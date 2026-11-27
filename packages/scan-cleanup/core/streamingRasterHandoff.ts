import {getErrorMessage} from '@contracts/getErrorMessage';
import {
    getUnprovenNativeTerminationDetail,
    markUnprovenNativeTermination,
} from '@contracts/nativeErrors';

export interface IResolvedStreamingRasterHandoffBudget {
    producerConcurrency: number;
    maxChunkPages: number;
    maxInFlightPages: number;
    maxInFlightBytes: number;
}

export interface IProducedStagedItem<TStaged> {
    staged: TStaged;
    actualBytes: number;
}

export interface ICleanupStagedOutcome {
    /** Bytes still resident on disk because unlinking failed with a non-ENOENT error. */
    unreclaimedBytes?: number;
    /** Cleanup failure to surface when no earlier primary error exists. */
    error?: unknown;
}

export interface IRunBoundedRasterProducerConsumerInput<TItem, TStaged> {
    items: readonly TItem[];
    budget: IResolvedStreamingRasterHandoffBudget;
    signal: AbortSignal;
    estimateItemBytes: (item: TItem, index: number) => number;
    produce: (
        item: TItem,
        index: number,
        operationSignal: AbortSignal,
    ) => Promise<IProducedStagedItem<TStaged>>;
    consumeChunk: (
        chunk: readonly TStaged[],
        chunkIndex: number,
        operationSignal: AbortSignal,
    ) => Promise<void>;
    cleanupStaged: (stagedItems: readonly TStaged[]) => Promise<ICleanupStagedOutcome | void>;
}

interface IReadyEntry<TStaged> {
    staged: TStaged;
    trackedBytes: number;
}

/**
 * Bounded producer-consumer handoff between page rasterization and native
 * sidecar rendering.
 *
 * Deadlock invariant: neither producer nor consumer ever holds an external
 * broker lease while waiting for queue space or ready pages. Capacity checks
 * happen strictly before invoking `produce`, and chunk waits happen strictly
 * before invoking `consumeChunk`.
 *
 * Ordering invariant: producer workers claim ascending indices after reserving
 * queue capacity, so head-of-line `nextConsumerIndex` is never starved, and the
 * single consumer drains strictly contiguous ascending chunks.
 */
