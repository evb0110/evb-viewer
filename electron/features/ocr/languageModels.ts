import { homedir } from 'os';
import {
    createHash,
    randomUUID,
} from 'node:crypto';
import {
    compact,
    uniq,
} from 'es-toolkit/array';
import {
    createReadStream,
    createWriteStream,
    existsSync,
    openSync,
    readSync,
    closeSync,
    statSync,
} from 'fs';
import {
    copyFile,
    mkdir,
    readdir,
    rename,
    rm,
    writeFile,
} from 'fs/promises';
import {
    dirname,
    join,
} from 'path';
import { Readable } from 'stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { pipeline } from 'stream/promises';
import { fileURLToPath } from 'url';
import type { App } from 'electron';
import * as electron from 'electron';
import {
    abortErrorFromSignal,
    createAbortError,
    isAbortError,
} from '@electron/utils/abort';
import { createLogger } from '@electron/utils/createLogger';
import { forEachConcurrent } from '@electron/utils/concurrency';
import { measureElectronPerfAsync } from '@electron/utils/measureElectronPerfAsync';
import { AVAILABLE_OCR_LANGUAGE_CODES } from '@electron/features/ocr/availableLanguages';
import { getErrorMessage } from '@electron/utils/error';
import { parseIntegerEnv } from '@electron/utils/parseIntegerEnv';
import { getOcrRuntimePolicy } from '@electron/features/ocr/main/ocrRuntimePolicy';
import { resolveOcrResourcesBase } from '@electron/features/ocr/main/resolveOcrResourcesBase';
import { OCR_LANGUAGE_MODEL_SHA256 } from '@contracts/ocrLanguages';

const log = createLogger('ocr-languageModels');
export const TESSDATA_BEST_REF = 'e12c65a915945e4c28e237a9b52bc4a8f39a0cec';
const DOWNLOAD_BASE_URL = `https://raw.githubusercontent.com/tesseract-ocr/tessdata_best/${TESSDATA_BEST_REF}`;
const DOWNLOAD_TIMEOUT_MS = 90_000;
const DOWNLOAD_RETRIES = 3;
const RETRY_DELAY_MS = 1_500;
const PRECHECK_TIMEOUT_MS = 4_000;
const MIN_TRAINEDDATA_BYTES = 1024;
const TESSDATA_SEED_MARKER_PREFIX = '.evb-seeded-';
const NON_RETRYABLE_HTTP_STATUSES = new Set([
    400,
    401,
    403,
    404,
    410,
]);
const NETWORK_UNREACHABLE_CODES = new Set([
    'ENETUNREACH',
    'EHOSTUNREACH',
    'ENETDOWN',
    'ENETRESET',
    'ECONNREFUSED',
    'ECONNRESET',
    'ECONNABORTED',
    'ENOTFOUND',
    'EAI_AGAIN',
    'ETIMEDOUT',
    'ERR_NETWORK_CHANGED',
]);

interface IEnsureTessdataLanguagesOptions {signal?: AbortSignal;}
interface ISharedDownloadTask {
    promise: Promise<void>;
    controller: AbortController;
    waiterIds: Set<symbol>;
}

interface IVerifiedModel {
    identity: string;
    sha256: string;
}

const inFlightDownloads = new Map<string, ISharedDownloadTask>();
const globalDownloadWaiters: Array<{
    resolve: (release: () => void) => void;
    reject: (error: unknown) => void;
    signal?: AbortSignal;
    abortHandler?: () => void;
}> = [];
const __dirname = dirname(fileURLToPath(import.meta.url));
const OCR_MAX_UNIQUE_MODEL_CODES = parseIntegerEnv(
    'EVB_OCR_MAX_UNIQUE_LANGUAGES_PER_JOB',
    AVAILABLE_OCR_LANGUAGE_CODES.size,
    1,
    AVAILABLE_OCR_LANGUAGE_CODES.size,
);

let runtimeTessdataSeedPromise: Promise<void> | null = null;
let activeModelDownloads = 0;
const verifiedModels = new Map<string, IVerifiedModel>();

function getElectronApp(): Pick<App, 'isPackaged' | 'getPath'> | undefined {
    return (electron as {app?: Pick<App, 'isPackaged' | 'getPath'>}).app;
}

