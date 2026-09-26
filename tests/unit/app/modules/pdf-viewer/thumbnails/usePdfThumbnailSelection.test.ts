// @vitest-environment happy-dom

import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    computed,
    nextTick,
    ref,
} from 'vue';
import type { TPageSelection } from '@contracts/pageNumbers';
import { usePdfThumbnailSelection } from '@app/modules/pdf-viewer/thumbnails/usePdfThumbnailSelection';

function createSelectionHarness(options: {
    currentPage?: number;
    keyboardMove?: 'move' | 'reorder';
    scrollPageIntoKeyboardView?: (page: number) => void | Promise<void>;
    selectedPages?: number[];
    totalPages?: number;
    pageSelection?: TPageSelection | null;
} = {}) {
    const totalPages = ref(options.totalPages ?? 5);
    const currentPage = ref(options.currentPage ?? 2);
    const selectedPages = ref(options.selectedPages ?? [
        2,
        4,
    ]);
    const selectedPageSelection = ref<TPageSelection | null>(options.pageSelection ?? null);
    const onSelectedPagesChange = vi.fn((pages: number[]) => {
        selectedPages.value = pages;
    });
    const onSelectionRefused = vi.fn();
    const onPageSelectionChange = vi.fn((selection: TPageSelection) => {
        selectedPageSelection.value = selection;
    });
    const onMove = vi.fn();
    const onReorder = vi.fn();
    const focusPageElement = vi.fn();
    const onGoToPage = vi.fn();
    const onContextMenu = vi.fn();
    const scrollPageIntoKeyboardView = vi.fn(options.scrollPageIntoKeyboardView);
    const selection = usePdfThumbnailSelection({
        consumeClickSkip: () => false,
        currentPage: computed(() => currentPage.value),
        focusPageElement,
        isDragging: ref(false),
        isExternalDragOver: ref(false),
        markUserInteraction: vi.fn(),
        onContextMenu,
        onGoToPage,
        ...(options.keyboardMove === 'move' ? {onMove} : {}),
        ...(options.keyboardMove === 'reorder' ? {onReorder} : {}),
        onSelectionRefused,
        onSelectedPagesChange,
        ...(options.pageSelection === undefined
            ? {}
            : {
                onPageSelectionChange,
                selectedPageSelection: computed(() => selectedPageSelection.value),
            }),
        scrollPageIntoKeyboardView,
        selectedPages: computed(() => selectedPages.value),
        totalPages: computed(() => totalPages.value),
    });
    return {
        currentPage,
        focusPageElement,
        onGoToPage,
        onContextMenu,
        onPageSelectionChange,
        onMove,
        onReorder,
        onSelectionRefused,
        onSelectedPagesChange,
        scrollPageIntoKeyboardView,
        selection,
        selectedPages,
        selectedPageSelection,
        totalPages,
    };
}

function keyEvent(key: string, init: KeyboardEventInit = {}) {
    return new KeyboardEvent('keydown', {
        key,
        cancelable: true,
        ...init,
    });
}

