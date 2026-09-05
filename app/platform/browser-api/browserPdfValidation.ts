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
    createPdfjsDocumentInitFromBrowserDocument,
    getPdfjsLib,
} from '@app/platform/browser-api/browserPdfjsDocumentInit';
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

type TPdfjsLoadingTask = ReturnType<Awaited<ReturnType<typeof getPdfjsLib>>['getDocument']>;

async function loadAndDestroyPdfDocument(loadingTask: TPdfjsLoadingTask) {
    try {
        const pdfDocument = await loadingTask.promise;
        await pdfDocument.destroy();
    } catch (error) {
        try {
            await loadingTask.destroy();
        } catch {
            // Ignore cleanup failure so the original validation error surfaces.
        }
        throw error;
    }
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
        await loadAndDestroyPdfDocument(loadingTask);
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
            errors: [error instanceof Error ? error.message : 'PDF validation failed'],
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
        const pdfjsLib = await getPdfjsLib();
        const rangeRead: { error: Error | null } = { error: null };
        let resolveRangeReadFailure: ((error: Error) => void) | undefined;
        const rangeReadFailure = new Promise<Error>((resolve) => {
            resolveRangeReadFailure = resolve;
        });
        const loadingTask = pdfjsLib.getDocument(
            await createPdfjsDocumentInitFromBrowserDocument(pdfjsLib, path, {onRangeReadFailure: (error) => {
                rangeRead.error = error;
                resolveRangeReadFailure?.(error);
            }}),
        );
        // A failed later range can leave PDF.js waiting for data. Race its
        // loading task so the public validator reports the range failure and
        // tears down the task instead of waiting forever.
        const documentLoad = loadAndDestroyPdfDocument(loadingTask);
        documentLoad.catch(() => undefined);
        const rangeFailure = await Promise.race([
            documentLoad.then(() => null),
            rangeReadFailure,
        ]);
        if (rangeFailure) {
            try {
                await loadingTask.destroy();
            } catch {
                // Preserve the original range-read failure.
            }
            throw rangeFailure;
        }
        if (rangeRead.error) {
            throw rangeRead.error;
        }
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
            errors: [error instanceof Error ? error.message : 'PDF validation failed'],
            warnings: [],
        };
    }
}
