import type {IScanCleanupDetectionResult} from '@contracts/scan-cleanup/electronApiScanCleanup';
import {SCAN_CLEANUP_STREAMING_BATCH_PAGES} from '@contracts/scan-cleanup/inputLimits';
import type {IScanCleanupDetectionResultStore} from '@evb/scan-cleanup/core/types';
import {
    assertPageCount,
    assertPageNumber,
    assertReadWindow,
    assertRecordWrite,
    RESULT_STORE_MAX_RECORD_BYTES,
    toPersistedDetectionResult,
} from '@evb/scan-cleanup/core/resultStoreRules';
import {resolveBrowserCapabilityTier} from '@app/platform/browser/browserCapabilityTier';

const DATABASE_PREFIX = 'evb-viewer-scan-cleanup-detection-';
const RECORDS_STORE = 'records';
/** Records written in one transaction; a large run appends pages one at a time. */
const WRITE_BATCH_RECORDS = 256;

interface IRecordRow {
    storeId: string;
    pageNumber: number;
    record: string;
}

function request<T>(operation: IDBRequest<T>) {
    return new Promise<T>((resolve, reject) => {
        operation.onsuccess = () => resolve(operation.result);
        operation.onerror = () => reject(operation.error ?? new Error('IndexedDB request failed'));
    });
}

function transactionDone(transaction: IDBTransaction) {
    return new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
        transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
    });
}

function lockManager() {
    const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
    return typeof locks?.request === 'function' ? locks : null;
}

/**
 * Deletes the detection databases of windows that no longer exist. A window
 * holds its database's lock for as long as it lives, and the browser releases
 * it when the window closes or crashes, so a database whose lock is free has
 * no owner left. Without a lock manager nobody can tell, and nothing is deleted.
 */
async function deleteOrphanedDatabases(factory: IDBFactory, ownName: string) {
    const locks = lockManager();
    if (locks === null || typeof factory.databases !== 'function') return;
    const databases = await factory.databases().catch(() => []);
    for (const {name} of databases) {
        if (name === undefined || name === ownName || !name.startsWith(DATABASE_PREFIX)) continue;
        await locks.request(name, {ifAvailable: true}, async lock => {
            if (lock === null) return;
            await request(factory.deleteDatabase(name)).catch(() => undefined);
        });
    }
}

let windowDatabase: Promise<IDBDatabase> | null = null;

/** This window's detection database, created on first use and kept for the window's life. */
function openWindowDatabase() {
    windowDatabase ??= (async () => {
        const {indexedDbFactory: factory} = resolveBrowserCapabilityTier();
        if (!factory) {
            throw new Error('Scan cleanup detection of a document this long needs browser storage, which is unavailable here');
        }
        const name = `${DATABASE_PREFIX}${crypto.randomUUID()}`;
        const locks = lockManager();
        if (locks !== null) {
            const held = Promise.withResolvers<undefined>();
            // Held until the window goes away; the browser releases it then.
            void locks.request(name, {mode: 'exclusive'}, () => {
                held.resolve(undefined);
                return new Promise<undefined>(() => undefined);
            });
            await held.promise;
        }
        await deleteOrphanedDatabases(factory, name);
        const open = factory.open(name, 1);
        open.onupgradeneeded = () => {
            open.result.createObjectStore(RECORDS_STORE, {keyPath: [
                'storeId',
                'pageNumber',
            ]});
        };
        return request(open);
    })();
    windowDatabase.catch(() => {
        windowDatabase = null;
    });
    return windowDatabase;
}

/**
 * A detection result store for a document too long to keep its records in
 * memory. Records live in this window's IndexedDB database, written in
 * batches; reads return fresh copies, page-ordered, in bounded windows, as the
 * desktop file-backed store does. Closing the store deletes its records, and a
 * later window deletes those of a window that crashed.
 */
