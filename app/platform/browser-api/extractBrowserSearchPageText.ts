import type {IPdfPage} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import { yieldToBrowser } from '@app/platform/browser-api/browserYield';
import { buildOcrTextLayerIndexText } from '@contracts/ocrText';
import type { IOcrWord } from '@contracts/shared';
import { assembleSearchablePageText } from '@contracts/search';
import {
    extractPdfjsWordBoxesFromOperatorList,
    getPdfjsPageViewBox,
    type TPdfjsTextOps,
} from '@pdf-core/pdfjsTextGeometry';

interface IBrowserSearchTextPageLike {
    getTextContent: IPdfPage['getTextContent'];
    cleanup?: IPdfPage['cleanup'];
}

interface IBrowserSearchGeometryPageLike extends IBrowserSearchTextPageLike {
    getOperatorList?: IPdfPage['getOperatorList'];
    view?: unknown;
}

interface IExtractBrowserSearchPageTextOptions {shouldContinue?: () => Promise<boolean> | boolean;}

/*
 * BGX-2: PDF.js does not expose cancellable handles for browser search
 * getOperatorList()/getTextContent() extraction, so cancellation can overshoot
 * by at most the currently awaited page extraction step.
 */
export interface IBrowserSearchPageData {
    text: string;
    words?: IOcrWord[];
    pageWidth?: number;
    pageHeight?: number;
}

async function throwIfBrowserSearchCanceled(shouldContinue?: IExtractBrowserSearchPageTextOptions['shouldContinue']) {
    if (await shouldContinue?.() === false) {
        throw new Error('ERR_BROWSER_SEARCH_CANCELED');
    }
}

async function extractTextContentPageText(
    page: IBrowserSearchTextPageLike,
    options: IExtractBrowserSearchPageTextOptions = {},
) {
    const content = await page.getTextContent({
        includeMarkedContent: true,
        disableNormalization: true,
    });
    await throwIfBrowserSearchCanceled(options.shouldContinue);
    const textItems: Array<{
        text: string;
        separatorAfter: 'line' | 'none'
    }> = [];

    for (let index = 0; index < content.items.length; index += 128) {
        const chunk = content.items.slice(index, index + 128);
        for (const item of chunk) {
            if ('str' in item) {
                textItems.push({
                    text: String(item.str ?? ''),
                    separatorAfter: item.hasEOL ? 'line' : 'none',
                });
            }
        }

        if (index + 128 < content.items.length) {
            await yieldToBrowser();
            await throwIfBrowserSearchCanceled(options.shouldContinue);
        }
    }

    return assembleSearchablePageText(textItems).text;
}

async function cleanupBrowserSearchPage(page: IBrowserSearchTextPageLike) {
    try {
        await Promise.resolve(page.cleanup?.());
    } catch {
        // Page cleanup is a best-effort memory hint.
    }
}

export async function extractBrowserSearchPageText(
    page: IBrowserSearchTextPageLike,
    options: IExtractBrowserSearchPageTextOptions = {},
) {
    try {
        return await extractTextContentPageText(page, options);
    } finally {
        await cleanupBrowserSearchPage(page);
    }
}

function hasUsableGeometry(page: IBrowserSearchPageData) {
    return Array.isArray(page.words)
        && page.words.length > 0
        && typeof page.pageWidth === 'number'
        && Number.isFinite(page.pageWidth)
        && page.pageWidth > 0
        && typeof page.pageHeight === 'number'
        && Number.isFinite(page.pageHeight)
        && page.pageHeight > 0;
}

export async function extractBrowserSearchPageData(
    page: IBrowserSearchGeometryPageLike,
    pdfjsOps: TPdfjsTextOps,
    options: IExtractBrowserSearchPageTextOptions = {},
): Promise<IBrowserSearchPageData> {
    try {
        if (typeof page.getOperatorList === 'function') {
            const pageBox = getPdfjsPageViewBox(page);
            const operatorList = await page.getOperatorList();
            await throwIfBrowserSearchCanceled(options.shouldContinue);
            const words = extractPdfjsWordBoxesFromOperatorList(operatorList, pageBox, pdfjsOps);
            const pageData: IBrowserSearchPageData = {
                text: buildOcrTextLayerIndexText(words),
                words,
                pageWidth: pageBox.pageWidth,
                pageHeight: pageBox.pageHeight,
            };
            if (hasUsableGeometry(pageData)) {
                return pageData;
            }
        }

        await throwIfBrowserSearchCanceled(options.shouldContinue);
        return {text: await extractTextContentPageText(page, options)};
    } finally {
        await cleanupBrowserSearchPage(page);
    }
}
