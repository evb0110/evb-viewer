import {
    ref,
    computed,
    toValue,
    type MaybeRefOrGetter,
} from 'vue';
import type { TFitMode } from '@app/types/pdf';

const BASE_MARGIN = 20;

export const usePdfScale = (
    zoom: MaybeRefOrGetter<number>,
    fitMode: MaybeRefOrGetter<TFitMode>,
    basePageWidth: MaybeRefOrGetter<number | null>,
    basePageHeight: MaybeRefOrGetter<number | null>,
) => {
    const fitWidthScale = ref(1);
    const lastContainerSize = ref<number | null>(null);

    const effectiveScale = computed(() => toValue(zoom) * fitWidthScale.value);

    const containerStyle = computed(() => {
        const scale = effectiveScale.value;
        const margin = Math.floor(BASE_MARGIN * scale);
        return {
            padding: `${margin}px`,
            gap: `${margin}px`,
        };
    });

    const scaledMargin = computed(() => Math.floor(BASE_MARGIN * effectiveScale.value));

    function computeFitWidthScale(container: HTMLElement | null): boolean {
        const width = toValue(basePageWidth);
        const height = toValue(basePageHeight);
        if (!container || !width || !height) {
            return false;
        }

        const mode = toValue(fitMode);
        const rawSize = mode === 'height'
            ? container.clientHeight
            : container.clientWidth;

        if (rawSize <= 0) {
            return false;
        }

        if (lastContainerSize.value !== null && Math.abs(rawSize - lastContainerSize.value) < 1) {
            return false;
        }

        lastContainerSize.value = rawSize;

        const baseDimension = mode === 'height'
            ? height + BASE_MARGIN * 2
            : width + BASE_MARGIN * 2;

        const newScale = rawSize / baseDimension;

        if (Math.abs(newScale - fitWidthScale.value) < 0.001) {
            return false;
        }

        fitWidthScale.value = newScale;
        return true;
    }

    function resetScale() {
        fitWidthScale.value = 1;
        lastContainerSize.value = null;
    }

    return {
        fitWidthScale,
        effectiveScale,
        containerStyle,
        scaledMargin,
        computeFitWidthScale,
        resetScale,
    };
};
