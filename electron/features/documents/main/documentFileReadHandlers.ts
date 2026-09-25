import { statSync } from 'fs';
import {
    open as openFileHandle,
    readFile,
} from 'fs/promises';
import type { FileHandle } from 'fs/promises';
import { extname } from 'path';
import { MAX_CHUNK } from '@electron/config/constants';
import {
    onWorkingCopyMutationSettled,
    onWorkingCopyMutationStarting,
} from '@electron/file-access/workingCopyMutationQueue';
import {
    captureWorkingCopyAdmissionSnapshot,
    getWorkingCopyBackingEntry,
    normalizePathForLookup,
    transitionWorkingCopyBackingState,
    workingCopyAdmissionSnapshotsMatch,
    type IWorkingCopyAdmissionSnapshot,
} from '@electron/file-access/workingCopyStore';
import {
    onWorkingCopyBackingSwapCacheInvalidation,
    WorkingCopyMaterializationError,
} from '@electron/file-access/workingCopyMaterialization';
import {
    assertWithinIpcReadBudget,
    describeRejectedReadPath,
    isAllowedBinaryReadExtension,
    normalizeNonEmptyPath,
    resolveExistingReadableDocumentOrImagePath,
    resolveReadablePath,
    resolveReadablePathSync,
} from '@electron/features/documents/main/documentFilePathResolution';
import type { IDocumentsSenderIdContext } from '@electron/features/documents/documentsContexts';

const ALLOWED_READ_EXTENSIONS = new Set([
    '.json',
    '.txt',
    '.tsv',
]);
const RANGE_READ_HANDLE_CACHE_LIMIT = 6;
const RANGE_READ_HANDLE_IDLE_MS = 30_000;
const RANGE_READ_GLOBAL_IN_FLIGHT_BYTES = 32 * 1024 * 1024;
const RANGE_READ_PER_DOCUMENT_IN_FLIGHT_BYTES = 8 * 1024 * 1024;
const RANGE_READ_MAX_WAITERS = 256;
const RANGE_READ_WAITER_TIMEOUT_MS = 30_000;
const RANGE_READ_MUTATION_CLOSE_TIMEOUT_MS = 30_000;

interface IRangeReadHandleCacheEntry {
    handle: FileHandle;
    mtimeMs: number;
    size: number;
    epoch: number;
    activeReads: number;
    closeRequested: boolean;
    closed: boolean;
    closePromise: Promise<void> | null;
    closeResolve: (() => void) | null;
    idleTimer: ReturnType<typeof setTimeout> | null;
}

interface IRangeReadHandleLease {
    handle: FileHandle;
    release(): Promise<void>;
}

interface IOriginalBackedRead {
    admissionSnapshot: IWorkingCopyAdmissionSnapshot;
    logicalRef: string;
    originalPath: string;
    registrationId: number;
    senderId?: number;
}

interface IRangeReadMutationBarrier {
    promise: Promise<void>;
    resolve: () => void;
}

const rangeReadHandles = new Map<string, IRangeReadHandleCacheEntry>();
const rangeReadHandleOpens = new Map<string, Promise<IRangeReadHandleCacheEntry>>();
const rangeReadPathEpochs = new Map<string, number>();
const rangeReadMutationBarriers = new Map<string, IRangeReadMutationBarrier>();
const pendingRangeReads = new Map<string, Promise<Uint8Array>>();
const rangeReadBytesByPath = new Map<string, number>();
let rangeReadGlobalBytes = 0;
const rangeReadBudgetWaiters: Array<{
    path: string;
    bytes: number;
    resolve: () => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}> = [];

function getRangeReadCacheKey(filePath: string) {
    return normalizePathForLookup(filePath) || filePath;
}

