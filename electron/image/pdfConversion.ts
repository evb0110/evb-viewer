import { existsSync } from 'fs';
import {stat} from 'fs/promises';
import {
    basename,
    dirname,
    extname,
    join,
} from 'path';
import { fileURLToPath } from 'url';
import {
    Worker,
    type ResourceLimits,
} from 'worker_threads';
import { createLogger } from '@electron/utils/createLogger';
import {isImagePath} from '@electron/image/pdfCombineShared';
import { getErrorMessage } from '@electron/utils/error';
import {
    isFiniteWorkerMessageNumber,
    isWorkerMessageRecord,
} from '@electron/utils/workerMessage';
import { WORKER_BUNDLES_BY_ID } from '@electron-worker-bundles/electronWorkerBundles.js';
import {
    tryCreatePdfFromInputPathsNative,
    tryWritePdfFromInputPathsNative,
} from '@electron/image/tryCreatePdfFromInputPathsNative';
import {PdfCombineCapabilityError} from '@electron/image/pdfCombineErrors';
import { parseIntegerEnv } from '@electron/utils/parseIntegerEnv';
import { abortErrorFromSignal } from '@electron/utils/abort';
import {
    createPdfCombineOutputTooLargeError,
    normalizePdfCombineOutputLimit,
    PDF_COMBINE_MAX_OUTPUT_BYTES,
} from '@contracts/pdfCombineOutputPolicy';

export interface ICreatePdfFromInputPathsProgress {
    processed: number;
    total: number;
    percent: number;
    elapsedMs: number;
    estimatedRemainingMs: number | null;
}

interface ICreatePdfFromInputPathsOptions {
    onProgress?: (progress: ICreatePdfFromInputPathsProgress) => void;
    signal?: AbortSignal;
}

interface ICombineInputResourceUsage {
    files: Array<{
        path: string;
        size: number;
    }>;
    totalBytes: number;
}

const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

function toSafeByteCount(value: number | bigint, inputPath: string) {
    if (typeof value === 'bigint') {
        if (value < 0n || value > MAX_SAFE_INTEGER_BIGINT) {
            throw new PdfCombineCapabilityError(
                'native-unavailable',
                `Input file size is outside the safe integer range: ${inputPath}`,
                {operation: 'pdf-combine'},
            );
        }
        return Number(value);
    }
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new PdfCombineCapabilityError(
            'native-unavailable',
            `Input file size is not a safe integer: ${inputPath}`,
            {operation: 'pdf-combine'},
        );
    }
    return value;
}

function addSafeByteCounts(total: number, next: number) {
    if (next > Number.MAX_SAFE_INTEGER - total) {
        throw new PdfCombineCapabilityError(
            'native-unavailable',
            'Combined input size is outside the safe integer range',
            {operation: 'pdf-combine'},
        );
    }
    return total + next;
}

type TCombineWorkerPayload =
    | {
        type: 'progress';
        processed: number;
        total: number;
        percent: number;
        elapsedMs: number;
        estimatedRemainingMs: number | null;
    }
    | {
        type: 'result';
        ok: true;
        data: unknown;
    }
    | {
        type: 'result';
        ok: false;
        error: string;
    };

