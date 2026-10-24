import type { IClientRect } from '@app/modules/document-viewer/public';
import {
    getRectHeight, getRectWidth, intersectClientRects, toClientRect,
} from '@app/modules/document-viewer/public';
import { buildCanvasCapturePlan } from '@app/modules/pdf-viewer/engine/pdf-region-capture/buildCanvasCapturePlan';
import type {
    ICapturePlan, IPdfRegionPaintCapture,
} from '@app/modules/pdf-viewer/engine/pdf-region-capture/pdfRegionCaptureTypes';
import {
    assertCaptureImageBudget, CAPTURE_MAX_BYTES, readCapturePngSize,
} from '@contracts/imageExportPlatformFeature';

/** Freeze the visible initiating pane and its page mask before any asynchronous read. */
export function freezePdfRegionCapture(viewerContainer: HTMLElement, selection: IClientRect): ICapturePlan {
    let clipped = intersectClientRects(selection, {
        left: 0,
        top: 0,
        right: window.innerWidth,
        bottom: window.innerHeight,
    });
    for (let element: HTMLElement | null = viewerContainer; clipped && element; element = element.parentElement) {
        const style = getComputedStyle(element);
        const box = element.getBoundingClientRect();
        const clipX = element === viewerContainer || style.overflowX !== 'visible';
        const clipY = element === viewerContainer || style.overflowY !== 'visible';
        clipped = intersectClientRects(clipped, {
            left: clipX ? box.left + element.clientLeft : clipped.left,
            right: clipX ? box.left + element.clientLeft + element.clientWidth : clipped.right,
            top: clipY ? box.top + element.clientTop : clipped.top,
            bottom: clipY ? box.top + element.clientTop + element.clientHeight : clipped.bottom,
        });
    }
    if (!clipped) return {
        outputRect: null,
        fragments: [],
    };
    const sources = [...viewerContainer.querySelectorAll<HTMLCanvasElement>('.page_container--rendered .page_canvas__render-layer > canvas')]
        .map(canvas => ({
            canvas,
            rect: toClientRect(canvas.getBoundingClientRect()),
        }));
    const plan = buildCanvasCapturePlan(clipped, sources);
    if (plan.outputRect) {
        plan.outputRect = {
            left: Math.max(Math.ceil(clipped.left), Math.floor(plan.outputRect.left)),
            top: Math.max(Math.ceil(clipped.top), Math.floor(plan.outputRect.top)),
            right: Math.min(Math.floor(clipped.right), Math.ceil(plan.outputRect.right)),
            bottom: Math.min(Math.floor(clipped.bottom), Math.ceil(plan.outputRect.bottom)),
        };
        assertCaptureImageBudget(Math.ceil(getRectWidth(plan.outputRect) * window.devicePixelRatio), Math.ceil(getRectHeight(plan.outputRect) * window.devicePixelRatio));
    }
    return plan;
}

/** One composed frame supplies every fragment. A missing reader never falls back to PDF canvases. */
export async function capturePdfRegionAsPngBlob(request: IPdfRegionPaintCapture) {
    const {
        plan, assertCurrent,
    } = request;
    const outputRect = plan.outputRect;
    if (!outputRect || !plan.fragments.length) return null;
    assertCurrent();
    const bytes = await request.read();
    assertCurrent();
    if (!bytes) return null;
    const size = readCapturePngSize(bytes);
    const scaleX = size.width / getRectWidth(outputRect);
    const scaleY = size.height / getRectHeight(outputRect);
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], {type: 'image/png'}));
    const canvas = document.createElement('canvas');
    try {
        assertCurrent();
        assertCaptureImageBudget(bitmap.width, bitmap.height);
        if (bitmap.width !== size.width || bitmap.height !== size.height) throw new Error('Capture dimensions changed during decoding');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Capture canvas is unavailable');
        for (const fragment of plan.fragments) {
            const rect = intersectClientRects(fragment.intersection, outputRect);
            if (!rect) continue;
            const x = Math.round((rect.left - outputRect.left) * scaleX);
            const y = Math.round((rect.top - outputRect.top) * scaleY);
            const width = Math.round((rect.right - outputRect.left) * scaleX) - x;
            const height = Math.round((rect.bottom - outputRect.top) * scaleY) - y;
            context.drawImage(bitmap, x, y, width, height, x, y, width, height);
        }
        assertCurrent();
        const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('Capture PNG encoding failed')), 'image/png'));
        assertCurrent();
        if (blob.size > CAPTURE_MAX_BYTES) throw new RangeError('Capture exceeds the encoded byte limit');
        return {
            blob,
            outputRect,
        };
    } finally {
        bitmap.close();
        canvas.width = 0;
        canvas.height = 0;
    }
}