function canReserveRangeRead(path: string, bytes: number) {
    const cacheKey = getRangeReadCacheKey(path);
    return rangeReadGlobalBytes + bytes <= RANGE_READ_GLOBAL_IN_FLIGHT_BYTES
        && (rangeReadBytesByPath.get(cacheKey) ?? 0) + bytes <= RANGE_READ_PER_DOCUMENT_IN_FLIGHT_BYTES;
}

function reserveRangeRead(path: string, bytes: number) {
    const cacheKey = getRangeReadCacheKey(path);
    rangeReadGlobalBytes += bytes;
    rangeReadBytesByPath.set(cacheKey, (rangeReadBytesByPath.get(cacheKey) ?? 0) + bytes);
}

function pumpRangeReadBudgetWaiters() {
    for (let index = 0; index < rangeReadBudgetWaiters.length;) {
        const waiter = rangeReadBudgetWaiters[index]!;
        if (!canReserveRangeRead(waiter.path, waiter.bytes)) {
            index += 1;
            continue;
        }
        rangeReadBudgetWaiters.splice(index, 1);
        clearTimeout(waiter.timer);
        reserveRangeRead(waiter.path, waiter.bytes);
        waiter.resolve();
    }
}

async function acquireRangeReadBudget(path: string, bytes: number) {
    if (!canReserveRangeRead(path, bytes)) {
        if (rangeReadBudgetWaiters.length >= RANGE_READ_MAX_WAITERS) {
            throw new Error('PDF range read queue is full; retry after active reads finish');
        }
        await new Promise<void>((resolve, reject) => {
            const waiter = {
                path,
                bytes,
                resolve,
                reject,
                timer: setTimeout(() => {
                    const index = rangeReadBudgetWaiters.indexOf(waiter);
                    if (index >= 0) {
                        rangeReadBudgetWaiters.splice(index, 1);
                    }
                    reject(new Error('Timed out waiting for PDF range read capacity'));
                }, RANGE_READ_WAITER_TIMEOUT_MS),
            };
            rangeReadBudgetWaiters.push(waiter);
        });
    } else {
        reserveRangeRead(path, bytes);
    }
    let released = false;
    return () => {
        if (released) {
            return;
        }
        released = true;
        rangeReadGlobalBytes -= bytes;
        const cacheKey = getRangeReadCacheKey(path);
        const remaining = (rangeReadBytesByPath.get(cacheKey) ?? bytes) - bytes;
        if (remaining > 0) {
            rangeReadBytesByPath.set(cacheKey, remaining);
        } else {
            rangeReadBytesByPath.delete(cacheKey);
        }
        pumpRangeReadBudgetWaiters();
    };
}

function getRangeReadPathEpoch(resolvedPath: string) {
    return rangeReadPathEpochs.get(getRangeReadCacheKey(resolvedPath)) ?? 0;
}

function advanceRangeReadPathEpoch(resolvedPath: string) {
    const cacheKey = getRangeReadCacheKey(resolvedPath);
    const nextEpoch = getRangeReadPathEpoch(cacheKey) + 1;
    rangeReadPathEpochs.set(cacheKey, nextEpoch);
    return nextEpoch;
}

function pruneRangeReadPathEpochIfUnused(resolvedPath: string) {
    const cacheKey = getRangeReadCacheKey(resolvedPath);
    if (
        !rangeReadHandles.has(cacheKey)
        && !rangeReadHandleOpens.has(cacheKey)
        && !rangeReadMutationBarriers.has(cacheKey)
    ) {
        rangeReadPathEpochs.delete(cacheKey);
    }
}

function getOrCreateRangeReadHandleClosePromise(entry: IRangeReadHandleCacheEntry) {
    if (entry.closePromise) {
        return entry.closePromise;
    }
    let resolve!: () => void;
    entry.closePromise = new Promise<void>(promiseResolve => {
        resolve = promiseResolve;
    });
    entry.closeResolve = resolve;
    return entry.closePromise;
}

