import { uniq } from 'es-toolkit/array';
import { range } from 'es-toolkit/math';
import type {
    TPdfViewMode,
    TPrintOrientation,
} from '@contracts/shared';
import {
    parsePageNumber,
    requirePageNumber,
} from '@contracts/pageNumbers';

interface IPrintablePageMetric {
    width: number;
    height: number;
}

interface IPrintLayoutOptions {
    pageNumbers?: number[];
    viewMode: TPdfViewMode;
    orientation: TPrintOrientation;
}

const SAFE_DIRECT_PRINT_FIT_SCALE_THRESHOLD = 0.97;
const SAFE_DIRECT_PRINT_ASPECT_DELTA_THRESHOLD = 0.1;
const STANDARD_SINGLE_PAGE_PRINT_SHEETS = [
    {
        width: 595.28,
        height: 841.89,
    },
    {
        width: 612,
        height: 792,
    },
] as const;

export function normalizePrintPageNumbers(
    pageNumbers: number[] | undefined,
    totalPages: number,
) {
    const normalizedTotalPages = Number.isFinite(totalPages) && totalPages > 0
        ? Math.floor(totalPages)
        : 0;
    if (normalizedTotalPages <= 0) {
        return [];
    }

    if (!pageNumbers || pageNumbers.length === 0) {
        return range(1, normalizedTotalPages + 1)
            .map(pageNumber => requirePageNumber(pageNumber, normalizedTotalPages));
    }

    return uniq(pageNumbers)
        .flatMap((page) => {
            const pageNumber = parsePageNumber(page, normalizedTotalPages);
            return pageNumber === null ? [] : [pageNumber];
        })
        .sort((left, right) => left - right);
}

// A page prints without layout when A4 or Letter holds it at nearly full size
// and nearly its own aspect ratio.
function fitsStandardSheet(width: number, height: number) {
    const isLandscape = width > height;
    const pageAspect = Math.max(width, height) / Math.max(1, Math.min(width, height));
    let bestFitScale = 0;
    let bestAspectDelta = Number.POSITIVE_INFINITY;
    for (const sheet of STANDARD_SINGLE_PAGE_PRINT_SHEETS) {
        const sheetWidth = isLandscape ? sheet.height : sheet.width;
        const sheetHeight = isLandscape ? sheet.width : sheet.height;
        const fitScale = Math.min(sheetWidth / Math.max(1, width), sheetHeight / Math.max(1, height));
        const aspectDelta = Math.abs(sheet.height / sheet.width - pageAspect);
        if (
            fitScale > bestFitScale + 0.0001
            || (Math.abs(fitScale - bestFitScale) <= 0.0001 && aspectDelta < bestAspectDelta)
        ) {
            bestFitScale = fitScale;
            bestAspectDelta = aspectDelta;
        }
    }
    return bestFitScale >= SAFE_DIRECT_PRINT_FIT_SCALE_THRESHOLD
        && bestAspectDelta <= SAFE_DIRECT_PRINT_ASPECT_DELTA_THRESHOLD;
}

export function shouldPrintPageMetricsDirectly(
    pageMetrics: readonly IPrintablePageMetric[],
    options: IPrintLayoutOptions,
) {
    if (
        options.viewMode !== 'single'
        || options.orientation !== 'auto'
        || (options.pageNumbers && options.pageNumbers.length > 0)
    ) {
        return false;
    }

    if (pageMetrics.length === 0) {
        return null;
    }

    return pageMetrics.every(metric => fitsStandardSheet(metric.width, metric.height));
}
