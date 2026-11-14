import { createLogger } from '@electron/utils/createLogger';
import {normalizePathForLookup} from '@electron/file-access/normalizePathForLookup';
import { cancelNativeCommandGroup } from '@electron/native-tools/runNativeCommand';
import {
    registerMainOperation,
    type IMainOperationUserCancel,
} from '@electron/operation-lifecycle/mainOperationLifecycle';
import { runWithWorkingCopyMutationCommitSignal } from '@electron/file-access/workingCopyMutationCommitSignal';

const log = createLogger('workingCopyMutationQueue');
interface IWorkingCopyMutationQueueEntry {
    tail: Promise<void>;
    operationId: string;
    kind: string;
    origin: string | null;
    enqueuedAt: number;
    depth: number;
}

export interface IWorkingCopyMutationQueueOptions {
    kind?: string;
    ownerWebContentsId?: number;
    userCancel?: IMainOperationUserCancel;
    /** Receives the operation's abort signal at enqueue, before it is granted. */
    onEnqueued?: (signal: AbortSignal) => void;
}

const workingCopyMutationQueue = new Map<string, IWorkingCopyMutationQueueEntry>();
const activeWorkingCopyMutations = new Map<string, IWorkingCopyMutationQueueEntry>();

export interface IWorkingCopyMutationOperation {
    workingCopyPath: string;
    signal: AbortSignal;
    cancelGroup: string;
    markCommitStarted: () => void;
}

function getWorkingCopyQueueKey(workingCopyPath: string) {
    return normalizePathForLookup(workingCopyPath) || workingCopyPath;
}

const MUTATION_ORIGIN_STACK_TRACE_LIMIT = 8;

function getMutationOrigin() {
    const previousStackTraceLimit = Error.stackTraceLimit;
    Error.stackTraceLimit = MUTATION_ORIGIN_STACK_TRACE_LIMIT;
    try {
        const error = new Error();
        Error.captureStackTrace(error, getMutationOrigin);
        const stack = error.stack?.split('\n', MUTATION_ORIGIN_STACK_TRACE_LIMIT) ?? [];
        return stack
            .map(line => line.trim())
            .find(line => line.startsWith('at ') && !line.includes('workingCopyMutationQueue'))
            ?? null;
    } finally {
        Error.stackTraceLimit = previousStackTraceLimit;
    }
}

function getMutationKind(kind: string | undefined) {
    const normalizedKind = kind?.trim();
    if (!normalizedKind) {
        return 'working-copy-mutation';
    }
    return normalizedKind;
}

/** Waiting behind another mutation is contention; a long mutation is only its own work. */
function getQueueLogLevel(durationMs: number, slow: 'info' | 'warn') {
    return durationMs >= 1_000 ? log[slow].bind(log) : log.debug.bind(log);
}

/**
 * Waits for the mutations queued when the drain starts, not for the queue to
 * empty. A mutation whose own completion enqueues the next one would otherwise
 * keep the queue non-empty forever and the drain would never return. Callers
 * that need to catch late arrivals drain a second time once the work that
 * produces them has been stopped.
 */
export async function drainWorkingCopyMutations(workingCopyPath?: string) {
    if (workingCopyPath !== undefined) {
        const queueKey = getWorkingCopyQueueKey(workingCopyPath);
        await workingCopyMutationQueue.get(queueKey)?.tail;
        return;
    }

    const tails = [...workingCopyMutationQueue.values()].map(entry => entry.tail);
    await Promise.allSettled(tails);
}