const logger = createLogger('pdfConversion');
const __dirname = dirname(fileURLToPath(import.meta.url));
const COMBINE_WORKER_FILENAME = WORKER_BUNDLES_BY_ID['pdf-combine'].fileName;
const PDF_COMBINE_WORKER_TIMEOUT_MS = (() => {
    const parsed = Number.parseInt(process.env.EVB_PDF_COMBINE_WORKER_TIMEOUT_MS ?? `${5 * 60 * 1000}`, 10);
    if (!Number.isFinite(parsed) || parsed < 10_000) {
        return 5 * 60 * 1000;
    }
    return parsed;
})();
const PDF_COMBINE_WORKER_RESOURCE_LIMITS: ResourceLimits = {
    maxOldGenerationSizeMb: parseIntegerEnv('EVB_PDF_COMBINE_WORKER_MAX_OLD_MB', 512, 128, 2048),
    maxYoungGenerationSizeMb: parseIntegerEnv('EVB_PDF_COMBINE_WORKER_MAX_YOUNG_MB', 64, 16, 256),
    stackSizeMb: parseIntegerEnv('EVB_PDF_COMBINE_WORKER_STACK_MB', 8, 2, 64),
};
// These limits belong only to the small in-memory compatibility route. The
// path-backed route switches to the native file writer before it can consult
// them.
const PDF_COMBINE_SMALL_MEMORY_MAX_INPUT_BYTES = (() => {
    const parsed = Number.parseInt(process.env.EVB_PDF_COMBINE_MAX_INPUT_MB ?? '512', 10);
    if (!Number.isFinite(parsed) || parsed < 16) {
        return 512 * 1024 * 1024;
    }
    return parsed * 1024 * 1024;
})();
const PDF_COMBINE_SMALL_MEMORY_MAX_TOTAL_INPUT_BYTES = (() => {
    const parsed = Number.parseInt(process.env.EVB_PDF_COMBINE_MAX_TOTAL_INPUT_MB ?? '1024', 10);
    if (!Number.isFinite(parsed) || parsed < 16) {
        return 1024 * 1024 * 1024;
    }
    return parsed * 1024 * 1024;
})();
const PDF_COMBINE_LOCAL_FALLBACK_MAX_TOTAL_BYTES = (() => {
    const parsed = Number.parseInt(process.env.EVB_PDF_COMBINE_LOCAL_FALLBACK_MAX_TOTAL_MB ?? '16', 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
        return 16 * 1024 * 1024;
    }
    return Math.min(parsed, 256) * 1024 * 1024;
})();
const PDF_COMBINE_SMALL_MEMORY_MAX_OUTPUT_BYTES = (() => {
    const parsed = Number.parseInt(process.env.EVB_PDF_COMBINE_MAX_OUTPUT_MB ?? '16', 10);
    return normalizePdfCombineOutputLimit(
        (Number.isFinite(parsed) && parsed >= 1 ? parsed : PDF_COMBINE_MAX_OUTPUT_BYTES / (1024 * 1024))
            * 1024 * 1024,
    );
})();
const WORKER_SUPPORTED_IMAGE_EXTENSIONS = new Set<string>(
    [
        '.png',
        '.jpg',
        '.jpeg',
        '.tif',
        '.tiff',
        '.bmp',
        '.gif',
        '.webp',
    ],
);

class PdfCombineWorkerStartupError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'PdfCombineWorkerStartupError';
    }
}

function assertNever(value: never) {
    throw new Error(`Unhandled image combine worker payload: ${JSON.stringify(value)}`);
}

function parseCombineWorkerProgressPayload(
    message: Record<string, unknown>,
): TCombineWorkerPayload | null {
    if (
        !isFiniteWorkerMessageNumber(message.processed)
        || !isFiniteWorkerMessageNumber(message.total)
        || !isFiniteWorkerMessageNumber(message.percent)
        || !isFiniteWorkerMessageNumber(message.elapsedMs)
    ) {
        return null;
    }

    return {
        type: 'progress',
        processed: message.processed,
        total: message.total,
        percent: message.percent,
        elapsedMs: message.elapsedMs,
        estimatedRemainingMs: isFiniteWorkerMessageNumber(message.estimatedRemainingMs)
            ? message.estimatedRemainingMs
            : null,
    };
}

function parseCombineWorkerResultPayload(
    message: Record<string, unknown>,
): TCombineWorkerPayload | null {
    if (message.ok === true) {
        return {
            type: 'result',
            ok: true,
            data: message.data,
        };
    }

    if (message.ok === false && typeof message.error === 'string') {
        return {
            type: 'result',
            ok: false,
            error: message.error,
        };
    }

    return null;
}

