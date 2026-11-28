import type {IStorePort} from '@document-store/storePort';
import {OcrFatalJobError, type IOcrRecognizedPage} from '@ocr-core/recognizeOcrPages';

const OCR_CHECKPOINT_ROOT = 'ocr-checkpoints';
const STALE_CHECKPOINT_TTL_MS = 24 * 60 * 60 * 1000;
export const BROWSER_OCR_FINALIZE_MAX_PAGES_PER_CHUNK = 16;
export const BROWSER_OCR_FINALIZE_MAX_CHUNK_BYTES = 2 * 1024 * 1024;
/**
 * Aggregate in-memory fallback ceiling shared across all concurrent browser OCR
 * jobs when OPFS is unavailable or hits storage quota. Generous enough for
 * ordinary no-OPFS documents while preventing unbounded tab OOM.
 */
export const BROWSER_OCR_MEMORY_FALLBACK_MAX_BYTES = 128 * 1024 * 1024;

/** Lean per-page metadata needed for searchable-PDF finalization (omits PDF bytes, raw text, and diagnostics). */
export type TBrowserOcrCheckpointRecord = Pick<
    IOcrRecognizedPage,
    'pageNumber' | 'languages' | 'wordEdits' | 'wordGeometry' | 'preprocessInverse'
>;

export interface IBrowserOcrCheckpointChunk {
    records: TBrowserOcrCheckpointRecord[];
    pagePdfs: Uint8Array[];
}

export interface IBrowserOcrCheckpointStoreOptions {
    /** Overrides the aggregate memory-fallback ceiling checked by this store (primarily for tests). */
    maxMemoryFallbackBytes?: number;
}

export interface IBrowserOcrCheckpointStore {
    readonly storageKind: 'opfs' | 'memory';
    readonly directory: string;
    stagePage(page: IOcrRecognizedPage): Promise<void>;
    getPageCount(): number;
    iterateChunks(options?: {
        maxPages?: number;
        maxBytes?: number;
        signal?: AbortSignal;
        consume?: boolean;
    }): AsyncGenerator<IBrowserOcrCheckpointChunk>;
    cleanup(): Promise<void>;
}

const activeCheckpointDirs = new Set<string>();
const encoder = new TextEncoder();
const decoder = new TextDecoder();
let aggregateMemoryFallbackBytes = 0;

/** Total checkpoint bytes currently retained in the shared in-memory fallback across all active jobs. */
export function getBrowserOcrMemoryFallbackBytes() {
    return aggregateMemoryFallbackBytes;
}

function isQuotaError(error: unknown) {
    return error instanceof Error && error.name === 'QuotaExceededError';
}

function pagePaths(dir: string, pageNumber: number) {
    return {
        pdf: `${dir}/page-${pageNumber}.pdf`,
        meta: `${dir}/page-${pageNumber}.json`,
    };
}

function extractRecord(page: IOcrRecognizedPage): TBrowserOcrCheckpointRecord {
    return {
        pageNumber: page.pageNumber,
        languages: [...page.languages],
        wordEdits: page.wordEdits,
        wordGeometry: page.wordGeometry,
        ...(page.preprocessInverse ? {preprocessInverse: page.preprocessInverse} : {}),
    };
}

/**
 * Removes orphaned browser OCR checkpoint directories left behind by crashed or
 * abruptly closed tabs once their `meta.json` timestamp exceeds the TTL.
 */
export async function sweepStaleBrowserOcrCheckpoints(port: Pick<IStorePort, 'list' | 'read' | 'remove'>, now = Date.now()) {
    const entries = await port.list(OCR_CHECKPOINT_ROOT).catch(() => []);
    await Promise.all(
        entries.map(async (name) => {
            const dir = `${OCR_CHECKPOINT_ROOT}/${name}`;
            if (activeCheckpointDirs.has(dir)) {
                return;
            }
            try {
                const raw = await port.read(`${dir}/meta.json`);
                const parsed = JSON.parse(decoder.decode(raw)) as {createdAt?: unknown};
                if (typeof parsed.createdAt === 'number' && now - parsed.createdAt > STALE_CHECKPOINT_TTL_MS) {
                    await port.remove(dir).catch(() => undefined);
                }
            } catch {
                // Leave unreadable or freshly-initializing directories untouched unless meta is stale.
            }
        }),
    );
}

/**
 * Per-job OPFS checkpoint store for browser OCR. Completed pages are flushed to
 * OPFS immediately so JS memory retains only page numbers and byte sizes during
 * multi-page jobs, then read back in bounded chunks during finalization. Falls
 * back to memory transparently when OPFS is unavailable or hits storage quota.
 */
