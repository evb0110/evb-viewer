import type {IPdfDocument} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import type {
    Ref,
    ShallowRef,
} from 'vue';
import { delay } from 'es-toolkit/promise';
import { BrowserLogger } from '@app/utils/browserLogger';
import type { IPageRange } from '@app/types/pdfUi';
import type { ICurrentPageSyncOptions } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerCurrentPageSync';

const RECOVERY_TRANSACTION_RETRY_DELAYS_MS = [
    0,
    80,
    160,
    320,
] as const;

interface IInitialRenderRecoveryTransactionController {
    beginTransaction: (options: {
        kind: 'recovery';
        source: 'render-stall-recovery';
        page: number;
        range: IPageRange;
        anchor: 'top';
    }) => { id: number } | null;
    advanceTransaction: (
        transactionId: number,
        state: 'render-requested' | 'settled',
    ) => boolean;
    isTransactionCurrent: (transactionId: number) => boolean;
    commitVisibleRange: (
        range: IPageRange,
        options?: { transactionId?: number | undefined },
    ) => boolean;
}

interface IInitialRenderRecoveryContext {
    isCurrent: () => boolean;
    initialRenderError?: unknown;
}

interface IUsePdfViewerInitialRenderRecoveryOptions {
    viewerContainer: Ref<HTMLElement | null>;
    pdfDocument: ShallowRef<IPdfDocument | null> | Ref<IPdfDocument | null>;
    numPages: Ref<number>;
    isLoading: Ref<boolean>;
    currentPage: Ref<number>;
    computeFitWidthScale: (container: HTMLElement | null) => boolean;
    getVisibleRange: () => IPageRange;
    updateVisibleRange: (container: HTMLElement | null, numPages: number) => void;
    renderVisiblePages: (
        range: IPageRange,
        options?: {
            bufferOverride?: number;
            forceRerender?: boolean;
        },
    ) => Promise<void>;
    syncCurrentPageFromViewport: (options?: ICurrentPageSyncOptions) => Promise<void>;
    transactionController?: IInitialRenderRecoveryTransactionController | undefined;
    isInitialCanvasCommitted?: (() => boolean) | undefined;
    onTerminalFailure?: ((error: Error) => void) | undefined;
}

