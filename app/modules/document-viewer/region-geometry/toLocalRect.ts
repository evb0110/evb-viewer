import { getRectHeight } from '@app/modules/document-viewer/region-geometry/getRectHeight';
import { getRectWidth } from '@app/modules/document-viewer/region-geometry/getRectWidth';
import type {
    IClientRect,
    ILocalRect,
    IOverlayRect,
} from '@app/modules/document-viewer/region-geometry/regionGeometryTypes';

export function toLocalRect(rect: IClientRect, overlayRect: IOverlayRect): ILocalRect {
    return {
        x: rect.left - overlayRect.left,
        y: rect.top - overlayRect.top,
        width: getRectWidth(rect),
        height: getRectHeight(rect),
    };
}
