import { useResizeObserver } from '@vueuse/core';

export const useToolbarOverflow = () => {
    const toolbarRef = ref<HTMLElement | null>(null);
    const collapseTier = ref(0);

    useResizeObserver(toolbarRef, (entries) => {
        const width = entries[0]?.contentRect.width ?? Infinity;
        if (width < 600) collapseTier.value = 3;
        else if (width < 750) collapseTier.value = 2;
        else if (width < 900) collapseTier.value = 1;
        else collapseTier.value = 0;
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