function parseCombineWorkerPayload(message: unknown): TCombineWorkerPayload | null {
    if (!isWorkerMessageRecord(message) || typeof message.type !== 'string') {
        return null;
    }

    switch (message.type) {
        case 'progress':
            return parseCombineWorkerProgressPayload(message);
        case 'result':
            return parseCombineWorkerResultPayload(message);
        default:
            return null;
    }
}

export function isPdfPath(filePath: string) {
    return extname(filePath).toLowerCase() === '.pdf';
}

export function isDjvuPath(filePath: string) {
    const extension = extname(filePath).toLowerCase();
    return extension === '.djvu' || extension === '.djv';
}

export function isPdfOrImagePath(filePath: string) {
    return isPdfPath(filePath) || isImagePath(filePath);
}

export function isSupportedOpenPath(filePath: string) {
    return isPdfOrImagePath(filePath) || isDjvuPath(filePath);
}

export function buildCombinedPdfOutputPath(inputPaths: string[]) {
    if (inputPaths.length === 0) {
        return 'combined.pdf';
    }

    const firstPath = inputPaths[0];
    if (!firstPath) {
        return 'combined.pdf';
    }
    const dir = dirname(firstPath);
    const stem = basename(firstPath, extname(firstPath));
    const outputName =
        inputPaths.length === 1 ? `${stem}.pdf` : `combined-${Date.now()}.pdf`;

    return join(dir, outputName);
}

function canCombineInWorker(inputPaths: string[]) {
    return inputPaths.every((sourcePath) => {
        const extension = extname(sourcePath).toLowerCase();
        return (
            extension === '.pdf' || WORKER_SUPPORTED_IMAGE_EXTENSIONS.has(extension)
        );
    });
}

function getCombineWorkerPath() {
    const defaultPath = join(__dirname, COMBINE_WORKER_FILENAME);
    const unpackedPath = defaultPath.replace('app.asar', 'app.asar.unpacked');
    if (unpackedPath !== defaultPath && existsSync(unpackedPath)) {
        return unpackedPath;
    }

    return defaultPath;
}

