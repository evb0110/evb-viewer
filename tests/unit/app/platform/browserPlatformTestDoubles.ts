export class MemoryStorage {
    private readonly data = new Map<string, string>();

    public clear() {
        this.data.clear();
    }

    // Required by the Storage-shaped object consumed structurally by the browser capabilities.
    public getItem(key: string) {
        return this.data.get(key) ?? null;
    }

    public setItem(key: string, value: string) {
        this.data.set(key, value);
    }
}

export interface IFileSystemFileHandleFixtureOptions {
    readonly name: string;
    readonly getFile?: FileSystemFileHandle['getFile'];
    readonly isSameEntry?: FileSystemFileHandle['isSameEntry'];
}

export function createEmptyFileSystemWritableFileStream(): FileSystemWritableFileStream {
    const writable = Object.assign(new WritableStream(), {
        abort: async (_reason?: unknown) => {},
        close: async () => {},
        seek: async (_position: number) => {},
        truncate: async (_size: number) => {},
        write: async (_chunk: FileSystemWriteChunkType) => {},
    });
    return writable satisfies FileSystemWritableFileStream;
}

export function createFileSystemFileHandle(
    options: IFileSystemFileHandleFixtureOptions,
): FileSystemFileHandle {
    const handle = {
        kind: 'file',
        name: options.name,
        getFile: options.getFile ?? (async () => new File([], options.name)),
        isSameEntry: options.isSameEntry ?? (async (_other: FileSystemHandle) => false),
        createWritable: async () => createEmptyFileSystemWritableFileStream(),
        createSyncAccessHandle: async () => {
            throw new Error('Synchronous access is not part of this file handle fixture');
        },
    } satisfies FileSystemFileHandle;
    return handle;
}

class FakeIdbRequest<T> extends EventTarget implements IDBRequest<T> {
    public result!: T;
    public error: DOMException | null = null;
    public readyState: IDBRequestReadyState = 'pending';
    public source!: IDBObjectStore | IDBIndex | IDBCursor;
    public transaction: IDBTransaction | null = null;
    public onsuccess: IDBRequest<T>['onsuccess'] = null;
    public onerror: IDBRequest<T>['onerror'] = null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIdbValidKey(value: unknown): value is IDBValidKey {
    return typeof value === 'number'
        || typeof value === 'string'
        || value instanceof Date
        || value instanceof ArrayBuffer
        || ArrayBuffer.isView(value)
        || (Array.isArray(value) && value.every(item => isIdbValidKey(item)));
}

class FakeDomStringList implements DOMStringList {
    public constructor(private readonly getNames: () => readonly string[]) {}

    readonly [index: number]: string;

    public [Symbol.iterator](): ArrayIterator<string> {
        return this.getNames()[Symbol.iterator]();
    }

    public get length() {
        return this.getNames().length;
    }

    public contains(name: string) {
        return this.getNames().includes(name);
    }

    public item(index: number) {
        return this.getNames()[index] ?? null;
    }
}

class FakeVersionChangeEvent extends Event implements IDBVersionChangeEvent {
    public readonly newVersion = null;
    public readonly oldVersion = 0;
}

class FakeOpenDbRequest extends FakeIdbRequest<IDBDatabase> {
    public onblocked: IDBOpenDBRequest['onblocked'] = null;
    public onupgradeneeded: IDBOpenDBRequest['onupgradeneeded'] = null;
}

class FakeCursorWithValue implements IDBCursorWithValue {
    public readonly direction: IDBCursorDirection;
    public readonly request: IDBRequest;
    public readonly source: IDBObjectStore | IDBIndex;
    public readonly key: IDBValidKey;
    public readonly primaryKey: IDBValidKey;
    public readonly value: unknown;

    public constructor(
        key: IDBValidKey,
        value: unknown,
        direction: IDBCursorDirection,
        request: IDBRequest,
        source: IDBObjectStore | IDBIndex,
        onContinue: () => void,
        onDelete: () => IDBRequest<undefined>,
    ) {
        this.direction = direction;
        this.key = key;
        this.primaryKey = key;
        this.request = request;
        this.source = source;
        this.value = value;
        this.continue = onContinue;
        this.delete = onDelete;
    }

    public advance(_count: number) {
        this.continue();
    }

    public continue: (key?: IDBValidKey) => void;

    public continuePrimaryKey(_key: IDBValidKey, _primaryKey: IDBValidKey) {
        this.continue();
    }

