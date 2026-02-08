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

export interface IAnnotationMarkerRect {
    left: number;
    top: number;
    width: number;
    height: number;
}

export interface IAnnotationCommentSummary {
    id: string;
    stableKey: string;
    sortIndex?: number | null;
    pageIndex: number;
    pageNumber: number;
    text: string;
    kindLabel?: string | null;
    subtype?: string | null;
    author: string | null;
    modifiedAt: number | null;
    color: string | null;
    uid: string | null;
    annotationId: string | null;
    source: 'editor' | 'pdf';
    hasNote?: boolean;
    markerRect?: IAnnotationMarkerRect | null;
}
