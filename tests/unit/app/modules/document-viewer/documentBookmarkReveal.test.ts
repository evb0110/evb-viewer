import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    getDocumentBookmarkVisibleRows,
    resolveDocumentBookmarkRevealRowIndex,
    type IDocumentBookmarkTreeItem,
} from '@app/modules/document-viewer/bookmarks/documentBookmarks';

function bookmark(
    id: string,
    children: IDocumentBookmarkTreeItem[] = [],
): IDocumentBookmarkTreeItem {
    return {
        id,
        title: `Bookmark ${id}`,
        pageNumber: null,
        children,
    };
}

const items = [
    bookmark('a', [
        bookmark('a1', [bookmark('a2')]),
        bookmark('a3'),
    ]),
    bookmark('b'),
];

function rowIds(rows: ReturnType<typeof getDocumentBookmarkVisibleRows>) {
    return rows.map(row => row.item.id);
}

describe('document bookmark visible rows', () => {
    it('renders every level in all-expanded mode', () => {
        const rows = getDocumentBookmarkVisibleRows(items, {
            displayMode: 'all-expanded',
            expandedIds: new Set(),
            activePathIds: new Set(),
        });

        expect(rowIds(rows)).toEqual([
            'a',
            'a1',
            'a2',
            'a3',
            'b',
        ]);
        expect(rows.map(row => row.depth)).toEqual([
            0,
            1,
            2,
            1,
            0,
        ]);
    });

    it('renders only expanded branches in top-level mode', () => {
        const rows = getDocumentBookmarkVisibleRows(items, {
            displayMode: 'top-level',
            expandedIds: new Set(['a']),
            activePathIds: new Set([
                'a',
                'a1',
                'a2',
            ]),
        });

        expect(rowIds(rows)).toEqual([
            'a',
            'a1',
            'a3',
            'b',
        ]);
    });

    it('renders the active path in current-expanded mode', () => {
        const rows = getDocumentBookmarkVisibleRows(items, {
            displayMode: 'current-expanded',
            expandedIds: new Set(),
            activePathIds: new Set([
                'a',
                'a1',
                'a2',
            ]),
        });

        expect(rowIds(rows)).toEqual([
            'a',
            'a1',
            'a2',
            'a3',
            'b',
        ]);
    });

    it('keeps manually expanded branches open when the active path changes', () => {
        const rows = getDocumentBookmarkVisibleRows(items, {
            displayMode: 'current-expanded',
            expandedIds: new Set(['a']),
            activePathIds: new Set(['b']),
        });

        expect(rowIds(rows)).toEqual([
            'a',
            'a1',
            'a3',
            'b',
        ]);
    });
});

describe('resolveDocumentBookmarkRevealRowIndex', () => {
    const activePathIds = new Set([
        'a',
        'a1',
        'a2',
    ]);

    it('reveals the active row when it is rendered', () => {
        const rows = getDocumentBookmarkVisibleRows(items, {
            displayMode: 'all-expanded',
            expandedIds: new Set(),
            activePathIds,
        });

        expect(resolveDocumentBookmarkRevealRowIndex(rows, 'a2', activePathIds)).toBe(2);
    });

    it('falls back to the deepest visible ancestor under a collapsed node', () => {
        const rows = getDocumentBookmarkVisibleRows(items, {
            displayMode: 'top-level',
            expandedIds: new Set(['a']),
            activePathIds,
        });

        expect(rowIds(rows)).not.toContain('a2');
        expect(resolveDocumentBookmarkRevealRowIndex(rows, 'a2', activePathIds)).toBe(1);
    });

    it('falls back to the top-level ancestor when the whole branch is collapsed', () => {
        const rows = getDocumentBookmarkVisibleRows(items, {
            displayMode: 'top-level',
            expandedIds: new Set(),
            activePathIds,
        });

        expect(resolveDocumentBookmarkRevealRowIndex(rows, 'a2', activePathIds)).toBe(0);
    });

    it('reveals nothing without an active bookmark or a visible ancestor', () => {
        const rows = getDocumentBookmarkVisibleRows(items, {
            displayMode: 'top-level',
            expandedIds: new Set(),
            activePathIds,
        });

        expect(resolveDocumentBookmarkRevealRowIndex(rows, null, activePathIds)).toBe(-1);
        expect(resolveDocumentBookmarkRevealRowIndex(rows, 'missing', new Set(['missing']))).toBe(-1);
    });
});
