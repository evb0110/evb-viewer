import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { createMainOperationShuttingDownError } from '@contracts/mainOperationErrors';
import { normalizePathForLookup } from '@electron/file-access/workingCopyStore';
import { createLogger } from '@electron/utils/createLogger';
import { runDetached } from '@electron/utils/runDetached';

export type TMainOperationKind = 'critical-write' | 'abortable-work' | 'resource-cleanup';
export type TMainOperationOwnerEndEvent = 'destroyed' | 'renderProcessGone' | 'mainFrameNavigation';
export type TMainOperationOwnerEndAction = 'cancel' | 'detach';
export interface IMainOperationOwnerLifecyclePolicy {
    destroyed: TMainOperationOwnerEndAction;
    renderProcessGone?: TMainOperationOwnerEndAction;
    mainFrameNavigation?: TMainOperationOwnerEndAction;
}

export interface IMainOperationRegistration {
    kind: TMainOperationKind;
    ownerWebContentsId?: number | undefined;
    workingCopyPath?: string | undefined;
    cancel?: ((reason: string) => void | Promise<void>) | undefined;
    ownerLifecycle?: IMainOperationOwnerLifecyclePolicy | undefined;
    /**
     * Whether closing `workingCopyPath` may cancel this operation. Long-running
     * work that only consumes the working copy says yes; the pipelines that
     * write the working copy itself drain instead, so they stay out of the
     * close predicate even though they carry a cancel hook for shutdown.
     * Defaults to `kind === 'abortable-work'`.
     */
    cancelOnWorkingCopyClose?: boolean | undefined;
}

export interface IRegisteredMainOperation {
    id: string;
    signal: AbortSignal;
    markCommitStarted: () => void;
    complete: () => void;
}

export interface ICanceledMainOperation {
    id: string;
    kind: TMainOperationKind;
    workingCopyPath: string;
    settled: Promise<void>;
}

/**
 * A working copy path is not an identity. The same path can be retired and
 * re-registered while a close is unwinding the previous registration's
 * dependents, and the operations that join the replacement belong to a document
 * nobody asked to close. The closing caller owns the registration, so it is the
 * only party that can say whether it still does, and it hands that check to
 * every cancellation round rather than being trusted to have checked once.
 */
export interface IClosingWorkingCopyOwnership {isRegistrationCurrent: () => boolean;}

export interface IMainOperationSnapshot {
    id: string;
    kind: TMainOperationKind;
    ownerWebContentsId?: number;
    workingCopyPath?: string;
    commitStarted: boolean;
    aborted: boolean;
}

interface IMainOperationRecord {
    id: string;
    kind: TMainOperationKind;
    ownerWebContentsId?: number | undefined;
    workingCopyPath?: string | undefined;
    cancel?: ((reason: string) => void | Promise<void>) | undefined;
    ownerLifecycle?: IMainOperationOwnerLifecyclePolicy | undefined;
    cancelOnWorkingCopyClose: boolean;
    controller: AbortController;
    commitStarted: boolean;
    complete: () => void;
    done: Promise<void>;
}

const operations = new Map<string, IMainOperationRecord>();
const cancellationSignals = new AsyncLocalStorage<AbortSignal>();
const log = createLogger('main-operation-lifecycle');
let shutdownAdmissionMessage: string | null = null;

function createTimeoutPromise(timeoutMs: number): Promise<'timeout'> {
    return new Promise<'timeout'>(resolve => {
        const timer = setTimeout(() => resolve('timeout'), timeoutMs);
        timer.unref();
    });
}

