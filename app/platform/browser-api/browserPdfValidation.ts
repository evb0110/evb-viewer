import {isBrowserFullReadTooLargeError} from '@app/platform/browser/browserDocumentReadError';
import { getErrorMessage } from '@app/utils/error';
import { BrowserLogger } from '@app/utils/browserLogger';
import type {
    IPdfConformanceAnalysisOptions,
    IPdfConformanceProfile,
    IPdfValidationResult,
} from '@contracts/pdfConformance';
import type {IPdfPathValidationOptions} from '@contracts/pdfValidationPathArgs';
import {BROWSER_QPDF_MAX_INPUT_BYTES} from '@contracts/browserQpdfEngine';
import {BROWSER_PAGE_OPS_MAX_REQUEST_BYTES} from '@contracts/browserPageOpsLimits';
import {
    DOCUMENT_LIST_HEADER, U32_BYTES,
} from '@contracts/browserPageOpsWasm.generated';
import {browserDocumentStore} from '@app/platform/browserDocumentStore';
import {
    createConservativePdfConformanceFallbackProfile,
    createPdfConformanceProfile,
    scanPdfMarkerEvidence,
    PDF_ENCRYPT_SCAN_REGION_BYTES,
} from '@pdf-core/pdfConformanceHelpers';
import {
    extractQpdfWarnings,
    isQpdfSuccessExitCode,
    parseQpdfPageCount,
    resolveQpdfValidationTimeoutMs,
    QPDF_STRUCTURAL_VALIDATE_TIMEOUT_MS,
    QPDF_VALIDATE_MAX_TIMEOUT_MS,
} from '@pdf-core/qpdfCommands';
import {loadBrowserPdfjsDocument} from '@app/platform/browser-api/loadBrowserPdfjsDocument';
import {runBrowserPageOpsWorkerRequest} from '@app/platform/browser-api/browserPageOpsWorkerClient';
import {
    BrowserQpdfEngineTimeoutError,
    isBrowserQpdfEngineUnavailableError,
    runBrowserQpdfCommand,
} from '@app/platform/browser-api/browserQpdfEngineClient';
import {buildBrowserByteLimitError} from '@app/platform/browser-api/browserPlatformHelpers';
import { yieldToBrowser } from '@app/platform/browser-api/browserYield';
import { BROWSER_MAX_FULL_READ_BYTES } from '@app/platform/browser/browserDocumentConstants';

// One document-list header and one u32 length precede the PDF.
export const BROWSER_PDF_CONFORMANCE_MAX_INPUT_BYTES = BROWSER_PAGE_OPS_MAX_REQUEST_BYTES
    - DOCUMENT_LIST_HEADER.bytes - U32_BYTES;
const COMPATIBILITY_WARNING = `qpdf validation is unavailable above the ${Math.round(BROWSER_QPDF_MAX_INPUT_BYTES / (1024 * 1024))} MiB browser input limit; only browser loadability was checked.`;

async function readPdfMarkerRegions(path: string, size: number) {
    const head = await browserDocumentStore.readRange(path, 0, Math.min(PDF_ENCRYPT_SCAN_REGION_BYTES, size));
    const tailStart = Math.max(head.byteLength, size - PDF_ENCRYPT_SCAN_REGION_BYTES);
    const tail = tailStart < size
        ? await browserDocumentStore.readRange(path, tailStart, size - tailStart)
        : new Uint8Array();
    const merged = new Uint8Array(head.byteLength + tail.byteLength);
    merged.set(head);
    merged.set(tail, head.byteLength);
    return merged;
}

async function readPdfStructuralFacts(data: Uint8Array, signal?: AbortSignal) {
    if (data.byteLength > BROWSER_PDF_CONFORMANCE_MAX_INPUT_BYTES) {
        throw buildBrowserByteLimitError('PDF structure analysis', BROWSER_PDF_CONFORMANCE_MAX_INPUT_BYTES, 'inputs');
    }
    return runBrowserPageOpsWorkerRequest('conformance', {data}, {
        dedicated: true,
        timeoutMs: QPDF_VALIDATE_MAX_TIMEOUT_MS,
        ...(signal ? {signal} : {}),
    });
}

/** Strict facts: failure must never authorize a rewrite or a timeout fallback. */
export async function analyzeBrowserPdfConformanceData(
    data: Uint8Array,
    options: IPdfConformanceAnalysisOptions & {signal?: AbortSignal} = {},
): Promise<IPdfConformanceProfile> {
    const facts = await readPdfStructuralFacts(data, options.signal);
    return createPdfConformanceProfile(facts, options.purpose === 'save-restrictions' ? undefined : scanPdfMarkerEvidence(data));
}

export async function analyzeBrowserPdfConformance(
    path: string,
    options: IPdfConformanceAnalysisOptions = {},
): Promise<IPdfConformanceProfile> {
    const {size} = await browserDocumentStore.stat(path);
    if (size > BROWSER_MAX_FULL_READ_BYTES) {
        return createConservativePdfConformanceFallbackProfile(scanPdfMarkerEvidence(await readPdfMarkerRegions(path, size)));
    }
    const bytes = await browserDocumentStore.read(path);
    await yieldToBrowser();
    try {
        return await analyzeBrowserPdfConformanceData(bytes, options);
    } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') throw error;
        BrowserLogger.debug('pdf-validation', 'PDF structure is unavailable; using the conservative marker profile', {
            path,
            error,
        });
        return createConservativePdfConformanceFallbackProfile(scanPdfMarkerEvidence(bytes));
    }
}

