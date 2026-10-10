const DOCUMENT_PAGE_ANCHOR_SELECTOR = '[data-document-page-number]';

export interface IDocumentViewportResizeAnchor {
    readonly pageNumber: number;
    readonly pageRatioX: number;
    readonly pageRatioY: number;
    readonly viewportRatioX: number;
    readonly viewportRatioY: number;
}

export interface IDocumentViewportResizeAnchorOptions {readonly viewportPoint?: {
    x: number;
    y: number
};}

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

/** Captures a semantic point inside the page nearest the supplied point or viewport centre. */
export function captureDocumentViewportResizeAnchor(
    viewport: HTMLElement,
    options?: IDocumentViewportResizeAnchorOptions,
): IDocumentViewportResizeAnchor | null {
    const viewportRect = viewport.getBoundingClientRect();
    if (viewport.clientWidth <= 0 || viewport.clientHeight <= 0) {
        return null;
    }
    const viewportRatioX = clampRatio((options?.viewportPoint?.x ?? viewport.clientWidth / 2) / viewport.clientWidth);
    const viewportRatioY = clampRatio((options?.viewportPoint?.y ?? viewport.clientHeight / 2) / viewport.clientHeight);
    const anchorX = viewportRect.left + viewport.clientLeft + (viewport.clientWidth * viewportRatioX);
    const anchorY = viewportRect.top + viewport.clientTop + (viewport.clientHeight * viewportRatioY);
    const candidates = Array.from(
        viewport.querySelectorAll<HTMLElement>(DOCUMENT_PAGE_ANCHOR_SELECTOR),
    ).flatMap((element) => {
        const pageNumber = readPageNumber(element);
        const rect = element.getBoundingClientRect();
        return pageNumber !== null && rect.width > 0 && rect.height > 0
            ? [{
                pageNumber,
                rect,
            }]
            : [];
    });
    const candidate = candidates.reduce<(typeof candidates)[number] | null>((nearest, current) => (
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
        pageNumber: candidate.pageNumber,
        pageRatioX: clampRatio((anchorX - candidate.rect.left) / candidate.rect.width),
        pageRatioY: clampRatio((anchorY - candidate.rect.top) / candidate.rect.height),
        viewportRatioX,
        viewportRatioY,
    });
}
