import type { IAnnotationMarkerRect } from '@app/types/annotations';
import type { TPageRotation } from '@app/modules/pdf-viewer/engine/annotation-geometry/pageRotation';
import { normalizeMarkerRect } from '@app/modules/pdf-viewer/engine/annotation-geometry/normalizeMarkerRect';
import { toPdfPointFromMarkerPoint } from '@app/modules/pdf-viewer/engine/annotation-geometry/toPdfPointFromMarkerPoint';

export function toPdfRectFromMarkerRect(
    markerRect: IAnnotationMarkerRect | null | undefined,
    pageView: number[] | null | undefined,
    pageRotation: TPageRotation = 0,
    options: {preserveUnrotatedBounds?: boolean} = {},
): [number, number, number, number] | null {
    // Rotated text/image rectangles describe unrotated dimensions. Their
    // unrotated bounds can cross a page edge while all visible corners fit.
    // Native admission validates the transformed rectangle before writing.
    const normalized = options.preserveUnrotatedBounds
        ? markerRect && [
            markerRect.left,
            markerRect.top,
            markerRect.width,
            markerRect.height,
        ].every(Number.isFinite)
            && markerRect.width > 0 && markerRect.height > 0 ? markerRect : null
        : normalizeMarkerRect(markerRect);
    if (!normalized) {
        return null;
    }

    const markerRight = normalized.left + normalized.width;
    const markerBottom = normalized.top + normalized.height;

    const cornerPoints = [];
    for (const [
        x,
        y,
    ] of [
            [
                normalized.left,
                normalized.top,
            ],
            [
                markerRight,
                normalized.top,
            ],
            [
                normalized.left,
                markerBottom,
            ],
            [
                markerRight,
                markerBottom,
            ],
        ] as const) {
        const point = toPdfPointFromMarkerPoint(x, y, pageView, pageRotation);
        if (!point) {
            return null;
        }
        cornerPoints.push(point);
    }

    const minX = Math.min(...cornerPoints.map(point => point.x));
    const minY = Math.min(...cornerPoints.map(point => point.y));
    const maxX = Math.max(...cornerPoints.map(point => point.x));
    const maxY = Math.max(...cornerPoints.map(point => point.y));

    return [
        minX,
        minY,
        maxX,
        maxY,
    ];
}
