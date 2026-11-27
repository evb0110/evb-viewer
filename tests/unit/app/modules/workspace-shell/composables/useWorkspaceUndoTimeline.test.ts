import {describe, expect, it, vi} from 'vitest';
import {useWorkspaceCommandLedger} from '@app/modules/workspace-shell/composables/useWorkspaceCommandLedger';

function createDeferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return {
        promise,
        reject,
        resolve,
    };
}

describe('useWorkspaceCommandLedger', () => {
    it('uses direct producer registration as the natural cross-source order', async () => {
        const ledger = useWorkspaceCommandLedger();
        const calls: string[] = [];
        for (const source of ['file', 'annotation', 'metadata'] as const) {
            ledger.registerCommand({
                source,
                undo: () => {
                    calls.push(`undo:${source}`);
                    return true;
                },
                cmd: () => {
                    calls.push(`redo:${source}`);
                    return true;
                },
            });
        }

        expect(ledger.nextUndoSource.value).toBe('metadata');
        await ledger.undoTimeline();
        await ledger.undoTimeline();
        await ledger.undoTimeline();
        await ledger.redoTimeline();
        await ledger.redoTimeline();
        await ledger.redoTimeline();
        expect(calls).toEqual(['undo:metadata', 'undo:annotation', 'undo:file', 'redo:file', 'redo:annotation', 'redo:metadata']);
    });

    it('resets one producer without disturbing commands from other sources', async () => {
        const ledger = useWorkspaceCommandLedger();
        const undoFile = vi.fn(() => true);
        ledger.registerCommand({
            source: 'metadata',
            undo: () => true,
            cmd: () => true,
        });
        ledger.registerCommand({
            source: 'file',
            undo: undoFile,
            cmd: () => true,
        });
        ledger.resetSource('metadata');

        expect(ledger.nextUndoSource.value).toBe('file');
        await ledger.undoTimeline();
        expect(undoFile).toHaveBeenCalledOnce();
        expect(ledger.canUndoTimeline.value).toBe(false);
    });

    it('still drops every entry of a source that owns entity ids when the source resets', async () => {
        const ledger = useWorkspaceCommandLedger();
        const undoAnnotation = vi.fn(() => true);
        const undoFile = vi.fn(() => true);
        ledger.registerCommand({
            source: 'file',
            undo: undoFile,
            cmd: () => true,
        });
        ledger.registerCommand({
            source: 'annotation',
            undo: undoAnnotation,
            cmd: () => true,
            entityIds: ['shape-1'],
        });

        ledger.resetSource('annotation');

        expect(ledger.nextUndoSource.value).toBe('file');
        await ledger.undoTimeline();
        expect(undoFile).toHaveBeenCalledOnce();
        expect(undoAnnotation).not.toHaveBeenCalled();
        expect(ledger.canUndoTimeline.value).toBe(false);
        expect(ledger.nextRedoSource.value).toBe('file');
    });

    it('forgets only the entries that own a removed id inside one source', async () => {
        const ledger = useWorkspaceCommandLedger();
        const undoFile = vi.fn(() => true);
        const undoForgotten = vi.fn(() => true);
        const undoKept = vi.fn(() => true);
        ledger.registerCommand({
            source: 'file',
            undo: undoFile,
            cmd: () => true,
        });
        ledger.registerCommand({
            source: 'annotation',
            undo: undoForgotten,
            cmd: () => true,
            entityIds: ['shape-1'],
        });
        ledger.registerCommand({
            source: 'annotation',
            undo: undoKept,
            cmd: () => true,
            entityIds: ['note-2'],
        });

        ledger.forgetSourceEntries('annotation', new Set(['shape-1']));

        expect(ledger.nextUndoSource.value).toBe('annotation');
        await ledger.undoTimeline();
        expect(undoKept).toHaveBeenCalledOnce();
        expect(ledger.nextUndoSource.value).toBe('file');
        await ledger.undoTimeline();
        expect(undoFile).toHaveBeenCalledOnce();
        expect(undoForgotten).not.toHaveBeenCalled();
        expect(ledger.canUndoTimeline.value).toBe(false);
    });

    it('leaves another source holding the same entity id untouched', async () => {
        const ledger = useWorkspaceCommandLedger();
        const undoMetadata = vi.fn(() => true);
        ledger.registerCommand({
            source: 'metadata',
            undo: undoMetadata,
            cmd: () => true,
            entityIds: ['shape-1'],
        });
        ledger.registerCommand({
            source: 'annotation',
            undo: () => true,
            cmd: () => true,
            entityIds: ['shape-1'],
        });

        ledger.forgetSourceEntries('annotation', new Set(['shape-1']));

        expect(ledger.nextUndoSource.value).toBe('metadata');
        await ledger.undoTimeline();
        expect(undoMetadata).toHaveBeenCalledOnce();
    });

    it('keeps entries that claim no entity ids when an id is forgotten', async () => {
        const ledger = useWorkspaceCommandLedger();
        const undoUnowned = vi.fn(() => true);
        ledger.registerCommand({
            source: 'annotation',
            undo: undoUnowned,
            cmd: () => true,
        });

        ledger.forgetSourceEntries('annotation', new Set(['shape-1']));

        expect(ledger.canUndoTimeline.value).toBe(true);
        await ledger.undoTimeline();
        expect(undoUnowned).toHaveBeenCalledOnce();
    });

    it('keeps an undone survivor redoable when a forgotten entry precedes it', async () => {
        const ledger = useWorkspaceCommandLedger();
        const redoKept = vi.fn(() => true);
        ledger.registerCommand({
            source: 'annotation',
            undo: () => true,
            cmd: () => true,
            entityIds: ['shape-1'],
        });
        ledger.registerCommand({
            source: 'annotation',
            undo: () => true,
            cmd: redoKept,
            entityIds: ['note-2'],
        });
        await ledger.undoTimeline();

        ledger.forgetSourceEntries('annotation', new Set(['shape-1']));

        expect(ledger.canUndoTimeline.value).toBe(false);
        expect(ledger.canRedoTimeline.value).toBe(true);
        await ledger.redoTimeline();
        expect(redoKept).toHaveBeenCalledOnce();
    });

    it('treats an empty forget set as no work', async () => {
        const ledger = useWorkspaceCommandLedger();
        const undo = vi.fn(() => true);
        ledger.registerCommand({
            source: 'annotation',
            undo,
            cmd: () => true,
            entityIds: ['shape-1'],
        });

        ledger.forgetSourceEntries('annotation', new Set());

        expect(ledger.canUndoTimeline.value).toBe(true);
        await ledger.undoTimeline();
        expect(undo).toHaveBeenCalledOnce();
    });

    it('retires a stale command when its inverse reports no work', async () => {
        const ledger = useWorkspaceCommandLedger();
        ledger.registerCommand({
            source: 'annotation',
            undo: () => false,
            cmd: () => true,
        });

        expect(await ledger.undoTimeline()).toBe(false);
        expect(ledger.nextUndoSource.value).toBeNull();
    });

    it('enforces one cross-source byte budget', async () => {
        const ledger = useWorkspaceCommandLedger();
        const undo = vi.fn(() => true);
        ledger.registerCommand({
            source: 'annotation',
            undo,
            cmd: () => true,
            estimatedBytes: 20 * 1024 * 1024,
        });
        ledger.registerCommand({
            source: 'file',
            undo,
            cmd: () => true,
            estimatedBytes: 20 * 1024 * 1024,
        });

        expect(await ledger.undoTimeline()).toBe(true);
        expect(ledger.canUndoTimeline.value).toBe(false);
        expect(undo).toHaveBeenCalledOnce();
    });

    it('keeps the newest command undoable when it alone exceeds the byte budget', async () => {
        const ledger = useWorkspaceCommandLedger();
        const undo = vi.fn(() => true);
        ledger.registerCommand({
            source: 'file',
            undo,
            cmd: () => true,
            estimatedBytes: 64 * 1024 * 1024,
        });

        expect(ledger.canUndoTimeline.value).toBe(true);
        expect(ledger.nextUndoSource.value).toBe('file');
        await expect(ledger.undoTimeline()).resolves.toBe(true);
        expect(undo).toHaveBeenCalledOnce();
    });
});

