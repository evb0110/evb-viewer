export type TAnnotationTool = 'none' | 'highlight' | 'text' | 'draw';

export interface IAnnotationSettings {
    highlightColor: string;
    highlightOpacity: number;
    highlightThickness: number;
    highlightFree: boolean;
    highlightShowAll: boolean;
    inkColor: string;
    inkOpacity: number;
    inkThickness: number;
    textColor: string;
    textSize: number;
}

export interface IAnnotationEditorState {
    isEditing: boolean;
    isEmpty: boolean;
    hasSomethingToUndo: boolean;
    hasSomethingToRedo: boolean;
    hasSelectedEditor: boolean;
}

export interface IAnnotationCommentSummary {
    id: string;
    pageIndex: number;
    pageNumber: number;
    text: string;
    author: string | null;
    modifiedAt: number | null;
    color: string | null;
    uid: string | null;
    annotationId: string | null;
    source: 'editor' | 'pdf';
}
