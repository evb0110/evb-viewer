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
import type {IOcrCapability} from '@contracts/ocrPlatformFeature';
import {
    AVAILABLE_OCR_LANGUAGES,
    isAvailableOcrLanguageCode,
    type IOcrLanguage,
    withOcrModelSublanguages,
} from '@contracts/ocrLanguages';
import {
    createJobId,
    type TRequestId,
} from '@contracts/shared';
import {
    isBrowserLegacyDocumentRef,
    type TDocumentRef,
} from '@contracts/documentRef';
import type {TDocumentRevisionToken} from '@contracts/documentRevision';
import {createEpochMs} from '@contracts/timestamps';
import {
    getOcrPageSelectionCount,
    iterateOcrPageRequestBatches,
} from '@ocr-core/ocrPageSelection';
import {
    canStoreBrowserOcrModels,
    hasCachedOcrModel,
} from '@app/platform/browser-api/browserOcrModels';
import {browserDocumentStore} from '@app/platform/browserDocumentStore';
import {getErrorMessage} from '@app/utils/error';

// The smallest module that uses a SIMD128 instruction; the engine needs SIMD.
const WASM_SIMD_PROBE = new Uint8Array([
    0,
    97,
    115,
    109,
    1,
    0,
    0,
    0,
    1,
    5,
    1,
    96,
    0,
    1,
    123,
    3,
    2,
    1,
    0,
    10,
    10,
    1,
    8,
    0,
    65,
    0,
    253,
    15,
    253,
    98,
    11,
]);

type TProgressListener = (progress: IOcrProgress) => void;
type TCompleteListener = (result: IOcrCompleteResult) => void;

interface IBrowserOcrStagedResult {
    requestId: TRequestId;
    /** The lease of the text layer appended to the document's file, uncommitted. */
    lease: string;
    sourceRevisionToken: TDocumentRevisionToken;
}

const progressListeners = new Set<TProgressListener>();
const completeListeners = new Set<TCompleteListener>();
const activeJobs = new Map<TRequestId, AbortController>();
// Results waiting to be applied, by the document each was appended to, which the completion names.
const stagedResults = new Map<TDocumentRef, IBrowserOcrStagedResult>();

/** The workspace localizes these codes; the message stays the code so the user sees only that text. */
const LOCALIZED_BROWSER_ERROR_CODES = new Set<TOcrErrorCode>([
    'OCR_BROWSER_UNSUPPORTED',
    'OCR_MODEL_DOWNLOAD_FAILED',
]);

function errorEnvelope(code: TOcrErrorCode, message: string, retryable = false): IOcrErrorEnvelope {
    return {
        code,
        message: LOCALIZED_BROWSER_ERROR_CODES.has(code) ? code : message,
        retryable,
        details: {timestamp: createEpochMs()},
    };
}

function refusedStart(code: TOcrErrorCode, message: string): IOcrJobStartResult {
    return {
        started: false,
        jobId: createJobId('ocr-refused'),
        installed: [],
        error: message,
        errors: [message],
        errorEnvelope: errorEnvelope(code, message),
    };
}

/** Why this browser cannot run the engine, or null when it can. */
function findUnsupportedReason() {
    if (typeof Worker === 'undefined' || typeof WebAssembly === 'undefined') {
        return 'This browser cannot run the OCR engine (it needs Web Workers and WebAssembly).';
    }
    if (!WebAssembly.validate(WASM_SIMD_PROBE)) {
        return 'This browser cannot run the OCR engine (it needs WebAssembly SIMD); update the browser or use the desktop app.';
    }
    if (!canStoreBrowserOcrModels()) {
        return 'This browser cannot store OCR language models here (Cache Storage is unavailable, for example in a private window).';
    }
    return null;
}

function emitProgress(progress: IOcrProgress) {
    for (const listener of progressListeners) listener(progress);
}

function emitComplete(result: IOcrCompleteResult) {
    for (const listener of completeListeners) listener(result);
}

function expandPages(selection: TOcrSearchablePdfPages) {
    const pages: IOcrSearchablePdfPage[] = [];
    for (const batch of iterateOcrPageRequestBatches(selection)) pages.push(...batch);
    return pages;
}

function findLanguageProblem(pages: readonly IOcrSearchablePdfPage[]) {
    const languages = new Set(pages.flatMap(page => page.languages));
    if (pages.some(page => page.languages.length === 0)) return 'Choose a language to recognize.';
    if (languages.size > 1) return 'OCR recognition accepts one language per request';
    const unsupported = [...languages].find(code => !isAvailableOcrLanguageCode(code));
    return unsupported === undefined ? null : `Unsupported OCR language: ${unsupported}`;
}

/** Ends a result that will not be applied: its layer is cut unless a commit took it. */
async function discardStagedResult(ref: TDocumentRef) {
    const staged = stagedResults.get(ref);
    if (!staged) return;
    stagedResults.delete(ref);
    await browserDocumentStore.discardAppend(ref, staged.lease);
}