function closeRangeReadHandleEntryWhenUnused(entry: IRangeReadHandleCacheEntry) {
    const closePromise = getOrCreateRangeReadHandleClosePromise(entry);
    if (entry.closed) {
        return closePromise;
    }
    if (entry.activeReads > 0) {
        return closePromise;
    }
    entry.closed = true;
    let closeOperation: Promise<unknown>;
    try {
        closeOperation = Promise.resolve(entry.handle.close());
    } catch {
        closeOperation = Promise.resolve();
    }
    void closeOperation
        .catch(() => undefined)
        .finally(() => {
            const resolve = entry.closeResolve;
            entry.closeResolve = null;
            resolve?.();
        });
    return closePromise;
}

function requestRangeReadHandleClose(
    resolvedPath: string,
    entry: IRangeReadHandleCacheEntry,
) {
    const cacheKey = getRangeReadCacheKey(resolvedPath);
    if (rangeReadHandles.get(cacheKey) === entry) {
        rangeReadHandles.delete(cacheKey);
    }
    if (entry.idleTimer) {
        clearTimeout(entry.idleTimer);
        entry.idleTimer = null;
    }
    entry.closeRequested = true;
    return closeRangeReadHandleEntryWhenUnused(entry);
}

function scheduleRangeReadHandleIdleClose(
    resolvedPath: string,
    entry: IRangeReadHandleCacheEntry,
) {
    const cacheKey = getRangeReadCacheKey(resolvedPath);
    if (entry.activeReads > 0 || entry.closeRequested || entry.closed) {
        return;
    }
    if (entry.idleTimer) {
        clearTimeout(entry.idleTimer);
    }
    const idleTimer = setTimeout(() => {
        const currentEntry = rangeReadHandles.get(cacheKey);
        if (currentEntry !== entry) {
            return;
        }
        void requestRangeReadHandleClose(resolvedPath, entry)
            .finally(() => pruneRangeReadPathEpochIfUnused(resolvedPath));
    }, RANGE_READ_HANDLE_IDLE_MS);
    entry.idleTimer = idleTimer;
    idleTimer.unref();
}

function closeCachedRangeReadHandle(resolvedPath: string) {
    const cacheKey = getRangeReadCacheKey(resolvedPath);
    const pendingOpen = rangeReadHandleOpens.get(cacheKey);
    if (pendingOpen) {
        return pendingOpen
            .then(entry => requestRangeReadHandleClose(resolvedPath, entry))
            .catch(() => undefined)
            .then(() => {
                const entry = rangeReadHandles.get(cacheKey);
                if (!entry) {
                    return;
                }
                return requestRangeReadHandleClose(resolvedPath, entry);
            });
    }

    const entry = rangeReadHandles.get(cacheKey);
    if (!entry) {
        return;
    }
    return requestRangeReadHandleClose(resolvedPath, entry);
}

async function closeLeastRecentlyUsedRangeReadHandle() {
    const oldest = rangeReadHandles.entries().next();
    if (oldest.done) {
        return;
    }
    await requestRangeReadHandleClose(oldest.value[0], oldest.value[1]);
}

function createRangeReadMutationBarrier(resolvedPath: string) {
    const cacheKey = getRangeReadCacheKey(resolvedPath);
    const existingBarrier = rangeReadMutationBarriers.get(cacheKey);
    if (existingBarrier) {
        return existingBarrier;
    }
    let resolve!: () => void;
    const barrier: IRangeReadMutationBarrier = {
        promise: new Promise<void>(promiseResolve => {
            resolve = promiseResolve;
        }),
        resolve: () => {
            resolve();
        },
    };
    rangeReadMutationBarriers.set(cacheKey, barrier);
    return barrier;
}

function finishRangeReadMutation(resolvedPath: string) {
    const cacheKey = getRangeReadCacheKey(resolvedPath);
    const barrier = rangeReadMutationBarriers.get(cacheKey);
    if (!barrier) {
        return;
    }
    rangeReadMutationBarriers.delete(cacheKey);
    barrier.resolve();
    pruneRangeReadPathEpochIfUnused(resolvedPath);
}

