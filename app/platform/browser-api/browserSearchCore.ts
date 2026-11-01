import type {IPdfDocument} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import pdfjsLib from '@app/services/pdfjs/runtimeLib';
import {loadBrowserPdfjsDocument} from '@app/platform/browser-api/loadBrowserPdfjsDocument';
import { yieldToBrowser } from '@app/platform/browser-api/browserYield';
import {
    extractBrowserSearchPageData,
    hasRightToLeftSearchText,
} from '@app/platform/browser-api/extractBrowserSearchPageText';
import type { IBrowserSearchPageData } from '@app/platform/browser-api/extractBrowserSearchPageText';
import { readEvbLayerLines } from '@app/platform/browser-api/browserOcrTextCatalog';

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
    // PDF.js gives right-to-left OCR words one glyph per item, so search reads
    // those pages' EVB OCR lines, as desktop and the text catalog do. They are
    // read once, and only for a document that has such a page.
    let evbLayers: ReturnType<typeof readEvbLayerLines> | undefined;
    const readEvbLayerText = async (pageNumber: number) => {
        // A layer that cannot be read leaves search on the PDF.js text.
        evbLayers ??= readEvbLayerLines(pdfPath, Array.from({length: pdfDocument.numPages}, (_, index) => index + 1))
            .catch(() => new Map());
        return (await evbLayers).get(pageNumber)?.text;
    };
    return {
        pageCount: pdfDocument.numPages,
        extractPage: (pageNumber: number, options: IExtractBrowserSearchDocumentTextOptions = {}) =>
            extractBrowserSearchDocumentPage(pdfDocument, pageNumber, readEvbLayerText, options),
        destroy: () => pdfDocument.loadingTask.destroy(),
    };
}

async function extractBrowserSearchDocumentPage(
    pdfDocument: IPdfDocument,
    pageNumber: number,
    readEvbLayerText: (pageNumber: number) => Promise<string | undefined>,
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
    const evbText = hasRightToLeftSearchText(pageData.text)
        ? await readEvbLayerText(pageNumber)
        : undefined;
    return {
        pageNumber,
        ...pageData,
        ...(evbText === undefined ? {} : {text: evbText}),
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
