import type { IClientRect } from '@app/modules/document-viewer/public';

export interface ICanvasSource {
    canvas: HTMLCanvasElement;
    rect: IClientRect;
    pageNumber?: number | null | undefined;
}

export interface ICaptureFragment {
    canvas: HTMLCanvasElement;
    intersection: IClientRect;
    sourceX: number;
    sourceY: number;
    sourceWidth: number;
    sourceHeight: number;
    scaleX: number;
    scaleY: number;
    pageNumber?: number | null | undefined;
}

export interface ICapturePlan {
    outputRect: IClientRect | null;
    fragments: ICaptureFragment[];
}

export interface IPdfRegionPaintCapture {
    plan: ICapturePlan;
    read: () => Promise<Uint8Array | null>;
    assertCurrent: () => void;
}

export interface IPdfViewerRegionCaptureExpose {
    captureRegionToClipboard: () => Promise<boolean>;
    captureVisibleRegionAsPng?: (selection: IClientRect, assertCurrent?: () => void) => Promise<{
        blob: Blob;
        outputRect: IClientRect
    } | null | undefined>;
    isCapturingRegion: boolean;
}
