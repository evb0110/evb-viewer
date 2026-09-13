import type {
    IDocumentsBatchProgress,
    TOpenFileResult,
} from '@contracts/electronApiDocuments';
import { hasElectronAPI } from '@app/utils/platform';
import {
    getDocumentOpenCapability,
    getDocumentPickerCapability,
    getDocumentWorkingCopyCapability,
} from '@app/utils/platformDocuments';
import { getErrorMessage } from '@app/utils/error';
import { BrowserLogger } from '@app/utils/browserLogger';
import {
    decodeFailureReceipt,
    type FailureReceipt,
} from '@contracts/diagnostics/failureReceipt';
import {
    createRequestId,
    type TRequestId,
} from '@contracts/shared';
import {findSerializableErrorEnvelope} from '@contracts/serializableError';
import {
    hasNativeErrorCode,
    isNativeErrorEnvelope,
} from '@contracts/nativeErrors';

export type TCombinePdfErrorCode = 'canceled' | 'invalid-input' | 'limit' | 'unsupported' | 'open-failed';

export class CombinePdfError extends Error {
    public readonly failure: FailureReceipt | undefined;

    public constructor(
        public readonly code: TCombinePdfErrorCode,
        options?: {
            cause?: unknown;
            failure?: FailureReceipt
        },
    ) {
        super(`PDF combine failed (${code})`, options);
        this.name = 'CombinePdfError';
        this.failure = options?.failure;
    }
}

function getOwnedFailure(error: unknown) {
    if (typeof error !== 'object' || error === null || !('failure' in error)) {
        return undefined;
    }
    return decodeFailureReceipt(error.failure) ?? undefined;
}

function getCombineAbortReason(signal: AbortSignal): Error {
    return signal.reason instanceof Error
        ? signal.reason
        : new DOMException('PDF combine was canceled.', 'AbortError');
}

function throwIfCombineAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
        throw getCombineAbortReason(signal);
    }
}

function classifyCombineError(error: unknown, signal?: AbortSignal): TCombinePdfErrorCode {
    if (signal?.aborted) {
        return 'canceled';
    }
    const envelope = findSerializableErrorEnvelope(error, isNativeErrorEnvelope);
    const code = envelope?.code ?? (hasNativeErrorCode(error) ? error.code : undefined);
    switch (code) {
        case 'too-large':
            return 'limit';
        case 'unsupported-filter':
            return 'unsupported';
        case 'corrupt-xref':
        case 'invalid-request':
            return 'invalid-input';
        case undefined:
        case 'encrypted':
        case 'needs-password':
        case 'io':
        case 'timeout':
        case 'panic':
        case 'native-failure':
            return 'open-failed';
    }
}

export interface ICombinePdfInputFile {file: File;}

export interface ICombinePdfCapabilities {
    supportedExtensions: readonly string[];
    maxInputs: number;
    maxInputBytes: number;
    maxTotalInputBytes: number;
}

const COMBINE_PDF_EXTENSIONS = [
    '.pdf',
    '.djvu',
    '.djv',
    '.png',
    '.jpg',
    '.jpeg',
    '.tif',
    '.tiff',
    '.bmp',
    '.webp',
    '.gif',
] as const;

export function getCombinePdfCapabilities(): ICombinePdfCapabilities {
    return hasElectronAPI() ? {
        supportedExtensions: COMBINE_PDF_EXTENSIONS,
        // Native file-backed combine is bounded by path/protocol safety, not
        // by a renderer product count.
        maxInputs: Number.MAX_SAFE_INTEGER,
        // Electron hands native combine a list of paths. The native writer
        // owns resource admission for that file-backed route, so renderer
        // capabilities must not retain the browser's byte ceilings.
        maxInputBytes: Number.MAX_SAFE_INTEGER,
        maxTotalInputBytes: Number.MAX_SAFE_INTEGER,
    } : {
        supportedExtensions: COMBINE_PDF_EXTENSIONS,
        maxInputs: 500,
        maxInputBytes: 32 * 1024 * 1024,
        maxTotalInputBytes: 64 * 1024 * 1024,
    };
}

export function isCombineCancellationSupported() {
    return !hasElectronAPI()
        || typeof getDocumentOpenCapability().cancelOpenDocumentDirectBatch === 'function';
}

function assertCombineInputsWithinCapabilities(options: ICombinePdfFilesOptions) {
    const capabilities = getCombinePdfCapabilities();
    if (options.files.length === 0 || options.files.length > capabilities.maxInputs) {
        throw new CombinePdfError('limit');
    }
    let totalBytes = 0;
    for (const {file} of options.files) {
        if (file.size <= 0 || file.size > capabilities.maxInputBytes) {
            throw new CombinePdfError(file.size <= 0 ? 'invalid-input' : 'limit');
        }
        if (!Number.isSafeInteger(file.size) || file.size > Number.MAX_SAFE_INTEGER - totalBytes) {
            throw new CombinePdfError('limit');
        }
        totalBytes += file.size;
    }
    if (totalBytes > capabilities.maxTotalInputBytes) {
        throw new CombinePdfError('limit');
    }
}

