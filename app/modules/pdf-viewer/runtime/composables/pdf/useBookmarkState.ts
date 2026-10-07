import type { IPdfBookmarkEntry } from '@app/types/pdfContracts';
import type { IPdfBookmarkChangePayload } from '@app/types/pdfUi';
import type {IWorkspaceMetadataRecovery} from '@contracts/workspaceCheckpoint';

export const useBookmarkState = (deps: {
    markDirty: () => void;
    onBookmarksSynchronized?: () => void;
    onBookmarksDirty?: () => void;
    onBookmarksSaved?: () => void;
}) => {
    const {
        onBookmarksSynchronized,
        onBookmarksDirty,
        onBookmarksSaved,
    } = deps;

    // Replaced wholesale, never mutated in place, and posted to the
    // serialization worker: deep reactivity would hand out a Proxy that
    // structured clone refuses.
    const bookmarkItems = shallowRef<IPdfBookmarkEntry[]>([]);
    const bookmarksResolved = ref(false);
    const bookmarksDirty = ref(false);
    const bookmarkEditMode = ref(false);
    let bookmarkRevision = 0;

    function markBookmarksSaved() {
        bookmarksDirty.value = false;
        onBookmarksSaved?.();
    }

    function handleBookmarksChange(payload: IPdfBookmarkChangePayload) {
        bookmarksResolved.value = true;
        bookmarkItems.value = payload.bookmarks;
        bookmarkRevision += 1;
        const historyMode = payload.history ?? (payload.dirty ? 'record' : 'reset');

        if (historyMode === 'record') {
            bookmarksDirty.value = payload.dirty;
            onBookmarksDirty?.();
            return;
        }

        bookmarksDirty.value = false;
        onBookmarksSynchronized?.();
    }

    function getBookmarksRevision() {
        return bookmarkRevision;
    }

    function captureRecovery(): IWorkspaceMetadataRecovery['bookmarks'] {
        return bookmarksDirty.value ? {
            revision: bookmarkRevision,
            dirty: true,
            items: structuredClone(bookmarkItems.value),
        } : undefined;
    }

    function restoreRecovery(recovery: NonNullable<IWorkspaceMetadataRecovery['bookmarks']>) {
        handleBookmarksChange({
            bookmarks: structuredClone(recovery.items),
            dirty: true,
            history: 'record',
        });
        bookmarkRevision = Math.max(bookmarkRevision, recovery.revision);
    }

    return {
        bookmarkItems,
        bookmarksResolved,
        bookmarksDirty,
        bookmarkEditMode,
        markBookmarksSaved,
        getBookmarksRevision,
        handleBookmarksChange,
        captureRecovery,
        restoreRecovery,
    };
};
