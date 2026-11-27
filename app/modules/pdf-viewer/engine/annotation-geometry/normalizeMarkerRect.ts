import type {IAnnotationMarkerRect} from '@app/types/annotations';
import {clamp} from 'es-toolkit/math';

export function normalizeMarkerRect(rect: IAnnotationMarkerRect | null | undefined): IAnnotationMarkerRect | null {
    if (!rect) {
        return null;
    }
    const left = Number.isFinite(rect.left) ? rect.left : 0;
    const top = Number.isFinite(rect.top) ? rect.top : 0;
    const width = Number.isFinite(rect.width) ? rect.width : 0;
    const height = Number.isFinite(rect.height) ? rect.height : 0;
    if (width <= 0 || height <= 0) {
        return null;
    }

    const clampedLeft = clamp(left, 0, 1);
    const clampedTop = clamp(top, 0, 1);
    const maxWidth = 1 - clampedLeft;
    const maxHeight = 1 - clampedTop;
    const clampedWidth = clamp(width, 0, maxWidth);
    const clampedHeight = clamp(height, 0, maxHeight);
    if (clampedWidth <= 0 || clampedHeight <= 0) {
        return null;
    }

    return {
        left: clampedLeft,
        top: clampedTop,
        width: clampedWidth,
        height: clampedHeight,
    };
}
