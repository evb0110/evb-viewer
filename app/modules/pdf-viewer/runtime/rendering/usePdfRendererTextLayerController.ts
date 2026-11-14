import {
    readPdfPageDocumentTeardownSignal,
    type IPdfPage,
} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import type { TPageNumber } from '@contracts/pageNumbers';
import type { usePdfTextLayerRenderer } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfTextLayerRenderer';
import type { IPdfLayerRenderResult } from '@app/modules/pdf-viewer/runtime/rendering/pdfRendererTypes';
import { PDF_PAGE_TEXT_LAYER_TIMEOUT_MS } from '@app/constants/timeouts';
import { isPageRenderTimeoutError } from '@app/modules/pdf-viewer/engine/pdf-page-render-timeout/isPageRenderTimeoutError';
import { withPageStageTimeout } from '@app/modules/pdf-viewer/engine/pdf-page-render-timeout/withPageStageTimeout';
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
    pdfPage: IPdfPage;
    renderResult: Pick<IPdfLayerRenderResult, 'viewport'>;
    textLayerDiv: HTMLDivElement | null;
}

interface IUsePdfRendererTextLayerControllerOptions {
    textLayerRenderer: Pick<ReturnType<typeof usePdfTextLayerRenderer>, 'renderTextLayer'>;
    logNonCriticalStageError: (pageNumber: TPageNumber, stage: string, error: unknown) => FailureReceipt | undefined;
}

/**
 * Renders a page's text layer under its layer owner's signal, then asks the
 * owner to publish. The canvas publishes even when the text fails, so the page
 * stays readable and offers Retry for its text; a cancelled render publishes
 * nothing.
 */
export const usePdfRendererTextLayerController = (options: IUsePdfRendererTextLayerControllerOptions) => {
    const {textLayerRenderer, logNonCriticalStageError} = options;

    return async function renderTextLayerForPage(
        pageNumber: TPageNumber,
        context: ITextLayerRenderContext,
        ownerSignal: AbortSignal,
        shouldContinue: () => boolean,
        publish: () => boolean = () => true,
    ): Promise<boolean | IPdfLayerStageFailure> {
        const {pdfPage, renderResult, textLayerDiv} = context;
        if (!textLayerDiv) {
            return publish();
        }
        if (!shouldContinue()) {
            return false;
        }
        const controller = new AbortController();
        const documentTeardown = readPdfPageDocumentTeardownSignal(pdfPage);
        const signal = AbortSignal.any(documentTeardown
            ? [controller.signal, ownerSignal, documentTeardown]
            : [controller.signal, ownerSignal]);
        let failure: IPdfLayerStageFailure | null = null;
        try {
            await withPageStageTimeout(
                textLayerRenderer.renderTextLayer(pdfPage, textLayerDiv, renderResult.viewport, signal),
                {
                    pageNumber,
                    stage: 'text-layer',
                    timeoutMs: PDF_PAGE_TEXT_LAYER_TIMEOUT_MS,
                },
                shouldContinue,
                () => controller.abort(),
                // Text is optional once the canvas is mounted: its own stage
                // timeout stands, but it does not enter canvas stall recovery.
                undefined,
                undefined,
                signal,
            );
        } catch (error) {
            if (!isPageRenderTimeoutError(error) && (!shouldContinue() || isRenderCancellation(error))) {
                return false;
            }
            failure = {
                failure: logNonCriticalStageError(pageNumber, 'text layer', error),
                error,
            };
        }
        if (!shouldContinue() || !publish()) return false;
        return failure ?? true;
    };
};
