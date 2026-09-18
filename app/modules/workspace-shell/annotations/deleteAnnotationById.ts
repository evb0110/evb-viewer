import type {IAnnotationCommentSummary} from '@app/types/annotations';
import {annotationIdForSummary} from '@app/modules/pdf-viewer/public';
import {isTextMarkupSubtype} from '@app/services/pdf/annotationSubtype';
import {BrowserLogger} from '@app/utils/browserLogger';

/**
 * A note window serves two shapes. A sticky note is the annotation, so
 * discarding it removes the annotation. Any other kind only carries the note
 * text, and discarding that note must leave the host on the page.
 */
export function isNoteHostedByAnotherAnnotation(comment: IAnnotationCommentSummary) {
    if (comment.annotationKind) {
        return comment.annotationKind !== 'note';
    }
    return isTextMarkupSubtype(comment.subtype);
}

/**
 * Note windows outlive the projection they were opened from, so a delete can
 * arrive for an annotation that is already gone. Report that miss instead of
 * dropping it, and never fall back to some other comment.
 */
export function deleteAnnotationById(
    comments: readonly IAnnotationCommentSummary[],
    annotationId: string,
    remove: (comment: IAnnotationCommentSummary) => Promise<unknown> | undefined,
    discardHostedNote: (comment: IAnnotationCommentSummary) => Promise<unknown> | undefined,
) {
    const comment = comments.find(candidate => annotationIdForSummary(candidate) === annotationId);
    if (!comment) {
        BrowserLogger.warn('annotations', 'Delete annotation by id found no projected comment', {
            annotationId,
            commentCount: comments.length,
        });
        return false;
    }
    void (isNoteHostedByAnotherAnnotation(comment) ? discardHostedNote(comment) : remove(comment));
    return true;
}