function nothingWrittenResult(
    requestId: TRequestId,
    outcome: {
        targeted: boolean;
        errors: string[];
        diagnostics: IOcrDiagnostic[]
    },
): IOcrCompleteResult {
    const neutral = !outcome.targeted && outcome.errors.length === 0
        && !outcome.diagnostics.some(diagnostic => diagnostic.severity === 'warning');
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
            emit: progress => emitProgress({
                requestId,
                ...progress,
            }),
        });
        if (outcome.kind === 'nothing-written') {
            terminal = nothingWrittenResult(requestId, outcome);
        } else {
            controller.signal.throwIfAborted();
            // A document has one pending append: a result it replaces goes.
            await discardStagedResult(sourceRef);
            stagedResults.set(sourceRef, {requestId, lease: outcome.lease, sourceRevisionToken: outcome.sourceRevisionToken});
            terminal = {
                requestId,
                success: true,
                pdfPath: sourceRef,
                sourceDocumentRevisionToken: outcome.sourceRevisionToken,
                resultSha256: outcome.sha256,
                requiresCleanupAck: true,
                errors: outcome.errors,
                ...(outcome.diagnostics.length > 0 ? {diagnostics: outcome.diagnostics} : {}),
            };
        }
    } catch (error) {
        const canceled = controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError');
        const message = canceled ? 'OCR was canceled' : getErrorMessage(error);
        const code: TOcrErrorCode = error instanceof Error && error.name === 'BrowserOcrJobError' && 'code' in error
            && LOCALIZED_BROWSER_ERROR_CODES.has(error.code as TOcrErrorCode)
            ? error.code as TOcrErrorCode
            : 'OCR_INTERNAL_ERROR';
        terminal = {
            requestId,
            success: false,
            errors: [message],
            ...(canceled ? {} : {errorEnvelope: errorEnvelope(code, message, code === 'OCR_MODEL_DOWNLOAD_FAILED')}),
        };
    } finally {
        activeJobs.delete(requestId);
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
    const staged = stagedResults.get(resultPath);
    if (!staged || resultPath !== workingCopyPath) {
        throw new Error('The OCR result does not belong to this document');
    }
    if (expectedDocumentRevisionToken === undefined || expectedDocumentRevisionToken !== staged.sourceRevisionToken) {
        throw new Error('The document changed after OCR read it');
    }
    await browserDocumentStore.commitAppend(workingCopyPath, expectedDocumentRevisionToken, staged.lease);
    return true;
}

export function canUseBrowserOcr() {
    return findUnsupportedReason() === null;
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
        if (findUnsupportedReason() !== null) return [];
        return Promise.all(AVAILABLE_OCR_LANGUAGES
            .map(async (language): Promise<IOcrLanguage> => ({
                code: language.code,
                script: language.script,
                modelState: (await Promise.all(withOcrModelSublanguages([language.code]).map(code => hasCachedOcrModel(code).catch(() => false))))
                    .every(Boolean) ? 'installed' : 'missing',
            })));
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
        const staged = pdfPath === undefined ? undefined : stagedResults.get(pdfPath);
        if (
            pdfPath === undefined
            || staged === undefined
            || staged.requestId !== requestId
            || (documentRef !== undefined && pdfPath !== documentRef)
        ) {
            return {cleaned: false};
        }
        await discardStagedResult(pdfPath);
        return {cleaned: true};
    },
    createSearchablePdf(sourcePdfPath, selection, requestId, renderDpiOrOptions?: number | IOcrSearchablePdfOptions) {
        const unsupported = findUnsupportedReason();
        if (unsupported !== null) {
            return Promise.resolve(refusedStart('OCR_BROWSER_UNSUPPORTED', unsupported));
        }
        if (!isBrowserLegacyDocumentRef(sourcePdfPath)) {
            return Promise.resolve(refusedStart('OCR_INVALID_PAYLOAD', 'OCR needs a document opened in this browser workspace'));
        }
        if (activeJobs.has(requestId)) {
            return Promise.resolve(refusedStart('OCR_INVALID_PAYLOAD', 'An OCR job with this request is already running'));
        }
        let pages: IOcrSearchablePdfPage[];
        try {
            if (getOcrPageSelectionCount(selection) === 0) throw new Error('Choose at least one page to recognize');
            pages = expandPages(selection);
        } catch (error) {
            return Promise.resolve(refusedStart('OCR_INVALID_PAYLOAD', getErrorMessage(error)));
        }
        const languageProblem = findLanguageProblem(pages);
        if (languageProblem !== null) {
            return Promise.resolve(refusedStart('OCR_INVALID_PAYLOAD', languageProblem));
        }
        const options: IOcrSearchablePdfOptions = typeof renderDpiOrOptions === 'number'
            ? {renderDpi: renderDpiOrOptions}
            : renderDpiOrOptions ?? {};
        const controller = new AbortController();
        activeJobs.set(requestId, controller);
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
