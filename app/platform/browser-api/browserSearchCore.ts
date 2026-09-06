import type {IPdfPage} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import {
    createPdfjsDocumentInitFromBrowserDocument,
    getPdfjsLib,
} from '@app/platform/browser-api/browserPdfjsDocumentInit';
import type { TPdfjsTextOps } from '@pdf-core/pdfjsTextGeometry';
import { yieldToBrowser } from '@app/platform/browser-api/browserYield';
import { extractBrowserSearchPageData } from '@app/platform/browser-api/extractBrowserSearchPageText';
import type { IBrowserSearchPageData } from '@app/platform/browser-api/extractBrowserSearchPageText';
import { BROWSER_SEARCH_LEGACY_ARRAY_PAGE_LIMIT } from '@app/platform/browser-api/browserSearchLegacyArrayPageLimit';
import {validateBrowserSearchPageCount} from '@app/platform/browser-api/browserSearchLimits';

interface ILoadedBrowserSearchDocument {
    pdfDocument: {
        numPages: number;
        getPage: (pageNumber: number) => Promise<IPdfPage>;
        destroy: () => Promise<void>;
    };
    pdfjsOps: TPdfjsTextOps;
    pageCount: number;
    destroy: () => Promise<void>;
}

interface IExtractBrowserSearchDocumentTextOptions {
    onPageExtracted?: (pageNumber: number, pageCount: number) => Promise<void> | void;
    shouldContinue?: () => Promise<boolean> | boolean;
}

interface IExtractedBrowserSearchDocumentText {
    pageCount: number;
    pageTexts: string[];
}

export interface IExtractedBrowserSearchPage extends IBrowserSearchPageData {pageNumber: number;}

export interface IBrowserSearchDocumentPageRecord extends IExtractedBrowserSearchPage {pageCount: number;}

async function throwIfBrowserSearchCanceled(shouldContinue?: IExtractBrowserSearchDocumentTextOptions['shouldContinue']) {
    if (await shouldContinue?.() === false) {
        throw new Error('ERR_BROWSER_SEARCH_CANCELED');
    }
}

async function loadBrowserSearchDocument(
    pdfPath: string,
): Promise<ILoadedBrowserSearchDocument> {
    const pdfjsLib = await getPdfjsLib();
    let rejectRangeReadFailure: ((error: Error) => void) | null = null;
    const rangeReadFailure = new Promise<never>((_resolve, reject) => {
        rejectRangeReadFailure = reject;
    });
    const loadingTask = pdfjsLib.getDocument(await createPdfjsDocumentInitFromBrowserDocument(pdfjsLib, pdfPath, {onRangeReadFailure: (error) => {
        const reject = rejectRangeReadFailure;
        rejectRangeReadFailure = null;
        reject?.(error);
    }}));
    let pdfDocument: Awaited<typeof loadingTask.promise>;
    try {
        pdfDocument = await Promise.race([
            loadingTask.promise,
            rangeReadFailure,
        ]);
    } catch (error) {
        await loadingTask.destroy();
        throw error;
    } finally {
        rejectRangeReadFailure = null;
    }

    return {
        pdfDocument,
        pdfjsOps: pdfjsLib.OPS,
        pageCount: pdfDocument.numPages,
        destroy: async () => {
            await pdfDocument.destroy();
        },
    };
}

async function extractBrowserSearchDocumentPage(
    document: ILoadedBrowserSearchDocument,
    pageNumber: number,
    options: Pick<IExtractBrowserSearchDocumentTextOptions, 'shouldContinue'> = {},
): Promise<IExtractedBrowserSearchPage> {
    await throwIfBrowserSearchCanceled(options.shouldContinue);
    const page = await document.pdfDocument.getPage(pageNumber);
    await throwIfBrowserSearchCanceled(options.shouldContinue);
    const pageData = await extractBrowserSearchPageData(
        page,
        document.pdfjsOps,
        options.shouldContinue ? {shouldContinue: options.shouldContinue} : {},
    );
    await throwIfBrowserSearchCanceled(options.shouldContinue);
    return {
        pageNumber,
        ...pageData,
    };
}

export async function extractBrowserSearchDocumentText(
    pdfPath: string,
    options: IExtractBrowserSearchDocumentTextOptions = {},
): Promise<IExtractedBrowserSearchDocumentText> {
    const document = await loadBrowserSearchDocument(pdfPath);
    try {
        validateBrowserSearchPageCount(document.pageCount);
        await throwIfBrowserSearchCanceled(options.shouldContinue);
        if (document.pageCount > BROWSER_SEARCH_LEGACY_ARRAY_PAGE_LIMIT) {
            throw new Error('ERR_BROWSER_SEARCH_STREAM_REQUIRED');
        }

        const pageTexts = new Array<string>(document.pageCount);
        for (let pageNumber = 1; pageNumber <= document.pageCount; pageNumber += 1) {
            const page = await extractBrowserSearchDocumentPage(document, pageNumber, options);
            pageTexts[page.pageNumber - 1] = page.text;
            await options.onPageExtracted?.(page.pageNumber, document.pageCount);
            await yieldToBrowser();
            await throwIfBrowserSearchCanceled(options.shouldContinue);
        }

        return {
            pageCount: document.pageCount,
            pageTexts,
        };
    } finally {
        await document.destroy();
    }
}

/**
 * Extracts one page record per iterator step. The next PDF page is not read
 * until the caller asks for the next record, which gives large searches
 * bounded memory and natural backpressure.
 */
export async function* streamBrowserSearchDocumentPages(
    pdfPath: string,
    options: Pick<IExtractBrowserSearchDocumentTextOptions, 'shouldContinue'> = {},
): AsyncGenerator<IBrowserSearchDocumentPageRecord, void, void> {
    const document = await loadBrowserSearchDocument(pdfPath);
    try {
        validateBrowserSearchPageCount(document.pageCount);
        for (let pageNumber = 1; pageNumber <= document.pageCount; pageNumber += 1) {
            const page = await extractBrowserSearchDocumentPage(document, pageNumber, options);
            yield {
                ...page,
                pageCount: document.pageCount,
            };
            await yieldToBrowser();
            await throwIfBrowserSearchCanceled(options.shouldContinue);
        }

        return;
    } finally {
        await document.destroy();
    }
}

export async function iterateBrowserSearchDocumentPages(
    pdfPath: string,
    onPage: (page: IExtractedBrowserSearchPage, pageCount: number) => Promise<void> | void,
    options: Pick<IExtractBrowserSearchDocumentTextOptions, 'shouldContinue'> = {},
) {
    let pageCount = 0;
    for await (const page of streamBrowserSearchDocumentPages(pdfPath, options)) {
        const {
            pageCount: totalPages,
            ...pageData
        } = page;
        pageCount = totalPages;
        await onPage(pageData, totalPages);
    }
    return pageCount;
}
