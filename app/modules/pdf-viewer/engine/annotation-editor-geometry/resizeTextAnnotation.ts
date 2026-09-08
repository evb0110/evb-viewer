import type { IAnnotationMarkerRect } from '@app/types/annotations';
import type {
    IAnnotationEditorPoint,
    IAnnotationPageDimensions,
    TAnnotationResizeHandle,
} from '@app/modules/pdf-viewer/engine/annotation-editor-geometry/annotationEditorGeometry';
import {
    resizeRotatedAnnotationRect,
    rotateAnnotationPointAround,
    rotatedAnnotationBounds,
} from '@app/modules/pdf-viewer/engine/annotation-editor-geometry/annotationEditorGeometry';

/** Corners scale text uniformly; side handles keep the font and change wrapping width. */
export function resizeTextAnnotation(
    rect: IAnnotationMarkerRect,
    fontSize: number,
    handle: TAnnotationResizeHandle,
    point: IAnnotationEditorPoint,
    rotation: number,
    page: IAnnotationPageDimensions,
) {
    if (handle.length === 1) {
        return {
            rect: resizeRotatedAnnotationRect(rect, handle, point, rotation, page),
            fontSize,
        };
    }
    const center = {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
    };
    const anchor = {
        x: rect.left + (handle.includes('w') ? rect.width : 0),
        y: rect.top + (handle.includes('n') ? rect.height : 0),
    };
    const local = rotateAnnotationPointAround(point, center, -rotation, page);
    const dx = rect.width * page.width * (handle.includes('w') ? -1 : 1);
    const dy = rect.height * page.height * (handle.includes('n') ? -1 : 1);
    const squaredLength = dx * dx + dy * dy;
    if (squaredLength <= 0 || fontSize <= 0) {
        return {
            rect,
            fontSize,
        };
    }
    const projected = ((local.x - anchor.x) * page.width * dx + (local.y - anchor.y) * page.height * dy) / squaredLength;
    const requested = Math.max(Math.min(1, 8 / fontSize), Math.min(Math.max(1, 72 / fontSize), projected));
    function candidate(scale: number) {
        const width = rect.width * scale;
        const height = rect.height * scale;
        const localCenter = {
            x: anchor.x + width * (handle.includes('w') ? -0.5 : 0.5),
            y: anchor.y + height * (handle.includes('n') ? -0.5 : 0.5),
        };
        const nextCenter = rotateAnnotationPointAround(localCenter, center, rotation, page);
        return {
            left: nextCenter.x - width / 2,
            top: nextCenter.y - height / 2,
            width,
            height,
        };
    }
    function inside(value: IAnnotationMarkerRect) {
        const bounds = rotatedAnnotationBounds(value, rotation, page);
        return bounds.left >= -1e-8 && bounds.top >= -1e-8
            && bounds.left + bounds.width <= 1 + 1e-8 && bounds.top + bounds.height <= 1 + 1e-8;
    }
    let scale = requested;
    if (!inside(candidate(scale))) {
        if (!inside(rect)) {
            return {
                rect,
                fontSize,
            };
        }
        let lower = 0;
        let upper = 1;
        for (let iteration = 0; iteration < 32; iteration += 1) {
            const fraction = (lower + upper) / 2;
            if (inside(candidate(1 + (requested - 1) * fraction))) lower = fraction;
            else upper = fraction;
        }
        scale = 1 + (requested - 1) * lower;
    }
    // The boundary search allows numerical tolerance. Do not publish that
    // tolerance as a font change when the page prevents meaningful scaling.
    if (Math.abs(scale - 1) <= 1e-7) {
        return {
            rect,
            fontSize,
        };
    }
    return {
        rect: candidate(scale),
        fontSize: fontSize * scale,
    };
}
