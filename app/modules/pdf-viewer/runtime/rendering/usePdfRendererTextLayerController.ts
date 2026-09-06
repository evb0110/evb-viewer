import type {IPdfPage} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import type { usePdfTextLayerRenderer } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfTextLayerRenderer';
import type {
    IActivePdfTextLayerTask,
    TClearSelectionBeforePageLayerTeardown,
    TPdfTextLayerCleanup,
} from '@app/modules/pdf-viewer/runtime/rendering/pdfRendererTypes';
import { PDF_PAGE_TEXT_LAYER_TIMEOUT_MS } from '@app/constants/timeouts';
import { isPageRenderTimeoutError } from '@app/modules/pdf-viewer/engine/pdf-page-render-timeout/isPageRenderTimeoutError';
import { withPageStageTimeout } from '@app/modules/pdf-viewer/engine/pdf-page-render-timeout/withPageStageTimeout';
import { clearPdfSelectionForLayerTeardown } from '@app/modules/pdf-viewer/engine/pdf-selection-cleanup/clearPdfSelectionForLayerTeardown';
import { BrowserLogger } from '@app/utils/browserLogger';

interface ITextLayerRenderContext {
    container: HTMLElement;
    pdfPage: IPdfPage;
    renderResult: {
        canvas: HTMLCanvasElement;
        viewport: Parameters<ReturnType<typeof usePdfTextLayerRenderer>['renderTextLayer']>[2];
        scaleX: number;
        scaleY: number;
        rawDims: {
            pageWidth: number;
            pageHeight: number;
        };
        userUnit: number;
        totalScaleFactor: number;
    };
    textLayerDiv: HTMLDivElement | null;
    preserveCanvasOnStale?: boolean;
}

interface IUsePdfRendererTextLayerControllerOptions {
    textLayerRenderer: ReturnType<typeof usePdfTextLayerRenderer>;
    activeTextLayerAbortControllers: Map<number, IActivePdfTextLayerTask>;
    textLayerCleanupFns: Map<number, TPdfTextLayerCleanup>;
    getRenderVersion: () => number;
    cleanupTextLayer: (pageNumber: number) => void;
    cleanupPageIfCurrentRender: (pageNumber: number, version: number, requestId?: number) => void;
    cancelActiveTextLayerRender: (pageNumber: number) => void;
    cancelActiveTextLayerRenderIfCurrent: (pageNumber: number, version: number, requestId: number) => void;
    clearSelectionBeforePageLayerTeardown: TClearSelectionBeforePageLayerTeardown;
    logNonCriticalStageError: (pageNumber: number, stage: string, error: unknown) => void;
}

