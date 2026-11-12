import {
    readPdfPageDocumentTeardownSignal,
    type IPdfPage,
} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import type { TPageNumber } from '@contracts/pageNumbers';
import type { usePdfTextLayerRenderer } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfTextLayerRenderer';
import type {
    IPdfLayerRenderResult,
    TClearSelectionBeforePageLayerTeardown,
    TPdfTextLayerCleanup,
} from '@app/modules/pdf-viewer/runtime/rendering/pdfRendererTypes';
import { PDF_PAGE_TEXT_LAYER_TIMEOUT_MS } from '@app/constants/timeouts';
import { isPageRenderTimeoutError } from '@app/modules/pdf-viewer/engine/pdf-page-render-timeout/isPageRenderTimeoutError';
import { withPageStageTimeout } from '@app/modules/pdf-viewer/engine/pdf-page-render-timeout/withPageStageTimeout';
import { clearPdfSelectionForLayerTeardown } from '@app/modules/pdf-viewer/engine/pdf-selection-cleanup/clearPdfSelectionForLayerTeardown';
import type {FailureReceipt} from '@contracts/diagnostics/failureReceipt';

export function isRenderCancellation(error: unknown) {
    const name = error && typeof error === 'object' ? (error as {name?: unknown}).name : undefined;
    return name === 'AbortError' || name === 'RenderingCancelledException';
}

export interface IPdfLayerStageFailure {
    failure: FailureReceipt | undefined;
    error: unknown;
}

interface ITextLayerRenderContext {
    container: HTMLElement;
    pdfPage: IPdfPage;
    renderResult: Omit<IPdfLayerRenderResult, 'annotationCanvasMap'>;
    textLayerDiv: HTMLDivElement | null;
}

/** The page's layer owner: its abort signal, and whether a newer owner replaced it. */
interface ITextLayerOwner {
    signal: AbortSignal;
    isSuperseded: () => boolean;
}

interface IUsePdfRendererTextLayerControllerOptions {
    textLayerRenderer: ReturnType<typeof usePdfTextLayerRenderer>;
    textLayerCleanupFns: Map<TPageNumber, TPdfTextLayerCleanup>;
    cleanupTextLayer: (pageNumber: TPageNumber) => void;
    clearSelectionBeforePageLayerTeardown: TClearSelectionBeforePageLayerTeardown;
    logNonCriticalStageError: (pageNumber: TPageNumber, stage: string, error: unknown) => FailureReceipt | undefined;
}

export const usePdfRendererTextLayerController = (options: IUsePdfRendererTextLayerControllerOptions) => {
    const {
        textLayerRenderer,
        textLayerCleanupFns,
        cleanupTextLayer,
        clearSelectionBeforePageLayerTeardown,
        logNonCriticalStageError,
    } = options;

    async function renderTextLayerForPage(
        pageNumber: TPageNumber,
        context: ITextLayerRenderContext,
        scale: number,
        owner: ITextLayerOwner,
        shouldContinue: () => boolean,
        publish: () => boolean = () => true,
    ): Promise<boolean | IPdfLayerStageFailure> {
        // A text layer that failed or timed out, rather than one a newer
        // render replaced; it is not tried again until asked.
        let failure: IPdfLayerStageFailure | null = null;
        const {
            container,
            pdfPage,
            renderResult,
            textLayerDiv,
        } = context;
        if (!textLayerDiv) {
            return publish();
        }
        if (!shouldContinue()) {
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

        let isTextLayerRendered = false;
        // A pure scale or rotation step reuses the mounted spans, so the
        // selection and the interaction handlers that hang off them survive.
        // Only a content rebuild may tear them down.
        let didRebuildTextLayer = false;

        const controller = new AbortController();
        const documentTeardown = readPdfPageDocumentTeardownSignal(pdfPage);
        const signal = AbortSignal.any(documentTeardown ? [
            controller.signal,
            owner.signal,
            documentTeardown,
        ] : [
            controller.signal,
            owner.signal,
        ]);
        const cleanupText = () => {
            clearPdfSelectionForLayerTeardown({
                target: textLayerDiv,
                root: container,
            });
            textLayerRenderer.cleanupTextLayerDom(textLayerDiv);
        };
        try {
            await withPageStageTimeout(
                textLayerRenderer.renderTextLayer(
                    pdfPage,
                    textLayerDiv,
                    viewport,
                    scale,
                    userUnit,
                    totalScaleFactor,
                    signal,
                    () => { didRebuildTextLayer = true; },
                ),
                {
                    pageNumber,
                    stage: 'text-layer',
                    timeoutMs: PDF_PAGE_TEXT_LAYER_TIMEOUT_MS,
                },
                shouldContinue,
                () => controller.abort(),
                // Optional enrichment must not enter the canonical render-stall
                // recovery loop; the local timeout and diagnostic error are enough.
                undefined,
                // Text selection/search enrichment is optional once the canonical
                // canvas is mounted. Its own stage timeout remains authoritative,
                // but it must not trip the canonical render heartbeat circuit.
                undefined,
                signal,
            );
            isTextLayerRendered = true;
        } catch (textLayerError) {
            if (isPageRenderTimeoutError(textLayerError)) {
                cleanupText();
                // The canvas stays readable; the page offers Retry for its text.
                failure = {
                    failure: logNonCriticalStageError(pageNumber, 'text layer', textLayerError),
                    error: textLayerError,
                };
            } else if (!shouldContinue() || isRenderCancellation(textLayerError)) {
                // A newer owner of this page already holds the shared text
                // layer; cleaning it here would erase that render's work. A
                // scale-only reuse is synchronous, so only a rebuild this
                // render started can be left half-built.
                if (!owner.isSuperseded() && didRebuildTextLayer) cleanupText();
                return false;
            } else {
                failure = {
                    failure: logNonCriticalStageError(
                        pageNumber,
                        'text layer',
                        textLayerError,
                    ),
                    error: textLayerError,
                };
                cleanupText();
            }
        }

        if (!shouldContinue()) return false;
        if (!publish()) {
            textLayerRenderer.cleanupTextLayerDom(textLayerDiv);
            return false;
        }
        if (didRebuildTextLayer) {
            clearSelectionBeforePageLayerTeardown(pageNumber);
            cleanupTextLayer(pageNumber);
        }
        if (isTextLayerRendered && didRebuildTextLayer) {
            try {
                textLayerCleanupFns.set(pageNumber, textLayerRenderer.setupTextLayerInteraction(textLayerDiv));
            } catch (textLayerInteractionError) {
                textLayerRenderer.cleanupTextLayerDom(textLayerDiv);
                return {
                    failure: logNonCriticalStageError(
                        pageNumber,
                        'text layer interaction',
                        textLayerInteractionError,
                    ),
                    error: textLayerInteractionError,
                };
            }
        }

        if (!isTextLayerRendered) return failure ?? false;

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
                viewport,
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
