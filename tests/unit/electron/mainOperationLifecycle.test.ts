import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {getMainOperationErrorEnvelope} from '@contracts/mainOperationErrors';
import {
    beginMainOperationShutdown,
    cancelAllMainOperations,
    cancelMainOperationsForOwner,
    cancelMainOperationsForClosingWorkingCopy,
    drainCriticalMainOperations,
    registerMainOperation,
    runWithMainOperationCancellationSignal,
    resetMainOperationLifecycleForTests,
    snapshotCancellableWorkingCopyDependents,
    snapshotMainOperations,
    waitForMainOperationsSettled,
} from '@electron/operation-lifecycle/mainOperationLifecycle';

// A close that still owns the registration it started on. The ownership check
// is the caller's, so the lifecycle tests state it explicitly.
const OWNS_REGISTRATION = {isRegistrationCurrent: () => true};

describe('mainOperationLifecycle', () => {
    afterEach(() => {
        resetMainOperationLifecycleForTests();
        vi.useRealTimers();
    });

    it('aborts registered noncommitting operations during shutdown cancel', () => {
        const cancel = vi.fn();
        const operation = registerMainOperation({
            kind: 'abortable-work',
            ownerWebContentsId: 7,
            cancel,
        });

        cancelAllMainOperations('app shutdown');

        expect(operation.signal.aborted).toBe(true);
        expect(cancel).toHaveBeenCalledWith('app shutdown');
        expect(snapshotMainOperations()).toEqual([expect.objectContaining({
            id: operation.id,
            kind: 'abortable-work',
            ownerWebContentsId: 7,
            aborted: true,
        })]);
    });

    it('cancels operations created inside an IPC invoke cancellation scope', () => {
        const cancel = vi.fn();
        const controller = new AbortController();
        const operation = runWithMainOperationCancellationSignal(
            controller.signal,
            () => registerMainOperation({
                kind: 'abortable-work',
                ownerWebContentsId: 7,
                cancel,
            }),
        );

        controller.abort(new Error('IPC invoke canceled'));

        expect(operation.signal.aborted).toBe(true);
        expect(cancel).toHaveBeenCalledWith('IPC invoke canceled');
        operation.complete();
    });

    it('reports pre-commit critical writes aborted during shutdown cancel', () => {
        const preCommit = registerMainOperation({
            kind: 'critical-write',
            workingCopyPath: '/tmp/pre-commit.pdf',
        });
        const committed = registerMainOperation({
            kind: 'critical-write',
            workingCopyPath: '/tmp/committed.pdf',
        });
        committed.markCommitStarted();

        expect(cancelAllMainOperations('app shutdown')).toEqual([expect.objectContaining({
            id: preCommit.id,
            kind: 'critical-write',
            workingCopyPath: '/tmp/pre-commit.pdf',
            commitStarted: false,
            aborted: true,
        })]);
        expect(preCommit.signal.aborted).toBe(true);
        expect(committed.signal.aborted).toBe(false);
    });

    it('aborts every unfinished operation owned by a renderer when it disappears', () => {
        const ownedCancel = vi.fn();
        const owned = registerMainOperation({
            kind: 'critical-write',
            ownerWebContentsId: 42,
            cancel: ownedCancel,
        });
        const committed = registerMainOperation({
            kind: 'critical-write',
            ownerWebContentsId: 42,
            cancel: vi.fn(),
        });
        committed.markCommitStarted();
        const other = registerMainOperation({
            kind: 'abortable-work',
            ownerWebContentsId: 7,
            cancel: vi.fn(),
        });

        cancelMainOperationsForOwner(42, 'Renderer lifecycle ended');

        expect(owned.signal.aborted).toBe(true);
        expect(ownedCancel).toHaveBeenCalledWith('Renderer lifecycle ended');
        expect(committed.signal.aborted).toBe(false);
        expect(other.signal.aborted).toBe(false);
    });

    it('revokes an owner-bound materialization flight before its staged lease can be reused', () => {
        const leaseUsable = {value: true};
        const materialization = registerMainOperation({
            kind: 'abortable-work',
            ownerWebContentsId: 42,
            cancel: () => {
                leaseUsable.value = false;
            },
        });

        cancelMainOperationsForOwner(42, 'Renderer lifecycle ended');

        expect(materialization.signal.aborted).toBe(true);
        expect(leaseUsable.value).toBe(false);
    });

    it('honors the registered owner policy for renderer lifecycle events', () => {
        const detachedCancel = vi.fn();
        const detached = registerMainOperation({
            kind: 'abortable-work',
            ownerWebContentsId: 42,
            cancel: detachedCancel,
            ownerLifecycle: {
                destroyed: 'detach',
                renderProcessGone: 'detach',
                mainFrameNavigation: 'detach',
            },
        });
        const cancel = vi.fn();
        const cancellable = registerMainOperation({
            kind: 'abortable-work',
            ownerWebContentsId: 42,
            cancel,
        });

        cancelMainOperationsForOwner(42, 'Renderer main frame navigated', 'mainFrameNavigation');

        expect(detached.signal.aborted).toBe(false);
        expect(detachedCancel).not.toHaveBeenCalled();
        expect(cancellable.signal.aborted).toBe(true);
        expect(cancel).toHaveBeenCalledWith('Renderer main frame navigated');
    });

    it('settles a completion boundary once even when teardown races a late completion', () => {
        const operation = registerMainOperation({
            kind: 'critical-write',
            ownerWebContentsId: 42,
        });
        operation.complete();
        operation.complete();

        expect(snapshotMainOperations()).toEqual([]);
        expect(operation.signal.aborted).toBe(false);
    });

    it('does not abort critical writes after commit starts and drains until completion', async () => {
        const operation = registerMainOperation({
            kind: 'critical-write',
            workingCopyPath: '/tmp/working.pdf',
        });
        operation.markCommitStarted();

        cancelAllMainOperations('app shutdown');
        const drainPromise = drainCriticalMainOperations({timeoutMs: 1000});
        await Promise.resolve();

        expect(operation.signal.aborted).toBe(false);
        expect(snapshotMainOperations()).toHaveLength(1);

        operation.complete();

        await expect(drainPromise).resolves.toEqual({
            completed: true,
            pending: [],
        });
    });

    it('times out while critical writes remain pending', async () => {
        vi.useFakeTimers();
        registerMainOperation({kind: 'critical-write'});

        const drainPromise = drainCriticalMainOperations({timeoutMs: 50});
        await vi.advanceTimersByTimeAsync(50);

        const result = await drainPromise;
        expect(result.completed).toBe(false);
        expect(result.pending).toHaveLength(1);
    });

    it('cancels every cancellable pre-commit dependent of a closing working copy', async () => {
        const cleanupCancel = vi.fn();
        const cleanup = registerMainOperation({
            kind: 'abortable-work',
            workingCopyPath: '/tmp/closing.pdf',
            cancel: cleanupCancel,
        });
        // Scan cleanup registers as a critical write so its output publication
        // owns a commit boundary, but until that boundary it is still reading
        // the working copy the close is about to delete.
        const scanCleanupCancel = vi.fn();
        const scanCleanup = registerMainOperation({
            kind: 'critical-write',
            workingCopyPath: '/tmp/closing.pdf',
            cancel: scanCleanupCancel,
            cancelOnWorkingCopyClose: true,
        });
        // The working copy's own mutation queue carries a cancel hook for
        // shutdown but must drain, not abort, when its document closes.
        const mutationCancel = vi.fn();
        const mutation = registerMainOperation({
            kind: 'critical-write',
            workingCopyPath: '/tmp/closing.pdf',
            cancel: mutationCancel,
        });
        const otherDocument = registerMainOperation({
            kind: 'abortable-work',
            workingCopyPath: '/tmp/other.pdf',
            cancel: vi.fn(),
        });
        const materializationFlight = registerMainOperation({
            kind: 'abortable-work',
            workingCopyPath: '/tmp/closing.pdf',
        });
        const pendingWrite = registerMainOperation({
            kind: 'critical-write',
            workingCopyPath: '/tmp/closing.pdf',
        });
        const committedWriteCancel = vi.fn();
        const committedWrite = registerMainOperation({
            kind: 'critical-write',
            workingCopyPath: '/tmp/closing.pdf',
            cancel: committedWriteCancel,
            cancelOnWorkingCopyClose: true,
        });
        committedWrite.markCommitStarted();

        const canceled = cancelMainOperationsForClosingWorkingCopy(
            '/tmp/closing.pdf',
            'Working copy is closing',
            OWNS_REGISTRATION,
        );
        await Promise.resolve();

        expect(canceled).not.toBeNull();
        expect(canceled!.map(operation => operation.id).sort()).toEqual([
            cleanup.id,
            scanCleanup.id,
        ].sort());
        expect(cleanup.signal.aborted).toBe(true);
        expect(cleanupCancel).toHaveBeenCalledWith('Working copy is closing');
        expect(scanCleanup.signal.aborted).toBe(true);
        expect(scanCleanupCancel).toHaveBeenCalledWith('Working copy is closing');
        expect(otherDocument.signal.aborted).toBe(false);
        expect(materializationFlight.signal.aborted).toBe(false);
        expect(mutation.signal.aborted).toBe(false);
        expect(mutationCancel).not.toHaveBeenCalled();
        expect(pendingWrite.signal.aborted).toBe(false);
        expect(committedWrite.signal.aborted).toBe(false);
        expect(committedWriteCancel).not.toHaveBeenCalled();
        // The same predicate answers "is anything still holding this path?" at
        // retirement time, so the two can never disagree about what a close owes
        // a wait to. A cancelled dependent still holds the path until it
        // completes; only the operations the close never had to stop drop out.
        expect(snapshotCancellableWorkingCopyDependents('/tmp/closing.pdf')
            .map(operation => operation.id).sort()).toEqual([
            cleanup.id,
            scanCleanup.id,
        ].sort());
        cleanup.complete();
        scanCleanup.complete();
        expect(snapshotCancellableWorkingCopyDependents('/tmp/closing.pdf')).toEqual([]);
    });

    it.skipIf(process.platform !== 'darwin')('cancels a dependent when cleanup uses the /private/var alias', () => {
        const rendererPath = '/var/tmp/evb-issue-123-alias/working.pdf';
        const canonicalPath = '/private/var/tmp/evb-issue-123-alias/working.pdf';
        const cancel = vi.fn();
        const operation = registerMainOperation({
            kind: 'abortable-work',
            workingCopyPath: rendererPath,
            cancel,
        });

        expect(snapshotCancellableWorkingCopyDependents(canonicalPath).map(entry => entry.id))
            .toEqual([operation.id]);
        const canceled = cancelMainOperationsForClosingWorkingCopy(
            canonicalPath,
            'Working copy is closing',
            OWNS_REGISTRATION,
        );

        expect(canceled?.map(entry => entry.id)).toEqual([operation.id]);
        expect(operation.signal.aborted).toBe(true);
        expect(cancel).toHaveBeenCalledWith('Working copy is closing');
        operation.complete();
    });

    it('cancels nothing once the caller no longer owns the registration it is closing', () => {
        const scanCleanupCancel = vi.fn();
        const scanCleanup = registerMainOperation({
            kind: 'critical-write',
            workingCopyPath: '/tmp/closing.pdf',
            cancel: scanCleanupCancel,
            cancelOnWorkingCopyClose: true,
        });

        // The document was closed and the same path reopened while the close was
        // waiting. This operation belongs to the replacement, and cancelling it
        // would stop a document nobody asked to close.
        expect(cancelMainOperationsForClosingWorkingCopy(
            '/tmp/closing.pdf',
            'Working copy is closing',
            {isRegistrationCurrent: () => false},
        )).toBeNull();
        expect(scanCleanup.signal.aborted).toBe(false);
        expect(scanCleanupCancel).not.toHaveBeenCalled();
    });

    it('reports a cancellable dependent that registered after the last cancellation round', () => {
        const settled = registerMainOperation({
            kind: 'abortable-work',
            workingCopyPath: '/tmp/closing.pdf',
            cancel: vi.fn(),
        });
        expect(cancelMainOperationsForClosingWorkingCopy(
            '/tmp/closing.pdf',
            'Working copy is closing',
            OWNS_REGISTRATION,
        )).toHaveLength(1);
        settled.complete();
        expect(snapshotCancellableWorkingCopyDependents('/tmp/closing.pdf')).toEqual([]);

        const late = registerMainOperation({
            kind: 'abortable-work',
            workingCopyPath: '/tmp/closing.pdf',
            cancel: vi.fn(),
        });

        expect(snapshotCancellableWorkingCopyDependents('/tmp/closing.pdf')).toEqual([expect.objectContaining({
            id: late.id,
            aborted: false,
        })]);
    });

    it('reports settlement of closing-working-copy dependents only once they complete', async () => {
        const operation = registerMainOperation({
            kind: 'critical-write',
            workingCopyPath: '/tmp/closing.pdf',
            cancel: vi.fn(),
            cancelOnWorkingCopyClose: true,
        });
        const canceled = cancelMainOperationsForClosingWorkingCopy(
            '/tmp/closing.pdf',
            'Working copy is closing',
            OWNS_REGISTRATION,
        );
        expect(canceled).toHaveLength(1);

        vi.useFakeTimers();
        const pendingSettlement = waitForMainOperationsSettled(canceled!, {timeoutMs: 50});
        await vi.advanceTimersByTimeAsync(50);
        await expect(pendingSettlement).resolves.toEqual({
            settled: false,
            pending: [expect.objectContaining({
                id: operation.id,
                aborted: true,
            })],
        });
        vi.useRealTimers();

        operation.complete();

        await expect(waitForMainOperationsSettled(canceled!, {timeoutMs: 50})).resolves.toEqual({
            settled: true,
            pending: [],
        });
    });

    it('treats an empty dependent set as already settled', async () => {
        await expect(waitForMainOperationsSettled([], {timeoutMs: 0})).resolves.toEqual({
            settled: true,
            pending: [],
        });
    });

    it('completes operations idempotently', () => {
        const operation = registerMainOperation({kind: 'resource-cleanup'});

        operation.complete();
        operation.complete();

        expect(snapshotMainOperations()).toEqual([]);
    });

    it('rejects registrations after shutdown admission closes without leaving drain orphans', async () => {
        beginMainOperationShutdown('Main process is shutting down');

        let caught: unknown;
        try {
            registerMainOperation({kind: 'critical-write'});
        } catch (error) {
            caught = error;
        }

        expect(getMainOperationErrorEnvelope(caught)).toEqual({
            code: 'shutting-down',
            message: 'Main process is shutting down',
        });
        await expect(drainCriticalMainOperations({timeoutMs: 50})).resolves.toEqual({
            completed: true,
            pending: [],
        });
        expect(snapshotMainOperations()).toEqual([]);
    });
});
