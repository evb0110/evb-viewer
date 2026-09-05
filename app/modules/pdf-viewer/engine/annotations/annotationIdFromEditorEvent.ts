import type {AnnotationId} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';

export function annotationIdFromEditorEvent(event: Event) {
    const target = event.target;
    if (!(target instanceof Element)) {
        return null;
    }
    const id = target.closest<HTMLElement>('[data-annotation-id]')?.dataset.annotationId;
    return id ? id as AnnotationId : null;
}