export function registerMainOperation(
    registration: IMainOperationRegistration,
): IRegisteredMainOperation {
    if (shutdownAdmissionMessage !== null) {
        throw createMainOperationShuttingDownError(shutdownAdmissionMessage);
    }

    const id = randomUUID();
    const controller = new AbortController();
    let resolveDone: (() => void) | null = null;
    const done = new Promise<void>((resolve) => {
        resolveDone = resolve;
    });
    let removeCancellationListener: () => void = () => undefined;
    const record: IMainOperationRecord = {
        id,
        kind: registration.kind,
        ownerWebContentsId: registration.ownerWebContentsId,
        workingCopyPath: registration.workingCopyPath,
        cancel: registration.cancel,
        ownerLifecycle: registration.ownerLifecycle,
        cancelOnWorkingCopyClose: registration.cancelOnWorkingCopyClose ?? registration.kind === 'abortable-work',
        controller,
        commitStarted: false,
        done,
        complete: () => {
            if (!operations.delete(id)) {
                return;
            }
            removeCancellationListener();
            resolveDone?.();
        },
    };
    operations.set(id, record);

    const cancellationSignal = cancellationSignals.getStore();
    const cancelFromParent = () => {
        // A critical write past its commit boundary is publishing, not reading:
        // the caller giving up on the reply does not make a half-written output
        // acceptable, so the same protection the other cancel paths apply holds
        // here too.
        if (record.kind === 'critical-write' && record.commitStarted) {
            return;
        }
        const reason = cancellationSignal?.reason instanceof Error
            ? cancellationSignal.reason.message
            : 'IPC invoke canceled';
        requestOperationCancel(record, reason);
    };
    if (cancellationSignal?.aborted) {
        cancelFromParent();
    } else if (cancellationSignal) {
        cancellationSignal.addEventListener('abort', cancelFromParent, {once: true});
        removeCancellationListener = () => cancellationSignal.removeEventListener('abort', cancelFromParent);
    }

    return {
        id,
        signal: controller.signal,
        markCommitStarted: () => {
            const current = operations.get(id);
            if (current) {
                current.commitStarted = true;
            }
        },
        complete: record.complete,
    };
}

export function runWithMainOperationCancellationSignal<TResult>(
    signal: AbortSignal,
    callback: () => TResult,
): TResult {
    return cancellationSignals.run(signal, callback);
}

export function beginMainOperationShutdown(message = 'Main process is shutting down') {
    shutdownAdmissionMessage ??= message;
}

function requestOperationCancel(operation: IMainOperationRecord, reason: string) {
    if (!operation.controller.signal.aborted) {
        operation.controller.abort(new Error(reason));
    }
    if (operation.cancel) {
        runDetached(
            () => operation.cancel?.(reason),
            {
                label: `cancel ${operation.kind} operation ${operation.id}`,
                logger: log,
            },
        );
    }
}

export function cancelAllMainOperations(reason: string): IMainOperationSnapshot[] {
    const canceledCriticalWrites: IMainOperationSnapshot[] = [];
    for (const operation of operations.values()) {
        if (operation.kind === 'critical-write' && operation.commitStarted) {
            continue;
        }
        requestOperationCancel(operation, reason);
        if (operation.kind === 'critical-write') {
            canceledCriticalWrites.push(toMainOperationSnapshot(operation));
        }
    }
    return canceledCriticalWrites;
}

export function cancelMainOperationsForOwner(
    ownerWebContentsId: number,
    reason: string,
    event: TMainOperationOwnerEndEvent = 'destroyed',
): void {
    for (const operation of operations.values()) {
        if (operation.ownerWebContentsId !== ownerWebContentsId) {
            continue;
        }
        if (operation.ownerLifecycle?.[event] === 'detach') {
            continue;
        }
        if (operation.kind === 'critical-write' && operation.commitStarted) {
            continue;
        }
        requestOperationCancel(operation, reason);
    }
}

// A working copy that is being retired can still be the source of long native
// work such as scan cleanup, OCR, or search indexing. Cancelling that work is
// what lets the close finish instead of deleting the file out from under a job
// that keeps burning CPU for minutes afterwards. Only operations that carry
// their own cancel hook qualify: a materialization flight registers without one
// because the close path decides on its own whether to join or cancel it.
//
// A `critical-write` qualifies too when it opts in. Scan cleanup registers as
// one so its output publication owns a protected commit boundary, but before
// that boundary it is still work reading the working copy, and closing the
// source document is the user asking for it to stop. Once `markCommitStarted()`
// has run the operation is publishing rather than reading and keeps its
// protection.
function isCancellableForClosingWorkingCopy(operation: IMainOperationRecord) {
    if (!operation.cancel || !operation.cancelOnWorkingCopyClose) {
        return false;
    }
    return operation.kind !== 'critical-write' || !operation.commitStarted;
}

