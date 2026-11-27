import { contentWitness } from '@document-store/contentWitness';
import type {
    IStoreFile,
    IStorePort,
} from '@document-store/storePort';
import {
    handlePrecompiledWasmModuleMessage,
    postPrecompiledWasmModules,
} from '@app/platform/browser/loadWasmWithDeadline';
import {
    PDF_PAGE_OPS_WASM_PATH,
    type IOcrTextLayerAppendRequest,
    type IPdfAppendFile,
    type IPdfAppendRequest,
    type IPdfAppendResult,
} from '@app/platform/browser/pdfPageEngine';
import { opfsFileHandle } from '@app/platform/browser/opfsFileHandle';
import type {
    TOpfsOperations,
    TOpfsRequest,
} from '@app/platform/browser/opfsStore.worker';
import type {IBrowserPageOpsWasmFailure} from '@contracts/browserPageOpsWorker';

type TPdfAppendRequest = IPdfAppendRequest | IOcrTextLayerAppendRequest;

interface IResponse {
    id: number;
    result?: unknown;
    error?: {name: string; message: string};
}

function storeError(error: {name: string; message: string}) {
    return Object.assign(new Error(error.message), {name: error.name});
}

const opfsPorts = new WeakSet<IStorePort>();
const fileBlobs = new WeakMap<IStorePort, (path: string) => Promise<Blob>>();

/**
 * The store file at `path` as a Blob that workers read by range, valid until the file next changes: the origin
 * private file system's file in place, one copy of a file in memory that all its readers share, or what another
 * port reads of it.
 */
export async function storeFileBlob(port: IStorePort, path: string) {
    return fileBlobs.get(port)?.(path) ?? new Blob([await port.read(path) as Uint8Array<ArrayBuffer>]);
}

type TPdfAppender = (base: number, request: TPdfAppendRequest) => Promise<IPdfAppendResult | IBrowserPageOpsWasmFailure>;
const pdfAppenders = new WeakMap<IStoreFile, TPdfAppender>();

/**
 * Appends the revisions `request` makes to the PDF of `base` bytes at the start of `file`, in the context that
 * holds the file's synchronous access: the store worker, or this window for a store in memory. The engine
 * reads the document by range there and writes past `base`; what it writes stays the caller's to commit or cut.
 */
export function appendPdfMutationsToStoreFile(file: IStoreFile, base: number, request: TPdfAppendRequest) {
    const append = pdfAppenders.get(file);
    if (!append) throw new Error('This store file cannot take a PDF edit');
    return append(base, request);
}

/** The engine over a file this window reads and writes synchronously, a store file in memory. */
async function appendPdfMutationsToSyncFile(file: IPdfAppendFile, base: number, request: TPdfAppendRequest) {
    const {appendPdfMutations} = await import('@app/platform/browser/pdfPageEngine');
    return appendPdfMutations(file, base, request);
}

/** Whether `port` keeps its files in the origin private file system, where a worker reads and writes them by path. */
export const isOpfsStorePort = (port: IStorePort) => opfsPorts.has(port);

const readBlobRange = async (blob: Blob, offset: number, length: number) => new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer());

/** The window's store worker, which hashes Blobs too once `openBrowserStorePort` opened it. */
let storeWorkerWitness: ((blob: Blob) => Promise<string>) | null = null;

/**
 * The `content-v2` witness of `blob`, such as the file a Save just wrote: hashed by the window's store worker when
 * it has one, so the window's thread neither reads nor hashes the bytes, and here otherwise.
 */
export function blobContentWitness(blob: Blob) {
    return storeWorkerWitness?.(blob) ?? contentWitness(blob.size, (offset, length) => readBlobRange(blob, offset, length));
}

/** The storage port of a store worker (`opfsStore.worker.ts`), which holds the files' sync access handles. */
export function createWorkerStorePort(worker: Worker): IStorePort & {probe(): Promise<boolean>; witnessBlob(blob: Blob): Promise<string>} {
    const pending = new Map<number, {resolve(value: unknown): void; reject(error: Error): void}>();
    let nextId = 1;
    postPrecompiledWasmModules(worker, [PDF_PAGE_OPS_WASM_PATH]);
    const fail = (error: Error) => {
        for (const request of pending.values()) request.reject(error);
        pending.clear();
    };
    worker.addEventListener('message', (event: MessageEvent<IResponse>) => {
        if (handlePrecompiledWasmModuleMessage(event.data)) return;
        const request = pending.get(event.data.id);
        if (!request) return;
        pending.delete(event.data.id);
        if (event.data.error) request.reject(storeError(event.data.error));
        else request.resolve(event.data.result);
    });
    worker.addEventListener('error', event => fail(new Error(`The document store worker failed: ${event.message}`)));
    const call = <K extends keyof TOpfsOperations>(
        op: K,
        ...args: Parameters<TOpfsOperations[K]>
    ) => new Promise<Awaited<ReturnType<TOpfsOperations[K]>>>((resolve, reject) => {
        const id = nextId++;
        pending.set(id, {resolve: resolve as (value: unknown) => void, reject});
        worker.postMessage({id, op, args} satisfies TOpfsRequest<K>);
    });
    const storeFile = (id: number): IStoreFile => {
        const file: IStoreFile = {
            size: () => call('size', id),
            readAt: (offset, length) => call('readAt', id, offset, length),
            witness: length => call('witness', id, length),
            writeAt: (offset, bytes) => call('writeAt', id, offset, bytes),
            truncate: length => call('truncate', id, length),
            flush: () => call('flush', id),
            close: () => call('close', id),
        };
        pdfAppenders.set(file, (base, request) => call('appendPdfMutations', id, base, request));
        return file;
    };
    const port = {
        probe: () => call('probe'),
        witnessBlob: blob => call('witnessBlob', blob),
        list: dir => call('list', dir),
        read: path => call('read', path),
        writeAtomic: (path, bytes) => call('writeAtomic', path, bytes),
        open: async path => storeFile(await call('open', path)),
        copyIn: (source, path) => call('copyIn', source, path),
        copy: (from, to) => call('copy', from, to),
        remove: path => call('remove', path),
    } satisfies IStorePort & {probe(): Promise<boolean>; witnessBlob(blob: Blob): Promise<string>};
    opfsPorts.add(port);
    fileBlobs.set(port, async path => (await opfsFileHandle(path)).getFile());
    return port;
}

