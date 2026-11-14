import { clamp } from 'es-toolkit/math';
import {
    ensurePdfExtension,
    getExtension,
    isDjvuFileName,
    isPdfFileName,
} from '@app/platform/browser-api/browserFileName';
import {
    BROWSER_COMBINE_IMAGE_EXTENSIONS, buildBrowserByteLimitError,
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
import {
    isNativeLegacyDocumentRef,
    parseDocumentRef,
} from '@contracts/documentRef';
import {
    createJobId,
    parseRequestId,
} from '@contracts/shared';
import {PdfCombineCapabilityError} from '@contracts/pdfCombineErrors';
import {createBrowserPdfCombineOutputError} from '@app/platform/browser-api/browserPdfCombineLimits';
import {BROWSER_PDF_COMBINE_MAX_REQUEST_BYTES} from '@contracts/browserPdfCombineWorker';
import type {ICreateStoredDocumentOptions} from '@app/platform/browser/browserDocumentRepository';
import {writePageStructureDocument} from '@app/platform/browser-api/createBrowserPageOpsCapability';

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
    const nativePath = paths.find(path => isNativeLegacyDocumentRef(path));
    if (!nativePath) {
        return;
    }

    throw new PdfCombineCapabilityError(
        'native-unavailable',
        `Browser PDF combine cannot process a native document path: ${nativePath}`,
        {operation: 'pdf-combine'},
    );
}

/** The stored document a combine writes: by default a transient output its caller removes. */
export interface ICombinedPdfDocument extends Omit<ICreateStoredDocumentOptions, 'mimeType' | 'saveKind'> {
    fileName: string;
}

export function assertBrowserCombinedPdfOutputBytes(bytes: Uint8Array) {
    if (bytes.byteLength === 0) {
        throw createBrowserPdfCombineOutputError();
    }
}

export function emitBatchOpenProgress(
    options: IBrowserBatchOpenProgressOptions | undefined,
    processed: number,
    total: number,
    startedAt: number,
    percentCap = 100,
) {
    const requestId = options?.requestId ? parseRequestId(options.requestId) : null;
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
    const jobId = createJobId('browser-pdf-combine-djvu');
    const cancel = () => { void browserDjvuCapability.cancel(jobId); };
    signal?.addEventListener('abort', cancel, {once: true});
    try {
        let result;
        try {
            throwIfCombineAborted(signal);
            const documentRef = parseDocumentRef(path);
            if (!documentRef) {
                throw new Error(`Invalid browser document reference: ${path}`);
            }
            result = await runBrowserDjvuConversion(
                documentRef,
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

/** Combines the files at `paths` into the new stored document `output` and returns its ref. */
export async function createCombinedPdfFromPaths(
    paths: string[],
    progressOptions?: IBrowserBatchOpenProgressOptions,
    output: ICombinedPdfDocument = {fileName: 'combined.pdf', kind: 'output', retention: 'transient'},
) {
    throwIfCombineAborted(progressOptions?.signal);
    assertBrowserCombineSources(paths);
    const {
        combinePaths,
        convertedRefs,
    } = await createBrowserCombineInputPaths(paths, progressOptions?.signal);
    try {
        return await createCombinedPdfFromPreparedPaths(combinePaths, output, progressOptions);
    } finally {
        if (convertedRefs.length > 0) {
            await Promise.allSettled(convertedRefs.map(ref => browserDocumentStore.remove(ref)));
        }
    }
}

async function combineImages(paths: string[], signal: AbortSignal | undefined) {
    const inputs = [];
    for (const path of paths) {
        throwIfCombineAborted(signal);
        inputs.push(cloneCombineWorkerInput(
            getBrowserDocumentFileName(path),
            await browserDocumentStore.read(path, {maxBytes: BROWSER_PDF_COMBINE_MAX_REQUEST_BYTES}),
        ));
    }
    try {
        const result = await runBrowserPdfCombineWorkerRequest('combinePdfs', {inputs}, signal);
        assertBrowserCombinedPdfOutputBytes(result.data);
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

/**
 * PDFs are merged by the page tool, which reads each where it is and writes the output into the stored
 * document; each run of images becomes one PDF first.
 */
async function createCombinedPdfFromPreparedPaths(
    paths: string[],
    output: ICombinedPdfDocument,
    progressOptions?: IBrowserBatchOpenProgressOptions,
) {
    const signal = progressOptions?.signal;
    throwIfCombineAborted(signal);
    const startedAt = Date.now();

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

    const isPdf = (path: string) => isPdfFileName(getBrowserDocumentFileName(path));
    const images = paths.filter(path => !isPdf(path));
    const imageBytes = (await Promise.all(images.map(path => browserDocumentStore.stat(path)))).reduce((total, {size}) => total + size, 0);
    if (imageBytes > BROWSER_PDF_COMBINE_MAX_REQUEST_BYTES) {
        throw buildBrowserByteLimitError('Combining these images', BROWSER_PDF_COMBINE_MAX_REQUEST_BYTES, 'inputs');
    }
    const {fileName, ...stored} = output;
    const options = {...stored, mimeType: 'application/pdf', saveKind: 'pdf'} as const;
    if (images.length === paths.length) {
        const data = await combineImages(paths, signal);
        emitBatchOpenProgress(progressOptions, paths.length, paths.length, startedAt, 95);
        return browserDocumentStore.createStoredDocument(fileName, data, options);
    }

    const sources: Blob[] = [];
    for (let index = 0; index < paths.length;) {
        throwIfCombineAborted(signal);
        if (isPdf(paths[index]!)) {
            sources.push(await browserDocumentStore.readableBlob(paths[index]!));
            index += 1;
        } else {
            let end = index;
            while (end < paths.length && !isPdf(paths[end]!)) end += 1;
            sources.push(new Blob([await combineImages(paths.slice(index, end), signal) as Uint8Array<ArrayBuffer>]));
            index = end;
        }
        emitBatchOpenProgress(progressOptions, index, paths.length, startedAt, 80);
    }
    const ref = await browserDocumentStore.createStoredDocument(fileName, new Uint8Array(), options);
    try {
        await writePageStructureDocument(ref, {kind: 'merge'}, sources, signal);
    } catch (error) {
        await browserDocumentStore.remove(ref).catch(() => undefined);
        throw error;
    }
    emitBatchOpenProgress(progressOptions, paths.length, paths.length, startedAt, 95);
    return ref;
}