export async function createBrowserOcrCheckpointStore(
    opfsPort: Pick<IStorePort, 'list' | 'read' | 'writeAtomic' | 'remove'> | null,
    jobId: string = crypto.randomUUID(),
    storeOptions: IBrowserOcrCheckpointStoreOptions = {},
): Promise<IBrowserOcrCheckpointStore> {
    const dir = `${OCR_CHECKPOINT_ROOT}/${jobId}`;
    const memoryCeilingBytes = Math.max(0, Math.trunc(storeOptions.maxMemoryFallbackBytes ?? BROWSER_OCR_MEMORY_FALLBACK_MAX_BYTES));
    let durablePort = opfsPort;
    let hasOpfsDirectory = false;

    if (durablePort) {
        activeCheckpointDirs.add(dir);
        try {
            await durablePort.writeAtomic(`${dir}/meta.json`, encoder.encode(JSON.stringify({createdAt: Date.now()})));
            hasOpfsDirectory = true;
            void sweepStaleBrowserOcrCheckpoints(durablePort);
        } catch {
            activeCheckpointDirs.delete(dir);
            durablePort = null;
        }
    }

    // Tracks completed pageNumber -> estimated checkpoint bytes (PDF + metadata JSON).
    const stagedBytesByPage = new Map<number, number>();
    // Fallback storage when OPFS is unavailable or hits QuotaExceededError mid-job.
    const memoryFallback = new Map<number, {record: TBrowserOcrCheckpointRecord; pdf: Uint8Array}>();
    // Exact bytes reserved in `aggregateMemoryFallbackBytes` for each in-memory page of this store.
    const memoryFallbackBytesByPage = new Map<number, number>();
    // Once OPFS hits QuotaExceededError, route all remaining writes straight to memory
    // so checkpoint staging does not starve `stageAppend` during finalization.
    let opfsWritesExhausted = false;
    let cleanedUp = false;

    const reserveMemoryFallbackPage = (pageNumber: number, bytes: number) => {
        const previous = memoryFallbackBytesByPage.get(pageNumber) ?? 0;
        const delta = bytes - previous;
        if (delta > 0 && aggregateMemoryFallbackBytes + delta > memoryCeilingBytes) {
            throw new OcrFatalJobError(
                'Browser storage quota was exceeded and the in-memory OCR checkpoint limit was reached. Free browser storage or run OCR on fewer pages at a time.',
                {code: 'OCR_DOCUMENT_TOO_LARGE'},
            );
        }
        aggregateMemoryFallbackBytes += delta;
        memoryFallbackBytesByPage.set(pageNumber, bytes);
    };

    const releaseMemoryFallbackPage = (pageNumber: number) => {
        const reserved = memoryFallbackBytesByPage.get(pageNumber);
        if (reserved !== undefined) {
            memoryFallbackBytesByPage.delete(pageNumber);
            aggregateMemoryFallbackBytes = Math.max(0, aggregateMemoryFallbackBytes - reserved);
        }
        memoryFallback.delete(pageNumber);
    };

    const releaseAllMemoryFallback = () => {
        for (const reserved of memoryFallbackBytesByPage.values()) {
            aggregateMemoryFallbackBytes = Math.max(0, aggregateMemoryFallbackBytes - reserved);
        }
        memoryFallbackBytesByPage.clear();
        memoryFallback.clear();
    };

    const readPage = async (pageNumber: number): Promise<{record: TBrowserOcrCheckpointRecord; pdf: Uint8Array; fromOpfs: boolean}> => {
        const inMemory = memoryFallback.get(pageNumber);
        if (inMemory) {
            return {...inMemory, fromOpfs: false};
        }
        if (!durablePort) {
            throw new Error(`OCR checkpoint missing for page ${pageNumber}`);
        }
        const paths = pagePaths(dir, pageNumber);
        const [pdf, metaBytes] = await Promise.all([durablePort.read(paths.pdf), durablePort.read(paths.meta)]);
        const record = JSON.parse(decoder.decode(metaBytes)) as TBrowserOcrCheckpointRecord;
        return {record, pdf, fromOpfs: true};
    };

    return {
        get storageKind() {
            return durablePort ? 'opfs' : 'memory';
        },
        directory: dir,
        async stagePage(page) {
            if (cleanedUp) {
                throw new Error('OCR checkpoint store was already cleaned up');
            }
            const record = extractRecord(page);
            const metaBytes = encoder.encode(JSON.stringify(record));
            const totalBytes = page.pdf.byteLength + metaBytes.byteLength;
            if (durablePort && !opfsWritesExhausted) {
                const paths = pagePaths(dir, page.pageNumber);
                try {
                    await durablePort.writeAtomic(paths.pdf, page.pdf);
                    await durablePort.writeAtomic(paths.meta, metaBytes);
                    if (cleanedUp) {
                        await Promise.all([durablePort.remove(paths.pdf), durablePort.remove(paths.meta)]).catch(() => undefined);
                        throw new Error('OCR checkpoint store was already cleaned up');
                    }
                    releaseMemoryFallbackPage(page.pageNumber);
                    stagedBytesByPage.set(page.pageNumber, totalBytes);
                    return;
                } catch (error) {
                    if (!isQuotaError(error)) {
                        throw error;
                    }
                    // Quota exhausted mid-job: latch writes to memory while keeping `durablePort`
                    // intact for reading already-staged pages and cleaning up on completion/abort.
                    opfsWritesExhausted = true;
                    await Promise.all([durablePort.remove(paths.pdf), durablePort.remove(paths.meta)]).catch(() => undefined);
                }
            }
            if (cleanedUp) {
                throw new Error('OCR checkpoint store was already cleaned up');
            }
            reserveMemoryFallbackPage(page.pageNumber, totalBytes);
            memoryFallback.set(page.pageNumber, {record, pdf: page.pdf});
            stagedBytesByPage.set(page.pageNumber, totalBytes);
        },
        getPageCount() {
            return stagedBytesByPage.size;
        },
        async *iterateChunks(options = {}) {
            const maxPages = Math.max(1, options.maxPages ?? BROWSER_OCR_FINALIZE_MAX_PAGES_PER_CHUNK);
            const maxBytes = Math.max(1, options.maxBytes ?? BROWSER_OCR_FINALIZE_MAX_CHUNK_BYTES);
            const consume = options.consume === true;
            const sortedPages = [...stagedBytesByPage.keys()].sort((left, right) => left - right);

            let cursor = 0;
            while (cursor < sortedPages.length) {
                options.signal?.throwIfAborted();
                const batchPageNumbers: number[] = [];
                let batchBytes = 0;
                while (cursor < sortedPages.length && batchPageNumbers.length < maxPages) {
                    const pageNumber = sortedPages[cursor]!;
                    const pageBytes = stagedBytesByPage.get(pageNumber) ?? 0;
                    if (batchPageNumbers.length > 0 && batchBytes + pageBytes > maxBytes) {
                        break;
                    }
                    batchPageNumbers.push(pageNumber);
                    batchBytes += pageBytes;
                    cursor += 1;
                }
                const records: TBrowserOcrCheckpointRecord[] = [];
                const pagePdfs: Uint8Array[] = [];
                const memoryConsumedPages: number[] = [];
                const opfsRemovals: Array<Promise<void>> = [];
                for (const pageNumber of batchPageNumbers) {
                    options.signal?.throwIfAborted();
                    const entry = await readPage(pageNumber);
                    records.push(entry.record);
                    pagePdfs.push(entry.pdf);
                    if (consume) {
                        if (entry.fromOpfs && durablePort) {
                            // Free OPFS disk quota as soon as the chunk is loaded into memory,
                            // before the consumer's append writes to OPFS.
                            stagedBytesByPage.delete(pageNumber);
                            const paths = pagePaths(dir, pageNumber);
                            opfsRemovals.push(durablePort.remove(paths.pdf).catch(() => undefined));
                            opfsRemovals.push(durablePort.remove(paths.meta).catch(() => undefined));
                        } else {
                            memoryConsumedPages.push(pageNumber);
                        }
                    }
                }
                if (opfsRemovals.length > 0) {
                    await Promise.all(opfsRemovals);
                }
                // Keep fallback memory charged while the consumer's async append holds the buffers,
                // and release on both normal advance and early return/throw.
                try {
                    yield {records, pagePdfs};
                } finally {
                    if (consume) {
                        for (const pageNumber of memoryConsumedPages) {
                            stagedBytesByPage.delete(pageNumber);
                            releaseMemoryFallbackPage(pageNumber);
                        }
                    }
                }
            }
        },
        async cleanup() {
            if (cleanedUp) {
                return;
            }
            cleanedUp = true;
            stagedBytesByPage.clear();
            releaseAllMemoryFallback();
            if (hasOpfsDirectory && durablePort) {
                await durablePort.remove(dir).catch(() => undefined);
            }
            activeCheckpointDirs.delete(dir);
        },
    };
}
