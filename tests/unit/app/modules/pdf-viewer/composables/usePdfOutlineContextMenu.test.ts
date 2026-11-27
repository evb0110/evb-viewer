import {beforeEach, describe, expect, it, vi} from 'vitest';
import {ref} from 'vue';
import type {IBookmarkItem} from '@app/types/pdfOutline';

const mocks = vi.hoisted(() => ({keydownListeners: [] as Array<(event: KeyboardEvent) => void>}));

vi.mock('@vueuse/core', () => ({
    useEventListener: vi.fn((_target: unknown, event: string, listener: (event: KeyboardEvent) => void) => {
        if (event === 'keydown') {
            mocks.keydownListeners.push(listener);
        }
        return vi.fn();
    }),
}));

vi.mock('@app/composables/usePositionedMenu', () => ({
    usePositionedMenu: <TMenuState>(_selector: string, createInitialState: () => TMenuState) => {
        const menu = ref(createInitialState());
        return {
            menu,
            showPositionedMenu: vi.fn((options: {buildState: (position: {x: number; y: number}) => TMenuState}) => {
                menu.value = options.buildState({
                    x: 10,
                    y: 20,
                });
            }),
            resetMenu: vi.fn(() => {
                menu.value = createInitialState();
            }),
        };
    },
}));

function createBookmark(id: string): IBookmarkItem {
    return {
        id,
        title: id,
        dest: null,
        pageIndex: null,
        bold: false,
        italic: false,
        color: null,
        items: [],
    };
}

describe('usePdfOutlineContextMenu', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        mocks.keydownListeners.length = 0;
        vi.stubGlobal('window', {addEventListener: vi.fn()});
        vi.stubGlobal('useTypedI18n', () => ({t: (key: string) => key}));
    });

    it('ignores app-wide Escape while the context menu is closed', async () => {
        const {usePdfOutlineContextMenu} = await import('@app/modules/pdf-viewer/runtime/composables/pdf/usePdfOutlineContextMenu');
        const onEscape = vi.fn();

        usePdfOutlineContextMenu(ref([createBookmark('first')]), ref(true), onEscape);

        mocks.keydownListeners[0]?.({key: 'Escape'} as KeyboardEvent);

        expect(onEscape).not.toHaveBeenCalled();
    });

    it('closes an open context menu on Escape and notifies the owner', async () => {
        const {usePdfOutlineContextMenu} = await import('@app/modules/pdf-viewer/runtime/composables/pdf/usePdfOutlineContextMenu');
        const onEscape = vi.fn();
        const contextMenu = usePdfOutlineContextMenu(ref([createBookmark('first')]), ref(true), onEscape);
        contextMenu.openBookmarkContextMenu({
            id: 'first',
            x: 5,
            y: 6,
        });
        expect(contextMenu.bookmarkContextMenu.value.visible).toBe(true);
        expect(contextMenu.selectedContextBookmark.value?.id).toBe('first');

        mocks.keydownListeners[0]?.({key: 'Escape'} as KeyboardEvent);

        expect(contextMenu.bookmarkContextMenu.value.visible).toBe(false);
        expect(contextMenu.selectedContextBookmark.value).toBeNull();
        expect(onEscape).toHaveBeenCalledOnce();
    });

    it('does not open the context menu outside edit mode', async () => {
        const {usePdfOutlineContextMenu} = await import('@app/modules/pdf-viewer/runtime/composables/pdf/usePdfOutlineContextMenu');
        const contextMenu = usePdfOutlineContextMenu(ref([createBookmark('first')]), ref(false), vi.fn());

        contextMenu.openBookmarkContextMenu({
            id: 'first',
            x: 5,
            y: 6,
        });

        expect(contextMenu.bookmarkContextMenu.value.visible).toBe(false);
    });
});
