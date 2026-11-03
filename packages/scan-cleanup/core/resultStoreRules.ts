import type {IScanCleanupDetectionResult} from '@contracts/scan-cleanup/electronApiScanCleanup';

/** A single result record must stay smaller than the native sidecar line cap. */
export const RESULT_STORE_MAX_RECORD_BYTES = 4 * 1024 * 1024;

export function assertPageCount(pageCount: number) {
    if (!Number.isSafeInteger(pageCount) || pageCount < 0) {
        throw new RangeError('Scan cleanup result store page count must be a non-negative safe integer');
    }
}

export function assertResultCount(resultCount: number, pageCount: number) {
    if (!Number.isSafeInteger(resultCount) || resultCount < 0 || resultCount > pageCount) {
        throw new RangeError('Scan cleanup result store result count must be within its page count');
    }
}

export function assertMaxReadPages(maxReadPages: number) {
    if (!Number.isSafeInteger(maxReadPages) || maxReadPages < 1) {
        throw new RangeError('Scan cleanup result store read window must be a positive safe integer');
    }
}

export function assertPageNumber(pageNumber: number, pageCount: number) {
    if (!Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > pageCount) {
        throw new RangeError(`Scan cleanup result store has no page ${String(pageNumber)}`);
    }
}

export function assertReadWindow(
    firstPageNumber: number,
    lastPageNumberExclusive: number,
    pageCount: number,
    maxReadPages: number,
) {
    if (
        !Number.isSafeInteger(firstPageNumber)
        || !Number.isSafeInteger(lastPageNumberExclusive)
        || firstPageNumber < 1
        || lastPageNumberExclusive < firstPageNumber
        || lastPageNumberExclusive > pageCount + 1
        || lastPageNumberExclusive - firstPageNumber > maxReadPages
    ) {
        throw new RangeError('Scan cleanup result store read range is invalid or exceeds its bounded window');
    }
}

/** A store keeps one record per page: an append adds a page, a replace revises one. */
export function assertRecordWrite(
    pageNumber: number,
    recordPageNumber: number,
    exists: boolean,
    requireExisting: boolean,
) {
    if (recordPageNumber !== pageNumber) {
        throw new Error(
            `Scan cleanup result store received page ${String(recordPageNumber)} for page ${String(pageNumber)}`,
        );
    }
    if (requireExisting && !exists) {
        throw new Error(`Scan cleanup result store cannot replace missing page ${String(pageNumber)}`);
    }
    if (!requireExisting && exists) {
        throw new Error(`Scan cleanup result store already contains page ${String(pageNumber)}`);
    }
}

/**
 * What a detection store keeps of a result. Output-mode diagnostics explain a
 * live recommendation and are the bulk of a record, so a document-scale store
 * leaves them out.
 */
export function toPersistedDetectionResult(result: IScanCleanupDetectionResult): IScanCleanupDetectionResult {
    if (result.outputModeDiagnostics === undefined) {
        return result;
    }
    const persisted = {...result};
    delete persisted.outputModeDiagnostics;
    return persisted;
}
