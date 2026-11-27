// @vitest-environment happy-dom

import {describe, expect, it, onTestFinished, vi} from 'vitest';
import {computed, createApp, defineComponent, h, shallowRef, nextTick, ref} from 'vue';
import type {TPageSelection} from '@contracts/pageNumbers';
import {usePdfThumbnailSelection} from '@app/modules/pdf-viewer/thumbnails/usePdfThumbnailSelection';

import PdfSidebarPageNumbering from '@app/modules/pdf-viewer/components/PdfSidebarPageNumbering.vue';
import {createEmptyPageSelection, createRangePageSelection, pageSelectionCount} from '@app/utils/pdfPageSelection';

vi.mock('@app/composables/useTypedI18n', () => ({
    useTypedI18n: () => ({t: (key: string, params?: {range?: string; total?: number}) => `${key}${params ? JSON.stringify(params) : ''}`}),
}));
vi.mock('@app/composables/useFailureToast', () => ({
    useFailureToast: () => ({presentNoticeToast: vi.fn()}),
}));

async function mountNumberingPanel() {
    const selected = shallowRef<TPageSelection>(createEmptyPageSelection(20));
    const host = document.createElement('div');
    document.body.append(host);
    const app = createApp({
        setup: () => () =>
            h('div', [
                h(PdfSidebarPageNumbering, {
                    totalPages: 20,
                    selectedPageSelection: selected.value,
                    'onUpdate:selectedPageSelection': (selection: TPageSelection) => {
                        selected.value = selection;
                    },
                }),
                h('output', {class: 'selection-count'}, String(pageSelectionCount(selected.value))),
            ]),
    });
    app.component(
        'UCollapsible',
        defineComponent({
            setup:
                (_props, {slots}) =>
                () =>
                    h('div', slots.content?.()),
        }),
    );
    app.component('UIcon', {render: () => h('span')});
    for (const name of ['UFormField', 'URadioGroup', 'USelect', 'UInputNumber']) {
        app.component(
            name,
            defineComponent({
                setup:
                    (_props, {slots}) =>
                    () =>
                        h('div', slots.default?.()),
            }),
        );
    }
    app.component(
        'UButton',
        defineComponent({
            setup:
                (_props, {attrs, slots}) =>
                () =>
                    h('button', attrs, slots.default?.()),
        }),
    );
    app.component(
        'UInput',
        defineComponent({
            props: {modelValue: {type: String, default: ''}},
            emits: ['update:modelValue'],
            setup:
                (props, {attrs, emit}) =>
                () =>
                    h('input', {
                        ...attrs,
                        value: props.modelValue,
                        onInput: (event: Event) => emit('update:modelValue', (event.target as HTMLInputElement).value),
                    }),
        }),
    );
    app.mount(host);
    onTestFinished(() => {
        app.unmount();
        host.remove();
    });
    await nextTick();
    const input = host.querySelector<HTMLInputElement>('#page-label-range-input')!;
    async function type(text: string) {
        input.value = text;
        input.dispatchEvent(new Event('input', {bubbles: true}));
        await nextTick();
    }
    return {host, input, selected, type};
}

describe('page numbering selection input', () => {
    it('selects each valid draft and retains the last accepted selection during invalid input', async () => {
        const {host, input, type} = await mountNumberingPanel();
        await type('2');
        expect(input.value).toBe('2');
        expect(host.querySelector('output')?.textContent).toBe('1');
        expect(host.querySelector('#page-label-target-summary')?.textContent).toContain('2');
        await type('2-');
        expect(input.value).toBe('2-');
        expect(host.querySelector('output')?.textContent).toBe('1');
        expect(host.querySelector('#page-label-target-summary')?.textContent).toBe('pageNumbering.rangeError');
        await type('2-4');
        expect(input.value).toBe('2-4');
        expect(host.querySelector('output')?.textContent).toBe('3');
        expect(host.querySelector('#page-label-target-summary')?.textContent).toContain('2-4');
    });

    it('ends an invalid draft when another selection is made', async () => {
        const {host, input, selected, type} = await mountNumberingPanel();
        await type('2');
        await type('2-');
        selected.value = createRangePageSelection(20, 5, 7);
        await nextTick();
        expect(input.value).toBe('5-7');
        expect(host.querySelector('output')?.textContent).toBe('3');
        expect(host.querySelector('#page-label-target-summary')?.textContent).toContain('5-7');
        expect(input.getAttribute('aria-invalid')).not.toBe('true');
    });
});