// Returns `null` when the caller no longer owns the registration it is closing.
// Nothing is cancelled in that case: the operations now sharing this path answer
// to a registration that is not being closed, and stopping them would cancel a
// document the user just opened. The caller treats `null` as "hands off": it
// retires nothing and deletes nothing.
export function cancelMainOperationsForClosingWorkingCopy(
    workingCopyPath: string,
    reason: string,
    ownership: IClosingWorkingCopyOwnership,
): ICanceledMainOperation[] | null {
    // Read once, immediately before the loop. The loop itself has no await, so
    // no registration can change between this check and the last cancel it
    // issues.
    if (!ownership.isRegistrationCurrent()) {
        return null;
    }
    const normalizedWorkingCopyPath = normalizePathForLookup(workingCopyPath) || workingCopyPath;
    const canceled: ICanceledMainOperation[] = [];
    for (const operation of operations.values()) {
        if (
            operation.workingCopyPath === undefined
            || (normalizePathForLookup(operation.workingCopyPath) || operation.workingCopyPath) !== normalizedWorkingCopyPath
            || !isCancellableForClosingWorkingCopy(operation)
        ) {
            continue;
        }
        requestOperationCancel(operation, reason);
        canceled.push({
            id: operation.id,
            kind: operation.kind,
            workingCopyPath,
            settled: operation.done,
        });
    }
    return canceled;
}

// The dependents a close would have stopped, as they stand right now. After a
// settled cancel-and-wait loop this is empty; anything in it registered after
// the last round, so it was never asked to stop and is still reading the bytes
// the caller is about to delete. The pipelines that write the working copy
// itself are excluded for the same reason they are excluded from cancellation:
// they drain, and the drain has already run by the time this is asked.
export function snapshotCancellableWorkingCopyDependents(workingCopyPath: string): IMainOperationSnapshot[] {
    const normalizedWorkingCopyPath = normalizePathForLookup(workingCopyPath) || workingCopyPath;
    return [...operations.values()]
        .filter(operation => (
            operation.workingCopyPath !== undefined
            && (normalizePathForLookup(operation.workingCopyPath) || operation.workingCopyPath) === normalizedWorkingCopyPath
            && isCancellableForClosingWorkingCopy(operation)
        ))
        .map(toMainOperationSnapshot);
}

// Cancellation is a request, not an arrival. A canceled scan-cleanup job still
// has to unwind a cooperative worker cancel and, when the worker will not stop,
// a bounded force termination before its Poppler children let go of the working
// copy. The caller deleting that directory has to wait for the operation record
// to be completed, not merely aborted.
export async function waitForMainOperationsSettled(
    canceledOperations: readonly ICanceledMainOperation[],
    options: {timeoutMs: number},
): Promise<{
    settled: boolean;
    pending: IMainOperationSnapshot[];
}> {
    if (canceledOperations.length === 0) {
        return {
            settled: true,
            pending: [],
        };
    }
    const outcome = await Promise.race([
        Promise.allSettled(canceledOperations.map(operation => operation.settled))
            .then(() => 'settled' as const),
        createTimeoutPromise(options.timeoutMs),
    ]);
    if (outcome === 'settled') {
        // Every operation completed, which is what removes its record. There is
        // nothing left to describe, and the registry is only consulted on the
        // timeout path, where the caller needs to name what would not stop.
        return {
            settled: true,
            pending: [],
        };
    }
    const pendingIds = new Set(canceledOperations.map(operation => operation.id));
    return {
        settled: false,
        pending: snapshotMainOperations().filter(operation => pendingIds.has(operation.id)),
    };
}

export async function drainCriticalMainOperations(options: {timeoutMs: number}): Promise<{
    completed: boolean;
    pending: IMainOperationSnapshot[];
}> {
    const criticalWrites = [...operations.values()]
        .filter(operation => operation.kind === 'critical-write');
    if (criticalWrites.length === 0) {
        return {
            completed: true,
            pending: [],
        };
    }

    const completed = await Promise.race([
        Promise.allSettled(criticalWrites.map(operation => operation.done))
            .then(() => 'completed' as const),
        createTimeoutPromise(options.timeoutMs),
    ]);

    return {
        completed: completed === 'completed',
        pending: snapshotMainOperations()
            .filter(operation => operation.kind === 'critical-write'),
    };
}

function toMainOperationSnapshot(operation: IMainOperationRecord): IMainOperationSnapshot {
    return {
        id: operation.id,
        kind: operation.kind,
        ...(operation.ownerWebContentsId === undefined ? {} : {ownerWebContentsId: operation.ownerWebContentsId}),
        ...(operation.workingCopyPath === undefined ? {} : {workingCopyPath: operation.workingCopyPath}),
        commitStarted: operation.commitStarted,
        aborted: operation.controller.signal.aborted,
    };
}

export function snapshotMainOperations(): IMainOperationSnapshot[] {
    return [...operations.values()].map(toMainOperationSnapshot);
}

export function resetMainOperationLifecycleForTests(): void {
    shutdownAdmissionMessage = null;
    for (const operation of operations.values()) {
        operation.complete();
    }
    operations.clear();
}
