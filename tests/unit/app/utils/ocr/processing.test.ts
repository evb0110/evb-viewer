import type * as TViMockOriginalModule from '@app/utils/yieldToBrowser';

import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const yieldToBrowserMock = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('@app/utils/yieldToBrowser', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    yieldToBrowser: yieldToBrowserMock,
}));

describe('ocrProcessing', () => {
    it('yields while extracting pdf text page by page', async () => {
        const cleanup = vi.fn(async () => {});
        const getPage = vi.fn(async (pageNumber: number) => ({
            getTextContent: vi.fn(async () => ({items: [{str: `page-${pageNumber}`}]})),
            cleanup,
        }));
        const pdfDocument = {
            numPages: 3,
            getPage,
        };

        const { extractPdfText } = await import('@app/utils/ocr/extractPdfText');
        const text = await extractPdfText(pdfDocument);

        expect(text).toBe('page-1\n\npage-2\n\npage-3');
        expect(getPage).toHaveBeenCalledTimes(3);
        expect(cleanup).toHaveBeenCalledTimes(3);
        expect(yieldToBrowserMock).toHaveBeenCalledTimes(1);
    });
});
