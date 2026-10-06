import type {IPdfPageLayoutMetrics} from '@app/modules/document-viewer/public';

export function getTrailingSpacerHeightForPage(
    layout: IPdfPageLayoutMetrics,
    lastVisiblePage: number,
) {
    if (!Number.isFinite(lastVisiblePage) || lastVisiblePage < 1) {
        return 0;
    }

    const pageIndex = Math.min(layout.base.totalPages, Math.floor(lastVisiblePage)) - 1;
    const rowIndex = layout.base.pageRowIndices[pageIndex] ?? -1;
    if (!Number.isFinite(rowIndex) || rowIndex < 0) {
        return 0;
    }

    const hiddenRows = Math.max(0, layout.base.rowHeights.length - rowIndex - 1);
    return (
        (layout.base.rowHeightPrefixSums[layout.base.rowHeightPrefixSums.length - 1] ?? 0)
        - (layout.base.rowHeightPrefixSums[rowIndex] ?? 0)
    ) * layout.scale
        + Math.max(0, hiddenRows - 1) * layout.gap;
}
