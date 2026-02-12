import { ref } from 'vue';
import type { IPdfBookmarkEntry } from '@app/types/pdf';

export const useBookmarkState = (deps: {markDirty: () => void;}) => {
    const { markDirty } = deps;

    const bookmarkItems = ref<IPdfBookmarkEntry[]>([]);
    const bookmarksDirty = ref(false);
    const bookmarkEditMode = ref(false);

    function markBookmarksSaved() {
        bookmarksDirty.value = false;
    }

    function handleBookmarksChange(payload: {
        bookmarks: IPdfBookmarkEntry[];
        dirty: boolean;
    }) {
        bookmarkItems.value = payload.bookmarks;

        if (payload.dirty) {
            if (!bookmarksDirty.value) {
                markDirty();
            }
            bookmarksDirty.value = true;
            return;
        }

        bookmarksDirty.value = false;
    }

    return {
        bookmarkItems,
        bookmarksDirty,
        bookmarkEditMode,
        markBookmarksSaved,
        handleBookmarksChange,
    };
};
