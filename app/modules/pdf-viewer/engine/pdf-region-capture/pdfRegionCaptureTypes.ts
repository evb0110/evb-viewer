import type { IClientRect } from '@app/modules/document-viewer/public';

export interface ICanvasSource {
    canvas: HTMLCanvasElement;
    rect: IClientRect;
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
}

export interface ICapturePlan {
    outputRect: IClientRect | null;
    fragments: ICaptureFragment[];
}
