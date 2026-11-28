import type {
    IOcrCompleteResult,
    IOcrDiagnostic,
    IOcrErrorEnvelope,
    IOcrJobStartResult,
    IOcrProgress,
    IOcrSearchablePdfOptions,
    IOcrSearchablePdfPage,
    TOcrErrorCode,
    TOcrSearchablePdfPages,
} from '@contracts/electronApiOcr';
import {isAbortError} from '@contracts/isAbortError';
import type {IOcrCapability} from '@contracts/ocrPlatformFeature';
import {AVAILABLE_OCR_LANGUAGES, isAvailableOcrLanguageCode, type IOcrLanguage, withOcrModelSublanguages} from '@contracts/ocrLanguages';
import {createJobId, type TRequestId} from '@contracts/shared';
import {isBrowserLegacyDocumentRef, requireDocumentRef, type TDocumentRef} from '@contracts/documentRef';
import type {TDocumentRevisionToken} from '@contracts/documentRevision';
import {createEpochMs} from '@contracts/timestamps';
import {getOcrPageSelectionCount, iterateOcrPageRequestBatches} from '@ocr-core/ocrPageSelection';
import {isOcrFatalJobError} from '@ocr-core/recognizeOcrPages';
import {hasCachedOcrModel} from '@app/platform/browser-api/browserOcrModels';
import {onBrowserWorkingCopyClose} from '@app/platform/browser-api/browserWorkingCopyClose';
import {canUseBrowserOcr, findBrowserOcrUnsupportedReason} from '@app/utils/browserOcrSupport';
import {browserDocumentStore} from '@app/platform/browserDocumentStore';
import {getErrorMessage} from '@app/utils/error';

export {canUseBrowserOcr};

type TProgressListener = (progress: IOcrProgress) => void;
type TCompleteListener = (result: IOcrCompleteResult) => void;

interface IBrowserOcrStagedResult {
    requestId: TRequestId;
    /** Unique per-result receipt returned as `pdfPath`, binding apply and ack to this exact lease. */
    resultRef: TDocumentRef;
    sourceRef: TDocumentRef;
    /** The lease of the text layer appended to the document's file, uncommitted. */
    lease: string;
    sourceRevisionToken: TDocumentRevisionToken;
    committed?: boolean;
    discarding?: Promise<void>;
}

const progressListeners = new Set<TProgressListener>();
const completeListeners = new Set<TCompleteListener>();
const activeJobs = new Map<TRequestId, AbortController>();
// Per-document admission guard while a job is running; `stagedResults` continues the guard through apply/ack.
const activeJobsByDocument = new Map<TDocumentRef, TRequestId>();
// Results waiting to be applied, indexed by owning document (each record also carries its unique receipt).
const stagedResults = new Map<TDocumentRef, IBrowserOcrStagedResult>();

function createOcrResultReceiptRef(sourceRef: TDocumentRef, lease: string): TDocumentRef {
    return requireDocumentRef(`${sourceRef}#ocr-result=${encodeURIComponent(lease)}`);
}

/** The workspace localizes these codes; the message stays the code so the user sees only that text. */
const LOCALIZED_BROWSER_ERROR_CODES = new Set<TOcrErrorCode>(['OCR_BROWSER_UNSUPPORTED', 'OCR_MODEL_DOWNLOAD_FAILED']);

function errorEnvelope(code: TOcrErrorCode, message: string, retryable = false): IOcrErrorEnvelope {
    return {
        code,
        message: LOCALIZED_BROWSER_ERROR_CODES.has(code) ? code : message,
        retryable,
        details: {timestamp: createEpochMs()},
    };
}

function refusedStart(code: TOcrErrorCode, message: string, retryable = false): IOcrJobStartResult {
    return {
        started: false,
        jobId: createJobId('ocr-refused'),
        installed: [],
        error: message,
        errors: [message],
        errorEnvelope: errorEnvelope(code, message, retryable),
    };
}

