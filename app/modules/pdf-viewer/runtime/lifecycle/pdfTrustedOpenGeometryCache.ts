import {
    parsePageNumber,
    requirePageNumber,
} from '@contracts/pageNumbers';
import type { TPageNumber } from '@contracts/pageNumbers';

import type { IPdfOpeningGeometry } from '@contracts/electronApiDocuments';
import {
    readLocalStorageItem,
    safeSetLocalStorageItem,
} from '@app/utils/localStorage';

const STORAGE_KEY = 'evb:pdf-trusted-open-geometry:v1';
const MAX_ENTRIES = 24;
const validatedEntries = new Map<string, IPdfTrustedOpenGeometry>();
const validationTasks = new Map<string, Promise<IPdfTrustedOpenGeometry | null>>();

export interface IPdfTrustedOpenGeometry {
    documentId: string;
    size: number;
    modifiedAt: number;
    pageNumber: TPageNumber;
    pageCount: number;
    width: number;
    height: number;
    rotation: number;
    savedAt: number;
    linearized?: boolean;
}

function isFinitePositive(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isPdfRotation(value: unknown): value is 0 | 90 | 180 | 270 {
    return value === 0 || value === 90 || value === 180 || value === 270;
}

function decode(value: unknown): IPdfTrustedOpenGeometry | null {
    if (!value || typeof value !== 'object') {
        return null;
    }
    const record = value as Partial<IPdfTrustedOpenGeometry>;
    const documentId = record.documentId;
    const size = record.size;
    const modifiedAt = record.modifiedAt;
    const pageCount = record.pageCount;
    const width = record.width;
    const height = record.height;
    const rotation = record.rotation;
    const savedAt = record.savedAt;
    const pageNumber = typeof record.pageNumber === 'number'
        && typeof pageCount === 'number'
        ? parsePageNumber(record.pageNumber, pageCount)
        : null;
    if (
        typeof documentId !== 'string'
        || typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0
        || typeof modifiedAt !== 'number' || !Number.isSafeInteger(modifiedAt) || modifiedAt < 0
        || typeof pageCount !== 'number' || !Number.isSafeInteger(pageCount) || pageCount < 1
        || pageNumber === null
        || !isFinitePositive(width)
        || !isFinitePositive(height)
        || !isPdfRotation(rotation)
        || typeof savedAt !== 'number' || !Number.isSafeInteger(savedAt)
        || record.linearized !== undefined && typeof record.linearized !== 'boolean'
    ) {
        return null;
    }
    return {
        documentId,
        size,
        modifiedAt,
        pageNumber,
        pageCount,
        width,
        height,
        rotation,
        savedAt,
        ...(record.linearized === undefined ? {} : {linearized: record.linearized}),
    } satisfies IPdfTrustedOpenGeometry;
}

function readAll(): IPdfTrustedOpenGeometry[] {
    const result = readLocalStorageItem(STORAGE_KEY);
    if (result.status !== 'present') {
        return [];
    }
    try {
        const parsed = JSON.parse(result.value) as unknown;
        return Array.isArray(parsed) ? parsed.map(decode).filter(value => value !== null) : [];
    } catch {
        return [];
    }
}

function buildEntryKey(documentId: string, pageNumber: TPageNumber) {
    return `${documentId}\u0000${String(pageNumber)}`;
}

export function rememberValidatedTrustedPdfOpenGeometry(entry: IPdfTrustedOpenGeometry) {
    if (decode(entry) === null) {
        return false;
    }
    const key = buildEntryKey(entry.documentId, entry.pageNumber);
    validatedEntries.delete(key);
    validatedEntries.set(key, Object.freeze({...entry}));
    while (validatedEntries.size > MAX_ENTRIES) {
        const oldestKey = validatedEntries.keys().next().value;
        if (typeof oldestKey !== 'string') {
            break;
        }
        validatedEntries.delete(oldestKey);
    }
    return true;
}

export function readPrevalidatedTrustedPdfOpenGeometry(documentId: string, pageNumber: TPageNumber) {
    return validatedEntries.get(buildEntryKey(documentId, pageNumber)) ?? null;
}

export function cacheTrustedPdfOpenGeometry(
    documentId: string,
    openingGeometry: IPdfOpeningGeometry,
    options: {
        makeSynchronouslyAvailable?: boolean;
        sourceRevision?: Pick<IPdfTrustedOpenGeometry, 'size' | 'modifiedAt'>;
    } = {},
) {
    const entry: IPdfTrustedOpenGeometry = {
        documentId,
        ...openingGeometry,
        pageNumber: requirePageNumber(openingGeometry.pageNumber),
        size: options.sourceRevision?.size ?? openingGeometry.size,
        modifiedAt: options.sourceRevision?.modifiedAt ?? openingGeometry.modifiedAt,
        savedAt: Date.now(),
    };
    if (decode(entry) === null) {
        return null;
    }
    writeTrustedPdfOpenGeometry(entry);
    if (options.makeSynchronouslyAvailable ?? true) {
        rememberValidatedTrustedPdfOpenGeometry(entry);
    }
    return entry;
}

function forgetPrevalidatedTrustedPdfOpenGeometry(documentId: string, pageNumber: TPageNumber) {
    validatedEntries.delete(buildEntryKey(documentId, pageNumber));
}

export function prevalidateTrustedPdfOpenGeometry(
    documentId: string,
    pageNumber: TPageNumber,
    readStat: (() => Promise<{
        size: number;
        modifiedAt?: number;
    }>) | undefined,
    readOpeningGeometry?: () => Promise<IPdfOpeningGeometry | null>,
    options: {forceAuthoritativeRefresh?: boolean} = {},
) {
    const validated = readPrevalidatedTrustedPdfOpenGeometry(documentId, pageNumber);
    if (validated && !options.forceAuthoritativeRefresh) {
        return Promise.resolve(validated);
    }
    const unvalidated = peekTrustedPdfOpenGeometry(documentId, pageNumber);
    if (!unvalidated && !readOpeningGeometry) {
        return Promise.resolve(null);
    }
    const key = buildEntryKey(documentId, pageNumber);
    const existingTask = validationTasks.get(key);
    if (existingTask) {
        return existingTask;
    }
    const task = (async () => {
        if (unvalidated && !readOpeningGeometry && readStat) {
            const stat = await readStat();
            const current = readTrustedPdfOpenGeometry(documentId, stat, pageNumber);
            if (current) {
                rememberValidatedTrustedPdfOpenGeometry(current);
                return current;
            }
        }
        if (unvalidated) invalidateTrustedPdfOpenGeometry(documentId, pageNumber);
        if (!readOpeningGeometry) {
            return null;
        }
        let openingGeometry;
        try {
            openingGeometry = await readOpeningGeometry();
        } catch (error) {
            if (options.forceAuthoritativeRefresh) {
                invalidateTrustedPdfOpenGeometry(documentId, pageNumber);
            }
            throw error;
        }
        if (openingGeometry === null) {
            return null;
        }
        if (openingGeometry.pageNumber !== pageNumber) {
            if (options.forceAuthoritativeRefresh) {
                invalidateTrustedPdfOpenGeometry(documentId, pageNumber);
            }
            return null;
        }
        const freshEntry = cacheTrustedPdfOpenGeometry(documentId, openingGeometry);
        if (freshEntry === null) {
            if (options.forceAuthoritativeRefresh) {
                invalidateTrustedPdfOpenGeometry(documentId, pageNumber);
            }
            return null;
        }
        return freshEntry;
    })()
        .finally(() => validationTasks.delete(key));
    validationTasks.set(key, task);
    return task;
}

function readTrustedPdfOpenGeometry(
    documentId: string,
    stat: {
        size: number;
        modifiedAt?: number
    },
    pageNumber: TPageNumber,
) {
    return readAll().find(entry => isTrustedPdfOpenGeometryCurrent(
        entry,
        documentId,
        stat,
        pageNumber,
    )) ?? null;
}

/** Synchronous presence lookup for invalidation only; never render this entry before validation. */
export function peekTrustedPdfOpenGeometry(documentId: string, pageNumber: TPageNumber) {
    return readAll().find(entry => (
        entry.documentId === documentId
        && entry.pageNumber === pageNumber
    )) ?? null;
}

export function invalidateTrustedPdfOpenGeometry(documentId: string, pageNumber: TPageNumber) {
    forgetPrevalidatedTrustedPdfOpenGeometry(documentId, pageNumber);
    const entries = readAll().filter(entry => (
        entry.documentId !== documentId
        || entry.pageNumber !== pageNumber
    ));
    safeSetLocalStorageItem(STORAGE_KEY, JSON.stringify(entries));
}

export function isTrustedPdfOpenGeometryCurrent(
    entry: IPdfTrustedOpenGeometry,
    documentId: string,
    stat: {
        size: number;
        modifiedAt?: number
    },
    pageNumber = entry.pageNumber,
) {
    if (stat.modifiedAt === undefined) {
        return false;
    }
    return (
        entry.documentId === documentId
        && entry.pageNumber === pageNumber
        && entry.size === stat.size
        && entry.modifiedAt === stat.modifiedAt
    );
}

export function writeTrustedPdfOpenGeometry(entry: IPdfTrustedOpenGeometry) {
    if (decode(entry) === null) {
        return;
    }
    const entries = readAll().filter(candidate => (
        candidate.documentId !== entry.documentId
        || candidate.pageNumber !== entry.pageNumber
    ));
    entries.unshift(entry);
    safeSetLocalStorageItem(STORAGE_KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES)));
}
