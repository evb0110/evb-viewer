import {afterEach, describe, expect, it, vi} from 'vitest';
import {BrowserDocumentStore} from '@app/platform/browser/browserDocumentRepository';
import {publishSourceBlob} from '@app/platform/browser/browserPublication';
import {appendPdfMutationsToStoreFile, createWorkerStorePort, openBrowserStorePort} from '@app/platform/browser/browserStorePort';
import type {TOpfsOperations, TOpfsRequest} from '@app/platform/browser/opfsStore.worker';

class MockStoreWorker extends EventTarget {
    readonly sent: TOpfsRequest[] = [];
    terminated = false;
    private readonly handler: (request: TOpfsRequest) => {
        result?: unknown;
        error?: {name: string; message: string};
    } | null;
    private readonly onPostMessage: ((request: TOpfsRequest) => void) | undefined;

    constructor(
        handler: (request: TOpfsRequest) => {
            result?: unknown;
            error?: {name: string; message: string};
        } | null,
        onPostMessage?: (request: TOpfsRequest) => void,
    ) {
        super();
        this.handler = handler;
        this.onPostMessage = onPostMessage;
    }

    postMessage(message: unknown) {
        if (typeof message !== 'object' || message === null || !('op' in message)) {
            return;
        }
        const request = message as TOpfsRequest;
        this.onPostMessage?.(request);
        this.sent.push(request);
        const reply = this.handler(request);
        if (!reply) {
            return;
        }
        queueMicrotask(() => {
            this.dispatchEvent(
                new MessageEvent('message', {
                    data: {
                        id: request.id,
                        ...reply,
                    },
                }),
            );
        });
    }

    deliverReply(id: number, reply: {result?: unknown; error?: {name: string; message: string}}) {
        this.dispatchEvent(new MessageEvent('message', {data: {id, ...reply}}));
    }

    emitWorkerError(message: string) {
        const event = new Event('error');
        Object.defineProperty(event, 'message', {value: message});
        this.dispatchEvent(event);
    }

    emitMessageError() {
        this.dispatchEvent(new MessageEvent('messageerror'));
    }

    terminate() {
        this.terminated = true;
    }
}

