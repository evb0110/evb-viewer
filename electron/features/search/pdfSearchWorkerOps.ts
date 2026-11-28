import {randomUUID} from 'node:crypto';
import {constants as fsConstants, open, rename, rm, writeFile, type FileHandle} from 'node:fs/promises';
import {
    decodePdfSearchIndexWasmOutput,
    decodePdfSearchJsonOutput,
    encodePdfSearchWasmRequest,
    isStaleSearchIndexAnswer,
    PDF_SEARCH_WASM_MAX_INDEX_BYTES,
    type IPdfSearchWasmQueryFields,
} from '@contracts/searchIndexWire';
import {PdfSearchNativeError, type createPdfSearchWasmRunner} from '@electron/features/search/pdfSearchWasmRunner';

const INDEX_READ_CHUNK_BYTES = 1024 * 1024;
const INDEX_EOF_PROBE_BYTES = 4096;
export const DEFAULT_DESKTOP_SEARCH_WORKER_INDEX_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_DESKTOP_SEARCH_WORKER_INDEX_CACHE_IDLE_TTL_MS = 30_000;

interface ICachedWorkerIndexEntry {
    readonly documentRevision: string;
    readonly indexBytes: Uint8Array;
    readonly byteLength: number;
}

export interface IPdfSearchWorkerIndexCacheOptions {
    maxBytes?: number;
    idleTtlMs?: number;
}

export interface IPdfSearchWorkerIndexCacheToken {
    readonly globalEvictSeq: number;
    readonly pathSeq: number;
}

export interface IPdfSearchWorkerIndexCache {
    captureToken(indexPath: string): IPdfSearchWorkerIndexCacheToken;
    get(indexPath: string, documentRevision: string, maxIndexBytes: number): Uint8Array | null;
    set(indexPath: string, documentRevision: string, indexBytes: Uint8Array, expectedToken?: IPdfSearchWorkerIndexCacheToken): void;
    evict(indexPath?: string): void;
    stats(): {entryCount: number; totalBytes: number};
}

export function createPdfSearchWorkerIndexCache(options: IPdfSearchWorkerIndexCacheOptions = {}): IPdfSearchWorkerIndexCache {
    const maxBytes = options.maxBytes ?? DEFAULT_DESKTOP_SEARCH_WORKER_INDEX_CACHE_MAX_BYTES;
    const idleTtlMs = options.idleTtlMs ?? DEFAULT_DESKTOP_SEARCH_WORKER_INDEX_CACHE_IDLE_TTL_MS;
    const entries = new Map<string, ICachedWorkerIndexEntry>();
    const pathEvictSeq = new Map<string, number>();
    let globalEvictSeq = 0;
    let nextPathSeq = 0;
    let totalBytes = 0;
    let idleTimer: NodeJS.Timeout | null = null;

    const clearIdleTimer = () => {
        if (idleTimer !== null) {
            clearTimeout(idleTimer);
            idleTimer = null;
        }
    };

    const scheduleIdleClear = () => {
        clearIdleTimer();
        if (entries.size === 0 || idleTtlMs <= 0) {
            return;
        }
        idleTimer = setTimeout(() => {
            idleTimer = null;
            globalEvictSeq += 1;
            pathEvictSeq.clear();
            entries.clear();
            totalBytes = 0;
        }, idleTtlMs);
        idleTimer.unref?.();
    };

    const deleteEntry = (indexPath: string) => {
        const existing = entries.get(indexPath);
        if (!existing) {
            return;
        }
        entries.delete(indexPath);
        totalBytes -= existing.byteLength;
        if (entries.size === 0) {
            clearIdleTimer();
        }
    };

    return {
        captureToken(indexPath) {
            return {
                globalEvictSeq,
                pathSeq: pathEvictSeq.get(indexPath) ?? 0,
            };
        },
        get(indexPath, documentRevision, maxIndexBytes) {
            const entry = entries.get(indexPath);
            if (!entry) {
                return null;
            }
            if (entry.documentRevision !== documentRevision) {
                deleteEntry(indexPath);
                return null;
            }
            if (entry.byteLength > maxIndexBytes) {
                return null;
            }
            // Refresh LRU order.
            entries.delete(indexPath);
            entries.set(indexPath, entry);
            scheduleIdleClear();
            return entry.indexBytes;
        },
        set(indexPath, documentRevision, indexBytes, expectedToken) {
            if (
                expectedToken !== undefined &&
                (expectedToken.globalEvictSeq !== globalEvictSeq || expectedToken.pathSeq !== (pathEvictSeq.get(indexPath) ?? 0))
            ) {
                // An eviction landed while disk I/O was in flight; never resurrect evicted entries.
                return;
            }
            deleteEntry(indexPath);
            const byteLength = indexBytes.byteLength;
            if (byteLength === 0 || byteLength > maxBytes) {
                return;
            }
            while (entries.size > 0 && totalBytes + byteLength > maxBytes) {
                const oldestKey = entries.keys().next().value;
                if (typeof oldestKey !== 'string') {
                    break;
                }
                deleteEntry(oldestKey);
            }
            entries.set(indexPath, {
                documentRevision,
                indexBytes,
                byteLength,
            });
            totalBytes += byteLength;
            scheduleIdleClear();
        },
        evict(indexPath) {
            if (indexPath === undefined) {
                globalEvictSeq += 1;
                pathEvictSeq.clear();
                entries.clear();
                totalBytes = 0;
                clearIdleTimer();
                return;
            }
            nextPathSeq += 1;
            pathEvictSeq.set(indexPath, nextPathSeq);
            deleteEntry(indexPath);
        },
        stats() {
            return {
                entryCount: entries.size,
                totalBytes,
            };
        },
    };
}

