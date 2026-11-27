import type {IAnnotationCommentSummary} from '@app/types/annotations';
import {createEpochMs} from '@contracts/timestamps';

export function withOpenedAnnotationNoteCreationTimestamp(comment: IAnnotationCommentSummary) {
    if (comment.source !== 'editor' || comment.createdAt || comment.modifiedAt) {
        return comment;
    }
    return {
        ...comment,
        createdAt: createEpochMs(Date.now()),
    };
}