function waitForRangeReadHandleCloseBeforeMutation(
    closePromise: Promise<void>,
    signal: AbortSignal,
) {
    if (signal.aborted) {
        return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
        let settled = false;
        const handleAbort = () => finish(resolve);
        const timeout = setTimeout(() => {
            finish(() => reject(new Error('Timed out closing PDF range reads before document mutation')));
        }, RANGE_READ_MUTATION_CLOSE_TIMEOUT_MS);
        function finish(settle: () => void) {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timeout);
            signal.removeEventListener('abort', handleAbort);
            settle();
        }
        timeout.unref();
        signal.addEventListener('abort', handleAbort, {once: true});
        if (signal.aborted) {
            handleAbort();
            return;
        }
        void closePromise.then(
            () => finish(resolve),
            error => finish(() => reject(error)),
        );
    });
}

async function acquireRangeReadHandle(resolvedPath: string): Promise<IRangeReadHandleLease> {
    const cacheKey = getRangeReadCacheKey(resolvedPath);
    for (;;) {
        const mutationBarrier = rangeReadMutationBarriers.get(cacheKey);
        if (mutationBarrier) {
            await mutationBarrier.promise;
        }
        const {
            mtimeMs,
            size,
        } = statSync(resolvedPath);
        const epoch = getRangeReadPathEpoch(cacheKey);
        const cachedEntry = rangeReadHandles.get(cacheKey);
        if (cachedEntry) {
            if (
                cachedEntry.size === size
                && cachedEntry.mtimeMs === mtimeMs
                && cachedEntry.epoch === epoch
                && !cachedEntry.closeRequested
                && !cachedEntry.closed
            ) {
                return acquireRangeReadHandleEntry(cacheKey, cachedEntry);
            }
            await requestRangeReadHandleClose(resolvedPath, cachedEntry);
        }

        const pendingOpen = rangeReadHandleOpens.get(cacheKey);
        if (pendingOpen) {
            const pendingEntry = await pendingOpen;
            if (
                rangeReadHandles.get(cacheKey) === pendingEntry
                && pendingEntry.size === size
                && pendingEntry.mtimeMs === mtimeMs
                && pendingEntry.epoch === getRangeReadPathEpoch(cacheKey)
                && !pendingEntry.closeRequested
                && !pendingEntry.closed
            ) {
                return acquireRangeReadHandleEntry(cacheKey, pendingEntry);
            }
            await requestRangeReadHandleClose(resolvedPath, pendingEntry);
            continue;
        }

        while (rangeReadHandles.size >= RANGE_READ_HANDLE_CACHE_LIMIT) {
            await closeLeastRecentlyUsedRangeReadHandle();
        }

        const openPromise = (async () => {
            const handle = await openFileHandle(resolvedPath, 'r');
            const entry: IRangeReadHandleCacheEntry = {
                handle,
                mtimeMs,
                size,
                epoch,
                activeReads: 0,
                closeRequested: false,
                closed: false,
                closePromise: null,
                closeResolve: null,
                idleTimer: null,
            };
            if (epoch !== getRangeReadPathEpoch(cacheKey)) {
                await requestRangeReadHandleClose(resolvedPath, entry);
                return entry;
            }

            rangeReadHandles.set(cacheKey, entry);
            return entry;
        })();
        rangeReadHandleOpens.set(cacheKey, openPromise);
        const entry = await openPromise.finally(() => {
            if (rangeReadHandleOpens.get(cacheKey) === openPromise) {
                rangeReadHandleOpens.delete(cacheKey);
            }
        });
        if (
            rangeReadHandles.get(cacheKey) === entry
            && entry.epoch === getRangeReadPathEpoch(cacheKey)
            && !entry.closeRequested
            && !entry.closed
        ) {
            return acquireRangeReadHandleEntry(cacheKey, entry);
        }
        await requestRangeReadHandleClose(resolvedPath, entry);
    }
}

