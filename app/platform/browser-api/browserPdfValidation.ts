import { getErrorMessage } from '@app/utils/error';
import { BrowserLogger } from '@app/utils/browserLogger';
import type {
    IPdfConformanceAnalysisOptions,
    IPdfConformanceProfile,
    IPdfValidationResult,
} from '@contracts/pdfConformance';
import { browserDocumentStore } from '@app/platform/browserDocumentStore';
import {
    createConservativePdfConformanceFallbackProfile,
    createPdfConformanceProfile,
    detectPdfaLevelFromPdfText,
    hasPdfEncryptMarkersInPdfText,
    hasPdfSignatureMarkersInPdfText,
    PDF_ENCRYPT_SCAN_REGION_BYTES,
} from '@pdf-core/pdfConformanceHelpers';
import {loadBrowserPdfjsDocument} from '@app/platform/browser-api/loadBrowserPdfjsDocument';
import {runBrowserPageOpsWorkerRequest} from '@app/platform/browser-api/browserPageOpsWorkerClient';
import { yieldToBrowser } from '@app/platform/browser-api/browserYield';
import { BROWSER_MAX_FULL_READ_BYTES } from '@app/platform/browser/browserDocumentConstants';

const pdfBinaryDecoder = new TextDecoder('latin1');

function readPdfMarkerEvidence(bytes: Uint8Array) {
    const text = pdfBinaryDecoder.decode(bytes);
    return {
        isSigned: hasPdfSignatureMarkersInPdfText(text),
        isEncrypted: hasPdfEncryptMarkersInPdfText(text),
        pdfaLevel: detectPdfaLevelFromPdfText(text),
    };
}

// A file beyond the full-read budget is judged by markers in its first and
// last regions only.
async function readPdfMarkerRegions(path: string, size: number) {
    const head = await browserDocumentStore.readRange(
        path,
        0,
        Math.min(PDF_ENCRYPT_SCAN_REGION_BYTES, size),
    );
    const tailStart = Math.max(head.byteLength, size - PDF_ENCRYPT_SCAN_REGION_BYTES);
    const tail = tailStart < size
        ? await browserDocumentStore.readRange(path, tailStart, size - tailStart)
        : new Uint8Array();
    const merged = new Uint8Array(head.byteLength + tail.byteLength);
    merged.set(head, 0);
    merged.set(tail, head.byteLength);
    return merged;
}

// The same pdf-page-ops structural reader desktop runs. A document it cannot
// read (encrypted, malformed, past the browser page-op page limit) keeps the
// conservative marker profile, which refuses incremental saves.
async function readPdfStructuralFacts(path: string, data: Uint8Array) {
    try {
        return await runBrowserPageOpsWorkerRequest('conformance', {data}, {dedicated: true});
    } catch (error) {
        BrowserLogger.debug('pdf-validation', 'PDF structure is unavailable; using the conservative marker profile', {
            path,
            error,
        });
        return null;
    }
}

export async function analyzeBrowserPdfConformance(
    path: string,
    options: IPdfConformanceAnalysisOptions = {},
): Promise<IPdfConformanceProfile> {
    const { size } = await browserDocumentStore.stat(path);
    if (size > BROWSER_MAX_FULL_READ_BYTES) {
        return createConservativePdfConformanceFallbackProfile(
            readPdfMarkerEvidence(await readPdfMarkerRegions(path, size)),
        );
    }

    const bytes = await browserDocumentStore.read(path);
    await yieldToBrowser();
    const structuralFacts = await readPdfStructuralFacts(path, bytes);
    if (!structuralFacts) {
        return createConservativePdfConformanceFallbackProfile(readPdfMarkerEvidence(bytes));
    }
    // Save restrictions follow the structure alone, as on desktop: a marker
    // such as an unsigned signature field does not force Save As.
    return options.purpose === 'save-restrictions'
        ? createPdfConformanceProfile(structuralFacts)
        : createPdfConformanceProfile(structuralFacts, readPdfMarkerEvidence(bytes));
}

// Validation asks whether the document loads. Once it has, a failure to
// tear it down is logged and does not turn the answer into "invalid".
function destroyValidatedDocument(loadingTask: {destroy(): Promise<void>}) {
    return loadingTask.destroy().catch((error: unknown) => {
        BrowserLogger.warn('pdf-validation', 'PDF.js teardown failed after a successful load', error);
    });
}

export async function validateBrowserPdfData(data: Uint8Array): Promise<IPdfValidationResult> {
    if (!(data instanceof Uint8Array) || data.byteLength === 0) {
        return {
            isValid: false,
            tool: 'browser',
            errors: ['PDF validation failed: empty document data'],
            warnings: [],
        };
    }

    try {
        await yieldToBrowser();
        const {
            createPdfjsDocumentInit, getPdfjsLib,
        } = await import('@app/platform/browser-api/browserPdfjsDocumentInit');
        const pdfjsLib = await getPdfjsLib();
        const loadingTask = pdfjsLib.getDocument(
            createPdfjsDocumentInit(pdfjsLib, data),
        );
        try {
            await loadingTask.promise;
        } catch (error) {
            // Report the load failure, not a failure to tear it down.
            await loadingTask.destroy().catch(() => undefined);
            throw error;
        }
        await destroyValidatedDocument(loadingTask);
        return {
            isValid: true,
            tool: 'browser',
            errors: [],
            warnings: [],
        };
    } catch (error) {
        return {
            isValid: false,
            tool: 'browser',
            errors: [error instanceof Error ? getErrorMessage(error) : 'PDF validation failed'],
            warnings: [],
        };
    }
}

export async function validateBrowserPdfPath(path: string): Promise<IPdfValidationResult> {
    const { size } = await browserDocumentStore.stat(path);
    if (size === 0) {
        return {
            isValid: false,
            tool: 'browser',
            errors: ['PDF validation failed: empty document data'],
            warnings: [],
        };
    }

    try {
        await yieldToBrowser();
        // The shared loader also fails on a later range read and destroys the
        // loading task itself when loading fails.
        const pdfDocument = await loadBrowserPdfjsDocument(path);
        await destroyValidatedDocument(pdfDocument.loadingTask);
        return {
            isValid: true,
            tool: 'browser',
            errors: [],
            warnings: [],
        };
    } catch (error) {
        return {
            isValid: false,
            tool: 'browser',
            errors: [error instanceof Error ? getErrorMessage(error) : 'PDF validation failed'],
            warnings: [],
        };
    }
}
