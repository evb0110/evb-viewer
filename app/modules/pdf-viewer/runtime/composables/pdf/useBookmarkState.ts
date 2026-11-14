import { isEqual } from 'es-toolkit/predicate';
import type { IPdfBookmarkEntry } from '@app/types/pdfContracts';
import type { IPdfBookmarkChangePayload } from '@app/types/pdfUi';
import type {IWorkspaceMetadataRecovery} from '@contracts/workspaceCheckpoint';

export const useBookmarkState = (deps: {
    markDirty: () => void;
    preservesSourceReload?: () => boolean;
    onBookmarksSynchronized?: () => void;
    onBookmarksDirty?: () => void;
    onBookmarksSaved?: (written?: IPdfBookmarkEntry[]) => void;
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

    // Saved as `written`: what the outline shows now is unsaved where it differs.
    function markBookmarksSaved(written?: IPdfBookmarkEntry[]) {
        bookmarksDirty.value = written !== undefined && !isEqual(bookmarkItems.value, written);
        onBookmarksSaved?.(written);
    }

    function handleBookmarksChange(payload: IPdfBookmarkChangePayload) {
        const historyMode = payload.history ?? (payload.dirty ? 'record' : 'reset');
        if (historyMode === 'reset' && bookmarksResolved.value && deps.preservesSourceReload?.()) return;
        bookmarksResolved.value = true;
        bookmarkItems.value = payload.bookmarks;
        bookmarkRevision += 1;

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

    /** `differsFromBytes`: the outline differs from the working bytes even where it matches the saved file. */
    function captureRecovery(differsFromBytes = false): IWorkspaceMetadataRecovery['bookmarks'] {
        return bookmarksDirty.value || differsFromBytes ? {
            revision: bookmarkRevision,
            dirty: true,
            items: bookmarkItems.value,
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
