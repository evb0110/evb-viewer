import { pageNumberToPageIndex } from '@contracts/pageNumbers';
import type { TPageNumber } from '@contracts/pageNumbers';

import {
    type IPdfPageLayoutMetrics,
    getLayoutPageTop,
} from '@app/modules/document-viewer/public';

export function getPageTop(layout: IPdfPageLayoutMetrics, pageNumber: TPageNumber) {
    return getLayoutPageTop(layout, pageNumberToPageIndex(pageNumber));
}
