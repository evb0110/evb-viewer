import type {
    ICropMargins,
    IPdfBox,
    TCropUnit,
} from '@app/types/crop';
import { clamp } from 'es-toolkit/math';

export const PDF_POINTS_PER_INCH = 72;
const PDF_POINTS_PER_MM = 72 / 25.4;

export function pointsToUnit(raw: number, unit: TCropUnit, userUnit = 1) {
    const pts = raw * userUnit;
    switch (unit) {
        case 'pt': return pts;
        case 'mm': return pts / PDF_POINTS_PER_MM;
        case 'in': return pts / PDF_POINTS_PER_INCH;
    }
}

export function unitToPoints(value: number, unit: TCropUnit, userUnit = 1) {
    switch (unit) {
        case 'pt': return value / userUnit;
        case 'mm': return value * PDF_POINTS_PER_MM / userUnit;
        case 'in': return value * PDF_POINTS_PER_INCH / userUnit;
    }
}

export function unitStep(unit: TCropUnit) {
    switch (unit) {
        case 'pt': return 1;
        case 'mm': return 1;
        case 'in': return 0.01;
    }
}

function clamp01(value: number) {
    return clamp(value, 0, 1);
}

export function normalizeCropRotation(rotation: number): 0 | 90 | 180 | 270 {
    const mod = ((rotation % 360) + 360) % 360;
    if (mod === 90 || mod === 180 || mod === 270) {
        return mod;
    }
    return 0;
}

/**
 * Maps a normalized screen position (0,0 = top-left, 1,1 = bottom-right)
 * to unrotated PDF coordinates within the given box, accounting for page rotation.
 *
 * When a page is rotated for display:
 * - 0°:   screen X → PDF X,  screen Y → PDF Y (inverted)
 * - 90°:  screen X → PDF Y,  screen Y → PDF X
 * - 180°: screen X → PDF X (inverted), screen Y → PDF Y
 * - 270°: screen X → PDF Y (inverted), screen Y → PDF X (inverted)
 */
function screenToPdfCoord(
    normX: number,
    normY: number,
    box: IPdfBox,
    rotation: 0 | 90 | 180 | 270,
): {
    x: number;
    y: number;
} {
    switch (rotation) {
        case 0:
            return {
                x: box.x + normX * box.width,
                y: box.y + (1 - normY) * box.height,
            };
        case 90:
            return {
                x: box.x + normY * box.width,
                y: box.y + normX * box.height,
            };
        case 180:
            return {
                x: box.x + (1 - normX) * box.width,
                y: box.y + normY * box.height,
            };
        case 270:
            return {
                x: box.x + (1 - normY) * box.width,
                y: box.y + (1 - normX) * box.height,
            };
    }
}

export function screenRectToMargins(
    selectionRect: {
        x: number;
        y: number;
        width: number;
        height: number;
    },
    pageContainerRect: {
        left: number;
        top: number;
        width: number;
        height: number;
    },
    effectiveBox: IPdfBox,
    mediaBox: IPdfBox,
    rotation: number,
): ICropMargins {
    if (pageContainerRect.width <= 0 || pageContainerRect.height <= 0) {
        return {
            top: 0,
            bottom: 0,
            left: 0,
            right: 0,
        };
    }

    const selectionLeft = selectionRect.x;
    const selectionTop = selectionRect.y;
    const selectionRight = selectionRect.x + selectionRect.width;
    const selectionBottom = selectionRect.y + selectionRect.height;

    // selectionRect and pageContainerRect only need a shared display-space origin.
    // Callers may pass either absolute screen-space values or page-local coordinates.
    const normLeft = clamp01((selectionLeft - pageContainerRect.left) / pageContainerRect.width);
    const normTop = clamp01((selectionTop - pageContainerRect.top) / pageContainerRect.height);
    const normRight = clamp01((selectionRight - pageContainerRect.left) / pageContainerRect.width);
    const normBottom = clamp01((selectionBottom - pageContainerRect.top) / pageContainerRect.height);

    const rot = normalizeCropRotation(rotation);

    const corner1 = screenToPdfCoord(normLeft, normTop, effectiveBox, rot);
    const corner2 = screenToPdfCoord(normRight, normBottom, effectiveBox, rot);

    const pdfLeft = Math.min(corner1.x, corner2.x);
    const pdfRight = Math.max(corner1.x, corner2.x);
    const pdfBottom = Math.min(corner1.y, corner2.y);
    const pdfTop = Math.max(corner1.y, corner2.y);

    return {
        left: Math.max(0, pdfLeft - mediaBox.x),
        right: Math.max(0, (mediaBox.x + mediaBox.width) - pdfRight),
        top: Math.max(0, (mediaBox.y + mediaBox.height) - pdfTop),
        bottom: Math.max(0, pdfBottom - mediaBox.y),
    };
}

