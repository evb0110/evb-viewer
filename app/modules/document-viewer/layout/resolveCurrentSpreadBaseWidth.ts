import {isFinitePositive} from '@contracts/runtimeGuards';
import type { TPageNumber } from '@contracts/pageNumbers';
import type { TPdfViewMode } from '@app/types/pdfContracts';
import type { IPdfPageMetric } from '@app/types/pdfUi';
import { sumBy } from 'es-toolkit/math';
import { getPageNumbersForViewMode } from '@app/modules/document-viewer/layout/getPageRowBoundsForViewMode';

export function resolveCurrentSpreadBaseWidth(
    pageMetrics: IPdfPageMetric[],
    viewMode: TPdfViewMode,
    totalPages: number,
    currentPage: TPageNumber,
) {
    if (totalPages <= 0) {
        return null;
    }

    const rowPages = getPageNumbersForViewMode({
        pageNumber: currentPage,
        viewMode,
        totalPages,
    });
    const width = sumBy(rowPages, (rowPage) => {
        const pageWidth = pageMetrics[rowPage - 1]?.width;
        return isFinitePositive(pageWidth) ? pageWidth : 0;
    });

    return width > 0 ? width : null;
}
