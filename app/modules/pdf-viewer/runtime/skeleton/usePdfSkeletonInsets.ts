import type {IPdfPage} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
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
    const skeletonContentInsets = ref<IContentInsets | null>(null);
    const skeletonContentInsetMetrics = ref<{
        width: number;
        height: number;
    } | null>(null);

    function areSkeletonInsetMetricsCurrent(width: number, height: number) {
        const metrics = skeletonContentInsetMetrics.value;
        return Boolean(
            metrics
            && Math.abs(metrics.width - width) < 0.001
            && Math.abs(metrics.height - height) < 0.001,
        );
    }

    function setSkeletonContentInsets(width: number, height: number) {
        skeletonContentInsetMetrics.value = {
            width,
            height,
        };
        skeletonContentInsets.value = buildFallbackInsets(width, height);
    }

    const scaledSkeletonPadding = computed<IContentInsets | null>(() => {
        const width = toValue(basePageWidth);
        const height = toValue(basePageHeight);
        if (!width || !height) {
            return null;
        }

        if (!skeletonContentInsets.value || !areSkeletonInsetMetricsCurrent(width, height)) {
            setSkeletonContentInsets(width, height);
        }
        const insets = skeletonContentInsets.value ?? buildFallbackInsets(width, height);
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

    function computeSkeletonInsets(
        pdfPage: IPdfPage,
        renderVersion: number,
        getCurrentVersion: () => number,
    ) {
        void pdfPage;
        const width = toValue(basePageWidth);
        const height = toValue(basePageHeight);
        if (!width || !height) {
            skeletonContentInsets.value = null;
            skeletonContentInsetMetrics.value = null;
            return Promise.resolve();
        }

        if (getCurrentVersion() !== renderVersion) {
            return Promise.resolve();
        }

        setSkeletonContentInsets(width, height);
        return Promise.resolve();
    }

    function resetInsets() {
        skeletonContentInsets.value = null;
        skeletonContentInsetMetrics.value = null;
    }

    return {
        skeletonContentInsets,
        scaledSkeletonPadding,
        scaledPageHeight,
        computeSkeletonInsets,
        resetInsets,
    };
};
