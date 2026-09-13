import {clamp} from 'es-toolkit/math';

const COMFORT_PADDING_MIN_PX = 16;
const COMFORT_PADDING_MAX_PX = 48;

/**
 * Shared auto-follow timing policy for every document thumbnail adapter.
 * A rail stops following the current page for the cooldown after a user
 * interaction, and ignores its own programmatic scrolls for the guard window.
 */
export const DOCUMENT_THUMBNAIL_AUTO_FOLLOW_COOLDOWN_MS = 700;
export const DOCUMENT_THUMBNAIL_PROGRAMMATIC_SCROLL_GUARD_MS = 160;

export interface IDocumentThumbnailPageBounds {
    bottom: number;
    height: number;
    top: number;
}

export interface IDocumentThumbnailViewport {
    clientHeight: number;
    scrollHeight: number;
    scrollTop: number;
}

export function resolveDocumentThumbnailPageBounds(
    page: number,
    layout: {
        getPageHeight(page: number): number;
        getPageTop(page: number): number
    },
): IDocumentThumbnailPageBounds {
    const top = Math.max(0, layout.getPageTop(page));
    const height = Math.max(1, layout.getPageHeight(page));
    return {
        bottom: top + height,
        height,
        top,
    };
}

export function getDocumentThumbnailMaxScrollTop(viewport: IDocumentThumbnailViewport) {
    return Math.max(0, viewport.scrollHeight - viewport.clientHeight);
}

export function getDocumentThumbnailComfortPadding(viewport: IDocumentThumbnailViewport) {
    return Math.min(
        COMFORT_PADDING_MAX_PX,
        Math.max(COMFORT_PADDING_MIN_PX, Math.round(viewport.clientHeight * 0.12)),
    );
}

export function isDocumentThumbnailWithinComfortViewport(
    viewport: IDocumentThumbnailViewport,
    bounds: IDocumentThumbnailPageBounds,
) {
    const padding = getDocumentThumbnailComfortPadding(viewport);
    return bounds.top >= viewport.scrollTop + padding
        && bounds.bottom <= viewport.scrollTop + viewport.clientHeight - padding;
}

/**
 * Shared current-page reveal policy for every document thumbnail adapter.
 * Distant pages are centered; nearby pages move only enough to regain a stable comfort inset.
 */
export function resolveDocumentThumbnailRevealScrollTop(
    viewport: IDocumentThumbnailViewport,
    bounds: IDocumentThumbnailPageBounds,
) {
    if (viewport.clientHeight <= 0) {
        return null;
    }
    const padding = getDocumentThumbnailComfortPadding(viewport);
    const viewportBottom = viewport.scrollTop + viewport.clientHeight;
    const maxScrollTop = getDocumentThumbnailMaxScrollTop(viewport);
    if (isDocumentThumbnailWithinComfortViewport(viewport, bounds)) {
        return null;
    }
    if (bounds.bottom <= viewport.scrollTop || bounds.top >= viewportBottom) {
        return clamp(
            bounds.top - Math.max(0, (viewport.clientHeight - bounds.height) / 2),
            0,
            maxScrollTop,
        );
    }
    if (bounds.top < viewport.scrollTop + padding) {
        return clamp(bounds.top - padding, 0, maxScrollTop);
    }
    return clamp(bounds.bottom + padding - viewport.clientHeight, 0, maxScrollTop);
}
