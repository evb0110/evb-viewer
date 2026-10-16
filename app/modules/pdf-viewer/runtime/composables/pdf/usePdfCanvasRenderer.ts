import type {IPdfPage} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import type {
    ICancelableRenderTask, IPdfAnnotationRenderInput, IPdfLayerRenderResult,
} from '@app/modules/pdf-viewer/runtime/rendering/pdfRendererTypes';
import { requirePageNumber } from '@contracts/pageNumbers';
import type { TPdfPageRenderContentIntent } from '@app/modules/pdf-viewer/engine/pdf-page-render-pipeline/bindPdfOpenSurfaceRenderContext';
import type { MaybeRefOrGetter } from 'vue';
import { AnnotationMode } from '@app/services/pdfjs/runtimeLib';
import { toPdfjsHiddenAnnotationIds } from '@app/modules/pdf-viewer/engine/pdf-hidden-annotations/toPdfjsHiddenAnnotationIds';
import { normalizePdfJsAnnotationId } from '@app/utils/pdfAnnotationRefs';
import { PDF_PAGE_RENDER_TIMEOUT_MS } from '@app/constants/timeouts';
import { withPageStageTimeout } from '@app/modules/pdf-viewer/engine/pdf-page-render-timeout/withPageStageTimeout';
import type { IPageRenderStallPayload } from '@app/modules/pdf-viewer/engine/pdf-page-render-timeout/pdfPageRenderTimeoutTypes';
import { PDF_PAGE_SCALE_CSS_VARS } from '@app/modules/pdf-viewer/engine/pdf-page-scale/pdfPageScale';
import type { TPdfPageOperationSettlementCapture } from '@app/modules/pdf-viewer/engine/pdf-page-render-coordinator/coordinatedPdfPageRender';
import type { TPdfViewRotation } from '@contracts/shared';
import { resolvePdfPageViewportRotation } from '@app/utils/pdfViewRotation';

interface ICanvasRenderResult extends IPdfLayerRenderResult {
    additionalResourceBytes: number;
    paintsAnnotations: boolean;
    requestedPixels: number;
    grantedPixels: number;
    pixelScaleFactor: number;
    wasClamped: boolean;
    surfaceReservation?: {release: () => void;} | undefined;
}


interface IPreparedCanvasRender extends ICanvasRenderResult { startRender: () => ICancelableRenderTask; }

