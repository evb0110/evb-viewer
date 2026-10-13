import { requirePageIndex } from '@contracts/pageNumbers';
import type { TPageIndex } from '@contracts/pageNumbers';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { navigateToBookmarkDestination } from '@app/modules/pdf-viewer/engine/pdf-outline-navigation/navigateToBookmarkDestination';
import type { IBookmarkItem } from '@app/types/pdfOutline';

function createBookmark(overrides: Partial<IBookmarkItem>): IBookmarkItem {
    return {
        bold: false,
        color: null,
        dest: null,
        id: 'bookmark',
        italic: false,
        items: [],
        pageIndex: null,
        title: 'Bookmark',
        ...overrides,
    };
}

describe('navigateToBookmarkDestination', () => {
    it('emits one unresolved named destination for the authority', () => {
        const emitGoToPage = vi.fn();
        navigateToBookmarkDestination({
            item: createBookmark({
                dest: 'chapter',
                pageIndex: requirePageIndex(4),
            }),
            pdfDocument: null,
            navigationRequestId: 2,
            isBookmarkNavigationRequestCurrent: id => id === 2,
            emitGoToPage,
        });
        expect(emitGoToPage).toHaveBeenCalledOnce();
        expect(emitGoToPage).toHaveBeenCalledWith(5, {navigationRequest: {
            target: {
                kind: 'named-dest',
                destination: 'chapter',
            },
            alignment: 'page-top',
            readiness: 'page-canvas',
            source: 'bookmark',
            supersession: 'latest-wins',
        }});
    });

    it('emits a page target when the bookmark has no named destination', () => {
        const emitGoToPage = vi.fn();
        navigateToBookmarkDestination({
            item: createBookmark({pageIndex: requirePageIndex(6)}),
            pdfDocument: null,
            navigationRequestId: 1,
            isBookmarkNavigationRequestCurrent: () => true,
            emitGoToPage,
        });
        expect(emitGoToPage).toHaveBeenCalledWith(7, {navigationRequest: expect.objectContaining({
            target: {
                kind: 'page',
                page: 7,
            },
            source: 'bookmark',
        })});
    });

    it('keeps the vertical position of a bookmark that has only a page ratio', () => {
        const emitGoToPage = vi.fn();
        navigateToBookmarkDestination({
            item: createBookmark({
                pageIndex: requirePageIndex(0),
                pageYRatio: 0.25,
            }),
            pdfDocument: null,
            navigationRequestId: 1,
            isBookmarkNavigationRequestCurrent: () => true,
            emitGoToPage,
        });
        expect(emitGoToPage).toHaveBeenCalledWith(1, {navigationRequest: expect.objectContaining({
            target: {
                kind: 'rect',
                page: 1,
                rect: {
                    left: 0.5,
                    top: 0.25,
                    width: 0,
                    height: 0,
                },
            },
            alignment: 'page-top',
            source: 'bookmark',
        })});
    });

    it('does not emit stale or invalid requests', () => {
        const emitGoToPage = vi.fn();
        const common = {
            pdfDocument: null,
            navigationRequestId: 1,
            emitGoToPage,
        };
        navigateToBookmarkDestination({
            ...common,
            item: createBookmark({dest: 'stale'}),
            isBookmarkNavigationRequestCurrent: () => false,
        });
        navigateToBookmarkDestination({
            ...common,
            // Invalid persisted page indexes are a runtime input case, not a
            // valid page-number fixture.
            item: createBookmark({pageIndex: Number.NaN as TPageIndex}),
            isBookmarkNavigationRequestCurrent: () => true,
        });
        expect(emitGoToPage).not.toHaveBeenCalled();
    });
});
