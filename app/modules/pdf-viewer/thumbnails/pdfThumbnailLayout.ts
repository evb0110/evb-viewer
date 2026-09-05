export const DEFAULT_THUMBNAIL_ITEM_HEIGHT = 220;
const THUMBNAIL_ITEM_VERTICAL_PADDING = 8;
const THUMBNAIL_ITEM_CONTENT_GAP = 4;
const THUMBNAIL_NUMBER_LINE_HEIGHT = 16;
const THUMBNAIL_CANVAS_BORDER_WIDTH = 2;
export const VIRTUAL_OVERSCAN = 8;
const CURRENT_PAGE_NEIGHBOR_COUNT = 2;

export function resolveThumbnailVirtualPages(
    visibleStartIndex: number,
    visibleEndIndex: number,
    totalPages: number,
    currentPage: number,
    pageBounds?: {
        endPage?: number;
        startPage?: number;
    },
) {
    if (totalPages <= 0) {
        return [] as number[];
    }

    const pages = new Set<number>();
    const firstPage = Math.min(
        totalPages,
        Math.max(1, Math.trunc(pageBounds?.startPage ?? 1)),
    );
    const lastPage = Math.max(
        firstPage,
        Math.min(totalPages, Math.trunc(pageBounds?.endPage ?? totalPages)),
    );
    const startIndex = Math.max(firstPage - 1, visibleStartIndex);
    const endIndex = Math.min(lastPage - 1, visibleEndIndex);
    for (let index = startIndex; index <= endIndex; index += 1) {
        pages.add(index + 1);
    }

    const clampedCurrentPage = Math.min(Math.max(currentPage, firstPage), lastPage);
    for (
        let page = Math.max(firstPage, clampedCurrentPage - CURRENT_PAGE_NEIGHBOR_COUNT);
        page <= Math.min(lastPage, clampedCurrentPage + CURRENT_PAGE_NEIGHBOR_COUNT);
        page += 1
    ) {
        pages.add(page);
    }
    return [...pages].sort((left, right) => left - right);
}

function isValidThumbnailAspectRatio(value: number | null | undefined): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function resolveThumbnailItemHeightFromCanvasHeight(canvasHeight: number) {
    return Math.ceil(canvasHeight)
        + THUMBNAIL_ITEM_VERTICAL_PADDING
        + THUMBNAIL_ITEM_CONTENT_GAP
        + THUMBNAIL_NUMBER_LINE_HEIGHT
        + THUMBNAIL_CANVAS_BORDER_WIDTH;
}

export function resolveThumbnailItemHeightFromAspect(
    aspectRatio: number | null | undefined,
    renderWidth: number,
) {
    if (!isValidThumbnailAspectRatio(aspectRatio)) {
        return DEFAULT_THUMBNAIL_ITEM_HEIGHT;
    }

    return resolveThumbnailItemHeightFromCanvasHeight(renderWidth * aspectRatio);
}

export function createThumbnailCanvasStyle(aspectRatio: number | null | undefined) {
    return isValidThumbnailAspectRatio(aspectRatio)
        ? {aspectRatio: `1 / ${aspectRatio}`}
        : {};
}

export function createThumbnailItemStyle(top: number, minHeight?: number) {
    return {
        minHeight: minHeight === undefined ? undefined : `${minHeight}px`,
        transform: `translateY(${top}px)`,
    };
}
