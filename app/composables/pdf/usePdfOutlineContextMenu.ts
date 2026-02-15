import {
    computed,
    ref,
    type Ref,
} from 'vue';
import {
    onClickOutside,
    useEventListener,
} from '@vueuse/core';
import type {
    IBookmarkItem,
    IBookmarkMenuPayload,
} from '@app/types/pdf-outline';
import {
    findBookmarkById,
    findBookmarkLocation,
    normalizeBookmarkColor,
} from '@app/utils/pdf-outline-helpers';
import { useContextMenuPosition } from '@app/composables/useContextMenuPosition';

export const usePdfOutlineContextMenu = (
    bookmarks: Ref<IBookmarkItem[]>,
    isEditMode: Ref<boolean>,
    styleRangeStartId: Ref<string | null>,
    emitBookmarksChange: () => void,
    onEscape: () => void,
) => {
    const { t } = useTypedI18n();
    const { clampToViewport } = useContextMenuPosition();
    const windowTarget = typeof window === 'undefined' ? undefined : window;

    const bookmarkContextMenu = ref<{
        visible: boolean;
        x: number;
        y: number;
        itemId: string | null;
    }>({
        visible: false,
        x: 0,
        y: 0,
        itemId: null,
    });

    const selectedContextBookmark = computed(() => {
        const id = bookmarkContextMenu.value.itemId;
        if (!id) {
            return null;
        }

        return findBookmarkById(bookmarks.value, id);
    });

    const styleRangeInfo = computed(() => {
        const selected = selectedContextBookmark.value;
        const startId = styleRangeStartId.value;
        if (!selected || !startId) {
            return null;
        }

        const startLocation = findBookmarkLocation(bookmarks.value, startId);
        const endLocation = findBookmarkLocation(bookmarks.value, selected.id);
        if (!startLocation || !endLocation || startLocation.list !== endLocation.list) {
            return null;
        }

        const start = Math.min(startLocation.index, endLocation.index);
        const end = Math.max(startLocation.index, endLocation.index);

        return {
            list: startLocation.list,
            start,
            end,
            count: end - start + 1,
        };
    });

    const canApplyStyleRange = computed(() => Boolean(styleRangeInfo.value));
    const contextMenuElement = computed(() => (
        typeof window === 'undefined'
            ? null
            : document.querySelector<HTMLElement>('.bookmarks-context-menu')
    ));

    const applyStyleRangeLabel = computed(() => {
        const info = styleRangeInfo.value;
        if (!info) {
            return t('bookmarks.applyStyleRange');
        }
        return t('bookmarks.applyStyleToCount', { count: info.count });
    });

    function openBookmarkContextMenu(payload: IBookmarkMenuPayload) {
        if (!isEditMode.value) {
            return;
        }

        const clamped = clampToViewport(payload.x, payload.y, 228, 380);

        bookmarkContextMenu.value = {
            visible: true,
            x: clamped.x,
            y: clamped.y,
            itemId: payload.id,
        };
    }

    function closeBookmarkContextMenu() {
        if (!bookmarkContextMenu.value.visible) {
            return;
        }

        bookmarkContextMenu.value = {
            visible: false,
            x: 0,
            y: 0,
            itemId: null,
        };
    }

    function setStyleRangeStart(id: string) {
        styleRangeStartId.value = id;
    }

    function applyContextStyleToRange() {
        const selected = selectedContextBookmark.value;
        const range = styleRangeInfo.value;
        if (!selected || !range) {
            return;
        }

        let changed = false;
        for (let index = range.start; index <= range.end; index += 1) {
            const target = range.list[index];
            if (!target) {
                continue;
            }

            const nextColor = normalizeBookmarkColor(selected.color);
            if (
                target.bold === selected.bold
                && target.italic === selected.italic
                && target.color === nextColor
            ) {
                continue;
            }

            target.bold = selected.bold;
            target.italic = selected.italic;
            target.color = nextColor;
            changed = true;
        }

        if (changed) {
            emitBookmarksChange();
        }
    }

    function handleGlobalKeydown(event: KeyboardEvent) {
        if (event.key === 'Escape') {
            closeBookmarkContextMenu();
            onEscape();
        }
    }
    onClickOutside(contextMenuElement, () => {
        if (!bookmarkContextMenu.value.visible) {
            return;
        }
        closeBookmarkContextMenu();
    }, { capture: true });
    useEventListener(windowTarget, 'keydown', handleGlobalKeydown);
    useEventListener(windowTarget, 'resize', closeBookmarkContextMenu);
    useEventListener(windowTarget, 'scroll', closeBookmarkContextMenu, { capture: true });

    return {
        bookmarkContextMenu,
        selectedContextBookmark,
        canApplyStyleRange,
        applyStyleRangeLabel,
        openBookmarkContextMenu,
        closeBookmarkContextMenu,
        setStyleRangeStart,
        applyContextStyleToRange,
    };
};