describe('useWorkspaceCommandLedger pruning during an in-flight command', () => {
    it('does not skip a survivor when the pending undo target is forgotten mid-flight', async () => {
        const ledger = useWorkspaceCommandLedger();
        const undoFile = vi.fn(() => true);
        const forgottenUndo = createDeferred<boolean>();
        ledger.registerCommand({
            source: 'file',
            undo: undoFile,
            cmd: () => true,
        });
        ledger.registerCommand({
            source: 'annotation',
            undo: () => forgottenUndo.promise,
            cmd: () => true,
            entityIds: ['shape-1'],
        });

        const pendingUndo = ledger.undoTimeline();
        ledger.forgetSourceEntries('annotation', new Set(['shape-1']));
        forgottenUndo.resolve(true);

        await expect(pendingUndo).resolves.toBe(true);
        expect(ledger.nextUndoSource.value).toBe('file');
        expect(ledger.canRedoTimeline.value).toBe(false);
        await expect(ledger.undoTimeline()).resolves.toBe(true);
        expect(undoFile).toHaveBeenCalledOnce();
        expect(ledger.canUndoTimeline.value).toBe(false);
    });

    it('does not advance past a survivor when the pending redo target is forgotten mid-flight', async () => {
        const ledger = useWorkspaceCommandLedger();
        const undoFile = vi.fn(() => true);
        const forgottenRedo = createDeferred<boolean>();
        ledger.registerCommand({
            source: 'file',
            undo: undoFile,
            cmd: () => true,
        });
        ledger.registerCommand({
            source: 'annotation',
            undo: () => true,
            cmd: () => forgottenRedo.promise,
            entityIds: ['shape-1'],
        });
        await ledger.undoTimeline();

        const pendingRedo = ledger.redoTimeline();
        ledger.forgetSourceEntries('annotation', new Set(['shape-1']));
        forgottenRedo.resolve(true);

        await expect(pendingRedo).resolves.toBe(true);
        expect(ledger.canRedoTimeline.value).toBe(false);
        expect(ledger.nextRedoSource.value).toBeNull();
        expect(ledger.nextUndoSource.value).toBe('file');
        await expect(ledger.undoTimeline()).resolves.toBe(true);
        expect(undoFile).toHaveBeenCalledOnce();
        expect(ledger.canUndoTimeline.value).toBe(false);
    });

    it('settles a pending undo against the order an unrelated forget left behind', async () => {
        const ledger = useWorkspaceCommandLedger();
        const undoFile = vi.fn(() => true);
        const redoSurvivor = vi.fn(() => true);
        const survivorUndo = createDeferred<boolean>();
        ledger.registerCommand({
            source: 'file',
            undo: undoFile,
            cmd: () => true,
        });
        ledger.registerCommand({
            source: 'annotation',
            undo: () => true,
            cmd: () => true,
            entityIds: ['shape-1'],
        });
        ledger.registerCommand({
            source: 'annotation',
            undo: () => survivorUndo.promise,
            cmd: redoSurvivor,
            entityIds: ['note-2'],
        });

        const pendingUndo = ledger.undoTimeline();
        ledger.forgetSourceEntries('annotation', new Set(['shape-1']));
        survivorUndo.resolve(true);

        await expect(pendingUndo).resolves.toBe(true);
        expect(ledger.nextUndoSource.value).toBe('file');
        expect(ledger.nextRedoSource.value).toBe('annotation');
        await expect(ledger.redoTimeline()).resolves.toBe(true);
        expect(redoSurvivor).toHaveBeenCalledOnce();
        expect(ledger.canRedoTimeline.value).toBe(false);
        await expect(ledger.undoTimeline()).resolves.toBe(true);
        await expect(ledger.undoTimeline()).resolves.toBe(true);
        expect(undoFile).toHaveBeenCalledOnce();
    });

    it('settles a pending redo against the order an unrelated forget left behind', async () => {
        const ledger = useWorkspaceCommandLedger();
        const undoMiddle = vi.fn(() => true);
        const undoLatest = vi.fn(() => true);
        const latestRedo = createDeferred<boolean>();
        ledger.registerCommand({
            source: 'annotation',
            undo: () => true,
            cmd: () => true,
            entityIds: ['shape-1'],
        });
        ledger.registerCommand({
            source: 'file',
            undo: undoMiddle,
            cmd: () => true,
        });
        ledger.registerCommand({
            source: 'file',
            undo: undoLatest,
            cmd: () => latestRedo.promise,
        });
        await ledger.undoTimeline();

        const pendingRedo = ledger.redoTimeline();
        ledger.forgetSourceEntries('annotation', new Set(['shape-1']));
        latestRedo.resolve(true);

        await expect(pendingRedo).resolves.toBe(true);
        expect(ledger.canRedoTimeline.value).toBe(false);
        await expect(ledger.undoTimeline()).resolves.toBe(true);
        expect(undoLatest).toHaveBeenCalledTimes(2);
        await expect(ledger.undoTimeline()).resolves.toBe(true);
        expect(undoMiddle).toHaveBeenCalledOnce();
        expect(ledger.canUndoTimeline.value).toBe(false);
    });

    it('keeps a survivor undoable when the target source resets during a pending undo', async () => {
        const ledger = useWorkspaceCommandLedger();
        const undoFile = vi.fn(() => true);
        const annotationUndo = createDeferred<boolean>();
        ledger.registerCommand({
            source: 'file',
            undo: undoFile,
            cmd: () => true,
        });
        ledger.registerCommand({
            source: 'annotation',
            undo: () => annotationUndo.promise,
            cmd: () => true,
            entityIds: ['shape-1'],
        });

        const pendingUndo = ledger.undoTimeline();
        ledger.resetSource('annotation');
        annotationUndo.resolve(true);

        await expect(pendingUndo).resolves.toBe(true);
        expect(ledger.nextUndoSource.value).toBe('file');
        expect(ledger.canRedoTimeline.value).toBe(false);
        await expect(ledger.undoTimeline()).resolves.toBe(true);
        expect(undoFile).toHaveBeenCalledOnce();
    });

    it('stays empty when a full reset lands during a pending undo', async () => {
        const ledger = useWorkspaceCommandLedger();
        const undoFile = vi.fn(() => true);
        const annotationUndo = createDeferred<boolean>();
        ledger.registerCommand({
            source: 'file',
            undo: undoFile,
            cmd: () => true,
        });
        ledger.registerCommand({
            source: 'annotation',
            undo: () => annotationUndo.promise,
            cmd: () => true,
            entityIds: ['shape-1'],
        });

        const pendingUndo = ledger.undoTimeline();
        ledger.resetSource();
        annotationUndo.resolve(true);

        await expect(pendingUndo).resolves.toBe(true);
        expect(ledger.canUndoTimeline.value).toBe(false);
        expect(ledger.canRedoTimeline.value).toBe(false);
        expect(ledger.nextUndoSource.value).toBeNull();
        expect(ledger.nextRedoSource.value).toBeNull();
        await expect(ledger.undoTimeline()).resolves.toBe(false);
        await expect(ledger.redoTimeline()).resolves.toBe(false);
        expect(undoFile).not.toHaveBeenCalled();

        const undoNext = vi.fn(() => true);
        ledger.registerCommand({
            source: 'metadata',
            undo: undoNext,
            cmd: () => true,
        });

        expect(ledger.nextUndoSource.value).toBe('metadata');
        expect(ledger.canRedoTimeline.value).toBe(false);
        await expect(ledger.undoTimeline()).resolves.toBe(true);
        expect(undoNext).toHaveBeenCalledOnce();
        expect(ledger.canUndoTimeline.value).toBe(false);
    });

    it('stays empty when a full reset lands during a pending redo', async () => {
        const ledger = useWorkspaceCommandLedger();
        const redoAnnotation = createDeferred<boolean>();
        ledger.registerCommand({
            source: 'file',
            undo: () => true,
            cmd: () => true,
        });
        ledger.registerCommand({
            source: 'annotation',
            undo: () => true,
            cmd: () => redoAnnotation.promise,
            entityIds: ['shape-1'],
        });
        await ledger.undoTimeline();

        const pendingRedo = ledger.redoTimeline();
        ledger.resetSource();
        redoAnnotation.resolve(true);

        await expect(pendingRedo).resolves.toBe(true);
        expect(ledger.canUndoTimeline.value).toBe(false);
        expect(ledger.canRedoTimeline.value).toBe(false);
        expect(ledger.nextUndoSource.value).toBeNull();
        expect(ledger.nextRedoSource.value).toBeNull();
    });

    it('keeps a rejected undo target retryable at its rebased position', async () => {
        const ledger = useWorkspaceCommandLedger();
        const undoFile = vi.fn(() => true);
        const firstAttempt = createDeferred<boolean>();
        let attempts = 0;
        const undoSurvivor = vi.fn(() => {
            attempts += 1;
            return attempts === 1 ? firstAttempt.promise : true;
        });
        ledger.registerCommand({
            source: 'file',
            undo: undoFile,
            cmd: () => true,
        });
        ledger.registerCommand({
            source: 'annotation',
            undo: () => true,
            cmd: () => true,
            entityIds: ['shape-1'],
        });
        ledger.registerCommand({
            source: 'annotation',
            undo: undoSurvivor,
            cmd: () => true,
            entityIds: ['note-2'],
        });

        const pendingUndo = ledger.undoTimeline();
        ledger.forgetSourceEntries('annotation', new Set(['shape-1']));
        firstAttempt.reject(new Error('annotation replay failed'));

        await expect(pendingUndo).rejects.toThrow('annotation replay failed');
        expect(ledger.nextUndoSource.value).toBe('annotation');
        expect(ledger.canRedoTimeline.value).toBe(false);
        await expect(ledger.undoTimeline()).resolves.toBe(true);
        expect(undoSurvivor).toHaveBeenCalledTimes(2);
        expect(ledger.nextUndoSource.value).toBe('file');
        await expect(ledger.undoTimeline()).resolves.toBe(true);
        expect(undoFile).toHaveBeenCalledOnce();
    });

    it('retires a stale undo target below the position an unrelated forget left it at', async () => {
        const ledger = useWorkspaceCommandLedger();
        const undoFile = vi.fn(() => true);
        const staleUndo = createDeferred<boolean>();
        ledger.registerCommand({
            source: 'file',
            undo: undoFile,
            cmd: () => true,
        });
        ledger.registerCommand({
            source: 'annotation',
            undo: () => true,
            cmd: () => true,
            entityIds: ['shape-1'],
        });
        ledger.registerCommand({
            source: 'annotation',
            undo: () => staleUndo.promise,
            cmd: () => true,
            entityIds: ['note-2'],
        });

        const pendingUndo = ledger.undoTimeline();
        ledger.forgetSourceEntries('annotation', new Set(['shape-1']));
        staleUndo.resolve(false);

        await expect(pendingUndo).resolves.toBe(false);
        expect(ledger.nextUndoSource.value).toBe('file');
        expect(ledger.canRedoTimeline.value).toBe(false);
        await expect(ledger.undoTimeline()).resolves.toBe(true);
        expect(undoFile).toHaveBeenCalledOnce();
        expect(ledger.canUndoTimeline.value).toBe(false);
    });

    it('retires a stale undo target without adopting the entry queued for redo', async () => {
        const ledger = useWorkspaceCommandLedger();
        const undoBase = vi.fn(() => true);
        const undoLatest = vi.fn(() => true);
        const redoLatest = vi.fn(() => true);
        ledger.registerCommand({
            source: 'file',
            undo: undoBase,
            cmd: () => true,
        });
        ledger.registerCommand({
            source: 'annotation',
            undo: () => false,
            cmd: () => true,
        });
        ledger.registerCommand({
            source: 'file',
            undo: undoLatest,
            cmd: redoLatest,
        });
        await expect(ledger.undoTimeline()).resolves.toBe(true);

        await expect(ledger.undoTimeline()).resolves.toBe(false);

        expect(undoLatest).toHaveBeenCalledOnce();
        expect(ledger.nextUndoSource.value).toBe('file');
        expect(ledger.nextRedoSource.value).toBe('file');
        await expect(ledger.redoTimeline()).resolves.toBe(true);
        expect(redoLatest).toHaveBeenCalledOnce();
        await expect(ledger.undoTimeline()).resolves.toBe(true);
        expect(undoLatest).toHaveBeenCalledTimes(2);
        await expect(ledger.undoTimeline()).resolves.toBe(true);
        expect(undoBase).toHaveBeenCalledOnce();
    });

    it('does not resurrect a forgotten redo target that reports no work', async () => {
        const ledger = useWorkspaceCommandLedger();
        const undoFile = vi.fn(() => true);
        const forgottenRedo = createDeferred<boolean>();
        ledger.registerCommand({
            source: 'file',
            undo: undoFile,
            cmd: () => true,
        });
        ledger.registerCommand({
            source: 'annotation',
            undo: () => true,
            cmd: () => forgottenRedo.promise,
            entityIds: ['shape-1'],
        });
        await ledger.undoTimeline();

        const pendingRedo = ledger.redoTimeline();
        ledger.forgetSourceEntries('annotation', new Set(['shape-1']));
        forgottenRedo.resolve(false);

        await expect(pendingRedo).resolves.toBe(false);
        expect(ledger.canRedoTimeline.value).toBe(false);
        expect(ledger.nextUndoSource.value).toBe('file');
        await expect(ledger.undoTimeline()).resolves.toBe(true);
        expect(undoFile).toHaveBeenCalledOnce();
    });
});
