import {contentWitness} from '@document-store/contentWitness';
import type {IStoreFile, IStorePort} from '@document-store/storePort';
import {handlePrecompiledWasmModuleMessage, postPrecompiledWasmModules} from '@app/platform/browser/loadWasmWithDeadline';
import {
    PDF_PAGE_OPS_WASM_PATH,
    type IOcrTextLayerAppendRequest,
    type IPdfAppendRequest,
    type IPdfAppendResult,
} from '@app/platform/browser/pdfPageEngine';
import {opfsFileHandle} from '@app/platform/browser/opfsFileHandle';
import type {TOpfsOperations, TOpfsRequest} from '@app/platform/browser/opfsStore.worker';
import type {IBrowserPageOpsWasmFailure} from '@contracts/browserPageOpsWorker';

type TPdfAppendRequest = IPdfAppendRequest | IOcrTextLayerAppendRequest;
type TWorkerStorePort = IStorePort & {probe(): Promise<boolean>; witnessBlob(blob: Blob): Promise<string>};
type TSerializedError = {name: string; message: string};
interface IResponse {
    id?: number;
    result?: unknown;
    error?: TSerializedError;
    transportError?: TSerializedError;
}

const storeError = (error: TSerializedError) => Object.assign(new Error(error.message), {name: error.name});
const transportError = (message: string) => storeError({name: 'StoreTransportError', message});
const opfsPorts = new WeakSet<IStorePort>();
const fileBlobs = new WeakMap<IStorePort, (path: string) => Promise<Blob>>();
const openFileBlobs = new WeakMap<IStoreFile, () => Promise<Blob>>();
const pdfAppenders = new WeakMap<
    IStoreFile,
    (base: number, request: TPdfAppendRequest) => Promise<IPdfAppendResult | IBrowserPageOpsWasmFailure>
>();
let storeWorkerPort: TWorkerStorePort | null = null;

export const isOpfsStorePort = (port: IStorePort) => opfsPorts.has(port);

export async function storeFileBlob(port: IStorePort, path: string) {
    return fileBlobs.get(port)?.(path) ?? new Blob([(await port.read(path)) as Uint8Array<ArrayBuffer>]);
}

export async function openStoreFileBlob(file: IStoreFile): Promise<Blob | null> {
    const read = openFileBlobs.get(file);
    return read ? read().catch(() => null) : null;
}

export function appendPdfMutationsToStoreFile(file: IStoreFile, base: number, request: TPdfAppendRequest) {
    const append = pdfAppenders.get(file);
    if (!append) {
        throw new Error('This store file cannot take a PDF edit');
    }
    return append(base, request);
}

export function blobContentWitness(blob: Blob) {
    return (
        storeWorkerPort?.witnessBlob(blob) ??
        contentWitness(blob.size, async (offset, length) => new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer()))
    );
}

/** Storage port backed by `opfsStore.worker.ts`. */
export function createWorkerStorePort(worker: Worker, onFault?: (error: Error) => void): TWorkerStorePort {
    const pending = new Map<number, {resolve(value: unknown): void; reject(error: Error): void}>();
    let nextId = 1;
    let broken: Error | null = null;
    postPrecompiledWasmModules(worker, [PDF_PAGE_OPS_WASM_PATH]);
    const fail = (error: Error) => {
        if (broken) {
            return;
        }
        broken = error;
        for (const request of pending.values()) {
            request.reject(error);
        }
        pending.clear();
        worker.terminate?.();
        onFault?.(error);
    };
    worker.addEventListener('message', (event: MessageEvent<IResponse>) => {
        if (handlePrecompiledWasmModuleMessage(event.data)) {
            return;
        }
        if (event.data.transportError) {
            fail(storeError(event.data.transportError));
            return;
        }
        const id = event.data.id;
        const request = id === undefined ? undefined : pending.get(id);
        if (!request) {
            return;
        }
        pending.delete(id!);
        if (event.data.error) {
            request.reject(storeError(event.data.error));
        } else {
            request.resolve(event.data.result);
        }
    });
    worker.addEventListener('error', (event) => fail(transportError(`The document store worker failed: ${event.message}`)));
    worker.addEventListener('messageerror', () => fail(transportError('The document store worker sent an unreadable reply')));
    const call = <K extends keyof TOpfsOperations>(op: K, ...args: Parameters<TOpfsOperations[K]>) =>
        broken
            ? Promise.reject(broken)
            : new Promise<Awaited<ReturnType<TOpfsOperations[K]>>>((resolve, reject) => {
                  const id = nextId++;
                  pending.set(id, {resolve: resolve as (value: unknown) => void, reject});
                  try {
                      worker.postMessage({id, op, args} satisfies TOpfsRequest<K>);
                  } catch (error) {
                      pending.delete(id);
                      reject(error);
                  }
              });
    const port: TWorkerStorePort = {
        probe: () => call('probe'),
        witnessBlob: (blob) => call('witnessBlob', blob),
        list: (dir) => call('list', dir),
        read: (path) => call('read', path),
        writeAtomic: (path, bytes) => call('writeAtomic', path, bytes),
        open: async (path) => {
            const id = await call('open', path);
            const file: IStoreFile = {
                size: () => call('size', id),
                readAt: (offset, length) => call('readAt', id, offset, length),
                witness: (length) => call('witness', id, length),
                writeAt: (offset, bytes) => call('writeAt', id, offset, bytes),
                truncate: (length) => call('truncate', id, length),
                flush: () => call('flush', id),
                close: () => call('close', id),
            };
            pdfAppenders.set(file, (base, request) => call('appendPdfMutations', id, base, request));
            openFileBlobs.set(file, async () => (await opfsFileHandle(path)).getFile());
            return file;
        },
        copyIn: (source, path) => call('copyIn', source, path),
        copy: (from, to) => call('copy', from, to),
        remove: (path) => call('remove', path),
    };
    opfsPorts.add(port);
    fileBlobs.set(port, async (path) => (await opfsFileHandle(path)).getFile());
    return port;
}

