import { clamp } from 'es-toolkit/math';
import type { IClientRect } from '@app/modules/document-viewer/public';
import {
    getRectHeight, getRectWidth , intersectClientRects , unionClientRects,  
} from '@app/modules/document-viewer/public';
import type {
    ICanvasSource,
    ICaptureFragment,
    ICapturePlan,
} from '@app/modules/pdf-viewer/engine/pdf-region-capture/pdfRegionCaptureTypes';

export function buildCanvasCapturePlan(selectionRect: IClientRect, sources: readonly ICanvasSource[]): ICapturePlan {
    let outputRect: IClientRect | null = null;
    const fragments: ICaptureFragment[] = [];

    for (const source of sources) {
        const intersection = intersectClientRects(selectionRect, source.rect);
        if (!intersection) {
            continue;
        }

        const canvasCssWidth = getRectWidth(source.rect);
        const canvasCssHeight = getRectHeight(source.rect);
        if (canvasCssWidth <= 0 || canvasCssHeight <= 0) {
            continue;
        }

        const scaleX = source.canvas.width / canvasCssWidth;
        const scaleY = source.canvas.height / canvasCssHeight;
        if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY) || scaleX <= 0 || scaleY <= 0) {
            continue;
        }

        const sourceX = clamp((intersection.left - source.rect.left) * scaleX, 0, source.canvas.width);
        const sourceY = clamp((intersection.top - source.rect.top) * scaleY, 0, source.canvas.height);
        const sourceWidth = clamp(getRectWidth(intersection) * scaleX, 0, source.canvas.width - sourceX);
        const sourceHeight = clamp(getRectHeight(intersection) * scaleY, 0, source.canvas.height - sourceY);
        if (sourceWidth <= 0 || sourceHeight <= 0) {
            continue;
        }

        fragments.push({
            canvas: source.canvas,
            intersection,
            sourceX,
            sourceY,
            sourceWidth,
            sourceHeight,
            scaleX,
            scaleY,
        });
        outputRect = outputRect
            ? unionClientRects(outputRect, intersection)
            : intersection;
    }

    return {
        outputRect,
        fragments,
    };
}
