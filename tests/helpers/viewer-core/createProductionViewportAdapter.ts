import { createPdfPageSlotRegistry } from '@app/modules/pdf-viewer/runtime/page-slots/pdfPageSlotRegistry';
import { createPdfPageRenderState } from '@app/modules/pdf-viewer/runtime/rendering/pdfPageRenderState';
import {
    createDocumentViewportNavigationMachineState,
    reduceDocumentViewportNavigationMachine,
    type TDocumentViewportNavigationEvent,
} from '@app/modules/document-viewer/viewport/documentViewportNavigationMachine';
import {
    resolveDocumentContinuousScrollGeometry,
    resolveDocumentContinuousScrollWindow,
} from '@app/modules/document-viewer/viewport/resolveDocumentContinuousScrollWindow';

export function createProductionViewportAdapter() {
    let navigation = createDocumentViewportNavigationMachineState();
    const pageSlots = createPdfPageSlotRegistry();
    const renderState = createPdfPageRenderState();

    return {
        pageSlots,
        renderState,
        get navigation() {
            return navigation;
        },
        dispatch(event: TDocumentViewportNavigationEvent) {
            navigation = reduceDocumentViewportNavigationMachine(navigation, event);
            return navigation;
        },
        resolveWindow(options: {
            currentPage: number;
            scrollTop: number;
            totalPages: number;
        }) {
            const pageHeights = Array.from({length: options.totalPages}, () => 1_000);
            const geometry = resolveDocumentContinuousScrollGeometry({
                pageGapPx: 10,
                pageHeights,
                totalPages: options.totalPages,
            });
            return resolveDocumentContinuousScrollWindow({
                ...options,
                geometry,
                overscanViewports: 1,
                pageGapPx: 10,
                pageHeights,
                renderMarginPages: 2,
                viewportHeight: 800,
            });
        },
    };
}
