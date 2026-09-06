import type {IPdfDocument} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {createPdfPageSource} from '@app/utils/document-viewer/source/createPdfPageSource';

describe('createPdfPageSource', () => {
    it('uses the coordinated PDF renderer as its thumbnail provider', async () => {
        const lease = {
            widthPx: 180,
            heightPx: 252,
            bytes: 181_440,
            surface: 'data:image/png;base64,',
            release: vi.fn(),
        };
        const renderPage = vi.fn(async () => lease);
        const pdfDocument: IPdfDocument = Object.assign(Object.create(null), {
            numPages: 3,
            getPage: vi.fn(),
        });
        const source = createPdfPageSource({
            documentRef: '/document.pdf',
            pdfDocument,
            renderPage,
        });
        const request = {
            pageNumber: 2,
            widthPx: 180,
            priority: 'thumbnail' as const,
            signal: new AbortController().signal,
        };

        await expect(source.thumbnailProvider!.renderThumbnail(request)).resolves.toBe(lease);
        expect(renderPage).toHaveBeenCalledWith(request);
    });
});
