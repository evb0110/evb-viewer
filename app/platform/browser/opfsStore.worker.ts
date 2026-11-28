/// <reference lib="webworker" />
// The storage port's file system on the origin private file system. Sync access handles exist only in
// dedicated workers, so this worker owns every handle of its window: one writer per file, which every engine
// enforces across windows too. Handle modes are not used; Firefox and WebKit ignore them. A PDF edit that
// appends a revision runs here too, on the handle the document already holds, and so does content hashing:
// a witness reads its bytes here, so the window neither receives nor hashes them.
import {contentWitness} from '@document-store/contentWitness';
import type {IStoreFile, IStorePort} from '@document-store/storePort';
import {handlePrecompiledWasmModuleMessage} from '@app/platform/browser/loadWasmWithDeadline';
import type {IOcrTextLayerAppendRequest, IPdfAppendRequest} from '@app/platform/browser/pdfPageEngine';

type TSyncOrAsync<T> = T | Promise<T>;
type TOpfsFileOperations = {
    [K in keyof IStoreFile]: (id: number, ...args: Parameters<IStoreFile[K]>) => TSyncOrAsync<Awaited<ReturnType<IStoreFile[K]>>>;
};
type TOpfsOperationsContract = Omit<IStorePort, 'open' | 'move'> &
    TOpfsFileOperations & {
        probe(): Promise<boolean>;
        open(path: string): Promise<number>;
        witnessBlob(blob: Blob): Promise<string>;
        appendPdfMutations(id: number, base: number, request: IPdfAppendRequest | IOcrTextLayerAppendRequest): Promise<unknown>;
    };

const COPY_BYTES = 4 * 1024 * 1024;
const root = navigator.storage.getDirectory();
const handles = new Map<number, FileSystemSyncAccessHandle>();
const openPaths = new Map<string, number>();
let nextFileId = 1;

function split(path: string) {
    const segments = path.split('/');
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
        throw new Error(`Invalid store path: ${path}`);
    }
    return {dirs: segments.slice(0, -1), name: segments.at(-1)!};
}

async function directory(dirs: string[], create: boolean) {
    let dir = await root;
    for (const name of dirs) {
        dir = await dir.getDirectoryHandle(name, {create});
    }
    return dir;
}

function isMissing(error: unknown) {
    return error instanceof DOMException && (error.name === 'NotFoundError' || error.name === 'TypeMismatchError');
}

/** A write that stores fewer bytes than asked means the store is full (Firefox reports quota that way). */
function writeAll(handle: FileSystemSyncAccessHandle, bytes: Uint8Array, at: number) {
    const written = handle.write(bytes, {at});
    if (written !== bytes.byteLength) {
        throw new DOMException(`Stored ${written} of ${bytes.byteLength} bytes: the browser's storage is full`, 'QuotaExceededError');
    }
}

function file(id: number) {
    const handle = handles.get(id);
    if (!handle) {
        throw new Error(`Store file ${id} is not open`);
    }
    return handle;
}

async function openHandle(path: string) {
    const {dirs, name} = split(path);
    const fileHandle = await (await directory(dirs, true)).getFileHandle(name, {create: true});
    return fileHandle.createSyncAccessHandle();
}

/** Copies into the new file `to`, reading `read` until it returns nothing, then flushes. */
async function writeNew(to: string, chunks: AsyncIterable<Uint8Array>) {
    if (openPaths.has(to)) {
        throw new Error(`Store file is open: ${to}`);
    }
    const target = await openHandle(to);
    try {
        if (target.getSize() !== 0) {
            throw new Error(`Store file exists: ${to}`);
        }
        let offset = 0;
        for await (const chunk of chunks) {
            writeAll(target, chunk, offset);
            offset += chunk.byteLength;
        }
        target.flush();
    } finally {
        target.close();
    }
}

async function* storeChunks(from: string) {
    // The core may copy a file it holds open, such as the current revision of a document being forked.
    const openId = openPaths.get(from);
    const source = openId === undefined ? await openHandle(from) : file(openId);
    try {
        const size = source.getSize();
        for (let offset = 0; offset < size; offset += COPY_BYTES) {
            const chunk = new Uint8Array(Math.min(COPY_BYTES, size - offset));
            source.read(chunk, {at: offset});
            yield chunk;
        }
    } finally {
        if (openId === undefined) {
            source.close();
        }
    }
}