function emitProgress(progress: IOcrProgress) {
    for (const listener of progressListeners) {
        listener(progress);
    }
}

function emitComplete(result: IOcrCompleteResult) {
    for (const listener of completeListeners) {
        listener(result);
    }
}

function expandPages(selection: TOcrSearchablePdfPages) {
    const pages: IOcrSearchablePdfPage[] = [];
    for (const batch of iterateOcrPageRequestBatches(selection)) {
        pages.push(...batch);
    }
    return pages;
}

function findLanguageProblem(pages: readonly IOcrSearchablePdfPage[]) {
    const languages = new Set(pages.flatMap((page) => page.languages));
    if (pages.some((page) => page.languages.length === 0)) {
        return 'Choose a language to recognize.';
    }
    if (languages.size > 1) {
        return 'OCR recognition accepts one language per request';
    }
    const unsupported = [...languages].find((code) => !isAvailableOcrLanguageCode(code));
    return unsupported === undefined ? null : `Unsupported OCR language: ${unsupported}`;
}

/** Ends a result that will not be applied: its layer is cut unless a commit took it. */
async function discardStagedResult(ref: TDocumentRef) {
    const staged = stagedResults.get(ref);
    if (!staged) {
        return;
    }
    if (staged.discarding) {
        await staged.discarding;
        return;
    }
    const discarding = (async () => {
        try {
            await browserDocumentStore.discardAppend(ref, staged.lease);
        } finally {
            if (stagedResults.get(ref) === staged) {
                stagedResults.delete(ref);
            }
        }
    })();
    staged.discarding = discarding;
    await discarding;
}

onBrowserWorkingCopyClose(async (ref) => {
    const activeRequestId = activeJobsByDocument.get(ref);
    if (activeRequestId !== undefined) {
        activeJobs.get(activeRequestId)?.abort(new DOMException('OCR was canceled', 'AbortError'));
    }
    await discardStagedResult(ref).catch(() => undefined);
});

function nothingWrittenResult(
    requestId: TRequestId,
    outcome: {
        targeted: boolean;
        errors: string[];
        diagnostics: IOcrDiagnostic[];
    },
): IOcrCompleteResult {
    const neutral =
        !outcome.targeted && outcome.errors.length === 0 && !outcome.diagnostics.some((diagnostic) => diagnostic.severity === 'warning');
    if (neutral) {
        return {
            requestId,
            success: false,
            outcome: 'no-pages-to-process',
            errors: [],
            diagnostics: outcome.diagnostics,
        };
    }
    return {
        requestId,
        success: false,
        errors: outcome.errors.length > 0 ? outcome.errors : ['No page was recognized'],
        ...(outcome.diagnostics.length > 0 ? {diagnostics: outcome.diagnostics} : {}),
    };
}

