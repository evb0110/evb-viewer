import { BROWSER_MAX_FULL_READ_BYTES } from '@app/platform/browser/browserDocumentConstants';
import {
    BROWSER_DOCUMENT_FULL_READ_TOO_LARGE,
    BrowserDocumentReadError,
} from '@app/platform/browser/browserDocumentReadError';
import type {
    IBrowserDocumentEntry,
    TBrowserDocumentStorageMode,
} from '@app/platform/browser/browserDocumentTypes';

const BROWSER_INLINE_FILE_THRESHOLD_BYTES = 16 * 1024 * 1024;

export function defaultRetentionForKind(kind: IBrowserDocumentEntry['kind']) {
    return kind === 'working' ? 'transient' : 'durable';
}

function shouldInlineFileBytes(fileSize: number) {
    return fileSize <= BROWSER_INLINE_FILE_THRESHOLD_BYTES;
}

export function resolveByteBackedStorageMode(fileSize: number): TBrowserDocumentStorageMode {
    return shouldInlineFileBytes(fileSize) ? 'inline' : 'chunked';
}

export function resolveStoredDocumentStorageMode(
    byteLength: number,
    requestedStorageMode?: TBrowserDocumentStorageMode,
): TBrowserDocumentStorageMode {
    const storageMode =
        requestedStorageMode ?? resolveByteBackedStorageMode(byteLength);

    if (storageMode === 'source-proxy') {
        return 'source-proxy';
    }

    if (storageMode === 'handle') {
        return byteLength > 0
            ? resolveByteBackedStorageMode(byteLength)
            : 'handle';
    }

    if (storageMode === 'inline') {
        return resolveByteBackedStorageMode(byteLength);
    }

    return storageMode;
}

export function buildBrowserDocumentFullReadError(fileName: string, fileSize: number, maxBytes = BROWSER_MAX_FULL_READ_BYTES) {
    return new BrowserDocumentReadError(
        BROWSER_DOCUMENT_FULL_READ_TOO_LARGE,
        `Browser document is too large to load fully into memory (${fileName}: `
        + `${Math.floor(fileSize / (1024 * 1024))}MB > `
        + `${Math.round(maxBytes / (1024 * 1024))}MB limit)`,
        {maxBytes},
    );
}
