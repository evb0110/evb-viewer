import type { TDocumentRef } from '@contracts/documentRef';
import type {
    IPdfDocument,
    IPdfPage,
} from '@app/modules/pdf-viewer/public';
import {
    assertDocumentPageNumber,
    type IDocumentPageMetrics,
    type IDocumentPageRenderRequest,
    type IDocumentPageSource,
    type IDocumentRenderLease,
} from '@app/modules/document-viewer/source/documentPageSource';

interface ICreatePdfPageSourceOptions {
    documentRef: TDocumentRef;
    pdfDocument: IPdfDocument;
    /** Reuses the document session's bounded page-proxy owner for background metrics. */
    getPage?: (pageNumber: number) => Promise<IPdfPage>;
    /** Metrics the viewer already holds, when it has them for the page. */
    getPageMetrics?: (pageNumber: number) => Promise<IDocumentPageMetrics | undefined>;
    /**
     * The viewer's raster scheduler, which owns page leases, the surface
     * budget, cancellation, view rotation and annotation suppression. The
     * generic chassis never rasterizes a PDF itself; a page it asks for comes
     * from the same scheduled render as a thumbnail.
     */
    renderThumbnail: (request: IDocumentPageRenderRequest) => Promise<IDocumentRenderLease>;
}

export function createPdfPageSource(options: ICreatePdfPageSourceOptions): IDocumentPageSource {
    function renderPage(request: IDocumentPageRenderRequest) {
        assertDocumentPageNumber(request.pageNumber, options.pdfDocument.numPages);
        request.signal.throwIfAborted();
        return options.renderThumbnail(request);
    }

    return {
        kind: 'pdf',
        documentRef: options.documentRef,
        pageCount: options.pdfDocument.numPages,
        async getPageMetrics(pageNumber, signal) {
            assertDocumentPageNumber(pageNumber, options.pdfDocument.numPages);
            signal?.throwIfAborted();
            const known = await options.getPageMetrics?.(pageNumber);
            if (known) {
                return known;
            }
            const page = await (options.getPage?.(pageNumber) ?? options.pdfDocument.getPage(pageNumber));
            signal?.throwIfAborted();
            const viewport = page.getViewport({ scale: 1 });
            const rotation = ((viewport.rotation % 360) + 360) % 360;
            return {
                widthPoints: viewport.width,
                heightPoints: viewport.height,
                rotation: rotation as 0 | 90 | 180 | 270,
            };
        },
        renderPage,
        thumbnailProvider: {renderThumbnail: renderPage},
        dispose() {},
    };
}
