import {
    DB_NAME,
    DB_VERSION,
    DOCUMENTS_STORE,
    DOCUMENT_CHUNKS_STORE,
    WORKSPACE_RECOVERY_STORE,
    BROWSER_LIVE_LEASES_STORE,
    BROWSER_TRANSFER_AUTHORITY_STORE,
} from '@app/platform/browser/browserDocumentConstants';
import type {IBrowserPersistedDocumentRecord} from '@app/platform/browser/browserDocumentTypes';
import {windowTabIncomingTransferSchema} from '@contracts/windowTabsValidation';
import { resolveBrowserCapabilityTier } from '@app/platform/browser/browserCapabilityTier';
import * as v from 'valibot';

interface IIndexedDbReadResult<T> {
    available: boolean;
    value: T | null;
}

const INDEXED_DB_OPEN_TIMEOUT_MS = 4_000;

async function openDatabase() {
    const { indexedDbFactory } = resolveBrowserCapabilityTier();
    if (!indexedDbFactory) {
        return null;
    }

    return new Promise<IDBDatabase | null>((resolve) => {
        let request: IDBOpenDBRequest;
        let settled = false;
        let timeout: ReturnType<typeof setTimeout> | null = null;
        const finish = (database: IDBDatabase | null) => {
            if (settled) {
                database?.close();
                return;
            }
            settled = true;
            if (timeout) {
                clearTimeout(timeout);
                timeout = null;
            }
            resolve(database);
        };
        try {
            request = indexedDbFactory.open(DB_NAME, DB_VERSION);
        } catch {
            finish(null);
            return;
        }

        timeout = setTimeout(() => finish(null), INDEXED_DB_OPEN_TIMEOUT_MS);

        request.onupgradeneeded = () => {
            upgradeBrowserDocumentDatabase(request.result);
        };

        request.onsuccess = () => finish(request.result);
        request.onerror = () => finish(null);
        // A previous tab can hold an old connection while it is being
        // discarded. Keep waiting for the bounded timeout rather than treating
        // the transient version-change block as a permanent storage failure.
        request.onblocked = () => undefined;
    });
}

// Exercised by the real IndexedDB migration harness through a runtime dynamic import.
// fallow-ignore-next-line unused-export
export function upgradeBrowserDocumentDatabase(database: IDBDatabase) {
    if (!database.objectStoreNames.contains(DOCUMENTS_STORE)) {
        database.createObjectStore(DOCUMENTS_STORE, { keyPath: 'ref' });
    }
    if (!database.objectStoreNames.contains(DOCUMENT_CHUNKS_STORE)) {
        database.createObjectStore(DOCUMENT_CHUNKS_STORE, { keyPath: 'key' });
    }
    if (!database.objectStoreNames.contains(WORKSPACE_RECOVERY_STORE)) {
        database.createObjectStore(WORKSPACE_RECOVERY_STORE, { keyPath: 'id' });
    }
    if (!database.objectStoreNames.contains(BROWSER_LIVE_LEASES_STORE)) {
        database.createObjectStore(BROWSER_LIVE_LEASES_STORE, { keyPath: 'id' });
    }
    if (!database.objectStoreNames.contains(BROWSER_TRANSFER_AUTHORITY_STORE)) {
        database.createObjectStore(BROWSER_TRANSFER_AUTHORITY_STORE, { keyPath: 'id' });
    }
}

function assertWriteCommitted(result: unknown, operation: string) {
    if (result === null) {
        throw new Error(`IndexedDB ${operation} did not commit.`);
    }
}

export async function withObjectStoreReadResult<T>(
    storeName: string,
    run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<IIndexedDbReadResult<T>> {
    const database = await openDatabase();
    if (!database) {
        return {
            available: false,
            value: null,
        };
    }

    return new Promise<IIndexedDbReadResult<T>>((resolve) => {
        let requestResult: T | null = null;
        let requestSucceeded = false;
        let transactionCompleted = false;
        let settled = false;

        const cleanup = (available: boolean, value: T | null) => {
            if (settled) {
                return;
            }
            settled = true;
            database.close();
            resolve({
                available,
                value,
            });
        };

        try {
            const transaction = database.transaction(storeName, 'readonly');
            const store = transaction.objectStore(storeName);
            const request = run(store);

            request.onsuccess = () => {
                requestResult = request.result;
                requestSucceeded = true;
                if (transactionCompleted) {
                    cleanup(true, requestResult);
                }
            };
            request.onerror = () => cleanup(false, null);
            transaction.onabort = () => cleanup(false, null);
            transaction.onerror = () => cleanup(false, null);
            transaction.oncomplete = () => {
                transactionCompleted = true;
                if (requestSucceeded) {
                    cleanup(true, requestResult);
                }
            };
        } catch {
            cleanup(false, null);
        }
    });
}

export async function withObjectStore<T>(
    storeName: string,
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => IDBRequest<T>,
) {
    const database = await openDatabase();
    if (!database) {
        return null;
    }

    return new Promise<T | null>((resolve) => {
        let requestResult: T | null = null;
        let requestSucceeded = false;
        let transactionCompleted = false;
        let settled = false;

        const cleanup = (result: T | null) => {
            if (settled) {
                return;
            }
            settled = true;
            database.close();
            resolve(result);
        };

        try {
            const transaction = database.transaction(storeName, mode);
            const store = transaction.objectStore(storeName);
            const request = run(store);

            request.onsuccess = () => {
                requestResult = request.result;
                requestSucceeded = true;
                if (transactionCompleted) {
                    cleanup(requestResult);
                }
            };
            request.onerror = () => cleanup(null);
            transaction.onabort = () => cleanup(null);
            transaction.onerror = () => cleanup(null);
            transaction.oncomplete = () => {
                transactionCompleted = true;
                if (requestSucceeded) {
                    cleanup(requestResult);
                }
            };
        } catch {
            cleanup(null);
        }
    });
}

export async function runObjectStoreTransaction<T>(
    storeName: string,
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore, setResult: (value: T) => void) => void,
) {
    return runObjectStoresTransaction<T>(
        [storeName],
        mode,
        (transaction, setResult) => run(transaction.objectStore(storeName), setResult),
    );
}

