import { pageNumberToPageIndex } from '@contracts/pageNumbers';
import type { TPageNumber } from '@contracts/pageNumbers';

import {
    type IPdfPageLayoutMetrics,
    getLayoutPageHeight,
} from '@app/modules/document-viewer/public';

export function getPageHeight(layout: IPdfPageLayoutMetrics, pageNumber: TPageNumber) {
    const pageIndex = pageNumberToPageIndex(pageNumber);
    return pageIndex < layout.base.pageHeights.length
        ? getLayoutPageHeight(layout, pageIndex)
        : null;
}