describe('usePdfThumbnailSelection', () => {
    it('keeps a compact multi-page selection for a context action', () => {
        const pageSelection = {
            kind: 'range',
            pageCount: 1_000_000,
            startPage: 2,
            endPage: 100_002,
        } satisfies TPageSelection;
        const {
            onContextMenu,
            selection,
        } = createSelectionHarness({
            pageSelection,
            totalPages: 1_000_000,
        });

        selection.handleThumbnailContextMenu(new MouseEvent('contextmenu'), 50_000);

        expect(onContextMenu).toHaveBeenCalledWith(expect.objectContaining({
            clickedPage: 50_000,
            selection: pageSelection,
        }));
    });
    it('renormalizes selected pages when total pages shrinks', async () => {
        const {
            onSelectedPagesChange,
            selectedPages,
            totalPages,
        } = createSelectionHarness();
        onSelectedPagesChange.mockClear();

        totalPages.value = 3;
        await nextTick();

        expect(onSelectedPagesChange).toHaveBeenCalledWith([2]);
        expect(selectedPages.value).toEqual([2]);
    });

    it('roves the tab stop from the current page and drops it for an empty document', () => {
        const {
            selection,
            totalPages,
        } = createSelectionHarness({currentPage: 2});

        expect(selection.rovingFocusPage.value).toBe(2);

        totalPages.value = 0;
        expect(selection.rovingFocusPage.value).toBeNull();
    });

    it('moves keyboard focus with arrow keys without changing selection or the page', () => {
        const {
            focusPageElement,
            onGoToPage,
            onSelectedPagesChange,
            scrollPageIntoKeyboardView,
            selectedPages,
            selection,
        } = createSelectionHarness({currentPage: 2});
        onSelectedPagesChange.mockClear();

        const event = keyEvent('ArrowDown');
        selection.handleContainerKeyDown(event);

        expect(event.defaultPrevented).toBe(true);
        expect(selection.rovingFocusPage.value).toBe(3);
        expect(scrollPageIntoKeyboardView).toHaveBeenCalledWith(3);
        expect(focusPageElement).toHaveBeenCalledWith(3);
        expect(onSelectedPagesChange).not.toHaveBeenCalled();
        expect(selectedPages.value).toEqual([
            2,
            4,
        ]);
        expect(onGoToPage).not.toHaveBeenCalled();
    });

    it('clamps arrow focus at the document edges and supports Home, End and paging keys', () => {
        const {selection} = createSelectionHarness({
            currentPage: 1,
            totalPages: 10,
        });

        selection.handleContainerKeyDown(keyEvent('ArrowUp'));
        expect(selection.rovingFocusPage.value).toBe(1);

        selection.handleContainerKeyDown(keyEvent('End'));
        expect(selection.rovingFocusPage.value).toBe(10);

        selection.handleContainerKeyDown(keyEvent('PageUp'));
        expect(selection.rovingFocusPage.value).toBe(5);

        selection.handleContainerKeyDown(keyEvent('PageDown'));
        expect(selection.rovingFocusPage.value).toBe(10);

        selection.handleContainerKeyDown(keyEvent('Home'));
        expect(selection.rovingFocusPage.value).toBe(1);
    });

    it.each([
        {
            currentPage: 20,
            key: 'Home',
            targetPage: 1,
        },
        {
            currentPage: 1,
            key: 'End',
            targetPage: 20,
        },
        {
            currentPage: 16,
            key: 'PageDown',
            targetPage: 20,
        },
    ])('waits for a cross-segment $key scroll before focusing its target row', async ({
        currentPage,
        key,
        targetPage,
    }) => {
        const harness = createSelectionHarness({
            currentPage,
            scrollPageIntoKeyboardView: () => Promise.resolve(),
            totalPages: 20,
        });

        harness.selection.handleContainerKeyDown(keyEvent(key));
        expect(harness.scrollPageIntoKeyboardView).toHaveBeenCalledWith(targetPage);
        expect(harness.focusPageElement).not.toHaveBeenCalled();

        await nextTick();

        expect(harness.focusPageElement).toHaveBeenCalledWith(targetPage);
    });

    it('activates the focused row with Enter and Space without selecting it', () => {
        const {
            onGoToPage,
            onSelectedPagesChange,
            selection,
        } = createSelectionHarness({currentPage: 2});
        onSelectedPagesChange.mockClear();

        selection.handleContainerKeyDown(keyEvent('ArrowDown'));
        const enter = keyEvent('Enter');
        selection.handleContainerKeyDown(enter);
        expect(enter.defaultPrevented).toBe(true);
        expect(onGoToPage).toHaveBeenLastCalledWith(3);

        const space = keyEvent(' ');
        selection.handleContainerKeyDown(space);
        expect(space.defaultPrevented).toBe(true);
        expect(onGoToPage).toHaveBeenCalledTimes(2);
        expect(onSelectedPagesChange).not.toHaveBeenCalled();
    });

    it('keeps Shift+Arrow range selection and moves the roving focus with it', () => {
        const {
            focusPageElement,
            onGoToPage,
            onSelectedPagesChange,
            selectedPages,
            selection,
        } = createSelectionHarness({currentPage: 2});
        onSelectedPagesChange.mockClear();

        const event = keyEvent('ArrowDown', {shiftKey: true});
        selection.handleContainerKeyDown(event);

        expect(event.defaultPrevented).toBe(true);
        expect(selectedPages.value).toEqual([
            4,
            5,
        ]);
        expect(onGoToPage).toHaveBeenCalledWith(5);
        expect(focusPageElement).toHaveBeenCalledWith(5);
        expect(selection.rovingFocusPage.value).toBe(5);
    });

    it('ignores key presses raised by controls nested inside a row', () => {
        const {
            onGoToPage,
            selection,
        } = createSelectionHarness({currentPage: 2});
        const row = document.createElement('div');
        row.dataset.thumbnailPage = '2';
        const toggle = document.createElement('button');
        row.append(toggle);
        document.body.append(row);

        try {
            const enter = keyEvent('Enter');
            Object.defineProperty(enter, 'target', {value: toggle});
            selection.handleContainerKeyDown(enter);

            const arrow = keyEvent('ArrowDown');
            Object.defineProperty(arrow, 'target', {value: toggle});
            selection.handleContainerKeyDown(arrow);

            expect(enter.defaultPrevented).toBe(false);
            expect(arrow.defaultPrevented).toBe(false);
            expect(onGoToPage).not.toHaveBeenCalled();
            expect(selection.rovingFocusPage.value).toBe(2);
        } finally {
            row.remove();
        }
    });

    it('ignores keyboard navigation before the document has pages', () => {
        const {
            focusPageElement,
            onGoToPage,
            scrollPageIntoKeyboardView,
            selection,
        } = createSelectionHarness({
            currentPage: 2,
            totalPages: 0,
        });

        const event = keyEvent('ArrowDown');
        selection.handleContainerKeyDown(event);

        expect(event.defaultPrevented).toBe(false);
        expect(focusPageElement).not.toHaveBeenCalled();
        expect(scrollPageIntoKeyboardView).not.toHaveBeenCalled();
        expect(onGoToPage).not.toHaveBeenCalled();
    });

    it('adopts the focused row when focus enters the rail', () => {
        const {selection} = createSelectionHarness({currentPage: 2});
        const row = document.createElement('div');
        row.dataset.thumbnailPage = '4';
        const label = document.createElement('span');
        row.append(label);

        selection.handleContainerFocusIn(new FocusEvent('focusin'));
        expect(selection.rovingFocusPage.value).toBe(2);

        const event = new FocusEvent('focusin');
        Object.defineProperty(event, 'target', {value: label});
        selection.handleContainerFocusIn(event);

        expect(selection.rovingFocusPage.value).toBe(4);
    });

    it('leaves navigation keys alone while a modifier chord is held', () => {
        const {
            focusPageElement,
            selection,
        } = createSelectionHarness({currentPage: 2});

        for (const modifier of [
            'ctrlKey',
            'metaKey',
            'altKey',
        ]) {
            const event = keyEvent('ArrowDown', {[modifier]: true});
            selection.handleContainerKeyDown(event);
            expect(event.defaultPrevented).toBe(false);
        }

        expect(focusPageElement).not.toHaveBeenCalled();
        expect(selection.rovingFocusPage.value).toBe(2);
    });

    it('moves the focused selected pages with Alt+ArrowDown in the page model', () => {
        const {
            onMove,
            selection,
        } = createSelectionHarness({
            currentPage: 2,
            keyboardMove: 'move',
            pageSelection: {
                kind: 'explicit',
                pageCount: 5,
                pages: [
                    2,
                    4,
                ],
            },
        });

        const event = keyEvent('ArrowDown', {altKey: true});
        selection.handleContainerKeyDown(event);

        expect(event.defaultPrevented).toBe(true);
        expect(onMove).toHaveBeenCalledWith({
            pageCount: 5,
            ranges: [
                {
                    startPage: 2,
                    endPage: 2,
                },
                {
                    startPage: 4,
                    endPage: 4,
                },
            ],
            insertAt: 5,
        });
    });

    it('builds the legacy reorder permutation for Alt+ArrowUp', () => {
        const {
            onReorder,
            selection,
        } = createSelectionHarness({
            currentPage: 2,
            keyboardMove: 'reorder',
            selectedPages: [
                2,
                3,
            ],
        });

        const event = keyEvent('ArrowUp', {altKey: true});
        selection.handleContainerKeyDown(event);

        expect(event.defaultPrevented).toBe(true);
        expect(onReorder).toHaveBeenCalledWith([
            2,
            3,
            1,
            4,
            5,
        ]);
    });

    it('keeps a million-page shift selection in the model instead of a legacy array', () => {
        const {
            onPageSelectionChange,
            onSelectedPagesChange,
            selectedPageSelection,
            selectedPages,
            selection,
        } = createSelectionHarness({
            currentPage: 2,
            pageSelection: {
                kind: 'none',
                pageCount: 1_000_000,
            },
            totalPages: 1_000_000,
        });
        onPageSelectionChange.mockClear();
        onSelectedPagesChange.mockClear();

        selection.handleThumbnailClick(
            new MouseEvent('click', { shiftKey: true }),
            1_000_000,
        );

        expect(onPageSelectionChange).toHaveBeenCalledOnce();
        expect(onPageSelectionChange.mock.calls[0]?.[0]).toEqual({
            kind: 'range',
            pageCount: 1_000_000,
            startPage: 2,
            endPage: 1_000_000,
        });
        expect(selectedPageSelection.value).toEqual(onPageSelectionChange.mock.calls[0]?.[0]);
        expect(onSelectedPagesChange).not.toHaveBeenCalled();
        expect(selectedPages.value).toEqual([
            2,
            4,
        ]);
        expect(selection.isSelected(1_000_000)).toBe(true);
    });

    it('refuses a million-page legacy shift selection before allocating an all-pages array', () => {
        const {
            onSelectedPagesChange,
            onSelectionRefused,
            selectedPages,
            selection,
        } = createSelectionHarness({totalPages: 1_000_000});
        onSelectedPagesChange.mockClear();

        selection.handleThumbnailClick(
            new MouseEvent('click', {shiftKey: true}),
            1_000_000,
        );

        expect(onSelectionRefused).toHaveBeenCalledWith({
            kind: 'page-count-limit',
            pageCount: 1_000_000,
            limit: 100_000,
        });
        expect(onSelectedPagesChange).not.toHaveBeenCalled();
        expect(selectedPages.value).toEqual([
            2,
            4,
        ]);
    });
});
