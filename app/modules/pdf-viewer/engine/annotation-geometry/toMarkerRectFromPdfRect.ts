import { getPageRectBounds } from '@app/modules/pdf-viewer/engine/annotation-geometry/getPageRectBounds';
import type { IAnnotationMarkerRect } from '@app/types/annotations';
import {
    normalizeMarkerRectBounds,
    orderPdfRectBounds,
} from '@app/utils/pdfMarkerRect';
import type { TPageRotation } from '@app/modules/pdf-viewer/engine/annotation-geometry/pageRotation';
import { toMarkerPointInPageBounds } from '@app/modules/pdf-viewer/engine/annotation-geometry/toMarkerPointFromPdfPoint';
import { normalizePageRotation } from '@app/modules/pdf-viewer/engine/annotation-geometry/normalizePageRotation';

export const MIN_MARKER_RECT_SIZE = 0.0016;

export function toMarkerRectFromPdfRect(
    rect: number[] | null | undefined,
    pageView: number[] | null | undefined,
    pageRotation: TPageRotation = 0,
): IAnnotationMarkerRect | null {
    const bounds = getPageRectBounds(pageView);
    if (!rect || rect.length < 4 || !bounds) {
        return null;
    }

    const x1 = rect[0] ?? 0;
    const y1 = rect[1] ?? 0;
    const x2 = rect[2] ?? 0;
    const y2 = rect[3] ?? 0;
    const {
        minX,
        maxX,
        minY,
        maxY,
    } = orderPdfRectBounds(x1, y1, x2, y2);

    const normalizedRotation = normalizePageRotation(pageRotation);

    const cornerPoints = [
        toMarkerPointInPageBounds(minX, minY, bounds, normalizedRotation),
        toMarkerPointInPageBounds(minX, maxY, bounds, normalizedRotation),
        toMarkerPointInPageBounds(maxX, minY, bounds, normalizedRotation),
        toMarkerPointInPageBounds(maxX, maxY, bounds, normalizedRotation),
    ];

    const markerLeft = Math.min(...cornerPoints.map(point => point.x));
    const markerTop = Math.min(...cornerPoints.map(point => point.y));
    const markerRight = Math.max(...cornerPoints.map(point => point.x));
    const markerBottom = Math.max(...cornerPoints.map(point => point.y));

    let normLeft = markerLeft;
    let normTop = markerTop;
    let normWidth = markerRight - markerLeft;
    let normHeight = markerBottom - markerTop;

    // Degenerate (zero-area) rects occur when a FreeText annotation is serialized
    // with minimal content (e.g. ZWS placeholder for sticky-note style comments).
    // Expand to a minimum point-marker size centered on the annotation position so
    // the annotation still produces a valid markerRect for the overlay system.
    if (normWidth < MIN_MARKER_RECT_SIZE) {
        const centerX = normLeft + normWidth / 2;
        normLeft = centerX - MIN_MARKER_RECT_SIZE / 2;
        normWidth = MIN_MARKER_RECT_SIZE;
    }
    if (normHeight < MIN_MARKER_RECT_SIZE) {
        const centerY = normTop + normHeight / 2;
        normTop = centerY - MIN_MARKER_RECT_SIZE / 2;
        normHeight = MIN_MARKER_RECT_SIZE;
    }

    return normalizeMarkerRectBounds({
        left: normLeft,
        top: normTop,
        right: normLeft + normWidth,
        bottom: normTop + normHeight,
    }, { clampSizeToRemaining: true });
}
