import { requirePageNumber } from '@contracts/pageNumbers';
import type { TPageNumber } from '@contracts/pageNumbers';

import { clamp } from 'es-toolkit/math';
import type { TPdfViewMode } from '@contracts/shared';
import { getPageContainerByNumber } from '@app/modules/pdf-viewer/engine/pdf-scroll-visibility/getPageContainerByNumber';
import { getPageScrollBounds as getPageScrollBoundsForContainer } from '@app/modules/pdf-viewer/engine/pdf-scroll-visibility/getPageScrollBounds';
import type { IPageScrollBounds } from '@app/modules/pdf-viewer/engine/pdf-scroll-visibility/pdfScrollVisibilityTypes';
import { getPageRowBoundsForViewMode } from '@app/modules/pdf-viewer/engine/pdf-page-layout/getPageRowBoundsForViewMode';
import { resolvePageBoundedHorizontalScroll } from '@app/modules/pdf-viewer/engine/pdf-horizontal-scroll-clamp/resolvePageBoundedHorizontalScroll';
import type { IScrollToPageOptions } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfScroll';
import type { TPageSnapAnchor } from '@app/modules/document-viewer/public';

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

interface IClampMarkerScrollTopOptions {
    desiredTop: number;
    maxTop: number;
    pageTop: number;
    pageHeight: number;
    containerHeight: number;
    scaledMargin: number;
}

interface IMountedPageSnapTopOptions {
    anchor: TPageSnapAnchor;
    baseTop: number;
    maxTop: number;
    targetHeight: number;
    containerHeight: number;
    scaledMargin: number;
    pageYRatio?: number | null | undefined;
    markerRect?: IScrollToPageOptions['markerRect'];
    markerPageTop?: number | undefined;
    markerPageHeight?: number | undefined;
    pageYBaseTop?: number | undefined;
    pageYPageHeight?: number | undefined;
}

interface IMountedPageMarkerScrollLeftOptions {
    containerWidth: number;
    maxLeft: number;
    markerRect?: IScrollToPageOptions['markerRect'];
    pageLeft: number;
    pageWidth: number;
    scaledMargin: number;
}

export interface IMountedPageSnapTargetOptions {
    anchor: TPageSnapAnchor;
    container: HTMLElement;
    scaledMargin: number;
    scrollOptions?: Pick<IScrollToPageOptions, 'pageYRatio' | 'markerRect'> | undefined;
    targetPage: number;
    targetPageElement: HTMLElement;
    totalPages: number;
    viewMode: TPdfViewMode;
}

export interface IMountedPageSnapTarget {
    left: number | null;
    top: number;
}

export interface IContinuousNavigationTargetOptions {
    container: HTMLElement;
    scaledMargin: number;
    scrollOptions?: IScrollToPageOptions | undefined;
    targetPageElement: HTMLElement;
}

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

function clampMarkerScrollTopToPageBounds(options: IClampMarkerScrollTopOptions) {
    const minTop = Math.max(0, options.pageTop - options.scaledMargin);
    const pageMaxTop = Math.max(
        minTop,
        options.pageTop + options.pageHeight + options.scaledMargin - options.containerHeight,
    );
    const boundedMaxTop = Math.min(options.maxTop, pageMaxTop);
    const boundedMinTop = Math.min(minTop, boundedMaxTop);

    return clamp(
        options.desiredTop,
        boundedMinTop,
        Math.max(boundedMinTop, boundedMaxTop),
    );
}

function resolveMountedPageSnapTop(options: IMountedPageSnapTopOptions) {
    if (typeof options.pageYRatio === 'number' && Number.isFinite(options.pageYRatio)) {
        const pageYBaseTop = typeof options.pageYBaseTop === 'number'
            && Number.isFinite(options.pageYBaseTop)
            ? options.pageYBaseTop
            : options.baseTop;
        const pageYPageHeight = typeof options.pageYPageHeight === 'number'
            && Number.isFinite(options.pageYPageHeight)
            && options.pageYPageHeight > 0
            ? options.pageYPageHeight
            : options.targetHeight;
        return Math.min(
            options.maxTop,
            Math.max(0, pageYBaseTop + clamp(options.pageYRatio, 0, 1) * pageYPageHeight),
        );
    }

    if (
        options.markerRect
        && typeof options.markerPageTop === 'number'
        && Number.isFinite(options.markerPageTop)
        && typeof options.markerPageHeight === 'number'
        && Number.isFinite(options.markerPageHeight)
        && options.markerPageHeight > 0
    ) {
        const markerCenterY = clamp(
            options.markerRect.top + options.markerRect.height / 2,
            0,
            1,
        );
        return clampMarkerScrollTopToPageBounds({
            desiredTop: Math.max(
                0,
                options.markerPageTop + markerCenterY * options.markerPageHeight - options.containerHeight / 2,
            ),
            maxTop: options.maxTop,
            pageTop: options.markerPageTop,
            pageHeight: options.markerPageHeight,
            containerHeight: options.containerHeight,
            scaledMargin: options.scaledMargin,
        });
    }

    const topTarget = Math.min(options.maxTop, Math.max(0, options.baseTop));
    const centerOffset = Math.max(0, (options.containerHeight - options.targetHeight) / 2);
    const centerTarget = Math.min(options.maxTop, Math.max(0, options.baseTop - centerOffset));
    const bottomTarget = Math.min(
        options.maxTop,
        Math.max(0, options.baseTop + options.targetHeight - options.containerHeight),
    );

    if (options.anchor === 'top') {
        return topTarget;
    }
    if (options.anchor === 'bottom') {
        return bottomTarget;
    }
    return centerTarget;
}