/** Resolves a captured result only after its transaction commits; failures resolve null. */
export async function runObjectStoresTransaction<T>(
    storeNames: string[],
    mode: IDBTransactionMode,
    run: (transaction: IDBTransaction, setResult: (value: T) => void) => void,
) {
    const database = await openDatabase();
    if (!database) {
        return null;
    }

    return new Promise<T | null>((resolve) => {
        let result: T | null = null;
        let settled = false;
        const cleanup = (value: T | null) => {
            if (settled) {
                return;
            }
            settled = true;
            database.close();
            resolve(value);
        };

        try {
            const transaction = database.transaction(storeNames, mode);
            run(transaction, value => { result = value; });
            transaction.onabort = () => cleanup(null);
            transaction.onerror = () => cleanup(null);
            transaction.oncomplete = () => queueMicrotask(() => cleanup(result));
        } catch {
            cleanup(null);
        }
    });
}

export async function persistRecord(record: IBrowserPersistedDocumentRecord) {
    const result = await withObjectStore(DOCUMENTS_STORE, 'readwrite', (store) => store.put(record));
    assertWriteCommitted(result, 'document write');
}

export async function loadRecord(ref: string) {
    return (await loadRecordAvailability(ref)).value;
}

export async function loadRecordAvailability(ref: string) {
    return withObjectStoreReadResult<unknown>(
        DOCUMENTS_STORE,
        (store) => store.get(ref) as IDBRequest<unknown>,
    );
}

export async function loadAllRecordKeys() {
    return (await loadAllRecordKeysAvailability()).value;
}

export async function loadAllRecordKeysAvailability() {
    return withObjectStoreReadResult<IDBValidKey[]>(
        DOCUMENTS_STORE,
        (store) => store.getAllKeys(),
    );
}

export async function deleteRecord(ref: string) {
    const result = await withObjectStore(DOCUMENTS_STORE, 'readwrite', (store) => store.delete(ref));
    assertWriteCommitted(result, 'document delete');
}

export const BROWSER_TRANSFER_AUTHORITY_RECORD_SCHEMA = v.object({
    id: v.pipe(v.string(), v.minLength(1)),
    transferId: v.pipe(v.string(), v.minLength(1)),
    nonce: v.pipe(v.string(), v.minLength(1)),
    sourceWindowId: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
    sourceInstanceNonce: v.string(),
    targetWindowId: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
    targetInstanceNonce: v.string(),
    generation: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
    state: v.picklist([
        'pending',
        'committed',
        'aborted',
    ]),
    targetReady: v.boolean(),
    deadlineAt: v.pipe(v.number(), v.finite()),
    payload: windowTabIncomingTransferSchema,
    backingRefs: v.array(v.object({
        ref: v.string(),
        chunkGeneration: v.optional(v.string()),
    })),
    createdAt: v.pipe(v.number(), v.finite()),
    decidedAt: v.optional(v.pipe(v.number(), v.finite())),
});

export type IBrowserTransferAuthorityRecord = v.InferOutput<typeof BROWSER_TRANSFER_AUTHORITY_RECORD_SCHEMA>;

export async function mutateBrowserTransferAuthority(
    transferId: string,
    mutate: (current: IBrowserTransferAuthorityRecord | null, store: IDBObjectStore) => IBrowserTransferAuthorityRecord | null,
) {
    const result = await runObjectStoreTransaction<IBrowserTransferAuthorityRecord | null>(
        BROWSER_TRANSFER_AUTHORITY_STORE,
        'readwrite',
        (store, setResult) => {
            const request = store.get(`transfer:${transferId}`);
            request.onsuccess = () => {
                const parsed = request.result === undefined || request.result === null
                    ? null
                    : v.safeParse(BROWSER_TRANSFER_AUTHORITY_RECORD_SCHEMA, request.result, {abortEarly: true});
                const current = parsed && parsed.success ? parsed.output : null;
                const next = mutate(current, store);
                if (next) store.put(next);
                setResult(next);
            };
        },
    );
    return result;
}

export async function loadBrowserTransferAuthority(transferId: string) {
    const result = await withObjectStoreReadResult<unknown>(
        BROWSER_TRANSFER_AUTHORITY_STORE,
        store => store.get(`transfer:${transferId}`),
    );
    if (!result.available || result.value === undefined || result.value === null) {
        return null;
    }
    const parsed = v.safeParse(BROWSER_TRANSFER_AUTHORITY_RECORD_SCHEMA, result.value, {abortEarly: true});
    return parsed.success ? parsed.output : null;
}

export async function abortBrowserTransferAuthority(transferId: string, nonce: string) {
    return mutateBrowserTransferAuthority(transferId, current => {
        if (!current || current.nonce !== nonce || current.state !== 'pending') {
            return current;
        }
        return {
            ...current,
            state: 'aborted',
            generation: current.generation + 1,
            decidedAt: Date.now(),
        };
    });
}
