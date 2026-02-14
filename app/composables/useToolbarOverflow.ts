import {
    useEventListener,
    useMutationObserver,
    useResizeObserver,
} from '@vueuse/core';
import { nextTick } from 'vue';

const MAX_COLLAPSE_TIER = 5;
const LIVE_RESIZE_MAX_TIER = 3;
const OVERFLOW_TOLERANCE_PX = 0.5;
const RESIZE_SETTLE_MS = 160;
const EXPAND_RETRY_WIDTH_DELTA_PX = 8;

export const useToolbarOverflow = () => {
    const toolbarRef = ref<HTMLElement | null>(null);
    const collapseTier = ref(0);

    let frameId: number | null = null;
    let settleTimerId: number | null = null;
    let isRecalculating = false;
    let needsRecalculation = false;
    let suppressMutationEvents = false;
    let failedExpandTier: number | null = null;
    let failedExpandWidth = 0;

    function isElementOverflowing(el: HTMLElement) {
        return (el.scrollWidth - el.clientWidth) > OVERFLOW_TOLERANCE_PX;
    }

    function hasOutOfBoundsChildren(el: HTMLElement) {
        const containerRect = el.getBoundingClientRect();
        if (containerRect.width <= 0) {
            return false;
        }

        return Array.from(el.children).some((child) => {
            if (!(child instanceof HTMLElement)) {
                return false;
            }

            const childRect = child.getBoundingClientRect();
            if (childRect.width <= 0) {
                return false;
            }

            return childRect.left < (containerRect.left - OVERFLOW_TOLERANCE_PX)
                || childRect.right > (containerRect.right + OVERFLOW_TOLERANCE_PX);
        });
    }

    function isOverflowing(toolbar: HTMLElement) {
        if (isElementOverflowing(toolbar) || hasOutOfBoundsChildren(toolbar)) {
            return true;
        }

        const centerSection = toolbar.querySelector<HTMLElement>('.toolbar-center');
        if (!centerSection) {
            return false;
        }

        return isElementOverflowing(centerSection) || hasOutOfBoundsChildren(centerSection);
    }

    async function waitForLayout() {
        await nextTick();
        if (typeof window === 'undefined') {
            return;
        }

        await new Promise<void>((resolve) => {
            window.requestAnimationFrame(() => {
                resolve();
            });
        });
    }

    async function recalculateCollapseTier(allowExpand: boolean) {
        suppressMutationEvents = true;
        const toolbar = toolbarRef.value;
        if (!toolbar) {
            collapseTier.value = 0;
            suppressMutationEvents = false;
            return;
        }

        try {
            let tier = Math.max(0, Math.min(collapseTier.value, MAX_COLLAPSE_TIER));
            collapseTier.value = tier;
            await waitForLayout();

            let currentToolbar = toolbarRef.value;
            if (!currentToolbar) {
                return;
            }

            let collapsedDuringPass = false;
            const maxTierForPass = allowExpand ? MAX_COLLAPSE_TIER : LIVE_RESIZE_MAX_TIER;

            while (tier < maxTierForPass && isOverflowing(currentToolbar)) {
                tier += 1;
                collapseTier.value = tier;
                collapsedDuringPass = true;
                await waitForLayout();

                currentToolbar = toolbarRef.value;
                if (!currentToolbar) {
                    return;
                }
            }

            if (collapsedDuringPass) {
                failedExpandTier = null;
            }

            if (!allowExpand) {
                return;
            }

            while (tier > 0) {
                currentToolbar = toolbarRef.value;
                if (!currentToolbar) {
                    return;
                }

                if (
                    failedExpandTier === tier
                    && currentToolbar.clientWidth <= (failedExpandWidth + EXPAND_RETRY_WIDTH_DELTA_PX)
                ) {
                    return;
                }

                const candidateTier = tier - 1;
                collapseTier.value = candidateTier;
                await waitForLayout();

                currentToolbar = toolbarRef.value;
                if (!currentToolbar || isOverflowing(currentToolbar)) {
                    collapseTier.value = tier;
                    failedExpandTier = tier;
                    failedExpandWidth = currentToolbar?.clientWidth ?? failedExpandWidth;
                    return;
                }

                failedExpandTier = null;
                tier = candidateTier;
            }
        } finally {
            suppressMutationEvents = false;
        }
    }

    async function runRecalculation(allowExpand: boolean) {
        if (isRecalculating) {
            needsRecalculation = true;
            return;
        }

        isRecalculating = true;
        try {
            await recalculateCollapseTier(allowExpand);
        } finally {
            isRecalculating = false;
            if (needsRecalculation) {
                needsRecalculation = false;
                scheduleRecalculation();
            }
        }
    }

    function scheduleRecalculation() {
        if (typeof window === 'undefined') {
            return;
        }

        if (isRecalculating) {
            needsRecalculation = true;
            return;
        }

        if (frameId !== null) {
            window.cancelAnimationFrame(frameId);
        }

        frameId = window.requestAnimationFrame(() => {
            frameId = null;
            void runRecalculation(false);
        });

        if (settleTimerId !== null) {
            window.clearTimeout(settleTimerId);
        }

        settleTimerId = window.setTimeout(() => {
            settleTimerId = null;
            void runRecalculation(true);
        }, RESIZE_SETTLE_MS);
    }

    watch(toolbarRef, () => {
        scheduleRecalculation();
    }, { flush: 'post' });

    useResizeObserver(toolbarRef, () => {
        scheduleRecalculation();
    });

    useMutationObserver(toolbarRef, () => {
        if (suppressMutationEvents) {
            needsRecalculation = true;
            return;
        }
        scheduleRecalculation();
    }, {
        subtree: true,
        childList: true,
        characterData: true,
    });

    useEventListener(typeof window !== 'undefined' ? window : undefined, 'resize', () => {
        scheduleRecalculation();
    });

    onMounted(() => {
        scheduleRecalculation();
    });

    onBeforeUnmount(() => {
        if (frameId !== null && typeof window !== 'undefined') {
            window.cancelAnimationFrame(frameId);
        }
        if (settleTimerId !== null && typeof window !== 'undefined') {
            window.clearTimeout(settleTimerId);
        }
    });

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
