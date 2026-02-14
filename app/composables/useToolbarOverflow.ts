import {
    useEventListener,
    useResizeObserver,
} from '@vueuse/core';
import { nextTick } from 'vue';

const MAX_COLLAPSE_TIER = 3;
const OVERFLOW_TOLERANCE_PX = 0.5;
const RESIZE_SETTLE_MS = 160;

export const useToolbarOverflow = () => {
    const toolbarRef = ref<HTMLElement | null>(null);
    const collapseTier = ref(0);
    let recalcToken = 0;
    let frameId: number | null = null;
    let settleTimerId: number | null = null;

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

    function isOverflowing(el: HTMLElement) {
        if (isElementOverflowing(el) || hasOutOfBoundsChildren(el)) {
            return true;
        }

        const centerSection = el.querySelector<HTMLElement>('.toolbar-center');
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

    async function recalculateCollapseTier(options: { allowExpand: boolean }) {
        const token = ++recalcToken;
        if (!toolbarRef.value) {
            collapseTier.value = 0;
            return;
        }

        let tier = Math.max(0, Math.min(collapseTier.value, MAX_COLLAPSE_TIER));
        collapseTier.value = tier;
        await waitForLayout();

        if (token !== recalcToken) {
            return;
        }

        let el = toolbarRef.value;
        if (!el) {
            return;
        }

        if (isOverflowing(el)) {
            while (tier < MAX_COLLAPSE_TIER) {
                tier += 1;
                collapseTier.value = tier;
                await waitForLayout();

                if (token !== recalcToken) {
                    return;
                }

                el = toolbarRef.value;
                if (!el || !isOverflowing(el)) {
                    return;
                }
            }
            return;
        }

        if (!options.allowExpand) {
            return;
        }

        while (tier > 0) {
            const nextTier = tier - 1;
            collapseTier.value = nextTier;
            await waitForLayout();

            if (token !== recalcToken) {
                return;
            }

            el = toolbarRef.value;
            if (!el || isOverflowing(el)) {
                collapseTier.value = tier;
                return;
            }

            tier = nextTier;
        }
    }

    function scheduleRecalculation() {
        if (typeof window === 'undefined') {
            return;
        }

        if (frameId !== null) {
            window.cancelAnimationFrame(frameId);
        }

        frameId = window.requestAnimationFrame(() => {
            frameId = null;
            void recalculateCollapseTier({ allowExpand: false });
        });

        if (settleTimerId !== null) {
            window.clearTimeout(settleTimerId);
        }

        settleTimerId = window.setTimeout(() => {
            settleTimerId = null;
            void recalculateCollapseTier({ allowExpand: true });
        }, RESIZE_SETTLE_MS);
    }

    watch(toolbarRef, () => {
        scheduleRecalculation();
    }, { flush: 'post' });

    useResizeObserver(toolbarRef, () => {
        scheduleRecalculation();
    });

    useEventListener(window, 'resize', () => {
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
