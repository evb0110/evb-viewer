import {createBrandedId, isBrandedString, parseBranded} from '@contracts/brand';
import type {TBrand} from '@contracts/brand';
import type {TTabId} from '@contracts/windowTabs';

export type TPaneId = TBrand<string, 'PaneId'>;

export function isPaneId(value: unknown): value is TPaneId {
    return isBrandedString<'PaneId'>(value);
}

export function parsePaneId(value: unknown): TPaneId | null {
    const normalized = typeof value === 'string' ? value.trim() : value;
    return parseBranded(normalized, isPaneId);
}

export function requirePaneId(value: unknown): TPaneId {
    const parsed = parsePaneId(value);
    if (parsed === null) {
        throw new TypeError('Pane ID must be a non-empty string');
    }
    return parsed;
}

export function createPaneId(prefix = 'pane'): TPaneId {
    return createBrandedId(prefix, isPaneId);
}

export type TPaneDirection = 'left' | 'right' | 'up' | 'down';

export type TPaneOrientation = 'horizontal' | 'vertical';

export interface IEditorPaneState {
    paneId: TPaneId;
    tabIds: TTabId[];
    activeTabId: TTabId | null;
}

export interface IEditorLayoutLeafNode {
    type: 'leaf';
    paneId: TPaneId;
}

export interface IEditorLayoutSplitNode {
    type: 'split';
    id: string;
    orientation: TPaneOrientation;
    ratio: number;
    first: TEditorLayoutNode;
    second: TEditorLayoutNode;
}

export type TEditorLayoutNode = IEditorLayoutLeafNode | IEditorLayoutSplitNode;

export interface IEditorPaneRect {
    paneId: TPaneId;
    x: number;
    y: number;
    widthPx: number;
    heightPx: number;
}
