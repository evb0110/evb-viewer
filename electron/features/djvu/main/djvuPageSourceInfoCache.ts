import { stat } from 'fs/promises';
import { resolve } from 'path';
import type {
    IDjvuPageSize,
    IDjvuPageSourceInfo,
} from '@contracts/electronApiDjvu';
import {
    parseEpochMs,
    type TEpochMs,
} from '@contracts/timestamps';

export type TDjvuSourceRevisionKey = `${number}:${number}`;

interface IDjvuPageSourceInfoCacheEntry {
    revision: TDjvuSourceRevisionKey;
    infoByPage: Map<number, IDjvuPageSourceInfo>;
}

export interface IDjvuSourceRevision {
    revision: TDjvuSourceRevisionKey;
    sourceModifiedAt: TEpochMs;
    sourceSize: number;
}

const DJVU_PAGE_SOURCE_INFO_CACHE_MAX_DOCUMENTS = 8;
// Keep the page metadata cache bounded even when a caller asks for a full
// document scan. Full-resolution page lists are still returned to that caller,
// but they must not remain resident for every open document.
const DJVU_PAGE_SOURCE_INFO_CACHE_MAX_PAGES = 512;
const cacheByDjvuPath = new Map<string, IDjvuPageSourceInfoCacheEntry>();
const pendingProbes = new Map<string, Promise<IDjvuPageSourceInfo>>();

function normalizeDjvuPath(djvuPath: string) {
    return resolve(djvuPath);
}

function touchEntry(djvuPath: string, entry: IDjvuPageSourceInfoCacheEntry) {
    cacheByDjvuPath.delete(djvuPath);
    cacheByDjvuPath.set(djvuPath, entry);
    while (cacheByDjvuPath.size > DJVU_PAGE_SOURCE_INFO_CACHE_MAX_DOCUMENTS) {
        const oldestPath = cacheByDjvuPath.keys().next().value;
        if (typeof oldestPath !== 'string') {
            break;
        }
        cacheByDjvuPath.delete(oldestPath);
        discardPendingProbes(oldestPath);
    }
}

function discardPendingProbes(djvuPath: string) {
    const prefix = `${djvuPath}\u0000`;
    for (const key of pendingProbes.keys()) {
        if (key.startsWith(prefix)) {
            pendingProbes.delete(key);
        }
    }
}

function storeInfo(
    djvuPath: string,
    revision: TDjvuSourceRevisionKey,
    infos: IDjvuPageSourceInfo[],
) {
    const existingEntry = cacheByDjvuPath.get(djvuPath);
    if (!existingEntry || existingEntry.revision !== revision) {
        return;
    }
    for (const info of infos) {
        existingEntry.infoByPage.set(info.pageNumber, info);
        while (existingEntry.infoByPage.size > DJVU_PAGE_SOURCE_INFO_CACHE_MAX_PAGES) {
            const oldestPage = existingEntry.infoByPage.keys().next().value;
            if (typeof oldestPage !== 'number') {
                break;
            }
            existingEntry.infoByPage.delete(oldestPage);
        }
    }
    touchEntry(djvuPath, existingEntry);
}

export async function readDjvuSourceRevision(djvuPath: string): Promise<IDjvuSourceRevision> {
    const normalizedPath = normalizeDjvuPath(djvuPath);
    const sourceStat = await stat(normalizedPath);
    if (!sourceStat.isFile()) {
        throw new Error(`DjVu source is not a regular file: ${normalizedPath}`);
    }
    const sourceModifiedAt = parseEpochMs(Math.trunc(sourceStat.mtimeMs));
    if (sourceModifiedAt === null) {
        throw new Error(`DjVu source has an invalid modification time: ${normalizedPath}`);
    }
    const revision: TDjvuSourceRevisionKey = `${sourceStat.size}:${sourceModifiedAt}`;
    let entry = cacheByDjvuPath.get(normalizedPath);
    if (entry?.revision !== revision) {
        cacheByDjvuPath.delete(normalizedPath);
        discardPendingProbes(normalizedPath);
        entry = {
            revision,
            infoByPage: new Map(),
        };
    }
    touchEntry(normalizedPath, entry);
    return {
        revision,
        sourceModifiedAt,
        sourceSize: sourceStat.size,
    };
}

function getCachedDjvuPageSourceInfo(
    djvuPath: string,
    revision: TDjvuSourceRevisionKey,
    pageNumber: number,
) {
    const normalizedPath = normalizeDjvuPath(djvuPath);
    const entry = cacheByDjvuPath.get(normalizedPath);
    if (!entry || entry.revision !== revision) {
        return null;
    }
    touchEntry(normalizedPath, entry);
    return entry.infoByPage.get(pageNumber) ?? null;
}

export function getCachedDjvuPageSizes(
    djvuPath: string,
    revision: TDjvuSourceRevisionKey,
    pageCount: number,
): IDjvuPageSize[] | null {
    const normalizedPath = normalizeDjvuPath(djvuPath);
    const entry = cacheByDjvuPath.get(normalizedPath);
    if (!entry || entry.revision !== revision || entry.infoByPage.size < pageCount) {
        return null;
    }
    const sizes: IDjvuPageSize[] = [];
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
        const info = entry.infoByPage.get(pageNumber);
        if (!info) {
            return null;
        }
        sizes.push(info.pageSize);
    }
    touchEntry(normalizedPath, entry);
    return sizes;
}

export function storeDjvuPageSourceInfos(
    djvuPath: string,
    revision: TDjvuSourceRevisionKey,
    infos: IDjvuPageSourceInfo[],
) {
    storeInfo(normalizeDjvuPath(djvuPath), revision, infos);
}

// Every page record of one source revision carries the same document page
// count and first-page DPI, so any cached record answers them for a page miss.
function getCachedDjvuDocumentInfo(
    djvuPath: string,
    revision: TDjvuSourceRevisionKey,
) {
    const entry = cacheByDjvuPath.get(djvuPath);
    const info = entry?.revision === revision ? entry.infoByPage.values().next().value : undefined;
    return info && {
        dpi: info.pageSize.dpi,
        pageCount: info.pageCount,
    };
}

export function getOrProbeDjvuPageSourceInfo(
    djvuPath: string,
    revision: TDjvuSourceRevisionKey,
    pageNumber: number,
    probe: (documentInfo: {
        dpi: number;
        pageCount: number;
    } | undefined) => Promise<IDjvuPageSourceInfo>,
) {
    const normalizedPath = normalizeDjvuPath(djvuPath);
    const cached = getCachedDjvuPageSourceInfo(normalizedPath, revision, pageNumber);
    if (cached) {
        return Promise.resolve(cached);
    }
    const probeKey = `${normalizedPath}\u0000${revision}\u0000${pageNumber}`;
    const pending = pendingProbes.get(probeKey);
    if (pending) {
        return pending;
    }
    const nextProbe = probe(getCachedDjvuDocumentInfo(normalizedPath, revision)).then((info) => {
        storeInfo(normalizedPath, revision, [info]);
        return info;
    }).finally(() => {
        pendingProbes.delete(probeKey);
    });
    pendingProbes.set(probeKey, nextProbe);
    return nextProbe;
}

export function clearDjvuPageSourceInfoCacheForTests() {
    cacheByDjvuPath.clear();
    pendingProbes.clear();
}