export const usePdfViewerInitialRenderRecovery = (
    options: IUsePdfViewerInitialRenderRecoveryOptions,
) => {
    function isEligible(context: IInitialRenderRecoveryContext) {
        return context.isCurrent()
            && options.pdfDocument.value !== null
            && !options.isLoading.value
            && options.numPages.value > 0;
    }

    function getNormalizedVisibleRange() {
        const range = options.getVisibleRange();
        const currentPage = Number.isFinite(options.currentPage.value)
            ? Math.floor(options.currentPage.value)
            : 1;
        const fallbackPage = Math.max(1, Math.min(
            options.numPages.value,
            currentPage,
        ));
        const rangeStart = Number.isFinite(range.start)
            ? Math.floor(range.start)
            : fallbackPage;
        const rangeEnd = Number.isFinite(range.end)
            ? Math.floor(range.end)
            : rangeStart;
        const start = Math.max(1, Math.min(
            options.numPages.value,
            rangeStart,
        ));
        const end = Math.max(start, Math.min(
            options.numPages.value,
            rangeEnd,
        ));
        return {
            start,
            end,
        } satisfies IPageRange;
    }

    function hasCommittedInitialCanvas() {
        if (options.isInitialCanvasCommitted) {
            return options.isInitialCanvasCommitted();
        }
        const container = options.viewerContainer.value;
        if (!container || options.numPages.value <= 0) {
            return false;
        }
        const currentPage = Math.max(1, Math.min(
            options.numPages.value,
            Number.isFinite(options.currentPage.value)
                ? Math.floor(options.currentPage.value)
                : 1,
        ));
        const canvas = container.querySelector<HTMLCanvasElement>(
            `.page_container[data-page="${currentPage}"] .page_canvas canvas`,
        );
        return Boolean(canvas?.isConnected && canvas.width > 0 && canvas.height > 0);
    }

    function refreshVisibleRange() {
        options.computeFitWidthScale(options.viewerContainer.value);
        options.updateVisibleRange(options.viewerContainer.value, options.numPages.value);
        return getNormalizedVisibleRange();
    }

    async function beginRecoveryTransaction(context: IInitialRenderRecoveryContext) {
        if (!options.transactionController) {
            return null;
        }
        for (const retryDelay of RECOVERY_TRANSACTION_RETRY_DELAYS_MS) {
            if (retryDelay > 0) {
                await delay(retryDelay);
            }
            if (!isEligible(context) || hasCommittedInitialCanvas()) {
                return null;
            }
            const range = getNormalizedVisibleRange();
            const transaction = options.transactionController.beginTransaction({
                kind: 'recovery',
                source: 'render-stall-recovery',
                page: Math.max(range.start, Math.min(
                    range.end,
                    Number.isFinite(options.currentPage.value)
                        ? Math.floor(options.currentPage.value)
                        : range.start,
                )),
                range,
                anchor: 'top',
            });
            if (transaction) {
                return transaction.id;
            }
        }
        return null;
    }

    function isRecoveryTransactionCurrent(transactionId: number | null) {
        return transactionId === null
            || options.transactionController?.isTransactionCurrent(transactionId) !== false;
    }

    function commitRecoveryVisibleRange(range: IPageRange, transactionId: number | null) {
        if (transactionId === null) {
            return true;
        }
        return options.transactionController?.commitVisibleRange(
            range,
            { transactionId },
        ) !== false;
    }

    function settleRecoveryTransaction(transactionId: number | null) {
        if (transactionId === null || !isRecoveryTransactionCurrent(transactionId)) {
            return;
        }
        options.transactionController?.advanceTransaction(transactionId, 'settled');
    }

    async function runBoundedRecoveryRender(
        context: IInitialRenderRecoveryContext,
        transactionId: number | null,
    ) {
        if (!isEligible(context) || !isRecoveryTransactionCurrent(transactionId)) {
            return;
        }
        const range = refreshVisibleRange();
        if (!commitRecoveryVisibleRange(range, transactionId)) {
            return;
        }
        if (transactionId !== null) {
            options.transactionController?.advanceTransaction(transactionId, 'render-requested');
        }
        await options.renderVisiblePages(range, {
            bufferOverride: 0,
            forceRerender: true,
        });
        if (!isEligible(context) || !isRecoveryTransactionCurrent(transactionId)) {
            return;
        }
        await options.syncCurrentPageFromViewport({
            source: 'render-stall-recovery',
            ...(transactionId !== null ? { transactionId } : {}),
        });
    }

    async function recoverInitialRenderIfNeeded(context: IInitialRenderRecoveryContext) {
        if (
            context.initialRenderError === undefined
            || !isEligible(context)
            || hasCommittedInitialCanvas()
        ) {
            return 'complete' as const;
        }
        const transactionId = await beginRecoveryTransaction(context);
        if (options.transactionController && transactionId === null) {
            return 'deferred' as const;
        }
        try {
            await runBoundedRecoveryRender(context, transactionId);
        } catch (error) {
            BrowserLogger.error(
                'pdf-viewer',
                'Failed to render visible pages during bounded initial recovery',
                error,
                {
                    code: 'RENDERER_PDF_INITIAL_RENDER_RECOVERY_FAILED',
                    context: {phase: 'render'},
                },
            );
            if (
                isEligible(context)
                && isRecoveryTransactionCurrent(transactionId)
                && !hasCommittedInitialCanvas()
            ) {
                options.onTerminalFailure?.(new Error(
                    'The initial PDF render and its bounded recovery transaction both failed.',
                    {cause: error},
                ));
            }
        } finally {
            settleRecoveryTransaction(transactionId);
        }
        return hasCommittedInitialCanvas() ? 'complete' as const : 'awaiting-canvas-commit' as const;
    }

    function scheduleRecoverInitialRender(context: IInitialRenderRecoveryContext) {
        void recoverInitialRenderIfNeeded(context).catch((error: unknown) => {
            BrowserLogger.error(
                'pdf-viewer',
                'Failed to coordinate bounded initial render recovery',
                error,
                {
                    code: 'RENDERER_PDF_INITIAL_RENDER_RECOVERY_FAILED',
                    context: {phase: 'coordinate'},
                },
            );
        });
    }

    return { scheduleRecoverInitialRender };
};
