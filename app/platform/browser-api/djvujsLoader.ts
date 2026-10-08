import type { IDjvuPageSize } from '@contracts/electronApiDjvu';

const DJVU_SCRIPT_PATH = '/vendor/djvujs/djvu.js';
export const DJVU_SCRIPT_LOAD_TIMEOUT_MS = 15_000;

export type { IDjvuPageSize } from '@contracts/electronApiDjvu';

interface IDjvuWorkerTask<T> { run(): Promise<T>; }

interface IDjvuPageTask {
    createPngObjectUrl(): IDjvuWorkerTask<IDjvuPngObjectData>;
    getImageData(rotate?: boolean): IDjvuWorkerTask<ImageData>;
    getText(): IDjvuWorkerTask<string>;
    getNormalizedTextZones(): IDjvuWorkerTask<IDjvuNormalizedTextZone[] | null>;
}

export interface IDjvuNormalizedTextZone {
    x: number;
    y: number;
    width: number;
    height: number;
    text: string;
}

export interface IDjvuContentsItem {
    description: string;
    url: string;
    children?: IDjvuContentsItem[];
}

interface IDjvuPngObjectData {
    url: string;
    byteLength: number;
    width: number;
    height: number;
    dpi: number;
}

export interface IDjvuWorker {
    readonly doc: {
        getPagesSizes(): IDjvuWorkerTask<IDjvuPageSize[]>;
        getPagesQuantity?(): IDjvuWorkerTask<number>;
        getContents(): IDjvuWorkerTask<IDjvuContentsItem[] | null>;
        getPageNumberByUrl(url: string): IDjvuWorkerTask<number | null>;
        getPage(pageNumber: number): IDjvuPageTask;
    };
    createDocument(
        buffer: ArrayBuffer,
        options?: Record<string, unknown>,
    ): Promise<void>;
    terminate(): void;
    revokeObjectURL(url: string): void;
}

interface IDjvuGlobal { Worker: new (path?: string) => IDjvuWorker; }

type TDjvuWindow = Window & { DjVu?: IDjvuGlobal };

let djvuLoadPromise: Promise<IDjvuGlobal> | null = null;

function getLoadedDjvuGlobal() {
    if (typeof window === 'undefined') {
        return null;
    }

    return (window as TDjvuWindow).DjVu ?? null;
}

export async function loadDjvuJs() {
    const loadedGlobal = getLoadedDjvuGlobal();
    if (loadedGlobal) {
        return loadedGlobal;
    }

    if (typeof document === 'undefined') {
        throw new Error('DjVu.js can only be loaded in a browser runtime');
    }

    if (!djvuLoadPromise) {
        const pendingLoad = new Promise<IDjvuGlobal>((resolve, reject) => {
            let script = document.querySelector<HTMLScriptElement>(
                `script[data-djvujs-src="${DJVU_SCRIPT_PATH}"]`,
            );

            if (script?.dataset.djvujsState === 'failed'
                || script?.dataset.djvujsState === 'ready') {
                script.remove();
                script = null;
            }

            if (!script) {
                script = document.createElement('script');
                script.src = DJVU_SCRIPT_PATH;
                script.async = true;
                script.dataset.djvujsSrc = DJVU_SCRIPT_PATH;
                script.dataset.djvujsState = 'loading';
            }

            const targetScript = script;
            let settled = false;
            const timeoutId = globalThis.setTimeout(() => {
                fail(new Error(`Timed out loading DjVu.js from ${DJVU_SCRIPT_PATH}`));
            }, DJVU_SCRIPT_LOAD_TIMEOUT_MS);

            const cleanup = () => {
                globalThis.clearTimeout(timeoutId);
                targetScript.removeEventListener('load', handleLoad);
                targetScript.removeEventListener('error', handleError);
            };
            const fail = (error: Error) => {
                if (settled) {
                    return;
                }
                settled = true;
                cleanup();
                targetScript.dataset.djvujsState = 'failed';
                targetScript.remove();
                reject(error);
            };
            const handleLoad = () => {
                if (settled) {
                    return;
                }
                const nextGlobal = getLoadedDjvuGlobal();
                if (!nextGlobal) {
                    fail(new Error('DjVu.js loaded without exposing window.DjVu'));
                    return;
                }
                settled = true;
                cleanup();
                targetScript.dataset.djvujsState = 'ready';
                resolve(nextGlobal);
            };
            const handleError = () => {
                fail(new Error(`Failed to load DjVu.js from ${DJVU_SCRIPT_PATH}`));
            };

            targetScript.addEventListener('load', handleLoad);
            targetScript.addEventListener('error', handleError);
            if (!targetScript.isConnected) {
                document.head.append(targetScript);
            }
        });
        const retryableLoad = pendingLoad.catch((error: unknown) => {
            if (djvuLoadPromise === retryableLoad) {
                djvuLoadPromise = null;
            }
            throw error;
        });
        djvuLoadPromise = retryableLoad;
    }

    return djvuLoadPromise;
}
