import {
    rm,
    unlink,
} from 'fs/promises';
import { isErrnoException } from '@contracts/runtimeGuards';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';
import { getNativeCompactSearchIndexPath as getCompactSearchIndexPath } from '@electron/features/search/publicNative';
import { normalizePathForLookup } from '@electron/file-access/workingCopyStore';
import { cancelNativeCommandGroup } from '@electron/native-tools/runNativeCommand';
import { registerMainOperation } from '@electron/operation-lifecycle/mainOperationLifecycle';
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
}

const workingCopyMutationQueue = new Map<string, IWorkingCopyMutationQueueEntry>();
const activeWorkingCopyMutations = new Map<string, IWorkingCopyMutationQueueEntry>();
const workingCopyMutationStartingListeners = new Set<
    (workingCopyPath: string, signal: AbortSignal) => void | Promise<void>
>();
const workingCopyMutationListeners = new Set<(workingCopyPath: string) => void>();

export interface IWorkingCopyMutationOperation {
    workingCopyPath: string;
    signal: AbortSignal;
    cancelGroup: string;
    markCommitStarted: () => void;
}

export function onWorkingCopyMutationSettled(listener: (workingCopyPath: string) => void) {
    workingCopyMutationListeners.add(listener);
    return () => {
        workingCopyMutationListeners.delete(listener);
    };
}

export function onWorkingCopyMutationStarting(
    listener: (workingCopyPath: string, signal: AbortSignal) => void | Promise<void>,
) {
    workingCopyMutationStartingListeners.add(listener);
    return () => {
        workingCopyMutationStartingListeners.delete(listener);
    };
}

// A starting listener may hold a mutation until resources that would block its
// replacement have been released. Settled listeners run after the operation,
// so they cannot provide this ordering guarantee.
function notifyWorkingCopyMutationStarting(workingCopyPath: string, signal: AbortSignal) {
    let pending: Promise<void> | undefined;
    for (const listener of workingCopyMutationStartingListeners) {
        if (pending) {
            pending = pending
                .then(() => listener(workingCopyPath, signal))
                .then(() => undefined);
            continue;
        }
        const result = listener(workingCopyPath, signal);
        if (result) {
            pending = Promise.resolve(result).then(() => undefined);
        }
    }
    return pending;
}

function notifyWorkingCopyMutationSettled(workingCopyPath: string) {
    for (const listener of workingCopyMutationListeners) {
        try {
            listener(workingCopyPath);
        } catch (error) {
            log.debug(`Failed to notify working copy mutation listener: ${getErrorMessage(error)}`);
        }
    }
}

function getWorkingCopyQueueKey(workingCopyPath: string) {
    return normalizePathForLookup(workingCopyPath) || workingCopyPath;
}

function getMutationOrigin() {
    const stack = new Error().stack?.split('\n') ?? [];
    return stack
        .map(line => line.trim())
        .find(line => line.startsWith('at ') && !line.includes('workingCopyMutationQueue'))
        ?? null;
}

function getMutationKind(kind: string | undefined) {
    const normalizedKind = kind?.trim();
    if (!normalizedKind) {
        return 'working-copy-mutation';
    }
    return normalizedKind;
}

function getQueueLogLevel(durationMs: number) {
    return durationMs >= 1_000 ? log.warn.bind(log) : log.debug.bind(log);
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
    enqueueLog(`Working-copy mutation enqueued: ${JSON.stringify({
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
    })}`);
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
            getQueueLogLevel(waitedMs)(`Working-copy mutation granted: ${JSON.stringify({
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
            })}`);
            try {
                const preparation = notifyWorkingCopyMutationStarting(workingCopyPath, mutationOperation.signal);
                if (preparation) {
                    await preparation;
                }
                if (isMutationAborted()) {
                    throw mutationOperation.signal.reason instanceof Error
                        ? mutationOperation.signal.reason
                        : new Error('Working-copy mutation canceled');
                }
                return await runWithWorkingCopyMutationCommitSignal(mutationOperation, () => operation(mutationOperation));
            } finally {
                const durationMs = Math.round((performance.now() - grantedAt) * 10) / 10;
                getQueueLogLevel(durationMs)(`Working-copy mutation settled: ${JSON.stringify({
                    queueKey,
                    operationId: entry.operationId,
                    kind: entry.kind,
                    origin: entry.origin,
                    waitedMs,
                    durationMs,
                })}`);
                if (activeWorkingCopyMutations.get(queueKey) === entry) {
                    activeWorkingCopyMutations.delete(queueKey);
                }
            }
        })
        .finally(() => {
            notifyWorkingCopyMutationSettled(workingCopyPath);
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

async function unlinkIfPresent(filePath: string) {
    try {
        await unlink(filePath);
    } catch (error) {
        const code = isErrnoException(error) ? error.code : undefined;
        if (code !== 'ENOENT') {
            log.debug(`Failed to remove page-op artifact "${filePath}": ${getErrorMessage(error)}`);
        }
    }
}

export async function clearWorkingCopyOcrArtifacts(workingCopyPath: string) {
    await Promise.all([
        rm(`${workingCopyPath}.ocr`, {
            recursive: true,
            force: true,
        }).catch(error => {
            log.debug(`Failed to remove OCR sidecar for page-op mutation: ${getErrorMessage(error)}`);
        }),
        unlinkIfPresent(`${workingCopyPath}.index.json`),
        unlinkIfPresent(getCompactSearchIndexPath(workingCopyPath)),
    ]);
}

export async function clearWorkingCopySearchArtifacts(workingCopyPath: string) {
    await Promise.all([
        unlinkIfPresent(`${workingCopyPath}.index.json`),
        unlinkIfPresent(getCompactSearchIndexPath(workingCopyPath)),
    ]);
}
