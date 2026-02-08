export type TAnnotationTool = 'none' | 'highlight' | 'underline' | 'strikethrough' | 'text' | 'draw' | 'rectangle' | 'circle' | 'line' | 'arrow' | 'stamp';

export type TMarkupSubtype = 'Highlight' | 'Underline' | 'StrikeOut' | 'Squiggly';

export type TShapeType = 'rectangle' | 'circle' | 'line' | 'arrow';

export type TLineEndStyle = 'none' | 'openArrow' | 'closedArrow';

export interface IShapeAnnotation {
    id: string;
    type: TShapeType;
    pageIndex: number;
    x: number;
    y: number;
    width: number;
    height: number;
    x2?: number;
    y2?: number;
    color: string;
    fillColor?: string;
    opacity: number;
    strokeWidth: number;
    lineEndStyle?: TLineEndStyle;
}

export interface IAnnotationSettings {
    highlightColor: string;
    highlightOpacity: number;
    highlightThickness: number;
    highlightFree: boolean;
    highlightShowAll: boolean;
    underlineColor: string;
    underlineOpacity: number;
    strikethroughColor: string;
    strikethroughOpacity: number;
    squigglyColor: string;
    squigglyOpacity: number;
    inkColor: string;
    inkOpacity: number;
    inkThickness: number;
    textColor: string;
    textSize: number;
    shapeColor: string;
    shapeFillColor: string;
    shapeOpacity: number;
    shapeStrokeWidth: number;
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
