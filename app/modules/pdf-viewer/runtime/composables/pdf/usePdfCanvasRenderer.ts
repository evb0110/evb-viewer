import type { ICancelableRenderTask } from '@app/modules/pdf-viewer/runtime/rendering/pdfRendererTypes';
import type { TPdfPageRenderContentIntent } from '@app/modules/pdf-viewer/engine/pdf-page-render-pipeline/bindPdfOpenSurfaceRenderContext';
import type { MaybeRefOrGetter } from 'vue';
import type { PDFPageProxy } from 'pdfjs-dist';
import { AnnotationMode } from '@app/services/pdfjs/runtimeLib';
import { BrowserLogger } from '@app/utils/browserLogger';
import { createHiddenAnnotationOperationsFilter } from '@app/modules/pdf-viewer/engine/pdf-hidden-annotation-operations/createHiddenAnnotationOperationsFilter';
import { PDF_PAGE_RENDER_TIMEOUT_MS } from '@app/constants/timeouts';
import { withPageStageTimeout } from '@app/modules/pdf-viewer/engine/pdf-page-render-timeout/withPageStageTimeout';
import type { IPageRenderStallPayload } from '@app/modules/pdf-viewer/engine/pdf-page-render-timeout/pdfPageRenderTimeoutTypes';
import { PDF_PAGE_SCALE_CSS_VARS } from '@app/modules/pdf-viewer/engine/pdf-page-scale/pdfPageScale';
import type { TPdfPageOperationSettlementCapture } from '@app/modules/pdf-viewer/engine/pdf-page-render-coordinator/coordinatedPdfPageRender';
import type { TPdfViewRotation } from '@contracts/shared';
import { resolvePdfPageViewportRotation } from '@app/utils/pdfViewRotation';

interface ICanvasRenderResult {
    canvas: HTMLCanvasElement;
    viewport: ReturnType<PDFPageProxy['getViewport']>;
    annotationCanvasMap: Map<string, HTMLCanvasElement> | null;
    scaleX: number;
    scaleY: number;
    rawDims: {
        pageWidth: number;
        pageHeight: number;
    };
    requestedPixels: number;
    grantedPixels: number;
    pixelScaleFactor: number;
    wasClamped: boolean;
    userUnit: number;
    totalScaleFactor: number;
    surfaceReservation?: {release: () => void;} | undefined;
}


interface IPreparedCanvasRender extends ICanvasRenderResult { startRender: () => ICancelableRenderTask; }

interface IRenderCanvasOptions {
    maxCanvasPixels?: number;
    sourceMaxPixels?: number;
    onRenderTask?: (task: ICancelableRenderTask) => void;
    hiddenAnnotationIds?: Set<string>;
    onRenderStall?: (payload: IPageRenderStallPayload) => void;
    contentIntent?: TPdfPageRenderContentIntent;
    reserveSurface?: ((bytes: number) => {release: () => void;} | null) | undefined;
    pageRenderCoordination?: {
        owner: string;
        priority: number;
        signal?: AbortSignal | undefined;
        shouldStart?: (() => boolean) | undefined;
        shouldContinue?: (() => boolean) | undefined;
        captureSettlement?: TPdfPageOperationSettlementCapture | undefined;
    };
}

interface ICanvasPixelSize {
    pixelWidth: number;
    pixelHeight: number;
    requestedPixels: number;
    grantedPixels: number;
    pixelScaleFactor: number;
    wasClamped: boolean;
}

interface ICanvasScale {
    scaleX: number;
    scaleY: number;
}

