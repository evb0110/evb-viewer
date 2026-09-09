import { requirePageIndex } from '@contracts/pageNumbers';
import type { TPageNumber } from '@contracts/pageNumbers';

import { clamp } from 'es-toolkit/math';
import type { TPdfViewMode } from '@contracts/shared';
import type { IPdfPageLayoutMetrics } from '@app/modules/pdf-viewer/engine/pdf-page-layout/pdfPageLayoutMetrics';
import {
    getLayoutContentHeight,
    getLayoutPageHeight,
    getLayoutPageTop,
    getLayoutPageWidth,
    getLayoutRowHeight,
} from '@app/modules/pdf-viewer/engine/pdf-page-layout/pdfPageLayoutMetrics';
import {createLazyIndexedCollection} from '@app/modules/pdf-viewer/engine/pdf-page-layout/normalizePageMetrics';

export interface IPdfSemanticAnchor {
    page: number;
    pageXFraction: number;
    pageYFraction: number;
    viewportXFraction: number;
    viewportYFraction: number;
    affinity: 'start' | 'center' | 'end';
}

export interface IPdfViewportPageMetric {
    width: number;
    height: number;
}
export interface IPdfViewportRect {
    left: number;
    top: number;
    width: number;
    height: number;
}

/**
 * Adapts the immutable layout sensor snapshot to the geometry consumed by the
 * viewport authority.  Navigation decisions must not consult live DOM layout.
 */
export function createPdfViewportGeometryFromLayout(
    metrics: IPdfPageLayoutMetrics,
    viewport: {
        width: number;
        height: number
    },
    revision: number,
    physicalScrollOrigin = 0,
): IPdfViewportGeometry {
    const getPageRect = (index: number): IPdfViewportRect => {
        const rowIndex = metrics.base.pageRowIndices[index] ?? 0;
        const rowStartPage = metrics.base.rowStartPages[rowIndex] ?? index + 1;
        const rowEndPage = metrics.base.rowEndPages[rowIndex] ?? index + 1;
        let rowWidth = 0;
        for (let page = rowStartPage; page <= rowEndPage; page += 1) {
            rowWidth += getLayoutPageWidth(
                metrics,
                requirePageIndex(page - 1, metrics.base.totalPages),
            );
        }
        rowWidth += Math.max(0, rowEndPage - rowStartPage) * metrics.gap;
        let left = Math.max(0, (viewport.width - rowWidth) / 2);
        for (let page = rowStartPage; page < index + 1; page += 1) {
            left += getLayoutPageWidth(
                metrics,
                requirePageIndex(page - 1, metrics.base.totalPages),
            ) + metrics.gap;
        }
        const pageIndex = requirePageIndex(index, metrics.base.totalPages);
        return {
            left,
            top: getLayoutPageTop(metrics, pageIndex) ?? 0,
            width: getLayoutPageWidth(metrics, pageIndex),
            height: getLayoutPageHeight(metrics, pageIndex),
        };
    };
    const pageRects = metrics.base.isSparse
        ? createLazyIndexedCollection<IPdfViewportRect>({
            length: metrics.base.totalPages,
            getValue: getPageRect,
        })
        : metrics.base.pageWidths.map((_width, index) => getPageRect(index));
    const getRow = (rowIndex: number) => {
        const startPage = metrics.base.rowStartPages[rowIndex] ?? rowIndex + 1;
        const endPage = metrics.base.rowEndPages[rowIndex] ?? startPage;
        const first = pageRects[startPage - 1] ?? {
            left: 0,
            top: 0,
            width: 0,
            height: 0,
        };
        const last = pageRects[endPage - 1] ?? first;
        return {
            startPage,
            endPage,
            rect: {
                left: first.left,
                top: first.top,
                width: last.left + last.width - first.left,
                height: getLayoutRowHeight(metrics, rowIndex) || first.height,
            },
        };
    };
    const rows = metrics.base.isSparse
        ? createLazyIndexedCollection<IPdfViewportGeometry['rows'][number]>({
            length: metrics.base.rowStartPages.length,
            getValue: getRow,
        })
        : metrics.base.rowStartPages.map((_startPage, rowIndex) => getRow(rowIndex));
    const maxPageWidth = Number.isFinite(metrics.base.maxPageWidth)
        ? Math.max(0, metrics.base.maxPageWidth)
        : 0;
    const contentWidth = metrics.base.isSparse
        ? Math.max(
            viewport.width,
            maxPageWidth * metrics.scale
                * (metrics.base.rowStartPages.length < metrics.base.totalPages ? 2 : 1)
                + (metrics.base.rowStartPages.length < metrics.base.totalPages ? metrics.gap : 0),
        )
        : Math.max(viewport.width, ...pageRects.map(rect => rect.left + rect.width));
    return {
        revision,
        insetTop: metrics.paddingTop,
        viewportWidth: viewport.width,
        viewportHeight: viewport.height,
        contentWidth,
        contentHeight: Math.max(viewport.height, getLayoutContentHeight(metrics)),
        physicalScrollOrigin: Math.max(0, physicalScrollOrigin),
        pageRects,
        rows,
    };
}

