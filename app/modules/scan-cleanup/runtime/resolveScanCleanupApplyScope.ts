export type TScanCleanupApplyScope = 'all' | 'from-here' | 'selected' | 'every-other';

/**
 * A contiguous or strided page scope. Iteration stays lazy, so selecting all
 * pages in a very large document does not first allocate one entry per page.
 */
export interface IScanCleanupPageRange extends Iterable<number> {
    readonly kind: 'range';
    readonly startPageNumber: number;
    readonly endPageNumber: number;
    readonly step: number;
    readonly size: number;
    has: (pageNumber: number) => boolean;
    forEach: (callback: (pageNumber: number, pageNumberAgain: number, range: IScanCleanupPageRange) => void, thisArg?: unknown) => void;
}

export type TScanCleanupPageScope = ReadonlySet<number> | IScanCleanupPageRange;

export interface IResolveScanCleanupApplyScopeOptions {
    leader: number;
    pageCount: number;
    selectedPages: ReadonlySet<number>;
}

export function resolveScanCleanupApplyScope(
    options: IResolveScanCleanupApplyScopeOptions,
    scope: TScanCleanupApplyScope,
): TScanCleanupPageScope {
    const pageCount = Math.max(0, Math.floor(options.pageCount));
    if (pageCount === 0) {
        return new Set();
    }
    const leader = Math.min(pageCount, Math.max(1, Math.floor(options.leader)));
    if (scope === 'from-here') {
        return createScanCleanupPageRange(leader, pageCount);
    }
    if (scope === 'selected') {
        return new Set(
            [...options.selectedPages]
                .filter((page) => Number.isInteger(page) && page >= 1 && page <= pageCount)
                .sort((left, right) => left - right),
        );
    }
    if (scope === 'every-other') {
        return createScanCleanupPageRange(leader % 2 === 1 ? 1 : 2, pageCount, 2);
    }
    return createScanCleanupPageRange(1, pageCount);
}

export function createScanCleanupPageRange(startPageNumber: number, endPageNumber: number, step = 1): IScanCleanupPageRange {
    const normalizedStart = Math.max(1, Math.floor(startPageNumber));
    const normalizedEnd = Math.max(0, Math.floor(endPageNumber));
    const normalizedStep = Math.max(1, Math.floor(step));
    const size = normalizedStart > normalizedEnd ? 0 : Math.floor((normalizedEnd - normalizedStart) / normalizedStep) + 1;
    const range: IScanCleanupPageRange = {
        kind: 'range',
        startPageNumber: normalizedStart,
        endPageNumber: normalizedEnd,
        step: normalizedStep,
        size,
        has: (pageNumber) =>
            Number.isInteger(pageNumber) &&
            pageNumber >= normalizedStart &&
            pageNumber <= normalizedEnd &&
            (pageNumber - normalizedStart) % normalizedStep === 0,
        forEach: (callback, thisArg) => {
            for (let pageNumber = normalizedStart; pageNumber <= normalizedEnd; pageNumber += normalizedStep) {
                callback.call(thisArg, pageNumber, pageNumber, range);
            }
        },
        [Symbol.iterator]: function* () {
            for (let pageNumber = normalizedStart; pageNumber <= normalizedEnd; pageNumber += normalizedStep) {
                yield pageNumber;
            }
        },
    };
    return range;
}