export const usePdfCanvasRenderer = (deps: {
    outputScale: MaybeRefOrGetter<number>;
    viewRotation?: MaybeRefOrGetter<TPdfViewRotation>;
    defaultMaxCanvasPixels?: number | undefined;
    annotationProjectionReady?: MaybeRefOrGetter<boolean>;
}) => {
    const {
        outputScale,
        viewRotation,
        defaultMaxCanvasPixels,
    } = deps;
    const effectiveViewRotation = viewRotation ?? (() => 0);

    function getOutputScale() {
        const value = toValue(outputScale);
        return typeof value === 'number' && Number.isFinite(value) && value > 0
            ? value
            : 1;
    }

    function cleanupCanvas(canvas: HTMLCanvasElement) {
        canvas.width = 0;
        canvas.height = 0;
        canvas.remove();
    }

    function cleanupCanvasRenderResult(renderResult: Pick<ICanvasRenderResult, 'canvas' | 'annotationCanvasMap'>) {
        const resultWithReservation = renderResult as Pick<ICanvasRenderResult, 'canvas' | 'annotationCanvasMap' | 'surfaceReservation'>;
        resultWithReservation.surfaceReservation?.release();
        resultWithReservation.surfaceReservation = undefined;
        cleanupCanvas(renderResult.canvas);
        renderResult.annotationCanvasMap?.forEach((annotationCanvas) => {
            if (annotationCanvas !== renderResult.canvas) {
                cleanupCanvas(annotationCanvas);
            }
        });
        renderResult.annotationCanvasMap?.clear();
    }

    function isValidViewportSize(width: number, height: number) {
        return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0;
    }

    function normalizeMaxCanvasPixels(value: number | undefined) {
        return typeof value === 'number'
            && Number.isFinite(value)
            && value > 0
            ? Math.max(1, Math.round(value))
            : null;
    }

    function getMaxCanvasPixels(options?: IRenderCanvasOptions) {
        const renderMaxPixels = normalizeMaxCanvasPixels(options?.maxCanvasPixels)
            ?? normalizeMaxCanvasPixels(defaultMaxCanvasPixels);
        const sourceMaxPixels = normalizeMaxCanvasPixels(options?.sourceMaxPixels);
        if (sourceMaxPixels === null) {
            return renderMaxPixels;
        }
        return renderMaxPixels === null
            ? sourceMaxPixels
            : Math.min(renderMaxPixels, sourceMaxPixels);
    }

    function calculateCanvasPixelSize(
        cssWidth: number,
        cssHeight: number,
        options?: IRenderCanvasOptions,
    ): ICanvasPixelSize {
        const currentOutputScale = getOutputScale();
        const requestedPixelWidth = Math.max(1, Math.round(cssWidth * currentOutputScale));
        const requestedPixelHeight = Math.max(1, Math.round(cssHeight * currentOutputScale));
        const requestedPixelCount = requestedPixelWidth * requestedPixelHeight;
        const maxCanvasPixels = getMaxCanvasPixels(options);
        const shouldClampPixels = maxCanvasPixels !== null && requestedPixelCount > maxCanvasPixels;
        const pixelScaleFactor = shouldClampPixels
            ? Math.sqrt(maxCanvasPixels / requestedPixelCount)
            : 1;
        let pixelWidth = Math.max(1, Math.round(requestedPixelWidth * pixelScaleFactor));
        let pixelHeight = Math.max(1, Math.round(requestedPixelHeight * pixelScaleFactor));
        // Rounding both axes independently can overshoot a strict pixel budget
        // by one row or column. Correct the longer axis after rounding so the
        // granted canvas is mathematically guaranteed to remain within budget.
        if (maxCanvasPixels !== null && pixelWidth * pixelHeight > maxCanvasPixels) {
            if (pixelHeight >= pixelWidth) {
                pixelHeight = Math.max(1, Math.floor(maxCanvasPixels / pixelWidth));
            } else {
                pixelWidth = Math.max(1, Math.floor(maxCanvasPixels / pixelHeight));
            }
        }

        return {
            pixelWidth,
            pixelHeight,
            requestedPixels: requestedPixelCount,
            grantedPixels: pixelWidth * pixelHeight,
            pixelScaleFactor,
            wasClamped: shouldClampPixels,
        };
    }

    function estimateRequestedPixels(cssWidth: number, cssHeight: number) {
        const currentOutputScale = getOutputScale();
        const requestedPixelWidth = Math.max(1, Math.round(cssWidth * currentOutputScale));
        const requestedPixelHeight = Math.max(1, Math.round(cssHeight * currentOutputScale));
        return requestedPixelWidth * requestedPixelHeight;
    }

    function setupCanvas(
        canvas: HTMLCanvasElement,
        cssWidth: number,
        cssHeight: number,
        pixelSize: ICanvasPixelSize,
    ): ICanvasScale {
        canvas.width = pixelSize.pixelWidth;
        canvas.height = pixelSize.pixelHeight;
        canvas.style.width = `${cssWidth}px`;
        canvas.style.height = `${cssHeight}px`;
        canvas.style.display = 'block';
        canvas.style.margin = '0';

        return {
            scaleX: pixelSize.pixelWidth / cssWidth,
            scaleY: pixelSize.pixelHeight / cssHeight,
        };
    }

    function isValidCanvasScale(scale: ICanvasScale) {
        return Number.isFinite(scale.scaleX)
            && Number.isFinite(scale.scaleY)
            && scale.scaleX > 0
            && scale.scaleY > 0;
    }

    function createOutputTransform(scale: ICanvasScale) {
        return scale.scaleX !== 1 || scale.scaleY !== 1 ? [
            scale.scaleX,
            0,
            0,
            scale.scaleY,
            0,
            0,
        ] : undefined;
    }

    async function createAnnotationRenderOptions(
        pdfPage: PDFPageProxy,
        options?: IRenderCanvasOptions,
    ) {
        if (
            options?.contentIntent === 'canvas-only-buffer'
            || options?.contentIntent === 'canvas-only-refine'
        ) {
            return {
                annotationCanvasMap: null,
                annotationMode: AnnotationMode?.DISABLE ?? 0,
                operationsFilter: undefined,
            };
        }
        if (toValue(deps.annotationProjectionReady ?? true) === false) {
            return {
                annotationCanvasMap: null,
                annotationMode: AnnotationMode?.DISABLE ?? 0,
                operationsFilter: undefined,
            };
        }
        const annotationCanvasMap = new Map<string, HTMLCanvasElement>();
        const annotationMode = AnnotationMode?.ENABLE_FORMS ?? AnnotationMode?.ENABLE ?? 1;
        const operationsFilter = await createHiddenAnnotationOperationsFilter(
            pdfPage,
            annotationMode,
            options?.hiddenAnnotationIds,
            options?.pageRenderCoordination,
        );

        return {
            annotationCanvasMap,
            annotationMode,
            operationsFilter,
        };
    }

    function shouldContinueCanvasPreparation(options?: IRenderCanvasOptions) {
        const coordination = options?.pageRenderCoordination;
        return coordination?.signal?.aborted !== true
            && coordination?.shouldContinue?.() !== false;
    }

    async function prepareCanvasRender(
        pdfPage: PDFPageProxy,
        scale: number,
        options?: IRenderCanvasOptions,
    ): Promise<IPreparedCanvasRender | null> {
        const viewport = pdfPage.getViewport({
            scale,
            rotation: resolvePdfPageViewportRotation(
                pdfPage.rotate,
                toValue(effectiveViewRotation),
            ),
        });
        const userUnit = viewport.userUnit ?? 1;
        const totalScaleFactor = scale * userUnit;
        const rawDims = viewport.rawDims as {
            pageWidth: number;
            pageHeight: number;
        };

        const cssWidth = viewport.width;
        const cssHeight = viewport.height;
        if (!isValidViewportSize(cssWidth, cssHeight)) {
            BrowserLogger.warn(
                'pdf-renderer',
                `Skipping page ${pdfPage.pageNumber} render due to invalid viewport size ${cssWidth}x${cssHeight}`,
            );
            return null;
        }

        const pixelSize = calculateCanvasPixelSize(cssWidth, cssHeight, options);
        const canvasScale = {
            scaleX: pixelSize.pixelWidth / cssWidth,
            scaleY: pixelSize.pixelHeight / cssHeight,
        };
        if (!isValidCanvasScale(canvasScale)) {
            BrowserLogger.warn(
                'pdf-renderer',
                `Skipping page ${pdfPage.pageNumber} render due to invalid canvas scale ${canvasScale.scaleX}x${canvasScale.scaleY}`,
            );
            return null;
        }

        const annotationOptions = await withPageStageTimeout(
            createAnnotationRenderOptions(pdfPage, options),
            {
                pageNumber: pdfPage.pageNumber,
                stage: 'canvas-prepare',
                timeoutMs: PDF_PAGE_RENDER_TIMEOUT_MS,
            },
            () => shouldContinueCanvasPreparation(options),
            undefined,
            options?.onRenderStall,
            undefined,
            options?.pageRenderCoordination?.signal,
        ).catch((error: unknown) => {
            if (error instanceof Error && error.name === 'AbortError') {
                return null;
            }
            throw error;
        });
        if (!annotationOptions) {
            return null;
        }
        if (!shouldContinueCanvasPreparation(options)) {
            return null;
        }
        const surfaceReservation = options?.reserveSurface?.(pixelSize.grantedPixels * 4);
        if (options?.reserveSurface && !surfaceReservation) {
            throw new RangeError(`PDF page ${pdfPage.pageNumber} canvas exceeds the available workspace surface budget`);
        }
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        if (!context) {
            surfaceReservation?.release();
            return null;
        }
        try {
            setupCanvas(canvas, cssWidth, cssHeight, pixelSize);
        } catch (error) {
            surfaceReservation?.release();
            throw error;
        }

        const renderContext = {
            canvasContext: context,
            canvas,
            transform: createOutputTransform(canvasScale),
            viewport,
            annotationMode: annotationOptions.annotationMode,
            ...(annotationOptions.annotationCanvasMap
                ? {annotationCanvasMap: annotationOptions.annotationCanvasMap}
                : {}),
            ...(annotationOptions.operationsFilter
                ? {operationsFilter: annotationOptions.operationsFilter}
                : {}),
        };

        return {
            canvas,
            viewport,
            annotationCanvasMap: annotationOptions.annotationCanvasMap,
            scaleX: canvasScale.scaleX,
            scaleY: canvasScale.scaleY,
            rawDims,
            requestedPixels: pixelSize.requestedPixels,
            grantedPixels: pixelSize.grantedPixels,
            pixelScaleFactor: pixelSize.pixelScaleFactor,
            wasClamped: pixelSize.wasClamped,
            userUnit,
            totalScaleFactor,
            surfaceReservation: surfaceReservation ?? undefined,
            startRender: () => (pdfPage.render(renderContext)),
        };
    }

    async function renderCanvas(
        pdfPage: PDFPageProxy,
        scale: number,
        options?: IRenderCanvasOptions,
    ): Promise<ICanvasRenderResult | null> {
        const preparedRender = await prepareCanvasRender(pdfPage, scale, options);
        if (!preparedRender) {
            return null;
        }

        const {
            startRender,
            ...renderResult
        } = preparedRender;
        const renderTask = startRender();
        options?.onRenderTask?.(renderTask);
        try {
            await renderTask.promise;
            return renderResult;
        } catch (error) {
            cleanupCanvasRenderResult(renderResult);
            throw error;
        }
    }

    function applyContainerUserUnit(
        container: HTMLElement,
        userUnit: number,
    ) {
        // The layout owner writes width, height, and mutable scale for every
        // mounted page synchronously. The renderer contributes only immutable
        // PDF metadata discovered from the concrete page proxy.
        container.style.setProperty(PDF_PAGE_SCALE_CSS_VARS.userUnit, String(userUnit));
    }

    function mountCanvas(
        canvasHost: HTMLElement,
        canvas: HTMLCanvasElement,
        previousCanvas?: HTMLCanvasElement | null,
    ) {
        if (previousCanvas?.parentElement === canvasHost) {
            previousCanvas.replaceWith(canvas);
        } else {
            canvasHost.prepend(canvas);
        }
    }

    return {
        cleanupCanvas,
        cleanupCanvasRenderResult,
        estimateRequestedPixels,
        prepareCanvasRender,
        renderCanvas,
        applyContainerUserUnit,
        mountCanvas,
    };
};
