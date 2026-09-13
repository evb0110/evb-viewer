import type { IDocumentOutlineItem } from '@app/modules/document-viewer/source/documentPageSource';

export type TDocumentBookmarkDisplayMode = 'top-level' | 'all-expanded' | 'current-expanded';
export type TDocumentBookmarkPersistenceRefusal = 'depth';

/**
 * The single representation of what a bookmark panel is showing. `error` means
 * the outline load failed and `items` is not a trustworthy empty outline, which
 * is why the two must never collapse into one "nothing to show" branch.
 */
export type TDocumentBookmarkStatus = 'loading' | 'error' | 'empty' | 'ready' | 'unpersistable';

export interface IDocumentBookmarkTreeItem {
    id: string;
    title: string;
    pageNumber: number | null;
    children: IDocumentBookmarkTreeItem[];
    bold?: boolean | undefined;
    italic?: boolean | undefined;
    color?: string | null | undefined;
}

function normalizeTitle(title: string) {
    return title.trim();
}

function createBookmarkId(path: readonly number[]) {
    return `document-bookmark-${path.join('-')}`;
}

export function createDocumentBookmarkTree(
    items: readonly IDocumentOutlineItem[],
    path: readonly number[] = [],
): IDocumentBookmarkTreeItem[] {
    const result: IDocumentBookmarkTreeItem[] = [];
    const stack = items.toReversed().map((item, reverseIndex) => ({
        item,
        itemPath: [
            ...path,
            items.length - reverseIndex - 1,
        ],
        target: result,
    }));
    while (stack.length > 0) {
        const entry = stack.pop();
        if (!entry) {
            break;
        }
        const mapped: IDocumentBookmarkTreeItem = {
            id: createBookmarkId(entry.itemPath),
            title: normalizeTitle(entry.item.title),
            pageNumber: entry.item.pageNumber,
            children: [],
        };
        entry.target.push(mapped);
        for (let index = entry.item.children.length - 1; index >= 0; index -= 1) {
            const child = entry.item.children[index];
            if (!child) {
                continue;
            }
            stack.push({
                item: child,
                itemPath: [
                    ...entry.itemPath,
                    index,
                ],
                target: mapped.children,
            });
        }
    }
    return result;
}

export function getDocumentBookmarkActivePath(
    items: readonly IDocumentBookmarkTreeItem[],
    currentPage: number,
) {
    let bestPath: string[] = [];
    let bestPage = Number.NEGATIVE_INFINITY;

    const stack = items.toReversed().map(item => ({
        item,
        path: [item.id],
    }));
    while (stack.length > 0) {
        const {
            item,
            path,
        } = stack.pop() ?? {
            item: null,
            path: [],
        };
        if (!item) {
            continue;
        }
        if (item.pageNumber !== null && item.pageNumber <= currentPage && item.pageNumber >= bestPage) {
            bestPage = item.pageNumber;
            bestPath = path;
        }
        for (let index = item.children.length - 1; index >= 0; index -= 1) {
            const child = item.children[index];
            if (!child) {
                continue;
            }
            stack.push({
                item: child,
                path: [
                    ...path,
                    child.id,
                ],
            });
        }
    }
    return bestPath;
}

export interface IDocumentBookmarkVisibleRow {
    item: IDocumentBookmarkTreeItem;
    depth: number;
    isExpanded: boolean;
}

export interface IDocumentBookmarkDisplayState {
    displayMode: TDocumentBookmarkDisplayMode;
    expandedIds: ReadonlySet<string>;
    activePathIds: ReadonlySet<string>;
}

export function isDocumentBookmarkExpanded(
    id: string,
    display: IDocumentBookmarkDisplayState,
) {
    if (display.displayMode === 'all-expanded') {
        return true;
    }
    if (display.displayMode === 'current-expanded') {
        return display.activePathIds.has(id) || display.expandedIds.has(id);
    }
    return display.expandedIds.has(id);
}

/**
 * Rows the tree renders for a display state, in document order.
 */
export function getDocumentBookmarkVisibleRows(
    items: readonly IDocumentBookmarkTreeItem[],
    display: IDocumentBookmarkDisplayState,
): IDocumentBookmarkVisibleRow[] {
    const rows: IDocumentBookmarkVisibleRow[] = [];
    const stack = items.toReversed().map(item => ({
        item,
        depth: 0,
    }));
    while (stack.length > 0) {
        const {
            item,
            depth,
        } = stack.pop() ?? {
            item: null,
            depth: 0,
        };
        if (!item) {
            continue;
        }
        const isExpanded = item.children.length > 0 && isDocumentBookmarkExpanded(item.id, display);
        rows.push({
            item,
            depth,
            isExpanded,
        });
        if (isExpanded) {
            for (let index = item.children.length - 1; index >= 0; index -= 1) {
                const child = item.children[index];
                if (!child) {
                    continue;
                }
                stack.push({
                    item: child,
                    depth: depth + 1,
                });
            }
        }
    }
    return rows;
}

/**
 * Row to scroll to when following the active bookmark. Collapsed ancestors hide
 * the active row itself, so the deepest rendered ancestor stands in for it
 * instead of the follow silently giving up. Rendered rows are in document
 * order, so the last row on the active path is the deepest one.
 */
export function resolveDocumentBookmarkRevealRowIndex(
    rows: readonly IDocumentBookmarkVisibleRow[],
    activeId: string | null,
    activePathIds: ReadonlySet<string>,
) {
    if (!activeId) {
        return -1;
    }

    let ancestorIndex = -1;
    for (const [
        index,
        row,
    ] of rows.entries()) {
        if (row.item.id === activeId) {
            return index;
        }
        if (activePathIds.has(row.item.id)) {
            ancestorIndex = index;
        }
    }

    return ancestorIndex;
}

export function findDocumentBookmark(
    items: readonly IDocumentBookmarkTreeItem[],
    id: string,
): IDocumentBookmarkTreeItem | null {
    const stack = items.toReversed();
    while (stack.length > 0) {
        const item = stack.pop();
        if (!item) {
            break;
        }
        if (item.id === id) {
            return item;
        }
        stack.push(...item.children.toReversed());
    }
    return null;
}
