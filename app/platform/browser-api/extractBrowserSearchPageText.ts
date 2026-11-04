import type {IPdfPage} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import { yieldToBrowser } from '@app/platform/browser-api/browserYield';
import {
    buildOcrTextLayerIndexText, assembleSearchablePageTextItems,
} from '@pdf-core';
import type { IOcrWord } from '@contracts/shared';
import {
    pdfjsTextItemIntersectsBox,
    mergePositionedPdfjsGlyphItems,
    type IPdfjsTextItem,
} from '@pdf-core/pdfjsTextItems';
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
    const textItems: IPdfjsTextItem[] = [];
    let hiddenItems = 0;

    for (let index = 0; index < content.items.length; index += 128) {
        const chunk = content.items.slice(index, index + 128);
        for (const item of chunk) {
            if ('str' in item) {
                if (visibleBox && !pdfjsTextItemIntersectsBox(visibleBox, item, content.styles[item.fontName ?? ''])) {
                    hiddenItems += 1;
                    if (item.hasEOL && textItems.length > 0) {
                        textItems[textItems.length - 1]!.separatorAfter = 'line';
                    }
                    continue;
                }
                textItems.push({
                    ...item,
                    text: item.str,
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
        text: assembleSearchablePageTextItems(mergePositionedPdfjsGlyphItems(textItems)).text,
        hiddenItems,
        hasVerticalText: textItems.some(item => item.dir === 'ttb'),
    };
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

export async function extractBrowserSearchPageData(
    page: IBrowserSearchTextPageLike,
    pdfjsOps: TPdfjsTextOps,
    options: IExtractBrowserSearchPageTextOptions = {},
): Promise<IBrowserSearchPageData> {
    try {
        const pageBox = getPdfjsPageViewBox(page);
        const {
            pageWidth, pageHeight,
        } = pageBox;
        let pageData: IBrowserSearchPageData | undefined;
        if (typeof page.getOperatorList === 'function') {
            const operatorList = await page.getOperatorList();
            await throwIfBrowserSearchCanceled(options.shouldContinue);
            const allWords = extractPdfjsWordBoxesFromOperatorList(operatorList, pageBox, pdfjsOps);
            // Word boxes are in CropBox space; a word centred outside it is cropped away.
            const words = allWords.filter(word => {
                const x = word.x + word.width / 2;
                const y = word.y + word.height / 2;
                return x >= 0 && x <= pageWidth && y >= 0 && y <= pageHeight;
            });
            pageData = {
                text: buildOcrTextLayerIndexText(words),
                words,
                pageWidth,
                pageHeight,
                ...(words.length < allWords.length ? {croppedText: true as const} : {}),
            };
        }

        await throwIfBrowserSearchCanceled(options.shouldContinue);
        const {
            text, hiddenItems, hasVerticalText,
        } = await extractTextContentPageText(page, options, pageBox);
        // Boxes are usable only when the operator walker retained the text.
        // Ignore separators the two assemblers generate differently. Vertical
        // writing and bidi runs use the rendered text layer's range geometry.
        if (pageData?.words?.length && !hasVerticalText
            && Number.isFinite(pageWidth) && pageWidth > 0
            && Number.isFinite(pageHeight) && pageHeight > 0
            && !hasRightToLeftSearchText(pageData.text)
            && pageData.text.replace(/\s/gu, '') === text.replace(/\s/gu, '')) {
            return pageData;
        }
        return {
            text,
            ...(pageData?.croppedText || hiddenItems > 0 ? {croppedText: true as const} : {}),
        };
    } finally {
        await cleanupBrowserSearchPage(page);
    }
}
