import { getErrorMessage } from '@app/utils/error';
import { BrowserLogger } from '@app/utils/browserLogger';
import type {
    IPdfConformanceProfile,
    IPdfValidationResult,
} from '@contracts/pdfConformance';
import { browserDocumentStore } from '@app/platform/browserDocumentStore';
import {
    containsPdfEncryptMarker,
    createConservativePdfConformanceFallbackProfile,
    detectPdfaLevelFromPdfText,
    hasPdfSignatureMarkersInPdfText,
    PDF_ENCRYPT_SCAN_REGION_BYTES,
} from '@pdf-core/pdfConformanceHelpers';
import {
    createPdfjsDocumentInit,
    getPdfjsLib,
} from '@app/platform/browser-api/browserPdfjsDocumentInit';
import {loadBrowserPdfjsDocument} from '@app/platform/browser-api/loadBrowserPdfjsDocument';
import { yieldToBrowser } from '@app/platform/browser-api/browserYield';
import { BROWSER_MAX_FULL_READ_BYTES } from '@app/platform/browser/browserDocumentConstants';

const pdfBinaryDecoder = new TextDecoder('latin1');

function decodePdfBinary(bytes: Uint8Array) {
    return pdfBinaryDecoder.decode(bytes);
}

function detectBrowserPdfaLevel(bytes: Uint8Array) {
    return detectPdfaLevelFromPdfText(decodePdfBinary(bytes));
}

function detectBrowserSignatureMarkers(bytes: Uint8Array) {
    return hasPdfSignatureMarkersInPdfText(decodePdfBinary(bytes));
}

async function readPdfMarkerRegions(path: string) {
    const { size } = await browserDocumentStore.stat(path);
    const head = await browserDocumentStore.readRange(
        path,
        0,
        Math.min(PDF_ENCRYPT_SCAN_REGION_BYTES, size),
    );
    const tailStart = Math.max(head.byteLength, size - PDF_ENCRYPT_SCAN_REGION_BYTES);
    const tail = tailStart < size
        ? await browserDocumentStore.readRange(path, tailStart, size - tailStart)
        : new Uint8Array();

    return {
        size,
        head,
        tail,
    };
}

function mergePdfMarkerRegions(head: Uint8Array, tail: Uint8Array) {
    const merged = new Uint8Array(head.byteLength + tail.byteLength);
    merged.set(head, 0);
    merged.set(tail, head.byteLength);
    return merged;
}

function buildMarkerOnlyConformanceProfile(bytes: Uint8Array): IPdfConformanceProfile {
    return createConservativePdfConformanceFallbackProfile({
        isSigned: detectBrowserSignatureMarkers(bytes),
        isEncrypted: containsPdfEncryptMarker(bytes),
        pdfaLevel: detectBrowserPdfaLevel(bytes),
    });
}

export async function analyzeBrowserPdfConformance(path: string): Promise<IPdfConformanceProfile> {
    const {
        size,
        head,
        tail,
    } = await readPdfMarkerRegions(path);

    if (size > BROWSER_MAX_FULL_READ_BYTES) {
        const markers = mergePdfMarkerRegions(head, tail);
        return buildMarkerOnlyConformanceProfile(markers);
    }

    const bytes = await browserDocumentStore.read(path);
    await yieldToBrowser();
    return buildMarkerOnlyConformanceProfile(bytes);
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