function validationResult(isValid: boolean, errors: string[] = [], warnings: string[] = []): IPdfValidationResult {
    return {
        isValid,
        tool: 'qpdf',
        errors,
        warnings,
    };
}

async function validateQpdfInput(
    size: number,
    readInput: () => Promise<Uint8Array>,
    fileName: string,
    purpose?: IPdfPathValidationOptions['purpose'],
    readFallbackInput = readInput,
    signal?: AbortSignal,
): Promise<IPdfValidationResult> {
    if (size === 0) return validationResult(false, ['PDF validation failed: empty document data']);
    const fullCheck = purpose === undefined;
    const timeoutMs = fullCheck ? resolveQpdfValidationTimeoutMs(size) : QPDF_STRUCTURAL_VALIDATE_TIMEOUT_MS;
    const label = fullCheck ? 'qpdf(validate-pdf)' : purpose === 'opening' ? 'qpdf(validate-pdf-opening)' : 'qpdf(validate-pdf-structure)';
    // Callback replacement keeps names containing $& literal. Never change argv.
    const display = (text: string) => text.replace(/\/work\/(?:input|output)\.pdf/gu, () => fileName);
    try {
        const result = await runBrowserQpdfCommand(fullCheck ? 'check' : 'page-count', await readInput(), {
            timeoutMs,
            ...(signal ? {signal} : {}),
        });
        if (!isQpdfSuccessExitCode(result.exitCode)) {
            // Desktop chooses raw stderr || stdout before trimming, including whitespace-only stderr.
            const detail = display(result.stderr || result.stdout).trim() || 'No process output was captured.';
            return validationResult(false, [`${label} failed with exit code ${result.exitCode}. ${detail.length > 1_200 ? `${detail.slice(0, 1_197)}...` : detail}`]);
        }
        if (!fullCheck && parseQpdfPageCount(result.stdout) === null) {
            return validationResult(false, ['PDF structural validation returned an invalid page count']);
        }
        return validationResult(true, [], [
            ...(fullCheck ? extractQpdfWarnings(display(result.stdout)) : []),
            ...extractQpdfWarnings(display(result.stderr)),
        ]);
    } catch (error) {
        if ((error instanceof Error && error.name === 'AbortError') || isBrowserQpdfEngineUnavailableError(error) || isBrowserFullReadTooLargeError(error)) throw error;
        const message = error instanceof BrowserQpdfEngineTimeoutError
            ? `${label} timed out after ${error.timeoutMs}ms`
            : display(getErrorMessage(error));
        if (fullCheck && error instanceof BrowserQpdfEngineTimeoutError) {
            try {
                await readPdfStructuralFacts(await readFallbackInput(), signal);
                return validationResult(true, [], [`qpdf validation timed out after ${timeoutMs}ms; fallback PDF structure validation succeeded.`]);
            } catch (fallbackError) {
                if (fallbackError instanceof Error && fallbackError.name === 'AbortError') throw fallbackError;
                return validationResult(false, [`${message}; fallback PDF structure validation failed: ${display(getErrorMessage(fallbackError))}`]);
            }
        }
        return validationResult(false, [message]);
    }
}

/** Full check of borrowed bytes: qpdf must never detach the caller's data. */
export async function validateBrowserPdfData(
    data: Uint8Array,
    options: {
        fileName?: string;
        signal?: AbortSignal
    } = {},
): Promise<IPdfValidationResult> {
    if (data.byteLength > BROWSER_QPDF_MAX_INPUT_BYTES) {
        throw buildBrowserByteLimitError('PDF validation', BROWSER_QPDF_MAX_INPUT_BYTES, 'inputs');
    }
    return validateQpdfInput(data.byteLength, () => Promise.resolve(data.slice()), options.fileName ?? 'document.pdf', undefined, () => Promise.resolve(data), options.signal);
}

export async function validateBrowserPdfPath(
    path: string,
    options?: IPdfPathValidationOptions,
): Promise<IPdfValidationResult> {
    const {size} = await browserDocumentStore.stat(path);
    if (size <= BROWSER_QPDF_MAX_INPUT_BYTES) {
        return validateQpdfInput(size, () => browserDocumentStore.read(path, {maxBytes: BROWSER_QPDF_MAX_INPUT_BYTES}), (await browserDocumentStore.requireEntry(path)).fileName, options?.purpose);
    }
    // Preserve range-based viewing and unchanged-ref saves above the whole-input engine ceiling.
    try {
        await yieldToBrowser();
        const pdfDocument = await loadBrowserPdfjsDocument(path);
        await pdfDocument.loadingTask.destroy().catch((error: unknown) => {
            BrowserLogger.warn('pdf-validation', 'PDF.js teardown failed after a successful load', error);
        });
        return {
            isValid: true,
            tool: 'browser',
            errors: [],
            warnings: [COMPATIBILITY_WARNING],
        };
    } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') throw error;
        return {
            isValid: false,
            tool: 'browser',
            errors: [getErrorMessage(error)],
            warnings: [],
        };
    }
}
