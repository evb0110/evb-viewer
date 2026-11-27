import type {IAnnotationCommentSummary} from '@app/types/annotations';

export function getAnnotationPageNumber(comment: IAnnotationCommentSummary) {
    const pageNumber = Number.isFinite(comment.pageNumber) ? comment.pageNumber : comment.pageIndex + 1;
    return Math.max(1, Math.round(pageNumber));
}
