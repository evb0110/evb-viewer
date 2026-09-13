import type { IClientPoint } from '@app/modules/document-viewer/public';

export function toClientPoint(payload: IClientPoint): IClientPoint {
    return {
        clientX: payload.clientX,
        clientY: payload.clientY,
    };
}