function isElectronAppPackaged() {
    return getElectronApp()?.isPackaged === true;
}

function getElectronUserDataPath() {
    try {
        const userDataPath = getElectronApp()?.getPath('userData').trim();
        if (userDataPath) {
            return userDataPath;
        }
    } catch {
        // Fall back to Electron's conventional userData location if app paths
        // are unavailable during early tests or startup recovery.
    }

    const appName = 'EVB Viewer';
    if (process.platform === 'win32') {
        return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), appName);
    }
    if (process.platform === 'darwin') {
        return join(homedir(), 'Library', 'Application Support', appName);
    }
    return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), appName);
}

function normalizeLanguageCodes(languageCodes: string[]): string[] {
    return uniq(compact(languageCodes
        .map(languageCode => languageCode.trim().toLowerCase())));
}

function isOcrLanguageModelCode(value: string): value is keyof typeof OCR_LANGUAGE_MODEL_SHA256 {
    return Object.hasOwn(OCR_LANGUAGE_MODEL_SHA256, value);
}

class LanguageModelDownloadError extends Error {
    readonly retryable: boolean;
    readonly code: string;

    constructor(
        message: string,
        options: {
            retryable: boolean;
            code: string;
        },
    ) {
        super(message);
        this.name = 'LanguageModelDownloadError';
        this.retryable = options.retryable;
        this.code = options.code;
    }
}

class DownloadTimeoutError extends Error {
    constructor(timeoutMs: number) {
        super(`Timed out after ${timeoutMs}ms`);
        this.name = 'TimeoutError';
    }
}

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) {
        throw abortErrorFromSignal(signal);
    }
}

function getErrorCode(error: unknown) {
    const visited = new Set<unknown>();
    let current: unknown = error;

    while (current && typeof current === 'object' && !visited.has(current)) {
        visited.add(current);
        const code = (current as { code?: unknown }).code;
        if (typeof code === 'string' && code.length > 0) {
            return code;
        }
        current = (current as { cause?: unknown }).cause;
    }

    return null;
}

function isTimeoutError(error: unknown) {
    return error instanceof Error && error.name === 'TimeoutError';
}

function createTimedAbortSignal(
    timeoutMs: number,
    signal?: AbortSignal,
) {
    const controller = new AbortController();
    const onAbort = () => {
        if (controller.signal.aborted) {
            return;
        }
        controller.abort(signal ? abortErrorFromSignal(signal) : createAbortError());
    };

    if (signal) {
        if (signal.aborted) {
            onAbort();
        } else {
            signal.addEventListener('abort', onAbort, { once: true });
        }
    }

    const timeoutHandle = setTimeout(() => {
        if (!controller.signal.aborted) {
            controller.abort(new DownloadTimeoutError(timeoutMs));
        }
    }, timeoutMs);
    timeoutHandle.unref();

    return {
        signal: controller.signal,
        cleanup: () => {
            clearTimeout(timeoutHandle);
            if (signal) {
                signal.removeEventListener('abort', onAbort);
            }
        },
    };
}