export function boxToNormalizedRect(
    box: IPdfBox,
    mediaBox: IPdfBox,
): {
    x: number;
    y: number;
    width: number;
    height: number;
} {
    const totalWidth = mediaBox.width;
    const totalHeight = mediaBox.height;
    if (totalWidth <= 0 || totalHeight <= 0) {
        return {
            x: 0,
            y: 0,
            width: 1,
            height: 1,
        };
    }

    const mediaTop = mediaBox.y + mediaBox.height;
    const boxRight = box.x + box.width;
    const boxTop = box.y + box.height;

    const normLeft = clamp01((box.x - mediaBox.x) / totalWidth);
    const normRight = clamp01((boxRight - mediaBox.x) / totalWidth);
    const normTop = clamp01((mediaTop - boxTop) / totalHeight);
    const normBottom = clamp01((mediaTop - box.y) / totalHeight);

    return {
        x: normLeft,
        y: normTop,
        width: Math.max(0, normRight - normLeft),
        height: Math.max(0, normBottom - normTop),
    };
}

function toDisplayNormalizedPoint(
    x: number,
    y: number,
    mediaBox: IPdfBox,
    rotation: 0 | 90 | 180 | 270,
) {
    const normX = clamp01((x - mediaBox.x) / Math.max(mediaBox.width, 1));
    const normY = clamp01((y - mediaBox.y) / Math.max(mediaBox.height, 1));

    switch (rotation) {
        case 90:
            return {
                x: normY,
                y: normX,
            };
        case 180:
            return {
                x: 1 - normX,
                y: normY,
            };
        case 270:
            return {
                x: 1 - normY,
                y: 1 - normX,
            };
        case 0:
            return {
                x: normX,
                y: 1 - normY,
            };
    }
}

export function boxToDisplayNormalizedRect(
    box: IPdfBox,
    mediaBox: IPdfBox,
    rotation: number,
) {
    const pageWidth = mediaBox.width;
    const pageHeight = mediaBox.height;
    if (pageWidth <= 0 || pageHeight <= 0) {
        return {
            x: 0,
            y: 0,
            width: 1,
            height: 1,
        };
    }

    const rot = normalizeCropRotation(rotation);
    const corners = [
        toDisplayNormalizedPoint(box.x, box.y, mediaBox, rot),
        toDisplayNormalizedPoint(box.x + box.width, box.y, mediaBox, rot),
        toDisplayNormalizedPoint(box.x, box.y + box.height, mediaBox, rot),
        toDisplayNormalizedPoint(box.x + box.width, box.y + box.height, mediaBox, rot),
    ];

    const left = Math.min(...corners.map(corner => corner.x));
    const top = Math.min(...corners.map(corner => corner.y));
    const right = Math.max(...corners.map(corner => corner.x));
    const bottom = Math.max(...corners.map(corner => corner.y));

    return {
        x: clamp01(left),
        y: clamp01(top),
        width: Math.max(0, clamp01(right) - clamp01(left)),
        height: Math.max(0, clamp01(bottom) - clamp01(top)),
    };
}

function marginsToPdfBox(
    margins: ICropMargins,
    mediaBox: IPdfBox,
): IPdfBox {
    return {
        x: mediaBox.x + margins.left,
        y: mediaBox.y + margins.bottom,
        width: Math.max(0, mediaBox.width - margins.left - margins.right),
        height: Math.max(0, mediaBox.height - margins.top - margins.bottom),
    };
}

export function marginsToNormalizedRect(
    margins: ICropMargins,
    mediaBox: IPdfBox,
): {
    x: number;
    y: number;
    width: number;
    height: number;
} {
    return boxToNormalizedRect(marginsToPdfBox(margins, mediaBox), mediaBox);
}

export function marginsToDisplayNormalizedRect(
    margins: ICropMargins,
    mediaBox: IPdfBox,
    rotation: number,
) {
    return boxToDisplayNormalizedRect(marginsToPdfBox(margins, mediaBox), mediaBox, rotation);
}
