import type { IAnnotationMarkerRect } from '@app/types/annotations';
import { toMarkerPointFromPdfPoint } from '@app/modules/pdf-viewer/engine/annotation-geometry/toMarkerPointFromPdfPoint';
import { toPdfPointFromMarkerPoint } from '@app/modules/pdf-viewer/engine/annotation-geometry/toPdfPointFromMarkerPoint';
import type { TPageRotation } from '@app/modules/pdf-viewer/engine/annotation-geometry/pageRotation';

export function nudgeMarkerRectByPdfPoints(
    rect: IAnnotationMarkerRect,
    deltaX: number,
    deltaY: number,
    pageView: number[],
    pageRotation: TPageRotation = 0,
): IAnnotationMarkerRect {
    const corners = [
        {
            x: rect.left,
            y: rect.top,
        },
        {
            x: rect.left + rect.width,
            y: rect.top,
        },
        {
            x: rect.left,
            y: rect.top + rect.height,
        },
        {
            x: rect.left + rect.width,
            y: rect.top + rect.height,
        },
    ];
    const moved = corners.map((corner) => {
        const pdf = toPdfPointFromMarkerPoint(corner.x, corner.y, pageView, pageRotation);
        if (!pdf) {
            return corner;
        }
        return toMarkerPointFromPdfPoint(pdf.x + deltaX, pdf.y + deltaY, pageView, pageRotation) ?? corner;
    });
    const left = Math.min(...moved.map(point => point.x));
    const top = Math.min(...moved.map(point => point.y));
    const right = Math.max(...moved.map(point => point.x));
    const bottom = Math.max(...moved.map(point => point.y));
    return {
        left,
        top,
        width: right - left,
        height: bottom - top,
    };
}