export interface ICombinePdfFilesOptions {
    files: readonly ICombinePdfInputFile[];
    outputName: string;
    openErrorMessage: string;
    onProgress?: (progress: IDocumentsBatchProgress) => void;
    signal?: AbortSignal;
}

function emitCompleteProgress(
    options: ICombinePdfFilesOptions,
    previousProgress?: IDocumentsBatchProgress | null,
) {
    options.onProgress?.({
        processed: options.files.length,
        total: options.files.length,
        percent: 100,
        elapsedMs: previousProgress?.elapsedMs ?? 0,
        estimatedRemainingMs: null,
    });
}

function toMonotonicInProgress(
    next: IDocumentsBatchProgress,
    previous: IDocumentsBatchProgress | null,
) {
    return {
        ...next,
        processed: Math.max(previous?.processed ?? 0, next.processed),
        percent: Math.min(95, Math.max(previous?.percent ?? 0, next.percent)),
        elapsedMs: Math.max(previous?.elapsedMs ?? 0, next.elapsedMs),
    };
}

async function combineElectronFiles(options: ICombinePdfFilesOptions): Promise<TOpenFileResult> {
    const documentPicker = getDocumentPickerCapability();
    const documentOpen = getDocumentOpenCapability();
    const inputPaths = documentPicker.getPathsForFiles(options.files.map(entry => entry.file))
        .filter(path => path.length > 0);

    if (inputPaths.length !== options.files.length) {
        throw new Error(options.openErrorMessage);
    }

    const requestId: TRequestId = createRequestId('pdf-combine');
    let latestProgress: IDocumentsBatchProgress | null = null;
    const stopProgress = documentOpen.onOpenDocumentDirectBatchProgress((nextProgress) => {
        if (
            nextProgress.operation !== 'document-open'
            || nextProgress.requestId !== requestId
        ) {
            return;
        }

        latestProgress = toMonotonicInProgress({
            processed: nextProgress.processed,
            total: nextProgress.total,
            percent: nextProgress.percent,
            elapsedMs: nextProgress.elapsedMs,
            estimatedRemainingMs: nextProgress.estimatedRemainingMs,
        }, latestProgress);
        options.onProgress?.(latestProgress);
    });
    const abort = () => {
        const cancel = documentOpen.cancelOpenDocumentDirectBatch;
        if (cancel) {
            void cancel(requestId).catch(() => undefined);
        }
    };
    options.signal?.addEventListener('abort', abort, {once: true});

    try {
        const result = await documentOpen.openDocumentDirectBatch(inputPaths, requestId, {forceCombine: true});
        if (!result) {
            throw new Error(options.openErrorMessage);
        }

        emitCompleteProgress(options, latestProgress);
        return result;
    } finally {
        options.signal?.removeEventListener('abort', abort);
        stopProgress();
    }
}

async function combineBrowserFiles(options: ICombinePdfFilesOptions): Promise<TOpenFileResult> {
    let latestProgress: IDocumentsBatchProgress | null = null;
    const documentPicker = getDocumentPickerCapability();
    if (!documentPicker.createCombinedPdfFromFiles) {
        throw new Error(options.openErrorMessage);
    }

    const combinedPdf = await documentPicker.createCombinedPdfFromFiles(
        options.files.map(entry => entry.file),
        {
            onProgress: (nextProgress) => {
                latestProgress = toMonotonicInProgress(nextProgress, latestProgress);
                options.onProgress?.(latestProgress);
            },
            ...(options.signal ? {signal: options.signal} : {}),
        },
    );
    throwIfCombineAborted(options.signal);
    const documentWorkingCopy = getDocumentWorkingCopyCapability();
    const workingPath = await documentWorkingCopy.createWorkingCopyFromData(
        options.outputName,
        combinedPdf,
    );
    if (options.signal?.aborted) {
        await documentWorkingCopy.cleanupFile(workingPath).catch(() => undefined);
        throw getCombineAbortReason(options.signal);
    }
    emitCompleteProgress(options, latestProgress);
    return {
        kind: 'pdf',
        workingPath,
        originalPath: workingPath,
        isGenerated: true,
    };
}

export async function combinePdfFiles(options: ICombinePdfFilesOptions): Promise<TOpenFileResult> {
    assertCombineInputsWithinCapabilities(options);
    throwIfCombineAborted(options.signal);
    try {
        return await (hasElectronAPI()
            ? combineElectronFiles(options)
            : combineBrowserFiles(options));
    } catch (error) {
        if (error instanceof CombinePdfError) throw error;
        const code = classifyCombineError(error, options.signal);
        if (code === 'canceled' || code === 'invalid-input' || code === 'limit' || code === 'unsupported') {
            throw new CombinePdfError(code, {cause: error});
        }
        const failure = getOwnedFailure(error) ?? BrowserLogger.error(
            'pdf-combine',
            'PDF combine operation failed',
            {
                code,
                detail: getErrorMessage(error),
            },
            {
                code: 'RENDERER_PDF_COMBINE_OPERATION_FAILED',
                context: {},
            },
        );
        throw new CombinePdfError(code, {
            cause: error,
            failure,
        });
    }
}