async function* blobChunks(blob: Blob) {
    const reader = blob.stream().getReader();
    for (;;) {
        const {done, value} = await reader.read();
        if (done) {
            return;
        }
        yield value;
    }
}

// Temporary file, flush, close, then the two-argument move, the one form that is atomic in every engine.
async function writeAtomic(path: string, bytes: Uint8Array) {
    const {dirs, name} = split(path);
    const dir = await directory(dirs, true);
    const tempName = `${name}.${crypto.randomUUID()}.tmp`;
    const temp = await dir.getFileHandle(tempName, {create: true});
    try {
        const handle = await temp.createSyncAccessHandle();
        try {
            handle.truncate(0);
            writeAll(handle, bytes, 0);
            handle.flush();
        } finally {
            handle.close();
        }
        await (temp as FileSystemFileHandle & {move(dir: FileSystemDirectoryHandle, name: string): Promise<void>}).move(dir, name);
    } catch (error) {
        await dir.removeEntry(tempName).catch(() => undefined);
        throw error;
    }
}

async function remove(path: string) {
    const {dirs, name} = split(path);
    try {
        await (await directory(dirs, false)).removeEntry(name, {recursive: true});
    } catch (error) {
        if (!isMissing(error)) {
            throw error;
        }
    }
}

const operations = {
    async probe(): Promise<boolean> {
        await writeAtomic('probe/probe.bin', new Uint8Array([1]));
        await remove('probe');
        return true;
    },
    async list(dir: string) {
        try {
            const names: string[] = [];
            for await (const name of (await directory(dir === '' ? [] : dir.split('/'), false)).keys()) {
                names.push(name);
            }
            return names;
        } catch (error) {
            if (isMissing(error)) {
                return [];
            }
            throw error;
        }
    },
    async read(path: string) {
        const {dirs, name} = split(path);
        const blob = await (await (await directory(dirs, false)).getFileHandle(name)).getFile();
        return new Uint8Array(await blob.arrayBuffer());
    },
    writeAtomic,
    async open(path: string) {
        if (openPaths.has(path)) {
            throw new Error(`Store file is already open: ${path}`);
        }
        const handle = await openHandle(path);
        const id = nextFileId++;
        handles.set(id, handle);
        openPaths.set(path, id);
        return id;
    },
    size: (id: number) => file(id).getSize(),
    readAt(id: number, offset: number, length: number) {
        const handle = file(id);
        const bytes = new Uint8Array(Math.max(0, Math.min(length, handle.getSize() - offset)));
        const read = handle.read(bytes, {at: offset});
        return bytes.subarray(0, read);
    },
    /** The content witness of the first `length` bytes, read synchronously into one reused buffer. */
    witness(id: number, length: number) {
        const handle = file(id);
        let buffer = new Uint8Array();
        return contentWitness(length, (offset, size) => {
            if (buffer.byteLength < size) {
                buffer = new Uint8Array(size);
            }
            const view = buffer.subarray(0, size);
            return Promise.resolve(view.subarray(0, handle.read(view, {at: offset})));
        });
    },
    /** The content witness of a Blob, such as the file a Save just wrote, read by range in this worker. */
    witnessBlob(blob: Blob) {
        if (typeof FileReaderSync === 'function') {
            const reader = new FileReaderSync();
            return contentWitness(blob.size, (offset, length) =>
                Promise.resolve(new Uint8Array(reader.readAsArrayBuffer(blob.slice(offset, offset + length)))),
            );
        }
        return contentWitness(blob.size, async (offset, length) => new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer()));
    },
    writeAt: (id: number, offset: number, bytes: Uint8Array) => writeAll(file(id), bytes, offset),
    truncate: (id: number, length: number) => file(id).truncate(length),
    /** Appends the revisions `request` makes past the first `base` bytes, the PDF they edit. */
    async appendPdfMutations(id: number, base: number, request: IPdfAppendRequest | IOcrTextLayerAppendRequest) {
        const handle = file(id);
        const {appendPdfMutations} = await import('@app/platform/browser/pdfPageEngine');
        return appendPdfMutations(
            {
                read(into, at) {
                    if (handle.read(into, {at}) !== into.byteLength) {
                        throw new Error('The document ended before its cross-reference said');
                    }
                },
                write(bytes, at) {
                    if (at < base) {
                        throw new Error('An append cannot write over its document');
                    }
                    writeAll(handle, bytes, at);
                },
            },
            base,
            request,
        );
    },
    flush: (id: number) => file(id).flush(),
    close(id: number) {
        const handle = handles.get(id);
        if (!handle) {
            return;
        }
        handle.close();
        handles.delete(id);
        for (const [path, openId] of openPaths) {
            if (openId === id) {
                openPaths.delete(path);
            }
        }
    },
    copyIn: (source: Blob | string, path: string) => writeNew(path, typeof source === 'string' ? storeChunks(source) : blobChunks(source)),
    copy: (from: string, to: string) => writeNew(to, storeChunks(from)),
    remove,
} satisfies TOpfsOperationsContract;

