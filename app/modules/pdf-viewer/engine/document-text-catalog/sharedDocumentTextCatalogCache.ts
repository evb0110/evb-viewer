import type {TPageNumber} from '@contracts/pageNumbers';

import type {TDocumentRef} from '@contracts/documentRef';
import type {TDocumentRevisionToken} from '@contracts/documentRevision';
import type {IDocumentOcrAvailability, IDocumentOcrPageRange, IDocumentTextCatalogPage} from '@contracts/documentTextCatalog';
import {getOcrCapability} from '@app/utils/getOcrCapability';
import {BrowserLogger} from '@app/utils/browserLogger';

const MAX_AVAILABILITY_SNAPSHOTS = 8;
const MAX_PAGE_SNAPSHOTS = 64;
const MAX_MISSING_PAGES_PER_REVISION = 4_096;

interface IIndexedDocumentOcrAvailability {
    readonly raw: IDocumentOcrAvailability;
    readonly hasAnyPages: boolean;
    readonly pageNumbersSet: ReadonlySet<number> | null;
    readonly pageRanges: readonly IDocumentOcrPageRange[];
    readonly rangesComplete: boolean;
}

interface IAvailabilityCacheEntry {
    readonly key: string;
    readonly workingCopyPath: TDocumentRef;
    readonly documentRevisionToken: TDocumentRevisionToken;
    readonly pending: Promise<IIndexedDocumentOcrAvailability | null>;
    resolved: IIndexedDocumentOcrAvailability | null | undefined;
    readonly missingPages: Set<number>;
}

const availabilityEntries = new Map<string, IAvailabilityCacheEntry>();
const pageSnapshots = new Map<string, Promise<IDocumentTextCatalogPage | null>>();

function cacheKey(workingCopyPath: TDocumentRef, documentRevisionToken: TDocumentRevisionToken) {
    return `${workingCopyPath}\0${documentRevisionToken}`;
}

function touchEntry<T>(cache: Map<string, T>, key: string, value: T) {
    cache.delete(key);
    cache.set(key, value);
}

function trimCache<T>(cache: Map<string, T>, maximumSize: number) {
    while (cache.size > maximumSize) {
        const oldestKey = cache.keys().next().value;
        if (oldestKey === undefined) {
            break;
        }
        cache.delete(oldestKey);
    }
}

function pruneStaleRevisionsForDocument(workingCopyPath: TDocumentRef, currentKey: string) {
    const documentPrefix = `${workingCopyPath}\0`;
    const currentPagePrefix = `${currentKey}\0`;
    for (const key of availabilityEntries.keys()) {
        if (key.startsWith(documentPrefix) && key !== currentKey) {
            availabilityEntries.delete(key);
        }
    }
    for (const key of pageSnapshots.keys()) {
        if (key.startsWith(documentPrefix) && !key.startsWith(currentPagePrefix)) {
            pageSnapshots.delete(key);
        }
    }
}

function indexAvailability(availability: IDocumentOcrAvailability): IIndexedDocumentOcrAvailability {
    const pageNumbersSet = availability.pageNumbers ? new Set<number>(availability.pageNumbers) : null;
    const pageRanges = availability.pageRanges ?? [];
    const hasAnyPages =
        availability.mappedPageCount !== undefined
            ? availability.mappedPageCount > 0
            : (pageNumbersSet?.size ?? 0) > 0 || pageRanges.length > 0;
    return {
        raw: availability,
        hasAnyPages,
        pageNumbersSet,
        pageRanges,
        rangesComplete: availability.rangesComplete !== false,
    };
}

function isPageInSortedRanges(ranges: readonly IDocumentOcrPageRange[], pageNumber: number) {
    let low = 0;
    let high = ranges.length - 1;
    while (low <= high) {
        const mid = (low + high) >>> 1;
        const range = ranges[mid]!;
        if (pageNumber < range.firstPage) {
            high = mid - 1;
        } else if (pageNumber > range.lastPage) {
            low = mid + 1;
        } else {
            return true;
        }
    }
    return false;
}

function evaluateIndexedPageAvailability(
    indexed: IIndexedDocumentOcrAvailability | null,
    missingPages: ReadonlySet<number>,
    pageNumber: TPageNumber,
): boolean | null {
    if (!indexed || !indexed.hasAnyPages) {
        return false;
    }
    if (indexed.pageNumbersSet?.has(pageNumber) === true) {
        return true;
    }
    if (isPageInSortedRanges(indexed.pageRanges, pageNumber)) {
        return true;
    }
    if (indexed.rangesComplete || missingPages.has(pageNumber)) {
        return false;
    }
    return null;
}

function recordMissingPage(entry: IAvailabilityCacheEntry | undefined, pageNumber: TPageNumber) {
    if (!entry) {
        return;
    }
    if (entry.missingPages.size >= MAX_MISSING_PAGES_PER_REVISION && !entry.missingPages.has(pageNumber)) {
        const oldest = entry.missingPages.values().next().value;
        if (oldest !== undefined) {
            entry.missingPages.delete(oldest);
        }
    }
    entry.missingPages.add(pageNumber);
}

