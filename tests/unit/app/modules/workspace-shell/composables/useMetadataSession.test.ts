import type {IPdfDocument} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
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
function createBookmark(title: string): IPdfBookmarkEntry {
    return {
        title,
        pageIndex: 0,
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
        markDirty: vi.fn(),
        fileHistoryMutationVersion: ref(0),
        fileHistorySessionVersion: ref(0),
        undoFile: vi.fn(async () => true),
        redoFile: vi.fn(async () => true),
    });
}

describe('useMetadataSession', () => {
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