export type TOpfsOperations = typeof operations;

export type TOpfsRequest<K extends keyof TOpfsOperations = keyof TOpfsOperations> = {
    [P in K]: {
        id: number;
        op: P;
        args: Parameters<TOpfsOperations[P]>;
    };
}[K];

function unknownOperation(request: never): never {
    const op = typeof request === 'object' && request !== null ? Reflect.get(request, 'op') : undefined;
    throw new Error(`Unknown store operation: ${String(op)}`);
}

function invokeOperation(request: TOpfsRequest): unknown {
    switch (request.op) {
        case 'probe':
            return operations.probe(...request.args);
        case 'list':
            return operations.list(...request.args);
        case 'read':
            return operations.read(...request.args);
        case 'writeAtomic':
            return operations.writeAtomic(...request.args);
        case 'open':
            return operations.open(...request.args);
        case 'size':
            return operations.size(...request.args);
        case 'readAt':
            return operations.readAt(...request.args);
        case 'witness':
            return operations.witness(...request.args);
        case 'witnessBlob':
            return operations.witnessBlob(...request.args);
        case 'writeAt':
            return operations.writeAt(...request.args);
        case 'truncate':
            return operations.truncate(...request.args);
        case 'appendPdfMutations':
            return operations.appendPdfMutations(...request.args);
        case 'flush':
            return operations.flush(...request.args);
        case 'close':
            return operations.close(...request.args);
        case 'copyIn':
            return operations.copyIn(...request.args);
        case 'copy':
            return operations.copy(...request.args);
        case 'remove':
            return operations.remove(...request.args);
        default:
            return unknownOperation(request);
    }
}

self.addEventListener('messageerror', () => {
    self.postMessage({
        transportError: {
            name: 'StoreTransportError',
            message: 'The document store worker could not deserialize a request',
        },
    });
});

self.addEventListener('message', (event: MessageEvent<TOpfsRequest>) => {
    if (handlePrecompiledWasmModuleMessage(event.data)) {
        return;
    }
    const request = event.data;
    const {id} = request;
    void (async () => {
        let result: unknown;
        let failed: {name: string; message: string} | null = null;
        try {
            result = await invokeOperation(request);
        } catch (error) {
            const {name, message} = error instanceof Error ? error : new Error(String(error));
            failed = {name, message};
        }
        try {
            if (failed) {
                self.postMessage({id, error: failed});
            } else {
                const transfer =
                    result instanceof Uint8Array &&
                    result.byteOffset === 0 &&
                    result.byteLength === result.buffer.byteLength &&
                    result.buffer instanceof ArrayBuffer
                        ? [result.buffer]
                        : [];
                self.postMessage({id, result}, {transfer});
            }
        } catch (replyError) {
            const message = replyError instanceof Error ? replyError.message : String(replyError);
            try {
                self.postMessage({
                    id,
                    transportError: {
                        name: 'StoreTransportError',
                        message: `The document store worker could not deliver reply for ${request.op}: ${message}`,
                    },
                });
            } catch {
                self.setTimeout(() => {
                    throw replyError;
                }, 0);
            }
        }
    })();
});