export interface IPdfViewportGeometry {
    revision: number;
    insetTop: number;
    viewportWidth: number;
    viewportHeight: number;
    contentWidth: number;
    contentHeight: number;
    physicalScrollOrigin: number;
    pageRects: readonly IPdfViewportRect[];
    rows: ReadonlyArray<{
        startPage: number;
        endPage: number;
        rect: IPdfViewportRect
    }>;
}

/**
 * Resolves a row without iterating the row collection. Sparse layouts expose
 * a virtual row array, so callers that need one page's mounted row must use
 * this indexed lookup rather than Array.prototype.find or a spread.
 */
export function getViewportGeometryRowForPage(
    geometry: IPdfViewportGeometry,
    pageNumber: TPageNumber,
) {
    const rowCount = geometry.rows.length;
    if (rowCount === 0) {
        return null;
    }

    const page = Number.isFinite(pageNumber)
        ? clamp(Math.trunc(pageNumber), 1, Math.max(1, geometry.pageRects.length))
        : 1;
    let low = 0;
    let high = rowCount - 1;
    while (low <= high) {
        const middle = low + Math.floor((high - low) / 2);
        const row = geometry.rows[middle];
        if (!row) {
            break;
        }
        if (page < row.startPage) {
            high = middle - 1;
        } else if (page > row.endPage) {
            low = middle + 1;
        } else {
            return row;
        }
    }

    return geometry.rows[clamp(low, 0, rowCount - 1)] ?? null;
}

export interface IComputePdfViewportGeometryOptions {
    revision: number;
    pages: readonly IPdfViewportPageMetric[];
    viewportWidth: number;
    viewportHeight: number;
    zoom: number;
    viewMode: TPdfViewMode;
    gap: number;
    padding: number;
}

function getRowEnd(startIndex: number, total: number, mode: TPdfViewMode) {
    if (mode === 'single' || total <= 1) {
        return startIndex;
    }
    if (mode === 'facing-first-single' && startIndex === 0) {
        return 0;
    }
    return Math.min(total - 1, startIndex + 1);
}