interface IRenderCanvasOptions {
    annotationInput?: IPdfAnnotationRenderInput | (() => Promise<IPdfAnnotationRenderInput>);
    maxCanvasPixels?: number;
    sourceMaxPixels?: number;
    hiddenAnnotationIds?: MaybeRefOrGetter<Set<string>>;
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
        reserveAppearanceBytes?: ((bytes: number) => void) | undefined;
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

export const usePdfCanvasRenderer = (deps: {
    outputScale: MaybeRefOrGetter<number>;
    viewRotation?: MaybeRefOrGetter<TPdfViewRotation>;
    defaultMaxCanvasPixels?: number | undefined;
    prepareAnnotations?: (page: IPdfPage, coordination: IRenderCanvasOptions['pageRenderCoordination']) => Promise<IPdfAnnotationRenderInput | undefined>;
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

    function cleanupCanvasRenderResult(renderResult: Pick<ICanvasRenderResult, 'canvas' | 'annotationCanvasMap' | 'annotationOutput' | 'surfaceReservation'>) {
        renderResult.surfaceReservation?.release();
        const canvases = new Set([
            ...renderResult.annotationCanvasMap?.values() ?? [],
            ...renderResult.annotationOutput?.ownCanvases.map(([
                , canvas,
            ]) => canvas) ?? [],
        ].flat());
        canvases.add(renderResult.canvas);
        canvases.forEach(cleanupCanvas);
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
        return calculateCanvasPixelSize(cssWidth, cssHeight).requestedPixels;
    }

    function setupCanvas(
        canvas: HTMLCanvasElement,
        cssWidth: number,
        pixelSize: ICanvasPixelSize,
    ) {
        canvas.width = pixelSize.pixelWidth;
        canvas.height = pixelSize.pixelHeight;
        canvas.style.width = `${cssWidth}px`;
        canvas.style.setProperty('height', 'auto', 'important');
        canvas.style.display = 'block';
        canvas.style.margin = '0';

    }

    async function createAnnotationRenderOptions(
        pdfPage: IPdfPage, options?: IRenderCanvasOptions,
    ) {
        const input = await (typeof options?.annotationInput === 'function' ? options.annotationInput()
            : options?.annotationInput ?? deps.prepareAnnotations?.(pdfPage, options?.pageRenderCoordination));
        const hiddenAnnotationIds = toPdfjsHiddenAnnotationIds(input?.excludedIds ?? toValue(options?.hiddenAnnotationIds));
        return {
            annotationInput: input ? Object.freeze({
                ...input,
                excludedIds: hiddenAnnotationIds ?? new Set<string>(),
            }) : undefined,
            annotationCanvasMap: input?.nativeAnnotationAppearance || options?.contentIntent === 'canvas-only-buffer' || options?.contentIntent === 'canvas-only-refine'
                || input?.original?.entities.some(original => original.kind === 'text-box' && original.pageIndex + 1 === pdfPage.pageNumber
                    && input.semanticInputs.some(entity => normalizePdfJsAnnotationId(entity.ref) === normalizePdfJsAnnotationId(`${original.objectNumber} ${original.generationNumber} R`))
                    && !hiddenAnnotationIds?.has(normalizePdfJsAnnotationId(`${original.objectNumber} ${original.generationNumber} R`)!))
                ? null : new Map<string, HTMLCanvasElement>(),
            annotationMode: AnnotationMode.ENABLE,
            hiddenAnnotationIds,
        };
    }

    function shouldContinueCanvasPreparation(options?: IRenderCanvasOptions) {
        const coordination = options?.pageRenderCoordination;
        return coordination?.signal?.aborted !== true
            && coordination?.shouldContinue?.() !== false;
    }

    async function prepareCanvasRender(
        pdfPage: IPdfPage,
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
        const rawDims = viewport.rawDims as {
            pageWidth: number;
            pageHeight: number;
        };

        const cssWidth = viewport.width;
        const cssHeight = viewport.height;
        if (!isValidViewportSize(cssWidth, cssHeight)) {
            throw new RangeError(`PDF page ${pdfPage.pageNumber} has invalid viewport size ${cssWidth}x${cssHeight}`);
        }

        const pixelSize = calculateCanvasPixelSize(cssWidth, cssHeight, options);
        const canvasScale = {
            scaleX: pixelSize.pixelWidth / cssWidth,
            scaleY: pixelSize.pixelHeight / cssHeight,
        };
        if (!Number.isFinite(canvasScale.scaleX) || !Number.isFinite(canvasScale.scaleY)
            || canvasScale.scaleX <= 0 || canvasScale.scaleY <= 0) {
            throw new RangeError(`PDF page ${pdfPage.pageNumber} has invalid canvas scale ${canvasScale.scaleX}x${canvasScale.scaleY}`);
        }

        if (!shouldContinueCanvasPreparation(options)) return null;
        const annotationOptions = await withPageStageTimeout(
            createAnnotationRenderOptions(pdfPage, options),
            {
                pageNumber: requirePageNumber(pdfPage.pageNumber),
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
            throw new Error(`PDF page ${pdfPage.pageNumber} has no 2D context`);
        }
        try {
            setupCanvas(canvas, cssWidth, pixelSize);
        } catch (error) {
            surfaceReservation?.release();
            throw error;
        }

        const renderContext = {
            canvasContext: context,
            canvas,
            transform: canvasScale.scaleX !== 1 || canvasScale.scaleY !== 1
                ? [
                    canvasScale.scaleX,
                    0,
                    0,
                    canvasScale.scaleY,
                    0,
                    0,
                ] : undefined,
            viewport,
            annotationMode: annotationOptions.annotationMode,
            nativeAnnotationAppearance: annotationOptions.annotationInput?.nativeAnnotationAppearance,
            ...(annotationOptions.annotationCanvasMap ? {annotationCanvasMap: annotationOptions.annotationCanvasMap} : {}),
            ...(annotationOptions.hiddenAnnotationIds ? {hiddenAnnotationIds: annotationOptions.hiddenAnnotationIds} : {}),
        };

        const result: IPreparedCanvasRender = {
            canvas,
            viewport,
            annotationCanvasMap: annotationOptions.annotationCanvasMap,
            annotationInput: annotationOptions.annotationInput,
            // Captured input, PDF.js submission copy, and structured-cloned worker bytes.
            additionalResourceBytes: 3 * (() => {
                const pdf = annotationOptions.annotationInput?.nativeAnnotationAppearance?.pdf;
                return pdf instanceof Uint8Array ? pdf.byteLength : pdf?.reduce((bytes, child) => bytes + child.byteLength, 0) ?? 0;
            })(),
            paintsAnnotations: true,
            scaleX: canvasScale.scaleX,
            scaleY: canvasScale.scaleY,
            rawDims,
            requestedPixels: pixelSize.requestedPixels,
            grantedPixels: pixelSize.grantedPixels,
            pixelScaleFactor: pixelSize.pixelScaleFactor,
            wasClamped: pixelSize.wasClamped,
            userUnit,
            totalScaleFactor: scale * userUnit,
            surfaceReservation: surfaceReservation ?? undefined,
            startRender() {
                const task = pdfPage.render(renderContext);
                return {
                    cancel: () => task.cancel(),
                    get onContinue() { return task.onContinue; },
                    set onContinue(value) { task.onContinue = value; },
                    promise: task.promise.then(() => {
                        result.annotationOutput = Object.freeze({
                            annotationMode: annotationOptions.annotationMode,
                            requestedSeparateCanvas: annotationOptions.annotationCanvasMap !== null,
                            separateAnnots: task.separateAnnots,
                            ownCanvases: Object.freeze([...annotationOptions.annotationCanvasMap?.entries() ?? []].flatMap(([
                                id,
                                canvases,
                            ]) =>
                                [canvases].flat().map(canvas => Object.freeze([
                                    id,
                                    canvas,
                                ] as const)),
                            )),
                        });
                    }),
                };
            },
        };
        return result;
    }

    async function renderCanvas(
        pdfPage: IPdfPage,
        scale: number,
        options?: IRenderCanvasOptions,
    ): Promise<ICanvasRenderResult | null> {
        const preparedRender = await prepareCanvasRender(pdfPage, scale, options);
        if (!preparedRender) {
            return null;
        }

        const renderTask = preparedRender.startRender();
        try {
            await renderTask.promise;
            return preparedRender;
        } catch (error) {
            cleanupCanvasRenderResult(preparedRender);
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
