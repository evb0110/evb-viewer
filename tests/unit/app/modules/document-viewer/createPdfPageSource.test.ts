import type {IPdfDocument} from '@app/modules/pdf-viewer/public';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {createPdfPageSource} from '@app/modules/document-viewer/source/createPdfPageSource';
import {requireDocumentRef} from '@contracts/documentRef';

describe('createPdfPageSource', () => {
    // The generic chassis never rasterizes a PDF itself: a page and a
    // thumbnail both come from the viewer's scheduled render.
    it('serves pages and thumbnails from the viewer\'s scheduled render', async () => {
        const lease = {
            widthPx: 180,
            heightPx: 252,
            bytes: 181_440,
            surface: 'data:image/png;base64,',
            release: vi.fn(),
        };
        const renderThumbnail = vi.fn(async () => lease);
        const pdfDocument: IPdfDocument = Object.assign(Object.create(null), {
            numPages: 3,
            getPage: vi.fn(),
        });
        const source = createPdfPageSource({
            documentRef: requireDocumentRef('/document.pdf'),
            pdfDocument,
            renderThumbnail,
        });
        const request = {
            pageNumber: 2,
            widthPx: 180,
            priority: 'thumbnail' as const,
            signal: new AbortController().signal,
        };

        await expect(source.thumbnailProvider!.renderThumbnail(request)).resolves.toBe(lease);
        await expect(source.renderPage({
            ...request,
            priority: 'navigation',
        })).resolves.toBe(lease);
        expect(() => source.renderPage({
            ...request,
            pageNumber: 4,
        })).toThrow();
    });
});
