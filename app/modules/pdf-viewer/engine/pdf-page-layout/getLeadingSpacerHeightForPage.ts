import type {IPdfPageLayoutMetrics} from '@app/modules/document-viewer/public';

export function getLeadingSpacerHeightForPage(
    layout: IPdfPageLayoutMetrics,
    firstVisiblePage: number,
) {
    if (!Number.isFinite(firstVisiblePage) || firstVisiblePage < 1) {
        return 0;
    }

    const pageIndex = Math.min(layout.base.totalPages, Math.floor(firstVisiblePage)) - 1;
    const rowIndex = layout.base.pageRowIndices[pageIndex] ?? -1;
    if (!Number.isFinite(rowIndex) || rowIndex <= 0) {
        return 0;
    }

    return (layout.base.rowHeightPrefixSums[rowIndex - 1] ?? 0) * layout.scale
        + Math.max(0, rowIndex - 1) * layout.gap;
}
