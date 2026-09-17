import type {
    IScanCleanupPreviewResult,
    TScanCleanupOutputHalf,
    TScanCleanupPageAlignment,
} from '@contracts/scan-cleanup/electronApiScanCleanup';
import type {
    ComponentPublicInstance,
    ComputedRef,
    CSSProperties,
    Ref,
} from 'vue';
import type {IScanCleanupDragRect} from '@app/modules/scan-cleanup/composables/useScanCleanupDragTransaction';

interface IPreviewPan {
    x: number;
    y: number;
}

interface IPreviewStageSize {
    height: number;
    width: number;
}

interface IUseScanCleanupPreviewOverlayGeometryOptions {
    activeDrag: Readonly<Ref<boolean>>;
    clampPan: () => void;
    cutterStage: Ref<HTMLElement | null>;
    dragOverlayBounds: IScanCleanupDragRect;
    previewPan: IPreviewPan;
    previewSurface: Ref<HTMLElement | null>;
    result: () => IScanCleanupPreviewResult | null;
    stageSize: IPreviewStageSize;
    transformScale: ComputedRef<number>;
}

export const useScanCleanupPreviewOverlayGeometry = (
    options: IUseScanCleanupPreviewOverlayGeometryOptions,
) => {
    const outputFitAreas = new Map<TScanCleanupOutputHalf, HTMLElement>();
    const outputCanvases = new Map<TScanCleanupOutputHalf, HTMLElement>();
    const outputFitAreaSizes = reactive<Partial<Record<TScanCleanupOutputHalf, {
        left: number;
        top: number;
        width: number;
        height: number
    }>>>({});
    const outputCanvasRects = reactive<Partial<Record<TScanCleanupOutputHalf, IScanCleanupDragRect>>>({});
    const placementAnchors: Array<{
        alignment: TScanCleanupPageAlignment;
        style: CSSProperties;
    }> = [
        {
            alignment: 'top-left',
            style: {
                left: '0%',
                top: '0%',
            },
        },
        {
            alignment: 'top-center',
            style: {
                left: '50%',
                top: '0%',
            },
        },
        {
            alignment: 'top-right',
            style: {
                left: '100%',
                top: '0%',
            },
        },
        {
            alignment: 'center-left',
            style: {
                left: '0%',
                top: '50%',
            },
        },
        {
            alignment: 'center',
            style: {
                left: '50%',
                top: '50%',
            },
        },
        {
            alignment: 'center-right',
            style: {
                left: '100%',
                top: '50%',
            },
        },
        {
            alignment: 'bottom-left',
            style: {
                left: '0%',
                top: '100%',
            },
        },
        {
            alignment: 'bottom-center',
            style: {
                left: '50%',
                top: '100%',
            },
        },
        {
            alignment: 'bottom-right',
            style: {
                left: '100%',
                top: '100%',
            },
        },
    ];
    let outputResizeObserver: ResizeObserver | null = null;
    let cutterResizeObserver: ResizeObserver | null = null;

    function setOutputFitArea(half: TScanCleanupOutputHalf, element: Element | ComponentPublicInstance | null) {
        const htmlElement = element instanceof HTMLElement ? element : null;
        const previous = outputFitAreas.get(half);
        if (previous === htmlElement) {
            return;
        }
        if (previous) outputResizeObserver?.unobserve(previous);
        if (!htmlElement) {
            outputFitAreas.delete(half);
            Reflect.deleteProperty(outputFitAreaSizes, half);
            return;
        }
        outputFitAreas.set(half, htmlElement);
        outputResizeObserver?.observe(htmlElement);
        updateOutputFitAreaSizes();
    }

    function setOutputCanvas(half: TScanCleanupOutputHalf, element: Element | ComponentPublicInstance | null) {
        const htmlElement = element instanceof HTMLElement ? element : null;
        const previous = outputCanvases.get(half);
        if (previous === htmlElement) {
            return;
        }
        if (previous) outputResizeObserver?.unobserve(previous);
        if (!htmlElement) {
            outputCanvases.delete(half);
            Reflect.deleteProperty(outputCanvasRects, half);
            return;
        }
        outputCanvases.set(half, htmlElement);
        const rect = htmlElement.getBoundingClientRect();
        outputCanvasRects[half] = {
            x: rect.left,
            y: rect.top,
            width: rect.width,
            height: rect.height,
        };
        outputResizeObserver?.observe(htmlElement);
        updateOverlayGeometry();
    }

    function currentStageRect(): IScanCleanupDragRect | null {
        const rect = options.cutterStage.value?.getBoundingClientRect();
        if (!rect) {
            return null;
        }
        return {
            x: rect.left,
            y: rect.top,
            width: rect.width,
            height: rect.height,
        };
    }

    function updateOverlayGeometry(force = false) {
        if (options.activeDrag.value && !force) {
            return;
        }
        const stageRect = currentStageRect();
        const surfaceRect = options.previewSurface.value?.getBoundingClientRect();
        if (!stageRect) {
            options.dragOverlayBounds.x = 0;
            options.dragOverlayBounds.y = 0;
            options.dragOverlayBounds.width = 0;
            options.dragOverlayBounds.height = 0;
            options.stageSize.width = 0;
            options.stageSize.height = 0;
            return;
        }
        if (!surfaceRect) {
            return;
        }
        const scale = Math.max(0.001, options.transformScale.value);
        const stageWidth = options.cutterStage.value && options.cutterStage.value.clientWidth > 0
            ? options.cutterStage.value.clientWidth
            : stageRect.width / scale;
        const stageHeight = options.cutterStage.value && options.cutterStage.value.clientHeight > 0
            ? options.cutterStage.value.clientHeight
            : stageRect.height / scale;
        options.dragOverlayBounds.x = stageRect.x
            - surfaceRect.left
            - options.previewPan.x
            + stageWidth * (scale - 1) / 2;
        options.dragOverlayBounds.y = stageRect.y
            - surfaceRect.top
            - options.previewPan.y
            + stageHeight * (scale - 1) / 2;
        options.dragOverlayBounds.width = stageWidth;
        options.dragOverlayBounds.height = stageHeight;
        options.stageSize.width = stageWidth;
        options.stageSize.height = stageHeight;
        options.clampPan();
        for (const [
            half,
            canvas,
        ] of outputCanvases) {
            const rect = canvas.getBoundingClientRect();
            outputCanvasRects[half] = {
                x: rect.left,
                y: rect.top,
                width: rect.width,
                height: rect.height,
            };
        }
    }

    function updateOutputFitAreaSizes() {
        const stageRect = options.cutterStage.value?.getBoundingClientRect();
        const scale = Math.max(0.001, options.transformScale.value);
        for (const [
            half,
            element,
        ] of outputFitAreas) {
            const rect = element.getBoundingClientRect();
            const current = outputFitAreaSizes[half];
            const left = (rect.left - (stageRect?.left ?? 0)) / scale;
            const top = (rect.top - (stageRect?.top ?? 0)) / scale;
            const width = element.clientWidth || rect.width / scale;
            const height = element.clientHeight || rect.height / scale;
            if (
                current?.left !== left
                || current.top !== top
                || current.width !== width
                || current.height !== height
            ) {
                outputFitAreaSizes[half] = {
                    left,
                    top,
                    width,
                    height,
                };
            }
        }
        updateOverlayGeometry();
    }

    function pruneOutputElementRefs() {
        const activeHalves = new Set(options.result()?.outputs.map(output => output.metadata.half) ?? []);
        for (const [
            half,
            element,
        ] of outputFitAreas) {
            if (!activeHalves.has(half)) {
                outputResizeObserver?.unobserve(element);
                outputFitAreas.delete(half);
                Reflect.deleteProperty(outputFitAreaSizes, half);
            }
        }
        for (const [
            half,
            element,
        ] of outputCanvases) {
            if (!activeHalves.has(half)) {
                outputResizeObserver?.unobserve(element);
                outputCanvases.delete(half);
                Reflect.deleteProperty(outputCanvasRects, half);
            }
        }
    }

    function observeOutputFitAreas() {
        outputResizeObserver?.disconnect();
        if (typeof ResizeObserver === 'undefined') {
            updateOutputFitAreaSizes();
            return;
        }
        outputResizeObserver = new ResizeObserver(updateOutputFitAreaSizes);
        for (const element of outputFitAreas.values()) outputResizeObserver.observe(element);
        for (const element of outputCanvases.values()) outputResizeObserver.observe(element);
        updateOutputFitAreaSizes();
    }

    function observeCutterStage() {
        cutterResizeObserver?.disconnect();
        updateOverlayGeometry();
        if (typeof ResizeObserver === 'undefined' || !options.cutterStage.value) {
            return;
        }
        cutterResizeObserver ??= new ResizeObserver(() => updateOverlayGeometry());
        cutterResizeObserver.observe(options.cutterStage.value);
    }

    onMounted(() => {
        observeCutterStage();
        observeOutputFitAreas();
    });
    watch(options.cutterStage, () => {
        void nextTick(observeCutterStage);
    });
    onBeforeUnmount(() => {
        cutterResizeObserver?.disconnect();
        outputResizeObserver?.disconnect();
    });

    return {
        currentStageRect,
        observeCutterStage,
        outputCanvasRects,
        outputFitAreaSizes,
        placementAnchors,
        pruneOutputElementRefs,
        setOutputCanvas,
        setOutputFitArea,
        updateOutputFitAreaSizes,
        updateOverlayGeometry,
    };
};
