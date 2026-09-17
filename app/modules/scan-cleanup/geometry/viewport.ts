import type {
    IScanCleanupPreviewMetadata,
    IScanCleanupPreviewPageMetadata,
} from '@contracts/scan-cleanup/electronApiScanCleanup';

export interface IScanCleanupPreviewSize {
    height: number;
    width: number
}
export interface IScanCleanupPreviewFitArea extends IScanCleanupPreviewSize {
    left: number;
    top: number
}
export interface IScanCleanupPreviewFitPlacement extends IScanCleanupPreviewFitArea {}
export interface IScanCleanupPreviewFrameOutput extends IScanCleanupPreviewSize {half: IScanCleanupPreviewMetadata['half'];}

export function resolvePreviewFitPlacement(
    containerWidth: number,
    containerHeight: number,
    contentWidth: number,
    contentHeight: number,
): IScanCleanupPreviewFitPlacement {
    const scale = Math.min(containerWidth / Math.max(1, contentWidth), containerHeight / Math.max(1, contentHeight));
    const width = Math.max(0, contentWidth * scale);
    const height = Math.max(0, contentHeight * scale);
    return {
        width,
        height,
        left: Math.max(0, containerWidth - width) / 2,
        top: Math.max(0, containerHeight - height) / 2,
    };
}

export function resolvePreviewOutputFitSizes(
    availableAreas: IScanCleanupPreviewSize[],
    canvases: IScanCleanupPreviewSize[],
): IScanCleanupPreviewSize[] {
    if (availableAreas.length !== canvases.length || canvases.length === 0) {
        return [];
    }
    const scale = Math.max(0, Math.min(...canvases.map((canvas, index) => {
        const available = availableAreas[index] ?? {
            width: 0,
            height: 0,
        };
        return Math.min(available.width / Math.max(1, canvas.width), available.height / Math.max(1, canvas.height));
    })));
    return canvases.map(canvas => ({
        width: canvas.width * scale,
        height: canvas.height * scale,
    }));
}

export function resolvePreviewViewportFrame(outputs: IScanCleanupPreviewMetadata[]): IScanCleanupPreviewFrameOutput[] {
    return outputs.map(output => ({
        half: output.half,
        width: output.canvasWidthPx,
        height: output.canvasHeightPx,
    }));
}

export function resolvePreviewPlaceholderViewportFrame(
    sourceWidth: number,
    sourceHeight: number,
    layoutClassification: IScanCleanupPreviewPageMetadata['layoutClassification'] | undefined,
    rotationDegrees: IScanCleanupPreviewPageMetadata['rotationDegrees'],
): IScanCleanupPreviewFrameOutput[] {
    const swapsAxes = rotationDegrees === 90 || rotationDegrees === 270;
    const analysisWidth = swapsAxes ? sourceHeight : sourceWidth;
    const analysisHeight = swapsAxes ? sourceWidth : sourceHeight;
    const halves: Array<IScanCleanupPreviewMetadata['half']> = layoutClassification === 'two-page-spread'
        ? [
            'left',
            'right',
        ]
        : ['full'];
    return halves.map(half => ({
        half,
        width: analysisWidth / halves.length,
        height: analysisHeight,
    }));
}

export function resolvePreviewOutputFitRects(
    availableAreas: IScanCleanupPreviewFitArea[],
    canvases: IScanCleanupPreviewSize[],
) {
    return resolvePreviewOutputFitSizes(availableAreas, canvases).map((size, index) => {
        const available = availableAreas[index];
        if (!available) {
            return size;
        }
        return {
            ...size,
            left: available.left + Math.max(0, available.width - size.width) / 2,
            top: available.top + Math.max(0, available.height - size.height) / 2,
        };
    });
}

export function resolvePreviewSpreadCutterCenter(renderedBoxes: readonly IScanCleanupPreviewFitPlacement[]) {
    if (renderedBoxes.length < 2) {
        return null;
    }
    const [
        left,
        right,
    ] = [...renderedBoxes].sort((first, second) => first.left - second.left);
    return ((left?.left ?? 0) + (left?.width ?? 0) + (right?.left ?? 0)) / 2;
}