function acquireRangeReadHandleEntry(
    resolvedPath: string,
    entry: IRangeReadHandleCacheEntry,
): IRangeReadHandleLease {
    const cacheKey = getRangeReadCacheKey(resolvedPath);
    if (entry.idleTimer) {
        clearTimeout(entry.idleTimer);
        entry.idleTimer = null;
    }
    rangeReadHandles.delete(cacheKey);
    rangeReadHandles.set(cacheKey, entry);
    entry.activeReads += 1;
    let released = false;
    return {
        handle: entry.handle,
        async release() {
            if (released) {
                return;
            }
            released = true;
            entry.activeReads -= 1;
            if (entry.closeRequested) {
                await closeRangeReadHandleEntryWhenUnused(entry);
            } else {
                scheduleRangeReadHandleIdleClose(cacheKey, entry);
            }
        },
    };
}

function createSourceBackingError(
    code: 'SOURCE_BACKING_CHANGED' | 'SOURCE_BACKING_UNAVAILABLE',
    cause?: unknown,
) {
    return new WorkingCopyMaterializationError(
        code,
        code === 'SOURCE_BACKING_CHANGED'
            ? 'The original document changed after it was opened'
            : 'The original document is unavailable',
        cause === undefined ? {} : {cause},
    );
}

function failOriginalBacking(
    backing: IOriginalBackedRead,
    code: 'SOURCE_BACKING_CHANGED' | 'SOURCE_BACKING_UNAVAILABLE',
    cause?: unknown,
): never {
    const entry = getWorkingCopyBackingEntry(backing.logicalRef, backing.senderId);
    if (entry?.registrationId === backing.registrationId) {
        transitionWorkingCopyBackingState(
            backing.logicalRef,
            backing.registrationId,
            'lazy-original',
            {
                expectedBackingState: [
                    'lazy-original',
                    'materializing',
                ],
                sourceBackingErrorCode: code,
            },
        );
    }
    throw createSourceBackingError(code, cause);
}

function resolveOriginalBackedRead(
    logicalRef: string,
    senderId?: number,
): IOriginalBackedRead | null {
    const entry = getWorkingCopyBackingEntry(logicalRef, senderId);
    if (
        !entry
        || (
            entry.backingState !== 'lazy-original'
            && entry.backingState !== 'materializing'
        )
    ) {
        return null;
    }
    if (
        entry.sourceBackingErrorCode === 'SOURCE_BACKING_CHANGED'
        || entry.sourceBackingErrorCode === 'SOURCE_BACKING_UNAVAILABLE'
    ) {
        throw createSourceBackingError(entry.sourceBackingErrorCode);
    }
    if (!entry.admissionSnapshot) {
        throw new WorkingCopyMaterializationError(
            'WORKING_COPY_MATERIALIZATION_FAILED',
            'Lazy working copy has no admission snapshot',
        );
    }
    return {
        admissionSnapshot: entry.admissionSnapshot,
        logicalRef,
        originalPath: entry.originalPath,
        registrationId: entry.registrationId,
        ...(senderId === undefined ? {} : {senderId}),
    };
}

export function resolveOriginalBackedReadTransport(
    logicalRef: string,
    senderId?: number,
) {
    const backing = resolveOriginalBackedRead(logicalRef, senderId);
    if (!backing) {
        return null;
    }
    return {
        identity: {
            size: Number(backing.admissionSnapshot.size),
            modifiedAt: Math.trunc(Number(backing.admissionSnapshot.mtimeNs) / 1_000_000),
        },
        read: async <T>(reader: (physicalPath: string) => Promise<T>) => {
            await assertOriginalBackingSnapshot(backing);
            try {
                return await reader(backing.originalPath);
            } finally {
                await assertOriginalBackingSnapshot(backing);
            }
        },
    };
}

