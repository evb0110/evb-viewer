import type {
    IOcrErrorEnvelope,
    IOcrJobStartResult,
    IOcrSearchablePdfOptions,
} from '@contracts/electronApiOcr';
import type { IOcrCapability } from '@contracts/ocrPlatformFeature';
import { noopUnsubscribe } from '@app/platform/browser-api/browserMenuHelpers';
import {
    createJobId,
    type TRequestId,
} from '@contracts/shared';
import { createEpochMs } from '@contracts/timestamps';

const BROWSER_OCR_UNAVAILABLE = 'Browser OCR is unavailable; use the desktop app to create searchable PDFs.';

function createBrowserOcrUnavailableEnvelope(): IOcrErrorEnvelope {
    return {
        code: 'OCR_WORKER_UNAVAILABLE',
        message: BROWSER_OCR_UNAVAILABLE,
        retryable: false,
        timestamp: createEpochMs(),
    };
}

function createBrowserOcrJobUnavailableResult(): IOcrJobStartResult {
    return {
        started: false,
        jobId: createJobId('ocr-unavailable'),
        installed: [],
        error: BROWSER_OCR_UNAVAILABLE,
        errors: [BROWSER_OCR_UNAVAILABLE],
        errorEnvelope: createBrowserOcrUnavailableEnvelope(),
    };
}

export const browserOcrCapability: IOcrCapability = {
    cancel() {
        return Promise.resolve({
            canceled: false,
            reason: 'not-found',
            error: BROWSER_OCR_UNAVAILABLE,
            errorEnvelope: createBrowserOcrUnavailableEnvelope(),
        });
    },
    getLanguages() {
        return Promise.resolve([]);
    },
    resolveDocumentTextCatalog(_workingCopyPath, documentRevision, pageCount = 0, _requestId?: TRequestId) {
        return Promise.resolve({
            documentRevision,
            pageCount,
            pages: [],
            contentDigest: '',
        });
    },
    resolveDocumentTextCatalogWindow(
        _workingCopyPath,
        documentRevision,
        firstPage,
        lastPage,
        pageCount = lastPage,
        _requestId?: TRequestId,
    ) {
        return Promise.resolve({
            documentRevision,
            pageCount,
            firstPage,
            lastPage,
            pages: [],
            contentDigest: '',
        });
    },
    acknowledgeResultFile() {
        return Promise.resolve({
            cleaned: false,
            error: BROWSER_OCR_UNAVAILABLE,
            errorEnvelope: createBrowserOcrUnavailableEnvelope(),
        });
    },
    createSearchablePdf(_sourcePdfPath, _pages, _requestId, _renderDpiOrOptions?: number | IOcrSearchablePdfOptions) {
        return Promise.resolve(createBrowserOcrJobUnavailableResult());
    },
    onProgress: noopUnsubscribe,
    onComplete: noopUnsubscribe,
};
