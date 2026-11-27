import {useEventListener, useMutationObserver} from '@vueuse/core';
import {BASE_ROOT_FONT_SIZE_PX, readRootFontSizePx} from '@app/utils/rootFontSize';

/**
 * Reactive pixel size of one rem.
 *
 * `useUiScale` applies the scale by writing `--app-ui-scale` inline on the
 * document element, so watching that element's `style` attribute is the exact
 * signal for a preset change; `resize` covers browser and OS zoom. Everything
 * that has to line rem-sized layout up with pixel arithmetic reads this instead
 * of hardcoding 16.
 */
export const useRootFontSize = () => {
    const rootFontSizePx = ref(BASE_ROOT_FONT_SIZE_PX);
    const documentElement = computed(() => (typeof document === 'undefined' ? null : document.documentElement));

    function measureRootFontSize() {
        rootFontSizePx.value = readRootFontSizePx();
    }

    measureRootFontSize();
    onMounted(measureRootFontSize);
    useMutationObserver(documentElement, measureRootFontSize, {
        attributeFilter: ['style'],
        attributes: true,
    });
    useEventListener('resize', measureRootFontSize);

    return {rootFontSizePx};
};
