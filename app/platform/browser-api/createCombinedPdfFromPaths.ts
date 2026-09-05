import { clamp } from 'es-toolkit/math';
import {
    ensurePdfExtension,
    getExtension,
    isDjvuFileName,
    isPdfFileName,
} from '@app/platform/browser-api/browserFileName';
import {
    BROWSER_COMBINE_IMAGE_EXTENSIONS,
    buildBrowserByteLimitError,
} from '@app/platform/browser-api/browserPlatformHelpers';
import {
    BrowserPdfCombineWorkerUnavailableError,
    canUseBrowserPdfCombineWorker,
    cloneCombineWorkerInput,
    runBrowserPdfCombineWorkerRequest,
} from '@app/platform/browser-api/browserPdfCombineWorkerClient';
import { yieldToBrowser } from '@app/platform/browser-api/browserYield';
import { browserDjvuCapability } from '@app/platform/browser-api/browserDjvuCapability';
import { runBrowserDjvuConversion } from '@app/platform/browser-api/browserDjvuConversionPipeline';
import { emitBrowserOpenDocumentDirectBatchProgress } from '@app/platform/browser-api/documentsMenuCapability';
import type { TOpenBatchProgressOperation } from '@contracts/electronApiDocuments';
import {
    browserDocumentStore,
    getBrowserDocumentFileName,
} from '@app/platform/browserDocumentStore';
import { BROWSER_MAX_FULL_READ_BYTES } from '@app/platform/browser/browserDocumentConstants';
import { isNativeDocumentRef } from '@app/utils/documentRef';
import {PdfCombineCapabilityError} from '@contracts/pdfCombineErrors';
import {createBrowserPdfCombineOutputError} from '@app/platform/browser-api/browserPdfCombineLimits';

export interface IBrowserBatchOpenProgress {
    processed: number;
    total: number;
    percent: number;
    elapsedMs: number;
    estimatedRemainingMs: number | null;
}

export interface IBrowserBatchOpenProgressOptions {
    requestId?: string;
    operation?: TOpenBatchProgressOperation;
    onProgress?: (progress: IBrowserBatchOpenProgress) => void;
    signal?: AbortSignal;
}

function throwIfCombineAborted(signal: AbortSignal | undefined) {
    if (signal?.aborted) {
        throw signal.reason instanceof Error
            ? signal.reason
            : new DOMException('PDF combine was canceled.', 'AbortError');
    }
}

function assertBrowserCombineSources(paths: string[]) {
    const nativePath = paths.find(path => isNativeDocumentRef(path));
    if (!nativePath) {
        return;
    }

    throw new PdfCombineCapabilityError(
        'native-unavailable',
        `Browser PDF combine cannot process a native document path: ${nativePath}`,
        {operation: 'pdf-combine'},
    );
}

const BROWSER_COMBINED_PDF_TOTAL_INPUT_MAX_BYTES = BROWSER_MAX_FULL_READ_BYTES;
const BROWSER_COMBINED_PDF_REWRITE_MAX_BYTES = BROWSER_MAX_FULL_READ_BYTES;
const BROWSER_COMBINED_PDF_MAX_PAGES = 500;
const BROWSER_COMBINED_PDF_MAX_OUTPUT_BYTES = BROWSER_MAX_FULL_READ_BYTES;

interface IBrowserDecodedWorkingSetBudget {
    usedBytes: number;
    maxBytes: number;
}

export function consumeBrowserDecodedWorkingSet(
    budget: IBrowserDecodedWorkingSetBudget,
    width: number,
    height: number,
    fileName: string,
) {
    const decodedBytes = width * height * 4;
    if (!Number.isSafeInteger(decodedBytes) || decodedBytes < 0 || budget.usedBytes > budget.maxBytes - decodedBytes) {
        throw new Error(`ERR_BROWSER_PDF_COMBINE_DECODED_WORKING_SET_TOO_LARGE:${fileName}`);
    }
    budget.usedBytes += decodedBytes;
}