async function delayWithAbort(
    delayMs: number,
    signal?: AbortSignal,
) {
    throwIfAborted(signal);
    await new Promise<void>((resolve, reject) => {
        const timeoutHandle = setTimeout(() => {
            cleanup();
            resolve();
        }, delayMs);
        timeoutHandle.unref();

        const onAbort = () => {
            cleanup();
            reject(signal ? abortErrorFromSignal(signal) : createAbortError());
        };

        const cleanup = () => {
            clearTimeout(timeoutHandle);
            signal?.removeEventListener('abort', onAbort);
        };

        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

async function waitForPromiseOrAbort<T>(
    promise: Promise<T>,
    signal?: AbortSignal,
) {
    throwIfAborted(signal);

    if (!signal) {
        return promise;
    }

    return new Promise<T>((resolve, reject) => {
        const onAbort = () => {
            cleanup();
            reject(abortErrorFromSignal(signal));
        };

        const cleanup = () => {
            signal.removeEventListener('abort', onAbort);
        };

        signal.addEventListener('abort', onAbort, { once: true });
        promise.then((value) => {
            cleanup();
            resolve(value);
        }, (error) => {
            cleanup();
            reject(error);
        });
    });
}

function createHttpDownloadError(languageCode: string, statusCode: number) {
    if (statusCode === 404) {
        return new LanguageModelDownloadError(
            `OCR language model "${languageCode}" is unavailable (HTTP 404). Verify language configuration and try again.`,
            {
                retryable: false,
                code: `HTTP_${statusCode}`,
            },
        );
    }

    if (NON_RETRYABLE_HTTP_STATUSES.has(statusCode)) {
        return new LanguageModelDownloadError(
            `OCR language model "${languageCode}" download rejected by server (HTTP ${statusCode}).`,
            {
                retryable: false,
                code: `HTTP_${statusCode}`,
            },
        );
    }

    return new LanguageModelDownloadError(
        `OCR language model "${languageCode}" download failed with HTTP ${statusCode}.`,
        {
            retryable: true,
            code: `HTTP_${statusCode}`,
        },
    );
}

function classifyDownloadError(languageCode: string, error: unknown, timeoutMs = DOWNLOAD_TIMEOUT_MS) {
    if (error instanceof LanguageModelDownloadError) {
        return error;
    }

    if (isTimeoutError(error)) {
        return new LanguageModelDownloadError(
            `OCR language model "${languageCode}" download timed out after ${timeoutMs}ms.`,
            {
                retryable: true,
                code: 'DOWNLOAD_TIMEOUT',
            },
        );
    }

    if (isAbortError(error)) {
        return new LanguageModelDownloadError(
            `OCR language model "${languageCode}" download was canceled.`,
            {
                retryable: false,
                code: 'DOWNLOAD_ABORTED',
            },
        );
    }

    const errorCode = getErrorCode(error);
    if (errorCode && NETWORK_UNREACHABLE_CODES.has(errorCode)) {
        return new LanguageModelDownloadError(
            `Network is offline or unreachable (${errorCode}) while downloading OCR model "${languageCode}". Check connection and retry OCR.`,
            {
                retryable: true,
                code: 'NETWORK_UNREACHABLE',
            },
        );
    }

    const message = getErrorMessage(error);
    const normalizedMessage = message.toLowerCase();
    if (
        normalizedMessage.includes('network is unreachable')
        || normalizedMessage.includes('failed to resolve')
        || normalizedMessage.includes('getaddrinfo')
        || normalizedMessage.includes('not known')
    ) {
        return new LanguageModelDownloadError(
            `Network is offline or DNS is unreachable while downloading OCR model "${languageCode}".`,
            {
                retryable: true,
                code: 'NETWORK_UNREACHABLE',
            },
        );
    }

    return new LanguageModelDownloadError(
        `OCR model "${languageCode}" download failed: ${message}`,
        {
            retryable: true,
            code: 'DOWNLOAD_FAILED',
        },
    );
}

function getBundledTessdataDir() {
    return join(resolveOcrResourcesBase(__dirname, isElectronAppPackaged()), 'tesseract', 'tessdata');
}

export function getRuntimeTessdataDir() {
    if (isElectronAppPackaged()) {
        return join(getElectronUserDataPath(), 'tessdata');
    }

    return getBundledTessdataDir();
}

function getModelPath(baseDir: string, languageCode: string) {
    return join(baseDir, `${languageCode}.traineddata`);
}

function getFileIdentity(path: string) {
    try {
        const stats = statSync(path);
        if (!stats.isFile()) {
            return null;
        }
        return [
            stats.dev,
            stats.ino,
            stats.size,
            stats.mtimeMs,
            stats.ctimeMs,
        ].join(':');
    } catch {
        return null;
    }
}

export function validateTraineddataFile(path: string): {
    valid: boolean;
    error?: string;
} {
    if (!existsSync(path)) {
        return {
            valid: false,
            error: `Missing traineddata file: ${path}`,
        };
    }

    const stats = statSync(path);
    if (!stats.isFile()) {
        return {
            valid: false,
            error: `Traineddata path is not a file: ${path}`,
        };
    }
    if (stats.size < MIN_TRAINEDDATA_BYTES) {
        return {
            valid: false,
            error: `Traineddata file is unexpectedly small: ${path}`,
        };
    }

    const header = Buffer.alloc(4 + (128 * 8));
    let fd: number | null = null;
    try {
        fd = openSync(path, 'r');
        const bytesRead = readSync(fd, header, 0, header.length, 0);
        if (bytesRead < 12) {
            return {
                valid: false,
                error: `Traineddata header is truncated: ${path}`,
            };
        }

        const entryCount = header.readUInt32LE(0);
        if (entryCount === 0 || entryCount > 128) {
            return {
                valid: false,
                error: `Traineddata header has invalid entry count ${entryCount}: ${path}`,
            };
        }

        const expectedHeaderBytes = 4 + (entryCount * 8);
        if (stats.size <= expectedHeaderBytes || bytesRead < expectedHeaderBytes) {
            return {
                valid: false,
                error: `Traineddata offset table is truncated: ${path}`,
            };
        }

        let readableOffsetCount = 0;
        for (let index = 0; index < entryCount; index++) {
            const offset = header.readBigInt64LE(4 + (index * 8));
            if (offset === -1n) {
                continue;
            }
            if (offset < BigInt(expectedHeaderBytes) || offset >= BigInt(stats.size)) {
                return {
                    valid: false,
                    error: `Traineddata header has out-of-range component offset ${offset.toString()}: ${path}`,
                };
            }
            readableOffsetCount++;
        }

        if (readableOffsetCount === 0) {
            return {
                valid: false,
                error: `Traineddata header has no readable components: ${path}`,
            };
        }

        return { valid: true };
    } catch (error) {
        return {
            valid: false,
            error: `Unable to read traineddata file ${path}: ${getErrorMessage(error)}`,
        };
    } finally {
        if (fd !== null) {
            closeSync(fd);
        }
    }
}

async function removeInvalidModelIfPresent(languageCode: string, modelPath: string) {
    return verifyInstalledLanguageModel(languageCode, modelPath);
}

async function verifyInstalledLanguageModel(
    languageCode: string,
    modelPath: string,
    signal?: AbortSignal,
) {
    throwIfAborted(signal);
    const validation = validateTraineddataFile(modelPath);
    if (!validation.valid || !isOcrLanguageModelCode(languageCode)) {
        verifiedModels.delete(modelPath);
        return false;
    }

    const identityBeforeHash = getFileIdentity(modelPath);
    const cached = identityBeforeHash ? verifiedModels.get(modelPath) : undefined;
    if (cached?.identity === identityBeforeHash && cached.sha256 === OCR_LANGUAGE_MODEL_SHA256[languageCode]) {
        return true;
    }

    const actualSha256 = await hashFileSha256(modelPath, signal);
    const identityAfterHash = getFileIdentity(modelPath);
    if (
        actualSha256 !== OCR_LANGUAGE_MODEL_SHA256[languageCode]
        || identityBeforeHash === null
        || identityBeforeHash !== identityAfterHash
    ) {
        verifiedModels.delete(modelPath);
        return false;
    }

    verifiedModels.set(modelPath, {
        identity: identityAfterHash,
        sha256: actualSha256,
    });
    return true;
}

async function publishVerifiedModel(
    languageCode: string,
    sourcePath: string,
    destinationPath: string,
    temporaryPath: string,
    signal?: AbortSignal,
) {
    await copyFile(sourcePath, temporaryPath);
    throwIfAborted(signal);
    if (!await verifyInstalledLanguageModel(languageCode, temporaryPath, signal)) {
        throw new Error(`OCR language model "${languageCode}" failed SHA-256 verification before publication`);
    }
    await rename(temporaryPath, destinationPath);
    verifiedModels.delete(destinationPath);
    if (!await verifyInstalledLanguageModel(languageCode, destinationPath, signal)) {
        throw new Error(`OCR language model "${languageCode}" failed SHA-256 verification after publication`);
    }
}

async function seedBundledModels(
    runtimeDir: string,
) {
    if (!isElectronAppPackaged()) {
        return;
    }

    const bundledDir = getBundledTessdataDir();
    if (!existsSync(bundledDir)) {
        return;
    }

    await mkdir(runtimeDir, { recursive: true });
    const bundledFiles = (await readdir(bundledDir))
        .filter(fileName => fileName.endsWith('.traineddata'))
        .sort();
    const bundledRegistryFingerprint = createHash('sha256')
        .update(JSON.stringify({
            ref: TESSDATA_BEST_REF,
            bundledFiles,
        }))
        .digest('hex')
        .slice(0, 16);
    const seedMarkerPath = join(
        runtimeDir,
        `${TESSDATA_SEED_MARKER_PREFIX}${TESSDATA_BEST_REF}-${bundledRegistryFingerprint}`,
    );
    for (const fileName of bundledFiles) {
        const languageCode = fileName.slice(0, -'.traineddata'.length);
        if (!isOcrLanguageModelCode(languageCode)) {
            log.warn(`Skipping unsupported bundled OCR language model ${fileName}`);
            continue;
        }
        const sourcePath = join(bundledDir, fileName);
        const destinationPath = join(runtimeDir, fileName);
        if (!await verifyInstalledLanguageModel(languageCode, sourcePath)) {
            log.warn(`Skipping invalid bundled OCR language model ${fileName}`);
            continue;
        }
        if (await verifyInstalledLanguageModel(languageCode, destinationPath)) {
            continue;
        }
        const stagingPath = `${destinationPath}.seed-${randomUUID()}`;
        try {
            await publishVerifiedModel(languageCode, sourcePath, destinationPath, stagingPath);
        } finally {
            await rm(stagingPath, { force: true }).catch(() => {});
        }
    }
    if (existsSync(seedMarkerPath)) {
        return;
    }
    const pendingSeedMarkerPath = `${seedMarkerPath}.${randomUUID()}.tmp`;
    await writeFile(pendingSeedMarkerPath, JSON.stringify({
        ref: TESSDATA_BEST_REF,
        registryFingerprint: bundledRegistryFingerprint,
        bundledFiles,
    }), {
        encoding: 'utf8',
        mode: 0o600,
    });
    await rename(pendingSeedMarkerPath, seedMarkerPath);
}

export async function ensureRuntimeTessdataSeeded(
    options: IEnsureTessdataLanguagesOptions = {},
) {
    if (!isElectronAppPackaged()) {
        return;
    }

    const runtimeDir = getRuntimeTessdataDir();
    if (runtimeTessdataSeedPromise) {
        throwIfAborted(options.signal);
        await waitForPromiseOrAbort(runtimeTessdataSeedPromise, options.signal);
        return;
    }

    if (options.signal?.aborted) {
        throw abortErrorFromSignal(options.signal);
    }

    const seedPromise = measureElectronPerfAsync('ocr:seed-runtime-tessdata', () => seedBundledModels(runtimeDir), {
        thresholdMs: 25,
        details: { runtimeDir },
    });
    runtimeTessdataSeedPromise = seedPromise;
    try {
        await waitForPromiseOrAbort(seedPromise, options.signal);
    } catch (error) {
        if (runtimeTessdataSeedPromise === seedPromise) {
            runtimeTessdataSeedPromise = null;
        }
        throw error;
    }
}

async function precheckLanguageDownload(
    languageCode: string,
    languageUrl: string,
    options: IEnsureTessdataLanguagesOptions = {},
) {
    throwIfAborted(options.signal);
    const timedSignal = createTimedAbortSignal(PRECHECK_TIMEOUT_MS, options.signal);
    try {
        const response = await fetch(languageUrl, {
            method: 'HEAD',
            signal: timedSignal.signal,
        });
        throwIfAborted(options.signal);

        if (!response.ok) {
            throw createHttpDownloadError(languageCode, response.status);
        }
    } catch (error) {
        if (options.signal?.aborted) {
            throw abortErrorFromSignal(options.signal);
        }

        const classified = classifyDownloadError(
            languageCode,
            timedSignal.signal.aborted ? timedSignal.signal.reason : error,
            PRECHECK_TIMEOUT_MS,
        );
        if (!classified.retryable) {
            throw classified;
        }

        log.warn(
            `Skipping OCR model precheck strictness for ${languageCode}: ${classified.message}. Continuing with download attempts.`,
        );
    } finally {
        timedSignal.cleanup();
    }
}

async function writeDownloadResponseBody(
    response: Response,
    tempPath: string,
    signal?: AbortSignal,
) {
    if (response.body && typeof Readable.fromWeb === 'function') {
        const readable = Readable.fromWeb(response.body as NodeReadableStream);
        const writable = createWriteStream(tempPath, { flags: 'wx' });
        await pipeline(readable, writable, { signal });
        return;
    }

    // Fallback for environments where Readable.fromWeb is unavailable.
    if (signal?.aborted) {
        throw signal.reason ?? createAbortError();
    }
    const arrayBuffer = await response.arrayBuffer();
    if (signal?.aborted) {
        throw signal.reason ?? createAbortError();
    }
    await writeFile(tempPath, Buffer.from(arrayBuffer), { signal });
}

export async function hashFileSha256(
    path: string,
    signal?: AbortSignal,
) {
    throwIfAborted(signal);
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    const onAbort = () => {
        if (signal) {
            stream.destroy(abortErrorFromSignal(signal));
        }
    };

    signal?.addEventListener('abort', onAbort, { once: true });
    try {
        for await (const rawChunk of stream) {
            const chunk: unknown = rawChunk;
            if (!(chunk instanceof Uint8Array)) {
                throw new Error(`OCR model stream returned a non-binary chunk: ${path}`);
            }
            hash.update(chunk);
        }
        throwIfAborted(signal);
        return hash.digest('hex');
    } finally {
        signal?.removeEventListener('abort', onAbort);
    }
}

async function downloadLanguageModelAttempt(
    languageCode: string,
    languageUrl: string,
    runtimeDir: string,
    modelPath: string,
    tempPath: string,
    attempt: number,
    signal?: AbortSignal,
) {
    throwIfAborted(signal);
    const timedSignal = createTimedAbortSignal(DOWNLOAD_TIMEOUT_MS, signal);
    try {
        log.info(`Downloading OCR model ${languageCode} (attempt ${attempt}/${DOWNLOAD_RETRIES})`);
        const response = await fetch(languageUrl, {
            method: 'GET',
            signal: timedSignal.signal,
        });
        throwIfAborted(signal);

        if (!response.ok) {
            throw createHttpDownloadError(languageCode, response.status);
        }

        await mkdir(runtimeDir, { recursive: true });
        await writeDownloadResponseBody(response, tempPath, timedSignal.signal);
        throwIfAborted(signal);

        const validation = validateTraineddataFile(tempPath);
        if (!validation.valid) {
            throw new Error(validation.error ?? 'Downloaded model is not a readable traineddata file');
        }
        if (!isOcrLanguageModelCode(languageCode)) {
            throw new LanguageModelDownloadError(
                `OCR language model "${languageCode}" failed SHA-256 verification.`,
                {
                    retryable: false,
                    code: 'CHECKSUM_MISMATCH',
                },
            );
        }
        const expectedSha256 = OCR_LANGUAGE_MODEL_SHA256[languageCode];
        const actualSha256 = await hashFileSha256(tempPath, timedSignal.signal);
        if (actualSha256 !== expectedSha256) {
            throw new LanguageModelDownloadError(
                `OCR language model "${languageCode}" failed SHA-256 verification.`,
                {
                    retryable: false,
                    code: 'CHECKSUM_MISMATCH',
                },
            );
        }
        const downloadedSize = statSync(tempPath).size;
        await rename(tempPath, modelPath);
        verifiedModels.delete(modelPath);
        if (!await verifyInstalledLanguageModel(languageCode, modelPath, signal)) {
            throw new LanguageModelDownloadError(
                `OCR language model "${languageCode}" failed SHA-256 verification after publication.`,
                {
                    retryable: false,
                    code: 'CHECKSUM_MISMATCH',
                },
            );
        }
        return downloadedSize;
    } catch (err) {
        if (signal?.aborted) {
            throw abortErrorFromSignal(signal);
        }
        throw classifyDownloadError(
            languageCode,
            timedSignal.signal.aborted ? timedSignal.signal.reason : err,
        );
    } finally {
        timedSignal.cleanup();
        await rm(tempPath, { force: true }).catch(() => {});
    }
}

async function waitBeforeDownloadRetry(
    languageCode: string,
    attempt: number,
    error: LanguageModelDownloadError,
    signal?: AbortSignal,
) {
    if (!error.retryable) {
        throw error;
    }

    if (attempt >= DOWNLOAD_RETRIES) {
        throw new LanguageModelDownloadError(
            `Failed to download OCR language model "${languageCode}" after ${DOWNLOAD_RETRIES} attempts: ${error.message}`,
            {
                retryable: true,
                code: error.code,
            },
        );
    }

    log.warn(`Download retry scheduled for OCR model ${languageCode}: ${error.message}`);
    await delayWithAbort(RETRY_DELAY_MS * attempt, signal);
}

async function downloadLanguageModel(
    languageCode: string,
    runtimeDir: string,
    options: IEnsureTessdataLanguagesOptions = {},
) {
    const modelPath = getModelPath(runtimeDir, languageCode);
    if (await removeInvalidModelIfPresent(languageCode, modelPath)) {
        return;
    }

    const languageUrl = `${DOWNLOAD_BASE_URL}/${encodeURIComponent(languageCode)}.traineddata`;
    const tempPath = `${modelPath}.download-${randomUUID()}`;
    await precheckLanguageDownload(languageCode, languageUrl, options);

    for (let attempt = 1; attempt <= DOWNLOAD_RETRIES; attempt++) {
        try {
            const downloadedSize = await downloadLanguageModelAttempt(
                languageCode,
                languageUrl,
                runtimeDir,
                modelPath,
                tempPath,
                attempt,
                options.signal,
            );
            log.info(`Downloaded OCR model ${languageCode} (${Math.round(downloadedSize / (1024 * 1024))}MB)`);
            return;
        } catch (err) {
            if (options.signal?.aborted) {
                throw abortErrorFromSignal(options.signal);
            }
            await waitBeforeDownloadRetry(
                languageCode,
                attempt,
                classifyDownloadError(languageCode, err),
                options.signal,
            );
        }
    }
}

async function restoreBundledLanguageModel(
    languageCode: string,
    runtimeDir: string,
    options: IEnsureTessdataLanguagesOptions = {},
) {
    if (!isElectronAppPackaged()) {
        return false;
    }

    const bundledPath = getModelPath(getBundledTessdataDir(), languageCode);
    if (!await verifyInstalledLanguageModel(languageCode, bundledPath, options.signal)) {
        log.warn(`Bundled OCR language model ${languageCode} is unavailable for offline restore`);
        return false;
    }

    const modelPath = getModelPath(runtimeDir, languageCode);
    const stagingPath = `${modelPath}.restore-${randomUUID()}`;
    try {
        throwIfAborted(options.signal);
        await mkdir(runtimeDir, {recursive: true});
        await publishVerifiedModel(languageCode, bundledPath, modelPath, stagingPath, options.signal);
        log.info(`Restored OCR language model ${languageCode} from the packaged bundle`);
        return true;
    } catch (error) {
        if (options.signal?.aborted) {
            throw abortErrorFromSignal(options.signal);
        }
        log.warn(`Could not restore bundled OCR language model ${languageCode}: ${getErrorMessage(error)}`);
        return false;
    } finally {
        await rm(stagingPath, {force: true}).catch(() => {});
    }
}

function releaseDownloadWaiter(
    languageCode: string,
    waiterId: symbol,
    task: ISharedDownloadTask,
) {
    task.waiterIds.delete(waiterId);
    if (
        task.waiterIds.size === 0
        && inFlightDownloads.get(languageCode) === task
        && !task.controller.signal.aborted
    ) {
        task.controller.abort(createAbortError(`OCR language model "${languageCode}" download was canceled`));
    }
}

async function ensureLanguageModel(
    languageCode: string,
    runtimeDir: string,
    options: IEnsureTessdataLanguagesOptions = {},
) {
    throwIfAborted(options.signal);
    const waiterId = Symbol(languageCode);
    const pending = inFlightDownloads.get(languageCode);
    if (pending) {
        pending.waiterIds.add(waiterId);
        try {
            await waitForPromiseOrAbort(pending.promise, options.signal);
        } finally {
            releaseDownloadWaiter(languageCode, waiterId, pending);
        }
        return;
    }

    const task: ISharedDownloadTask = {
        controller: new AbortController(),
        waiterIds: new Set([waiterId]),
        promise: Promise.resolve(),
    };
    task.promise = (async () => {
        let releaseSlot: (() => void) | null = null;
        try {
            const modelPath = getModelPath(runtimeDir, languageCode);
            if (await verifyInstalledLanguageModel(languageCode, modelPath, task.controller.signal)) {
                return;
            }
            const restored = await restoreBundledLanguageModel(languageCode, runtimeDir, {signal: task.controller.signal});
            if (!restored && !await verifyInstalledLanguageModel(languageCode, modelPath, task.controller.signal)) {
                releaseSlot = await acquireGlobalModelDownloadSlot(task.controller.signal);
                await downloadLanguageModel(languageCode, runtimeDir, {signal: task.controller.signal});
            }
        } finally {
            releaseSlot?.();
            if (inFlightDownloads.get(languageCode) === task) {
                inFlightDownloads.delete(languageCode);
            }
        }
    })();

    inFlightDownloads.set(languageCode, task);
    try {
        await waitForPromiseOrAbort(task.promise, options.signal);
    } finally {
        releaseDownloadWaiter(languageCode, waiterId, task);
    }
}

function getModelDownloadConcurrency() {
    return getOcrRuntimePolicy().modelDownloadConcurrency;
}

function activateNextGlobalDownloadWaiter() {
    while (
        globalDownloadWaiters.length > 0
        && activeModelDownloads < getModelDownloadConcurrency()
    ) {
        const next = globalDownloadWaiters.shift();
        if (!next) {
            continue;
        }
        if (next.signal?.aborted) {
            next.reject(abortErrorFromSignal(next.signal));
            continue;
        }
        if (next.signal && next.abortHandler) {
            next.signal.removeEventListener('abort', next.abortHandler);
        }
        activeModelDownloads++;
        next.resolve(releaseGlobalModelDownloadSlot);
        return;
    }
}

function releaseGlobalModelDownloadSlot() {
    activeModelDownloads = Math.max(0, activeModelDownloads - 1);
    activateNextGlobalDownloadWaiter();
}

function acquireGlobalModelDownloadSlot(signal?: AbortSignal): Promise<() => void> {
    throwIfAborted(signal);
    if (activeModelDownloads < getModelDownloadConcurrency()) {
        activeModelDownloads++;
        return Promise.resolve(releaseGlobalModelDownloadSlot);
    }

    return new Promise((resolve, reject) => {
        const waiter: {
            resolve: (release: () => void) => void;
            reject: (error: unknown) => void;
            signal?: AbortSignal;
            abortHandler?: () => void;
        } = {
            resolve,
            reject,
        };

        if (signal) {
            waiter.signal = signal;
            waiter.abortHandler = () => {
                const index = globalDownloadWaiters.indexOf(waiter);
                if (index >= 0) {
                    globalDownloadWaiters.splice(index, 1);
                }
                reject(abortErrorFromSignal(signal));
            };
            signal.addEventListener('abort', waiter.abortHandler, { once: true });
        }

        globalDownloadWaiters.push(waiter);
    });
}

export async function ensureTessdataLanguages(
    languageCodes: string[],
    options: IEnsureTessdataLanguagesOptions = {},
) {
    const requiredCodes = normalizeLanguageCodes(languageCodes);
    if (requiredCodes.length === 0) {
        return;
    }
    throwIfAborted(options.signal);
    if (requiredCodes.length > OCR_MAX_UNIQUE_MODEL_CODES) {
        throw new Error(`Too many OCR languages requested (${requiredCodes.length})`);
    }
    for (const languageCode of requiredCodes) {
        if (!AVAILABLE_OCR_LANGUAGE_CODES.has(languageCode)) {
            throw new Error(`Unsupported OCR language: ${languageCode}`);
        }
    }

    const runtimeDir = getRuntimeTessdataDir();
    await ensureRuntimeTessdataSeeded(options);
    // Bound parallel model downloads so OCR requests cannot flood network/disk resources.
    await forEachConcurrent(requiredCodes, getModelDownloadConcurrency(), async (languageCode) => {
        await ensureLanguageModel(languageCode, runtimeDir, options);
    });
}

export async function getOcrLanguageModelStates() {
    await ensureRuntimeTessdataSeeded();
    const runtimeDir = getRuntimeTessdataDir();
    return Promise.all(Array.from(AVAILABLE_OCR_LANGUAGE_CODES, async languageCode => ({
        code: languageCode,
        state: inFlightDownloads.has(languageCode)
            ? 'downloading' as const
            : await verifyInstalledLanguageModel(languageCode, getModelPath(runtimeDir, languageCode))
                ? 'installed' as const
                : 'missing' as const,
    })));
}
