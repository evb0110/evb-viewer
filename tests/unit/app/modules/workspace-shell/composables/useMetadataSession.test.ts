import type {IPdfDocument} from '@app/modules/pdf-viewer/public';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    ref,
    shallowRef,
} from 'vue';
import { useMetadataSession } from '@app/modules/workspace-shell/composables/useMetadataSession';
import type {IPdfBookmarkEntry} from '@app/types/pdfContracts';
import {requirePageIndex} from '@contracts/pageNumbers';
import {requireDocumentRef} from '@contracts/documentRef';
function createBookmark(title: string): IPdfBookmarkEntry {
    return {
        title,
        pageIndex: requirePageIndex(0),
        namedDest: null,
        bold: false,
        italic: false,
        color: null,
        items: [],
    };
}

function createSession() {
    return useMetadataSession({
        pdfDocument: shallowRef<IPdfDocument | null>(null),
        totalPages: ref(1),
        workingCopyPath: ref(requireDocumentRef('/tmp/work.pdf')),
        markDirty: vi.fn(),
        fileHistoryMutationVersion: ref(0),
        fileHistorySessionVersion: ref(0),
        undoFile: vi.fn(async () => true),
        redoFile: vi.fn(async () => true),
    });
}

describe('useMetadataSession', () => {
    it('recovers metadata against the admitted saved baseline without manufacturing undo history', async () => {
        const source = createSession();
        source.bookmarkState.handleBookmarksChange({
            bookmarks: [createBookmark('Base')],
            dirty: false,
        });
        source.bookmarkState.handleBookmarksChange({
            bookmarks: [createBookmark('Recovered')],
            dirty: true,
        });
        source.pageLabelState.handlePageLabelRangesUpdate([{
            startPage: 1,
            style: 'r',
            prefix: 'Recovered ',
            startNumber: 1,
        }]);
        const recovery = source.captureRecovery();
        const restored = createSession();
        restored.bookmarkState.handleBookmarksChange({
            bookmarks: [createBookmark('Base')],
            dirty: false,
        });
        restored.restoreRecovery(recovery);
        expect(restored.bookmarkState.bookmarkItems.value).toEqual([createBookmark('Recovered')]);
        expect(restored.pageLabelState.labelAt(1)).toBe('Recovered i');
        expect(restored.bookmarkState.bookmarksDirty.value).toBe(true);
        expect(restored.pageLabelState.pageLabelsDirty.value).toBe(true);
        expect(await restored.workspaceUndoTimeline.undoTimeline()).toBe(false);
        restored.bookmarkState.handleBookmarksChange({
            bookmarks: [createBookmark('Later')],
            dirty: true,
        });
        expect(await restored.workspaceUndoTimeline.undoTimeline()).toBe(true);
        expect(restored.bookmarkState.bookmarkItems.value).toEqual([createBookmark('Recovered')]);
        expect(restored.bookmarkState.bookmarksDirty.value).toBe(true);
    });

    it('keeps bookmark edits undoable when the edit returns to the clean state', async () => {
        const session = createSession();
        const bookmark = createBookmark('Transient bookmark');

        session.bookmarkState.handleBookmarksChange({
            bookmarks: [bookmark],
            dirty: true,
            history: 'record',
        });
        session.bookmarkState.handleBookmarksChange({
            bookmarks: [],
            dirty: false,
            history: 'record',
        });

        expect(session.bookmarkState.bookmarksDirty.value).toBe(false);
        expect(session.workspaceUndoTimeline.canUndoTimeline.value).toBe(true);
        expect(session.workspaceUndoTimeline.nextUndoSource.value).toBe('metadata');

        expect(await session.workspaceUndoTimeline.undoTimeline()).toBe(true);
        expect(session.bookmarkState.bookmarkItems.value).toEqual([bookmark]);
        expect(session.bookmarkState.bookmarksDirty.value).toBe(true);
    });

    it('keeps bookmark edits undoable after the current state is marked saved', async () => {
        const session = createSession();
        const bookmark = createBookmark('Saved bookmark');

        session.bookmarkState.handleBookmarksChange({
            bookmarks: [bookmark],
            dirty: true,
            history: 'record',
        });
        session.bookmarkState.markBookmarksSaved();

        expect(session.bookmarkState.bookmarksDirty.value).toBe(false);
        expect(session.workspaceUndoTimeline.canUndoTimeline.value).toBe(true);

        expect(await session.workspaceUndoTimeline.undoTimeline()).toBe(true);
        expect(session.bookmarkState.bookmarkItems.value).toEqual([]);
        expect(session.bookmarkState.bookmarksDirty.value).toBe(true);
    });

    it('restores preserved dirty metadata across a source reload before marking it saved', async () => {
        const session = createSession();
        const bookmark = createBookmark('Preserved bookmark');

        session.bookmarkState.handleBookmarksChange({
            bookmarks: [bookmark],
            dirty: true,
            history: 'record',
        });
        session.preserveMetadataForNextSourceReload();

        session.bookmarkState.bookmarkItems.value = [];
        session.bookmarkState.bookmarksDirty.value = false;

        expect(session.consumePreservedSourceReloadMetadata()).toBe(true);
        expect(session.bookmarkState.bookmarkItems.value).toEqual([bookmark]);
        expect(session.bookmarkState.bookmarksDirty.value).toBe(true);

        session.bookmarkState.markBookmarksSaved();

        expect(session.bookmarkState.bookmarksDirty.value).toBe(false);
        expect(await session.workspaceUndoTimeline.undoTimeline()).toBe(true);
        expect(session.bookmarkState.bookmarkItems.value).toEqual([]);
        expect(session.bookmarkState.bookmarksDirty.value).toBe(true);
    });
});
