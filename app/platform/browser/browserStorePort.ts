import type {
    IStoreFile,
    IStorePort,
} from '@document-store/storePort';

interface IResponse {
    id: number;
    result?: unknown;
    error?: {name: string; message: string};
}

function storeError(error: {name: string; message: string}) {
    return Object.assign(new Error(error.message), {name: error.name});
}

/** The storage port of a store worker (`opfsStore.worker.ts`), which holds the files' sync access handles. */
export function createWorkerStorePort(worker: Worker): IStorePort & {probe(): Promise<boolean>} {
    const pending = new Map<number, {resolve(value: unknown): void; reject(error: Error): void}>();
    let nextId = 1;
    const fail = (error: Error) => {
        for (const request of pending.values()) request.reject(error);
        pending.clear();
    };
    worker.addEventListener('message', (event: MessageEvent<IResponse>) => {
        const request = pending.get(event.data.id);
        if (!request) return;
        pending.delete(event.data.id);
        if (event.data.error) request.reject(storeError(event.data.error));
        else request.resolve(event.data.result);
    });
    worker.addEventListener('error', event => fail(new Error(`The document store worker failed: ${event.message}`)));
    const call = <T>(op: string, ...args: unknown[]) => new Promise<T>((resolve, reject) => {
        const id = nextId++;
        pending.set(id, {resolve: resolve as (value: unknown) => void, reject});
        worker.postMessage({id, op, args});
    });
    const storeFile = (id: number): IStoreFile => ({
        size: () => call('size', id),
        readAt: (offset, length) => call('readAt', id, offset, length),
        writeAt: (offset, bytes) => call('writeAt', id, offset, bytes),
        truncate: length => call('truncate', id, length),
        flush: () => call('flush', id),
        close: () => call('close', id),
    });
    return {
        probe: () => call('probe'),
        list: dir => call('list', dir),
        read: path => call('read', path),
        writeAtomic: (path, bytes) => call('writeAtomic', path, bytes),
        open: async path => storeFile(await call<number>('open', path)),
        copyIn: (source, path) => call('copyIn', source, path),
        copy: (from, to) => call('copy', from, to),
        remove: path => call('remove', path),
    };
}

/** The storage port without durability: documents of a window whose browser refuses storage. */
export function createMemoryStorePort(): IStorePort {
    // A file's bytes are `[0, length)` of a buffer that grows by doubling, so streamed writes stay linear.
    const files = new Map<string, {buffer: Uint8Array; length: number}>();
    const children = (dir: string) => [...files.keys()].filter(path => path.startsWith(`${dir}/`));
    const bytesOf = (path: string) => {
        const file = files.get(path);
        if (!file) throw Object.assign(new Error(`Missing store file: ${path}`), {name: 'NotFoundError'});
        return file.buffer.subarray(0, file.length);
    };
    const put = (path: string, bytes: Uint8Array) => void files.set(path, {buffer: bytes.slice(), length: bytes.byteLength});
    const copyIn = async (source: Blob | string, path: string) => put(path, typeof source === 'string' ? bytesOf(source) : new Uint8Array(await source.arrayBuffer()));
    return {
        list: async dir => [...new Set(children(dir).map(path => path.slice(dir.length + 1).split('/')[0]!))],
        read: async path => bytesOf(path).slice(),
        writeAtomic: async (path, bytes) => put(path, bytes),
        async open(path) {
            if (!files.has(path)) put(path, new Uint8Array());
            const file = files.get(path)!;
            const writeAt = async (offset: number, chunk: Uint8Array) => {
                const end = offset + chunk.byteLength;
                if (end > file.buffer.byteLength) {
                    const grown = new Uint8Array(Math.max(end, file.buffer.byteLength * 2));
                    grown.set(file.buffer.subarray(0, file.length));
                    file.buffer = grown;
                }
                file.buffer.set(chunk, offset);
                file.length = Math.max(file.length, end);
            };
            return {
                size: async () => file.length,
                readAt: async (offset, length) => file.buffer.slice(offset, Math.min(file.length, offset + length)),
                writeAt,
                async truncate(length) {
                    if (length > file.length) await writeAt(file.length, new Uint8Array(length - file.length));
                    file.buffer.fill(0, length, file.length);
                    file.length = length;
                },
                flush: async () => undefined,
                close: async () => undefined,
            };
        },
        copyIn,
        copy: (from, to) => copyIn(from, to),
        async remove(path) {
            files.delete(path);
            for (const child of children(path)) files.delete(child);
        },
    };
}

/**
 * The window's storage port: the origin private file system through its store worker, or memory when the
 * browser offers no such storage or no Web Locks (an older engine, a private window that refuses it).
 */
export async function openBrowserStorePort(createWorker = () => new Worker(new URL('./opfsStore.worker.ts', import.meta.url), {type: 'module'})) {
    try {
        // Durable documents need one owner per directory across windows, which Web Locks provide.
        if (typeof Worker === 'undefined' || typeof navigator === 'undefined' || !navigator.storage?.getDirectory || !navigator.locks) {
            throw new Error('No origin private file system with Web Locks');
        }
        const port = createWorkerStorePort(createWorker());
        await port.probe();
        return {port, durable: true};
    } catch {
        return {port: createMemoryStorePort(), durable: false};
    }
}
