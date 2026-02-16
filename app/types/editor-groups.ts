export type TGroupDirection = 'left' | 'right' | 'up' | 'down';

export type TGroupOrientation = 'horizontal' | 'vertical';

export interface IEditorGroupState {
    id: string;
    tabIds: string[];
    activeTabId: string | null;
}

export interface IEditorLayoutLeafNode {
    type: 'leaf';
    groupId: string;
}

export interface IEditorLayoutSplitNode {
    type: 'split';
    id: string;
    orientation: TGroupOrientation;
    ratio: number;
    first: TEditorLayoutNode;
    second: TEditorLayoutNode;
}

export type TEditorLayoutNode = IEditorLayoutLeafNode | IEditorLayoutSplitNode;

export interface IEditorGroupRect {
    groupId: string;
    x: number;
    y: number;
    width: number;
    height: number;
}
