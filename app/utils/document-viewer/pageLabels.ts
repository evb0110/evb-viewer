import type {
    IDocumentPageLabelRange,
    IDocumentPageRange,
    TDocumentPageLabelLookup,
} from '@pdf-core/pdfPageLabels';
import {
    buildPageLabelsFromRanges,
    isImplicitDefaultPageLabels,
} from '@pdf-core/pdfPageLabels';

/**
 * PDF.js exposes page labels as a whole array. Keep that shape only for the
 * small renderer compatibility path. Desktop document state uses ranges for
 * every page count, including documents above this boundary.
 */
export const PAGE_LABEL_SMALL_COMPATIBILITY_MAX_PAGES = 200;
export const PAGE_LABEL_DENSE_READ_MAX_PAGES = 100_000;

export type {
    IDocumentPageLabelModel,
    IDocumentPageLabelRange,
    IDocumentPageLabelSegment,
    IDocumentPageLabelUpdate,
    IDocumentPageLabelWindow,
    IDocumentPageRange,
    TDocumentPageLabelLookup,
    TDocumentPageLabelStyle,
} from '@pdf-core/pdfPageLabels';
export {
    PAGE_LABEL_MAX_WINDOW_PAGES,
    applyPageLabelRange,
    applySparsePageLabelUpdates,
    buildPageLabelSegments,
    buildPageLabelsFromRanges,
    buildWholeDocumentPageLabelRanges,
    countPageLabelDifferences,
    createPageLabelModel,
    derivePageLabelRangesFromLabels,
    findPageByPageLabelInput,
    getPageLabelAt,
    getPageLabelWindow,
    isImplicitDefaultPageLabels,
    normalizePageLabelRanges,
    readPageLabelWindow,
    replacePageLabelRange,
    setPageLabelAt,
} from '@pdf-core/pdfPageLabels';

function isPageLabelArray(
    pageLabels: TDocumentPageLabelLookup,
): pageLabels is readonly string[] {
    return Array.isArray(pageLabels);
}

/** Materialize labels only for the existing small-document compatibility path. */
export function materializePageLabelsForCompatibility(
    totalPages: number,
    ranges: readonly IDocumentPageLabelRange[],
    existingLabels: readonly string[] | null = null,
): string[] | null {
    if (
        totalPages <= 0
        || totalPages > PAGE_LABEL_SMALL_COMPATIBILITY_MAX_PAGES
        || isImplicitDefaultPageLabels(ranges, totalPages)
    ) {
        return null;
    }

    if (existingLabels && existingLabels.length === totalPages) {
        return [...existingLabels];
    }

    return buildPageLabelsFromRanges(totalPages, ranges);
}

function getLabelFromLookup(page: number, pageLabels: TDocumentPageLabelLookup) {
    if (isPageLabelArray(pageLabels)) {
        return pageLabels[page - 1] ?? '';
    }
    if (pageLabels) {
        return pageLabels.labelAt(page) ?? '';
    }
    return '';
}

export function getVisiblePageLabel(page: number, pageLabels: TDocumentPageLabelLookup) {
    const rawLabel = getLabelFromLookup(page, pageLabels);
    const label = rawLabel.trim();
    if (!label) {
        return null;
    }
    return label;
}

export interface IPageIndicatorFormatOptions { compactPhysicalPage?: boolean; }

export function formatPageIndicatorWithOptions(
    page: number,
    pageLabels: TDocumentPageLabelLookup,
    options: IPageIndicatorFormatOptions = {},
) {
    const logical = getVisiblePageLabel(page, pageLabels);
    if (!logical || logical === String(page)) {
        return String(page);
    }

    const physicalPage = options.compactPhysicalPage
        ? `(${page})`
        : ` (${page})`;

    return `${logical}${physicalPage}`;
}

export function getMaxPageIndicatorLength(
    totalPages: number,
    pageLabels: TDocumentPageLabelLookup,
    options: IPageIndicatorFormatOptions = {},
) {
    if (totalPages <= 0) {
        return 0;
    }

    if (!pageLabels || isPageLabelArray(pageLabels) && pageLabels.length !== totalPages) {
        return String(totalPages).length;
    }

    if (!isPageLabelArray(pageLabels)) {
        let maxLength = String(totalPages).length;
        for (const segment of pageLabels.segments) {
            const candidatePages = [
                segment.startPage,
                segment.endPage,
                Math.min(segment.endPage, segment.startPage + 1),
            ];
            for (const page of candidatePages) {
                maxLength = Math.max(
                    maxLength,
                    formatPageIndicatorWithOptions(page, pageLabels, options).length,
                );
            }
        }
        return maxLength;
    }

    let maxLength = 0;
    for (let page = 1; page <= totalPages; page += 1) {
        maxLength = Math.max(maxLength, formatPageIndicatorWithOptions(page, pageLabels, options).length);
    }

    return maxLength;
}

const PAGE_INDICATOR_MIN_TOTAL_WIDTH_CH = 3;

export function getPageIndicatorLayoutMetrics(
    totalPages: number,
    pageLabels: TDocumentPageLabelLookup,
    showTotal: boolean,
    options: IPageIndicatorFormatOptions = {},
) {
    const currentMinimumWidth = showTotal ? 5 : 3;
    const currentWidthCh = Math.max(currentMinimumWidth, getMaxPageIndicatorLength(totalPages, pageLabels, options));

    if (!showTotal) {
        return {
            currentWidthCh,
            totalWidthCh: 0,
            separatorWidthCh: 0,
            displayWidthCh: currentWidthCh + 2,
        };
    }

    const totalWidthCh = Math.max(
        PAGE_INDICATOR_MIN_TOTAL_WIDTH_CH,
        String(totalPages).length,
    );
    const separatorWidthCh = 1;

    return {
        currentWidthCh,
        totalWidthCh,
        separatorWidthCh,
        displayWidthCh: currentWidthCh + totalWidthCh + separatorWidthCh + 2,
    };
}

export function parsePageRangeInput(input: string, totalPages: number): IDocumentPageRange | null {
    if (totalPages <= 0) {
        return null;
    }

    const normalized = input
        .trim()
        .replace(/[–—]/g, '-')
        .replace(/\.\./g, '-')
        .replace(/\s+/g, '');

    if (!normalized) {
        return null;
    }

    const match = /^(\d+)(?:-(\d+))?$/.exec(normalized);
    if (!match) {
        return null;
    }

    const first = Number.parseInt(match[1] ?? '', 10);
    if (!Number.isFinite(first) || first < 1 || first > totalPages) {
        return null;
    }

    const secondToken = match[2];
    if (!secondToken) {
        return {
            startPage: first,
            endPage: first,
        };
    }

    const second = Number.parseInt(secondToken, 10);
    if (!Number.isFinite(second) || second < 1 || second > totalPages) {
        return null;
    }

    const startPage = Math.min(first, second);
    const endPage = Math.max(first, second);

    return {
        startPage,
        endPage,
    };
}

export function formatPageRange(range: IDocumentPageRange) {
    if (range.startPage === range.endPage) {
        return String(range.startPage);
    }
    return `${range.startPage}-${range.endPage}`;
}