    public delete: () => IDBRequest<undefined>;

    public update(_value: unknown): IDBRequest<IDBValidKey> {
        throw new Error('The IndexedDB test double does not update cursor values');
    }
}

// IndexedDB interfaces are browser-owned and much larger than the members the
// fake needs. Implement the browser contracts here so callers do not need an
// unchecked generic helper at every test boundary.

interface IFakeStoreState {
    records: Map<string, unknown>;
    keyPath: string;
    indexes: Map<string, string>;
}

class FakeIndex implements IDBIndex {
    public readonly keyPath: string;
    public readonly multiEntry = false;
    public readonly name: string;
    public readonly objectStore!: IDBObjectStore;
    public readonly unique = false;

    public constructor(
        private readonly state: IFakeStoreState,
        keyPathValue: string,
        name = 'fake-index',
    ) {
        this.keyPath = keyPathValue;
        this.name = name;
    }

    public getAllKeys(value?: IDBValidKey | IDBKeyRange | null, _count?: number) {
        const request = new FakeIdbRequest<IDBValidKey[]>();
        queueMicrotask(() => {
            request.result = Array.from(this.state.records.entries())
                .filter(([
                    , record,
                ]) => (
                    isRecord(record)
                    && (value === undefined || value === null || String(record[this.keyPath]) === String(value))
                ))
                .map(([key]) => key);
            request.readyState = 'done';
            request.onsuccess?.(new Event('success'));
        });
        return request;
    }

    public openCursor(_query?: IDBValidKey | IDBKeyRange | null, direction?: IDBCursorDirection) {
        const request = new FakeIdbRequest<IDBCursorWithValue | null>();
        const entries = Array.from(this.state.records.entries()).sort((first, second) => (
            Number(isRecord(first[1]) ? first[1][this.keyPath] : Number.NaN)
            - Number(isRecord(second[1]) ? second[1][this.keyPath] : Number.NaN)
        ));
        if (direction === 'prev' || direction === 'prevunique') {
            entries.reverse();
        }
        let cursorIndex = 0;
        const advance = () => queueMicrotask(() => {
            const entry = entries[cursorIndex];
            if (!entry) {
                request.result = null;
                request.onsuccess?.(new Event('success'));
                return;
            }
            const [
                key,
                value,
            ] = entry;
            request.result = new FakeCursorWithValue(
                key,
                value,
                direction ?? 'next',
                request,
                this,
                () => {
                    cursorIndex += 1;
                    advance();
                },
                () => {
                    this.state.records.delete(key);
                    return new FakeIdbRequest<undefined>();
                },
            );
            request.readyState = 'done';
            request.onsuccess?.(new Event('success'));
        });
        advance();
        return request;
    }

    public count(_query?: IDBValidKey | IDBKeyRange): IDBRequest<number> {
        throw new Error('The IndexedDB test double does not count index values');
    }

    public get(_query: IDBValidKey | IDBKeyRange): IDBRequest<unknown> {
        throw new Error('The IndexedDB test double does not get index values');
    }

    public getAll(_queryOrOptions?: IDBValidKey | IDBKeyRange | null, _count?: number): IDBRequest<unknown[]> {
        throw new Error('The IndexedDB test double does not get all index values');
    }

    public getKey(_query: IDBValidKey | IDBKeyRange): IDBRequest<IDBValidKey | undefined> {
        throw new Error('The IndexedDB test double does not get index keys');
    }

    public openKeyCursor(_query?: IDBValidKey | IDBKeyRange | null, _direction?: IDBCursorDirection): IDBRequest<IDBCursor | null> {
        throw new Error('The IndexedDB test double does not open index key cursors');
    }
}

class FakeObjectStore implements IDBObjectStore {
    public readonly autoIncrement = false;
    public readonly indexNames: DOMStringList;
    public readonly keyPath: string;
    public readonly name: string;
    public readonly transaction!: IDBTransaction;

    public constructor(
        private readonly state: IFakeStoreState,
        name = 'fake-store',
    ) {
        this.indexNames = new FakeDomStringList(() => Array.from(this.state.indexes.keys()));
        this.keyPath = state.keyPath;
        this.name = name;
    }

    public setTransaction(transaction: IDBTransaction) {
        Object.defineProperty(this, 'transaction', {
            configurable: true,
            value: transaction,
        });
    }

