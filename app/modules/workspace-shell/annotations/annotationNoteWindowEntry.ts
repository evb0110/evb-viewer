import type {IAnnotationCommentSummary} from '@app/types/annotations';

export interface IAnnotationNoteWindowEntry {
    annotationId: string;
    pageIndex: number;
    pageNumber: number;
    author: string | null;
    color?: string | null;
    createdAt: number | null;
    modifiedAt: number | null;
    markerRect: IAnnotationCommentSummary['markerRect'];
    subtype: string | null;
    source: IAnnotationCommentSummary['source'];
    hasNote: boolean;
    draftText: string;
    saving: boolean;
    error: string | null;
    order: number;
    isMinimized: boolean;
}
