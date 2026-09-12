import { Worker } from 'node:worker_threads';
import { resolve } from 'node:path';
import { build } from 'esbuild';

interface IWorkerReadyMessage {kind: 'ready';}
interface IWorkerResultMessage {
    id: number;
    kind: 'result';
    value: unknown;
}
interface IWorkerErrorMessage {
    error: string;
    id: number;
    kind: 'error';
}
type TWorkerMessage = IWorkerReadyMessage | IWorkerResultMessage | IWorkerErrorMessage;

interface IPendingRequest {
    reject: (error: Error) => void;
    resolve: (value: unknown) => void;
}

export interface IRealWorkerProtocolHarness {
    close: () => Promise<void>;
    decode: <T>(decoder: string, frame: unknown, transferList?: ArrayBuffer[]) => Promise<T>;
}

export async function createRealWorkerProtocolHarness(options: {
    decoders: readonly string[];
    modulePath: string;
}): Promise<IRealWorkerProtocolHarness> {
    const decoderNames = JSON.stringify(options.decoders);
    const source = `
        import {parentPort} from 'node:worker_threads';
        import * as protocol from ${JSON.stringify(options.modulePath)};

        const decoderNames = new Set(${decoderNames});
        if (!parentPort) throw new Error('Protocol harness requires parentPort');
        parentPort.on('message', ({id, decoder, frame}) => {
            try {
                if (!decoderNames.has(decoder) || typeof protocol[decoder] !== 'function') {
                    throw new Error('Unknown protocol decoder: ' + decoder);
                }
                parentPort.postMessage({kind: 'result', id, value: protocol[decoder](frame)});
            } catch (error) {
                parentPort.postMessage({
                    kind: 'error',
                    id,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        });
        parentPort.postMessage({kind: 'ready'});
    `;
    const buildResult = await build({
        bundle: true,
        format: 'cjs',
        platform: 'node',
        target: 'node22',
        tsconfig: resolve(process.cwd(), 'tsconfig.base.json'),
        write: false,
        stdin: {
            contents: source,
            loader: 'ts',
            resolveDir: process.cwd(),
            sourcefile: 'real-worker-protocol-harness.ts',
        },
    });
    const output = buildResult.outputFiles[0]?.text;
    if (!output) {
        throw new Error('Protocol harness bundle produced no output');
    }

    const worker = new Worker(output, {eval: true});
    const pending = new Map<number, IPendingRequest>();
    let nextRequestId = 1;
    let resolveReady: (() => void) | null = null;
    let rejectReady: ((error: Error) => void) | null = null;
    const ready = new Promise<void>((resolvePromise, rejectPromise) => {
        resolveReady = resolvePromise;
        rejectReady = rejectPromise;
    });
    worker.on('message', (message: TWorkerMessage) => {
        if (message.kind === 'ready') {
            resolveReady?.();
            return;
        }
        const request = pending.get(message.id);
        pending.delete(message.id);
        if (!request) {
            return;
        }
        if (message.kind === 'error') {
            request.reject(new Error(message.error));
            return;
        }
        request.resolve(message.value);
    });
    worker.on('error', (error) => {
        rejectReady?.(error);
        for (const request of pending.values()) {
            request.reject(error);
        }
        pending.clear();
    });
    await ready;

    return {
        close: async () => {
            await worker.terminate();
        },
        decode: <T>(decoder: string, frame: unknown, transferList: ArrayBuffer[] = []) => new Promise<T>((resolvePromise, rejectPromise) => {
            const id = nextRequestId;
            nextRequestId += 1;
            pending.set(id, {
                reject: rejectPromise,
                resolve: value => resolvePromise(value as T),
            });
            worker.postMessage({
                decoder,
                frame,
                id,
            }, transferList);
        }),
    };
}