/** The storage port without durability: documents of a window whose browser refuses storage. */
export function createMemoryStorePort(): IStorePort {
    // A file's bytes are `[0, length)` of a buffer that grows by doubling, so streamed writes stay linear. Its
    // readers share one Blob of them until it changes or closes: a copy per reader outgrows the memory a browser
    // lends Blobs.
    const files = new Map<string, {buffer: Uint8Array; length: number; blob?: Blob}>();
    const children = (dir: string) => [...files.keys()].filter(path => path.startsWith(`${dir}/`));
    const bytesOf = (path: string) => {
        const file = files.get(path);
        if (!file) throw Object.assign(new Error(`Missing store file: ${path}`), {name: 'NotFoundError'});
        return file.buffer.subarray(0, file.length);
    };
    const put = (path: string, bytes: Uint8Array) => void files.set(path, {buffer: bytes.slice(), length: bytes.byteLength});
    const copyIn = async (source: Blob | string, path: string) => put(path, typeof source === 'string' ? bytesOf(source) : new Uint8Array(await source.arrayBuffer()));
    const port: IStorePort = {
        list: async dir => [...new Set(children(dir).map(path => path.slice(dir.length + 1).split('/')[0]!))],
        read: async path => bytesOf(path).slice(),
        writeAtomic: async (path, bytes) => put(path, bytes),
        async open(path) {
            if (!files.has(path)) put(path, new Uint8Array());
            const file = files.get(path)!;
            const write = (offset: number, chunk: Uint8Array) => {
                const end = offset + chunk.byteLength;
                delete file.blob;
                if (end > file.buffer.byteLength) {
                    const grown = new Uint8Array(Math.max(end, file.buffer.byteLength * 2));
                    grown.set(file.buffer.subarray(0, file.length));
                    file.buffer = grown;
                }
                file.buffer.set(chunk, offset);
                file.length = Math.max(file.length, end);
            };
            const writeAt = async (offset: number, chunk: Uint8Array) => write(offset, chunk);
            const readAt = async (offset: number, length: number) => file.buffer.slice(offset, Math.min(file.length, offset + length));
            const storeFile: IStoreFile = {
                size: async () => file.length,
                readAt,
                witness: length => contentWitness(length, readAt),
                writeAt,
                async truncate(length) {
                    if (length > file.length) await writeAt(file.length, new Uint8Array(length - file.length));
                    file.buffer.fill(0, length, file.length);
                    file.length = length;
                    delete file.blob;
                },
                flush: async () => undefined,
                // A closed file, such as a revision kept for undo, keeps its bytes but lends no Blob until read again.
                close: async () => {
                    delete file.blob;
                },
            };
            pdfAppenders.set(storeFile, (base, request) => appendPdfMutationsToSyncFile({
                read(into, at) {
                    if (at + into.byteLength > file.length) throw new Error('The document ended before its cross-reference said');
                    into.set(file.buffer.subarray(at, at + into.byteLength));
                },
                write(bytes, at) {
                    if (at < base) throw new Error('An append cannot write over its document');
                    write(at, bytes);
                },
            }, base, request));
            return storeFile;
        },
        copyIn,
        copy: (from, to) => copyIn(from, to),
        async remove(path) {
            files.delete(path);
            for (const child of children(path)) files.delete(child);
        },
    };
    fileBlobs.set(port, async (path) => {
        const bytes = bytesOf(path);
        return files.get(path)!.blob ??= new Blob([bytes as Uint8Array<ArrayBuffer>]);
    });
    return port;
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
        storeWorkerWitness = blob => port.witnessBlob(blob);
        return {port, durable: true};
    } catch {
        return {port: createMemoryStorePort(), durable: false};
    }
}
