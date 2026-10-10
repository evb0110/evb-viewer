import type {IPdfDocument} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import { requirePageNumber } from '@contracts/pageNumbers';
import type { TPageNumber } from '@contracts/pageNumbers';
import type {
    ComputedRef,
    Ref,
    ShallowRef,
} from 'vue';
import type {TPdfViewMode} from '@app/types/pdfContracts';
import type { IPageRange } from '@app/types/pdfUi';
import {
    getPageRowBoundsForViewMode,
    createDocumentViewerActivationRunGuard,
    runDocumentViewerActivationPresentation,
    waitForDocumentViewerVisibleLayout,
} from '@app/modules/document-viewer/public';

interface IUsePdfViewerActivationRestoreOptions {
    viewerContainer: Ref<HTMLElement | null>;
    pdfDocument: ShallowRef<IPdfDocument | null>;
    isActive: ComputedRef<boolean>;
    isLoading: Ref<boolean>;
    numPages: Ref<number>;
    currentPage: Ref<number>;
    visibleRange: Ref<IPageRange>;
    viewMode: ComputedRef<TPdfViewMode>;
    getVisiblePageRange: (container: HTMLElement | null, numPages: number) => IPageRange | null;
    renderVisiblePages: (range: IPageRange, options?: {preserveRenderedPages?: boolean}) => Promise<void>;
    isPageRendered?: ((pageNumber: TPageNumber) => boolean) | undefined;
    applySearchHighlights: () => void;
    // Retained only while callers shed the old transaction-controller argument.
    transactionController?: unknown;
}

/**
 * Activation is a single resume operation. Slot demand/rendering remains with
 * the normal renderer; this adapter neither polls the DOM nor starts recovery.
 * The place belongs to the viewport session, which restores its committed
 * semantic anchor when the view becomes active; this adapter never scrolls.
 */
export const usePdfViewerActivationRestore = (options: IUsePdfViewerActivationRestoreOptions) => {
    const activationRun = createDocumentViewerActivationRunGuard(() => (
        options.isActive.value && !options.isLoading.value
    ));

    function nextActivationRestoreRunId() {
        return activationRun.begin();
    }

    function isActivationRunCurrent(runId: number) {
        return activationRun.isCurrent(runId);
    }

    function currentRow(): IPageRange {
        const row = getPageRowBoundsForViewMode({
            pageNumber: requirePageNumber(options.currentPage.value, Math.max(1, options.numPages.value)),
            viewMode: options.viewMode.value,
            totalPages: Math.max(1, options.numPages.value),
        });
        return {
            start: row.start,
            end: row.end,
        };
    }

    async function renderActiveDocumentAfterActivation(runId: number) {
        const document = options.pdfDocument.value;
        if (!document || !isActivationRunCurrent(runId)) {
            return;
        }
        const isCurrent = () => (
            isActivationRunCurrent(runId)
            && options.pdfDocument.value === document
        );
        await runDocumentViewerActivationPresentation({
            isCurrent,
            waitForVisibleLayout: () => waitForDocumentViewerVisibleLayout(
                () => options.viewerContainer.value,
                {isCurrent},
            ),
            measure: () => {
                const measured = options.getVisiblePageRange(
                    options.viewerContainer.value,
                    options.numPages.value,
                );
                if (measured) {
                    options.visibleRange.value = measured;
                }
            },
            reconcile: async () => {
                await options.renderVisiblePages(currentRow(), {preserveRenderedPages: true});
                if (isCurrent()) {
                    options.applySearchHighlights();
                }
            },
        });
    }

    return {
        nextActivationRestoreRunId,
        isActivationRunCurrent,
        isActivationRestoreRunCurrent: (runId: number, document = options.pdfDocument.value) => (
            isActivationRunCurrent(runId) && document !== null && options.pdfDocument.value === document
        ),
        renderActiveDocumentAfterActivation,
    };
};