function getIndexOpenFlags(): number | string {
    return typeof fsConstants?.O_RDONLY === 'number' ? fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0) : 'r';
}

export interface IExecutePdfSearchWorkerCommandOptions {
    maxIndexBytes?: number;
    indexCache?: IPdfSearchWorkerIndexCache;
}

export type TPdfSearchWorkerCommand =
    | {
          op: 'index';
          indexPath: string;
          documentRevision: string;
          pageCount?: number;
          maxPageTextBytes: number;
          maxTotalTextBytes: number;
          pagesBuffer: Uint8Array;
      }
    | {
          op: 'stat';
          indexPath: string;
          documentRevision: string;
      }
    | ({
          op: 'search';
          indexPath: string;
          documentRevision: string;
      } & IPdfSearchWasmQueryFields)
    | ({
          op: 'searchPages';
          documentRevision: string;
          pageCount?: number;
          allowRegex?: boolean;
          pagesBuffer: Uint8Array;
      } & IPdfSearchWasmQueryFields)
    | {
          op: 'evict';
          indexPath?: string;
      };

function resolveStagedIndexPath(command: Extract<TPdfSearchWorkerCommand, {op: 'index'}>): string | undefined {
    if (!('stagedIndexPath' in command)) {
        return undefined;
    }
    const candidate: unknown = (command as {stagedIndexPath?: unknown}).stagedIndexPath;
    if (typeof candidate === 'string' && candidate !== command.indexPath && candidate.startsWith(`${command.indexPath}.tmp-`)) {
        return candidate;
    }
    return undefined;
}

function isErrnoCode(error: unknown, code: string) {
    return typeof error === 'object' && error !== null && 'code' in error && (error as {code?: unknown}).code === code;
}

function resolveMaxIndexBytes(override: number | undefined): number {
    if (override === undefined) {
        return PDF_SEARCH_WASM_MAX_INDEX_BYTES;
    }
    if (typeof override !== 'number' || !Number.isSafeInteger(override) || override < 0) {
        throw new PdfSearchNativeError('invalid-request', 'Search index admission ceiling must be a non-negative safe integer');
    }
    return override;
}