function createSelectionHarness(
    options: {
        currentPage?: number;
        keyboardMove?: 'move' | 'reorder';
        scrollPageIntoKeyboardView?: (page: number) => void | Promise<void>;
        selectedPages?: number[];
        totalPages?: number;
        pageSelection?: TPageSelection | null;
    } = {},
) {
    const totalPages = ref(options.totalPages ?? 5);
    const currentPage = ref(options.currentPage ?? 2);
    const selectedPages = ref(options.selectedPages ?? [2, 4]);
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
        const {onContextMenu, selection} = createSelectionHarness({
            pageSelection,
            totalPages: 1_000_000,
        });

        selection.handleThumbnailContextMenu(new MouseEvent('contextmenu'), 50_000);

        expect(onContextMenu).toHaveBeenCalledWith(
            expect.objectContaining({
                clickedPage: 50_000,
                selection: pageSelection,
            }),
        );
    });
    it('roves the tab stop from the current page and drops it for an empty document', () => {
        const {selection, totalPages} = createSelectionHarness({currentPage: 2});

        expect(selection.rovingFocusPage.value).toBe(2);

        totalPages.value = 0;
        expect(selection.rovingFocusPage.value).toBeNull();
    });

    it('moves keyboard focus with arrow keys without changing selection or the page', () => {
        const {focusPageElement, onGoToPage, onSelectedPagesChange, scrollPageIntoKeyboardView, selectedPages, selection} =
            createSelectionHarness({currentPage: 2});
        onSelectedPagesChange.mockClear();

        const event = keyEvent('ArrowDown');
        selection.handleContainerKeyDown(event);

        expect(event.defaultPrevented).toBe(true);
        expect(selection.rovingFocusPage.value).toBe(3);
        expect(scrollPageIntoKeyboardView).toHaveBeenCalledWith(3);
        expect(focusPageElement).toHaveBeenCalledWith(3);
        expect(onSelectedPagesChange).not.toHaveBeenCalled();
        expect(selectedPages.value).toEqual([2, 4]);
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
    ])('waits for a cross-segment $key scroll before focusing its target row', async ({currentPage, key, targetPage}) => {
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
        const {onGoToPage, onSelectedPagesChange, selection} = createSelectionHarness({currentPage: 2});
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
        const {focusPageElement, onGoToPage, onSelectedPagesChange, selectedPages, selection} = createSelectionHarness({currentPage: 2});
        onSelectedPagesChange.mockClear();

        const event = keyEvent('ArrowDown', {shiftKey: true});
        selection.handleContainerKeyDown(event);

        expect(event.defaultPrevented).toBe(true);
        expect(selectedPages.value).toEqual([4, 5]);
        expect(onGoToPage).toHaveBeenCalledWith(5);
        expect(focusPageElement).toHaveBeenCalledWith(5);
        expect(selection.rovingFocusPage.value).toBe(5);
    });

    it('starts a new keyboard range after an external clear and selection', async () => {
        const {selection, selectedPages, selectedPageSelection} = createSelectionHarness({
            totalPages: 20,
            selectedPages: [],
            pageSelection: createEmptyPageSelection(20),
        });

        selection.toggleSinglePageSelection(2);
        await nextTick();
        selection.handleContainerKeyDown(keyEvent('ArrowDown', {shiftKey: true}));
        await nextTick();
        expect(selectedPages.value).toEqual([2, 3]);

        selectedPageSelection.value = createEmptyPageSelection(20);
        selectedPages.value = [];
        await nextTick();
        selectedPageSelection.value = createRangePageSelection(20, 7, 8);
        selectedPages.value = [7, 8];
        await nextTick();

        selection.handleContainerKeyDown(keyEvent('ArrowDown', {shiftKey: true}));
        expect(selectedPages.value).toEqual([7, 8, 9]);
        expect(selection.isSelected(9)).toBe(true);
        expect(selection.isSelected(2)).toBe(false);
    });

    it('ignores key presses raised by controls nested inside a row', () => {
        const {onGoToPage, selection} = createSelectionHarness({currentPage: 2});
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
        const {focusPageElement, onGoToPage, scrollPageIntoKeyboardView, selection} = createSelectionHarness({
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
        const {focusPageElement, selection} = createSelectionHarness({currentPage: 2});

        for (const modifier of ['ctrlKey', 'metaKey', 'altKey']) {
            const event = keyEvent('ArrowDown', {[modifier]: true});
            selection.handleContainerKeyDown(event);
            expect(event.defaultPrevented).toBe(false);
        }

        expect(focusPageElement).not.toHaveBeenCalled();
        expect(selection.rovingFocusPage.value).toBe(2);
    });

    it('moves the focused selected pages with Alt+ArrowDown in the page model', () => {
        const {onMove, selection} = createSelectionHarness({
            currentPage: 2,
            keyboardMove: 'move',
            pageSelection: {
                kind: 'explicit',
                pageCount: 5,
                pages: [2, 4],
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
        const {onReorder, selection} = createSelectionHarness({
            currentPage: 2,
            keyboardMove: 'reorder',
            selectedPages: [2, 3],
        });

        const event = keyEvent('ArrowUp', {altKey: true});
        selection.handleContainerKeyDown(event);

        expect(event.defaultPrevented).toBe(true);
        expect(onReorder).toHaveBeenCalledWith([2, 3, 1, 4, 5]);
    });

    it('keeps a million-page shift selection in the model instead of a legacy array', () => {
        const {onPageSelectionChange, onSelectedPagesChange, selectedPageSelection, selectedPages, selection} = createSelectionHarness({
            currentPage: 2,
            pageSelection: {
                kind: 'none',
                pageCount: 1_000_000,
            },
            totalPages: 1_000_000,
        });
        onPageSelectionChange.mockClear();
        onSelectedPagesChange.mockClear();

        selection.handleThumbnailClick(new MouseEvent('click', {shiftKey: true}), 1_000_000);

        expect(onPageSelectionChange).toHaveBeenCalledOnce();
        expect(onPageSelectionChange.mock.calls[0]?.[0]).toEqual({
            kind: 'range',
            pageCount: 1_000_000,
            startPage: 2,
            endPage: 1_000_000,
        });
        expect(selectedPageSelection.value).toEqual(onPageSelectionChange.mock.calls[0]?.[0]);
        expect(onSelectedPagesChange).not.toHaveBeenCalled();
        expect(selectedPages.value).toEqual([2, 4]);
        expect(selection.isSelected(1_000_000)).toBe(true);
    });

    it('refuses a million-page legacy shift selection before allocating an all-pages array', () => {
        const {onSelectedPagesChange, onSelectionRefused, selectedPages, selection} = createSelectionHarness({totalPages: 1_000_000});
        onSelectedPagesChange.mockClear();

        selection.handleThumbnailClick(new MouseEvent('click', {shiftKey: true}), 1_000_000);

        expect(onSelectionRefused).toHaveBeenCalledWith({
            kind: 'page-count-limit',
            pageCount: 1_000_000,
            limit: 100_000,
        });
        expect(onSelectedPagesChange).not.toHaveBeenCalled();
        expect(selectedPages.value).toEqual([2, 4]);
    });
});
