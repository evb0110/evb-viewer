import { requirePageNumber } from '@contracts/pageNumbers';
import type { TPageNumber } from '@contracts/pageNumbers';
import type { TPdfViewMode } from '@contracts/shared';
import type { IPdfPageMetric } from '@app/types/pdfUi';
import { DOCUMENT_PAGE_GUTTER_PX } from '@app/modules/document-viewer/public';
import { getPageRowBoundsForViewMode } from '@app/modules/pdf-viewer/engine/pdf-page-layout/getPageRowBoundsForViewMode';
import {isSparsePageMetricCollection} from '@app/modules/pdf-viewer/engine/pdf-page-layout/normalizePageMetrics';
import { resolveCurrentSpreadBaseWidth } from '@app/modules/pdf-viewer/engine/pdf-page-layout/resolveCurrentSpreadBaseWidth';

export interface IPdfFitWidthDimensions {
    readonly availableSize: number;
    readonly baseDimension: number;
}

interface IResolvePdfFitWidthDimensionsOptions {
    readonly metrics: IPdfPageMetric[];
    readonly rawSize: number;
    readonly page: TPageNumber;
    readonly currentWidth: number;
    readonly viewMode: TPdfViewMode;
    readonly totalPages: number;
    readonly continuousScroll: boolean;
    readonly widthRows?: ReadonlyMap<number, number>;
}

function resolveFitWidthAvailableSize(
    rawSize: number,
    page: TPageNumber,
    viewMode: TPdfViewMode,
    totalPages: number,
) {
    const row = getPageRowBoundsForViewMode({
        pageNumber: page,
        viewMode,
        totalPages,
    });
    const columns = row.end - row.start + 1;
    return rawSize - DOCUMENT_PAGE_GUTTER_PX * (columns + 1);
}

/**
 * Return the largest base width for each row shape in a continuous document.
 */
export function resolvePdfFitWidthRowWidths(options: {
    readonly metrics: IPdfPageMetric[];
    readonly viewMode: TPdfViewMode;
    readonly totalPages: number;
}) {
    const widthRows = new Map<number, number>();
    const candidates = new Set<number>([
        1,
        options.totalPages,
    ]);
    if (isSparsePageMetricCollection(options.metrics)) {
        // Nearest-page estimates only change at measured pages and halfway
        // between them. Inspect neighboring rows at those boundaries without
        // walking every virtual page.
        let previousIndex: number | undefined;
        for (const index of options.metrics.knownIndices) {
            candidates.add(index + 1);
            if (previousIndex !== undefined) {
                const boundary = Math.floor((previousIndex + index) / 2) + 1;
                for (let offset = -2; offset <= 2; offset += 1) {
                    candidates.add(boundary + offset);
                }
            }
            previousIndex = index;
        }
    } else {
        for (let pageNumber = 1; pageNumber <= options.totalPages; pageNumber += 1) {
            candidates.add(pageNumber);
        }
    }

    const visited = new Set<number>();
    for (const candidate of candidates) {
        if (candidate < 1 || candidate > options.totalPages) continue;
        const row = getPageRowBoundsForViewMode({
            pageNumber: requirePageNumber(candidate),
            viewMode: options.viewMode,
            totalPages: options.totalPages,
        });
        if (visited.has(row.start)) continue;
        visited.add(row.start);
        const columns = row.end - row.start + 1;
        const width = resolveCurrentSpreadBaseWidth(
            options.metrics,
            options.viewMode,
            options.totalPages,
            row.start,
        );
        if (width) widthRows.set(columns, Math.max(widthRows.get(columns) ?? 0, width));
    }
    return widthRows;
}

export function resolvePdfFitWidthDimensions(
    options: IResolvePdfFitWidthDimensionsOptions,
): IPdfFitWidthDimensions {
    const currentAvailableSize = resolveFitWidthAvailableSize(
        options.rawSize,
        options.page,
        options.viewMode,
        options.totalPages,
    );
    if (!options.continuousScroll) {
        return {
            availableSize: currentAvailableSize,
            baseDimension: options.currentWidth,
        };
    }

    const widthRows = options.widthRows ?? resolvePdfFitWidthRowWidths(options);
    let result: IPdfFitWidthDimensions = {
        availableSize: currentAvailableSize,
        baseDimension: options.currentWidth,
    };
    for (const [
        columns,
        width,
    ] of widthRows) {
        const availableSize = options.rawSize - DOCUMENT_PAGE_GUTTER_PX * (columns + 1);
        if (availableSize <= 0) continue;
        if (
            result.availableSize <= 0
            || availableSize / width < result.availableSize / result.baseDimension
        ) {
            result = {
                availableSize,
                baseDimension: width,
            };
        }
    }
    return result;
}
