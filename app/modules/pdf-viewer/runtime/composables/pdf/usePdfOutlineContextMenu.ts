import type {Ref} from 'vue';
import {useEventListener} from '@vueuse/core';
import type {IBookmarkItem, IBookmarkMenuPayload} from '@app/types/pdfOutline';
import {findBookmarkById} from '@app/utils/pdfOutlineHelpers';
import {usePositionedMenu} from '@app/composables/usePositionedMenu';

export const usePdfOutlineContextMenu = (bookmarks: Ref<IBookmarkItem[]>, isEditMode: Ref<boolean>, onEscape: () => void) => {
    const windowTarget = typeof window === 'undefined' ? undefined : window;

    interface IBookmarkContextMenuState {
        visible: boolean;
        x: number;
        y: number;
        itemId: string | null;
    }

    function createInitialBookmarkContextMenuState(): IBookmarkContextMenuState {
        return {
            visible: false,
            x: 0,
            y: 0,
            itemId: null,
        };
    }
    const {
        menu: bookmarkContextMenu,
        showPositionedMenu,
        resetMenu,
    } = usePositionedMenu<IBookmarkContextMenuState>('.bookmarks-context-menu', createInitialBookmarkContextMenuState, {
        autoDismiss: {
            onOutsideClick: true,
            onResize: true,
            onScroll: true,
        },
    });

    const selectedContextBookmark = computed(() => {
        const id = bookmarkContextMenu.value.itemId;
        if (!id) {
            return null;
        }

        return findBookmarkById(bookmarks.value, id);
    });

    function openBookmarkContextMenu(payload: IBookmarkMenuPayload) {
        if (!isEditMode.value) {
            return;
        }

        const fallbackWidth = 320;
        const fallbackHeight = 380;
        showPositionedMenu({
            x: payload.x,
            y: payload.y,
            fallbackWidth,
            fallbackHeight,
            buildState: (position) => ({
                visible: true,
                x: position.x,
                y: position.y,
                itemId: payload.id,
            }),
        });
    }

    function closeBookmarkContextMenu() {
        if (!bookmarkContextMenu.value.visible) {
            return;
        }

        resetMenu();
    }

    function handleGlobalKeydown(event: KeyboardEvent) {
        if (event.key !== 'Escape' || !bookmarkContextMenu.value.visible) {
            return;
        }

        closeBookmarkContextMenu();
        onEscape();
    }
    useEventListener(windowTarget, 'keydown', handleGlobalKeydown);

    return {
        bookmarkContextMenu,
        selectedContextBookmark,
        openBookmarkContextMenu,
        closeBookmarkContextMenu,
    };
};
