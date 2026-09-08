import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {AnnotationStore} from '@app/modules/pdf-viewer/annotations/domain/annotationStore';
import {
    asAnnotationId,
    type INoteEntity,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import {usePdfAppAnnotationHistory} from '@app/modules/pdf-viewer/runtime/annotations/usePdfAppAnnotationHistory';
import {
    AnnotationHistoryIndeterminateError,
    LocalAnnotationHistoryAuthority,
} from '@app/modules/pdf-viewer/engine/annotations/annotation-history/pdfAppAnnotationHistoryCommand';
import {useWorkspaceCommandLedger} from '@app/modules/workspace-shell/composables/useWorkspaceCommandLedger';
import {requirePageIndex} from '@contracts/pageNumbers';

function setup() {
    const ledger = useWorkspaceCommandLedger();
    const history = usePdfAppAnnotationHistory({
        emitAnnotationState: vi.fn(),
        markModified: vi.fn(),
    });
    history.setWorkspaceCommandSink({
        register: ledger.registerCommand,
        reset: ledger.resetSource,
        forget: ledger.forgetSourceEntries,
    });
    const store = new AnnotationStore({
        get canUndo() { return history.canUndo.value; },
        get canRedo() { return history.canRedo.value; },
        registerCommand: history.registerCommand,
        forgetCommands: history.forgetCommands,
        undo: history.undo,
        redo: history.redo,
    });
    const note: INoteEntity = {
        kind: 'note',
        identity: {
            id: asAnnotationId('retained-thread'),
            pdfRef: '10 0 R',
        },
        pageIndex: requirePageIndex(0),
        revision: 0,
        persistedRevision: 0,
        deleted: false,
        author: null,
        createdAt: null,
        modifiedAt: null,
        contents: 'thread',
        position: {
            left: 0.2,
            top: 0.2,
            width: 0.02,
            height: 0.02,
        },
        color: '#ffff00',
        open: false,
        recoveryData: '01'.repeat(256 * 1024),
    };
    store.replaceFromDocument([note], []);
    return {
        ledger,
        history,
        store,
        note,
    };
}
function saveDeletion(store: AnnotationStore) {
    store.markPersisted(store.beginSave());
    store.replaceFromDocument([], []);
}

describe('saved annotation history retention', () => {
    it('releases every command without masking the original replay failure', () => {
        const history = new LocalAnnotationHistoryAuthority();
        const failure = new AnnotationHistoryIndeterminateError(new Error('replay failed'));
        const firstRelease = vi.fn(() => { throw new Error('release failed'); });
        const secondRelease = vi.fn();
        history.registerCommand({
            cmd: vi.fn(),
            undo: vi.fn(),
            onDiscard: firstRelease,
        });
        history.registerCommand({
            cmd: vi.fn(),
            undo: () => { throw failure; },
            onDiscard: secondRelease,
        });
        expect(() => history.undo()).toThrow(failure);
        expect(firstRelease).toHaveBeenCalledOnce();
        expect(secondRelease).toHaveBeenCalledOnce();
        expect(history.canUndo).toBe(false);
        expect(history.canRedo).toBe(false);
    });

    it('reports undo of an unsaved creation as a definitive removal until redo restores it', () => {
        const {note} = setup();
        const store = new AnnotationStore();
        store.createNote({
            ...note,
            identity: {id: note.identity.id},
            persistedRevision: -1,
        });
        expect(store.deletedAnnotationIds()).toEqual([]);
        expect(store.undo()).toBe(true);
        expect(store.get(note.identity.id)).toBeNull();
        expect(store.deletedAnnotationIds()).toEqual([note.identity.id]);
        expect(store.redo()).toBe(true);
        expect(store.deletedAnnotationIds()).toEqual([]);
    });

    it('releases a saved deleted graph when the shared workspace byte budget evicts its final command', async () => {
        const {
            ledger,
            store,
            note,
        } = setup();
        store.delete(note.identity.id);
        saveDeletion(store);
        expect(store.get(note.identity.id)?.deleted).toBe(true);
        expect(ledger.nextUndoSource.value).toBe('annotation');
        const fileUndo = vi.fn(() => true);
        ledger.registerCommand({
            source: 'file',
            estimatedBytes: 32 * 1024 * 1024,
            undo: fileUndo,
            cmd: () => true,
        });
        expect(store.get(note.identity.id)).toBeNull();
        expect(store.hasChangesSinceSavedBaseline()).toBe(false);
        expect(store.dirtyEntities()).toEqual([]);
        await expect(ledger.undoTimeline()).resolves.toBe(true);
        expect(fileUndo).toHaveBeenCalledOnce();
        expect(ledger.canUndoTimeline.value).toBe(false);
    });

    it('keeps recovery while any command can restore it, then releases it on history reset', async () => {
        const {
            ledger,
            store,
            note,
        } = setup();
        store.updateNote(note.identity.id, {contents: 'edited thread'});
        store.delete(note.identity.id);
        saveDeletion(store);
        expect(store.get(note.identity.id)?.kind).toBe('note');
        await expect(ledger.undoTimeline()).resolves.toBe(true);
        const restored = store.get(note.identity.id);
        expect(restored).toMatchObject({
            contents: 'edited thread',
            deleted: false,
        });
        expect(restored?.identity.pdfRef).toBeUndefined();
        await expect(ledger.redoTimeline()).resolves.toBe(true);
        expect(store.get(note.identity.id)?.deleted).toBe(true);
        ledger.resetTimeline();
        expect(store.get(note.identity.id)).toBeNull();
        expect(store.hasChangesSinceSavedBaseline()).toBe(false);
    });

    it('retains an unsaved deletion until it is committed even when its command expires', () => {
        const {
            ledger,
            store,
            note,
        } = setup();
        store.delete(note.identity.id);
        ledger.resetTimeline();
        expect(store.dirtyEntities()).toHaveLength(1);
        saveDeletion(store);
        expect(store.get(note.identity.id)).toBeNull();
        expect(store.hasChangesSinceSavedBaseline()).toBe(false);
    });
});