function getOrLoadAvailabilityEntry(
    workingCopyPath: TDocumentRef,
    documentRevisionToken: TDocumentRevisionToken,
): IAvailabilityCacheEntry | null {
    const key = cacheKey(workingCopyPath, documentRevisionToken);
    const cached = availabilityEntries.get(key);
    if (cached) {
        touchEntry(availabilityEntries, key, cached);
        return cached;
    }

    const capability = getOcrCapability();
    if (typeof capability.resolveDocumentOcrAvailability !== 'function') {
        return null;
    }

    pruneStaleRevisionsForDocument(workingCopyPath, key);

    const pending = capability
        .resolveDocumentOcrAvailability(workingCopyPath, documentRevisionToken)
        .then((availability) => {
            const indexed = availability ? indexAvailability(availability) : null;
            const current = availabilityEntries.get(key);
            if (current?.pending === pending) {
                current.resolved = indexed;
            }
            return indexed;
        })
        .catch((error) => {
            if (availabilityEntries.get(key)?.pending === pending) {
                availabilityEntries.delete(key);
            }
            BrowserLogger.warn('ocr', 'Failed to resolve OCR availability for PDF viewer', error);
            return null;
        });

    const entry: IAvailabilityCacheEntry = {
        key,
        workingCopyPath,
        documentRevisionToken,
        pending,
        resolved: undefined,
        missingPages: new Set<number>(),
    };
    availabilityEntries.set(key, entry);
    trimCache(availabilityEntries, MAX_AVAILABILITY_SNAPSHOTS);
    return entry;
}

export function loadSharedDocumentOcrAvailability(
    workingCopyPath: TDocumentRef,
    documentRevisionToken: TDocumentRevisionToken,
): Promise<IDocumentOcrAvailability | null> {
    const entry = getOrLoadAvailabilityEntry(workingCopyPath, documentRevisionToken);
    if (!entry) {
        return Promise.resolve(null);
    }
    if (entry.resolved !== undefined) {
        return Promise.resolve(entry.resolved?.raw ?? null);
    }
    return entry.pending.then((indexed) => indexed?.raw ?? null);
}

/**
 * Synchronous check against the already-resolved revision availability and
 * negative page-probe cache. Returns `null` when availability has not resolved
 * yet or when an incomplete range list still requires a per-page probe.
 */
export function peekSharedDocumentOcrPageAvailability(
    workingCopyPath: TDocumentRef,
    documentRevisionToken: TDocumentRevisionToken,
    pageNumber: TPageNumber,
): boolean | null {
    const key = cacheKey(workingCopyPath, documentRevisionToken);
    const entry = availabilityEntries.get(key);
    if (!entry || entry.resolved === undefined) {
        return null;
    }
    touchEntry(availabilityEntries, key, entry);
    return evaluateIndexedPageAvailability(entry.resolved, entry.missingPages, pageNumber);
}

export async function hasSharedDocumentOcrPage(
    workingCopyPath: TDocumentRef,
    documentRevisionToken: TDocumentRevisionToken,
    pageNumber: TPageNumber,
): Promise<boolean> {
    const entry = getOrLoadAvailabilityEntry(workingCopyPath, documentRevisionToken);
    if (!entry) {
        return false;
    }
    const indexed = entry.resolved !== undefined ? entry.resolved : await entry.pending;
    const decided = evaluateIndexedPageAvailability(indexed, entry.missingPages, pageNumber);
    if (decided !== null) {
        return decided;
    }
    return (await loadSharedDocumentOcrPage(workingCopyPath, documentRevisionToken, pageNumber)) !== null;
}

export function loadSharedDocumentOcrPage(
    workingCopyPath: TDocumentRef,
    documentRevisionToken: TDocumentRevisionToken,
    pageNumber: TPageNumber,
) {
    const revKey = cacheKey(workingCopyPath, documentRevisionToken);
    const key = `${revKey}\0${pageNumber}`;
    const cached = pageSnapshots.get(key);
    if (cached) {
        touchEntry(pageSnapshots, key, cached);
        return cached;
    }

    const availabilityEntry = availabilityEntries.get(revKey);
    if (availabilityEntry) {
        if (availabilityEntry.missingPages.has(pageNumber)) {
            return Promise.resolve(null);
        }
        if (
            availabilityEntry.resolved !== undefined &&
            evaluateIndexedPageAvailability(availabilityEntry.resolved, availabilityEntry.missingPages, pageNumber) === false
        ) {
            return Promise.resolve(null);
        }
    }

    const capability = getOcrCapability();
    if (typeof capability.resolveDocumentOcrPage !== 'function') {
        return Promise.resolve(null);
    }

    pruneStaleRevisionsForDocument(workingCopyPath, revKey);

    const capturedAvailabilityEntry = availabilityEntry;
    const pending = capability
        .resolveDocumentOcrPage(workingCopyPath, documentRevisionToken, pageNumber)
        .then((snapshot) => {
            if (
                snapshot.page === null &&
                pageSnapshots.get(key) === pending &&
                capturedAvailabilityEntry !== undefined &&
                availabilityEntries.get(revKey) === capturedAvailabilityEntry
            ) {
                recordMissingPage(capturedAvailabilityEntry, pageNumber);
                pageSnapshots.delete(key);
            }
            return snapshot.page;
        })
        .catch((error) => {
            if (pageSnapshots.get(key) === pending) {
                pageSnapshots.delete(key);
            }
            BrowserLogger.warn('ocr', `Failed to resolve OCR page ${pageNumber} for PDF viewer`, error);
            return null;
        });
    pageSnapshots.set(key, pending);
    trimCache(pageSnapshots, MAX_PAGE_SNAPSHOTS);
    return pending;
}

export function clearSharedDocumentTextCatalog(workingCopyPath?: TDocumentRef) {
    if (workingCopyPath === undefined) {
        availabilityEntries.clear();
        pageSnapshots.clear();
        return;
    }
    const prefix = `${workingCopyPath}\0`;
    for (const key of availabilityEntries.keys()) {
        if (key.startsWith(prefix)) {
            availabilityEntries.delete(key);
        }
    }
    for (const key of pageSnapshots.keys()) {
        if (key.startsWith(prefix)) {
            pageSnapshots.delete(key);
        }
    }
}
