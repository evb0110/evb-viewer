import {SCAN_CLEANUP_STREAMING_BATCH_PAGES} from '@contracts/scan-cleanup/inputLimits';

export const SCAN_CLEANUP_PAGE_SCOPE_ERROR_CODE = 'SCAN_CLEANUP_INVALID_PAGE_SCOPE' as const;

export interface IScanCleanupPageNumberRange extends Iterable<number> {
    readonly length: number;
    readonly startPageNumber: number;
    readonly endPageNumber: number;
}

export interface IScanCleanupPageRange {
    startPageNumber: number;
    endPageNumber: number;
}

class ScanCleanupPageNumberRange implements IScanCleanupPageNumberRange {
    readonly length: number;
    readonly startPageNumber: number;
    readonly endPageNumber: number;

    constructor(documentPageCount: number, startPageNumber = 1) {
        this.length = documentPageCount;
        this.startPageNumber = startPageNumber;
        this.endPageNumber = startPageNumber + documentPageCount - 1;
    }

    *[Symbol.iterator]() {
        for (let pageNumber = this.startPageNumber; pageNumber <= this.endPageNumber; pageNumber += 1) {
            yield pageNumber;
        }
    }
}

export class ScanCleanupPageScopeError extends Error {
    readonly code = SCAN_CLEANUP_PAGE_SCOPE_ERROR_CODE;
    readonly pageNumbers: readonly number[];
    readonly documentPageCount: number;

    constructor(message: string, pageNumbers: readonly number[], documentPageCount: number) {
        super(message);
        this.name = 'ScanCleanupPageScopeError';
        this.pageNumbers = [...pageNumbers];
        this.documentPageCount = documentPageCount;
    }
}

/**
 * Validates the one-based page scope before any DPI probing or native
 * detection starts. The returned order is canonical so every caller gets the
 * same plan for an equivalent selection.
 */
export function resolveScanCleanupPageScope(
    pageNumbers: readonly number[] | undefined,
    documentPageCount: number,
): number[] {
    const requested = [...resolveScanCleanupPageScopeLazy(pageNumbers, documentPageCount)];
    return requested.sort((left, right) => left - right);
}

/** Resolve an all-document scope without allocating one page-number entry per page. */
export function resolveScanCleanupPageScopeLazy(
    pageNumbers: readonly number[] | undefined,
    documentPageCount: number,
    pageRange?: IScanCleanupPageRange,
): readonly number[] | IScanCleanupPageNumberRange {
    if (pageNumbers !== undefined && pageRange !== undefined) {
        throw new ScanCleanupPageScopeError(
            'Scan cleanup source page scope cannot contain both a page list and a page range',
            pageNumbers,
            documentPageCount,
        );
    }
    if (pageRange !== undefined) {
        if (
            !Number.isSafeInteger(pageRange.startPageNumber)
            || !Number.isSafeInteger(pageRange.endPageNumber)
            || pageRange.startPageNumber < 1
            || pageRange.endPageNumber < pageRange.startPageNumber
            || pageRange.endPageNumber > documentPageCount
        ) {
            throw new ScanCleanupPageScopeError(
                'Scan cleanup source page range is outside the document',
                [],
                documentPageCount,
            );
        }
        return new ScanCleanupPageNumberRange(
            pageRange.endPageNumber - pageRange.startPageNumber + 1,
            pageRange.startPageNumber,
        );
    }
    const requested = pageNumbers === undefined && documentPageCount > SCAN_CLEANUP_STREAMING_BATCH_PAGES
        ? null
        : pageNumbers === undefined
            ? Array.from({length: documentPageCount}, (_, index) => index + 1)
            : [...pageNumbers];
    if (requested === null) {
        return new ScanCleanupPageNumberRange(documentPageCount);
    }
    if (requested.length === 0) {
        throw new ScanCleanupPageScopeError(
            'Scan cleanup source page scope must not be empty',
            requested,
            documentPageCount,
        );
    }
    const seen = new Set<number>();
    for (const pageNumber of requested) {
        if (!Number.isSafeInteger(pageNumber) || pageNumber <= 0) {
            throw new ScanCleanupPageScopeError(
                'Scan cleanup source page scope requires strictly positive integers',
                requested,
                documentPageCount,
            );
        }
        if (pageNumber > documentPageCount) {
            throw new ScanCleanupPageScopeError(
                'Scan cleanup source page scope is outside the document',
                requested,
                documentPageCount,
            );
        }
        if (seen.has(pageNumber)) {
            throw new ScanCleanupPageScopeError(
                `Scan cleanup source page scope contains duplicate page ${String(pageNumber)}`,
                requested,
                documentPageCount,
            );
        }
        seen.add(pageNumber);
    }
    return requested.sort((left, right) => left - right);
}

export type TScanCleanupPageScope = readonly number[] | IScanCleanupPageNumberRange;

export function mapScanCleanupPageScope<T>(
    pageScope: TScanCleanupPageScope,
    mapper: (pageNumber: number, index: number) => T,
) {
    const values: T[] = [];
    let index = 0;
    for (const pageNumber of pageScope) {
        values.push(mapper(pageNumber, index));
        index += 1;
    }
    return values;
}

export function filterScanCleanupPageScope(
    pageScope: TScanCleanupPageScope,
    predicate: (pageNumber: number, index: number) => boolean,
) {
    const values: number[] = [];
    let index = 0;
    for (const pageNumber of pageScope) {
        if (predicate(pageNumber, index)) values.push(pageNumber);
        index += 1;
    }
    return values;
}

export function getScanCleanupPageAt(
    pageScope: TScanCleanupPageScope,
    index: number,
) {
    if (index < 0 || index >= pageScope.length || !Number.isSafeInteger(index)) {
        return undefined;
    }
    if ('startPageNumber' in pageScope) {
        return pageScope.startPageNumber + index;
    }
    return pageScope[index];
}
