import type { IAnnotationMarkerRect } from '@app/types/annotations';

export function clamp01(value: number) {
    if (!Number.isFinite(value)) {
        return 0;
    }
    return Math.max(0, Math.min(1, value));
}

export function normalizeMarkerRect(rect: IAnnotationMarkerRect | null | undefined): IAnnotationMarkerRect | null {
    if (!rect) {
        return null;
    }
    const left = Number.isFinite(rect.left) ? rect.left : 0;
    const top = Number.isFinite(rect.top) ? rect.top : 0;
    const width = Number.isFinite(rect.width) ? rect.width : 0;
    const height = Number.isFinite(rect.height) ? rect.height : 0;
    if (width <= 0 || height <= 0) {
        return null;
    }

    const clampedLeft = Math.min(1, Math.max(0, left));
    const clampedTop = Math.min(1, Math.max(0, top));
    const maxWidth = 1 - clampedLeft;
    const maxHeight = 1 - clampedTop;
    const clampedWidth = Math.min(maxWidth, Math.max(0, width));
    const clampedHeight = Math.min(maxHeight, Math.max(0, height));
    if (clampedWidth <= 0 || clampedHeight <= 0) {
        return null;
    }

    return {
        left: clampedLeft,
        top: clampedTop,
        width: clampedWidth,
        height: clampedHeight,
    };
}

export function toMarkerRectFromPdfRect(
    rect: number[] | null | undefined,
    pageView: number[] | null | undefined,
): IAnnotationMarkerRect | null {
    if (!rect || rect.length < 4 || !pageView || pageView.length < 4) {
        return null;
    }

    const x1 = rect[0] ?? 0;
    const y1 = rect[1] ?? 0;
    const x2 = rect[2] ?? 0;
    const y2 = rect[3] ?? 0;
    const minX = Math.min(x1, x2);
    const maxX = Math.max(x1, x2);
    const minY = Math.min(y1, y2);
    const maxY = Math.max(y1, y2);

    const xMin = pageView[0] ?? 0;
    const yMin = pageView[1] ?? 0;
    const xMax = pageView[2] ?? 0;
    const yMax = pageView[3] ?? 0;
    const pageWidth = xMax - xMin;
    const pageHeight = yMax - yMin;
    if (!Number.isFinite(pageWidth) || !Number.isFinite(pageHeight) || pageWidth <= 0 || pageHeight <= 0) {
        return null;
    }

    return normalizeMarkerRect({
        left: (minX - xMin) / pageWidth,
        top: (yMax - maxY) / pageHeight,
        width: (maxX - minX) / pageWidth,
        height: (maxY - minY) / pageHeight,
    });
}

export function markerRectIoU(
    leftRect: IAnnotationMarkerRect | null | undefined,
    rightRect: IAnnotationMarkerRect | null | undefined,
) {
    const left = normalizeMarkerRect(leftRect);
    const right = normalizeMarkerRect(rightRect);
    if (!left || !right) {
        return 0;
    }

    const intersectionLeft = Math.max(left.left, right.left);
    const intersectionTop = Math.max(left.top, right.top);
    const intersectionRight = Math.min(left.left + left.width, right.left + right.width);
    const intersectionBottom = Math.min(left.top + left.height, right.top + right.height);
    const intersectionWidth = Math.max(0, intersectionRight - intersectionLeft);
    const intersectionHeight = Math.max(0, intersectionBottom - intersectionTop);
    const intersectionArea = intersectionWidth * intersectionHeight;
    if (intersectionArea <= 0) {
        return 0;
    }

    const leftArea = left.width * left.height;
    const rightArea = right.width * right.height;
    const unionArea = leftArea + rightArea - intersectionArea;
    if (unionArea <= 0) {
        return 0;
    }

    return intersectionArea / unionArea;
}

export function rectIntersectionArea(left: DOMRect, right: DOMRect) {
    const x1 = Math.max(left.left, right.left);
    const y1 = Math.max(left.top, right.top);
    const x2 = Math.min(left.right, right.right);
    const y2 = Math.min(left.bottom, right.bottom);
    const width = Math.max(0, x2 - x1);
    const height = Math.max(0, y2 - y1);
    return width * height;
}

export function rectIoU(left: DOMRect, right: DOMRect) {
    const intersection = rectIntersectionArea(left, right);
    if (intersection <= 0) {
        return 0;
    }
    const leftArea = left.width * left.height;
    const rightArea = right.width * right.height;
    const union = leftArea + rightArea - intersection;
    if (union <= 0) {
        return 0;
    }
    return intersection / union;
}

export function rectCenterDistance(left: DOMRect, right: DOMRect) {
    const leftX = left.left + left.width / 2;
    const leftY = left.top + left.height / 2;
    const rightX = right.left + right.width / 2;
    const rightY = right.top + right.height / 2;
    return Math.hypot(leftX - rightX, leftY - rightY);
}

export function rectsIntersect(
    leftRect: {
        left: number;
        top: number;
        right: number;
        bottom: number;
    },
    rightRect: {
        left: number;
        top: number;
        right: number;
        bottom: number;
    },
) {
    return !(
        leftRect.right < rightRect.left
        || leftRect.left > rightRect.right
        || leftRect.bottom < rightRect.top
        || leftRect.top > rightRect.bottom
    );
}

export function mergeMarkerRects(left: IAnnotationMarkerRect, right: IAnnotationMarkerRect): IAnnotationMarkerRect {
    const minLeft = Math.min(left.left, right.left);
    const minTop = Math.min(left.top, right.top);
    const maxRight = Math.max(left.left + left.width, right.left + right.width);
    const maxBottom = Math.max(left.top + left.height, right.top + right.height);
    return {
        left: minLeft,
        top: minTop,
        width: Math.max(0.0001, maxRight - minLeft),
        height: Math.max(0.0001, maxBottom - minTop),
    };
}
