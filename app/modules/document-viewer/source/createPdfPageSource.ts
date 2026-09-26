import type { TDocumentRef } from '@contracts/documentRef';
import type {
    IPdfDocument,
    IPdfPage,
    // eslint-disable-next-line import-classic/no-restricted-paths -- Share the PDF structural contract as types only.
} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
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
    /** Delegates to the existing coordinated PDF.js path; the generic chassis never rasterizes PDF itself. */
    renderPage: (request: IDocumentPageRenderRequest) => Promise<IDocumentRenderLease>;
    /** Metrics the viewer already holds, when it has them for the page. */
    getPageMetrics?: (pageNumber: number) => Promise<IDocumentPageMetrics | undefined>;
    renderThumbnail?: (request: IDocumentPageRenderRequest) => Promise<IDocumentRenderLease>;
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
        thumbnailProvider: {renderThumbnail: options.renderThumbnail ?? renderPage},
        dispose() {},
    };
}