async function assertOriginalBackingSnapshot(backing: IOriginalBackedRead) {
    let snapshot: IWorkingCopyAdmissionSnapshot;
    try {
        snapshot = await captureWorkingCopyAdmissionSnapshot(backing.originalPath);
    } catch (error) {
        failOriginalBacking(backing, 'SOURCE_BACKING_UNAVAILABLE', error);
    }
    if (!workingCopyAdmissionSnapshotsMatch(snapshot, backing.admissionSnapshot)) {
        failOriginalBacking(backing, 'SOURCE_BACKING_CHANGED');
    }
    const currentEntry = getWorkingCopyBackingEntry(backing.logicalRef, backing.senderId);
    if (!currentEntry || currentEntry.registrationId !== backing.registrationId) {
        throw new WorkingCopyMaterializationError(
            'WORKING_COPY_REGISTRATION_CHANGED',
            'Working-copy registration changed during the read',
        );
    }
    if (
        currentEntry.sourceBackingErrorCode === 'SOURCE_BACKING_CHANGED'
        || currentEntry.sourceBackingErrorCode === 'SOURCE_BACKING_UNAVAILABLE'
    ) {
        throw createSourceBackingError(currentEntry.sourceBackingErrorCode);
    }
    return snapshot;
}

// Original-backed reads share the rangeReadHandles cache keyed by the original
// path: the backing-swap invalidation event fires with that path, so a swap or
// materialization closes the cached handle. Every read runs the admission-
// snapshot assert both before and after the bytes are read: a same-size
// in-place rewrite during the read window would otherwise hand torn bytes to
// the renderer, and a short read whose snapshot still matches is a source
// anomaly that must fail rather than return a truncated document.
async function readOriginalBacking(
    backing: IOriginalBackedRead,
) {
    await assertOriginalBackingSnapshot(backing);
    const size = Number(backing.admissionSnapshot.size);
    assertWithinIpcReadBudget(backing.logicalRef, size);
    const buffer = Buffer.allocUnsafe(size);
    let totalBytesRead = 0;
    let lease: IRangeReadHandleLease | null = null;
    try {
        lease = await acquireRangeReadHandle(backing.originalPath);
        while (totalBytesRead < size) {
            const {bytesRead} = await lease.handle.read(
                buffer,
                totalBytesRead,
                size - totalBytesRead,
                totalBytesRead,
            );
            if (bytesRead <= 0) {
                break;
            }
            totalBytesRead += bytesRead;
        }
    } catch (error) {
        failOriginalBacking(backing, 'SOURCE_BACKING_UNAVAILABLE', error);
    } finally {
        await lease?.release();
    }
    await assertOriginalBackingSnapshot(backing);
    if (totalBytesRead !== size) {
        failOriginalBacking(backing, 'SOURCE_BACKING_UNAVAILABLE');
    }
    return new Uint8Array(buffer);
}

async function statOriginalBacking(backing: IOriginalBackedRead) {
    const snapshot = await assertOriginalBackingSnapshot(backing);
    return {
        size: Number(snapshot.size),
        modifiedAt: Math.trunc(Number(snapshot.mtimeNs) / 1_000_000),
    };
}

async function readOriginalBackingRange(
    backing: IOriginalBackedRead,
    offset: number,
    length: number,
) {
    await assertOriginalBackingSnapshot(backing);
    const buffer = Buffer.allocUnsafe(length);
    let bytesRead = 0;
    let lease: IRangeReadHandleLease | null = null;
    try {
        lease = await acquireRangeReadHandle(backing.originalPath);
        ({bytesRead} = await lease.handle.read(buffer, 0, length, offset));
    } catch (error) {
        failOriginalBacking(backing, 'SOURCE_BACKING_UNAVAILABLE', error);
    } finally {
        await lease?.release();
    }
    await assertOriginalBackingSnapshot(backing);
    return new Uint8Array(buffer.subarray(0, bytesRead));
}

