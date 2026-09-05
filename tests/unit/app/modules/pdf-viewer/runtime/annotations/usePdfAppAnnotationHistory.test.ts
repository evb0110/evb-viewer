import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';
import { usePdfAppAnnotationHistory } from '@app/modules/pdf-viewer/runtime/annotations/usePdfAppAnnotationHistory';
import {
    AnnotationHistoryCompensationError,
    AnnotationHistoryIndeterminateError,
} from '@app/modules/pdf-viewer/engine/annotations/annotation-history/pdfAppAnnotationHistoryCommand';
import {useWorkspaceCommandLedger} from '@app/modules/workspace-shell/composables/useWorkspaceCommandLedger';
import {BrowserLogger} from '@app/utils/browserLogger';
import {asAnnotationId} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import type { IAnnotationEditorState } from '@app/types/annotations';

function createAnnotationState(overrides: Partial<IAnnotationEditorState> = {}): IAnnotationEditorState {
    return {
        isEditing: false,
        isEmpty: true,
        hasSomethingToUndo: false,
        hasSomethingToRedo: false,
        hasSelectedEditor: false,
        ...overrides,
    };
}

describe('usePdfAppAnnotationHistory', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('keeps app history availability out of the internal PDF.js state', () => {
        const pdfjsAnnotationState = ref(createAnnotationState());
        const emittedStates: IAnnotationEditorState[] = [];
        const history = usePdfAppAnnotationHistory({
            pdfjsAnnotationState,
            emitAnnotationState: state => emittedStates.push(state),
            markModified: vi.fn(),
        });

        history.registerCommand({
            cmd: vi.fn(),
            undo: vi.fn(),
        });

        expect(pdfjsAnnotationState.value.hasSomethingToUndo).toBe(false);
        expect(emittedStates.at(-1)).toMatchObject({
            hasSomethingToUndo: true,
            hasAppAnnotationUndoHistory: true,
        });
    });

    it('transfers a canonical create command into the workspace stack on first attach', async () => {
        const ledger = useWorkspaceCommandLedger();
        let present = true;
        const history = usePdfAppAnnotationHistory({
            pdfjsAnnotationState: ref(createAnnotationState()),
            emitAnnotationState: vi.fn(),
            markModified: vi.fn(),
        });

        history.registerCommand({
            annotationIds: [asAnnotationId('canonical-shape')],
            cmd: () => {
                present = true;
            },
            undo: () => {
                present = false;
            },
        });
        history.setWorkspaceCommandSink({
            register: ledger.registerCommand,
            reset: ledger.resetSource,
            forget: ledger.forgetSourceEntries,
        });

        expect(ledger.canUndoTimeline.value).toBe(true);
        await expect(ledger.undoTimeline()).resolves.toBe(true);
        expect(present).toBe(false);
        expect(ledger.canRedoTimeline.value).toBe(true);
        await expect(ledger.redoTimeline()).resolves.toBe(true);
        expect(present).toBe(true);
    });

    it('keeps the workspace command across a renderer target swap', async () => {
        const ledger = useWorkspaceCommandLedger();
        let present = true;
        const history = usePdfAppAnnotationHistory({
            pdfjsAnnotationState: ref(createAnnotationState()),
            emitAnnotationState: vi.fn(),
            markModified: vi.fn(),
        });
        const sink = {
            register: ledger.registerCommand,
            reset: ledger.resetSource,
            forget: ledger.forgetSourceEntries,
        };

        history.setWorkspaceCommandSink(sink);
        history.registerCommand({
            cmd: () => {
                present = true;
            },
            undo: () => {
                present = false;
            },
        });
        history.setWorkspaceCommandSink(null);
        history.setWorkspaceCommandSink(sink);

        expect(ledger.canUndoTimeline.value).toBe(true);
        await expect(ledger.undoTimeline()).resolves.toBe(true);
        expect(present).toBe(false);
    });

    it('routes editor history through the workspace timeline when attached', async () => {
        const ledger = useWorkspaceCommandLedger();
        const workspaceUndo = vi.fn(async () => true);
        const workspaceRedo = vi.fn(async () => true);
        const history = usePdfAppAnnotationHistory({
            pdfjsAnnotationState: ref(createAnnotationState()),
            emitAnnotationState: vi.fn(),
            markModified: vi.fn(),
        });

        history.setWorkspaceCommandSink({
            register: ledger.registerCommand,
            reset: ledger.resetSource,
            forget: ledger.forgetSourceEntries,
            undo: workspaceUndo,
            redo: workspaceRedo,
        });

        await expect(history.undoForEditor()).resolves.toBe(true);
        await expect(history.redoForEditor()).resolves.toBe(true);
        expect(workspaceUndo).toHaveBeenCalledOnce();
        expect(workspaceRedo).toHaveBeenCalledOnce();
    });

    it('reports app-owned executor command availability without rewriting native state', () => {
        const pdfjsAnnotationState = ref(createAnnotationState());
        const emittedStates: IAnnotationEditorState[] = [];
        const markModified = vi.fn();
        const undo = vi.fn();
        const cmd = vi.fn();
        const history = usePdfAppAnnotationHistory({
            pdfjsAnnotationState,
            emitAnnotationState: state => emittedStates.push(state),
            markModified,
        });

        history.registerExecutorCommand({
            cmd,
            undo,
        });
        pdfjsAnnotationState.value = createAnnotationState({ hasSomethingToUndo: true });

        expect(history.undo()).toBe(true);

        expect(undo).toHaveBeenCalledOnce();
        expect(pdfjsAnnotationState.value.hasSomethingToUndo).toBe(true);
        expect(pdfjsAnnotationState.value.hasSomethingToRedo).toBe(false);
        expect(emittedStates.at(-1)).toMatchObject({
            hasSomethingToUndo: false,
            hasSomethingToRedo: true,
            hasAppAnnotationUndoHistory: false,
            hasAppAnnotationRedoHistory: true,
        });

        expect(history.redo()).toBe(true);

        expect(cmd).toHaveBeenCalledOnce();
        expect(emittedStates.at(-1)).toMatchObject({
            hasSomethingToUndo: true,
            hasSomethingToRedo: false,
            hasAppAnnotationUndoHistory: true,
            hasAppAnnotationRedoHistory: false,
        });
        expect(markModified).toHaveBeenCalledTimes(2);
    });

    it('uses only captured executor operations owned by the app history', () => {
        const undo = vi.fn();
        const cmd = vi.fn();
        const history = usePdfAppAnnotationHistory({
            pdfjsAnnotationState: ref(createAnnotationState()),
            emitAnnotationState: () => {},
            markModified: vi.fn(),
        });
        history.registerExecutorCommand({
            undo,
            cmd,
        });

        expect(history.undo()).toBe(true);
        expect(undo).toHaveBeenCalledOnce();
        expect(history.redo()).toBe(true);
        expect(cmd).toHaveBeenCalledOnce();
    });

    it('advances local executor history once when post-replay notifications throw', () => {
        const state = ['applied'];
        const markFailure = new Error('mark modified failed');
        const projectionFailure = new Error('projection sync failed');
        const markModified = vi.fn(() => {
            throw markFailure;
        });
        const replayEffect = vi.fn(() => {
            throw projectionFailure;
        });
        const warn = vi.spyOn(BrowserLogger, 'warn').mockImplementation(() => {});
        const undo = vi.fn(() => state.pop());
        const cmd = vi.fn(() => state.push('applied'));
        const emitAnnotationState = vi.fn();
        const history = usePdfAppAnnotationHistory({
            pdfjsAnnotationState: ref(createAnnotationState()),
            emitAnnotationState,
            markModified,
        });
        history.setReplayEffect(replayEffect);
        history.registerExecutorCommand({
            undo,
            cmd,
        });
        emitAnnotationState.mockClear();

        expect(history.undo()).toBe(true);
        expect(state).toEqual([]);
        expect(history.canUndo.value).toBe(false);
        expect(history.canRedo.value).toBe(true);
        expect(history.undo()).toBe(false);
        expect(undo).toHaveBeenCalledOnce();

        expect(history.redo()).toBe(true);
        expect(state).toEqual(['applied']);
        expect(cmd).toHaveBeenCalledOnce();
        expect(markModified).toHaveBeenCalledTimes(2);
        expect(replayEffect).toHaveBeenCalledTimes(2);
        expect(emitAnnotationState).toHaveBeenCalledTimes(2);
        expect(warn).toHaveBeenCalledTimes(4);
        expect(warn).toHaveBeenCalledWith(
            'annotations',
            'Failed to mark the document modified after replay',
            markFailure,
        );
        expect(warn).toHaveBeenCalledWith(
            'annotations',
            'Failed to synchronize annotation projections after replay',
            projectionFailure,
        );
    });

    it('restores local stacks when history trimming throws after a command applies', () => {
        const state = ['applied'];
        const trimFailure = new Error('history size read failed');
        let failSizeRead = false;
        const history = usePdfAppAnnotationHistory({
            pdfjsAnnotationState: ref(createAnnotationState()),
            emitAnnotationState: vi.fn(),
            markModified: vi.fn(),
        });
        const command = {
            cmd: () => state.push('applied'),
            undo: (registerFailureRollback?: (rollback: () => void) => void) => {
                state.pop();
                registerFailureRollback?.(() => state.push('applied'));
            },
            get estimatedBytes() {
                if (failSizeRead) {
                    throw trimFailure;
                }
                return 1024;
            },
        };
        history.registerExecutorCommand(command);
        failSizeRead = true;

        let received: unknown;
        try {
            history.undo();
        } catch (error) {
            received = error;
        }

        expect(received).toBe(trimFailure);
        expect(state).toEqual(['applied']);
        expect(history.canUndo.value).toBe(true);
        expect(history.canRedo.value).toBe(false);

        failSizeRead = false;
        expect(history.undo()).toBe(true);
        expect(state).toEqual([]);
        expect(history.canUndo.value).toBe(false);
        expect(history.canRedo.value).toBe(true);
    });

    it('keeps a failed redo available until its command succeeds', () => {
        let rejectRedo = true;
        const history = usePdfAppAnnotationHistory({
            pdfjsAnnotationState: ref(createAnnotationState()),
            emitAnnotationState: () => {},
            markModified: vi.fn(),
        });
        history.registerCommand({
            undo: vi.fn(),
            cmd: () => {
                if (rejectRedo) throw new Error('identity conflict');
            },
        });
        history.undo();

        expect(() => history.redo()).toThrow('identity conflict');
        expect(history.canUndo.value).toBe(false);
        expect(history.canRedo.value).toBe(true);

        rejectRedo = false;
        expect(history.redo()).toBe(true);
        expect(history.canUndo.value).toBe(true);
        expect(history.canRedo.value).toBe(false);
    });

    it('groups canonical and executor commands into one user-visible history step', () => {
        const calls: string[] = [];
        const history = usePdfAppAnnotationHistory({
            pdfjsAnnotationState: ref(createAnnotationState()),
            emitAnnotationState: () => {},
            markModified: vi.fn(),
        });

        history.runTransaction(() => {
            history.registerExecutorCommand({
                cmd: () => calls.push('executor-redo'),
                undo: () => calls.push('executor-undo'),
            });
            history.registerCommand({
                cmd: () => calls.push('canonical-redo'),
                undo: () => calls.push('canonical-undo'),
            });
        });

        expect(history.undo()).toBe(true);
        expect(history.canUndo.value).toBe(false);
        expect(calls).toEqual([
            'canonical-undo',
            'executor-undo',
        ]);
        expect(history.redo()).toBe(true);
        expect(calls).toEqual([
            'canonical-undo',
            'executor-undo',
            'executor-redo',
            'canonical-redo',
        ]);
    });

    it('compensates a transaction redo that fails before or after its child effect', () => {
        const state = [
            'first',
            'second',
        ];
        const beforeFailure = new Error('second redo failed before mutation');
        const afterFailure = new Error('second redo failed after mutation');
        let failureTiming: 'before' | 'after' | null = 'before';
        const history = usePdfAppAnnotationHistory({
            pdfjsAnnotationState: ref(createAnnotationState()),
            emitAnnotationState: () => {},
            markModified: vi.fn(),
        });
        history.runTransaction(() => {
            history.registerCommand({
                cmd: () => state.push('first'),
                undo: () => state.pop(),
            });
            history.registerCommand({
                cmd: (registerFailureRollback) => {
                    if (failureTiming === 'before') throw beforeFailure;
                    state.push('second');
                    registerFailureRollback?.(() => state.pop());
                    if (failureTiming === 'after') throw afterFailure;
                },
                undo: () => state.pop(),
            });
        });
        history.undo();
        expect(state).toEqual([]);

        let received: unknown;
        try {
            history.redo();
        } catch (error) {
            received = error;
        }
        expect(received).toBe(beforeFailure);
        expect(state).toEqual([]);
        expect(history.canRedo.value).toBe(true);

        failureTiming = 'after';
        received = undefined;
        try {
            history.redo();
        } catch (error) {
            received = error;
        }
        expect(received).toBe(afterFailure);
        expect(state).toEqual([]);
        expect(history.canRedo.value).toBe(true);

        failureTiming = null;
        expect(history.redo()).toBe(true);
        expect(state).toEqual([
            'first',
            'second',
        ]);
    });

    it('compensates a transaction undo that fails before or after its child effect', () => {
        const state = [
            'first',
            'second',
        ];
        const beforeFailure = new Error('first undo failed before mutation');
        const afterFailure = new Error('first undo failed after mutation');
        let failureTiming: 'before' | 'after' | null = 'before';
        const history = usePdfAppAnnotationHistory({
            pdfjsAnnotationState: ref(createAnnotationState()),
            emitAnnotationState: () => {},
            markModified: vi.fn(),
        });
        history.runTransaction(() => {
            history.registerCommand({
                cmd: () => state.push('first'),
                undo: (registerFailureRollback) => {
                    if (failureTiming === 'before') throw beforeFailure;
                    const removed = state.pop();
                    registerFailureRollback?.(() => {
                        if (removed) state.push(removed);
                    });
                    if (failureTiming === 'after') throw afterFailure;
                },
            });
            history.registerCommand({
                cmd: () => state.push('second'),
                undo: () => state.pop(),
            });
        });

        let received: unknown;
        try {
            history.undo();
        } catch (error) {
            received = error;
        }
        expect(received).toBe(beforeFailure);
        expect(state).toEqual([
            'first',
            'second',
        ]);
        expect(history.canUndo.value).toBe(true);

        failureTiming = 'after';
        received = undefined;
        try {
            history.undo();
        } catch (error) {
            received = error;
        }
        expect(received).toBe(afterFailure);
        expect(state).toEqual([
            'first',
            'second',
        ]);
        expect(history.canUndo.value).toBe(true);

        failureTiming = null;
        expect(history.undo()).toBe(true);
        expect(state).toEqual([]);
    });

    it('attempts every transaction rollback and poisons retryable history when compensation fails', () => {
        const state = [
            'first',
            'second',
        ];
        const replayFailure = new Error('second redo failed after mutation');
        const activeRollbackFailure = new Error('second rollback failed');
        const priorRollbackFailure = new Error('first rollback failed');
        let failRedo = false;
        let failCompensation = false;
        const firstUndo = vi.fn(() => {
            state.pop();
            if (failCompensation) throw priorRollbackFailure;
        });
        const secondRollback = vi.fn(() => {
            state.pop();
            if (failCompensation) throw activeRollbackFailure;
        });
        const history = usePdfAppAnnotationHistory({
            pdfjsAnnotationState: ref(createAnnotationState()),
            emitAnnotationState: () => {},
            markModified: vi.fn(),
        });
        history.runTransaction(() => {
            history.registerCommand({
                cmd: () => state.push('first'),
                undo: firstUndo,
            });
            history.registerCommand({
                cmd: (registerFailureRollback) => {
                    state.push('second');
                    registerFailureRollback?.(secondRollback);
                    if (failRedo) throw replayFailure;
                },
                undo: () => state.pop(),
            });
        });
        history.undo();
        failRedo = true;
        failCompensation = true;

        let received: unknown;
        try {
            history.redo();
        } catch (error) {
            received = error;
        }

        expect(received).toBeInstanceOf(AnnotationHistoryCompensationError);
        expect((received as AnnotationHistoryCompensationError).cause).toBe(replayFailure);
        expect((received as AnnotationHistoryCompensationError).rollbackErrors).toEqual([
            activeRollbackFailure,
            priorRollbackFailure,
        ]);
        expect(secondRollback).toHaveBeenCalledOnce();
        expect(firstUndo).toHaveBeenCalledTimes(2);
        expect(history.canUndo.value).toBe(false);
        expect(history.canRedo.value).toBe(false);
        expect(history.annotationHistoryResetVersion.value).toBe(1);
    });

    it('does not publish pending transaction commands after replay poisons history', () => {
        const replayFailure = new Error('opaque executor state is uncertain');
        const pendingUndo = vi.fn();
        const history = usePdfAppAnnotationHistory({
            pdfjsAnnotationState: ref(createAnnotationState()),
            emitAnnotationState: vi.fn(),
            markModified: vi.fn(),
        });
        history.registerCommand({
            undo: () => {
                throw new AnnotationHistoryIndeterminateError(replayFailure);
            },
            cmd: vi.fn(),
        });

        let received: unknown;
        try {
            history.runTransaction(() => {
                history.registerCommand({
                    undo: pendingUndo,
                    cmd: vi.fn(),
                });
                history.undo();
            });
        } catch (error) {
            received = error;
        }

        expect(received).toBeInstanceOf(AnnotationHistoryIndeterminateError);
        expect((received as AnnotationHistoryIndeterminateError).cause).toBe(replayFailure);
        expect(history.annotationHistoryResetVersion.value).toBe(1);
        expect(history.canUndo.value).toBe(false);
        expect(history.canRedo.value).toBe(false);
        expect(history.undo()).toBe(false);
        expect(pendingUndo).not.toHaveBeenCalled();
    });

    it('removes poisoned annotation commands from the real workspace ledger', async () => {
        const ledger = useWorkspaceCommandLedger();
        const replayFailure = new Error('workspace undo failed after mutation');
        const rollbackFailure = new Error('workspace rollback failed');
        const history = usePdfAppAnnotationHistory({
            pdfjsAnnotationState: ref(createAnnotationState()),
            emitAnnotationState: () => {},
            markModified: vi.fn(),
        });
        ledger.registerCommand({
            source: 'file',
            undo: () => true,
            cmd: () => true,
        });
        history.setWorkspaceCommandSink({
            register: ledger.registerCommand,
            reset: ledger.resetSource,
            forget: ledger.forgetSourceEntries,
        });
        history.registerCommand({
            cmd: vi.fn(),
            undo: (registerFailureRollback) => {
                registerFailureRollback?.(() => {
                    throw rollbackFailure;
                });
                throw replayFailure;
            },
        });

        let received: unknown;
        try {
            await ledger.undoTimeline();
        } catch (error) {
            received = error;
        }

        expect(received).toBeInstanceOf(AnnotationHistoryCompensationError);
        expect((received as AnnotationHistoryCompensationError).cause).toBe(replayFailure);
        expect((received as AnnotationHistoryCompensationError).rollbackErrors).toEqual([rollbackFailure]);
        expect(history.annotationHistoryResetVersion.value).toBe(1);
        expect(ledger.nextUndoSource.value).toBe('file');
        expect(ledger.canUndoTimeline.value).toBe(true);
        expect(ledger.canRedoTimeline.value).toBe(false);
    });

    it('removes hard-forgotten annotation commands from the real workspace ledger', () => {
        const ledger = useWorkspaceCommandLedger();
        const forgottenId = asAnnotationId('forgotten-annotation');
        const history = usePdfAppAnnotationHistory({
            pdfjsAnnotationState: ref(createAnnotationState()),
            emitAnnotationState: vi.fn(),
            markModified: vi.fn(),
        });
        ledger.registerCommand({
            source: 'file',
            undo: () => true,
            cmd: () => true,
        });
        history.setWorkspaceCommandSink({
            register: ledger.registerCommand,
            reset: ledger.resetSource,
            forget: ledger.forgetSourceEntries,
        });
        history.registerCommand({
            undo: vi.fn(),
            cmd: vi.fn(),
            annotationIds: [forgottenId],
        });

        expect(ledger.nextUndoSource.value).toBe('annotation');
        history.forgetCommands(new Set([forgottenId]));
        expect(ledger.nextUndoSource.value).toBe('file');
        expect(ledger.canRedoTimeline.value).toBe(false);
    });

    it('keeps unrelated annotation history undoable when one shape is hard-forgotten', async () => {
        const ledger = useWorkspaceCommandLedger();
        const forgottenId = asAnnotationId('replaced-shape');
        const keptId = asAnnotationId('sticky-note');
        const forgottenUndo = vi.fn();
        const forgottenRedo = vi.fn();
        const keptUndo = vi.fn();
        const keptRedo = vi.fn();
        const undoFile = vi.fn(() => true);
        const history = usePdfAppAnnotationHistory({
            pdfjsAnnotationState: ref(createAnnotationState()),
            emitAnnotationState: vi.fn(),
            markModified: vi.fn(),
        });
        ledger.registerCommand({
            source: 'file',
            undo: undoFile,
            cmd: () => true,
        });
        history.setWorkspaceCommandSink({
            register: ledger.registerCommand,
            reset: ledger.resetSource,
            forget: ledger.forgetSourceEntries,
        });
        history.registerCommand({
            undo: forgottenUndo,
            cmd: forgottenRedo,
            annotationIds: [forgottenId],
        });
        history.registerCommand({
            undo: keptUndo,
            cmd: keptRedo,
            annotationIds: [keptId],
        });

        history.forgetCommands(new Set([forgottenId]));

        expect(ledger.nextUndoSource.value).toBe('annotation');
        await expect(ledger.undoTimeline()).resolves.toBe(true);
        expect(keptUndo).toHaveBeenCalledOnce();
        await expect(ledger.redoTimeline()).resolves.toBe(true);
        expect(keptRedo).toHaveBeenCalledOnce();
        await ledger.undoTimeline();
        await ledger.undoTimeline();
        expect(undoFile).toHaveBeenCalledOnce();
        expect(ledger.canUndoTimeline.value).toBe(false);
        expect(forgottenUndo).not.toHaveBeenCalled();
        expect(forgottenRedo).not.toHaveBeenCalled();
    });

    it('keeps a survivor undoable when a pending undo target is hard-forgotten mid-flight', async () => {
        const ledger = useWorkspaceCommandLedger();
        const forgottenId = asAnnotationId('replaced-shape');
        const forgottenUndo = vi.fn();
        const undoFile = vi.fn(() => true);
        const history = usePdfAppAnnotationHistory({
            pdfjsAnnotationState: ref(createAnnotationState()),
            emitAnnotationState: vi.fn(),
            markModified: vi.fn(),
        });
        ledger.registerCommand({
            source: 'file',
            undo: undoFile,
            cmd: () => true,
        });
        history.setWorkspaceCommandSink({
            register: ledger.registerCommand,
            reset: ledger.resetSource,
            forget: ledger.forgetSourceEntries,
        });
        history.registerCommand({
            undo: forgottenUndo,
            cmd: vi.fn(),
            annotationIds: [forgottenId],
        });

        // The replay runs synchronously, so the hard-forget lands in the gap
        // between it and the ledger settling the command it started.
        const pendingUndo = ledger.undoTimeline();
        history.forgetCommands(new Set([forgottenId]));

        await expect(pendingUndo).resolves.toBe(true);
        expect(forgottenUndo).toHaveBeenCalledOnce();
        expect(ledger.nextUndoSource.value).toBe('file');
        expect(ledger.canRedoTimeline.value).toBe(false);
        await expect(ledger.undoTimeline()).resolves.toBe(true);
        expect(undoFile).toHaveBeenCalledOnce();
        expect(ledger.canUndoTimeline.value).toBe(false);
    });

    it('keeps a survivor undoable when a pending redo target is hard-forgotten mid-flight', async () => {
        const ledger = useWorkspaceCommandLedger();
        const forgottenId = asAnnotationId('replaced-shape');
        const forgottenRedo = vi.fn();
        const undoFile = vi.fn(() => true);
        const history = usePdfAppAnnotationHistory({
            pdfjsAnnotationState: ref(createAnnotationState()),
            emitAnnotationState: vi.fn(),
            markModified: vi.fn(),
        });
        ledger.registerCommand({
            source: 'file',
            undo: undoFile,
            cmd: () => true,
        });
        history.setWorkspaceCommandSink({
            register: ledger.registerCommand,
            reset: ledger.resetSource,
            forget: ledger.forgetSourceEntries,
        });
        history.registerCommand({
            undo: vi.fn(),
            cmd: forgottenRedo,
            annotationIds: [forgottenId],
        });
        await ledger.undoTimeline();

        const pendingRedo = ledger.redoTimeline();
        history.forgetCommands(new Set([forgottenId]));

        // The forgotten target must not come back, and the file checkpoint
        // below it must not be stepped over.
        await expect(pendingRedo).resolves.toBe(true);
        expect(forgottenRedo).toHaveBeenCalledOnce();
        expect(ledger.canRedoTimeline.value).toBe(false);
        expect(ledger.nextUndoSource.value).toBe('file');
        await expect(ledger.undoTimeline()).resolves.toBe(true);
        expect(undoFile).toHaveBeenCalledOnce();
    });

    it('keeps a survivor undoable when the annotation source clears during a pending undo', async () => {
        const ledger = useWorkspaceCommandLedger();
        const undoFile = vi.fn(() => true);
        const history = usePdfAppAnnotationHistory({
            pdfjsAnnotationState: ref(createAnnotationState()),
            emitAnnotationState: vi.fn(),
            markModified: vi.fn(),
        });
        ledger.registerCommand({
            source: 'file',
            undo: undoFile,
            cmd: () => true,
        });
        history.setWorkspaceCommandSink({
            register: ledger.registerCommand,
            reset: ledger.resetSource,
            forget: ledger.forgetSourceEntries,
        });
        history.registerCommand({
            undo: vi.fn(),
            cmd: vi.fn(),
            annotationIds: [asAnnotationId('cleared-shape')],
        });

        // A viewer swap or document reopen clears the annotation source through
        // the same sink while the command it started is still settling.
        const pendingUndo = ledger.undoTimeline();
        history.clear();

        await expect(pendingUndo).resolves.toBe(true);
        expect(ledger.nextUndoSource.value).toBe('file');
        await expect(ledger.undoTimeline()).resolves.toBe(true);
        expect(undoFile).toHaveBeenCalledOnce();
        expect(ledger.canUndoTimeline.value).toBe(false);
    });

    it('drops a multi-shape annotation command when any one of its shapes is forgotten', async () => {
        const ledger = useWorkspaceCommandLedger();
        const forgottenId = asAnnotationId('replaced-shape');
        const survivingId = asAnnotationId('surviving-shape');
        const pairedUndo = vi.fn();
        const history = usePdfAppAnnotationHistory({
            pdfjsAnnotationState: ref(createAnnotationState()),
            emitAnnotationState: vi.fn(),
            markModified: vi.fn(),
        });
        history.setWorkspaceCommandSink({
            register: ledger.registerCommand,
            reset: ledger.resetSource,
            forget: ledger.forgetSourceEntries,
        });
        history.registerCommand({
            undo: pairedUndo,
            cmd: vi.fn(),
            annotationIds: [
                forgottenId,
                survivingId,
            ],
        });

        history.forgetCommands(new Set([forgottenId]));

        expect(ledger.canUndoTimeline.value).toBe(false);
        await expect(ledger.undoTimeline()).resolves.toBe(false);
        expect(pairedUndo).not.toHaveBeenCalled();
    });

    it('drops a hard-forgotten local command before its transaction is published', () => {
        const forgottenId = asAnnotationId('forgotten-transaction-annotation');
        const history = usePdfAppAnnotationHistory({
            pdfjsAnnotationState: ref(createAnnotationState()),
            emitAnnotationState: vi.fn(),
            markModified: vi.fn(),
        });

        history.runTransaction(() => {
            history.registerCommand({
                undo: vi.fn(),
                cmd: vi.fn(),
                annotationIds: [forgottenId],
            });
            history.forgetCommands(new Set([forgottenId]));
        });

        expect(history.canUndo.value).toBe(false);
        expect(history.canRedo.value).toBe(false);
        expect(history.undo()).toBe(false);
    });

    it('does not republish a forgotten transaction into the workspace ledger', () => {
        const ledger = useWorkspaceCommandLedger();
        const forgottenId = asAnnotationId('forgotten-workspace-transaction-annotation');
        const history = usePdfAppAnnotationHistory({
            pdfjsAnnotationState: ref(createAnnotationState()),
            emitAnnotationState: vi.fn(),
            markModified: vi.fn(),
        });
        ledger.registerCommand({
            source: 'file',
            undo: () => true,
            cmd: () => true,
        });
        history.setWorkspaceCommandSink({
            register: ledger.registerCommand,
            reset: ledger.resetSource,
            forget: ledger.forgetSourceEntries,
        });

        history.runTransaction(() => {
            history.registerCommand({
                undo: vi.fn(),
                cmd: vi.fn(),
                annotationIds: [forgottenId],
            });
            history.forgetCommands(new Set([forgottenId]));
        });

        expect(ledger.nextUndoSource.value).toBe('file');
        expect(ledger.canRedoTimeline.value).toBe(false);
    });

    it('advances the real workspace ledger once when post-replay notifications throw', async () => {
        const ledger = useWorkspaceCommandLedger();
        const state = ['applied'];
        const markModified = vi.fn(() => {
            throw new Error('mark modified failed');
        });
        const replayEffect = vi.fn(() => {
            throw new Error('projection sync failed');
        });
        vi.spyOn(BrowserLogger, 'warn').mockImplementation(() => {});
        const undo = vi.fn(() => state.pop());
        const cmd = vi.fn(() => state.push('applied'));
        const emitAnnotationState = vi.fn();
        const history = usePdfAppAnnotationHistory({
            pdfjsAnnotationState: ref(createAnnotationState()),
            emitAnnotationState,
            markModified,
        });
        history.setReplayEffect(replayEffect);
        history.setWorkspaceCommandSink({
            register: ledger.registerCommand,
            reset: ledger.resetSource,
            forget: ledger.forgetSourceEntries,
        });
        history.registerExecutorCommand({
            undo,
            cmd,
        });
        emitAnnotationState.mockClear();

        await expect(ledger.undoTimeline()).resolves.toBe(true);
        expect(state).toEqual([]);
        expect(ledger.canUndoTimeline.value).toBe(false);
        expect(ledger.canRedoTimeline.value).toBe(true);
        await expect(ledger.undoTimeline()).resolves.toBe(false);
        expect(undo).toHaveBeenCalledOnce();

        await expect(ledger.redoTimeline()).resolves.toBe(true);
        expect(state).toEqual(['applied']);
        expect(cmd).toHaveBeenCalledOnce();
        expect(markModified).toHaveBeenCalledTimes(2);
        expect(replayEffect).toHaveBeenCalledTimes(2);
        expect(emitAnnotationState).toHaveBeenCalledTimes(2);
    });

    it('bounds retained annotation commands to its 16 MiB share of the global undo budget', () => {
        const history = usePdfAppAnnotationHistory({
            pdfjsAnnotationState: ref(createAnnotationState()),
            emitAnnotationState: () => {},
            markModified: vi.fn(),
        });
        const undone: number[] = [];
        for (let index = 0; index < 3; index += 1) {
            history.registerCommand({
                cmd: vi.fn(),
                undo: () => undone.push(index),
                estimatedBytes: 8 * 1024 * 1024,
            });
        }

        expect(history.undo()).toBe(true);
        expect(history.undo()).toBe(true);
        expect(history.undo()).toBe(false);
        expect(undone).toEqual([
            2,
            1,
        ]);
    });

    it('registers annotation commands directly with the workspace ledger sink', async () => {
        const registrations: Array<{
            source: string;
            undo: () => Promise<boolean> | boolean;
            cmd: () => Promise<boolean> | boolean;
            estimatedBytes?: number;
        }> = [];
        const reset = vi.fn();
        const undo = vi.fn();
        const cmd = vi.fn();
        const markModified = vi.fn();
        const history = usePdfAppAnnotationHistory({
            pdfjsAnnotationState: ref(createAnnotationState()),
            emitAnnotationState: () => {},
            markModified,
        });
        history.setWorkspaceCommandSink({
            register: command => registrations.push(command),
            reset,
            forget: vi.fn(),
        });

        history.registerCommand({
            undo,
            cmd,
            estimatedBytes: 2048,
        });

        expect(history.canUndo.value).toBe(false);
        expect(registrations).toHaveLength(1);
        expect(registrations[0]).toMatchObject({
            source: 'annotation',
            estimatedBytes: 2048,
        });
        await expect(Promise.resolve(registrations[0]?.undo())).resolves.toBe(true);
        await expect(Promise.resolve(registrations[0]?.cmd())).resolves.toBe(true);
        expect(undo).toHaveBeenCalledOnce();
        expect(cmd).toHaveBeenCalledOnce();
        expect(markModified).toHaveBeenCalledTimes(2);

        history.clear();
        expect(reset).toHaveBeenCalledWith('annotation');
    });

    it('runs the projection replay effect after workspace undo and redo', async () => {
        const registrations: Array<{
            undo: () => Promise<boolean> | boolean;
            cmd: () => Promise<boolean> | boolean;
        }> = [];
        const calls: string[] = [];
        const history = usePdfAppAnnotationHistory({
            pdfjsAnnotationState: ref(createAnnotationState()),
            emitAnnotationState: () => {},
            markModified: () => calls.push('modified'),
        });
        history.setReplayEffect(() => calls.push('projection-sync'));
        history.setWorkspaceCommandSink({
            register: command => registrations.push(command),
            reset: vi.fn(),
            forget: vi.fn(),
        });
        history.registerCommand({
            undo: () => calls.push('undo'),
            cmd: () => calls.push('redo'),
        });

        await registrations[0]?.undo();
        await registrations[0]?.cmd();

        expect(calls).toEqual([
            'undo',
            'modified',
            'projection-sync',
            'redo',
            'modified',
            'projection-sync',
        ]);
    });

    it('captures the editor boundary before replay and projects it after', async () => {
        const registrations: Array<{
            undo: () => Promise<boolean> | boolean;
            cmd: () => Promise<boolean> | boolean;
        }> = [];
        const calls: string[] = [];
        const history = usePdfAppAnnotationHistory({
            pdfjsAnnotationState: ref(createAnnotationState()),
            emitAnnotationState: () => {},
            markModified: () => calls.push('modified'),
        });
        history.setBeforeReplayEffect(() => calls.push('capture'));
        history.setReplayEffect(() => calls.push('projection-sync'));
        history.setWorkspaceCommandSink({
            register: command => registrations.push(command),
            reset: vi.fn(),
            forget: vi.fn(),
        });
        history.registerCommand({
            undo: () => calls.push('undo'),
            cmd: () => calls.push('redo'),
        });

        await registrations[0]?.undo();
        await registrations[0]?.cmd();

        expect(calls).toEqual([
            'capture',
            'undo',
            'modified',
            'projection-sync',
            'capture',
            'redo',
            'modified',
            'projection-sync',
        ]);
    });
});
