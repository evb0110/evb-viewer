import {
    tryOnMounted,
    tryOnScopeDispose,
    useEventListener,
    useMutationObserver,
    useRafFn,
    useResizeObserver,
} from '@vueuse/core';
import { runDetached } from '@app/utils/asyncGuard';

const MAX_COLLAPSE_TIER = 5;
const OVERFLOW_TOLERANCE_PX = 0.5;
// A readout that shrinks may leave room for a collapsed group, but testing that
// remounts the group. The retry waits until the text has been still for longer
// than a few frames, so an eased animation whose readout rounds to the same
// value for a frame or two does not trigger the remount mid-animation.
const TEXT_SETTLE_MS = 250;
const NON_LAYOUT_ATTRIBUTE_NAMES = new Set([
    'aria-disabled',
    'aria-label',
    'aria-pressed',
    'class',
    'data-collapse-tier',
    'disabled',
    'title',
]);

export const useToolbarOverflow = () => {
    const toolbarRef = ref<HTMLElement | null>(null);
    const collapseTier = ref(0);

    let isRecalculating = false;
    let needsRecalculation = false;
    let suppressMutationEvents = false;
    let rafPending = false;
    let hasPendingLayoutMutation = true;
    let hasPendingTextMutation = false;
    let isExpansionRetryDue = false;
    let expansionRetryTimer: ReturnType<typeof setTimeout> | null = null;
    let descendantCache = new WeakMap<HTMLElement, HTMLElement[]>();
    let lastStableState: {
        tier: number
        clientWidth: number
        scrollWidth: number
    } | null = null;

    function invalidateDescendantCache() {
        descendantCache = new WeakMap();
    }

    function getDescendants(el: HTMLElement) {
        const cached = descendantCache.get(el);
        if (cached) {
            return cached;
        }

        const descendants = Array.from(el.querySelectorAll('*'))
            .filter((node): node is HTMLElement => node instanceof HTMLElement);
        descendantCache.set(el, descendants);
        return descendants;
    }

    function cancelExpansionRetry() {
        if (expansionRetryTimer === null) {
            return;
        }

        clearTimeout(expansionRetryTimer);
        expansionRetryTimer = null;
    }

    function scheduleExpansionRetry() {
        cancelExpansionRetry();
        expansionRetryTimer = setTimeout(() => {
            expansionRetryTimer = null;
            isExpansionRetryDue = true;
            scheduleRecalculation();
        }, TEXT_SETTLE_MS);
    }

    function setCollapseTier(tier: number) {
        if (collapseTier.value === tier) {
            return;
        }

        collapseTier.value = tier;
        invalidateDescendantCache();
    }

    // A readout such as the zoom percentage is rendered as an element whose
    // only child is text, and Vue patches it by replacing that text node, so
    // the mutation arrives as a child-list change rather than character data.
    // Either way the element set is unchanged and the descendant cache holds.
    function isTextOnlyMutation(mutation: MutationRecord) {
        if (mutation.type === 'characterData') {
            return true;
        }

        if (mutation.type !== 'childList') {
            return false;
        }

        const nodes = [
            ...mutation.addedNodes,
            ...mutation.removedNodes,
        ];
        return nodes.length > 0 && nodes.every(node => node.nodeType === Node.TEXT_NODE);
    }

    function isElementOverflowing(el: HTMLElement) {
        return (el.scrollWidth - el.clientWidth) > OVERFLOW_TOLERANCE_PX;
    }

    function hasOutOfBoundsDescendants(el: HTMLElement) {
        const containerRect = el.getBoundingClientRect();
        if (containerRect.width <= 0) {
            return false;
        }

        return getDescendants(el).some((child) => {
            const childRect = child.getBoundingClientRect();
            if (childRect.width <= 0) {
                return false;
            }

            return childRect.left < (containerRect.left - OVERFLOW_TOLERANCE_PX)
                || childRect.right > (containerRect.right + OVERFLOW_TOLERANCE_PX);
        });
    }

    function isOverflowing(toolbar: HTMLElement) {
        if (isElementOverflowing(toolbar) || hasOutOfBoundsDescendants(toolbar)) {
            return true;
        }

        const centerSection = toolbar.querySelector<HTMLElement>('.toolbar-center');
        if (!centerSection) {
            return false;
        }

        return isElementOverflowing(centerSection) || hasOutOfBoundsDescendants(centerSection);
    }

    async function waitForLayout() {
        await nextTick();
    }

    async function recalculateCollapseTier() {
        suppressMutationEvents = true;
        const toolbar = toolbarRef.value;
        if (!toolbar) {
            setCollapseTier(0);
            lastStableState = null;
            suppressMutationEvents = false;
            return;
        }

        try {
            const hasStructuralChange = hasPendingLayoutMutation;
            const hasTextChange = hasPendingTextMutation;
            const isExpansionRetry = isExpansionRetryDue && !hasStructuralChange && !hasTextChange;
            hasPendingLayoutMutation = false;
            hasPendingTextMutation = false;
            isExpansionRetryDue = false;

            let startTier = 0;
            if (
                lastStableState
                && !hasStructuralChange
                && !isExpansionRetry
                && collapseTier.value === lastStableState.tier
                && toolbar.clientWidth === lastStableState.clientWidth
            ) {
                // Nothing that can change the layout has happened since the last
                // settled pass, so skip the descendant rect scan entirely.
                if (!hasTextChange && toolbar.scrollWidth === lastStableState.scrollWidth) {
                    return;
                }

                // Only readout text changed. Testing the tiers below the current
                // one would remount their groups, which costs more than a frame
                // while a fit-scale preview rewrites the zoom readout on every
                // frame. Measure the current tier in place instead: escalate if
                // the text no longer fits, and retry expanding once the text has
                // settled.
                if (!isOverflowing(toolbar)) {
                    lastStableState.scrollWidth = toolbar.scrollWidth;
                    if (collapseTier.value > 0) {
                        scheduleExpansionRetry();
                    }
                    return;
                }

                startTier = collapseTier.value;
            }

            cancelExpansionRetry();
            for (let tier = startTier; tier <= MAX_COLLAPSE_TIER; tier += 1) {
                setCollapseTier(tier);
                await waitForLayout();

                const currentToolbar = toolbarRef.value;
                if (!currentToolbar) {
                    return;
                }

                if (!isOverflowing(currentToolbar)) {
                    lastStableState = {
                        tier,
                        clientWidth: currentToolbar.clientWidth,
                        scrollWidth: currentToolbar.scrollWidth,
                    };
                    return;
                }
            }

            setCollapseTier(MAX_COLLAPSE_TIER);
            lastStableState = {
                tier: MAX_COLLAPSE_TIER,
                clientWidth: toolbar.clientWidth,
                scrollWidth: toolbar.scrollWidth,
            };
        } finally {
            suppressMutationEvents = false;
        }
    }

    async function runRecalculation() {
        if (isRecalculating) {
            needsRecalculation = true;
            return;
        }

        isRecalculating = true;
        try {
            await recalculateCollapseTier();
        } finally {
            isRecalculating = false;
            if (needsRecalculation) {
                needsRecalculation = false;
                scheduleRecalculation();
            }
        }
    }

    const {
        pause: pauseRaf,
        resume: resumeRaf,
    } = useRafFn(() => {
        if (!rafPending) {
            pauseRaf();
            return;
        }

        rafPending = false;
        pauseRaf();
        void runRecalculation();
    }, { immediate: false });

    function scheduleRecalculation() {
        if (typeof window === 'undefined') {
            return;
        }

        if (isRecalculating) {
            needsRecalculation = true;
            return;
        }

        rafPending = true;
        resumeRaf();
    }

    watch(toolbarRef, () => {
        invalidateDescendantCache();
        hasPendingLayoutMutation = true;
        scheduleRecalculation();
    }, { flush: 'post' });

    useResizeObserver(toolbarRef, () => {
        scheduleRecalculation();
    });

    function shouldRecalculateForMutation(mutation: MutationRecord) {
        if (mutation.type !== 'attributes') {
            return true;
        }

        const attributeName = mutation.attributeName;
        return !attributeName || !NON_LAYOUT_ATTRIBUTE_NAMES.has(attributeName);
    }

    useMutationObserver(toolbarRef, (mutations) => {
        const layoutMutations = mutations.filter(shouldRecalculateForMutation);
        const hasStructuralMutation = layoutMutations.some(mutation => !isTextOnlyMutation(mutation));
        if (hasStructuralMutation) {
            invalidateDescendantCache();
        }
        if (layoutMutations.length === 0 || suppressMutationEvents) {
            return;
        }

        if (hasStructuralMutation) {
            hasPendingLayoutMutation = true;
        } else {
            hasPendingTextMutation = true;
        }
        scheduleRecalculation();
    }, {
        subtree: true,
        childList: true,
        // Page/zoom readouts patch text nodes, and their width feeds the tier decision.
        characterData: true,
        attributes: true,
    });

    useEventListener(typeof window !== 'undefined' ? window : undefined, 'resize', () => {
        scheduleRecalculation();
    });

    tryOnMounted(() => {
        scheduleRecalculation();
        if (typeof document === 'undefined') {
            return;
        }

        void runDetached(async () => {
            await document.fonts.ready;
            // Font swaps resize text without mutating the DOM, so force a full pass.
            hasPendingLayoutMutation = true;
            scheduleRecalculation();
        }, {
            category: 'background-diagnostic',
            scope: 'toolbar-overflow',
            message: 'Failed to recalculate toolbar after fonts loaded',
        });
    });

    tryOnScopeDispose(cancelExpansionRetry);

    const hasOverflowItems = computed(() => collapseTier.value > 0);

    function isCollapsed(tier: number) {
        return collapseTier.value >= tier;
    }

    return {
        toolbarRef,
        collapseTier,
        hasOverflowItems,
        isCollapsed,
    };
};
