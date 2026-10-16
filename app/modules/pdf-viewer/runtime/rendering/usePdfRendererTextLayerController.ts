import {
    readPdfPageDocumentTeardownSignal,
    type IPdfPage,
} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import type { TPageNumber } from '@contracts/pageNumbers';
import type { usePdfTextLayerRenderer } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfTextLayerRenderer';
import type {
    IActivePdfTextLayerTask,
    IPdfLayerRenderResult,
    TClearSelectionBeforePageLayerTeardown,
    TPdfTextLayerCleanup,
} from '@app/modules/pdf-viewer/runtime/rendering/pdfRendererTypes';
import { PDF_PAGE_TEXT_LAYER_TIMEOUT_MS } from '@app/constants/timeouts';
import { isPageRenderTimeoutError } from '@app/modules/pdf-viewer/engine/pdf-page-render-timeout/isPageRenderTimeoutError';
import { withPageStageTimeout } from '@app/modules/pdf-viewer/engine/pdf-page-render-timeout/withPageStageTimeout';
import { clearPdfSelectionForLayerTeardown } from '@app/modules/pdf-viewer/engine/pdf-selection-cleanup/clearPdfSelectionForLayerTeardown';
import { BrowserLogger } from '@app/utils/browserLogger';
import { isEqual } from 'es-toolkit';
import { getTextLayerTextMapping } from '@app/modules/pdf-viewer/engine/search/pdfSearchHighlightDom';
import { isRenderCancellation } from '@app/modules/pdf-viewer/runtime/rendering/usePdfRendererAnnotationLayerController';

interface ITextLayerRenderContext {
    container: HTMLElement;
    pdfPage: IPdfPage;
    renderResult: Omit<IPdfLayerRenderResult, 'annotationCanvasMap'>;
    textLayerDiv: HTMLDivElement | null;
}

interface IUsePdfRendererTextLayerControllerOptions {
    textLayerRenderer: ReturnType<typeof usePdfTextLayerRenderer>;
    activeTextLayerAbortControllers: Map<TPageNumber, IActivePdfTextLayerTask>;
    textLayerCleanupFns: Map<TPageNumber, TPdfTextLayerCleanup>;
    getRenderVersion: () => number;
    cleanupTextLayer: (pageNumber: TPageNumber) => void;
    cancelActiveTextLayerRender: (pageNumber: TPageNumber) => void;
    cancelActiveTextLayerRenderIfCurrent: (pageNumber: TPageNumber, version: number, requestId: number) => void;
    clearSelectionBeforePageLayerTeardown: TClearSelectionBeforePageLayerTeardown;
    logNonCriticalStageError: (pageNumber: TPageNumber, stage: string, error: unknown) => void;
}

export const usePdfRendererTextLayerController = (options: IUsePdfRendererTextLayerControllerOptions) => {
    const {
        textLayerRenderer,
        activeTextLayerAbortControllers,
        textLayerCleanupFns,
        getRenderVersion,
        cleanupTextLayer,
        cancelActiveTextLayerRender,
        cancelActiveTextLayerRenderIfCurrent,
        clearSelectionBeforePageLayerTeardown,
        logNonCriticalStageError,
    } = options;

    async function renderTextLayerForPage(
        pageNumber: TPageNumber,
        version: number,
        requestId: number,
        context: ITextLayerRenderContext,
        scale: number,
        shouldContinue: () => boolean,
        publish: () => boolean = () => true,
    ) {
        const {
            container,
            pdfPage,
            renderResult,
            textLayerDiv,
        } = context;
        if (!textLayerDiv) {
            return publish();
        }
        if (getRenderVersion() !== version || !shouldContinue()) {
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

        const controller = new AbortController();
        const documentTeardown = readPdfPageDocumentTeardownSignal(pdfPage);
        const signal = documentTeardown ? AbortSignal.any([
            controller.signal,
            documentTeardown,
        ]) : controller.signal;
        const cleanupText = () => {
            clearPdfSelectionForLayerTeardown({
                target: textLayerDiv,
                root: container,
            });
            textLayerRenderer.cleanupTextLayerDom(textLayerDiv);
        };
        try {
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
                    signal,
                    () => { didRebuildTextLayer = true; },
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
                signal,
            );
            isTextLayerRendered = true;
        } catch (textLayerError) {
            if (isPageRenderTimeoutError(textLayerError)) {
                cleanupText();
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
                || isRenderCancellation(textLayerError)
            ) {
                // A newer render of this page cancelled this one and already
                // owns the shared text layer; cleaning it here would erase
                // that render's work.
                const owner = activeTextLayerAbortControllers.get(pageNumber);
                if (owner && owner.controller !== controller) {
                    return false;
                }
                cleanupText();
                return false;
            } else {
                logNonCriticalStageError(
                    pageNumber,
                    'text layer',
                    textLayerError,
                );
                cleanupText();
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

        if (getRenderVersion() !== version || !shouldContinue()) return false;
        const outgoing = container.querySelector<HTMLDivElement>('.text-layer');
        const selection = outgoing !== textLayerDiv ? container.ownerDocument.getSelection() : null;
        const previous = outgoing && getTextLayerTextMapping(outgoing);
        const incoming = getTextLayerTextMapping(textLayerDiv);
        const remap = (node: Node | null, offset: number) => {
            if (!node || !outgoing?.contains(node)) return [
                node,
                offset,
            ] as const;
            const index = previous?.textDivs.findIndex(span => span.contains(node)) ?? -1;
            const span = previous?.textDivs[index];
            const target = incoming?.textDivs[index]?.firstChild;
            if (!span || !(target instanceof Text)) return null;
            const prefix = span.ownerDocument.createRange();
            prefix.selectNodeContents(span);
            prefix.setEnd(node, offset);
            return [
                target,
                prefix.toString().length,
            ] as const;
        };
        const anchor = selection && previous && incoming
            && (outgoing?.contains(selection.anchorNode) || outgoing?.contains(selection.focusNode))
            && isEqual(previous.textContentItemsStr, incoming.textContentItemsStr)
            ? remap(selection.anchorNode, selection.anchorOffset) : null;
        const focus = anchor && selection ? remap(selection.focusNode, selection.focusOffset) : null;
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
                logNonCriticalStageError(
                    pageNumber,
                    'text layer interaction',
                    textLayerInteractionError,
                );
                textLayerRenderer.cleanupTextLayerDom(textLayerDiv);
                return false;
            }
        }

        if (!isTextLayerRendered) return false;
        if (anchor?.[0] && focus?.[0]) selection?.setBaseAndExtent(anchor[0], anchor[1], focus[0], focus[1]);

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