export async function runBoundedRasterProducerConsumer<TItem, TStaged>(
    input: IRunBoundedRasterProducerConsumerInput<TItem, TStaged>,
): Promise<void> {
    const {
        items,
        budget,
        signal,
        estimateItemBytes,
        produce,
        consumeChunk,
        cleanupStaged,
    } = input;
    if (items.length === 0) {
        return;
    }
    signal.throwIfAborted();

    const internalAbort = new AbortController();
    const operationSignal = AbortSignal.any([
        signal,
        internalAbort.signal,
    ]);

    const readyByIndex = new Map<number, IReadyEntry<TStaged>>();
    let nextProducerIndex = 0;
    let nextConsumerIndex = 0;
    let inFlightPages = 0;
    let inFlightBytes = 0;
    let producerDone = false;
    let failure: unknown;
    let hasFailure = false;
    const distinctFailures: unknown[] = [];
    const unprovenFailures: unknown[] = [];

    const producerWaiters = new Set<() => void>();
    const consumerWaiters = new Set<() => void>();
    let stateVersion = 0;

    const wakeWaiters = (waiters: Set<() => void>) => {
        const snapshot = [...waiters];
        waiters.clear();
        for (const wake of snapshot) {wake();}
    };

    const notifyAll = () => {
        stateVersion += 1;
        wakeWaiters(producerWaiters);
        wakeWaiters(consumerWaiters);
    };

    const waitForStateChange = (waiters: Set<() => void>, seenVersion: number) => new Promise<void>(resolve => {
        if (stateVersion !== seenVersion || operationSignal.aborted || hasFailure) {
            resolve();
            return;
        }
        const wake = () => {
            waiters.delete(wake);
            resolve();
        };
        waiters.add(wake);
    });

    const recordFailure = (error: unknown) => {
        const isUnproven = getUnprovenNativeTerminationDetail(error) !== undefined;
        if (isUnproven && !unprovenFailures.includes(error)) {
            unprovenFailures.push(error);
        }
        const isInternalAbortReflection = hasFailure
            && !isUnproven
            && error === internalAbort.signal.reason;
        if (!isInternalAbortReflection && !distinctFailures.includes(error)) {
            distinctFailures.push(error);
        }
        if (!hasFailure) {
            hasFailure = true;
            failure = error;
            if (!internalAbort.signal.aborted) {
                internalAbort.abort(error);
            }
        }
        notifyAll();
    };

    const handleExternalAbort = () => {
        notifyAll();
    };
    signal.addEventListener('abort', handleExternalAbort, {once: true});

    const estimatedBytesFor = (index: number) => {
        const estimated = estimateItemBytes(items[index]!, index);
        return Number.isFinite(estimated) && estimated > 0 ? Math.ceil(estimated) : 1;
    };

    // Single-item liveness: when nothing is currently in flight, always admit
    // the next item even if its byte size exceeds maxInFlightBytes.
    const canAdmitNext = (estimatedBytes: number) => (
        inFlightPages < budget.maxInFlightPages
        && (inFlightPages === 0 || inFlightBytes + estimatedBytes <= budget.maxInFlightBytes)
    );

    const claimNextProducerSlot = async (): Promise<{
        index: number;
        estimatedBytes: number;
    } | null> => {
        while (true) {
            if (hasFailure || operationSignal.aborted) {
                return null;
            }
            if (nextProducerIndex >= items.length) {
                return null;
            }
            const estimatedBytes = estimatedBytesFor(nextProducerIndex);
            if (canAdmitNext(estimatedBytes)) {
                const index = nextProducerIndex;
                nextProducerIndex += 1;
                inFlightPages += 1;
                inFlightBytes += estimatedBytes;
                notifyAll();
                return {
                    index,
                    estimatedBytes,
                };
            }
            // Wake consumer in case it was waiting for more pages but cannot
            // receive them until it flushes its ready prefix to free capacity.
            wakeWaiters(consumerWaiters);
            const seenVersion = stateVersion;
            await waitForStateChange(producerWaiters, seenVersion);
        }
    };

    const releaseBudget = (pages: number, bytes: number) => {
        inFlightPages = Math.max(0, inFlightPages - pages);
        inFlightBytes = Math.max(0, inFlightBytes - bytes);
        notifyAll();
    };

    const runProducerWorker = async () => {
        while (true) {
            const slot = await claimNextProducerSlot();
            if (slot === null) {
                return;
            }
            let reservedBytes = slot.estimatedBytes;
            let handedOff = false;
            try {
                const result = await produce(items[slot.index]!, slot.index, operationSignal);
                const actualBytes = Number.isFinite(result.actualBytes) && result.actualBytes >= 0
                    ? Math.ceil(result.actualBytes)
                    : reservedBytes;
                // Reconcile the initial conservative pre-write estimate (`reservedBytes`)
                // to the actual on-disk bytes once staged so subsequent admissions reflect
                // true resident scratch usage.
                inFlightBytes = Math.max(0, inFlightBytes - reservedBytes + actualBytes);
                reservedBytes = actualBytes;
                if (hasFailure || operationSignal.aborted) {
                    let unreclaimedBytes = 0;
                    if (unprovenFailures.length === 0) {
                        const cleanupOutcome = await cleanupStaged([result.staged]).catch(() => undefined);
                        if (
                            cleanupOutcome !== undefined
                            && cleanupOutcome.unreclaimedBytes !== undefined
                            && Number.isFinite(cleanupOutcome.unreclaimedBytes)
                            && cleanupOutcome.unreclaimedBytes > 0
                        ) {
                            unreclaimedBytes = Math.min(reservedBytes, Math.ceil(cleanupOutcome.unreclaimedBytes));
                        }
                    } else {
                        unreclaimedBytes = reservedBytes;
                    }
                    releaseBudget(1, Math.max(0, reservedBytes - unreclaimedBytes));
                    return;
                }
                readyByIndex.set(slot.index, {
                    staged: result.staged,
                    trackedBytes: actualBytes,
                });
                handedOff = true;
                notifyAll();
            } catch (error) {
                if (!handedOff) {
                    releaseBudget(1, reservedBytes);
                }
                recordFailure(error);
                return;
            }
        }
    };

    const producerLoop = (async () => {
        try {
            const workerCount = Math.min(budget.producerConcurrency, items.length);
            const settled = await Promise.allSettled(
                Array.from({length: workerCount}, () => runProducerWorker()),
            );
            for (const outcome of settled) {
                if (outcome.status === 'rejected') {
                    recordFailure(outcome.reason);
                }
            }
        } finally {
            producerDone = true;
            notifyAll();
        }
    })().catch(recordFailure);

    const countContiguousReadyPrefix = () => {
        let count = 0;
        while (
            count < budget.maxChunkPages
            && readyByIndex.has(nextConsumerIndex + count)
        ) {
            count += 1;
        }
        return count;
    };

    const canDispatchChunk = (readyCount: number) => {
        if (readyCount === 0) {
            return false;
        }
        if (readyCount >= budget.maxChunkPages) {
            return true;
        }
        const nextIndexAfterReady = nextConsumerIndex + readyCount;
        if (nextIndexAfterReady >= items.length) {
            return true;
        }
        if (producerDone) {
            return true;
        }
        // If the next page after the ready prefix has not even been claimed yet
        // because the queue is at its page or byte limit, dispatch this ready
        // prefix immediately so consuming it frees room for the producer.
        return nextProducerIndex === nextIndexAfterReady
            && !canAdmitNext(estimatedBytesFor(nextIndexAfterReady));
    };

    const consumerLoop = (async () => {
        let chunkIndex = 0;
        while (nextConsumerIndex < items.length) {
            if (hasFailure || operationSignal.aborted) {
                return;
            }
            const readyCount = countContiguousReadyPrefix();
            if (!canDispatchChunk(readyCount)) {
                const seenVersion = stateVersion;
                await waitForStateChange(consumerWaiters, seenVersion);
                continue;
            }
            const chunkEntries: Array<IReadyEntry<TStaged>> = [];
            for (let offset = 0; offset < readyCount; offset += 1) {
                const index = nextConsumerIndex + offset;
                const entry = readyByIndex.get(index)!;
                readyByIndex.delete(index);
                chunkEntries.push(entry);
            }
            nextConsumerIndex += readyCount;
            const stagedChunk = chunkEntries.map(entry => entry.staged);
            const chunkBytes = chunkEntries.reduce((sum, entry) => sum + entry.trackedBytes, 0);
            let chunkError: unknown;
            let chunkFailed = false;
            try {
                await consumeChunk(stagedChunk, chunkIndex, operationSignal);
                chunkIndex += 1;
            } catch (error) {
                chunkFailed = true;
                chunkError = error;
                recordFailure(error);
                return;
            } finally {
                // Unproven native termination means the sidecar may still hold
                // open input rasters; keep them until recovery completes.
                const retainForUnprovenTermination = chunkFailed
                    && getUnprovenNativeTerminationDetail(chunkError) !== undefined;
                let unreclaimedBytes = retainForUnprovenTermination ? chunkBytes : 0;
                if (!retainForUnprovenTermination) {
                    try {
                        const cleanupOutcome = await cleanupStaged(stagedChunk);
                        if (
                            cleanupOutcome !== undefined
                            && cleanupOutcome.unreclaimedBytes !== undefined
                            && Number.isFinite(cleanupOutcome.unreclaimedBytes)
                            && cleanupOutcome.unreclaimedBytes > 0
                        ) {
                            unreclaimedBytes = Math.min(chunkBytes, Math.ceil(cleanupOutcome.unreclaimedBytes));
                        }
                        if (cleanupOutcome?.error !== undefined && !chunkFailed && !hasFailure) {
                            recordFailure(cleanupOutcome.error);
                        }
                    } catch (cleanupError) {
                        unreclaimedBytes = chunkBytes;
                        if (!chunkFailed && !hasFailure) {
                            recordFailure(cleanupError);
                        }
                    }
                }
                releaseBudget(chunkEntries.length, Math.max(0, chunkBytes - unreclaimedBytes));
            }
        }
    })().catch(recordFailure);

    try {
        const settled = await Promise.allSettled([
            producerLoop,
            consumerLoop,
        ]);
        for (const outcome of settled) {
            if (outcome.status === 'rejected') {
                recordFailure(outcome.reason);
            }
        }
    } finally {
        signal.removeEventListener('abort', handleExternalAbort);
        const retainRemaining = unprovenFailures.length > 0;
        if (readyByIndex.size > 0 && !retainRemaining) {
            const leftover = [...readyByIndex.values()].map(entry => entry.staged);
            readyByIndex.clear();
            await cleanupStaged(leftover).catch(() => undefined);
        }
    }

    if (distinctFailures.length > 1) {
        const aggregate = new AggregateError(
            distinctFailures,
            getErrorMessage(distinctFailures[0]),
        );
        if (unprovenFailures.length > 0) {
            const detail = getUnprovenNativeTerminationDetail(unprovenFailures[0]);
            if (detail !== undefined) {
                markUnprovenNativeTermination(aggregate, detail);
            }
        }
        throw aggregate;
    }

    if (unprovenFailures.length > 0) {
        throw unprovenFailures[0];
    }

    if (distinctFailures.length === 1) {
        if (signal.aborted) {
            signal.throwIfAborted();
        }
        throw distinctFailures[0];
    }

    if (hasFailure) {
        if (signal.aborted) {
            signal.throwIfAborted();
        }
        throw failure;
    }
    signal.throwIfAborted();
}
