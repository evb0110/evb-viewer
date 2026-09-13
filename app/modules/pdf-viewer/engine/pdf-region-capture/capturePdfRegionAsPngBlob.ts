import type { IClientRect } from '@app/modules/document-viewer/public';
import {
    getRectHeight, getRectWidth , toClientRect,  
} from '@app/modules/document-viewer/public';
import { buildCanvasCapturePlan } from '@app/modules/pdf-viewer/engine/pdf-region-capture/buildCanvasCapturePlan';
import type {
    ICanvasSource,
    ICaptureFragment,
    ICapturePlan,
} from '@app/modules/pdf-viewer/engine/pdf-region-capture/pdfRegionCaptureTypes';

function collectCanvasSources(viewerContainer: HTMLElement): ICanvasSource[] {
    const renderedCanvases = Array.from(
        viewerContainer.querySelectorAll<HTMLCanvasElement>('.page_container--rendered .page_canvas canvas'),
    );
    const fallbackCanvases = renderedCanvases.length > 0
        ? renderedCanvases
        : Array.from(viewerContainer.querySelectorAll<HTMLCanvasElement>('.page_canvas canvas'));

    return fallbackCanvases
        .map((canvas) => {
            const rect = toClientRect(canvas.getBoundingClientRect());
            return {
                canvas,
                rect,
            };
        })
        .filter((source) =>
            source.canvas.width > 0
            && source.canvas.height > 0
            && getRectWidth(source.rect) > 0
            && getRectHeight(source.rect) > 0);
}

function resolveOutputScale(fragments: readonly ICaptureFragment[]) {
    if (fragments.length === 0) {
        return 1;
    }

    return Math.max(
        1,
        ...fragments.map(fragment => Math.min(fragment.scaleX, fragment.scaleY)),
    );
}

function renderCapturePlan(plan: ICapturePlan): HTMLCanvasElement | null {
    if (!plan.outputRect || plan.fragments.length === 0) {
        return null;
    }

    const outputScale = resolveOutputScale(plan.fragments);
    const outputWidth = Math.max(1, Math.round(getRectWidth(plan.outputRect) * outputScale));
    const outputHeight = Math.max(1, Math.round(getRectHeight(plan.outputRect) * outputScale));

    const outputCanvas = document.createElement('canvas');
    outputCanvas.width = outputWidth;
    outputCanvas.height = outputHeight;
    const context = outputCanvas.getContext('2d');
    if (!context) {
        return null;
    }

    for (const fragment of plan.fragments) {
        const destinationX = (fragment.intersection.left - plan.outputRect.left) * outputScale;
        const destinationY = (fragment.intersection.top - plan.outputRect.top) * outputScale;
        const destinationWidth = getRectWidth(fragment.intersection) * outputScale;
        const destinationHeight = getRectHeight(fragment.intersection) * outputScale;

        context.drawImage(
            fragment.canvas,
            fragment.sourceX,
            fragment.sourceY,
            fragment.sourceWidth,
            fragment.sourceHeight,
            destinationX,
            destinationY,
            destinationWidth,
            destinationHeight,
        );
    }

    return outputCanvas;
}

function canvasToPngBlob(canvas: HTMLCanvasElement) {
    return new Promise<Blob | null>((resolve) => {
        canvas.toBlob((blob) => {
            resolve(blob);
        }, 'image/png');
    });
}

export async function capturePdfRegionAsPngBlob(
    viewerContainer: HTMLElement,
    selectionRect: IClientRect,
) {
    const sources = collectCanvasSources(viewerContainer);
    const capturePlan = buildCanvasCapturePlan(selectionRect, sources);
    const outputRect = capturePlan.outputRect;
    if (!outputRect || capturePlan.fragments.length === 0) {
        return null;
    }

    const outputCanvas = renderCapturePlan(capturePlan);
    if (!outputCanvas) {
        throw new Error('Failed to render capture image');
    }

    const blob = await canvasToPngBlob(outputCanvas);
    outputCanvas.width = 0;
    outputCanvas.height = 0;

    if (!blob) {
        throw new Error('Failed to serialize capture image');
    }

    return {
        blob,
        outputRect,
    };
}