describe('browserStorePort typed worker RPC', () => {
    it('routes typed OPFS worker calls, preserves void/undefined returns, and propagates store errors', async () => {
        const payload = new Uint8Array([1, 2, 3]);
        const worker = new MockStoreWorker((request) => {
            switch (request.op) {
                case 'probe':
                    return {result: true};
                case 'list':
                    return {result: ['manifest.json']};
                case 'read':
                    return {result: payload};
                case 'writeAtomic':
                    return {result: undefined};
                case 'open':
                    return {result: 7};
                case 'size':
                    return {result: 3};
                case 'readAt':
                    return {result: payload.subarray(1, 3)};
                case 'witness':
                    return {result: 'content-v2:file'};
                case 'witnessBlob':
                    return {result: 'content-v2:blob'};
                case 'writeAt':
                    return {result: undefined};
                case 'truncate':
                    return {result: undefined};
                case 'flush':
                    return {result: undefined};
                case 'close':
                    return {result: undefined};
                case 'copyIn':
                    return {result: undefined};
                case 'copy':
                    return {result: undefined};
                case 'remove':
                    return {error: {name: 'QuotaExceededError', message: 'disk full'}};
                case 'appendPdfMutations':
                    return {result: {status: 'failed', error: {code: 'invalid-request', message: 'synthetic'}}};
            }
        });

        const port = createWorkerStorePort(worker as unknown as Worker);

        expect(await port.probe()).toBe(true);
        expect(await port.list('documents')).toEqual(['manifest.json']);
        expect(await port.read('documents/a/manifest.json')).toEqual(payload);
        expect(await port.writeAtomic('documents/a/manifest.json', payload)).toBeUndefined();
        expect(await port.witnessBlob(new Blob([payload]))).toBe('content-v2:blob');
        expect(await port.copyIn('from', 'to')).toBeUndefined();
        expect(await port.copy('from', 'to')).toBeUndefined();

        const file = await port.open('documents/a/r1.pdf');
        expect(await file.size()).toBe(3);
        expect(await file.readAt(1, 2)).toEqual(new Uint8Array([2, 3]));
        expect(await file.witness(3)).toBe('content-v2:file');
        expect(await file.writeAt(0, payload)).toBeUndefined();
        expect(await file.truncate(2)).toBeUndefined();
        expect(await file.flush()).toBeUndefined();
        const appended = await appendPdfMutationsToStoreFile(file, 3, {
            mutations: {},
            modifiedAt: '2026-11-27T00:00:00.000Z',
        });
        expect(appended).toEqual({status: 'failed', error: {code: 'invalid-request', message: 'synthetic'}});
        expect(await file.close()).toBeUndefined();

        await expect(port.remove('documents/a')).rejects.toMatchObject({
            name: 'QuotaExceededError',
            message: 'disk full',
        });

        expect(worker.sent.map((request) => request.op)).toEqual([
            'probe',
            'list',
            'read',
            'writeAtomic',
            'witnessBlob',
            'copyIn',
            'copy',
            'open',
            'size',
            'readAt',
            'witness',
            'writeAt',
            'truncate',
            'flush',
            'appendPdfMutations',
            'close',
            'remove',
        ]);
    });

    it('rejects all pending requests when the worker emits an error event', async () => {
        const worker = new MockStoreWorker(() => null);
        const port = createWorkerStorePort(worker as unknown as Worker);

        const pending = port.list('documents');
        worker.emitWorkerError('worker crashed');

        await expect(pending).rejects.toThrow('The document store worker failed: worker crashed');
    });

    it('falls back to the memory store when OPFS worker probing fails', async () => {
        const failingWorker = new MockStoreWorker(() => ({
            error: {name: 'SecurityError', message: 'OPFS disabled'},
        }));
        vi.stubGlobal('Worker', MockStoreWorker);
        vi.stubGlobal('navigator', {
            storage: {getDirectory: vi.fn()},
            locks: {request: vi.fn()},
        });

        try {
            const opened = await openBrowserStorePort(() => failingWorker as unknown as Worker);

            expect(failingWorker.sent.map((request) => request.op)).toEqual(['probe']);
            expect(opened.durable).toBe(false);
            await opened.port.writeAtomic('docs/test.txt', new Uint8Array([65, 66]));
            expect(await opened.port.read('docs/test.txt')).toEqual(new Uint8Array([65, 66]));
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('rejects mismatched OPFS worker RPC requests at compile time', () => {
        const validProbe: TOpfsRequest<'probe'> = {id: 1, op: 'probe', args: []};
        const validReadAt: TOpfsRequest<'readAt'> = {id: 2, op: 'readAt', args: [1, 0, 16]};
        const _returnTypes: [
            Awaited<ReturnType<TOpfsOperations['probe']>>,
            Awaited<ReturnType<TOpfsOperations['open']>>,
            Awaited<ReturnType<TOpfsOperations['flush']>>,
        ] = [true, 1, undefined];

        const _invalidArgs: TOpfsRequest<'readAt'> = {
            id: 3,
            op: 'readAt',
            // @ts-expect-error readAt expects [number, number, number]
            args: ['not-an-id', 0, 16],
        };
        const _unknownOp: TOpfsRequest = {
            id: 4,
            // @ts-expect-error unknown OPFS worker operation name must not compile
            op: 'nonExistentOp',
            args: [],
        };

        expect([validProbe.op, validReadAt.op, _returnTypes.length, _invalidArgs.id, _unknownOp.id]).toEqual(['probe', 'readAt', 3, 3, 4]);
    });
});

function createFakeOpfsRoot(backing = new Map<string, Uint8Array>()) {
    const dirHandle = (prefix: string): FileSystemDirectoryHandle => {
        const keyOf = (name: string) => (prefix ? `${prefix}/${name}` : name);
        return {
            kind: 'directory',
            name: prefix.split('/').at(-1) ?? '',
            async getDirectoryHandle(name: string, options?: FileSystemGetDirectoryOptions) {
                const sub = keyOf(name);
                if (!options?.create && ![...backing.keys()].some((k) => k === sub || k.startsWith(`${sub}/`))) {
                    throw new DOMException(`Missing dir: ${sub}`, 'NotFoundError');
                }
                return dirHandle(sub);
            },
            async getFileHandle(name: string, options?: FileSystemGetFileOptions) {
                const fullPath = keyOf(name);
                if (!backing.has(fullPath)) {
                    if (!options?.create) {
                        throw new DOMException(`Missing file: ${fullPath}`, 'NotFoundError');
                    }
                    backing.set(fullPath, new Uint8Array(0));
                }
                let currentPath = fullPath;
                return {
                    kind: 'file',
                    name,
                    async getFile() {
                        const bytes = backing.get(currentPath);
                        if (!bytes) {
                            throw new DOMException(`Missing file: ${currentPath}`, 'NotFoundError');
                        }
                        return new File([bytes as Uint8Array<ArrayBuffer>], name);
                    },
                    async createSyncAccessHandle() {
                        return {
                            getSize: () => backing.get(currentPath)?.byteLength ?? 0,
                            read(buf: ArrayBufferView, opts?: {at?: number}) {
                                const src = backing.get(currentPath) ?? new Uint8Array(0);
                                const at = opts?.at ?? 0;
                                const target = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
                                const slice = src.subarray(at, Math.min(src.byteLength, at + target.byteLength));
                                target.set(slice);
                                return slice.byteLength;
                            },
                            write(buf: ArrayBufferView, opts?: {at?: number}) {
                                const at = opts?.at ?? 0;
                                const src = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
                                const prev = backing.get(currentPath) ?? new Uint8Array(0);
                                const next = new Uint8Array(Math.max(prev.byteLength, at + src.byteLength));
                                next.set(prev);
                                next.set(src, at);
                                backing.set(currentPath, next);
                                return src.byteLength;
                            },
                            truncate(len: number) {
                                const prev = backing.get(currentPath) ?? new Uint8Array(0);
                                const next = new Uint8Array(len);
                                next.set(prev.subarray(0, Math.min(prev.byteLength, len)));
                                backing.set(currentPath, next);
                            },
                            flush() {},
                            close() {},
                        };
                    },
                    async move(_dir: FileSystemDirectoryHandle, targetName: string) {
                        const targetPath = keyOf(targetName);
                        const bytes = backing.get(currentPath) ?? new Uint8Array(0);
                        backing.delete(currentPath);
                        backing.set(targetPath, bytes);
                        currentPath = targetPath;
                    },
                } as unknown as FileSystemFileHandle;
            },
            async removeEntry(name: string, options?: FileSystemRemoveOptions) {
                const target = keyOf(name);
                let removed = false;
                for (const key of [...backing.keys()]) {
                    if (key === target || (options?.recursive && key.startsWith(`${target}/`))) {
                        backing.delete(key);
                        removed = true;
                    }
                }
                if (!removed) {
                    throw new DOMException(`Missing entry: ${target}`, 'NotFoundError');
                }
            },
            async *keys() {
                const seen = new Set<string>();
                const base = prefix ? `${prefix}/` : '';
                for (const key of backing.keys()) {
                    if (key.startsWith(base)) {
                        const child = key.slice(base.length).split('/')[0]!;
                        if (!seen.has(child)) {
                            seen.add(child);
                            yield child;
                        }
                    }
                }
            },
        } as unknown as FileSystemDirectoryHandle;
    };
    return {backing, root: dirHandle('')};
}

function withTimeout<T>(promise: Promise<T>, label: string, ms = 250): Promise<T> {
    return Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
            setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), ms);
        }),
    ]);
}