export const usePdfRendererTextLayerController = (options: IUsePdfRendererTextLayerControllerOptions) => {
    const {
        textLayerRenderer,
        activeTextLayerAbortControllers,
        textLayerCleanupFns,
        getRenderVersion,
        cleanupTextLayer,
        cleanupPageIfCurrentRender,
        cancelActiveTextLayerRender,
        cancelActiveTextLayerRenderIfCurrent,
        clearSelectionBeforePageLayerTeardown,
        logNonCriticalStageError,
    } = options;

    async function renderTextLayerForPage(
        pageNumber: number,
        version: number,
        requestId: number,
        context: ITextLayerRenderContext,
        scale: number,
        shouldContinue: () => boolean,
    ) {
        const {
            container,
            pdfPage,
            renderResult,
            textLayerDiv,
            preserveCanvasOnStale = false,
        } = context;
        if (!textLayerDiv) {
            return true;
        }
        if (getRenderVersion() !== version || !shouldContinue()) {
            if (!preserveCanvasOnStale) {
                cleanupPageIfCurrentRender(pageNumber, version, requestId);
            }
            return false;
        }

        const {
            canvas,
            viewport,
            scaleX,
            scaleY,
            rawDims,
            userUnit,
            totalScaleFactor,
        } = renderResult;

        cancelActiveTextLayerRender(pageNumber);
        let isTextLayerRendered = false;
        // A pure scale or rotation step reuses the mounted spans, so the
        // selection and the interaction handlers that hang off them survive.
        // Only a content rebuild may tear them down.
        let didRebuildTextLayer = false;
        const teardownBeforeTextLayerRebuild = () => {
            didRebuildTextLayer = true;
            clearSelectionBeforePageLayerTeardown(pageNumber);
            cleanupTextLayer(pageNumber);
        };

        try {
            const controller = new AbortController();
            activeTextLayerAbortControllers.set(pageNumber, {
                version,
                requestId,
                controller,
            });
            await withPageStageTimeout(
                textLayerRenderer.renderTextLayer(
                    pdfPage,
                    textLayerDiv,
                    viewport,
                    scale,
                    userUnit,
                    totalScaleFactor,
                    controller.signal,
                    teardownBeforeTextLayerRebuild,
                ),
                {
                    pageNumber,
                    stage: 'text-layer',
                    timeoutMs: PDF_PAGE_TEXT_LAYER_TIMEOUT_MS,
                },
                () => getRenderVersion() === version && shouldContinue(),
                () => {
                    cancelActiveTextLayerRenderIfCurrent(pageNumber, version, requestId);
                },
                // Optional enrichment must not enter the canonical render-stall
                // recovery loop; the local timeout and diagnostic error are enough.
                undefined,
                // Text selection/search enrichment is optional once the canonical
                // canvas is mounted. Its own stage timeout remains authoritative,
                // but it must not trip the canonical render heartbeat circuit.
                undefined,
                controller.signal,
            );
            isTextLayerRendered = true;
        } catch (textLayerError) {
            if (isPageRenderTimeoutError(textLayerError)) {
                clearPdfSelectionForLayerTeardown({
                    target: textLayerDiv,
                    root: container,
                });
                textLayerRenderer.cleanupTextLayerDom(textLayerDiv);
                BrowserLogger.warn(
                    'pdf-renderer',
                    `Optional text layer enrichment timed out for page ${String(pageNumber)}`,
                    {
                        pageNumber,
                        stage: textLayerError.stage,
                        timeoutMs: textLayerError.timeoutMs,
                    },
                );
                // The canvas is already mounted. A nonessential text layer must not
                // turn a readable page into a blank page when it stalls.
                isTextLayerRendered = false;
            } else if (
                getRenderVersion() !== version
                || !shouldContinue()
                || (
                    textLayerError
                    && typeof textLayerError === 'object'
                    && (textLayerError as { name?: unknown }).name === 'AbortError'
                )
            ) {
                clearPdfSelectionForLayerTeardown({
                    target: textLayerDiv,
                    root: container,
                });
                textLayerRenderer.cleanupTextLayerDom(textLayerDiv);
                if (!preserveCanvasOnStale) {
                    cleanupPageIfCurrentRender(pageNumber, version, requestId);
                }
                return false;
            } else {
                logNonCriticalStageError(
                    pageNumber,
                    'text layer',
                    textLayerError,
                );
                clearPdfSelectionForLayerTeardown({
                    target: textLayerDiv,
                    root: container,
                });
                textLayerRenderer.cleanupTextLayerDom(textLayerDiv);
            }
        } finally {
            const activeTextLayer = activeTextLayerAbortControllers.get(pageNumber);
            if (
                activeTextLayer?.version === version
                && activeTextLayer.requestId === requestId
            ) {
                activeTextLayerAbortControllers.delete(pageNumber);
            }
        }

        if (getRenderVersion() !== version || !shouldContinue()) {
            if (!preserveCanvasOnStale) {
                cleanupPageIfCurrentRender(pageNumber, version, requestId);
            }
            return false;
        }

        if (!isTextLayerRendered) {
            return true;
        }

        if (didRebuildTextLayer) {
            try {
                const cleanup =
                    textLayerRenderer.setupTextLayerInteraction(textLayerDiv);
                if (typeof cleanup === 'function') {
                    textLayerCleanupFns.set(pageNumber, cleanup);
                }
            } catch (textLayerInteractionError) {
                logNonCriticalStageError(
                    pageNumber,
                    'text layer interaction',
                    textLayerInteractionError,
                );
            }
        }

        try {
            textLayerRenderer.applyPageSearchHighlights(
                container,
                textLayerDiv,
                pageNumber,
                canvas,
                {
                    userUnit,
                    totalScaleFactor,
                    viewportWidth: viewport.width,
                    viewportHeight: viewport.height,
                    rawPageWidth: rawDims.pageWidth,
                    rawPageHeight: rawDims.pageHeight,
                    canvasPixelWidth: canvas.width,
                    canvasPixelHeight: canvas.height,
                    renderScaleX: scaleX,
                    renderScaleY: scaleY,
                },
            );
        } catch (searchHighlightError) {
            logNonCriticalStageError(
                pageNumber,
                'search highlights',
                searchHighlightError,
            );
        }

        return true;
    }

    return renderTextLayerForPage;
};