export function computePdfViewportGeometry(
    options: IComputePdfViewportGeometryOptions,
): IPdfViewportGeometry {
    const scale = Math.max(0.01, options.zoom);
    const gap = Math.max(0, options.gap);
    const padding = Math.max(0, options.padding);
    const pageRects: IPdfViewportRect[] = [];
    const rows: Array<IPdfViewportGeometry['rows'][number]> = [];
    let top = padding;
    let contentWidth = options.viewportWidth;

    for (let start = 0; start < options.pages.length;) {
        const end = getRowEnd(start, options.pages.length, options.viewMode);
        const rowPages = options.pages.slice(start, end + 1);
        const widths = rowPages.map(page => Math.max(0, page.width * scale));
        const heights = rowPages.map(page => Math.max(0, page.height * scale));
        const rowWidth = widths.reduce((sum, width) => sum + width, 0) + gap * (widths.length - 1);
        const rowHeight = Math.max(0, ...heights);
        let left = Math.max(padding, (options.viewportWidth - rowWidth) / 2);
        for (let offset = 0; offset < rowPages.length; offset += 1) {
            const width = widths[offset];
            const height = heights[offset];
            if (width === undefined || height === undefined) {
                continue;
            }
            pageRects[start + offset] = {
                left,
                top,
                width,
                height,
            };
            left += width + gap;
        }
        rows.push({
            startPage: start + 1,
            endPage: end + 1,
            rect: {
                left: Math.max(padding, (options.viewportWidth - rowWidth) / 2),
                top,
                width: rowWidth,
                height: rowHeight,
            },
        });
        contentWidth = Math.max(contentWidth, rowWidth + padding * 2);
        top += rowHeight + gap;
        start = end + 1;
    }

    return {
        revision: options.revision,
        insetTop: padding,
        viewportWidth: options.viewportWidth,
        viewportHeight: options.viewportHeight,
        contentWidth,
        contentHeight: Math.max(options.viewportHeight, top - (rows.length ? gap : 0) + padding),
        physicalScrollOrigin: 0,
        pageRects,
        rows,
    };
}

export function resolveScrollForAnchor(geometry: IPdfViewportGeometry, anchor: IPdfSemanticAnchor) {
    const rect = geometry.pageRects[clamp(anchor.page, 1, geometry.pageRects.length) - 1];
    if (!rect) {
        return {
            left: 0,
            top: 0,
        };
    }
    const logicalTop = rect.top + clamp(anchor.pageYFraction, 0, 1) * rect.height
        - clamp(anchor.viewportYFraction, 0, 1) * geometry.viewportHeight
        - (anchor.affinity === 'start' ? geometry.insetTop : 0);
    const physicalContentHeight = Math.max(
        geometry.viewportHeight,
        geometry.contentHeight - geometry.physicalScrollOrigin,
    );
    return {
        left: clamp(
            rect.left + clamp(anchor.pageXFraction, 0, 1) * rect.width
                - clamp(anchor.viewportXFraction, 0, 1) * geometry.viewportWidth,
            0,
            Math.max(0, geometry.contentWidth - geometry.viewportWidth),
        ),
        top: clamp(
            logicalTop - geometry.physicalScrollOrigin,
            0,
            Math.max(0, physicalContentHeight - geometry.viewportHeight),
        ),
    };
}

