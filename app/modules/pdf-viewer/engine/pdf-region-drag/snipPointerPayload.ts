import type { IOverlayRect } from '@app/modules/document-viewer/public';

export interface ISnipPointerPayload {
    clientX: number;
    clientY: number;
    overlayRect: IOverlayRect;
}