/** Non-durable memory storage port used when OPFS or Web Locks are unavailable. */
export function createMemoryStorePort(): IStorePort {
    const files = new Map<string, {buffer: Uint8Array; length: number; blob?: Blob}>();
    const children = (dir: string) => [...files.keys()].filter((path) => path.startsWith(`${dir}/`));
    const entryOf = (path: string) => {
        const file = files.get(path);
        if (!file) {
            throw Object.assign(new Error(`Missing store file: ${path}`), {name: 'NotFoundError'});
        }
        return file;
    };
    const bytesOf = (path: string) => {
        const file = entryOf(path);
        return file.buffer.subarray(0, file.length);
    };
    const blobOf = async (path: string) => (entryOf(path).blob ??= new Blob([bytesOf(path) as Uint8Array<ArrayBuffer>]));
    const put = (path: string, bytes: Uint8Array) => void files.set(path, {buffer: bytes.slice(), length: bytes.byteLength});
    const copyIn = async (source: Blob | string, path: string) =>
        put(path, typeof source === 'string' ? bytesOf(source) : new Uint8Array(await source.arrayBuffer()));
    const open = async (path: string) => {
        const file = files.get(path) ?? (put(path, new Uint8Array()), files.get(path)!);
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
        const storeFile: IStoreFile = {
            size: async () => file.length,
            readAt: async (offset, length) => file.buffer.slice(offset, Math.min(file.length, offset + length)),
            witness: (length) =>
                contentWitness(length, async (offset, size) => file.buffer.subarray(offset, Math.min(file.length, offset + size))),
            writeAt: async (offset, chunk) => write(offset, chunk),
            async truncate(length) {
                if (length > file.length) {
                    write(file.length, new Uint8Array(length - file.length));
                }
                file.buffer.fill(0, length, file.length);
                file.length = length;
                delete file.blob;
            },
            flush: async () => undefined,
            close: async () => void delete file.blob,
        };
        pdfAppenders.set(storeFile, async (base, request) =>
            (await import('@app/platform/browser/pdfPageEngine')).appendPdfMutations(
                {
                    read(into, at) {
                        if (at + into.byteLength > file.length) {
                            throw new Error('The document ended before its cross-reference said');
                        }
                        into.set(file.buffer.subarray(at, at + into.byteLength));
                    },
                    write(bytes, at) {
                        if (at < base) {
                            throw new Error('An append cannot write over its document');
                        }
                        write(at, bytes);
                    },
                },
                base,
                request,
            ),
        );
        openFileBlobs.set(storeFile, () => blobOf(path));
        return storeFile;
    };
    const port: IStorePort = {
        list: async (dir) => [...new Set(children(dir).map((path) => path.slice(dir.length + 1).split('/')[0]!))],
        read: async (path) => bytesOf(path).slice(),
        writeAtomic: async (path, bytes) => put(path, bytes),
        open,
        copyIn,
        copy: (from, to) => copyIn(from, to),
        remove: async (path) => {
            files.delete(path);
            for (const child of children(path)) {
                files.delete(child);
            }
        },
    };
    fileBlobs.set(port, blobOf);
    return port;
}

export async function openBrowserStorePort(
    createWorker = () => new Worker(new URL('./opfsStore.worker.ts', import.meta.url), {type: 'module'}),
    onFault?: (error: Error) => void,
) {
    try {
        if (typeof Worker === 'undefined' || typeof navigator === 'undefined' || !navigator.storage?.getDirectory || !navigator.locks) {
            throw new Error('No origin private file system with Web Locks');
        }
        const port = createWorkerStorePort(createWorker(), (error) => {
            if (storeWorkerPort === port) {
                storeWorkerPort = null;
            }
            onFault?.(error);
        });
        await port.probe();
        storeWorkerPort = port;
        return {port, durable: true};
    } catch {
        return {port: createMemoryStorePort(), durable: false};
    }
}
