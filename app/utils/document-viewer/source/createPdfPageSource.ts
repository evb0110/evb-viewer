import type { TDocumentRef } from '@contracts/documentRef';
import type {
    IPdfDocument,
    IPdfPage,
} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import {
    assertDocumentPageNumber,
    type IDocumentPageRenderRequest,
    type IDocumentPageSource,
    type IDocumentSurfaceLease,
} from '@app/utils/document-viewer/source/documentPageSource';

interface ICreatePdfPageSourceOptions {
    documentRef: TDocumentRef;
    pdfDocument: IPdfDocument;
    /** Reuses the document session's bounded page-proxy owner for background metrics. */
    getPage?: (pageNumber: number) => Promise<IPdfPage>;
    /** Delegates to the existing coordinated PDF.js path; the generic chassis never rasterizes PDF itself. */
    renderPage: (request: IDocumentPageRenderRequest) => Promise<IDocumentSurfaceLease>;
}

export function createPdfPageSource(options: ICreatePdfPageSourceOptions): IDocumentPageSource {
    function renderPage(request: IDocumentPageRenderRequest) {
        assertDocumentPageNumber(request.pageNumber, options.pdfDocument.numPages);
        request.signal.throwIfAborted();
        return options.renderPage(request);
    }

    return {
        kind: 'pdf',
        documentRef: options.documentRef,
        pageCount: options.pdfDocument.numPages,
        async getPageMetrics(pageNumber, signal) {
            assertDocumentPageNumber(pageNumber, options.pdfDocument.numPages);
            signal?.throwIfAborted();
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
