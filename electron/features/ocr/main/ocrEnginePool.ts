import {
    dirname,
    join,
} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Worker} from 'node:worker_threads';
import * as electron from 'electron';
import {WORKER_BUNDLES_BY_ID} from '@electron-worker-bundles/electronWorkerBundles.js';
import type {
    IOcrEngineRequest,
    IOcrEngineResult,
} from '@ocr-core/tesseractEngine';
import type {IOcrEngineWorkerData} from '@electron/features/ocr/main/ocrEngineWorker';
import {getRuntimeTessdataDir} from '@electron/features/ocr/languageModels';
import {getOcrRuntimePolicy} from '@electron/features/ocr/main/ocrRuntimePolicy';
import {resolveUnpackedWorkerPath} from '@electron/utils/workerTask';

const __dirname = dirname(fileURLToPath(import.meta.url));
// A worker keeps its engine and models loaded between pages for a while.
const ENGINE_IDLE_TTL_MS = 60_000;
// One Tesseract pass may run three minutes, as in the browser.
const PASS_TIMEOUT_MS = 3 * 60 * 1000;

interface IEngineWorker {
    worker: Worker;
    busy: boolean;
    idleTimer?: NodeJS.Timeout;
}

export interface IOcrEnginePoolOptions {
    size: () => number;
    workerPath: string;
    workerData: IOcrEngineWorkerData;
}

/**
 * Node worker threads running the shared engine, one warm engine each, never
 * on the main thread. Canceling or a pass past its time limit ends the busy
 * worker, since a worker inside Tesseract cannot read messages.
 */
export function createOcrEnginePool(options: IOcrEnginePoolOptions) {
    const workers = new Set<IEngineWorker>();
    const waiters: Array<() => void> = [];
    let nextId = 0;

    const release = (entry: IEngineWorker) => {
        entry.busy = false;
        entry.idleTimer = setTimeout(() => {
            workers.delete(entry);
            void entry.worker.terminate();
        }, ENGINE_IDLE_TTL_MS);
        entry.idleTimer.unref();
        waiters.shift()?.();
    };

    const discard = (entry: IEngineWorker) => {
        workers.delete(entry);
        void entry.worker.terminate();
        waiters.shift()?.();
    };

    const acquire = async (signal: AbortSignal): Promise<IEngineWorker> => {
        for (;;) {
            signal.throwIfAborted();
            const idle = [...workers].find(entry => !entry.busy);
            if (idle) {
                clearTimeout(idle.idleTimer);
                idle.busy = true;
                return idle;
            }
            if (workers.size < Math.max(1, options.size())) {
                const entry: IEngineWorker = {
                    worker: new Worker(options.workerPath, {workerData: options.workerData}),
                    busy: true,
                };
                entry.worker.unref();
                // An idle worker that fails must not throw into the main process.
                entry.worker.on('error', () => workers.delete(entry));
                entry.worker.on('exit', () => workers.delete(entry));
                workers.add(entry);
                return entry;
            }
            await new Promise<void>((resolve) => {
                const wake = () => {
                    signal.removeEventListener('abort', wake);
                    const index = waiters.indexOf(wake);
                    if (index >= 0) waiters.splice(index, 1);
                    resolve();
                };
                waiters.push(wake);
                signal.addEventListener('abort', wake, {once: true});
            });
        }
    };

    return {
        async run(request: IOcrEngineRequest, signal: AbortSignal): Promise<IOcrEngineResult> {
            const entry = await acquire(signal);
            const id = nextId++;
            const {worker} = entry;
            return new Promise<IOcrEngineResult>((resolve, reject) => {
                const settle = (error: Error | null, result?: IOcrEngineResult) => {
                    clearTimeout(timer);
                    signal.removeEventListener('abort', onAbort);
                    worker.off('message', onMessage);
                    worker.off('error', onError);
                    worker.off('exit', onExit);
                    if (error) reject(error);
                    else resolve(result!);
                };
                const onMessage = (message: {
                    id: number;
                    ok: boolean;
                    result?: IOcrEngineResult;
                    error?: string
                }) => {
                    if (message.id !== id) return;
                    release(entry);
                    settle(message.ok ? null : new Error(message.error), message.result);
                };
                const onError = (error: Error) => {
                    discard(entry);
                    settle(new Error(`The OCR engine stopped: ${error.message}`));
                };
                const onExit = (code: number) => {
                    discard(entry);
                    settle(new Error(`The OCR engine exited with code ${code}`));
                };
                const onAbort = () => {
                    discard(entry);
                    settle(signal.reason instanceof Error ? signal.reason : new Error('OCR was canceled'));
                };
                const timer = setTimeout(() => {
                    discard(entry);
                    settle(new Error('Tesseract did not finish within its time limit'));
                }, PASS_TIMEOUT_MS * request.passes.length);
                worker.on('message', onMessage);
                worker.on('error', onError);
                worker.on('exit', onExit);
                signal.addEventListener('abort', onAbort, {once: true});
                if (signal.aborted) {
                    onAbort();
                    return;
                }
                worker.postMessage({
                    id,
                    request,
                }, [request.image.buffer as ArrayBuffer]);
            });
        },
        terminate() {
            for (const entry of workers) void entry.worker.terminate();
            workers.clear();
        },
    };
}

let appPool: ReturnType<typeof createOcrEnginePool> | null = null;

/** The engine bundled with the renderer: unpacked beside the app archive, or the repository's public files. */
function resolveOcrEngineDir() {
    return (electron as {app?: {isPackaged?: boolean}}).app?.isPackaged === true
        ? join(process.resourcesPath, 'app.asar.unpacked', 'nuxt-output', 'public', 'wasm')
        : join(__dirname, '..', 'public', 'wasm');
}

/** Runs one page's passes on the app's engine pool, sized like desktop's OCR page slots. */
export function runOcrEngine(request: IOcrEngineRequest, signal: AbortSignal) {
    appPool ??= createOcrEnginePool({
        size: () => getOcrRuntimePolicy().globalPageSlots,
        workerPath: resolveUnpackedWorkerPath(__dirname, WORKER_BUNDLES_BY_ID['ocr-engine'].fileName),
        workerData: {
            engineDir: resolveOcrEngineDir(),
            tessdataDir: getRuntimeTessdataDir(),
        },
    });
    return appPool.run(request, signal);
}

export function shutdownOcrEnginePool() {
    appPool?.terminate();
    appPool = null;
}