    public createIndex(name: string, keyPath: string | string[], _options?: IDBIndexParameters) {
        const resolvedKeyPath = typeof keyPath === 'string' ? keyPath : Array.from(keyPath)[0];
        if (!resolvedKeyPath) {
            throw new Error(`Missing fake IndexedDB key path for index: ${name}`);
        }
        this.state.indexes.set(name, resolvedKeyPath);
        return new FakeIndex(this.state, resolvedKeyPath, name);
    }

    public index(name: string) {
        const keyPath = this.state.indexes.get(name);
        if (!keyPath) {
            throw new Error(`Missing fake IndexedDB index: ${name}`);
        }
        return new FakeIndex(this.state, keyPath, name);
    }

    public add(record: unknown, key?: IDBValidKey) {
        return this.put(record, key);
    }

    public put(record: unknown, key?: IDBValidKey) {
        const request = new FakeIdbRequest<IDBValidKey>();
        queueMicrotask(() => {
            const recordKey = key ?? (
                isRecord(record)
                    ? record[this.state.keyPath]
                    : undefined
            );
            if (!isIdbValidKey(recordKey)) {
                request.error = new DOMException('Fake IndexedDB record key is missing');
                request.onerror?.(new Event('error'));
                return;
            }
            this.state.records.set(String(recordKey), record);
            request.result = recordKey;
            request.readyState = 'done';
            request.onsuccess?.(new Event('success'));
        });
        return request;
    }

    public get(ref: IDBValidKey) {
        const request = new FakeIdbRequest<unknown>();
        queueMicrotask(() => {
            request.result = this.state.records.get(String(ref));
            request.readyState = 'done';
            request.onsuccess?.(new Event('success'));
        });
        return request;
    }

    public delete(ref: IDBValidKey) {
        const request = new FakeIdbRequest<undefined>();
        queueMicrotask(() => {
            this.state.records.delete(String(ref));
            request.result = undefined;
            request.readyState = 'done';
            request.onsuccess?.(new Event('success'));
        });
        return request;
    }

    public clear() {
        const request = new FakeIdbRequest<undefined>();
        queueMicrotask(() => {
            this.state.records.clear();
            request.result = undefined;
            request.readyState = 'done';
            request.onsuccess?.(new Event('success'));
        });
        return request;
    }

    public count(_query?: IDBValidKey | IDBKeyRange) {
        const request = new FakeIdbRequest<number>();
        queueMicrotask(() => {
            request.result = this.state.records.size;
            request.readyState = 'done';
            request.onsuccess?.(new Event('success'));
        });
        return request;
    }

    public getAll(_queryOrOptions?: IDBValidKey | IDBKeyRange | null, _count?: number) {
        const request = new FakeIdbRequest<unknown[]>();
        queueMicrotask(() => {
            request.result = Array.from(this.state.records.values());
            request.readyState = 'done';
            request.onsuccess?.(new Event('success'));
        });
        return request;
    }

    public getAllKeys(_queryOrOptions?: IDBValidKey | IDBKeyRange | null, _count?: number) {
        const request = new FakeIdbRequest<IDBValidKey[]>();
        queueMicrotask(() => {
            request.result = Array.from(this.state.records.keys());
            request.readyState = 'done';
            request.onsuccess?.(new Event('success'));
        });
        return request;
    }

    public getKey(ref: IDBValidKey) {
        const request = new FakeIdbRequest<IDBValidKey | undefined>();
        queueMicrotask(() => {
            request.result = this.state.records.has(String(ref)) ? ref : undefined;
            request.readyState = 'done';
            request.onsuccess?.(new Event('success'));
        });
        return request;
    }

    public deleteIndex(name: string) {
        this.state.indexes.delete(name);
    }

    public openCursor(_query?: IDBValidKey | IDBKeyRange | null, _direction?: IDBCursorDirection) {
        const request = new FakeIdbRequest<IDBCursorWithValue | null>();
        queueMicrotask(() => {
            request.result = null;
            request.readyState = 'done';
            request.onsuccess?.(new Event('success'));
        });
        return request;
    }

    public openKeyCursor(_query?: IDBValidKey | IDBKeyRange | null, _direction?: IDBCursorDirection) {
        const request = new FakeIdbRequest<IDBCursor | null>();
        queueMicrotask(() => {
            request.result = null;
            request.readyState = 'done';
            request.onsuccess?.(new Event('success'));
        });
        return request;
    }
}

class FakeTransaction extends EventTarget implements IDBTransaction {
    public readonly db!: IDBDatabase;
    public readonly durability: IDBTransactionDurability = 'default';
    public readonly error: DOMException | null = null;
    public readonly mode: IDBTransactionMode;
    public readonly objectStoreNames: DOMStringList;
    public onabort: IDBTransaction['onabort'] = null;
    public onerror: IDBTransaction['onerror'] = null;
    public oncomplete: IDBTransaction['oncomplete'] = null;

