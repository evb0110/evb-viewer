import {
    useMutationObserver,
    useResizeObserver,
} from '@vueuse/core';
import { nextTick } from 'vue';

const MAX_COLLAPSE_TIER = 3;
const OVERFLOW_TOLERANCE_PX = 1;

export const useToolbarOverflow = () => {
    const toolbarRef = ref<HTMLElement | null>(null);
    const collapseTier = ref(0);
    let recalcToken = 0;
    let frameId: number | null = null;

    function isOverflowing(el: HTMLElement) {
        return (el.scrollWidth - el.clientWidth) > OVERFLOW_TOLERANCE_PX;
    }

    async function recalculateCollapseTier() {
        const token = ++recalcToken;
        const initialEl = toolbarRef.value;
        if (!initialEl) {
            collapseTier.value = 0;
            return;
        }

        for (let tier = 0; tier <= MAX_COLLAPSE_TIER; tier += 1) {
            collapseTier.value = tier;
            await nextTick();

            if (token !== recalcToken) {
                return;
            }

            const el = toolbarRef.value;
            if (!el || !isOverflowing(el)) {
                return;
            }
        }

        collapseTier.value = MAX_COLLAPSE_TIER;
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
            void recalculateCollapseTier();
        });
    }

    watch(toolbarRef, () => {
        scheduleRecalculation();
    }, { flush: 'post' });

    useResizeObserver(toolbarRef, () => {
        scheduleRecalculation();
    });

    useMutationObserver(toolbarRef, () => {
        scheduleRecalculation();
    }, {
        childList: true,
        subtree: true,
        characterData: true,
    });

    onMounted(() => {
        scheduleRecalculation();
    });

    onBeforeUnmount(() => {
        if (frameId !== null && typeof window !== 'undefined') {
            window.cancelAnimationFrame(frameId);
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
