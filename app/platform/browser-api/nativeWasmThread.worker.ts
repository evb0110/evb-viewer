/// <reference lib="webworker" />

import {
    createNativeWasmLineWriter,
    createNativeWasmThreadImports,
    runNativeWasmThread,
} from '@app/platform/browser-api/nativeWasmThreadHost';

/**
 * One host thread of a threaded native WASM engine, nested in the engine's
 * worker (`nativeWasmThreadedTool.ts`). It receives the compiled module and
 * the shared memory, reports ready, and on its start message acknowledges and
 * runs its thread until the engine's worker ends it.
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
    type: 'fault';
    message: string;
};

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
    // Posted before the thread blocks this worker for good.
    self.postMessage({type: 'started'} satisfies TNativeWasmThreadReply);
    try {
        runNativeWasmThread({
            module,
            memory,
            faultPointer: message.faultPointer,
            threadId: message.threadId,
            startArg: message.startArg,
            imports: createNativeWasmThreadImports({
                memory,
                spawnThread: () => -1,
                writeOutput: createNativeWasmLineWriter(line => console.warn(`${label}: ${line}`)),
            }),
        });
    } catch (error) {
        // The engine has been marked faulted; the request it runs fails with this message and drops it.
        const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        console.warn(`${label}: thread ${message.threadId} stopped: ${reason}`);
        self.postMessage({
            type: 'fault',
            message: reason,
        } satisfies TNativeWasmThreadReply);
    }
});