async function runJob(
    requestId: TRequestId,
    sourceRef: TDocumentRef,
    pages: IOcrSearchablePdfPage[],
    options: IOcrSearchablePdfOptions,
    controller: AbortController,
) {
    const progressBase = {
        currentPage: 0,
        processedCount: 0,
        totalPages: pages.length,
    };
    let terminal: IOcrCompleteResult;
    try {
        // The job brings PDF.js rendering and the engine client; load them on first use.
        const {runBrowserOcrJob} = await import('@app/platform/browser-api/browserOcrJob');
        const outcome = await runBrowserOcrJob({
            sourceRef,
            pages,
            options,
            signal: controller.signal,
            emit: (progress) =>
                emitProgress({
                    requestId,
                    ...progress,
                }),
        });
        if (outcome.kind === 'nothing-written') {
            terminal = nothingWrittenResult(requestId, outcome);
        } else {
            let leaseOwned = false;
            const resultRef = createOcrResultReceiptRef(sourceRef, outcome.lease);
            try {
                controller.signal.throwIfAborted();
                // A document has one pending append: a result it replaces goes.
                await discardStagedResult(sourceRef);
                controller.signal.throwIfAborted();
                const staged: IBrowserOcrStagedResult = {
                    requestId,
                    resultRef,
                    sourceRef,
                    lease: outcome.lease,
                    sourceRevisionToken: outcome.sourceRevisionToken,
                };
                stagedResults.set(sourceRef, staged);
                leaseOwned = true;
            } finally {
                if (!leaseOwned) {
                    await browserDocumentStore.discardAppend(sourceRef, outcome.lease).catch(() => undefined);
                }
            }
            terminal = {
                requestId,
                success: true,
                pdfPath: resultRef,
                sourceDocumentRevisionToken: outcome.sourceRevisionToken,
                resultSha256: outcome.sha256,
                requiresCleanupAck: true,
                errors: outcome.errors,
                ...(outcome.diagnostics.length > 0 ? {diagnostics: outcome.diagnostics} : {}),
            };
        }
    } catch (error) {
        const canceled = controller.signal.aborted || isAbortError(error);
        const message = canceled ? 'OCR was canceled' : getErrorMessage(error);
        const code: TOcrErrorCode =
            error instanceof Error &&
            error.name === 'BrowserOcrJobError' &&
            'code' in error &&
            LOCALIZED_BROWSER_ERROR_CODES.has(error.code as TOcrErrorCode)
                ? (error.code as TOcrErrorCode)
                : isOcrFatalJobError(error) && error.code !== undefined
                  ? error.code
                  : 'OCR_INTERNAL_ERROR';
        terminal = {
            requestId,
            success: false,
            errors: [message],
            ...(canceled ? {} : {errorEnvelope: errorEnvelope(code, message, code === 'OCR_MODEL_DOWNLOAD_FAILED')}),
        };
    } finally {
        activeJobs.delete(requestId);
        if (activeJobsByDocument.get(sourceRef) === requestId) {
            activeJobsByDocument.delete(sourceRef);
        }
    }
    emitProgress({
        requestId,
        ...progressBase,
        processedCount: pages.length,
        status: terminal.success ? 'success' : controller.signal.aborted ? 'canceled' : 'failed',
    });
    emitComplete(terminal);
}

/**
 * Applies a completed OCR result to the document it was recognized from: the
 * layer appended to that document's revision becomes its next revision, when
 * the document is still at that revision and nothing else was appended since.
 */
export async function commitBrowserOcrResult(
    workingCopyPath: TDocumentRef,
    resultPath: TDocumentRef,
    expectedDocumentRevisionToken: TDocumentRevisionToken | undefined,
) {
    const staged = stagedResults.get(workingCopyPath);
    if (!staged || staged.resultRef !== resultPath || staged.discarding !== undefined || staged.committed === true) {
        throw new Error('The OCR result does not belong to this document');
    }
    if (expectedDocumentRevisionToken === undefined || expectedDocumentRevisionToken !== staged.sourceRevisionToken) {
        throw new Error('The document changed after OCR read it');
    }
    await browserDocumentStore.commitAppend(workingCopyPath, expectedDocumentRevisionToken, staged.lease);
    staged.committed = true;
    return true;
}

