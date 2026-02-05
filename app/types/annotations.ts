export type TAnnotationTool = 'none' | 'highlight' | 'text' | 'draw';

export interface IAnnotationSettings {
    highlightColor: string;
    highlightOpacity: number;
    highlightFree: boolean;
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