async function invalidateCachedRangeReadPath(resolvedPath: string) {
    advanceRangeReadPathEpoch(resolvedPath);
    await closeCachedRangeReadHandle(resolvedPath);
    pruneRangeReadPathEpochIfUnused(resolvedPath);
}

// Keep range readers out of the replacement window. The barrier is installed
// before closing the current handle, so a reader that arrives while an active
// read drains cannot reopen the path before the mutation has settled.
onWorkingCopyMutationStarting((workingCopyPath, signal) => {
    createRangeReadMutationBarrier(workingCopyPath);
    advanceRangeReadPathEpoch(workingCopyPath);
    const closePromise = closeCachedRangeReadHandle(workingCopyPath);
    if (!closePromise) {
        return;
    }
    return waitForRangeReadHandleCloseBeforeMutation(closePromise, signal).catch(error => {
        finishRangeReadMutation(workingCopyPath);
        throw error;
    });
});

onWorkingCopyMutationSettled((workingCopyPath) => {
    advanceRangeReadPathEpoch(workingCopyPath);
    void Promise.resolve(closeCachedRangeReadHandle(workingCopyPath))
        .finally(() => {
            finishRangeReadMutation(workingCopyPath);
            pruneRangeReadPathEpochIfUnused(workingCopyPath);
        });
});

onWorkingCopyBackingSwapCacheInvalidation(async (logicalRef, previousPhysicalPath) => {
    await Promise.all(
        [...new Set([
            logicalRef,
            previousPhysicalPath,
        ])].map(invalidateCachedRangeReadPath),
    );
});

export async function closeCachedRangeReadHandles() {
    await Promise.all(
        Array.from(rangeReadHandleOpens.entries(), async ([
            resolvedPath,
            pendingEntry,
        ]) => {
            advanceRangeReadPathEpoch(resolvedPath);
            return pendingEntry
                .then(entry => requestRangeReadHandleClose(resolvedPath, entry))
                .catch(() => undefined);
        }),
    );
    await Promise.all(
        Array.from(rangeReadHandles.entries(), async ([
            resolvedPath,
            entry,
        ]) => {
            advanceRangeReadPathEpoch(resolvedPath);
            return requestRangeReadHandleClose(resolvedPath, entry);
        }),
    );
    for (const resolvedPath of rangeReadPathEpochs.keys()) {
        pruneRangeReadPathEpochIfUnused(resolvedPath);
    }
}

export async function clearCachedRangeReadHandlesForTests() {
    await closeCachedRangeReadHandles();
    rangeReadPathEpochs.clear();
}

export function getRangeReadCacheStatsForTests() {
    return {
        handles: rangeReadHandles.size,
        pendingOpens: rangeReadHandleOpens.size,
        pathEpochs: rangeReadPathEpochs.size,
        pendingReads: pendingRangeReads.size,
        inFlightBytes: rangeReadGlobalBytes,
        budgetWaiters: rangeReadBudgetWaiters.length,
    };
}

export async function handleFileRead(context: IDocumentsSenderIdContext, filePath: unknown) {
    const normalizedPath = normalizeNonEmptyPath(filePath);
    const extension = extname(normalizedPath).toLowerCase();

    if (!isAllowedBinaryReadExtension(extension)) {
        throw new Error('Invalid file type: only supported document and image files are allowed');
    }

    const resolvedPath = await resolveReadablePath(normalizedPath, extension, context.senderId);
    if (!resolvedPath) {
        throw new Error(describeRejectedReadPath(normalizedPath, context.senderId));
    }

    const originalBacking = resolveOriginalBackedRead(resolvedPath, context.senderId);
    if (originalBacking) {
        return readOriginalBacking(originalBacking);
    }

    let size: number;
    try {
        ({size} = statSync(resolvedPath));
    } catch {
        throw new Error(`File not found: ${normalizedPath}`);
    }

    assertWithinIpcReadBudget(resolvedPath, size);
    const buffer = await readFile(resolvedPath);
    return new Uint8Array(buffer);
}

