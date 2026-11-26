import { getErrorMessage } from '@app/utils/error';
import {
    compileWasmWithDeadline,
    resolveWasmUrl,
} from '@app/platform/browser/loadWasmWithDeadline';
import {
    createNativeWasmLineWriter,
    createNativeWasmThreadImports,
    createNativeWasmThreadMemory,
} from '@app/platform/browser/nativeWasmThreadHost';
import type {
    INativeWasmThreadLoadMessage,
    INativeWasmThreadStartMessage,
    TNativeWasmThreadReply,
} from '@app/platform/browser/nativeWasmThread.worker';

/** A tool's threaded build (`wasm32-wasip1-threads`) and the threads each instance runs. */
export interface INativeWasmThreadsDescriptor {
    /** Public path of the threaded module, such as `/wasm/evb-scan-cleanup-threads.wasm`. */
    path: string;
    /** Host threads each instance starts; the instance keeps them for life. */
    count: number;
    /** The shared memory's maximum in 64 KiB pages. */
    maximumMemoryPages?: number;
}

/**
 * The threaded build compiled but did not come up: its memory, an instance or
 * a thread failed, or the threads did not all report within the deadline. A
 * page that sees this runs the single-threaded build instead.
 */
export class NativeWasmThreadStartError extends Error {
    public constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = 'NativeWasmThreadStartError';
    }
}

export interface INativeWasmThreadedInstance {
    exports: WebAssembly.Exports;
    /** Ends the instance's threads. The instance must not be called after. */
    dispose: () => void;
    /** Why a thread died, once the engine reported a fault; null when no thread says so soon. */
    readFault: () => Promise<string | null>;
}

/** How long a faulted request waits for the dead thread's own account. */
const THREAD_FAULT_REPORT_MS = 500;

/** Starting the threads involves only local work; ten seconds is far past any healthy start. */
const THREAD_START_DEADLINE_MS = 10_000;

function call(value: WebAssembly.ExportValue | undefined, name: string, ...args: number[]): number {
    if (typeof value !== 'function') throw new Error(`The threaded module has no ${name} export`);
    return (value as (...values: number[]) => number)(...args);
}

/** The next reply of `type` from a thread worker; a worker error or its failed reply rejects it. */
function replyOf(worker: Worker, type: 'ready' | 'started') {
    return new Promise<void>((resolve, reject) => {
        const onMessage = (event: MessageEvent<TNativeWasmThreadReply>) => {
            if (event.data?.type === 'failed') {
                settle();
                reject(new Error(`a thread could not start: ${event.data.message}`));
                return;
            }
            if (event.data?.type !== type) return;
            settle();
            resolve();
        };
        const onError = (event: Event) => {
            settle();
            const message: unknown = Reflect.get(event, 'message');
            reject(new Error(typeof message === 'string' && message ? message : 'A thread worker failed to start'));
        };
        const settle = () => {
            worker.removeEventListener('message', onMessage);
            worker.removeEventListener('error', onError);
            worker.removeEventListener('messageerror', onError);
        };
        worker.addEventListener('message', onMessage);
        worker.addEventListener('error', onError);
        worker.addEventListener('messageerror', onError);
    });
}

function withDeadline<T>(work: Promise<T>, deadline: Promise<never>) {
    return Promise.race([
        work,
        deadline,
    ]);
}

/**
 * Starts instances of a tool's threaded build in this worker. The module is
 * compiled once and kept across instances; each instance gets a new shared
 * memory, a main instance in this worker and `count` thread workers nested in
 * it. Terminating this worker ends them too.
 *
 * Start-up order: every thread worker receives the module and the memory and
 * reports ready; the main instance runs `_initialize`, then the tool's thread
 * start export, whose spawn calls each hand a ready worker its thread id and
 * start argument; each worker acknowledges before it instantiates its thread,
 * so no thread instance exists before `_initialize` has finished; the instance
 * is returned once every thread has acknowledged.
 */
