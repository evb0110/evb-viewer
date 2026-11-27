import {describe, expect, it, vi} from 'vitest';
import {appendPdfMutationsToStoreFile, createWorkerStorePort, openBrowserStorePort} from '@app/platform/browser/browserStorePort';
import type {TOpfsOperations, TOpfsRequest} from '@app/platform/browser/opfsStore.worker';

class MockStoreWorker extends EventTarget {
    readonly sent: TOpfsRequest[] = [];
    private readonly handler: (request: TOpfsRequest) => {
        result?: unknown;
        error?: {name: string; message: string};
    } | null;

    constructor(
        handler: (request: TOpfsRequest) => {
            result?: unknown;
            error?: {name: string; message: string};
        } | null,
    ) {
        super();
        this.handler = handler;
    }

    postMessage(message: unknown) {
        if (typeof message !== 'object' || message === null || !('op' in message)) {
            return;
        }
        const request = message as TOpfsRequest;
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

    emitWorkerError(message: string) {
        const event = new Event('error');
        Object.defineProperty(event, 'message', {value: message});
        this.dispatchEvent(event);
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
