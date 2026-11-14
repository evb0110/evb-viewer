import { createPdfPageSlotRegistry } from '@app/modules/pdf-viewer/runtime/page-slots/pdfPageSlotRegistry';
import {
    resolveDocumentContinuousScrollGeometry,
    resolveDocumentContinuousScrollWindow,
} from '@app/modules/document-viewer/viewport/resolveDocumentContinuousScrollWindow';

export function createProductionViewportAdapter() {
    const pageSlots = createPdfPageSlotRegistry();

    return {
        pageSlots,
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
