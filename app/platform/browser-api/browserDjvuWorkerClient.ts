import type {
    IDjvuComponentDirectory,
    IDjvuDocInfo,
    IDjvuOutlineRawItem,
    IDjvuPageInfo,
    IDjvuPageLayerSummary,
    IDjvuPageTextRaw,
    IDjvuRenderedPage,
    IDjvuRenderPageOptions,
} from '@djvu-core/djvuLibreTypes';
import type {
    TBrowserDjvuWorkerRequest,
    TBrowserDjvuWorkerResponse,
} from '@app/platform/browser-api/browserDjvuEngine.worker';
import { getErrorMessage } from '@app/utils/error';

export type { IDjvuPageSize } from '@contracts/electronApiDjvu';
export type {
    IDjvuComponentDirectory,
    IDjvuComponentRequest,
    IDjvuDocInfo,
    IDjvuOutlineRawItem,
    IDjvuPageInfo,
    IDjvuPageLayerSummary,
    IDjvuPageTextRaw,
    IDjvuRenderedPage,
    IDjvuRenderPageOptions,
} from '@djvu-core/djvuLibreTypes';

/** Reads a component the DjVuLibre worker asked for by name, as a standalone `AT&T` file. */
export type TDjvuComponentReader = (name: string) => Promise<Uint8Array>;

export interface IDjvuNormalizedTextZone {
    x: number;
    y: number;
    width: number;
    height: number;
    text: string;
}

export interface IDjvuWorker {
    readonly worker?: Worker;
    open(initBytes: ArrayBuffer, hasComponents: boolean): Promise<void>;
    getComponentDirectory(): Promise<IDjvuComponentDirectory | null>;
    getDocInfo(): Promise<IDjvuDocInfo>;
    getPageInfo(pageNumber: number): Promise<IDjvuPageInfo>;
    getPageLayerSummary(pageNumber: number, defaultForegroundSubsample?: number): Promise<IDjvuPageLayerSummary>;
    renderPage(pageNumber: number, options?: IDjvuRenderPageOptions): Promise<IDjvuRenderedPage>;
    renderMaskPbm(pageNumber: number): Promise<Uint8Array | null>;
    renderBackgroundRgb(pageNumber: number): Promise<{
        width: number;
        height: number;
        rgb: Uint8Array;
    } | null>;
    renderPagePpm(pageNumber: number, options?: Omit<IDjvuRenderPageOptions, 'pixelFormat'>): Promise<{
        width: number;
        height: number;
        ppm: Uint8Array;
    } | null>;
    getOutline(): Promise<IDjvuOutlineRawItem[]>;
    getPageNumberByUrl(url: string): Promise<number | null>;
    getPageText(pageNumber: number, options?: { includeZones?: boolean }): Promise<IDjvuPageTextRaw>;
    pageHasText(pageNumber: number): Promise<boolean>;
    getMetadata(): Promise<Record<string, string>>;
    clearCache(): Promise<void>;
    terminate(): void;
}

function createWorkerError(message: string, name?: string) {
    if (name === 'RangeError') {
        return new RangeError(message);
    }
    if (name === 'AbortError') {
        return new DOMException(message, 'AbortError');
    }
    const error = new Error(message);
    if (name) {
        error.name = name;
    }
    return error;
}

/**
 * Creates a DjVuLibre WASM Web Worker client. Terminating the client kills the
 * worker, closes its component channel, and immediately rejects every pending
 * and queued request with `AbortError`.
 */
