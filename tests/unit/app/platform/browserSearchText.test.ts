import type {
    IPdfTextContent,
    IPdfTextItem,
} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    extractBrowserSearchPageData,
    extractBrowserSearchPageText,
} from '@app/platform/browser-api/extractBrowserSearchPageText';

const mocks = vi.hoisted(() => ({
    extractPdfjsWordBoxesFromOperatorList: vi.fn(),
    getPdfjsPageViewBox: vi.fn(),
}));

vi.mock('@pdf-core', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...(actual as object),
        extractPdfjsWordBoxesFromOperatorList: mocks.extractPdfjsWordBoxesFromOperatorList,
        getPdfjsPageViewBox: mocks.getPdfjsPageViewBox,
    };
});

describe('extractBrowserSearchPageText', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.extractPdfjsWordBoxesFromOperatorList.mockReturnValue([]);
        mocks.getPdfjsPageViewBox.mockReturnValue({
            pageHeight: 200,
            pageWidth: 100,
        });
    });

    it('keeps PDF.js text item offsets compatible with rendered text layers', async () => {
        const makeTextItem = (str: string, hasEOL: boolean): IPdfTextItem => ({
            str,
            hasEOL,
            dir: 'ltr',
            transform: [],
            width: 0,
            height: 0,
            fontName: 'f1',
        });
        const textContent: IPdfTextContent = {
            items: [
                makeTextItem('alpha', true),
                makeTextItem('beta  gamma', false),
            ],
            styles: {},
            lang: null,
        };
        const cleanup = vi.fn(() => true);
        const page = {
            getTextContent: vi.fn(async () => textContent),
            cleanup,
        };

        await expect(extractBrowserSearchPageText(page)).resolves.toBe('alpha\nbeta  gamma');
        expect(page.getTextContent).toHaveBeenCalledWith({
            includeMarkedContent: true,
            disableNormalization: true,
        });
        expect(cleanup).toHaveBeenCalledOnce();
    });

    it('uses canonical joining and hyphenation while preserving source Unicode offsets', async () => {
        const makeTextItem = (str: string, hasEOL = false): IPdfTextItem => ({
            str,
            hasEOL,
            dir: 'ltr',
            transform: [],
            width: 0,
            height: 0,
            fontName: 'f1',
        });
        const page = {getTextContent: vi.fn(async (): Promise<IPdfTextContent> => ({
            items: [
                makeTextItem('Cafe\u0301'),
                makeTextItem('ex-', true),
                makeTextItem('\uFB01le'),
            ],
            styles: {},
            lang: null,
        }))};

        await expect(extractBrowserSearchPageText(page)).resolves.toBe('Cafe\u0301 ex\uFB01le');
    });

    it('collapses exact repeated hidden text streams before browser search indexes the page', async () => {
        const repeatedText = 'СЛОВАРЬ\nАРАБСКОЙ ХРЕСТОМАТИИ И КОРАНУ. СОСТАВИЛЪ ПРОФ. В. ГИРГАСЪ.\n';
        const makeTextItem = (str: string): IPdfTextItem => ({
            str,
            hasEOL: false,
            dir: 'ltr',
            transform: [],
            width: 0,
            height: 0,
            fontName: 'f1',
        });
        const textContent: IPdfTextContent = {
            items: [
                makeTextItem(repeatedText),
                makeTextItem(repeatedText),
                makeTextItem(repeatedText),
            ],
            styles: {},
            lang: null,
        };
        const page = { getTextContent: vi.fn(async () => textContent) };

        await expect(extractBrowserSearchPageText(page)).resolves.toBe(repeatedText);
    });

    it('does not start text-content fallback when cancellation arrives after operator-list extraction', async () => {
        const page = {
            cleanup: vi.fn(),
            getOperatorList: vi.fn(async () => ({
                argsArray: [],
                fnArray: [],
            })),
            getTextContent: vi.fn(async () => ({
                items: [],
                styles: {},
                lang: null,
            })),
        };
        const shouldContinue = vi.fn(() => false);

        await expect(extractBrowserSearchPageData(page, {}, {shouldContinue}))
            .rejects
            .toThrow('ERR_BROWSER_SEARCH_CANCELED');

        expect(page.getOperatorList).toHaveBeenCalledOnce();
        expect(page.getTextContent).not.toHaveBeenCalled();
        expect(page.cleanup).toHaveBeenCalledOnce();
    });

    it('rejects direct text extraction when cancellation arrives after getTextContent resolves', async () => {
        const page = {
            cleanup: vi.fn(),
            getTextContent: vi.fn(async () => ({
                items: [],
                styles: {},
                lang: null,
            })),
        };
        const shouldContinue = vi.fn(() => false);

        await expect(extractBrowserSearchPageText(page, {shouldContinue}))
            .rejects
            .toThrow('ERR_BROWSER_SEARCH_CANCELED');

        expect(page.getTextContent).toHaveBeenCalledOnce();
        expect(page.cleanup).toHaveBeenCalledOnce();
    });
});
