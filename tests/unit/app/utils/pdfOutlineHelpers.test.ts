import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import {
    convertOutlineColorToHex,
    normalizeBookmarkColor,
    resolveBookmarkDestinationPage,
    resolvePageIndex,
} from '@app/utils/pdf-outline-helpers';

type TOutlinePdfDocumentStub = Pick<PDFDocumentProxy, 'numPages' | 'getDestination' | 'getPageIndex'>;

function createPdfDocumentStub(overrides: Partial<TOutlinePdfDocumentStub> = {}): PDFDocumentProxy {
    const base: TOutlinePdfDocumentStub = {
        numPages: 10,
        getDestination: vi.fn(async (_name: string) => null),
        getPageIndex: vi.fn(async (_ref: unknown) => 0),
    };
    return {
        ...base,
        ...overrides,
    } as PDFDocumentProxy;
}

describe('pdf-outline-helpers', () => {
    it('converts outline color arrays to hex', () => {
        expect(convertOutlineColorToHex([
            255,
            128.2,
            0,
        ])).toBe('#ff8000');
        expect(convertOutlineColorToHex(null)).toBeNull();
        expect(convertOutlineColorToHex([
            1,
            2,
        ])).toBeNull();
    });

    it('normalizes bookmark color values', () => {
        expect(normalizeBookmarkColor('#abc')).toBe('#aabbcc');
        expect(normalizeBookmarkColor('  #A1b2C3  ')).toBe('#a1b2c3');
        expect(normalizeBookmarkColor('blue')).toBeNull();
    });

    it('resolves named destination and caches destination + ref index', async () => {
        const getDestination = vi.fn(async (_name: string) => [{
            num: 4,
            gen: 0, 
        }]);
        const getPageIndex = vi.fn(async (_ref: unknown) => 3);
        const pdfDoc = createPdfDocumentStub({
            getDestination,
            getPageIndex,
        });

        const destinationCache = new Map<string, unknown[] | null>();
        const refIndexCache = new Map<string, number | null>();

        const first = await resolvePageIndex(pdfDoc, 'chapter-1', destinationCache, refIndexCache);
        const second = await resolvePageIndex(pdfDoc, 'chapter-1', destinationCache, refIndexCache);

        expect(first).toBe(3);
        expect(second).toBe(3);
        expect(getDestination).toHaveBeenCalledTimes(1);
        expect(getPageIndex).toHaveBeenCalledTimes(1);
    });

    it('handles numeric destinations in both 0-based and 1-based forms', async () => {
        const pdfDoc = createPdfDocumentStub({ numPages: 5 });
        const destinationCache = new Map<string, unknown[] | null>();
        const refIndexCache = new Map<string, number | null>();

        await expect(resolvePageIndex(pdfDoc, [2], destinationCache, refIndexCache)).resolves.toBe(2);
        await expect(resolvePageIndex(pdfDoc, [5], destinationCache, refIndexCache)).resolves.toBe(4);
        await expect(resolvePageIndex(pdfDoc, [99], destinationCache, refIndexCache)).resolves.toBeNull();
    });

    it('returns null when destination lookup fails', async () => {
        const pdfDoc = createPdfDocumentStub({getDestination: vi.fn(async () => {
            throw new Error('lookup failed');
        })});
        const destinationCache = new Map<string, unknown[] | null>();
        const refIndexCache = new Map<string, number | null>();

        await expect(resolvePageIndex(pdfDoc, 'missing', destinationCache, refIndexCache)).resolves.toBeNull();
        expect(destinationCache.get('missing')).toBeNull();
    });

    it('resolves bookmark destination page as 1-based number', async () => {
        const pdfDoc = createPdfDocumentStub({
            numPages: 6,
            getDestination: vi.fn(async () => [3]),
        });

        await expect(resolveBookmarkDestinationPage(pdfDoc, 'toc')).resolves.toBe(4);
        await expect(resolveBookmarkDestinationPage(pdfDoc, [6])).resolves.toBe(6);
    });
});