export async function createIndexedDbScanCleanupDetectionResultStore(
    pageCount: number,
    maxReadPages = SCAN_CLEANUP_STREAMING_BATCH_PAGES,
): Promise<IScanCleanupDetectionResultStore> {
    assertPageCount(pageCount);
    const database = await openWindowDatabase();
    const storeId = crypto.randomUUID();
    const present = new Uint8Array(pageCount + 1);
    let resultCount = 0;
    const pending = new Map<number, string>();
    let closed = false;
    let operation = Promise.resolve();
    const enqueue = <T>(task: () => Promise<T>) => {
        const next = operation.then(task);
        operation = next.then(() => undefined, () => undefined);
        return next;
    };
    const assertOpen = () => {
        if (closed) throw new Error('Scan cleanup result store is closed');
    };
    const flush = async () => {
        if (pending.size === 0) return;
        const rows: IRecordRow[] = [...pending].map(([
            pageNumber,
            record,
        ]) => ({
            storeId,
            pageNumber,
            record,
        }));
        pending.clear();
        const transaction = database.transaction(RECORDS_STORE, 'readwrite');
        const store = transaction.objectStore(RECORDS_STORE);
        for (const row of rows) store.put(row);
        await transactionDone(transaction);
    };
    const write = async (pageNumber: number, result: IScanCleanupDetectionResult, requireExisting: boolean) => {
        assertOpen();
        assertPageNumber(pageNumber, pageCount);
        assertRecordWrite(pageNumber, result.pageNumber, present[pageNumber] === 1, requireExisting);
        const record = JSON.stringify(toPersistedDetectionResult(result));
        if (record.length > RESULT_STORE_MAX_RECORD_BYTES) {
            throw new RangeError(`Scan cleanup result record exceeds ${String(RESULT_STORE_MAX_RECORD_BYTES)} bytes`);
        }
        pending.set(pageNumber, record);
        if (present[pageNumber] !== 1) {
            present[pageNumber] = 1;
            resultCount += 1;
        }
        if (pending.size >= WRITE_BATCH_RECORDS) await flush();
    };
    const readRange = async (firstPageNumber: number, lastPageNumberExclusive: number) => {
        assertReadWindow(firstPageNumber, lastPageNumberExclusive, pageCount, maxReadPages);
        await flush();
        if (lastPageNumberExclusive === firstPageNumber) return [];
        const transaction = database.transaction(RECORDS_STORE, 'readonly');
        const rows = await request(transaction.objectStore(RECORDS_STORE).getAll(IDBKeyRange.bound(
            [
                storeId,
                firstPageNumber,
            ],
            [
                storeId,
                lastPageNumberExclusive - 1,
            ],
        ))) as IRecordRow[];
        return rows.map(row => JSON.parse(row.record) as IScanCleanupDetectionResult);
    };
    return {
        pageCount,
        get resultCount() {
            return resultCount;
        },
        append: result => enqueue(() => write(result.pageNumber, result, false)),
        replace: (pageNumber, result) => enqueue(() => write(pageNumber, result, true)),
        getPage: pageNumber => enqueue(async () => {
            assertOpen();
            assertPageNumber(pageNumber, pageCount);
            if (present[pageNumber] !== 1) return undefined;
            const buffered = pending.get(pageNumber);
            if (buffered !== undefined) return JSON.parse(buffered) as IScanCleanupDetectionResult;
            const transaction = database.transaction(RECORDS_STORE, 'readonly');
            const row = await request(transaction.objectStore(RECORDS_STORE).get([
                storeId,
                pageNumber,
            ])) as IRecordRow | undefined;
            return row === undefined ? undefined : JSON.parse(row.record) as IScanCleanupDetectionResult;
        }),
        readRange: (firstPageNumber, lastPageNumberExclusive) => enqueue(async () => {
            assertOpen();
            return readRange(firstPageNumber, lastPageNumberExclusive);
        }),
        forEachChunk: onChunk => enqueue(async () => {
            assertOpen();
            for (let firstPageNumber = 1; firstPageNumber <= pageCount; firstPageNumber += maxReadPages) {
                await onChunk(
                    await readRange(firstPageNumber, Math.min(pageCount + 1, firstPageNumber + maxReadPages)),
                    firstPageNumber,
                );
            }
        }),
        close: () => enqueue(async () => {
            if (closed) return;
            closed = true;
            pending.clear();
            if (pageCount === 0) return;
            const transaction = database.transaction(RECORDS_STORE, 'readwrite');
            transaction.objectStore(RECORDS_STORE).delete(IDBKeyRange.bound(
                [
                    storeId,
                    1,
                ],
                [
                    storeId,
                    pageCount,
                ],
            ));
            await transactionDone(transaction).catch(() => undefined);
        }),
    };
}