export function assertBrowserCombinedPdfPageCount(pageCount: number) {
    if (pageCount > BROWSER_COMBINED_PDF_MAX_PAGES) {
        throw new Error('ERR_BROWSER_PDF_COMBINE_TOO_MANY_PAGES');
    }
}

export function assertBrowserCombinedPdfOutputBytes(bytes: Uint8Array) {
    if (bytes.byteLength === 0 || bytes.byteLength > BROWSER_COMBINED_PDF_MAX_OUTPUT_BYTES) {
        throw createBrowserPdfCombineOutputError(bytes.byteLength);
    }
}

function buildBrowserLargeJobError(label: string, maxBytes: number) {
    return buildBrowserByteLimitError(
        label,
        maxBytes,
        'inputs',
    );
}

export function emitBatchOpenProgress(
    options: IBrowserBatchOpenProgressOptions | undefined,
    processed: number,
    total: number,
    startedAt: number,
    percentCap = 100,
) {
    const requestId = options?.requestId?.trim();
    const safeTotal = Math.max(total, 0);
    const safeProcessed = safeTotal > 0
        ? clamp(processed, 0, safeTotal)
        : 0;
    const elapsedMs = Math.max(0, Date.now() - startedAt);
    const percent = safeTotal > 0
        ? (safeProcessed / safeTotal) * percentCap
        : percentCap;
    const estimatedRemainingMs = safeProcessed > 0 && safeProcessed < safeTotal
        ? Math.max(
            0,
            Math.round((elapsedMs / safeProcessed) * (safeTotal - safeProcessed)),
        )
        : null;
    const progress = {
        processed: safeProcessed,
        total: safeTotal,
        percent,
        elapsedMs,
        estimatedRemainingMs,
    };

    options?.onProgress?.(progress);

    if (!requestId) {
        return;
    }

    emitBrowserOpenDocumentDirectBatchProgress({
        operation: options?.operation ?? 'document-open',
        requestId,
        ...progress,
    });
}

async function ensureBrowserCombinedPdfBudget(paths: string[], maxBytes: number) {
    let totalBytes = 0;

    for (let index = 0; index < paths.length; index += 1) {
        if (index > 0) {
            await yieldToBrowser();
        }

        const { size } = await browserDocumentStore.stat(paths[index]!);
        totalBytes += size;
        if (totalBytes > maxBytes) {
            throw buildBrowserLargeJobError(
                'Combining documents',
                maxBytes,
            );
        }
    }
}

async function ensureBrowserCombinedPdfInputBudget(paths: string[]) {
    await ensureBrowserCombinedPdfBudget(paths, BROWSER_COMBINED_PDF_TOTAL_INPUT_MAX_BYTES);
}

async function ensureBrowserCombinedPdfRewriteBudget(paths: string[]) {
    await ensureBrowserCombinedPdfBudget(paths, BROWSER_COMBINED_PDF_REWRITE_MAX_BYTES);
}

function canCombineBrowserPathsOffThread(paths: string[]) {
    return paths.length > 0 && paths.every((path) => {
        const fileName = getBrowserDocumentFileName(path);
        return isPdfFileName(fileName) || BROWSER_COMBINE_IMAGE_EXTENSIONS.has(getExtension(fileName));
    });
}

async function createBrowserPdfFromDjvuForCombine(path: string, signal?: AbortSignal) {
    throwIfCombineAborted(signal);
    const fileName = getBrowserDocumentFileName(path);
    const outputName = ensurePdfExtension(fileName.replace(/\.[^.]+$/u, ''));
    const outputRef = await browserDocumentStore.createStoredDocument(
        outputName,
        new Uint8Array(),
        {
            mimeType: 'application/pdf',
            saveKind: 'pdf',
            kind: 'output',
            retention: 'transient',
        },
    );
    const jobId = `browser-pdf-combine-djvu-${crypto.randomUUID()}`;
    const cancel = () => { void browserDjvuCapability.cancel(jobId); };
    signal?.addEventListener('abort', cancel, {once: true});
    try {
        let result;
        try {
            throwIfCombineAborted(signal);
            result = await runBrowserDjvuConversion(
                path,
                outputRef,
                {
                    jobId,
                    pdfStrategy: 'compact-djvu-aware',
                    subsample: 2,
                    preserveBookmarks: true,
                },
            );
            throwIfCombineAborted(signal);
        } finally {
            signal?.removeEventListener('abort', cancel);
        }

        if (!result.success) {
            throw new Error(result.error ?? `Failed to convert DjVu file: ${fileName}`);
        }
        return outputRef;
    } catch (error) {
        await browserDocumentStore.remove(outputRef).catch(() => undefined);
        throw error;
    }
}