async function createPairedOpfsWorker(
    backing: Map<string, Uint8Array>,
    options: {failReplyOn?: (message: unknown) => boolean; onWriteAtomic?: (path: string) => void} = {},
) {
    const workerBus = new EventTarget();
    const hostBus = new EventTarget();
    let terminated = false;
    const workerSelf = Object.assign(workerBus, {
        setTimeout(fn: () => void) {
            queueMicrotask(() => {
                if (terminated) {
                    return;
                }
                try {
                    fn();
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    hostBus.dispatchEvent(new ErrorEvent('error', {message}));
                }
            });
            return 0;
        },
        postMessage(message: unknown) {
            if (terminated) {
                return;
            }
            if (options.failReplyOn?.(message)) {
                throw new DOMException('Reply could not be cloned', 'DataCloneError');
            }
            queueMicrotask(() => {
                if (!terminated) {
                    hostBus.dispatchEvent(new MessageEvent('message', {data: message}));
                }
            });
        },
    });
    const {root} = createFakeOpfsRoot(backing);
    vi.stubGlobal('self', workerSelf);
    vi.stubGlobal('navigator', {
        storage: {getDirectory: async () => root},
        locks: {
            request: async (_name: string, _optsOrCb: unknown, maybeCb?: (lock: object) => unknown) => {
                const cb = typeof _optsOrCb === 'function' ? (_optsOrCb as (lock: object) => unknown) : maybeCb!;
                return cb({name: _name});
            },
        },
    });
    vi.resetModules();
    await import('@app/platform/browser/opfsStore.worker');
    const hostWorker = Object.assign(hostBus, {
        terminated: false,
        postMessage(message: unknown) {
            if (terminated) {
                return;
            }
            if (typeof message === 'object' && message !== null && Reflect.get(message, 'op') === 'writeAtomic') {
                const args = Reflect.get(message, 'args') as [string, Uint8Array];
                options.onWriteAtomic?.(args[0]);
            }
            queueMicrotask(() => {
                if (!terminated) {
                    workerBus.dispatchEvent(new MessageEvent('message', {data: message}));
                }
            });
        },
        emitWorkerMessageError() {
            workerBus.dispatchEvent(new MessageEvent('messageerror'));
        },
        terminate() {
            terminated = true;
            this.terminated = true;
        },
    });
    return hostWorker;
}

