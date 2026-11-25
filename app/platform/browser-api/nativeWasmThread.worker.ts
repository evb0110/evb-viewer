/// <reference lib="webworker" />

import {
    createNativeWasmLineWriter,
    createNativeWasmThreadImports,
    reportNativeWasmThreadFault,
} from '@app/platform/browser-api/nativeWasmThreadHost';

/**
 * One host thread of a threaded native WASM engine, nested in the engine's
 * worker (`nativeWasmThreadedTool.ts`). It receives the compiled module and
 * the shared memory and reports ready. On its start message it instantiates
 * its thread, reports started, or failed when it could not, and runs the
 * thread until the engine's worker ends it.
 */

declare const self: DedicatedWorkerGlobalScope;

export interface INativeWasmThreadLoadMessage {
    type: 'load';
    module: WebAssembly.Module;
    memory: WebAssembly.Memory;
    label: string;
}

export interface INativeWasmThreadStartMessage {
    type: 'start';
    threadId: number;
    startArg: number;
    faultPointer: number;
}

export type TNativeWasmThreadReply = {type: 'ready'} | {type: 'started'} | {
    /** The thread could not be instantiated; the engine never started. */
    type: 'failed';
    message: string;
} | {
    /** The running thread trapped; the engine is faulted. */
    type: 'fault';
    message: string;
};

const describe = (error: unknown) => error instanceof Error ? `${error.name}: ${error.message}` : String(error);

let loaded: INativeWasmThreadLoadMessage | null = null;

self.addEventListener('message', (event: MessageEvent<INativeWasmThreadLoadMessage | INativeWasmThreadStartMessage>) => {
    const message = event.data;
    if (message.type === 'load') {
        loaded = message;
        self.postMessage({type: 'ready'} satisfies TNativeWasmThreadReply);
        return;
    }
    if (message.type !== 'start' || loaded === null) return;
    const {
        module, memory, label,
    } = loaded;
    let start: (threadId: number, startArg: number) => void;
    try {
        // Instantiated before it reports started, so a thread that cannot
        // exist fails the engine's start instead of its first request.
        const {exports} = new WebAssembly.Instance(module, createNativeWasmThreadImports({
            memory,
            spawnThread: () => -1,
            writeOutput: createNativeWasmLineWriter(line => console.warn(`${label}: ${line}`)),
        }));
        if (typeof exports.wasi_thread_start !== 'function') throw new Error('The threaded module has no wasi_thread_start export');
        start = exports.wasi_thread_start as typeof start;
    } catch (error) {
        self.postMessage({
            type: 'failed',
            message: describe(error),
        } satisfies TNativeWasmThreadReply);
        return;
    }
    // Posted before the thread blocks this worker for good.
    self.postMessage({type: 'started'} satisfies TNativeWasmThreadReply);
    try {
        start(message.threadId, message.startArg);
    } catch (error) {
        // The reason is posted before the engine is marked faulted, so the
        // request that then fails can carry it.
        const reason = describe(error);
        console.warn(`${label}: thread ${message.threadId} stopped: ${reason}`);
        self.postMessage({
            type: 'fault',
            message: reason,
        } satisfies TNativeWasmThreadReply);
        reportNativeWasmThreadFault(memory, message.faultPointer);
    }
});
