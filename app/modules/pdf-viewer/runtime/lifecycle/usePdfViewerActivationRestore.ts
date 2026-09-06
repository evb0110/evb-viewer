import type {IPdfDocument} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import type {
    ComputedRef,
    Ref,
    ShallowRef,
} from 'vue';
import type {TPdfViewMode} from '@app/types/pdfContracts';
import type { IPageRange } from '@app/types/pdfUi';
import { getPageRowBoundsForViewMode } from '@app/modules/pdf-viewer/engine/pdf-page-layout/getPageRowBoundsForViewMode';
import { createDocumentViewerActivationRunGuard } from '@app/utils/document-viewer/lifecycle/createDocumentViewerActivationRunGuard';
import {
    runDocumentViewerActivationPresentation,
    waitForDocumentViewerVisibleLayout,
} from '@app/utils/document-viewer/lifecycle/documentViewerActivationPresentation';
import { isPdfInitialVisualCanvasReady } from '@app/modules/pdf-viewer/runtime/lifecycle/isPdfInitialVisualCanvasReady';
import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';

interface IUsePdfViewerActivationRestoreOptions {
    viewerContainer: Ref<HTMLElement | null>;
    pdfDocument: ShallowRef<IPdfDocument | null>;
    isActive: ComputedRef<boolean>;
    isLoading: Ref<boolean>;
    numPages: Ref<number>;
    currentPage: Ref<number>;
    visibleRange: Ref<IPageRange>;
    viewMode: ComputedRef<TPdfViewMode>;
    getVisiblePageRange?: ((container: HTMLElement | null, numPages: number) => IPageRange) | undefined;
    updateVisibleRange: (container: HTMLElement | null, numPages: number) => void;
    scrollToPage: (pageNumber: number) => void;
    renderVisiblePages: (range: IPageRange, options?: {preserveRenderedPages?: boolean}) => Promise<void>;
    isPageRendered?: ((pageNumber: number) => boolean) | undefined;
    applySearchHighlights: () => void;
    // Retained only while callers shed the old transaction-controller argument.
    transactionController?: unknown;
}

/**
 * Activation is a single resume operation. Slot demand/rendering remains with
 * the normal renderer; this adapter neither polls the DOM nor starts recovery.
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
            pageNumber: options.currentPage.value,
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
                const measured = options.getVisiblePageRange?.(
                    options.viewerContainer.value,
                    options.numPages.value,
                );
                if (measured) {
                    options.visibleRange.value = measured;
                } else {
                    options.updateVisibleRange(options.viewerContainer.value, options.numPages.value);
                }
            },
            reconcile: async () => {
                const row = currentRow();
                const container = options.viewerContainer.value;
                const page = options.currentPage.value;
                const physicallyVisible = isPdfInitialVisualCanvasReady(container, page, page);
                if (
                    !physicallyVisible
                    || page < options.visibleRange.value.start
                    || page > options.visibleRange.value.end
                ) {
                    logPdfRenderTrace('pdf-activation-viewport-reanchor', {
                        page,
                        physicallyVisible,
                        scrollTop: container?.scrollTop ?? null,
                        visibleRange: options.visibleRange.value,
                    });
                    options.scrollToPage(options.currentPage.value);
                }
                await options.renderVisiblePages(row, {preserveRenderedPages: true});
                if (isCurrent()) {
                    logPdfRenderTrace('pdf-activation-viewport-reanchor-settled', {
                        page,
                        physicallyVisible: isPdfInitialVisualCanvasReady(container, page, page),
                        scrollTop: container?.scrollTop ?? null,
                    });
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
