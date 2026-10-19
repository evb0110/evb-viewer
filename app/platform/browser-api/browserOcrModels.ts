import {sha256Hex} from '@app/platform/browser/browserStagedArtifact';
import type {IOcrModelDownloadProgress} from '@contracts/electronApiOcr';
import {
    getOcrModelDownloadUrl,
    OCR_LANGUAGE_MODEL_BYTES,
    OCR_LANGUAGE_MODEL_SHA256,
    type TOcrModelCode,
} from '@contracts/ocrLanguages';

/**
 * The browser's OCR models: the pinned tessdata_best files desktop uses,
 * downloaded from GitHub once per browser profile and kept in Cache Storage,
 * which the page and the engine workers both read. Bytes are checked against
 * the registry's size and SHA-256 when they arrive and again when a worker
 * loads them.
 */

const MODEL_CACHE_NAME = 'evb-ocr-models-v1';
// As on desktop: an attempt fails after this long without headers or body
// bytes, however long a steady download takes in total.
const DOWNLOAD_STALL_TIMEOUT_MS = 90_000;
const DOWNLOAD_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1_500;
const NON_RETRYABLE_HTTP_STATUSES = new Set([
    400,
    401,
    403,
    404,
    410,
]);

type TProgressListener = (progress: IOcrModelDownloadProgress) => void;

interface ISharedDownload {
    promise: Promise<void>;
    controller: AbortController;
    listeners: Set<TProgressListener>;
    waiters: number;
    progress?: IOcrModelDownloadProgress;
}

const downloads = new Map<TOcrModelCode, ISharedDownload>();

export class BrowserOcrModelError extends Error {
    public constructor(message: string, public readonly retryable: boolean) {
        super(message);
        this.name = 'BrowserOcrModelError';
    }
}

function abortError(signal: AbortSignal) {
    return signal.reason instanceof Error ? signal.reason : new DOMException('OCR model download was canceled', 'AbortError');
}

async function isPinnedModel(code: TOcrModelCode, bytes: Uint8Array<ArrayBuffer>) {
    return bytes.byteLength === OCR_LANGUAGE_MODEL_BYTES[code]
        && await sha256Hex(bytes) === OCR_LANGUAGE_MODEL_SHA256[code];
}

export function canStoreBrowserOcrModels() {
    return typeof caches !== 'undefined' && typeof crypto?.subtle !== 'undefined';
}

/** Whether a model is in the cache; its bytes are verified when read. */
export async function hasCachedOcrModel(code: TOcrModelCode) {
    const cache = await caches.open(MODEL_CACHE_NAME);
    return (await cache.match(getOcrModelDownloadUrl(code))) !== undefined;
}

/** A cached model's verified bytes. A damaged entry is removed so the next run downloads it again. */
export async function readCachedOcrModel(code: TOcrModelCode) {
    const cache = await caches.open(MODEL_CACHE_NAME);
    const url = getOcrModelDownloadUrl(code);
    const response = await cache.match(url);
    if (!response) {
        throw new BrowserOcrModelError(`OCR model ${code} is not downloaded`, true);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!await isPinnedModel(code, bytes)) {
        await cache.delete(url);
        throw new BrowserOcrModelError(`The stored OCR model ${code} is damaged; it will be downloaded again`, true);
    }
    return bytes;
}

async function readBodyWithStallTimeout(
    response: Response,
    code: TOcrModelCode,
    attempt: number,
    signal: AbortSignal,
    report: TProgressListener,
) {
    const totalBytes = OCR_LANGUAGE_MODEL_BYTES[code];
    const reader = response.body?.getReader();
    if (!reader) {
        throw new BrowserOcrModelError(`OCR model ${code} download returned no body`, true);
    }
    const bytes = new Uint8Array(totalBytes);
    let receivedBytes = 0;
    for (;;) {
        let stallTimer: ReturnType<typeof setTimeout> | undefined;
        const stalled = new Promise<never>((_resolve, reject) => {
            stallTimer = setTimeout(() => reject(new BrowserOcrModelError(`OCR model ${code} download stalled`, true)), DOWNLOAD_STALL_TIMEOUT_MS);
        });
        try {
            const chunk = await Promise.race([
                reader.read(),
                stalled,
            ]);
            if (chunk.done) break;
            if (receivedBytes + chunk.value.byteLength > totalBytes) {
                throw new BrowserOcrModelError(`OCR model ${code} download is larger than the pinned model`, false);
            }
            bytes.set(chunk.value, receivedBytes);
            receivedBytes += chunk.value.byteLength;
            report({
                languageCode: code,
                receivedBytes,
                totalBytes,
                attempt,
                maxAttempts: DOWNLOAD_ATTEMPTS,
                retrying: false,
            });
        } catch (error) {
            await reader.cancel().catch(() => {});
            throw signal.aborted ? abortError(signal) : error;
        } finally {
            clearTimeout(stallTimer);
        }
    }
    if (receivedBytes !== totalBytes) {
        throw new BrowserOcrModelError(`OCR model ${code} download ended early`, true);
    }
    return bytes;
}

