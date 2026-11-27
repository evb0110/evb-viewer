import type {
    ComputedRef,
    InjectionKey,
    MaybeRefOrGetter,
} from 'vue';
import type { IContentInsets } from '@app/types/pdfUi';
import { clamp } from 'es-toolkit/math';

interface IPdfSkeletonContext {
    scaledSkeletonPadding: ComputedRef<IContentInsets | null>;
    scaledPageHeight: ComputedRef<number | null>;
}

const pdfSkeletonContextKey: InjectionKey<IPdfSkeletonContext> = Symbol('PdfSkeletonContext');

function buildFallbackInsets(width: number, height: number): IContentInsets {
    const horizontal = clamp(width * 0.08, 24, width / 3);
    const vertical = clamp(height * 0.1, 32, height / 3);

    return {
        top: vertical,
        right: horizontal,
        bottom: vertical,
        left: horizontal,
    };
}

export const usePdfSkeletonContext = () => {
    const context = inject(pdfSkeletonContextKey);
    if (!context) {
        throw new Error('usePdfSkeletonContext must be used within a component that calls usePdfSkeletonInsets');
    }
    return context;
};

export const usePdfSkeletonInsets = (
    basePageWidth: MaybeRefOrGetter<number | null>,
    basePageHeight: MaybeRefOrGetter<number | null>,
    effectiveScale: MaybeRefOrGetter<number>,
) => {
    const skeletonContentInsets = computed<IContentInsets | null>(() => {
        const width = toValue(basePageWidth);
        const height = toValue(basePageHeight);
        if (!width || !height) {
            return null;
        }
        return buildFallbackInsets(width, height);
    });

    const scaledSkeletonPadding = computed<IContentInsets | null>(() => {
        const insets = skeletonContentInsets.value;
        if (!insets) {
            return null;
        }
        const scale = toValue(effectiveScale);

        return {
            top: insets.top * scale,
            right: insets.right * scale,
            bottom: insets.bottom * scale,
            left: insets.left * scale,
        };
    });

    const scaledPageHeight = computed(() => {
        const height = toValue(basePageHeight);
        if (!height) {
            return null;
        }
        return Math.floor(height * toValue(effectiveScale));
    });

    provide(pdfSkeletonContextKey, {
        scaledSkeletonPadding,
        scaledPageHeight,
    });

    // Insets derive purely from admitted page dimensions; kept as a no-op for viewport reset callers.
    function resetInsets() {}

    return {
        skeletonContentInsets,
        scaledSkeletonPadding,
        scaledPageHeight,
        resetInsets,
    };
};
