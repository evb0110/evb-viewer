import { requirePageNumber } from '@contracts/pageNumbers';
import type { TPageNumber } from '@contracts/pageNumbers';

import { clamp } from 'es-toolkit/math';
import type { TPdfViewMode } from '@contracts/shared';
import { getPageContainerByNumber } from '@app/modules/pdf-viewer/engine/pdf-scroll-visibility/getPageContainerByNumber';
import { getPageScrollBounds as getPageScrollBoundsForContainer } from '@app/modules/pdf-viewer/engine/pdf-scroll-visibility/getPageScrollBounds';
import type { IPageScrollBounds } from '@app/modules/pdf-viewer/engine/pdf-scroll-visibility/pdfScrollVisibilityTypes';
import { getPageRowBoundsForViewMode } from '@app/modules/document-viewer/public';

interface IPageRowGeometry {
    top: number;
    height: number;
}

interface IPageRowGeometryOptions {
    container: HTMLElement;
    pageNumber: TPageNumber;
    totalPages: number;
    viewMode: TPdfViewMode;
}

interface IPageScrollBoundsOptions extends IPageRowGeometryOptions {scaledMargin: number;}

/** The scroll range that shows the page's row, read from its mounted bounds. */
export function getPageRowGeometry(options: IPageRowGeometryOptions): IPageRowGeometry | null {
    const rowBounds = getPageRowBoundsForViewMode({
        pageNumber: options.pageNumber,
        viewMode: options.viewMode,
        totalPages: options.totalPages,
    });
    let rowTop = Number.POSITIVE_INFINITY;
    let rowBottom = Number.NEGATIVE_INFINITY;
    let foundAnyPage = false;

    for (let rowPage = Number(rowBounds.start); rowPage <= Number(rowBounds.end); rowPage += 1) {
        const pageElement = getPageContainerByNumber(
            options.container,
            requirePageNumber(rowPage, options.totalPages),
        );
        if (!pageElement) {
            continue;
        }
        foundAnyPage = true;
        rowTop = Math.min(rowTop, pageElement.offsetTop);
        rowBottom = Math.max(rowBottom, pageElement.offsetTop + pageElement.offsetHeight);
    }

    if (!foundAnyPage) {
        return null;
    }

    return {
        top: rowTop,
        height: Math.max(0, rowBottom - rowTop),
    };
}

function getPageScrollBoundsFromGeometry(
    container: HTMLElement,
    geometry: IPageRowGeometry,
    scaledMargin: number,
): IPageScrollBounds {
    const maxScrollTop = Math.max(
        0,
        container.scrollHeight - container.clientHeight,
    );
    const unclampedMin = Math.max(0, geometry.top - scaledMargin);
    const unclampedMax = unclampedMin + Math.max(
        0,
        geometry.height - container.clientHeight,
    );
    const min = Math.min(maxScrollTop, unclampedMin);
    const max = Math.min(maxScrollTop, Math.max(min, unclampedMax));

    return {
        min,
        max,
    };
}

export function getPageScrollBounds(options: IPageScrollBoundsOptions) {
    const targetPage = requirePageNumber(
        clamp(options.pageNumber, 1, options.totalPages),
        options.totalPages,
    );
    const rowGeometry = getPageRowGeometry({
        container: options.container,
        pageNumber: targetPage,
        totalPages: options.totalPages,
        viewMode: options.viewMode,
    });
    if (rowGeometry) {
        return getPageScrollBoundsFromGeometry(
            options.container,
            rowGeometry,
            options.scaledMargin,
        );
    }

    return getPageScrollBoundsForContainer(
        options.container,
        targetPage,
        options.scaledMargin,
    );
}
