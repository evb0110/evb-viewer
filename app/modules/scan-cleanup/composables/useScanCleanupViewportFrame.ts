import {isAbortError} from '@contracts/isAbortError';
import type {
    IScanCleanupPreviewPageMetadata,
    IScanCleanupPreviewResult,
    TScanCleanupPageRotation,
    TScanCleanupOutputHalf,
} from '@contracts/scan-cleanup/electronApiScanCleanup';
import type {Ref} from 'vue';
import type {
    IDocumentPageMetrics,
    IDocumentPageSource,
} from '@app/modules/document-viewer/public';
import {
    resolvePreviewPlaceholderViewportFrame,
    resolvePreviewViewportFrame,
} from '@app/modules/scan-cleanup/geometry/viewport';

interface IUseScanCleanupViewportFrameOptions {
    activeDrag: Readonly<Ref<boolean>>;
    layoutClassification?: () => IScanCleanupPreviewPageMetadata['layoutClassification'] | undefined;
    requestedPage: () => number;
    result: () => IScanCleanupPreviewResult | null;
    rotationDegrees?: () => TScanCleanupPageRotation;
    source?: () => IDocumentPageSource | null;
}

const DEFAULT_PAGE_METRICS: IDocumentPageMetrics = {
    widthPoints: 1,
    heightPoints: Math.SQRT2,
    rotation: 0,
};

export const useScanCleanupViewportFrame = (options: IUseScanCleanupViewportFrameOptions) => {
    const initialSource = options.source?.() ?? null;
    const sourceMetrics = shallowRef<IDocumentPageMetrics>(DEFAULT_PAGE_METRICS);
    const sourceMetricsReady = ref(initialSource === null);
    // Paper geometry follows the result, or before one the source page's
    // metrics. A drag keeps the frame it started with until it ends.
    const frame = computed<{outputs: Partial<Record<TScanCleanupOutputHalf, {
        height: number;
        width: number
    }>>;}>(previous => {
        if (options.activeDrag.value && previous) {
            return previous;
        }
        const result = options.result();
        const outputs = result
            ? resolvePreviewViewportFrame(result.outputs.map(output => output.metadata))
            : resolvePreviewPlaceholderViewportFrame(
                sourceMetrics.value.widthPoints,
                sourceMetrics.value.heightPoints,
                options.layoutClassification?.(),
                options.rotationDegrees?.() ?? 0,
            );
        return {outputs: Object.fromEntries(outputs.map(output => [
            output.half,
            {
                width: output.width,
                height: output.height,
            },
        ]))};
    });
    watch([
        () => options.source?.() ?? null,
        () => options.requestedPage(),
    ], async ([
        source,
        pageNumber,
    ], _previous, onCleanup) => {
        if (!source) {
            sourceMetrics.value = DEFAULT_PAGE_METRICS;
            sourceMetricsReady.value = true;
            return;
        }
        sourceMetricsReady.value = false;
        const controller = new AbortController();
        onCleanup(() => controller.abort());
        try {
            const metrics = await source.getPageMetrics(pageNumber, controller.signal);
            if (controller.signal.aborted) {
                return;
            }
            sourceMetrics.value = metrics;
            sourceMetricsReady.value = true;
        } catch (error) {
            if (!isAbortError(error)) {
                sourceMetrics.value = DEFAULT_PAGE_METRICS;
                // A failed measurement still has a safe fallback frame. Mark
                // it ready so the viewport does not remain hidden forever.
                sourceMetricsReady.value = true;
            }
        }
    }, {immediate: true});

    const placeholderHalves = computed<TScanCleanupOutputHalf[]>(() => (
        options.layoutClassification?.() === 'two-page-spread'
            ? [
                'left',
                'right',
            ]
            : ['full']
    ));

    return {
        frame,
        placeholderHalves,
        sourceMetrics,
        sourceMetricsReady,
    };
};