export function resolveAnchorFromScroll(
    geometry: IPdfViewportGeometry,
    scroll: {
        left: number;
        top: number
    },
    viewportFraction = {
        x: 0.5,
        y: 0.5,
    },
): IPdfSemanticAnchor {
    const x = scroll.left + geometry.viewportWidth * viewportFraction.x;
    const y = scroll.top + geometry.physicalScrollOrigin
        + geometry.viewportHeight * viewportFraction.y;
    const rowCount = geometry.rows.length;
    if (rowCount === 0 || geometry.pageRects.length === 0) {
        return {
            page: 1,
            pageXFraction: clamp(x, 0, 1),
            pageYFraction: clamp(y, 0, 1),
            viewportXFraction: clamp(viewportFraction.x, 0, 1),
            viewportYFraction: clamp(viewportFraction.y, 0, 1),
            affinity: 'center',
        };
    }
    let low = 0;
    let high = rowCount - 1;
    let containingRowIndex = -1;
    while (low <= high) {
        const middle = low + Math.floor((high - low) / 2);
        const row = geometry.rows[middle];
        if (!row) {
            break;
        }
        if (y < row.rect.top) {
            high = middle - 1;
        } else if (y > row.rect.top + row.rect.height) {
            low = middle + 1;
        } else {
            containingRowIndex = middle;
            break;
        }
    }

    const candidateRowIndexes: number[] = [];
    if (containingRowIndex >= 0) {
        const previousRowIndex = containingRowIndex - 1;
        const previousRow = geometry.rows[previousRowIndex];
        if (previousRow && y >= previousRow.rect.top && y <= previousRow.rect.top + previousRow.rect.height) {
            candidateRowIndexes.push(previousRowIndex);
        }
        candidateRowIndexes.push(containingRowIndex);
        const nextRowIndex = containingRowIndex + 1;
        const nextRow = geometry.rows[nextRowIndex];
        if (nextRow && y >= nextRow.rect.top && y <= nextRow.rect.top + nextRow.rect.height) {
            candidateRowIndexes.push(nextRowIndex);
        }
    } else {
        candidateRowIndexes.push(
            clamp(high, 0, Math.max(0, rowCount - 1)),
            clamp(low, 0, Math.max(0, rowCount - 1)),
        );
    }
    let containingPageIndex = -1;
    let horizontalCandidate: {
        index: number;
        distance: number;
    } | null = null;
    let nearestPageIndex = -1;
    let nearestPageDistance = Number.POSITIVE_INFINITY;
    const seenRows = new Set<number>();
    for (const rowIndex of candidateRowIndexes) {
        if (seenRows.has(rowIndex)) {
            continue;
        }
        seenRows.add(rowIndex);
        const row = geometry.rows[rowIndex];
        if (!row) {
            continue;
        }
        for (let page = row.startPage; page <= row.endPage; page += 1) {
            const pageIndex = page - 1;
            const rect = geometry.pageRects[pageIndex];
            if (!rect) {
                continue;
            }
            const verticallyContains = y >= rect.top && y <= rect.top + rect.height;
            const verticalDistance = verticallyContains
                ? 0
                : Math.abs(rect.top + rect.height / 2 - y);
            if (verticalDistance < nearestPageDistance) {
                nearestPageDistance = verticalDistance;
                nearestPageIndex = pageIndex;
            }
            if (!verticallyContains) {
                continue;
            }
            if (x >= rect.left && x <= rect.left + rect.width) {
                containingPageIndex = pageIndex;
                break;
            }
            const horizontalDistance = Math.abs(rect.left + rect.width / 2 - x);
            if (!horizontalCandidate || horizontalDistance < horizontalCandidate.distance) {
                horizontalCandidate = {
                    index: pageIndex,
                    distance: horizontalDistance,
                };
            }
        }
        if (containingPageIndex >= 0) {
            break;
        }
    }
    const pageIndex = containingPageIndex >= 0
        ? containingPageIndex
        : horizontalCandidate?.index ?? nearestPageIndex;
    const rect = geometry.pageRects[pageIndex] ?? {
        left: 0,
        top: 0,
        width: 1,
        height: 1,
    };
    return {
        page: pageIndex + 1,
        pageXFraction: clamp((x - rect.left) / Math.max(1, rect.width), 0, 1),
        pageYFraction: clamp((y - rect.top) / Math.max(1, rect.height), 0, 1),
        viewportXFraction: clamp(viewportFraction.x, 0, 1),
        viewportYFraction: clamp(viewportFraction.y, 0, 1),
        affinity: 'center',
    };
}

export function resolveRetainedAnchorFromScroll(
    geometry: IPdfViewportGeometry,
    scroll: {
        left: number;
        top: number;
    },
    committedAnchor: IPdfSemanticAnchor | null,
    tolerance = 1,
) {
    if (committedAnchor) {
        const projected = resolveScrollForAnchor(geometry, committedAnchor);
        if (
            Math.abs(projected.left - scroll.left) <= tolerance
            && Math.abs(projected.top - scroll.top) <= tolerance
        ) {
            return committedAnchor;
        }
    }
    return resolveAnchorFromScroll(geometry, scroll);
}
