import type { TPageNumber } from '@contracts/pageNumbers';
import type { IDocumentViewportFlingBackdrop } from '@app/modules/document-viewer/public';
import type { IPdfPageLayoutMetrics } from '@app/modules/pdf-viewer/engine/pdf-page-layout/pdfPageLayoutMetrics';
import { resolvePdfLayoutRowShape } from '@app/modules/pdf-viewer/engine/pdf-page-layout/resolvePdfLayoutRowShape';

/**
 * Describes the current row for the chassis fling backdrop. The page track sits
 * at the top of the scroll content, so a layout row top less the active
 * physical scroll-segment origin is its scroll-content coordinate.
 */
export function resolvePdfFlingBackdrop(
    layout: IPdfPageLayoutMetrics,
    page: TPageNumber,
    physicalScrollOrigin: number,
): IDocumentViewportFlingBackdrop | null {
    const shape = resolvePdfLayoutRowShape(layout, page);
    if (!shape) {
        return null;
    }
    return {
        pages: shape.pages,
        columnGap: layout.gap,
        pitch: shape.pitch,
        rowTop: shape.top - physicalScrollOrigin,
    };
}
