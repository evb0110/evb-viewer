import type {IPdfPage} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import { yieldToBrowser } from '@app/platform/browser-api/browserYield';
import {
    buildOcrTextLayerIndexText, assembleSearchablePageTextItems,
} from '@pdf-core';
import type { IOcrWord } from '@contracts/shared';
import {hasRightToLeftSearchText} from '@pdf-core/pdfSearchAlgorithms';
import {
    extractPdfjsWordBoxesFromOperatorList,
    getPdfjsPageViewBox,
    type IPdfjsPageViewBox,
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
    /** The CropBox hid some of the page's text, as desktop search leaves out. */
    croppedText?: true;
}

async function throwIfBrowserSearchCanceled(shouldContinue?: IExtractBrowserSearchPageTextOptions['shouldContinue']) {
    if (await shouldContinue?.() === false) {
        throw new Error('ERR_BROWSER_SEARCH_CANCELED');
    }
}

async function extractTextContentPageText(
    page: IBrowserSearchTextPageLike,
    options: IExtractBrowserSearchPageTextOptions = {},
    visibleBox?: IPdfjsPageViewBox,
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
    let hiddenItems = 0;

    for (let index = 0; index < content.items.length; index += 128) {
        const chunk = content.items.slice(index, index + 128);
        for (const item of chunk) {
            if ('str' in item) {
                // Text outside the CropBox is not on the page a reader sees.
                const origin = Array.isArray(item.transform) ? item.transform : null;
                if (visibleBox && origin && !isInsideBox(visibleBox, origin[4], origin[5])) {
                    hiddenItems += 1;
                    continue;
                }
                textItems.push({
                    text: String(item.str),
                    separatorAfter: item.hasEOL ? 'line' : 'none',
                });
            }
        }

        if (index + 128 < content.items.length) {
            await yieldToBrowser();
            await throwIfBrowserSearchCanceled(options.shouldContinue);
        }
    }

    return {
        text: assembleSearchablePageTextItems(textItems).text,
        hiddenItems,
    };
}

function isInsideBox(box: IPdfjsPageViewBox, x: unknown, y: unknown) {
    return typeof x === 'number' && typeof y === 'number'
        && x >= box.xMin && x <= box.xMax && y >= box.yMin && y <= box.yMax;
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
        return (await extractTextContentPageText(page, options)).text;
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
            const allWords = extractPdfjsWordBoxesFromOperatorList(operatorList, pageBox, pdfjsOps);
            // Word boxes are in CropBox space; a word centred outside it is cropped away.
            const words = allWords.filter(word => isInsideBox({
                ...pageBox,
                xMin: 0,
                yMin: 0,
                xMax: pageBox.pageWidth,
                yMax: pageBox.pageHeight,
            }, word.x + word.width / 2, word.y + word.height / 2));
            const pageData: IBrowserSearchPageData = {
                text: buildOcrTextLayerIndexText(words),
                words,
                pageWidth: pageBox.pageWidth,
                pageHeight: pageBox.pageHeight,
                ...(words.length < allWords.length ? {croppedText: true as const} : {}),
            };
            // Operator-list glyphs are in paint order. For bidi text, use the
            // same PDF.js logical items as the rendered text layer and let its
            // existing range mapping supply geometry, including mixed runs.
            if (hasUsableGeometry(pageData) && !hasRightToLeftSearchText(pageData.text)) {
                return pageData;
            }
        }

        await throwIfBrowserSearchCanceled(options.shouldContinue);
        const {
            text, hiddenItems,
        } = await extractTextContentPageText(page, options, getPdfjsPageViewBox(page));
        return {
            text,
            ...(hiddenItems > 0 ? {croppedText: true as const} : {}),
        };
    } finally {
        await cleanupBrowserSearchPage(page);
    }
}
