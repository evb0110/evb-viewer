import { DOCUMENT_PAGE_GUTTER_PX } from '@app/modules/document-viewer/layout/documentPageGutterPx';

export interface IDocumentZoomPageLayout {
    left?: number;
    top: number;
    width: number;
    height: number;
}

/** The viewport's client box and the outer box around it, scrollbars included. */
interface IDocumentZoomViewportBox {
    clientHeight: number;
    clientWidth: number;
    offsetHeight: number;
    offsetWidth: number;
}

export interface IDocumentZoomAnchor {
    pageIndex: number;
    viewportX?: number;
    viewportXRatio?: number;
    viewportY?: number;
    viewportYRatio?: number;
    xRatio: number;
    yRatio: number;
    /** The box the anchor was taken in, when the viewport is a laid-out element. */
    viewportBox?: IDocumentZoomViewportBox;
}

type TDocumentZoomViewport = Pick<HTMLElement, 'clientHeight' | 'clientWidth' | 'scrollLeft' | 'scrollTop'>
    & Partial<Pick<HTMLElement, 'offsetHeight' | 'offsetWidth'>>;

export interface IDocumentZoomViewportPoint {
    x: number;
    y: number;
}

function resolveLayoutLeft(
    container: Pick<HTMLElement, 'clientWidth'>,
    layout: IDocumentZoomPageLayout,
) {
    return layout.left ?? Math.max(0, (container.clientWidth - layout.width) / 2);
}

/** Where the page-source renderer places a page of this width: centred, never past its gutter. */
export function resolveDocumentPageLeft(containerWidth: number, pageWidth: number) {
    return Math.max(DOCUMENT_PAGE_GUTTER_PX, (containerWidth - pageWidth) / 2);
}

function distanceToPage(layout: IDocumentZoomPageLayout, y: number) {
    const bottom = layout.top + layout.height;
    return y < layout.top ? layout.top - y : y > bottom ? y - bottom : 0;
}

/**
 * The first page nearest to `y` in a layout whose page tops run down the
 * document, as a continuous layout's do. A scroll reads it on every frame, so
 * it searches the tops instead of visiting every page: pages starting below
 * `y` only get farther, and pages above it are no nearer than the row just
 * above `y`, except where a page ends exactly where the next row starts.
 */
function findNearestPageIndex(layouts: readonly IDocumentZoomPageLayout[], y: number) {
    let low = 0;
    let high = layouts.length;
    while (low < high) {
        const middle = (low + high) >>> 1;
        if (layouts[middle]!.top > y) high = middle;
        else low = middle + 1;
    }
    let nearest = Math.min(low, layouts.length - 1);
    let nearestDistance = distanceToPage(layouts[nearest]!, y);
    // The row holding the last page that starts above y, and the row before it.
    let rowsLeft = 2;
    let rowTop = Number.NaN;
    for (let index = low - 1; index >= 0; index -= 1) {
        const layout = layouts[index]!;
        if (layout.top !== rowTop) {
            rowTop = layout.top;
            rowsLeft -= 1;
            if (rowsLeft < 0) break;
        }
        const distance = distanceToPage(layout, y);
        if (distance <= nearestDistance) {
            nearestDistance = distance;
            nearest = index;
        }
    }
    return nearest;
}