export async function handleFileStat(
    context: IDocumentsSenderIdContext,
    filePath: unknown,
): Promise<{
    size: number;
    modifiedAt: number
}> {
    const resolvedPath = await resolveExistingReadableDocumentOrImagePath(filePath, context.senderId);
    const originalBacking = resolveOriginalBackedRead(resolvedPath, context.senderId);
    if (originalBacking) {
        return statOriginalBacking(originalBacking);
    }
    // Sync on purpose: packaged Windows Electron mishandles fs.promises
    // metadata calls through its ASAR fs shim (issue #82).
    const s = statSync(resolvedPath);
    return {
        size: s.size,
        modifiedAt: Math.trunc(s.mtimeMs),
    };
}

export async function handleFileReadRange(
    context: IDocumentsSenderIdContext,
    filePath: unknown,
    offset: unknown,
    length: unknown,
) {
    const resolvedPath = await resolveExistingReadableDocumentOrImagePath(filePath, context.senderId);
    const originalBacking = resolveOriginalBackedRead(resolvedPath, context.senderId);
    const off = Number(offset);
    const len = Number(length);
    if (
        !Number.isSafeInteger(off)
        || !Number.isSafeInteger(len)
        || off < 0
        || len <= 0
    ) {
        throw new Error('Invalid range: offset must be >=0 and length must be >0');
    }

    const want = Math.min(len, MAX_CHUNK);

    const cacheKey = getRangeReadCacheKey(resolvedPath);
    const readKey = `${cacheKey}\0${originalBacking?.registrationId ?? 'managed'}\0${off}\0${want}\0${getRangeReadPathEpoch(cacheKey)}`;
    const existingRead = pendingRangeReads.get(readKey);
    if (existingRead) {
        return existingRead;
    }

    const readPromise = (async () => {
        const releaseBudget = await acquireRangeReadBudget(resolvedPath, want);
        let lease: IRangeReadHandleLease | null = null;
        try {
            if (originalBacking) {
                return await readOriginalBackingRange(originalBacking, off, want);
            }
            lease = await acquireRangeReadHandle(resolvedPath);
            const buf = Buffer.allocUnsafe(want);
            const { bytesRead } = await lease.handle.read(buf, 0, want, off);
            return new Uint8Array(buf.subarray(0, bytesRead));
        } finally {
            await lease?.release();
            releaseBudget();
        }
    })();
    pendingRangeReads.set(readKey, readPromise);
    return readPromise.finally(() => {
        if (pendingRangeReads.get(readKey) === readPromise) {
            pendingRangeReads.delete(readKey);
        }
    });
}

export async function handleFileReadText(
    context: IDocumentsSenderIdContext,
    filePath: unknown,
) {
    const normalizedPath = normalizeNonEmptyPath(filePath);
    const extension = extname(normalizedPath).toLowerCase();

    if (!ALLOWED_READ_EXTENSIONS.has(extension)) {
        throw new Error('Invalid file type: only .json, .txt, and .tsv files are allowed');
    }

    const resolvedPath = await resolveReadablePath(normalizedPath, extension, context.senderId);
    if (!resolvedPath) {
        throw new Error(describeRejectedReadPath(normalizedPath, context.senderId));
    }

    let size: number;
    try {
        ({size} = statSync(resolvedPath));
    } catch {
        throw new Error(`File not found: ${normalizedPath}`);
    }

    assertWithinIpcReadBudget(resolvedPath, size);
    const buffer = await readFile(resolvedPath, 'utf-8');
    return buffer;
}

export function handleFileExists(
    context: IDocumentsSenderIdContext,
    filePath: unknown,
) {
    if (typeof filePath !== 'string') {
        return false;
    }

    const normalizedPath = filePath.trim();
    if (!normalizedPath) {
        return false;
    }

    const resolvedPath = resolveReadablePathSync(normalizedPath, context.senderId);
    if (!resolvedPath) {
        return false;
    }

    return true;
}