export function enqueueWorkingCopyMutation<T>(
    workingCopyPath: string,
    operation: (operation: IWorkingCopyMutationOperation) => Promise<T>,
    options: IWorkingCopyMutationQueueOptions = {},
) {
    const queueKey = getWorkingCopyQueueKey(workingCopyPath);
    const previousEntry = workingCopyMutationQueue.get(queueKey);
    const previousTail = previousEntry?.tail ?? Promise.resolve();
    const activeEntryAtEnqueue = activeWorkingCopyMutations.get(queueKey);
    const enqueuedAt = performance.now();
    let cancelGroup = '';
    const lifecycleOperation = registerMainOperation({
        kind: 'critical-write',
        ownerWebContentsId: options.ownerWebContentsId,
        workingCopyPath,
        userCancel: options.userCancel,
        cancel: () => {
            if (cancelGroup) {
                cancelNativeCommandGroup(cancelGroup);
            }
        },
    });
    cancelGroup = `working-copy-mutation:${lifecycleOperation.id}`;
    const mutationOperation: IWorkingCopyMutationOperation = {
        workingCopyPath,
        signal: lifecycleOperation.signal,
        cancelGroup,
        markCommitStarted: lifecycleOperation.markCommitStarted,
    };
    const isMutationAborted = () => mutationOperation.signal.aborted;
    options.onEnqueued?.(mutationOperation.signal);
    const entry: IWorkingCopyMutationQueueEntry = {
        tail: Promise.resolve(),
        operationId: lifecycleOperation.id,
        kind: getMutationKind(options.kind),
        origin: getMutationOrigin(),
        enqueuedAt,
        depth: (previousEntry?.depth ?? 0) + 1,
    };
    const enqueueLog = previousEntry || activeEntryAtEnqueue
        ? log.warn.bind(log)
        : log.debug.bind(log);
    enqueueLog('Working-copy mutation enqueued', {
        queueKey,
        operationId: entry.operationId,
        kind: entry.kind,
        origin: entry.origin,
        depth: entry.depth,
        queuedBehind: previousEntry ? {
            operationId: previousEntry.operationId,
            kind: previousEntry.kind,
            origin: previousEntry.origin,
        } : null,
        activeOwner: activeEntryAtEnqueue ? {
            operationId: activeEntryAtEnqueue.operationId,
            kind: activeEntryAtEnqueue.kind,
            origin: activeEntryAtEnqueue.origin,
        } : null,
    });
    const operationPromise = previousTail
        .then(async () => {
            if (isMutationAborted()) {
                throw mutationOperation.signal.reason instanceof Error
                    ? mutationOperation.signal.reason
                    : new Error('Working-copy mutation canceled');
            }
            const grantedAt = performance.now();
            const waitedMs = Math.round((grantedAt - enqueuedAt) * 10) / 10;
            activeWorkingCopyMutations.set(queueKey, entry);
            getQueueLogLevel(waitedMs, 'warn')('Working-copy mutation granted', {
                queueKey,
                operationId: entry.operationId,
                kind: entry.kind,
                origin: entry.origin,
                depth: entry.depth,
                waitedMs,
                queuedBehind: previousEntry ? {
                    operationId: previousEntry.operationId,
                    kind: previousEntry.kind,
                    origin: previousEntry.origin,
                } : null,
            });
            try {
                return await runWithWorkingCopyMutationCommitSignal(mutationOperation, () => operation(mutationOperation));
            } finally {
                const durationMs = Math.round((performance.now() - grantedAt) * 10) / 10;
                getQueueLogLevel(durationMs, 'info')('Working-copy mutation settled', {
                    queueKey,
                    operationId: entry.operationId,
                    kind: entry.kind,
                    origin: entry.origin,
                    waitedMs,
                    durationMs,
                });
                if (activeWorkingCopyMutations.get(queueKey) === entry) {
                    activeWorkingCopyMutations.delete(queueKey);
                }
            }
        })
        .finally(() => {
            lifecycleOperation.complete();
        });

    const nextTail = operationPromise
        .then(() => undefined, () => undefined)
        .finally(() => {
            if (workingCopyMutationQueue.get(queueKey) === entry) {
                workingCopyMutationQueue.delete(queueKey);
            }
        });

    entry.tail = nextTail;
    workingCopyMutationQueue.set(queueKey, entry);
    return operationPromise;
}