describe('G-4 OPFS worker transport fault handling', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('removes only the unsent request on synchronous postMessage throw without poisoning in-flight or later calls', async () => {
        const deferred: TOpfsRequest[] = [];
        const worker = new MockStoreWorker(
            (request) => {
                if (request.op === 'list' && request.args[0] === 'in-flight') {
                    deferred.push(request);
                    return null;
                }
                return {result: ['ok']};
            },
            (request) => {
                if (request.op === 'read' && request.args[0] === 'uncloneable') {
                    throw new DOMException('Cannot clone argument', 'DataCloneError');
                }
            },
        );
        const port = createWorkerStorePort(worker as unknown as Worker);

        const inFlight = port.list('in-flight');
        await expect(port.read('uncloneable')).rejects.toMatchObject({name: 'DataCloneError'});
        expect(worker.terminated).toBe(false);

        worker.deliverReply(deferred[0]!.id, {result: ['still-alive']});
        await expect(inFlight).resolves.toEqual(['still-alive']);
        await expect(port.list('after')).resolves.toEqual(['ok']);
    });

    it('settles all outstanding requests and rejects future calls on main-side messageerror instead of hanging', async () => {
        const worker = new MockStoreWorker(() => null);
        const port = createWorkerStorePort(worker as unknown as Worker);

        const first = port.list('a');
        const second = port.read('b');
        worker.emitMessageError();

        await expect(withTimeout(first, 'first request after messageerror')).rejects.toMatchObject({name: 'StoreTransportError'});
        await expect(withTimeout(second, 'second request after messageerror')).rejects.toMatchObject({name: 'StoreTransportError'});
        expect(worker.terminated).toBe(true);
        const sentBefore = worker.sent.length;
        await expect(withTimeout(port.list('after-fault'), 'future call on broken port')).rejects.toMatchObject({
            name: 'StoreTransportError',
        });
        expect(worker.sent.length).toBe(sentBefore);
    });

    it('settles requests and marks port broken on worker-side messageerror and split reply postMessage failure', async () => {
        const backing = new Map<string, Uint8Array>();
        const worker1 = await createPairedOpfsWorker(backing);
        const port1 = createWorkerStorePort(worker1 as unknown as Worker);

        const pending1 = port1.list('documents');
        worker1.emitWorkerMessageError();
        await expect(withTimeout(pending1, 'worker messageerror settlement')).rejects.toMatchObject({name: 'StoreTransportError'});
        await expect(withTimeout(port1.list('after-worker-messageerror'), 'future call after worker messageerror')).rejects.toMatchObject({
            name: 'StoreTransportError',
        });

        let failedOnce = false;
        const worker2 = await createPairedOpfsWorker(backing, {
            failReplyOn: (msg) => {
                if (!failedOnce && typeof msg === 'object' && msg !== null && 'result' in msg && Reflect.get(msg, 'result') === undefined) {
                    failedOnce = true;
                    return true;
                }
                return false;
            },
        });
        const port2 = createWorkerStorePort(worker2 as unknown as Worker);
        await expect(
            withTimeout(port2.writeAtomic('documents/doc1/manifest.json', new TextEncoder().encode('{"v":1}')), 'split reply fault'),
        ).rejects.toMatchObject({name: 'StoreTransportError'});
        // The mutation executed before reply serialization failed: bytes are persisted, and future calls reject cleanly.
        expect(new TextDecoder().decode(backing.get('documents/doc1/manifest.json'))).toBe('{"v":1}');
        await expect(withTimeout(port2.read('documents/doc1/manifest.json'), 'future call after reply fault')).rejects.toMatchObject({
            name: 'StoreTransportError',
        });
    });

    it('reopens the durable store under lock and reads back the manifest after a failed mutation reply without retrying the mutation', async () => {
        const backing = new Map<string, Uint8Array>();
        const manifestWrites: string[] = [];
        let workerIndex = 0;
        let faultNextManifestReply = false;
        const createdWorkers: Array<{terminated: boolean}> = [];

        const createLazyPairedWorker = () => {
            const index = ++workerIndex;
            let pendingManifestReplyId: number | null = null;
            const hostBus = new EventTarget();
            let inner: Awaited<ReturnType<typeof createPairedOpfsWorker>> | null = null;
            let terminated = false;
            const queued: unknown[] = [];
            const ready = createPairedOpfsWorker(backing, {
                onWriteAtomic: (path) => {
                    if (path.endsWith('/manifest.json')) {
                        manifestWrites.push(`${index}:${path}`);
                    }
                },
                failReplyOn: (msg) => {
                    if (
                        faultNextManifestReply &&
                        pendingManifestReplyId !== null &&
                        typeof msg === 'object' &&
                        msg !== null &&
                        Reflect.get(msg, 'id') === pendingManifestReplyId &&
                        'result' in msg
                    ) {
                        faultNextManifestReply = false;
                        return true;
                    }
                    return false;
                },
            }).then((paired) => {
                inner = paired;
                paired.addEventListener('message', (event) => {
                    if (!terminated) {
                        hostBus.dispatchEvent(new MessageEvent('message', {data: (event as MessageEvent).data}));
                    }
                });
                if (terminated) {
                    paired.terminate();
                    return;
                }
                for (const msg of queued.splice(0)) {
                    paired.postMessage(msg);
                }
            });
            void ready;
            const hostWorker = Object.assign(hostBus, {
                terminated: false,
                postMessage(message: unknown) {
                    if (terminated) {
                        return;
                    }
                    if (
                        faultNextManifestReply &&
                        typeof message === 'object' &&
                        message !== null &&
                        Reflect.get(message, 'op') === 'writeAtomic'
                    ) {
                        const args = Reflect.get(message, 'args') as [string, Uint8Array];
                        if (args[0].endsWith('/manifest.json')) {
                            pendingManifestReplyId = Reflect.get(message, 'id') as number;
                        }
                    }
                    if (inner) {
                        inner.postMessage(message);
                    } else {
                        queued.push(message);
                    }
                },
                terminate() {
                    terminated = true;
                    this.terminated = true;
                    inner?.terminate();
                },
            });
            createdWorkers.push(hostWorker);
            return hostWorker as unknown as Worker;
        };

        const {root} = createFakeOpfsRoot(backing);
        vi.stubGlobal('Worker', MockStoreWorker);
        vi.stubGlobal('navigator', {
            storage: {getDirectory: async () => root},
            locks: {
                request: async (_name: string, _optsOrCb: unknown, maybeCb?: (lock: object) => unknown) => {
                    const cb = typeof _optsOrCb === 'function' ? (_optsOrCb as (lock: object) => unknown) : maybeCb!;
                    return cb({name: _name});
                },
            },
        });
        const repo = new BrowserDocumentStore(createLazyPairedWorker);
        const ref = await repo.createStoredDocument('fault.pdf', new TextEncoder().encode('rev-1'), {
            mimeType: 'application/pdf',
            kind: 'working',
        });
        const entry = await repo.requireEntry(ref);
        const token1 = repo.tokenOf(entry);
        const writesBefore = manifestWrites.length;

        faultNextManifestReply = true;
        await expect(
            withTimeout(
                repo.write(ref, new TextEncoder().encode('rev-2-committed-on-disk'), {expectedDocumentRevisionToken: token1}),
                'mutation with failed reply',
                2_000,
            ),
        ).rejects.toMatchObject({name: 'StoreTransportError'});

        // Mutation executed once on worker 1 and was NEVER retried on worker 2.
        expect(manifestWrites.length).toBe(writesBefore + 1);
        expect(createdWorkers.length).toBe(2);
        expect(createdWorkers[0]!.terminated).toBe(true);
        // Locked store reopen + manifest readback recovered the committed revision from OPFS!
        expect(new TextDecoder().decode(await repo.read(ref))).toBe('rev-2-committed-on-disk');
        expect(repo.tokenOf(entry)).not.toBe(token1);
        // Next mutation succeeds cleanly on the replacement worker.
        await repo.write(ref, new TextEncoder().encode('rev-3-after-reopen'), {expectedDocumentRevisionToken: repo.tokenOf(entry)});
        expect(new TextDecoder().decode(await repo.read(ref))).toBe('rev-3-after-reopen');
        await repo.release(ref);
    });

    it('reopens cleanly and keeps the prior revision when a transport fault happens before manifest commit', async () => {
        const backing = new Map<string, Uint8Array>();
        let faultNextWriteAt = false;
        const createdWorkers: Array<{terminated: boolean}> = [];
        const createLazyPairedWorker = () => {
            const hostBus = new EventTarget();
            let inner: Awaited<ReturnType<typeof createPairedOpfsWorker>> | null = null;
            let terminated = false;
            const queued: unknown[] = [];
            void createPairedOpfsWorker(backing).then((paired) => {
                inner = paired;
                paired.addEventListener('message', (event) => {
                    if (!terminated) {
                        hostBus.dispatchEvent(new MessageEvent('message', {data: (event as MessageEvent).data}));
                    }
                });
                if (terminated) {
                    paired.terminate();
                    return;
                }
                for (const msg of queued.splice(0)) {
                    paired.postMessage(msg);
                }
            });
            const hostWorker = Object.assign(hostBus, {
                terminated: false,
                postMessage(message: unknown) {
                    if (terminated) {
                        return;
                    }
                    if (faultNextWriteAt && typeof message === 'object' && message !== null && Reflect.get(message, 'op') === 'copyIn') {
                        faultNextWriteAt = false;
                        queueMicrotask(() => hostBus.dispatchEvent(new MessageEvent('messageerror')));
                        return;
                    }
                    if (inner) {
                        inner.postMessage(message);
                    } else {
                        queued.push(message);
                    }
                },
                terminate() {
                    terminated = true;
                    this.terminated = true;
                    inner?.terminate();
                },
            });
            createdWorkers.push(hostWorker);
            return hostWorker as unknown as Worker;
        };

        const {root} = createFakeOpfsRoot(backing);
        vi.stubGlobal('Worker', MockStoreWorker);
        vi.stubGlobal('navigator', {
            storage: {getDirectory: async () => root},
            locks: {
                request: async (_name: string, _optsOrCb: unknown, maybeCb?: (lock: object) => unknown) => {
                    const cb = typeof _optsOrCb === 'function' ? (_optsOrCb as (lock: object) => unknown) : maybeCb!;
                    return cb({name: _name});
                },
            },
        });
        const repo = new BrowserDocumentStore(createLazyPairedWorker);
        const ref = await repo.createStoredDocument('uncommitted.pdf', new TextEncoder().encode('rev-1-intact'), {
            mimeType: 'application/pdf',
            kind: 'working',
        });
        const entry = await repo.requireEntry(ref);
        const token1 = repo.tokenOf(entry);

        faultNextWriteAt = true;
        await expect(
            withTimeout(
                repo.write(ref, new TextEncoder().encode('rev-2-never-committed'), {expectedDocumentRevisionToken: token1}),
                'uncommitted mutation fault',
                2_000,
            ),
        ).rejects.toMatchObject({name: 'StoreTransportError'});

        expect(createdWorkers.length).toBe(2);
        expect(createdWorkers[0]!.terminated).toBe(true);
        expect(repo.tokenOf(entry)).toBe(token1);
        expect(new TextDecoder().decode(await repo.read(ref))).toBe('rev-1-intact');
        await repo.release(ref);
    });

    it('slices the OPFS File directly in publishSourceBlob without copying bytes through worker readAt RPCs', async () => {
        const backing = new Map<string, Uint8Array>();
        const worker = await createPairedOpfsWorker(backing);
        const port = createWorkerStorePort(worker as unknown as Worker);
        const payload = new TextEncoder().encode('%PDF-1.7 direct OPFS slice payload plus trailing bytes');
        const file = await port.open('documents/direct-slice/r1.pdf');
        await file.writeAt(0, payload);
        await file.flush();

        const readAtSpy = vi.spyOn(file, 'readAt');
        const prefixLength = '%PDF-1.7 direct OPFS slice payload'.length;
        const blob = await publishSourceBlob(
            {
                path: 'documents/direct-slice/r1.pdf',
                length: prefixLength,
                file,
            },
            'application/pdf',
        );

        expect(readAtSpy).not.toHaveBeenCalled();
        expect(blob.type).toBe('application/pdf');
        expect(blob.size).toBe(prefixLength);
        // Download Blob must remain readable independently even if the live OPFS file is overwritten or deleted right after Save.
        await file.writeAt(0, new TextEncoder().encode('OVERWRITTEN BY LATER EDIT'));
        await file.close();
        await port.remove('documents/direct-slice');
        expect(new TextDecoder().decode(new Uint8Array(await blob.arrayBuffer()))).toBe('%PDF-1.7 direct OPFS slice payload');
    });

    it('preserves byteRevision epoch on unchanged reopen, advances it on changed reopen, and retries if a replacement worker faults during manifest readback', async () => {
        const backing = new Map<string, Uint8Array>();
        let workerIndex = 0;
        let faultNextManifestReply = false;
        let faultWorker2Read = true;
        let faultUncommittedCopyIn = false;
        const createdWorkers: Array<{terminated: boolean}> = [];

        const createLazyPairedWorker = () => {
            const index = ++workerIndex;
            let pendingManifestReplyId: number | null = null;
            const hostBus = new EventTarget();
            let inner: Awaited<ReturnType<typeof createPairedOpfsWorker>> | null = null;
            let terminated = false;
            const queued: unknown[] = [];
            void createPairedOpfsWorker(backing, {
                failReplyOn: (msg) => {
                    if (
                        faultNextManifestReply &&
                        pendingManifestReplyId !== null &&
                        typeof msg === 'object' &&
                        msg !== null &&
                        Reflect.get(msg, 'id') === pendingManifestReplyId &&
                        'result' in msg
                    ) {
                        faultNextManifestReply = false;
                        return true;
                    }
                    return false;
                },
            }).then((paired) => {
                inner = paired;
                paired.addEventListener('message', (event) => {
                    if (!terminated) {
                        hostBus.dispatchEvent(new MessageEvent('message', {data: (event as MessageEvent).data}));
                    }
                });
                if (terminated) {
                    paired.terminate();
                    return;
                }
                for (const msg of queued.splice(0)) {
                    paired.postMessage(msg);
                }
            });
            const hostWorker = Object.assign(hostBus, {
                terminated: false,
                postMessage(message: unknown) {
                    if (terminated) {
                        return;
                    }
                    if (typeof message === 'object' && message !== null) {
                        const op = Reflect.get(message, 'op');
                        // Fault replacement worker #2 between probe() and manifest readback!
                        if (index === 2 && faultWorker2Read && op === 'read') {
                            faultWorker2Read = false;
                            queueMicrotask(() => hostBus.dispatchEvent(new MessageEvent('messageerror')));
                            return;
                        }
                        if (faultUncommittedCopyIn && op === 'copyIn') {
                            faultUncommittedCopyIn = false;
                            queueMicrotask(() => hostBus.dispatchEvent(new MessageEvent('messageerror')));
                            return;
                        }
                        if (faultNextManifestReply && op === 'writeAtomic') {
                            const args = Reflect.get(message, 'args') as [string, Uint8Array];
                            if (args[0].endsWith('/manifest.json')) {
                                pendingManifestReplyId = Reflect.get(message, 'id') as number;
                            }
                        }
                    }
                    if (inner) {
                        inner.postMessage(message);
                    } else {
                        queued.push(message);
                    }
                },
                terminate() {
                    terminated = true;
                    this.terminated = true;
                    inner?.terminate();
                },
            });
            createdWorkers.push(hostWorker);
            return hostWorker as unknown as Worker;
        };

        const {root} = createFakeOpfsRoot(backing);
        vi.stubGlobal('Worker', MockStoreWorker);
        vi.stubGlobal('navigator', {
            storage: {getDirectory: async () => root},
            locks: {
                request: async (_name: string, _optsOrCb: unknown, maybeCb?: (lock: object) => unknown) => {
                    const cb = typeof _optsOrCb === 'function' ? (_optsOrCb as (lock: object) => unknown) : maybeCb!;
                    return cb({name: _name});
                },
            },
        });
        const repo = new BrowserDocumentStore(createLazyPairedWorker);
        const ref = await repo.createStoredDocument('epoch.pdf', new TextEncoder().encode('rev-1'), {
            mimeType: 'application/pdf',
            kind: 'working',
        });
        const entry = await repo.requireEntry(ref);
        // Advance byteRevision from 0 -> 1 before any fault.
        await repo.write(ref, new TextEncoder().encode('rev-2'), {expectedDocumentRevisionToken: repo.tokenOf(entry)});
        const readerBefore = await repo.readableRevision(ref);
        expect(readerBefore.byteRevision).toBe(1);

        // Uncommitted fault on worker 1 -> worker 2 passes probe() then faults on manifest read -> worker 3 succeeds!
        faultUncommittedCopyIn = true;
        await expect(
            withTimeout(
                repo.write(ref, new TextEncoder().encode('rev-3-aborted'), {expectedDocumentRevisionToken: readerBefore.token}),
                'uncommitted fault with worker 2 readback fault',
                2_000,
            ),
        ).rejects.toMatchObject({name: 'StoreTransportError'});

        // Worker 3 recovered cleanly (worker 2 was NOT cached broken!) and preserved byteRevision === 1 for unchanged bytes.
        expect(createdWorkers.length).toBe(3);
        expect(createdWorkers[0]!.terminated).toBe(true);
        expect(createdWorkers[1]!.terminated).toBe(true);
        await expect(
            repo.assertDocumentRevisionCurrent(ref, readerBefore.token, {
                strict: true,
                expectedInstance: readerBefore.instance,
                expectedByteRevision: readerBefore.byteRevision!,
            }),
        ).resolves.toBeUndefined();

        // Now fault AFTER manifest commit on worker 3 -> worker 4 recovers committed bytes AND advances byteRevision so stale readers refuse!
        faultNextManifestReply = true;
        await expect(
            withTimeout(
                repo.write(ref, new TextEncoder().encode('rev-3-committed'), {expectedDocumentRevisionToken: readerBefore.token}),
                'committed fault advances byteRevision',
                2_000,
            ),
        ).rejects.toMatchObject({name: 'StoreTransportError'});

        expect(createdWorkers.length).toBe(4);
        await expect(
            repo.assertDocumentRevisionCurrent(ref, readerBefore.token, {
                strict: true,
                expectedInstance: readerBefore.instance,
                expectedByteRevision: readerBefore.byteRevision!,
            }),
        ).rejects.toMatchObject({code: 'STALE_REVISION'});
        const readerAfter = await repo.readableRevision(ref);
        expect(readerAfter.byteRevision).toBeGreaterThan(readerBefore.byteRevision!);
        expect(new TextDecoder().decode(await repo.read(ref))).toBe('rev-3-committed');
        await repo.release(ref);
    });

    it('drains an in-flight OPFS page rewrite before manifest recovery removes its uncommitted output', async () => {
        const backing = new Map<string, Uint8Array>();
        const lockedOutputs = new Set<string>();
        let worker1Bus: EventTarget | null = null;
        const createdWorkers: Array<{terminated: boolean}> = [];

        const createLazyPairedWorker = () => {
            const hostBus = new EventTarget();
            worker1Bus ??= hostBus;
            let inner: Awaited<ReturnType<typeof createPairedOpfsWorker>> | null = null;
            let terminated = false;
            const queued: unknown[] = [];
            void createPairedOpfsWorker(backing).then((paired) => {
                inner = paired;
                paired.addEventListener('message', (event) => {
                    if (!terminated) {
                        hostBus.dispatchEvent(new MessageEvent('message', {data: (event as MessageEvent).data}));
                    }
                });
                if (terminated) {
                    paired.terminate();
                    return;
                }
                for (const msg of queued.splice(0)) {
                    paired.postMessage(msg);
                }
            });
            const hostWorker = Object.assign(hostBus, {
                terminated: false,
                postMessage(message: unknown) {
                    if (terminated) {
                        return;
                    }
                    // Simulate OPFS NoModificationAllowedError if recovery tries to remove an output still held by pageOps worker.
                    if (typeof message === 'object' && message !== null && Reflect.get(message, 'op') === 'remove') {
                        const target = (Reflect.get(message, 'args') as [string])[0];
                        if (lockedOutputs.has(target)) {
                            const id = Reflect.get(message, 'id') as number;
                            queueMicrotask(() =>
                                hostBus.dispatchEvent(
                                    new MessageEvent('message', {
                                        data: {id, error: {name: 'NoModificationAllowedError', message: `Locked: ${target}`}},
                                    }),
                                ),
                            );
                            return;
                        }
                    }
                    if (inner) {
                        inner.postMessage(message);
                    } else {
                        queued.push(message);
                    }
                },
                terminate() {
                    terminated = true;
                    this.terminated = true;
                    inner?.terminate();
                },
            });
            createdWorkers.push(hostWorker);
            return hostWorker as unknown as Worker;
        };

        const {root} = createFakeOpfsRoot(backing);
        vi.stubGlobal('Worker', MockStoreWorker);
        vi.stubGlobal('navigator', {
            storage: {getDirectory: async () => root},
            locks: {
                request: async (_name: string, _optsOrCb: unknown, maybeCb?: (lock: object) => unknown) => {
                    const cb = typeof _optsOrCb === 'function' ? (_optsOrCb as (lock: object) => unknown) : maybeCb!;
                    return cb({name: _name});
                },
            },
        });
        const repo = new BrowserDocumentStore(createLazyPairedWorker);
        const ref = await repo.createStoredDocument('rewrite-race.pdf', new TextEncoder().encode('rev-1'), {
            mimeType: 'application/pdf',
            kind: 'working',
        });
        const entry = await repo.requireEntry(ref);
        const token1 = repo.tokenOf(entry);

        let writerStarted!: () => void;
        let releaseWriter!: () => void;
        const started = new Promise<void>((r) => {
            writerStarted = r;
        });
        const release = new Promise<void>((r) => {
            releaseWriter = r;
        });

        const rewritePromise = repo.rewrite(ref, token1, async (_source, output) => {
            expect(output).not.toBeNull();
            backing.set(output!, new TextEncoder().encode('partial uncommitted output'));
            lockedOutputs.add(output!);
            writerStarted();
            await release;
            lockedOutputs.delete(output!);
            return undefined;
        });

        await started;
        // Transport fault hits worker 1 while the external pageOps worker still holds `output` locked!
        worker1Bus!.dispatchEvent(new MessageEvent('messageerror'));
        // Yield microtasks so recovery queues behind the in-flight rewrite, then release the external writer's sync handle.
        await Promise.resolve();
        await Promise.resolve();
        releaseWriter();

        await expect(withTimeout(rewritePromise, 'in-flight rewrite after fault', 2_000)).rejects.toMatchObject({
            name: 'StoreTransportError',
        });
        expect(createdWorkers.length).toBe(2);
        // Recovery waited for the rewrite to finish, cleaned up the uncommitted output, and rebound the entry to worker 2.
        expect(new TextDecoder().decode(await repo.read(ref))).toBe('rev-1');
        await repo.write(ref, new TextEncoder().encode('rev-2-after-drain'), {expectedDocumentRevisionToken: repo.tokenOf(entry)});
        expect(new TextDecoder().decode(await repo.read(ref))).toBe('rev-2-after-drain');
        await repo.release(ref);
    });

    it('recovers without deadlock during writeStream, retries a replacement worker that faults during probe, and preserves live Undo retention', async () => {
        const backing = new Map<string, Uint8Array>();
        let workerIndex = 0;
        let faultStreamWriteAt = false;
        let faultWorker2Probe = true;
        const createdWorkers: Array<{terminated: boolean}> = [];

        const createLazyPairedWorker = () => {
            const index = ++workerIndex;
            const hostBus = new EventTarget();
            let inner: Awaited<ReturnType<typeof createPairedOpfsWorker>> | null = null;
            let terminated = false;
            const queued: unknown[] = [];
            void createPairedOpfsWorker(backing).then((paired) => {
                inner = paired;
                paired.addEventListener('message', (event) => {
                    if (!terminated) {
                        hostBus.dispatchEvent(new MessageEvent('message', {data: (event as MessageEvent).data}));
                    }
                });
                if (terminated) {
                    paired.terminate();
                    return;
                }
                for (const msg of queued.splice(0)) {
                    paired.postMessage(msg);
                }
            });
            const hostWorker = Object.assign(hostBus, {
                terminated: false,
                postMessage(message: unknown) {
                    if (terminated) {
                        return;
                    }
                    if (typeof message === 'object' && message !== null) {
                        const op = Reflect.get(message, 'op');
                        if (index === 2 && faultWorker2Probe && op === 'probe') {
                            faultWorker2Probe = false;
                            queueMicrotask(() => hostBus.dispatchEvent(new MessageEvent('messageerror')));
                            return;
                        }
                        if (faultStreamWriteAt && op === 'writeAt') {
                            faultStreamWriteAt = false;
                            queueMicrotask(() => hostBus.dispatchEvent(new MessageEvent('messageerror')));
                            return;
                        }
                    }
                    if (inner) {
                        inner.postMessage(message);
                    } else {
                        queued.push(message);
                    }
                },
                terminate() {
                    terminated = true;
                    this.terminated = true;
                    inner?.terminate();
                },
            });
            createdWorkers.push(hostWorker);
            return hostWorker as unknown as Worker;
        };

        const {root} = createFakeOpfsRoot(backing);
        vi.stubGlobal('Worker', MockStoreWorker);
        vi.stubGlobal('navigator', {
            storage: {getDirectory: async () => root},
            locks: {
                request: async (_name: string, _optsOrCb: unknown, maybeCb?: (lock: object) => unknown) => {
                    const cb = typeof _optsOrCb === 'function' ? (_optsOrCb as (lock: object) => unknown) : maybeCb!;
                    return cb({name: _name});
                },
            },
        });
        const repo = new BrowserDocumentStore(createLazyPairedWorker);
        const ref = await repo.createStoredDocument('stream-undo.pdf', new TextEncoder().encode('rev-1'), {
            mimeType: 'application/pdf',
            kind: 'working',
        });
        const entry = await repo.requireEntry(ref);
        const token1 = repo.tokenOf(entry);
        await repo.write(ref, new TextEncoder().encode('rev-2'), {expectedDocumentRevisionToken: token1});
        const token2 = repo.tokenOf(entry);
        await repo.retainRevisions(ref, [token1, token2]);
        await repo.write(ref, new TextEncoder().encode('rev-3'), {expectedDocumentRevisionToken: token2});
        const token3 = repo.tokenOf(entry);
        await repo.retainRevisions(ref, [token1, token2, token3]);

        // Start a writeStream and inject a transport fault mid-stream (plus worker #2 faulting during probe!).
        const stream = await repo.writeStream(ref);
        faultStreamWriteAt = true;
        await stream.write(new TextEncoder().encode('streamed-chunk'));
        await expect(withTimeout(stream.close(), 'writeStream fault without deadlock', 2_000)).rejects.toThrow();

        // Worker #2 faulted during probe -> recovery retried and succeeded on Worker #3!
        expect(createdWorkers.length).toBe(3);
        expect(createdWorkers[0]!.terminated).toBe(true);
        expect(createdWorkers[1]!.terminated).toBe(true);
        expect(new TextDecoder().decode(await repo.read(ref))).toBe('rev-3');

        // Both consecutive Undos succeed because the live retained set was restored on the reopened directory!
        await repo.restoreRevision(ref, token2, repo.tokenOf(entry));
        expect(new TextDecoder().decode(await repo.read(ref))).toBe('rev-2');
        await repo.restoreRevision(ref, token1, repo.tokenOf(entry));
        expect(new TextDecoder().decode(await repo.read(ref))).toBe('rev-1');
        await repo.release(ref);
    });

    it('settles callers via worker error event when both primary and fallback reply postMessage throw', async () => {
        const backing = new Map<string, Uint8Array>();
        const worker = await createPairedOpfsWorker(backing, {
            failReplyOn: () => true,
        });
        const port = createWorkerStorePort(worker as unknown as Worker);
        await expect(withTimeout(port.list('documents'), 'double reply postMessage failure', 500)).rejects.toMatchObject({
            name: 'StoreTransportError',
        });
        expect(worker.terminated).toBe(true);
    });

    it('rebinds a dirty document if the worker faults while hold() awaits checkpoint naming, and heals transient NoModificationAllowedError on reopen', async () => {
        const backing = new Map<string, Uint8Array>();
        let workerIndex = 0;
        let worker1Bus: EventTarget | null = null;
        let worker2OpenFailCount = 4; // Fails all 3 retries during reopen, then succeeds on subsequent read!
        const createdWorkers: Array<{terminated: boolean}> = [];

        const createLazyPairedWorker = () => {
            const index = ++workerIndex;
            const hostBus = new EventTarget();
            if (index === 1) {
                worker1Bus = hostBus;
            }
            let inner: Awaited<ReturnType<typeof createPairedOpfsWorker>> | null = null;
            let terminated = false;
            const queued: unknown[] = [];
            void createPairedOpfsWorker(backing).then((paired) => {
                inner = paired;
                paired.addEventListener('message', (event) => {
                    if (!terminated) {
                        hostBus.dispatchEvent(new MessageEvent('message', {data: (event as MessageEvent).data}));
                    }
                });
                if (terminated) {
                    paired.terminate();
                    return;
                }
                for (const msg of queued.splice(0)) {
                    paired.postMessage(msg);
                }
            });
            const hostWorker = Object.assign(hostBus, {
                terminated: false,
                postMessage(message: unknown) {
                    if (terminated) {
                        return;
                    }
                    if (
                        index === 2 &&
                        worker2OpenFailCount > 0 &&
                        typeof message === 'object' &&
                        message !== null &&
                        Reflect.get(message, 'op') === 'open'
                    ) {
                        worker2OpenFailCount -= 1;
                        const id = Reflect.get(message, 'id') as number;
                        queueMicrotask(() => {
                            if (!terminated) {
                                hostBus.dispatchEvent(
                                    new MessageEvent('message', {
                                        data: {id, error: {name: 'NoModificationAllowedError', message: 'Sync handle still closing'}},
                                    }),
                                );
                            }
                        });
                        return;
                    }
                    if (inner) {
                        inner.postMessage(message);
                    } else {
                        queued.push(message);
                    }
                },
                terminate() {
                    terminated = true;
                    this.terminated = true;
                    inner?.terminate();
                },
            });
            createdWorkers.push(hostWorker);
            return hostWorker as unknown as Worker;
        };

        const {root} = createFakeOpfsRoot(backing);
        vi.stubGlobal('Worker', MockStoreWorker);
        vi.stubGlobal('navigator', {
            storage: {getDirectory: async () => root},
            locks: {
                request: async (_name: string, _optsOrCb: unknown, maybeCb?: (lock: object) => unknown) => {
                    const cb = typeof _optsOrCb === 'function' ? (_optsOrCb as (lock: object) => unknown) : maybeCb!;
                    return cb({name: _name});
                },
            },
        });
        const repo = new BrowserDocumentStore(createLazyPairedWorker);
        let faultedDuringNaming = false;
        repo.onDirectoryEdited = async () => {
            if (!faultedDuringNaming) {
                faultedDuringNaming = true;
                worker1Bus!.dispatchEvent(new MessageEvent('messageerror'));
                await Promise.resolve();
                await Promise.resolve();
            }
            return true;
        };

        // Creating a dirty working document awaits onDirectoryEdited inside hold(); worker 1 faults mid-hold,
        // and worker 2 transiently rejects open with NoModificationAllowedError during reopen.
        const ref = await repo.createStoredDocument('dirty-hold.pdf', new TextEncoder().encode('dirty-bytes'), {
            mimeType: 'application/pdf',
            kind: 'working',
        });
        expect(createdWorkers.length).toBe(2);
        expect(createdWorkers[0]!.terminated).toBe(true);
        // Subsequent read transparently rebinds the entry onto worker 2 and reads the committed bytes!
        expect(new TextDecoder().decode(await repo.read(ref))).toBe('dirty-bytes');
        await repo.release(ref);
    });

    it('rejects a stale memory-backed rewrite when an edit and Undo run while the rewrite is in flight', async () => {
        vi.stubGlobal('Worker', undefined);
        const repo = new BrowserDocumentStore();
        const ref = await repo.createStoredDocument('mem-rewrite.pdf', new TextEncoder().encode('rev-1'), {
            mimeType: 'application/pdf',
            kind: 'working',
        });
        const entry = await repo.requireEntry(ref);
        const token1 = repo.tokenOf(entry);
        await repo.retainRevisions(ref, [token1]);

        await expect(
            repo.rewrite(ref, token1, async () => {
                // Intervening edit + Undo restores token1 while advancing byteRevision!
                await repo.write(ref, new TextEncoder().encode('rev-2'), {expectedDocumentRevisionToken: token1});
                await repo.restoreRevision(ref, token1, repo.tokenOf(entry));
                expect(repo.tokenOf(entry)).toBe(token1);
                return new TextEncoder().encode('stale-rewrite-output');
            }),
        ).rejects.toMatchObject({code: 'STALE_REVISION'});

        expect(new TextDecoder().decode(await repo.read(ref))).toBe('rev-1');
        await repo.release(ref);
    });
});