    private completionScheduled = false;

    public constructor(
        private readonly stores: Map<string, FakeObjectStore>,
        mode: IDBTransactionMode,
    ) {
        super();
        this.mode = mode;
        this.objectStoreNames = new FakeDomStringList(() => Array.from(this.stores.keys()));
    }

    public objectStore(name: string) {
        const store = this.stores.get(name);
        if (!store) {
            throw new Error(`Unknown IndexedDB test store: ${name}`);
        }
        store.setTransaction(this);
        if (!this.completionScheduled) {
            this.completionScheduled = true;
            queueMicrotask(() => {
                queueMicrotask(() => this.oncomplete?.(new Event('complete')));
            });
        }
        return store;
    }

    public abort() {
        this.onabort?.(new Event('abort'));
    }

    public commit() {}
}

class FakeDatabase extends EventTarget implements IDBDatabase {
    private readonly storesByName = new Map<string, IFakeStoreState>();
    private readonly storeNames = new Set<string>();

    public readonly name = 'fake-database';
    public readonly objectStoreNames = new FakeDomStringList(() => Array.from(this.storeNames));
    public readonly version = 1;
    public onabort: IDBDatabase['onabort'] = null;
    public onclose: IDBDatabase['onclose'] = null;
    public onerror: IDBDatabase['onerror'] = null;
    public onversionchange: IDBDatabase['onversionchange'] = null;

    public createObjectStore(name: string, options?: IDBObjectStoreParameters) {
        this.storeNames.add(name);
        const store = {
            records: new Map<string, unknown>(),
            keyPath: typeof options?.keyPath === 'string' ? options.keyPath : 'ref',
            indexes: new Map<string, string>(),
        };
        this.storesByName.set(name, store);
        return new FakeObjectStore(store, name);
    }

    public deleteObjectStore(name: string) {
        this.storeNames.delete(name);
        this.storesByName.delete(name);
    }

    public transaction(
        nameOrNames: string | string[] | Iterable<string>,
        mode: IDBTransactionMode = 'readonly',
        _options?: IDBTransactionOptions,
    ) {
        const names = typeof nameOrNames === 'string' ? [nameOrNames] : Array.from(nameOrNames);
        if (names.length === 0) {
            throw new Error('The IndexedDB test double requires at least one store name.');
        }
        const stores = new Map<string, FakeObjectStore>();
        for (const name of names) {
            const store = this.storesByName.get(name) ?? {
                records: new Map<string, unknown>(),
                keyPath: 'ref',
                indexes: new Map<string, string>(),
            };
            this.storesByName.set(name, store);
            stores.set(name, new FakeObjectStore(store, name));
        }
        return new FakeTransaction(stores, mode);
    }

    public getStoreRecords(name: string) {
        const store = this.storesByName.get(name);
        return store?.records ?? new Map<string, unknown>();
    }

    public close() {
        this.onclose?.(new Event('close'));
    }

    public rejectNextTransaction(error: Error) {
        const transaction = this.transaction.bind(this);
        const rejectedTransaction = (_nameOrNames: string | string[] | Iterable<string>, _mode?: IDBTransactionMode) => {
            this.transaction = transaction;
            throw error;
        };
        this.transaction = rejectedTransaction;
    }
}

export class FakeIndexedDbFactory {
    private readonly databases = new Map<string, FakeDatabase>();

    // Required by the IDBFactory-shaped object consumed structurally by the browser document store.
    // fallow-ignore-next-line unused-class-member
    public open(name: string, _version: number) {
        const request = new FakeOpenDbRequest();
        queueMicrotask(() => {
            let database = this.databases.get(name);
            const isNew = !database;
            if (!database) {
                database = new FakeDatabase();
                this.databases.set(name, database);
            }

            request.result = database;
            if (isNew) {
                request.onupgradeneeded?.(new FakeVersionChangeEvent('upgradeneeded'));
            }
            request.onsuccess?.(new Event('success'));
        });
        return request;
    }

    public getDatabase(name: string) {
        return this.databases.get(name) ?? null;
    }
}
