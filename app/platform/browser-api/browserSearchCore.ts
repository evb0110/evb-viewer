import type {IPdfDocument} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import pdfjsLib from '@app/services/pdfjs/runtimeLib';
import {loadBrowserPdfjsDocument} from '@app/platform/browser-api/loadBrowserPdfjsDocument';
import { yieldToBrowser } from '@app/platform/browser-api/browserYield';
import { extractBrowserSearchPageData } from '@app/platform/browser-api/extractBrowserSearchPageText';
import type { IBrowserSearchPageData } from '@app/platform/browser-api/extractBrowserSearchPageText';
import {validateBrowserSearchPageCount} from '@app/platform/browser-api/browserSearchLimits';

interface IExtractBrowserSearchDocumentTextOptions {shouldContinue?: () => Promise<boolean> | boolean;}

export interface IExtractedBrowserSearchPage extends IBrowserSearchPageData {pageNumber: number;}

export interface IBrowserSearchDocumentPageRecord extends IExtractedBrowserSearchPage {pageCount: number;}

async function throwIfBrowserSearchCanceled(shouldContinue?: IExtractBrowserSearchDocumentTextOptions['shouldContinue']) {
    if (await shouldContinue?.() === false) {
        throw new Error('ERR_BROWSER_SEARCH_CANCELED');
    }
}

export async function loadBrowserSearchDocument(pdfPath: string) {
    const pdfDocument = await loadBrowserPdfjsDocument(pdfPath);
    try {
        validateBrowserSearchPageCount(pdfDocument.numPages);
    } catch (error) {
        await pdfDocument.loadingTask.destroy();
        throw error;
    }
    return {
        pageCount: pdfDocument.numPages,
        extractPage: (pageNumber: number, options: IExtractBrowserSearchDocumentTextOptions = {}) =>
            extractBrowserSearchDocumentPage(pdfDocument, pageNumber, options),
        destroy: () => pdfDocument.loadingTask.destroy(),
    };
}

async function extractBrowserSearchDocumentPage(
    pdfDocument: IPdfDocument,
    pageNumber: number,
    options: IExtractBrowserSearchDocumentTextOptions = {},
): Promise<IExtractedBrowserSearchPage> {
    await throwIfBrowserSearchCanceled(options.shouldContinue);
    const page = await pdfDocument.getPage(pageNumber);
    await throwIfBrowserSearchCanceled(options.shouldContinue);
    const pageData = await extractBrowserSearchPageData(
        page,
        pdfjsLib.OPS,
        options.shouldContinue ? {shouldContinue: options.shouldContinue} : {},
    );
    await throwIfBrowserSearchCanceled(options.shouldContinue);
    return {
        pageNumber,
        ...pageData,
    };
}

/**
 * Extracts one page record per iterator step. The next PDF page is not read
 * until the caller asks for the next record, which gives large searches
 * bounded memory and natural backpressure.
 */
export async function* streamBrowserSearchDocumentPages(
    pdfPath: string,
    options: IExtractBrowserSearchDocumentTextOptions = {},
): AsyncGenerator<IBrowserSearchDocumentPageRecord, void, void> {
    const document = await loadBrowserSearchDocument(pdfPath);
    try {
        for (let pageNumber = 1; pageNumber <= document.pageCount; pageNumber += 1) {
            const page = await document.extractPage(pageNumber, options);
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
    options: IExtractBrowserSearchDocumentTextOptions = {},
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
