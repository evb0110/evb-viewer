import type {
    IAnnotationCommentSummary,
    IAnnotationMarkerRect,
} from '@app/types/annotations';

export function isAnnotationMarkerRect(value: IAnnotationCommentSummary['markerRect']): value is IAnnotationMarkerRect {
    return Boolean(
        value
        && Number.isFinite(value.left)
        && Number.isFinite(value.top)
        && Number.isFinite(value.width)
        && Number.isFinite(value.height),
    );
}