export const browserOcrCapability: IOcrCapability = {
    cancel(requestId) {
        const controller = activeJobs.get(requestId);
        if (!controller) {
            return Promise.resolve({
                canceled: false,
                reason: 'not-found',
            });
        }
        controller.abort(new DOMException('OCR was canceled', 'AbortError'));
        return Promise.resolve({canceled: true});
    },
    async getLanguages() {
        if (findBrowserOcrUnsupportedReason() !== null) {
            return [];
        }
        return Promise.all(
            AVAILABLE_OCR_LANGUAGES.map(async (language): Promise<IOcrLanguage> => ({
                code: language.code,
                script: language.script,
                modelState: (
                    await Promise.all(withOcrModelSublanguages([language.code]).map((code) => hasCachedOcrModel(code).catch(() => false)))
                ).every(Boolean)
                    ? 'installed'
                    : 'missing',
            })),
        );
    },
    async resolveDocumentTextCatalog(workingCopyPath, documentRevision, pageCount?: number, _requestId?: TRequestId) {
        const {readBrowserDocumentTextSnapshot} = await import('@app/platform/browser-api/browserOcrTextCatalog');
        return readBrowserDocumentTextSnapshot(workingCopyPath, documentRevision, pageCount);
    },
    async resolveDocumentTextCatalogWindow(
        workingCopyPath,
        documentRevision,
        firstPage,
        lastPage,
        pageCount = lastPage,
        _requestId?: TRequestId,
    ) {
        const {readBrowserDocumentTextWindow} = await import('@app/platform/browser-api/browserOcrTextCatalog');
        return readBrowserDocumentTextWindow(workingCopyPath, documentRevision, {
            firstPage,
            lastPage,
            pageCount,
        });
    },
    async acknowledgeResultFile(
        requestId,
        pdfPath?: TDocumentRef,
        documentRef?: TDocumentRef,
        _sourceDocumentRevisionToken?: TDocumentRevisionToken,
    ) {
        const staged =
            pdfPath === undefined
                ? undefined
                : documentRef !== undefined
                  ? stagedResults.get(documentRef)
                  : [...stagedResults.values()].find((entry) => entry.resultRef === pdfPath);
        if (
            pdfPath === undefined ||
            staged === undefined ||
            staged.resultRef !== pdfPath ||
            staged.discarding !== undefined ||
            staged.requestId !== requestId ||
            (documentRef !== undefined && staged.sourceRef !== documentRef)
        ) {
            return {cleaned: false};
        }
        await discardStagedResult(staged.sourceRef);
        return {cleaned: true};
    },
    createSearchablePdf(sourcePdfPath, selection, requestId, renderDpiOrOptions?: number | IOcrSearchablePdfOptions) {
        const unsupported = findBrowserOcrUnsupportedReason();
        if (unsupported !== null) {
            return Promise.resolve(refusedStart('OCR_BROWSER_UNSUPPORTED', unsupported));
        }
        if (!isBrowserLegacyDocumentRef(sourcePdfPath)) {
            return Promise.resolve(refusedStart('OCR_INVALID_PAYLOAD', 'OCR needs a document opened in this browser workspace'));
        }
        if (activeJobs.has(requestId)) {
            return Promise.resolve(refusedStart('OCR_INVALID_PAYLOAD', 'An OCR job with this request is already running'));
        }
        if (activeJobsByDocument.has(sourcePdfPath) || stagedResults.has(sourcePdfPath)) {
            return Promise.resolve(refusedStart('OCR_QUEUE_BACKPRESSURE', 'An OCR job is already running for this document', true));
        }
        let pages: IOcrSearchablePdfPage[];
        try {
            if (getOcrPageSelectionCount(selection) === 0) {
                throw new Error('Choose at least one page to recognize');
            }
            pages = expandPages(selection);
        } catch (error) {
            return Promise.resolve(refusedStart('OCR_INVALID_PAYLOAD', getErrorMessage(error)));
        }
        const languageProblem = findLanguageProblem(pages);
        if (languageProblem !== null) {
            return Promise.resolve(refusedStart('OCR_INVALID_PAYLOAD', languageProblem));
        }
        const options: IOcrSearchablePdfOptions =
            typeof renderDpiOrOptions === 'number' ? {renderDpi: renderDpiOrOptions} : (renderDpiOrOptions ?? {});
        const controller = new AbortController();
        activeJobs.set(requestId, controller);
        activeJobsByDocument.set(sourcePdfPath, requestId);
        void runJob(requestId, sourcePdfPath, pages, options, controller);
        return Promise.resolve({
            started: true,
            jobId: createJobId('browser-ocr'),
            installed: [],
        });
    },
    onProgress(listener) {
        progressListeners.add(listener);
        return () => progressListeners.delete(listener);
    },
    onComplete(listener) {
        completeListeners.add(listener);
        return () => completeListeners.delete(listener);
    },
};
