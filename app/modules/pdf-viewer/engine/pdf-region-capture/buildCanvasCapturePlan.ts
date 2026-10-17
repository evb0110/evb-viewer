import type { IClientRect } from '@app/modules/document-viewer/public';
import {
    intersectClientRects, unionClientRects,
} from '@app/modules/document-viewer/public';
import type {
    ICanvasSource,
    ICaptureFragment,
    ICapturePlan,
} from '@app/modules/pdf-viewer/engine/pdf-region-capture/pdfRegionCaptureTypes';

/** An intersection has a positive CSS size, so a fragment needs only a canvas with pixels. */
export function buildCanvasCapturePlan(selectionRect: IClientRect, sources: readonly ICanvasSource[]): ICapturePlan {
    let outputRect: IClientRect | null = null;
    const fragments: ICaptureFragment[] = [];

    for (const source of sources) {
        const intersection = intersectClientRects(selectionRect, source.rect);
        if (!intersection || source.canvas.width <= 0 || source.canvas.height <= 0) {
            continue;
        }

        fragments.push({
            canvas: source.canvas,
            intersection,
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
