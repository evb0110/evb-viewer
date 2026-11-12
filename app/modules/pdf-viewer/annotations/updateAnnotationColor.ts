import type { IAnnotationCommentSummary } from '@app/types/annotations';
import type { AnnotationApplication } from '@app/modules/pdf-viewer/annotations/annotationApplication';
import { parseMarkupSubtype } from '@contracts/annotations';

/**
 * Recolours the note or text markup a sidebar or context-menu row names.
 * Returns whether the store accepted the change.
 */
export function updateAnnotationColor(
    application: AnnotationApplication,
    comment: IAnnotationCommentSummary,
    color: string,
) {
    const annotationId = application.annotationIdForSummary(comment);
    const entity = annotationId ? application.store.get(annotationId) : null;
    if (!entity || entity.deleted) {
        return false;
    }
    if (entity.kind === 'note') {
        return Boolean(application.store.updateNote(entity.identity.id, {color}));
    }
    if (entity.kind === 'text-markup' && parseMarkupSubtype(comment.subtype)) {
        return Boolean(application.store.updateTextMarkup(entity.identity.id, {color}));
    }
    return false;
}
