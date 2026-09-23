import type { TOpenFileResult } from '@contracts/electronApiDocuments';

const retryableOpenResults = new WeakSet<TOpenFileResult>();

/**
 * A retained result keeps its working copy when an open of it fails: its
 * owner still needs the file for a retry or a Save As, and removes it itself.
 */
export function retainDocumentOpenWorkingCopyForRetry(result: TOpenFileResult) {
    retryableOpenResults.add(result);
}

export function isDocumentOpenWorkingCopyRetained(result: TOpenFileResult) {
    return retryableOpenResults.has(result);
}

export function releaseDocumentOpenWorkingCopyRetention(result: TOpenFileResult) {
    retryableOpenResults.delete(result);
}
