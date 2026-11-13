import { statSync } from 'fs';
import {
    open as openFileHandle,
    readFile,
} from 'fs/promises';
import { MAX_CHUNK } from '@electron/config/constants';
import type {IFileStatResult} from '@contracts/electronApiDocuments';
import {requireEpochMs} from '@contracts/timestamps';
import {
    getWorkingCopyBackingEntry,
    readOpenDocument,
    runWithWorkingCopyReadBacking,
    statOpenDocument,
} from '@electron/file-access/documentStore';
import {normalizePathForLookup} from '@electron/file-access/normalizePathForLookup';
import {
    assertWithinIpcReadBudget,
    resolveExistingReadableDocumentOrImagePath,
} from '@electron/features/documents/main/documentFilePathResolution';
import type { IDocumentsSenderIdContext } from '@electron/features/documents/documentsContexts';
import {quarantineWorkingCopy} from '@electron/file-access/workingCopyQuarantine';
import { getUnprovenNativeTerminationDetail } from '@electron/utils/nativeTerminationProof';

const RANGE_READ_GLOBAL_IN_FLIGHT_BYTES = 32 * 1024 * 1024;
const RANGE_READ_PER_DOCUMENT_IN_FLIGHT_BYTES = 8 * 1024 * 1024;
const RANGE_READ_MAX_WAITERS = 256;
const RANGE_READ_WAITER_TIMEOUT_MS = 30_000;

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

/**
 * Runs a native read of `path`. A reader whose termination cannot be proven may still hold the file, so the
 * document it belongs to is quarantined rather than deleted when it closes.
 */
export async function withContentReadLease<T>(logicalRef: string, reader: () => Promise<T>) {
    try {
        return await reader();
    } catch (error) {
        const unprovenTermination = getUnprovenNativeTerminationDetail(error);
        if (unprovenTermination !== undefined) quarantineWorkingCopy(logicalRef, unprovenTermination);
        throw error;
    }
}

/**
 * How a native reader reaches the bytes behind an open document's ref: the current revision file, or the
 * destination while the document has none of its own, checked unchanged around the read. `null` for other paths.
 */
export function resolveDocumentReadTransport(logicalRef: string, senderId?: number) {
    const entry = getWorkingCopyBackingEntry(logicalRef, senderId);
    if (!entry) {
        return null;
    }
    const identity = statOpenDocument(entry);
    return {
        identity,
        read: <T>(reader: (physicalPath: string) => Promise<T>) => withContentReadLease(entry.ref, () =>
            runWithWorkingCopyReadBacking(entry.ref, reader, senderId === undefined ? {} : {ownerWebContentsId: senderId})),
    };
}

export async function handleFileRead(context: IDocumentsSenderIdContext, filePath: unknown) {
    const resolvedPath = await resolveExistingReadableDocumentOrImagePath(filePath, context.senderId);
    const entry = getWorkingCopyBackingEntry(resolvedPath, context.senderId);
    if (entry) {
        const {size} = statOpenDocument(entry);
        assertWithinIpcReadBudget(resolvedPath, size);
        return readOpenDocument(entry, 0, size);
    }

    let size: number;
    try {
        ({size} = statSync(resolvedPath));
    } catch {
        throw new Error(`File not found: ${String(filePath)}`);
    }

    assertWithinIpcReadBudget(resolvedPath, size);
    const buffer = await readFile(resolvedPath);
    return new Uint8Array(buffer);
}

export async function handleFileStat(
    context: IDocumentsSenderIdContext,
    filePath: unknown,
): Promise<IFileStatResult> {
    const resolvedPath = await resolveExistingReadableDocumentOrImagePath(filePath, context.senderId);
    const entry = getWorkingCopyBackingEntry(resolvedPath, context.senderId);
    // Sync on purpose: packaged Windows Electron mishandles fs.promises
    // metadata calls through its ASAR fs shim (issue #82).
    const s = entry ? statOpenDocument(entry) : statSync(resolvedPath);
    return {
        size: s.size,
        modifiedAt: requireEpochMs(Math.trunc('mtimeMs' in s ? s.mtimeMs : s.modifiedAt)),
    };
}

async function readFileRange(path: string, offset: number, length: number) {
    const handle = await openFileHandle(path, 'r');
    try {
        const buf = Buffer.allocUnsafe(length);
        const { bytesRead } = await handle.read(buf, 0, length, offset);
        return new Uint8Array(buf.subarray(0, bytesRead));
    } finally {
        await handle.close();
    }
}

export async function handleFileReadRange(
    context: IDocumentsSenderIdContext,
    filePath: unknown,
    offset: unknown,
    length: unknown,
) {
    const resolvedPath = await resolveExistingReadableDocumentOrImagePath(filePath, context.senderId);
    const entry = getWorkingCopyBackingEntry(resolvedPath, context.senderId);
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
    const revision = entry?.doc.state().current?.id ?? 0;
    const readKey = `${getRangeReadCacheKey(resolvedPath)}\0${entry?.registrationId ?? 'file'}\0${revision}\0${off}\0${want}`;
    const existingRead = pendingRangeReads.get(readKey);
    if (existingRead) {
        return existingRead;
    }

    const readPromise = (async () => {
        const releaseBudget = await acquireRangeReadBudget(resolvedPath, want);
        try {
            return entry ? await readOpenDocument(entry, off, want) : await readFileRange(resolvedPath, off, want);
        } finally {
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