async function readIndexFileOrNull(indexPath: string, maxIndexBytes = PDF_SEARCH_WASM_MAX_INDEX_BYTES): Promise<Uint8Array | null> {
    let handle: FileHandle | null = null;
    try {
        handle = await open(indexPath, getIndexOpenFlags());
        const info = await handle.stat();
        if (!info.isFile()) {
            throw new PdfSearchNativeError('io', 'Search index path is not a regular file');
        }
        if (info.size > maxIndexBytes) {
            throw new PdfSearchNativeError('too-large', `Search index exceeds the ${maxIndexBytes}-byte admission ceiling`);
        }

        const initial = new Uint8Array(info.size);
        let totalBytes = 0;
        while (totalBytes < info.size) {
            const toRead = Math.min(INDEX_READ_CHUNK_BYTES, info.size - totalBytes);
            const {bytesRead} = await handle.read(initial, totalBytes, toRead, totalBytes);
            if (bytesRead === 0) {
                return initial.slice(0, totalBytes);
            }
            totalBytes += bytesRead;
        }

        const maxProbeBytes = maxIndexBytes + 1;
        let growthBuffer: Uint8Array | null = null;
        let growthUsed = 0;
        let scratch = Buffer.allocUnsafe(Math.min(INDEX_EOF_PROBE_BYTES, maxProbeBytes - totalBytes));
        while (totalBytes < maxProbeBytes) {
            const remainingBudget = maxProbeBytes - totalBytes;
            const targetScratchSize =
                growthUsed === 0 ? Math.min(INDEX_EOF_PROBE_BYTES, remainingBudget) : Math.min(INDEX_READ_CHUNK_BYTES, remainingBudget);
            if (scratch.byteLength < targetScratchSize) {
                scratch = Buffer.allocUnsafe(targetScratchSize);
            }
            const toRead = Math.min(scratch.byteLength, remainingBudget);
            const {bytesRead} = await handle.read(scratch, 0, toRead, totalBytes);
            if (bytesRead === 0) {
                break;
            }
            totalBytes += bytesRead;
            if (totalBytes > maxIndexBytes) {
                throw new PdfSearchNativeError('too-large', `Search index exceeds the ${maxIndexBytes}-byte admission ceiling`);
            }
            const maxExtraCapacity = maxIndexBytes - initial.byteLength;
            const needed = growthUsed + bytesRead;
            if (growthBuffer === null) {
                const capacity = Math.min(maxExtraCapacity, Math.max(needed, INDEX_EOF_PROBE_BYTES));
                growthBuffer = new Uint8Array(capacity);
            } else if (needed > growthBuffer.byteLength) {
                const nextCapacity = Math.min(maxExtraCapacity, Math.max(needed, growthBuffer.byteLength * 2));
                const next = new Uint8Array(nextCapacity);
                next.set(growthBuffer.subarray(0, growthUsed), 0);
                growthBuffer = next;
            }
            growthBuffer.set(scratch.subarray(0, bytesRead), growthUsed);
            growthUsed = needed;
        }

        if (growthUsed === 0 || growthBuffer === null) {
            return initial;
        }
        const combined = new Uint8Array(totalBytes);
        combined.set(initial, 0);
        combined.set(growthBuffer.subarray(0, growthUsed), initial.byteLength);
        return combined;
    } catch (error) {
        if (isErrnoCode(error, 'ENOENT')) {
            return null;
        }
        if (error instanceof PdfSearchNativeError) {
            throw error;
        }
        throw new PdfSearchNativeError('io', `Search index could not be read: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
        await handle?.close().catch(() => undefined);
    }
}

async function writeIndexFileAtomic(indexPath: string, bytes: Uint8Array, stagedIndexPath?: string) {
    const tempPath = stagedIndexPath ?? `${indexPath}.tmp-${process.pid}-${randomUUID()}`;
    try {
        await writeFile(tempPath, bytes);
        await rename(tempPath, indexPath);
    } catch (error) {
        await rm(tempPath, {force: true}).catch(() => undefined);
        throw new PdfSearchNativeError(
            'io',
            `Search index could not be written: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
}

export async function executePdfSearchWorkerCommand(
    runner: ReturnType<typeof createPdfSearchWasmRunner>,
    command: TPdfSearchWorkerCommand,
    options: IExecutePdfSearchWorkerCommandOptions = {},
): Promise<unknown> {
    const maxIndexBytes = resolveMaxIndexBytes(options.maxIndexBytes);
    const {indexCache} = options;
    const runWithPressureGuard = (request: Uint8Array) => {
        const memoryBefore = runner.memoryBytes();
        try {
            const output = runner.run(request);
            // If the WASM runner dropped its linear memory after crossing highWaterBytes,
            // release cached index bytes from other documents under memory pressure.
            if (indexCache && memoryBefore > 0 && runner.memoryBytes() === 0) {
                indexCache.evict();
            }
            return output;
        } catch (error) {
            if (error instanceof PdfSearchNativeError && (error.code === 'too-large' || error.code === 'panic')) {
                indexCache?.evict();
            }
            throw error;
        }
    };
    switch (command.op) {
        case 'evict': {
            indexCache?.evict(command.indexPath);
            return {evicted: true};
        }
        case 'index': {
            // Immediately drop any previous cached revision for this document.
            indexCache?.evict(command.indexPath);
            const cacheToken = indexCache?.captureToken(command.indexPath);
            const request = encodePdfSearchWasmRequest(
                {
                    op: 'index',
                    documentRevision: command.documentRevision,
                    ...(command.pageCount === undefined ? {} : {pageCount: command.pageCount}),
                    maxPageTextBytes: command.maxPageTextBytes,
                    maxTotalTextBytes: command.maxTotalTextBytes,
                },
                command.pagesBuffer,
            );
            const output = runWithPressureGuard(request);
            const {coverage, indexBytes} = decodePdfSearchIndexWasmOutput(output);
            await writeIndexFileAtomic(command.indexPath, indexBytes, resolveStagedIndexPath(command));
            indexCache?.set(command.indexPath, command.documentRevision, indexBytes, cacheToken);
            return coverage;
        }
        case 'stat': {
            const cachedBytes = indexCache?.get(command.indexPath, command.documentRevision, maxIndexBytes) ?? null;
            const cacheToken = cachedBytes === null ? indexCache?.captureToken(command.indexPath) : undefined;
            const indexBytes = cachedBytes ?? (await readIndexFileOrNull(command.indexPath, maxIndexBytes));
            if (indexBytes === null) {
                indexCache?.evict(command.indexPath);
                return {stale: true};
            }
            const request = encodePdfSearchWasmRequest(
                {
                    op: 'stat',
                    documentRevision: command.documentRevision,
                },
                indexBytes,
            );
            const decoded = decodePdfSearchJsonOutput(runWithPressureGuard(request));
            if (isStaleSearchIndexAnswer(decoded)) {
                indexCache?.evict(command.indexPath);
            } else if (cachedBytes === null) {
                indexCache?.set(command.indexPath, command.documentRevision, indexBytes, cacheToken);
            }
            return decoded;
        }
        case 'search': {
            const cachedBytes = indexCache?.get(command.indexPath, command.documentRevision, maxIndexBytes) ?? null;
            const cacheToken = cachedBytes === null ? indexCache?.captureToken(command.indexPath) : undefined;
            const indexBytes = cachedBytes ?? (await readIndexFileOrNull(command.indexPath, maxIndexBytes));
            if (indexBytes === null) {
                indexCache?.evict(command.indexPath);
                return {stale: true};
            }
            const {op: _op, indexPath: _indexPath, ...headerFields} = command;
            const request = encodePdfSearchWasmRequest(
                {
                    op: 'search',
                    ...headerFields,
                },
                indexBytes,
            );
            const decoded = decodePdfSearchJsonOutput(runWithPressureGuard(request));
            if (isStaleSearchIndexAnswer(decoded)) {
                indexCache?.evict(command.indexPath);
            } else if (cachedBytes === null) {
                indexCache?.set(command.indexPath, command.documentRevision, indexBytes, cacheToken);
            }
            return decoded;
        }
        case 'searchPages': {
            const {op: _op, pagesBuffer, ...headerFields} = command;
            const request = encodePdfSearchWasmRequest(
                {
                    op: 'searchPages',
                    ...headerFields,
                },
                pagesBuffer,
            );
            return decodePdfSearchJsonOutput(runWithPressureGuard(request));
        }
    }
}