export function createBrowserDjvuWorker(readComponent?: TDjvuComponentReader): IDjvuWorker {
    if (typeof Worker === 'undefined') {
        throw new Error('Web Workers are unavailable for DjVu decoding');
    }
    const worker = new Worker(
        new URL('./browserDjvuEngine.worker.ts', import.meta.url),
        { type: 'module' },
    );
    let terminated = false;
    let nextRequestId = 1;
    let componentChannel: MessageChannel | null = null;
    const pending = new Map<number, {
        resolve: (value: unknown) => void;
        reject: (error: unknown) => void;
    }>();

    const failAll = (error: unknown) => {
        for (const entry of pending.values()) {
            entry.reject(error);
        }
        pending.clear();
    };

    worker.addEventListener('message', (event: MessageEvent<TBrowserDjvuWorkerResponse>) => {
        const response = event.data;
        if (!response || typeof response !== 'object' || typeof response.id !== 'number') {
            return;
        }
        const entry = pending.get(response.id);
        if (!entry) {return;}
        pending.delete(response.id);
        if (response.ok) {
            entry.resolve(response.data);
        } else {
            entry.reject(createWorkerError(response.error, response.errorName));
        }
    });

    const shutdown = (error: unknown) => {
        if (terminated) {
            return;
        }
        terminated = true;
        if (componentChannel) {
            componentChannel.port1.onmessage = null;
            componentChannel.port1.close();
            componentChannel = null;
        }
        worker.terminate();
        failAll(error);
    };

    worker.addEventListener('error', (event: ErrorEvent) => {
        shutdown(new Error(event.message || 'DjVuLibre WASM worker crashed'));
    });

    const call = <T>(
        payload: Omit<TBrowserDjvuWorkerRequest, 'id'> | TBrowserDjvuWorkerRequest,
        transfer: Transferable[] = [],
    ): Promise<T> => {
        if (terminated) {
            return Promise.reject(new DOMException('DjVu worker was terminated', 'AbortError'));
        }
        const id = nextRequestId++;
        return new Promise<T>((resolve, reject) => {
            pending.set(id, {
                resolve: resolve as (value: unknown) => void,
                reject,
            });
            try {
                worker.postMessage({
                    ...payload,
                    id,
                }, transfer);
            } catch (error) {
                pending.delete(id);
                reject(error);
            }
        });
    };

    const terminate = () => {
        shutdown(new DOMException('DjVu worker was terminated', 'AbortError'));
    };

    return {
        worker,
        async open(initBytes: ArrayBuffer, hasComponents: boolean) {
            if (terminated) {
                throw new DOMException('DjVu worker was terminated', 'AbortError');
            }
            const transfer: Transferable[] = [initBytes];
            if (hasComponents && readComponent) {
                const channel = new MessageChannel();
                componentChannel = channel;
                channel.port1.onmessage = (event: MessageEvent<{
                    id: number;
                    name: string;
                }>) => {
                    const {
                        id,
                        name,
                    } = event.data;
                    void Promise.resolve().then(() => readComponent(name)).then((bytes) => {
                        if (terminated || componentChannel !== channel) {
                            return;
                        }
                        // Always transfer a fresh copy so transferring never detaches a cached/shared buffer.
                        const buffer = bytes.slice().buffer;
                        channel.port1.postMessage({
                            id,
                            ok: true,
                            buffer,
                        }, [buffer]);
                    }, (error: unknown) => {
                        if (terminated || componentChannel !== channel) {
                            return;
                        }
                        channel.port1.postMessage({
                            id,
                            ok: false,
                            error: getErrorMessage(error),
                        });
                    });
                };
                transfer.push(channel.port2);
            }
            await call<null>({
                type: 'open',
                initBytes,
                hasComponents,
            }, transfer);
        },
        getComponentDirectory: () => call<IDjvuComponentDirectory | null>({ type: 'getComponentDirectory' }),
        getDocInfo: () => call<IDjvuDocInfo>({ type: 'getDocInfo' }),
        getPageInfo: (pageNumber: number) => call<IDjvuPageInfo>({
            type: 'getPageInfo',
            pageNumber,
        }),
        getPageLayerSummary: (pageNumber: number, defaultForegroundSubsample?: number) => call<IDjvuPageLayerSummary>({
            type: 'getPageLayerSummary',
            pageNumber,
            ...(defaultForegroundSubsample === undefined ? {} : { defaultForegroundSubsample }),
        }),
        renderPage: (pageNumber: number, options?: IDjvuRenderPageOptions) => call<IDjvuRenderedPage>({
            type: 'renderPage',
            pageNumber,
            ...(options ? { options } : {}),
        }),
        renderMaskPbm: (pageNumber: number) => call<Uint8Array | null>({
            type: 'renderMaskPbm',
            pageNumber,
        }),
        renderBackgroundRgb: (pageNumber: number) => call<{
            width: number;
            height: number;
            rgb: Uint8Array;
        } | null>({
            type: 'renderBackgroundRgb',
            pageNumber,
        }),
        renderPagePpm: (pageNumber: number, options?: Omit<IDjvuRenderPageOptions, 'pixelFormat'>) => call<{
            width: number;
            height: number;
            ppm: Uint8Array;
        } | null>({
            type: 'renderPagePpm',
            pageNumber,
            ...(options ? { options } : {}),
        }),
        getOutline: () => call<IDjvuOutlineRawItem[]>({ type: 'getOutline' }),
        getPageNumberByUrl: (url: string) => call<number | null>({
            type: 'getPageNumberByUrl',
            url,
        }),
        getPageText: (pageNumber: number, options?: { includeZones?: boolean }) => call<IDjvuPageTextRaw>({
            type: 'getPageText',
            pageNumber,
            ...(options?.includeZones === undefined ? {} : { includeZones: options.includeZones }),
        }),
        pageHasText: (pageNumber: number) => call<boolean>({
            type: 'pageHasText',
            pageNumber,
        }),
        getMetadata: () => call<Record<string, string>>({ type: 'getMetadata' }),
        clearCache: () => call<void>({ type: 'clearCache' }),
        terminate,
    };
}