export function createNativeWasmThreadedInstances({
    prefix,
    label,
    threads,
}: {
    prefix: string;
    label: string;
    threads: INativeWasmThreadsDescriptor;
}) {
    let compiled: Promise<WebAssembly.Module> | null = null;
    const writeOutput = createNativeWasmLineWriter(line => console.warn(`${label}: ${line}`));

    function compile() {
        const current = compiled ??= compileWasmWithDeadline(resolveWasmUrl(threads.path));
        current.catch(() => {
            if (compiled === current) compiled = null;
        });
        return current;
    }

    async function start(module: WebAssembly.Module): Promise<INativeWasmThreadedInstance> {
        const workers: Worker[] = [];
        const dispose = () => {
            for (const worker of workers) worker.terminate();
        };
        let reportFault: (reason: string) => void = () => undefined;
        const fault = new Promise<string>((resolve) => {
            reportFault = resolve;
        });
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error(`its threads did not start within ${THREAD_START_DEADLINE_MS} ms`)), THREAD_START_DEADLINE_MS);
        });
        deadline.catch(() => undefined);
        try {
            const memory = createNativeWasmThreadMemory(threads.maximumMemoryPages);
            for (let index = 0; index < threads.count; index += 1) {
                const worker = new Worker(new URL('./nativeWasmThread.worker.ts', import.meta.url), {
                    type: 'module',
                    name: `${label} thread`,
                });
                // A thread that dies marks the engine faulted; its error must
                // not also reach the page as this worker's.
                worker.addEventListener('error', event => event.preventDefault());
                worker.addEventListener('message', (event: MessageEvent<TNativeWasmThreadReply>) => {
                    if (event.data?.type === 'fault') reportFault(event.data.message);
                });
                workers.push(worker);
            }
            await withDeadline(Promise.all(workers.map((worker) => {
                const ready = replyOf(worker, 'ready');
                worker.postMessage({
                    type: 'load',
                    module,
                    memory,
                    label,
                } satisfies INativeWasmThreadLoadMessage);
                return ready;
            })), deadline);
            const idle = [...workers];
            const started: Array<Promise<void>> = [];
            let faultPointer = 0;
            let lastThreadId = 0;
            const instance = await WebAssembly.instantiate(module, createNativeWasmThreadImports({
                memory,
                writeOutput,
                spawnThread: (startArg) => {
                    const worker = idle.shift();
                    if (!worker) return -1;
                    lastThreadId += 1;
                    started.push(replyOf(worker, 'started'));
                    worker.postMessage({
                        type: 'start',
                        threadId: lastThreadId,
                        startArg,
                        faultPointer,
                    } satisfies INativeWasmThreadStartMessage);
                    return lastThreadId;
                },
            }));
            const {exports} = instance;
            call(exports._initialize, '_initialize');
            faultPointer = call(exports[`${prefix}_thread_fault_ptr`], 'thread fault');
            const count = call(exports[`${prefix}_start_threads`], 'thread start', threads.count);
            if (count !== threads.count) throw new Error(`it started ${count} of ${threads.count} threads`);
            await withDeadline(Promise.all(started), deadline);
            return {
                exports,
                dispose,
                readFault: () => Promise.race([
                    fault,
                    new Promise<null>(resolve => setTimeout(() => resolve(null), THREAD_FAULT_REPORT_MS)),
                ]),
            };
        } catch (error) {
            dispose();
            throw error;
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * A new running instance. A failed download rejects as itself and is
     * tried again next time. A module this browser cannot compile, and
     * anything after compilation, rejects with `NativeWasmThreadStartError`.
     */
    async function instantiate() {
        let module: WebAssembly.Module;
        try {
            module = await compile();
        } catch (error) {
            if (error instanceof WebAssembly.CompileError || error instanceof WebAssembly.LinkError) {
                throw new NativeWasmThreadStartError(`This browser cannot compile the threaded ${label}: ${getErrorMessage(error)}`, {cause: error});
            }
            throw error;
        }
        try {
            return await start(module);
        } catch (error) {
            throw new NativeWasmThreadStartError(`The ${label} could not start its threads: ${getErrorMessage(error)}`, {cause: error});
        }
    }

    return {instantiate};
}