function decodeWorkerPdfBytes(data: unknown): Uint8Array | null {
    if (data instanceof Uint8Array) {
        return data;
    }
    if (data instanceof ArrayBuffer) {
        return new Uint8Array(data);
    }
    if (ArrayBuffer.isView(data)) {
        return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    return null;
}

async function inspectInputResourceUsage(inputPaths: string[]): Promise<ICombineInputResourceUsage> {
    let totalBytes = 0;
    const files: ICombineInputResourceUsage['files'] = [];
    for (const inputPath of inputPaths) {
        const fileStat = await stat(inputPath, {bigint: true});
        if (!fileStat.isFile()) {
            throw new Error(`Input path is not a regular file: ${inputPath}`);
        }
        const size = toSafeByteCount(fileStat.size, inputPath);
        if (size <= 0) {
            throw new Error(`Input file is empty: ${inputPath}`);
        }
        files.push({
            path: inputPath,
            size,
        });
        totalBytes = addSafeByteCounts(totalBytes, size);
    }

    return {
        files,
        totalBytes,
    };
}

function isSmallMemoryCombine(resourceUsage: ICombineInputResourceUsage) {
    return resourceUsage.totalBytes <= PDF_COMBINE_LOCAL_FALLBACK_MAX_TOTAL_BYTES;
}

function assertMemoryCombineInputResourceLimits(resourceUsage: ICombineInputResourceUsage) {
    for (const file of resourceUsage.files) {
        if (file.size > PDF_COMBINE_SMALL_MEMORY_MAX_INPUT_BYTES) {
            throw new Error(`Input file is too large to combine safely: ${file.path}`);
        }
    }
    if (resourceUsage.totalBytes > PDF_COMBINE_SMALL_MEMORY_MAX_TOTAL_INPUT_BYTES) {
        throw new Error('Combined input files are too large to combine safely');
    }
    const estimatedMinimumOutputBytes = Math.ceil(resourceUsage.totalBytes * 1.25);
    if (estimatedMinimumOutputBytes > PDF_COMBINE_SMALL_MEMORY_MAX_OUTPUT_BYTES) {
        throw createPdfCombineOutputTooLargeError();
    }
}

function createPdfFromInputPathsWorker(
    inputPaths: string[],
    options?: ICreatePdfFromInputPathsOptions,
): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
        if (options?.signal?.aborted) {
            reject(abortErrorFromSignal(options.signal));
            return;
        }

        let worker: Worker;
        try {
            worker = new Worker(getCombineWorkerPath(), {
                workerData: { inputPaths },
                resourceLimits: PDF_COMBINE_WORKER_RESOURCE_LIMITS,
            });
        } catch (error) {
            reject(new PdfCombineWorkerStartupError(
                `Image combine worker failed to start: ${getErrorMessage(error)}`,
            ));
            return;
        }

        let settled = false;
        let cleanedUp = false;
        let timeoutHandle: NodeJS.Timeout | null = null;
        let workerOnline = false;
        let ignoreLateWorkerError: (() => undefined) | null = null;
        let abortHandler: (() => void) | null = null;

        const cleanupWorker = () => {
            if (cleanedUp) {
                return;
            }
            cleanedUp = true;
            worker.removeAllListeners('message');
            worker.removeAllListeners('error');
            worker.removeAllListeners('exit');
            if (timeoutHandle) {
                clearTimeout(timeoutHandle);
                timeoutHandle = null;
            }
            if (options?.signal && abortHandler) {
                options.signal.removeEventListener('abort', abortHandler);
                abortHandler = null;
            }
        };

        const terminateWorker = () => {
            cleanupWorker();
            ignoreLateWorkerError = () => undefined;
            worker.on('error', ignoreLateWorkerError);
            void worker.terminate().catch(() => undefined).finally(() => {
                if (ignoreLateWorkerError) {
                    worker.removeListener('error', ignoreLateWorkerError);
                    ignoreLateWorkerError = null;
                }
            });
        };

        worker.once('online', () => {
            workerOnline = true;
        });

        if (options?.signal) {
            abortHandler = () => {
                if (settled) {
                    return;
                }
                settled = true;
                terminateWorker();
                reject(abortErrorFromSignal(options.signal!));
            };
            options.signal.addEventListener('abort', abortHandler, { once: true });
        }

        worker.on('message', (message: unknown) => {
            const payload = parseCombineWorkerPayload(message);
            if (!payload) {
                if (!settled) {
                    settled = true;
                    terminateWorker();
                    reject(new Error('Image combine worker sent malformed payload'));
                }
                return;
            }

            switch (payload.type) {
                case 'progress':
                    if (options?.onProgress) {
                        options.onProgress({
                            processed: payload.processed,
                            total: payload.total,
                            percent: payload.percent,
                            elapsedMs: payload.elapsedMs,
                            estimatedRemainingMs: payload.estimatedRemainingMs,
                        });
                    }
                    return;
                case 'result': {
                    if (settled) {
                        return;
                    }
                    settled = true;
                    terminateWorker();

                    if (!payload.ok) {
                        reject(new Error(payload.error || 'Image combine worker failed'));
                        return;
                    }

                    const data = decodeWorkerPdfBytes(payload.data);
                    if (!data) {
                        reject(new Error('Image combine worker returned invalid PDF data'));
                        return;
                    }
                    if (data.byteLength > PDF_COMBINE_SMALL_MEMORY_MAX_OUTPUT_BYTES) {
                        reject(createPdfCombineOutputTooLargeError());
                        return;
                    }

                    resolve(data);
                    return;
                }
                default:
                    assertNever(payload);
            }
        });

        worker.once('error', (error) => {
            if (!settled) {
                settled = true;
                terminateWorker();
                if (!workerOnline) {
                    reject(new PdfCombineWorkerStartupError(
                        `Image combine worker failed before becoming ready: ${getErrorMessage(error)}`,
                    ));
                    return;
                }
                reject(error);
            }
        });

        worker.once('exit', (code) => {
            if (!settled) {
                settled = true;
                cleanupWorker();
                if (!workerOnline) {
                    reject(new PdfCombineWorkerStartupError(
                        `Image combine worker exited during startup with code ${code}`,
                    ));
                    return;
                }
                reject(new Error(`Image combine worker exited with code ${code}`));
            }
        });

        timeoutHandle = setTimeout(() => {
            if (settled) {
                return;
            }

            settled = true;
            terminateWorker();
            reject(new Error(`Image combine worker timed out after ${PDF_COMBINE_WORKER_TIMEOUT_MS}ms`));
        }, PDF_COMBINE_WORKER_TIMEOUT_MS);
        timeoutHandle.unref?.();
    });
}

