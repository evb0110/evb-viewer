import type { IPdfBookmarkEntry } from '@contracts/pdfBookmarkEntry';
import type { TDocumentBookmarkDisplayMode } from '@app/modules/document-viewer/public';

export type TBookmarkDisplayMode = TDocumentBookmarkDisplayMode;
export type TBookmarkDropPosition = 'before' | 'after' | 'child';

export interface IBookmarkItem {
    title: IPdfBookmarkEntry['title'];
    pageIndex: IPdfBookmarkEntry['pageIndex'];
    pageYRatio?: IPdfBookmarkEntry['pageYRatio'];
    bold: IPdfBookmarkEntry['bold'];
    italic: IPdfBookmarkEntry['italic'];
    color: IPdfBookmarkEntry['color'];
    dest: string | unknown[] | null;
    id: string;
    items: IBookmarkItem[];
}

/**
 * The content coordinates a bookmark id is derived from. `parentId` carries the
 * whole ancestry, because every parent id was derived the same way.
 */
export interface IBookmarkIdentityInput {
    parentId: string | null;
    title: string;
    pageIndex: number | null;
    dest: string | unknown[] | null;
}

export type TCreateBookmarkId = (input: IBookmarkIdentityInput) => string;

export interface IBookmarkLocation {
    parent: IBookmarkItem | null;
    list: IBookmarkItem[];
    index: number;
    item: IBookmarkItem;
}

export type TBookmarkStyleFlagState = 'on' | 'off' | 'mixed';

/**
 * Style shared by the bookmarks a context-menu action will touch. `color` is
 * only meaningful while `colorMixed` is false.
 */
export interface IBookmarkStyleSummary {
    targetCount: number;
    bold: TBookmarkStyleFlagState;
    italic: TBookmarkStyleFlagState;
    color: string | null;
    colorMixed: boolean;
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