async function downloadAttempt(
    code: TOcrModelCode,
    attempt: number,
    signal: AbortSignal,
    report: TProgressListener,
) {
    const attemptController = new AbortController();
    const abortAttempt = () => attemptController.abort(signal.reason);
    signal.addEventListener('abort', abortAttempt, {once: true});
    const headerTimer = setTimeout(
        () => attemptController.abort(new BrowserOcrModelError(`OCR model ${code} download stalled`, true)),
        DOWNLOAD_STALL_TIMEOUT_MS,
    );
    try {
        const response = await fetch(getOcrModelDownloadUrl(code), {
            signal: attemptController.signal,
            cache: 'no-store',
            credentials: 'omit',
        });
        clearTimeout(headerTimer);
        if (!response.ok) {
            throw new BrowserOcrModelError(
                `OCR model ${code} download failed with HTTP ${response.status}`,
                !NON_RETRYABLE_HTTP_STATUSES.has(response.status),
            );
        }
        const bytes = await readBodyWithStallTimeout(response, code, attempt, attemptController.signal, report);
        if (!await isPinnedModel(code, bytes)) {
            throw new BrowserOcrModelError(`OCR model ${code} does not match its pinned SHA-256`, true);
        }
        return bytes;
    } catch (error) {
        if (signal.aborted) throw abortError(signal);
        if (attemptController.signal.reason instanceof BrowserOcrModelError) throw attemptController.signal.reason;
        throw error instanceof BrowserOcrModelError
            ? error
            : new BrowserOcrModelError(`OCR model ${code} download failed: ${error instanceof Error ? error.message : String(error)}`, true);
    } finally {
        clearTimeout(headerTimer);
        signal.removeEventListener('abort', abortAttempt);
    }
}

function waitBeforeRetry(signal: AbortSignal, attempt: number) {
    return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        }, RETRY_DELAY_MS * attempt);
        const onAbort = () => {
            clearTimeout(timer);
            reject(abortError(signal));
        };
        signal.addEventListener('abort', onAbort, {once: true});
    });
}

async function downloadAndStore(code: TOcrModelCode, signal: AbortSignal, report: TProgressListener) {
    // Another tab may be downloading the same model; take turns and reuse its result.
    const run = async () => {
        if (await hasCachedOcrModel(code)) return;
        for (let attempt = 1; ; attempt += 1) {
            try {
                const bytes = await downloadAttempt(code, attempt, signal, report);
                const cache = await caches.open(MODEL_CACHE_NAME);
                await cache.put(getOcrModelDownloadUrl(code), new Response(bytes, {headers: {'content-type': 'application/octet-stream'}}));
                return;
            } catch (error) {
                const retryable = error instanceof BrowserOcrModelError && error.retryable;
                if (signal.aborted || !retryable || attempt >= DOWNLOAD_ATTEMPTS) throw error;
                report({
                    languageCode: code,
                    receivedBytes: 0,
                    totalBytes: OCR_LANGUAGE_MODEL_BYTES[code],
                    attempt: attempt + 1,
                    maxAttempts: DOWNLOAD_ATTEMPTS,
                    retrying: true,
                });
                await waitBeforeRetry(signal, attempt);
            }
        }
    };
    if (typeof navigator !== 'undefined' && navigator.locks) {
        await navigator.locks.request(`evb-ocr-model:${code}`, {signal}, run);
    } else {
        await run();
    }
}

function waitOrAbort(promise: Promise<void>, signal: AbortSignal | undefined) {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(abortError(signal));
    return new Promise<void>((resolve, reject) => {
        const onAbort = () => reject(abortError(signal));
        signal.addEventListener('abort', onAbort, {once: true});
        promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    });
}

/**
 * Makes one model available. Concurrent callers share one download; a caller
 * that cancels stops waiting, and the download stops when no caller is left.
 */
export async function ensureBrowserOcrModel(
    code: TOcrModelCode,
    options: {
        signal?: AbortSignal;
        onProgress?: TProgressListener
    } = {},
) {
    options.signal?.throwIfAborted();
    let download = downloads.get(code);
    if (!download) {
        const controller = new AbortController();
        const listeners = new Set<TProgressListener>();
        const created: ISharedDownload = {
            controller,
            listeners,
            waiters: 0,
            promise: Promise.resolve(),
        };
        created.promise = downloadAndStore(code, controller.signal, (progress) => {
            created.progress = progress;
            for (const listener of listeners) listener(progress);
        }).finally(() => {
            if (downloads.get(code) === created) downloads.delete(code);
        });
        created.promise.catch(() => {});
        downloads.set(code, created);
        download = created;
    }
    const listener = options.onProgress;
    if (listener) {
        download.listeners.add(listener);
        if (download.progress) listener(download.progress);
    }
    download.waiters += 1;
    try {
        await waitOrAbort(download.promise, options.signal);
    } finally {
        download.waiters -= 1;
        if (listener) download.listeners.delete(listener);
        if (options.signal?.aborted && download.waiters === 0 && downloads.get(code) === download) {
            download.controller.abort(abortError(options.signal));
        }
    }
}