function resolveMountedPageMarkerScrollLeft(options: IMountedPageMarkerScrollLeftOptions) {
    if (
        !options.markerRect
        || !Number.isFinite(options.pageWidth)
        || options.pageWidth <= 0
    ) {
        return null;
    }

    const markerCenterX = clamp(
        options.markerRect.left + options.markerRect.width / 2,
        0,
        1,
    );
    const markerTargetLeft = Math.max(
        0,
        options.pageLeft + markerCenterX * options.pageWidth - options.containerWidth / 2,
    );
    const scrollClamp = resolvePageBoundedHorizontalScroll({
        scrollLeft: markerTargetLeft,
        viewportWidth: options.containerWidth,
        pageLeft: options.pageLeft,
        pageWidth: options.pageWidth,
        margin: options.scaledMargin,
    });

    return Math.min(
        options.maxLeft,
        Math.max(0, scrollClamp?.scrollLeft ?? markerTargetLeft),
    );
}

export function resolveContinuousNavigationTargetTop(options: IContinuousNavigationTargetOptions) {
    const pageHeight = options.targetPageElement.offsetHeight || options.targetPageElement.clientHeight;
    const pageYRatio = typeof options.scrollOptions?.pageYRatio === 'number'
        && Number.isFinite(options.scrollOptions.pageYRatio)
        ? clamp(options.scrollOptions.pageYRatio, 0, 1)
        : 0;
    const maxTop = Math.max(0, options.container.scrollHeight - options.container.clientHeight);
    if (
        typeof options.scrollOptions?.pageYRatio === 'number'
        && Number.isFinite(options.scrollOptions.pageYRatio)
    ) {
        return Math.min(
            maxTop,
            Math.max(
                0,
                options.targetPageElement.offsetTop + pageYRatio * pageHeight - options.scaledMargin,
            ),
        );
    }

    if (options.scrollOptions?.markerRect) {
        const markerCenterY = clamp(
            options.scrollOptions.markerRect.top + options.scrollOptions.markerRect.height / 2,
            0,
            1,
        );
        return clampMarkerScrollTopToPageBounds({
            desiredTop: Math.max(
                0,
                options.targetPageElement.offsetTop + markerCenterY * pageHeight - options.container.clientHeight / 2,
            ),
            maxTop,
            pageTop: options.targetPageElement.offsetTop,
            pageHeight,
            containerHeight: options.container.clientHeight,
            scaledMargin: options.scaledMargin,
        });
    }

    return Math.min(
        maxTop,
        Math.max(0, options.targetPageElement.offsetTop - options.scaledMargin),
    );
}

export function resolveContinuousNavigationTargetLeft(options: IContinuousNavigationTargetOptions) {
    if (!options.scrollOptions?.markerRect) {
        return null;
    }

    const containerWidth = Number.isFinite(options.container.clientWidth) && options.container.clientWidth > 0
        ? options.container.clientWidth
        : 0;
    const scrollWidth = Number.isFinite(options.container.scrollWidth) && options.container.scrollWidth > 0
        ? options.container.scrollWidth
        : containerWidth;
    const maxLeft = Math.max(0, scrollWidth - containerWidth);
    const pageWidth = options.targetPageElement.offsetWidth || options.targetPageElement.clientWidth || 0;
    return resolveMountedPageMarkerScrollLeft({
        containerWidth,
        maxLeft,
        markerRect: options.scrollOptions.markerRect,
        pageLeft: options.targetPageElement.offsetLeft,
        pageWidth,
        scaledMargin: options.scaledMargin,
    });
}

export function resolveMountedPageSnapTarget(options: IMountedPageSnapTargetOptions): IMountedPageSnapTarget {
    const containerHeight = options.container.clientHeight;
    const containerWidth = Number.isFinite(options.container.clientWidth) && options.container.clientWidth > 0
        ? options.container.clientWidth
        : 0;
    const targetGeometry = getPageRowGeometry({
        container: options.container,
        pageNumber: requirePageNumber(options.targetPage, options.totalPages),
        totalPages: options.totalPages,
        viewMode: options.viewMode,
    }) ?? {
        top: options.targetPageElement.offsetTop,
        height: options.targetPageElement.offsetHeight,
    };
    const targetPageHeight = options.targetPageElement.offsetHeight
        || options.targetPageElement.clientHeight
        || targetGeometry.height;
    const targetPageWidth = options.targetPageElement.offsetWidth || options.targetPageElement.clientWidth || 0;
    const targetHeight = targetGeometry.height;
    const baseTop = targetGeometry.top - options.scaledMargin;
    const maxTop = Math.max(0, options.container.scrollHeight - containerHeight);
    const scrollWidth = Number.isFinite(options.container.scrollWidth) && options.container.scrollWidth > 0
        ? options.container.scrollWidth
        : containerWidth;
    const maxLeft = Math.max(0, scrollWidth - containerWidth);
    const top = resolveMountedPageSnapTop({
        anchor: options.anchor,
        baseTop,
        maxTop,
        targetHeight,
        containerHeight,
        scaledMargin: options.scaledMargin,
        pageYRatio: options.scrollOptions?.pageYRatio,
        markerRect: options.scrollOptions?.markerRect,
        markerPageTop: options.targetPageElement.offsetTop,
        markerPageHeight: targetPageHeight,
        pageYBaseTop: options.targetPageElement.offsetTop - options.scaledMargin,
        pageYPageHeight: targetPageHeight,
    });
    const left = resolveMountedPageMarkerScrollLeft({
        containerWidth,
        maxLeft,
        markerRect: options.scrollOptions?.markerRect,
        pageLeft: options.targetPageElement.offsetLeft,
        pageWidth: targetPageWidth,
        scaledMargin: options.scaledMargin,
    });

    return {
        left,
        top,
    };
}