export async function createPdfFileFromInputPaths(
    inputPaths: string[],
    outputPath: string,
    options?: ICreatePdfFromInputPathsOptions,
) {
    const normalizedPaths = inputPaths
        .filter((path) => path.length > 0);
    const normalizedOutputPath = typeof outputPath === 'string' ? outputPath : '';

    if (normalizedPaths.length === 0) {
        throw new Error('No input files were provided');
    }
    if (!normalizedOutputPath) {
        throw new Error('No output file was provided');
    }

    const nativeOptions = {
        ...(options ?? {}),
        failureMode: 'capability-error' as const,
    };
    const nativeWrote = await tryWritePdfFromInputPathsNative(
        normalizedPaths,
        normalizedOutputPath,
        nativeOptions,
    );
    if (nativeWrote) {
        return normalizedOutputPath;
    }
    throw new PdfCombineCapabilityError(
        'native-failure',
        'Native PDF combine did not produce an output file for the path-backed input set',
        {operation: 'pdf-combine'},
    );
}

async function createPdfFromNormalizedInputPaths(
    normalizedPaths: string[],
    resourceUsage: ICombineInputResourceUsage,
    options?: ICreatePdfFromInputPathsOptions,
) {
    const smallMemoryCombine = isSmallMemoryCombine(resourceUsage);
    if (!smallMemoryCombine) {
        throw new PdfCombineCapabilityError(
            'native-failure',
            'In-memory PDF combine is unavailable for inputs larger than the small-input limit; use file-backed conversion',
            {operation: 'pdf-combine'},
        );
    }

    assertMemoryCombineInputResourceLimits(resourceUsage);
    const nativePdf = await tryCreatePdfFromInputPathsNative(normalizedPaths, options);
    if (nativePdf) {
        return nativePdf;
    }
    if (!canCombineInWorker(normalizedPaths)) {
        throw new PdfCombineCapabilityError(
            'native-failure',
            'Native PDF combine does not support this input set',
            {operation: 'pdf-combine'},
        );
    }

    try {
        return await createPdfFromInputPathsWorker(normalizedPaths, options);
    } catch (workerError) {
        if (!(workerError instanceof PdfCombineWorkerStartupError)) {
            logger.warn(
                `Image combine worker failed without safe fallback: ${
                    getErrorMessage(workerError)
                }`,
            );
            throw workerError;
        }

        logger.warn(`Image combine worker failed to start: ${getErrorMessage(workerError)}`);
        throw new PdfCombineCapabilityError(
            'native-unavailable',
            `Image combine worker is unavailable: ${getErrorMessage(workerError)}`,
            {
                operation: 'pdf-combine',
                cause: workerError,
            },
        );
    }
}

export async function createPdfFromInputPaths(
    inputPaths: string[],
    options?: ICreatePdfFromInputPathsOptions,
): Promise<Uint8Array> {
    const normalizedPaths = inputPaths
        .filter((path) => path.length > 0);

    if (normalizedPaths.length === 0) {
        throw new Error('No input files were provided');
    }

    const resourceUsage = await inspectInputResourceUsage(normalizedPaths);
    return createPdfFromNormalizedInputPaths(normalizedPaths, resourceUsage, options);
}
