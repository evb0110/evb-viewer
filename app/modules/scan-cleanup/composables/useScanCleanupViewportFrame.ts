import type {
    IScanCleanupPreviewPageMetadata,
    IScanCleanupPreviewResult,
    TScanCleanupPageRotation,
    TScanCleanupOutputHalf,
} from '@contracts/electronApiScanCleanup';
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
    fitAreaSizes: Partial<Record<TScanCleanupOutputHalf, {
        left: number;
        top: number;
        width: number;
        height: number;
    }>>;
    matchPageSize: () => boolean;
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
    const frame = ref<{
        signature: string;
        outputs: Partial<Record<TScanCleanupOutputHalf, {
            height: number;
            width: number
        }>>;
    }>({
        signature: '',
        outputs: {},
    });
    const signature = computed(() => {
        const result = options.result();
        if (!result) {
            const metrics = sourceMetrics.value;
            const layoutClassification = options.layoutClassification?.();
            return JSON.stringify({
                requestedPage: options.requestedPage(),
                layout: layoutClassification ?? 'single-uncut-page',
                matchPageSize: options.matchPageSize(),
                sourceWidth: metrics.widthPoints,
                sourceHeight: metrics.heightPoints,
                rotationDegrees: options.rotationDegrees?.() ?? 0,
            });
        }
        return JSON.stringify({
            requestedPage: options.requestedPage(),
            resultPage: result.pageNumber,
            layout: result.pageMetadata.layoutClassification,
            outputCount: result.outputs.length,
            geometry: result.outputs.map(output => ({
                half: output.metadata.half,
                outputWidthPx: output.metadata.outputWidthPx,
                outputHeightPx: output.metadata.outputHeightPx,
                canvasWidthPx: output.metadata.canvasWidthPx,
                canvasHeightPx: output.metadata.canvasHeightPx,
                appliedMargins: output.metadata.appliedMargins,
            })),
            matchPageSize: options.matchPageSize(),
            container: result.outputs.map(output => {
                const size = options.fitAreaSizes[output.metadata.half];
                return {
                    half: output.metadata.half,
                    width: size?.width ?? 0,
                    height: size?.height ?? 0,
                };
            }),
        });
    });

    function refresh() {
        if (options.activeDrag.value || frame.value.signature === signature.value) {
            return;
        }
        const result = options.result();
        if (!result) {
            const metrics = sourceMetrics.value;
            const outputs = resolvePreviewPlaceholderViewportFrame(
                metrics.widthPoints,
                metrics.heightPoints,
                options.layoutClassification?.(),
                options.rotationDegrees?.() ?? 0,
            );
            frame.value = {
                signature: signature.value,
                outputs: Object.fromEntries(outputs.map(output => [
                    output.half,
                    {
                        width: output.width,
                        height: output.height,
                    },
                ])),
            };
            return;
        }
        frame.value = {
            signature: signature.value,
            outputs: Object.fromEntries(resolvePreviewViewportFrame(
                result.outputs.map(output => output.metadata),
            ).map(output => [
                output.half,
                {
                    width: output.width,
                    height: output.height,
                },
            ])),
        };
    }

    watch(signature, refresh, {immediate: true});
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
            if (!(error instanceof DOMException && error.name === 'AbortError')) {
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
        refresh,
        signature,
        sourceMetrics,
        sourceMetricsReady,
    };
};
