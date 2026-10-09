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
    let pageIndex = normalizedPreferredPageIndex ?? 0;
    if (normalizedPreferredPageIndex === null) {
        let nearestDistance = Number.POSITIVE_INFINITY;
        layouts.forEach((layout, index) => {
            const bottom = layout.top + layout.height;
            const distance = viewportY < layout.top
                ? layout.top - viewportY
                : viewportY > bottom ? viewportY - bottom : 0;
            if (distance < nearestDistance) {
                nearestDistance = distance;
                pageIndex = index;
            }
        });
    }
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