async function createBrowserCombineInputPaths(paths: string[], signal?: AbortSignal) {
    const convertedRefs: string[] = [];
    const combinePaths: string[] = [];

    try {
        for (let index = 0; index < paths.length; index += 1) {
            throwIfCombineAborted(signal);
            if (index > 0) {
                await yieldToBrowser();
            }

            const path = paths[index]!;
            const fileName = getBrowserDocumentFileName(path);
            if (!isDjvuFileName(fileName)) {
                combinePaths.push(path);
                continue;
            }

            const convertedRef = await createBrowserPdfFromDjvuForCombine(path, signal);
            convertedRefs.push(convertedRef);
            combinePaths.push(convertedRef);
        }

        return {
            combinePaths,
            convertedRefs,
        };
    } catch (error) {
        await Promise.allSettled(convertedRefs.map(ref => browserDocumentStore.remove(ref)));
        throw error;
    }
}

export async function createCombinedPdfFromPaths(
    paths: string[],
    progressOptions?: IBrowserBatchOpenProgressOptions,
) {
    throwIfCombineAborted(progressOptions?.signal);
    assertBrowserCombineSources(paths);
    await ensureBrowserCombinedPdfInputBudget(paths);
    const {
        combinePaths,
        convertedRefs,
    } = await createBrowserCombineInputPaths(paths, progressOptions?.signal);
    try {
        return await createCombinedPdfFromPreparedPaths(combinePaths, progressOptions);
    } finally {
        if (convertedRefs.length > 0) {
            await Promise.allSettled(convertedRefs.map(ref => browserDocumentStore.remove(ref)));
        }
    }
}

async function createCombinedPdfFromPreparedPaths(
    paths: string[],
    progressOptions?: IBrowserBatchOpenProgressOptions,
) {
    throwIfCombineAborted(progressOptions?.signal);
    await ensureBrowserCombinedPdfRewriteBudget(paths);
    const startedAt = Date.now();
    const totalPaths = paths.length;

    if (!canCombineBrowserPathsOffThread(paths)) {
        throw new PdfCombineCapabilityError(
            'native-unavailable',
            'Browser PDF combine does not support this input set',
            {operation: 'pdf-combine'},
        );
    }

    if (!canUseBrowserPdfCombineWorker()) {
        throw new PdfCombineCapabilityError(
            'native-unavailable',
            'Browser PDF combine worker is unavailable',
            {operation: 'pdf-combine'},
        );
    }

    const inputs = [];

    for (let index = 0; index < paths.length; index += 1) {
        throwIfCombineAborted(progressOptions?.signal);
        if (index > 0) {
            await yieldToBrowser();
        }

        const path = paths[index]!;
        const data = await browserDocumentStore.read(path);
        inputs.push(cloneCombineWorkerInput(
            getBrowserDocumentFileName(path),
            data,
        ));
        emitBatchOpenProgress(progressOptions, index + 1, totalPaths, startedAt, 80);
    }

    try {
        const result = await runBrowserPdfCombineWorkerRequest(
            'combinePdfs',
            { inputs },
            progressOptions?.signal,
        );
        assertBrowserCombinedPdfOutputBytes(result.data);
        emitBatchOpenProgress(progressOptions, totalPaths, totalPaths, startedAt, 95);
        return result.data;
    } catch (error) {
        if (error instanceof BrowserPdfCombineWorkerUnavailableError) {
            throw new PdfCombineCapabilityError(
                'native-unavailable',
                'Browser PDF combine worker failed to start',
                {
                    operation: 'pdf-combine',
                    cause: error,
                },
            );
        }
        throw error;
    }
}
