import type {TPageNumber} from '@contracts/pageNumbers';

import type {IAnnotationCommentSummary} from '@app/types/annotations';

export interface IAnnotationContextMenuPayload {
    comment: IAnnotationCommentSummary | null;
    clientX: number;
    clientY: number;
    hasSelection: boolean;
    selectionText: string;
    pageNumber: TPageNumber | null;
    pageX: number | null;
    pageY: number | null;
}
