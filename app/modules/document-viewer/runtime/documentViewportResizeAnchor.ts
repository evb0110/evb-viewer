const DOCUMENT_PAGE_ANCHOR_SELECTOR = '[data-document-page-number]';

export interface IDocumentViewportResizeAnchor {
    readonly element: HTMLElement;
    readonly pageNumber: number;
    readonly pageRatioX: number;
    readonly pageRatioY: number;
    readonly viewportRatioX: number;
    readonly viewportRatioY: number;
}

export interface IDocumentViewportAnchorPosition {
    readonly left: number;
    readonly top: number;
}

export interface IDocumentViewportResizeAnchorOptions {readonly preferredPageNumber?: number | null;}

function clampRatio(value: number) {
    return Math.max(0, Math.min(1, value));
}

function readPageNumber(element: HTMLElement) {
    const pageNumber = Number.parseInt(element.dataset.documentPageNumber ?? '', 10);
    return Number.isFinite(pageNumber) && pageNumber > 0 ? pageNumber : null;
}

function distanceFromPoint(rect: DOMRect, x: number, y: number) {
    const horizontal = x < rect.left ? rect.left - x : x > rect.right ? x - rect.right : 0;
    const vertical = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0;
    return Math.hypot(horizontal, vertical);
}

/**
 * Captures a semantic point inside the page nearest the viewport centre.
 * The element is retained so renderer-specific layout work cannot silently
 * substitute a different page while a workspace transition is in progress.
 */
export function captureDocumentViewportResizeAnchor(
    viewport: HTMLElement,
    options?: IDocumentViewportResizeAnchorOptions,
): IDocumentViewportResizeAnchor | null {
    const viewportRect = viewport.getBoundingClientRect();
    if (viewportRect.width <= 0 || viewportRect.height <= 0) {
        return null;
    }
    const viewportRatioX = 0.5;
    const viewportRatioY = 0.5;
    const anchorX = viewportRect.left + (viewportRect.width * viewportRatioX);
    const anchorY = viewportRect.top + (viewportRect.height * viewportRatioY);
    const candidates = Array.from(
        viewport.querySelectorAll<HTMLElement>(DOCUMENT_PAGE_ANCHOR_SELECTOR),
    ).flatMap((element) => {
        const pageNumber = readPageNumber(element);
        const rect = element.getBoundingClientRect();
        return pageNumber !== null && rect.width > 0 && rect.height > 0
            ? [{
                element,
                pageNumber,
                rect,
            }]
            : [];
    });
    const preferredPageNumber = options?.preferredPageNumber;
    const preferred = typeof preferredPageNumber === 'number'
        ? candidates.find(candidate => candidate.pageNumber === preferredPageNumber)
        : undefined;
    const candidate = preferred ?? candidates.reduce<(typeof candidates)[number] | null>((nearest, current) => (
        nearest === null
        || distanceFromPoint(current.rect, anchorX, anchorY)
            < distanceFromPoint(nearest.rect, anchorX, anchorY)
            ? current
            : nearest
    ), null);
    if (!candidate) {
        return null;
    }
    return Object.freeze({
        element: candidate.element,
        pageNumber: candidate.pageNumber,
        pageRatioX: clampRatio((anchorX - candidate.rect.left) / candidate.rect.width),
        pageRatioY: clampRatio((anchorY - candidate.rect.top) / candidate.rect.height),
        viewportRatioX,
        viewportRatioY,
    });
}

/** Resolves the scroll coordinates that keep a captured semantic point fixed. */
export function resolveDocumentViewportResizeAnchorPosition(
    viewport: HTMLElement,
    anchor: IDocumentViewportResizeAnchor,
): IDocumentViewportAnchorPosition | null {
    if (!anchor.element.isConnected || !viewport.contains(anchor.element)) {
        return null;
    }
    const viewportRect = viewport.getBoundingClientRect();
    const pageRect = anchor.element.getBoundingClientRect();
    if (
        viewportRect.width <= 0
        || viewportRect.height <= 0
        || pageRect.width <= 0
        || pageRect.height <= 0
    ) {
        return null;
    }
    return {
        left: viewport.scrollLeft
            + pageRect.left
            + (pageRect.width * anchor.pageRatioX)
            - viewportRect.left
            - (viewportRect.width * anchor.viewportRatioX),
        top: viewport.scrollTop
            + pageRect.top
            + (pageRect.height * anchor.pageRatioY)
            - viewportRect.top
            - (viewportRect.height * anchor.viewportRatioY),
    };
}
