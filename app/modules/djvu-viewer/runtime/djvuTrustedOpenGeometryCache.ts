import type { IRecentFile } from '@contracts/shared';
import type { IDjvuPageSourceInfo } from '@contracts/electronApiDjvu';
import type { IDocumentOpenSurfacePageGeometrySeed } from '@app/modules/document-viewer/public';
import {
    createBoundedLruCache, settleOpeningPreviewGeometry,
} from '@app/modules/document-viewer/public';
import {resolveDjvuPageSizeInPoints} from '@app/modules/document-viewer/source/resolveDjvuPageSizeInPoints';

interface ISourceStat {
    size: number;
    modifiedAt?: number;
}

const DJVU_TRUSTED_OPEN_GEOMETRY_CACHE_LIMIT = 256;
const geometryByPath = createBoundedLruCache<string, IDocumentOpenSurfacePageGeometrySeed>(
    DJVU_TRUSTED_OPEN_GEOMETRY_CACHE_LIMIT,
);
const pendingByPath = new Map<string, Promise<IDocumentOpenSurfacePageGeometrySeed | null>>();
const DEFAULT_RECENT_DJVU_OPEN_GEOMETRY_PREWARM_LIMIT = 4;

function matchesStat(geometry: IDocumentOpenSurfacePageGeometrySeed, stat: ISourceStat) {
    return stat.modifiedAt !== undefined
        && geometry.size === stat.size
        && geometry.modifiedAt === stat.modifiedAt;
}

export function readPrevalidatedTrustedDjvuOpenGeometry(
    path: string,
    pageNumber: number,
    sourceStat: ISourceStat | null,
    options: {allowUnvalidated?: boolean} = {},
) {
    if (!sourceStat && !options.allowUnvalidated) {
        return null;
    }
    const geometry = geometryByPath.get(path);
    if (!geometry || geometry.pageNumber !== pageNumber) {
        return null;
    }
    if (sourceStat && !matchesStat(geometry, sourceStat)) {
        geometryByPath.delete(path);
        return null;
    }
    return geometry;
}

export function cacheTrustedDjvuOpenGeometry(
    path: string,
    sourceStat: ISourceStat,
    sourceInfo: IDjvuPageSourceInfo,
) {
    const {
        widthPoints,
        heightPoints,
    } = resolveDjvuPageSizeInPoints(sourceInfo.pageSize);
    const geometry: IDocumentOpenSurfacePageGeometrySeed = Object.freeze({
        documentId: path,
        pageNumber: sourceInfo.pageNumber,
        pageCount: sourceInfo.pageCount,
        width: widthPoints,
        height: heightPoints,
        rotation: 0,
        size: sourceStat.size,
        modifiedAt: sourceStat.modifiedAt ?? 0,
    });
    geometryByPath.set(path, geometry);
    return geometry;
}

async function prevalidateTrustedDjvuOpenGeometry(
    path: string,
    readStat: (() => Promise<ISourceStat>) | undefined,
    readSourceInfo: () => Promise<IDjvuPageSourceInfo>,
) {
    const existingPending = pendingByPath.get(path);
    if (existingPending) {
        return existingPending;
    }
    const pending = (async () => {
        const sourceInfo = await readSourceInfo();
        const revision = sourceInfo.sourceSize !== undefined
            && sourceInfo.sourceModifiedAt !== undefined
            ? {
                size: sourceInfo.sourceSize,
                modifiedAt: sourceInfo.sourceModifiedAt,
            }
            : await readStat?.().catch(() => null) ?? null;
        if (!revision) {
            return null;
        }
        const cached = geometryByPath.get(path);
        if (cached && matchesStat(cached, revision)) {
            return cached;
        }
        return cacheTrustedDjvuOpenGeometry(path, revision, sourceInfo);
    })().catch(() => null).finally(() => pendingByPath.delete(path));
    pendingByPath.set(path, pending);
    return pending;
}

function selectRecentDjvuOpeningGeometryCandidates(
    files: readonly IRecentFile[],
    limit = DEFAULT_RECENT_DJVU_OPEN_GEOMETRY_PREWARM_LIMIT,
) {
    return files
        .filter(file => /\.djvu?$/iu.test(file.fileName || file.originalPath))
        .slice(0, Math.max(0, Math.trunc(limit)));
}

export async function prewarmRecentDjvuOpeningGeometry(
    files: readonly IRecentFile[],
    port: {
        readStat?: (path: string) => Promise<ISourceStat>;
        readSourceInfo: (path: string) => Promise<IDjvuPageSourceInfo>;
    },
    options: {
        concurrency?: number;
        limit?: number;
        settleTimeoutMs?: number;
        onSettled?: (
            file: IRecentFile,
            geometry: IDocumentOpenSurfacePageGeometrySeed | null,
        ) => void;
    } = {},
) {
    const candidates = selectRecentDjvuOpeningGeometryCandidates(
        files,
        options.limit,
    );
    const results = new Map<string, IDocumentOpenSurfacePageGeometrySeed | null>();
    let nextIndex = 0;
    const workers = Array.from({length: Math.min(candidates.length, Math.max(1, Math.trunc(options.concurrency ?? 2)))}, async () => {
        while (nextIndex < candidates.length) {
            const file = candidates[nextIndex++];
            if (!file) {
                return;
            }
            const readStat = port.readStat;
            const geometryTask = prevalidateTrustedDjvuOpenGeometry(
                file.originalPath,
                readStat ? () => readStat(file.originalPath) : undefined,
                () => port.readSourceInfo(file.originalPath),
            );
            const {
                geometry,
                timedOut,
            } = await settleOpeningPreviewGeometry(
                geometryTask,
                options.settleTimeoutMs,
            );
            results.set(file.originalPath, geometry);
            options.onSettled?.(file, geometry);
            if (timedOut) {
                void geometryTask.then((lateGeometry) => {
                    if (lateGeometry) {
                        options.onSettled?.(file, lateGeometry);
                    }
                });
                // The platform operation is not abortable through this port.
                // Stop probing after a timeout. Mark unclaimed candidates so
                // callers can distinguish skipped probes from missing results.
                while (nextIndex < candidates.length) {
                    const skippedFile = candidates[nextIndex++];
                    if (!skippedFile) {
                        continue;
                    }
                    results.set(skippedFile.originalPath, null);
                    options.onSettled?.(skippedFile, null);
                }
                return;
            }
        }
    });
    await Promise.all(workers);
    return results;
}
