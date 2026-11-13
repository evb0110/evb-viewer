// File handles cannot be written to files, so the handles that destinations and Recent Files name live in
// one small IndexedDB store, keyed by the id a `handle:<id>` destination names. The old document database
// is left untouched.
const DB_NAME = 'evb-viewer-file-handles';
const STORE = 'handles';

export interface IStoredFileHandle {
    handle: FileSystemFileHandle;
    name: string;
}

let database: Promise<IDBDatabase> | null = null;

function openDatabase() {
    database ??= new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = () => request.result.createObjectStore(STORE);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('The file handle store could not open'));
    }).catch((error: unknown) => {
        database = null;
        throw error;
    });
    return database;
}

async function run<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>) {
    const transaction = (await openDatabase()).transaction(STORE, mode);
    const request = operation(transaction.objectStore(STORE));
    return new Promise<T>((resolve, reject) => {
        transaction.oncomplete = () => resolve(request.result);
        transaction.onerror = () => reject(transaction.error ?? new Error('The file handle store refused a request'));
        transaction.onabort = () => reject(transaction.error ?? new Error('The file handle store aborted a request'));
    });
}

export const fileHandleStore = {
    get: (key: string) => run<IStoredFileHandle | undefined>('readonly', store => store.get(key)),
    put: (key: string, value: IStoredFileHandle) => run('readwrite', store => store.put(value, key)).then(() => undefined),
    delete: (key: string) => run('readwrite', store => store.delete(key)).then(() => undefined),
    keys: () => run('readonly', store => store.getAllKeys()).then(keys => keys.filter((key): key is string => typeof key === 'string')),
};
