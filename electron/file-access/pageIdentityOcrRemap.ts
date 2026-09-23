import {randomUUID} from 'node:crypto';
import type {
    IPageIdentityDelta,
    IPageIdentityRangeMapping,
    TPageIdentityRangeOperation,
} from '@contracts/electronApiPageOps';

export const OCR_V3_DIRECT_REMAP_PAGE_LIMIT = 1_024;

type TMutablePageIdentityRangeOperation = TPageIdentityRangeOperation extends infer TOperation
    ? TOperation extends object
        ? {-readonly [TKey in keyof TOperation]: TOperation[TKey]}
        : never
    : never;

export interface IOcrRangeIdentityDelta {
    readonly previousPageCount: number;
    readonly nextPageCount: number;
    readonly ranges: readonly TPageIdentityRangeOperation[];
}

function appendMapping(
    ranges: TMutablePageIdentityRangeOperation[],
    fromPageNumber: number,
    toPageNumber: number,
    count: number,
) {
    if (count < 1) {
        return;
    }
    const kind: IPageIdentityRangeMapping['kind'] = fromPageNumber === toPageNumber ? 'retain' : 'move';
    const previous = ranges.at(-1);
    if (
        previous?.kind === kind
        && previous.fromPageNumber + previous.count === fromPageNumber
        && previous.toPageNumber + previous.count === toPageNumber
    ) {
        previous.count += count;
        return;
    }
    ranges.push({
        kind,
        fromPageNumber,
        toPageNumber,
        count,
    });
}

function appendDelete(
    ranges: TMutablePageIdentityRangeOperation[],
    fromPageNumber: number,
    count: number,
) {
    if (count < 1) {
        return;
    }
    const previous = ranges.at(-1);
    if (
        previous?.kind === 'delete'
        && previous.fromPageNumber + previous.count === fromPageNumber
    ) {
        previous.count += count;
        return;
    }
    ranges.push({
        kind: 'delete',
        fromPageNumber,
        count,
    });
}

function appendInsert(
    ranges: TMutablePageIdentityRangeOperation[],
    toPageNumber: number,
    count: number,
) {
    if (count < 1) {
        return;
    }
    const previous = ranges.at(-1);
    if (
        previous?.kind === 'insert'
        && previous.toPageNumber + previous.count === toPageNumber
    ) {
        previous.count += count;
        return;
    }
    ranges.push({
        kind: 'insert',
        toPageNumber,
        count,
        identitySeed: randomUUID(),
    });
}

/**
 * Converts a page identity delta into the range form expected by OCR v4.
 * An inline `pages` permutation is already bounded by the delta decoder, and
 * the conversion is linear, so it applies at every document size. Capping it at
 * the v3 direct-remap limit made every page op fail on OCR'd documents between
 * that limit and `PAGE_IDENTITY_INLINE_PAGE_COUNT`.
 */
export function createOcrRangeDelta(delta: IPageIdentityDelta): IOcrRangeIdentityDelta | null {
    if (delta.pages === undefined) {
        if (delta.ranges === undefined || delta.nextPageCount === undefined) {
            return null;
        }
        return {
            previousPageCount: delta.previousPageCount,
            nextPageCount: delta.nextPageCount,
            ranges: delta.ranges,
        };
    }
    const nextPageCount = delta.pages.length;
    if (delta.nextPageCount !== undefined && delta.nextPageCount !== nextPageCount) {
        throw new Error('Page identity delta page count does not match its page entries');
    }
    const ranges: TMutablePageIdentityRangeOperation[] = [];
    const sourcePages = new Set<number>();
    for (const [
        index,
        page,
    ] of delta.pages.entries()) {
        const destinationPageNumber = index + 1;
        if ('insertedId' in page) {
            appendInsert(ranges, destinationPageNumber, 1);
            continue;
        }
        if (
            !Number.isSafeInteger(page.fromPageNumber)
            || page.fromPageNumber < 1
            || page.fromPageNumber > delta.previousPageCount
            || sourcePages.has(page.fromPageNumber)
        ) {
            throw new Error('Page identity delta is not a valid source mapping');
        }
        sourcePages.add(page.fromPageNumber);
        appendMapping(ranges, page.fromPageNumber, destinationPageNumber, 1);
    }
    let sourcePageNumber = 1;
    while (sourcePageNumber <= delta.previousPageCount) {
        if (sourcePages.has(sourcePageNumber)) {
            sourcePageNumber += 1;
            continue;
        }
        const firstDeletedPage = sourcePageNumber;
        while (
            sourcePageNumber <= delta.previousPageCount
            && !sourcePages.has(sourcePageNumber)
        ) {
            sourcePageNumber += 1;
        }
        appendDelete(ranges, firstDeletedPage, sourcePageNumber - firstDeletedPage);
    }
    return {
        previousPageCount: delta.previousPageCount,
        nextPageCount,
        ranges,
    };
}
