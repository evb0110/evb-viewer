export type TBookmarkDisplayMode = 'top-level' | 'all-expanded' | 'current-expanded';
export type TBookmarkDropPosition = 'before' | 'after' | 'child';

export interface IBookmarkItem {
    title: string;
    dest: string | unknown[] | null;
    id: string;
    pageIndex: number | null;
    bold: boolean;
    italic: boolean;
    color: string | null;
    items: IBookmarkItem[];
}

export interface IBookmarkLocation {
    parent: IBookmarkItem | null;
    list: IBookmarkItem[];
    index: number;
    item: IBookmarkItem;
}

export interface IBookmarkMenuPayload {
    id: string;
    x: number;
    y: number;
}

export interface IBookmarkDropTarget {
    id: string;
    position: TBookmarkDropPosition;
}

export interface IBookmarkActivatePayload {
    id: string;
    hasChildren: boolean;
    wasActive: boolean;
    multiSelect: boolean;
    rangeSelect: boolean;
}

export interface IBookmarkDropPayload {
    targetId: string;
    position: TBookmarkDropPosition;
}