export function captureDocumentZoomAnchor(
    container: TDocumentZoomViewport,
    layouts: readonly IDocumentZoomPageLayout[],
    viewportPoint?: IDocumentZoomViewportPoint,
    preferredPageIndex?: number | null,
): IDocumentZoomAnchor | null {
    if (layouts.length === 0) {
        return null;
    }
    const pointX = Math.max(0, Math.min(container.clientWidth, viewportPoint?.x ?? container.clientWidth / 2));
    const pointY = Math.max(0, Math.min(container.clientHeight, viewportPoint?.y ?? container.clientHeight / 2));
    const viewportX = container.scrollLeft + pointX;
    const viewportY = container.scrollTop + pointY;
    const normalizedPreferredPageIndex = preferredPageIndex !== null
        && preferredPageIndex !== undefined
        && Number.isInteger(preferredPageIndex)
        && preferredPageIndex >= 0
        && preferredPageIndex < layouts.length
        ? preferredPageIndex
        : null;
    const pageIndex = normalizedPreferredPageIndex ?? findNearestPageIndex(layouts, viewportY);
    const layout = layouts[pageIndex];
    if (!layout) {
        return null;
    }
    const left = resolveLayoutLeft(container, layout);
    return {
        pageIndex,
        ...(viewportPoint ? {
            viewportX: pointX,
            viewportY: pointY,
        } : {}),
        viewportXRatio: pointX / Math.max(1, container.clientWidth),
        viewportYRatio: pointY / Math.max(1, container.clientHeight),
        xRatio: (viewportX - left) / Math.max(1, layout.width),
        yRatio: (viewportY - layout.top) / Math.max(1, layout.height),
        ...(container.offsetWidth === undefined || container.offsetHeight === undefined ? {} : {viewportBox: {
            clientHeight: container.clientHeight,
            clientWidth: container.clientWidth,
            offsetHeight: container.offsetHeight,
            offsetWidth: container.offsetWidth,
        }}),
    };
}

export function resolveDocumentZoomAnchorScroll(
    container: TDocumentZoomViewport,
    layouts: readonly IDocumentZoomPageLayout[],
    anchor: IDocumentZoomAnchor | null,
) {
    if (!anchor) {
        return null;
    }
    const layout = layouts[anchor.pageIndex];
    if (!layout) {
        return null;
    }
    const left = resolveLayoutLeft(container, layout);
    // A scrollbar that comes or goes changes the client box but not the outer
    // one, and moves nothing on screen: the anchor's point stays where it was
    // taken. A resize changes the outer box, and the point takes its place in
    // the new client box.
    const box = anchor.viewportBox
        && anchor.viewportBox.offsetWidth === container.offsetWidth
        && anchor.viewportBox.offsetHeight === container.offsetHeight
        ? anchor.viewportBox
        : container;
    const viewportX = anchor.viewportX === undefined
        ? box.clientWidth * (anchor.viewportXRatio ?? 0.5)
        : Math.min(container.clientWidth, Math.max(0, anchor.viewportX));
    const viewportY = anchor.viewportY === undefined
        ? box.clientHeight * (anchor.viewportYRatio ?? 0.5)
        : Math.min(container.clientHeight, Math.max(0, anchor.viewportY));
    return {
        left: Math.max(0, left + layout.width * anchor.xRatio - viewportX),
        top: Math.max(0, layout.top + layout.height * anchor.yRatio - viewportY),
    };
}

export function resolveRetainedDocumentZoomAnchor(
    container: TDocumentZoomViewport & Pick<HTMLElement, 'scrollHeight' | 'scrollWidth'>,
    layouts: readonly IDocumentZoomPageLayout[],
    retainedAnchor: IDocumentZoomAnchor | null,
    tolerance = 1,
    preferredPageIndex?: number | null,
) {
    if (retainedAnchor) {
        const projected = resolveDocumentZoomAnchorScroll(container, layouts, retainedAnchor);
        if (projected) {
            const projectedLeft = Math.min(
                projected.left,
                Math.max(0, container.scrollWidth - container.clientWidth),
            );
            const projectedTop = Math.min(
                projected.top,
                Math.max(0, container.scrollHeight - container.clientHeight),
            );
            if (
                Math.abs(projectedLeft - container.scrollLeft) <= tolerance
                && Math.abs(projectedTop - container.scrollTop) <= tolerance
            ) {
                return retainedAnchor;
            }
        }
    }
    return captureDocumentZoomAnchor(container, layouts, undefined, preferredPageIndex);
}
