import type {IPdfPageSize} from '@evb/scan-cleanup/core/types';
import {PREVIEW_DPI} from '@evb/scan-cleanup/core/policy/scanCleanupRasterPolicy';
import type {IPageRaster} from '@app/platform/browser-api/browserScanCleanupJob';

const MIB = 1024 * 1024;

/**
 * Byte budget for the shared 150 DPI scan-cleanup raster LRU cache: 128 MiB on
 * devices reporting more than 4 GiB of RAM and 64 MiB otherwise.
 */
export function scanCleanupRasterCacheBudgetBytes(
    deviceMemory = (globalThis.navigator as (Navigator & {deviceMemory?: number}) | undefined)?.deviceMemory,
) {
    return (deviceMemory ?? 4) > 4 ? 128 * MIB : 64 * MIB;
}

export interface IScanCleanupRasterCacheKeyInput {
    ref: string;
    revision: string;
    pageSize: Pick<IPdfPageSize, 'pageNumber' | 'renderBox' | 'rotation' | 'xPoints' | 'yPoints' | 'widthPoints' | 'heightPoints'>;
    dpi: number;
    region?: {
        x: number;
        y: number;
        width: number;
        height: number;
    };
}

export interface ICachedScanCleanupRasterHit {
    raster: IPageRaster;
    pageOpsEngineSha256: string | null;
}

interface ICachedRasterEntry {
    ppm: Uint8Array<ArrayBuffer>;
    width: number;
    height: number;
    dpi: number;
    pageOpsEngineSha256: string | null;
}

export function buildScanCleanupRasterCacheKey(input: IScanCleanupRasterCacheKeyInput) {
    const {
        ref, revision, pageSize, dpi, region,
    } = input;
    const regionKey = region === undefined
        ? 'full'
        : `${region.x},${region.y},${region.width},${region.height}`;
    return `${ref}\u0000${revision}\u0000${pageSize.pageNumber}\u0000${pageSize.renderBox}\u0000${pageSize.rotation}\u0000${pageSize.xPoints},${pageSize.yPoints},${pageSize.widthPoints},${pageSize.heightPoints}\u0000${dpi}\u0000${regionKey}`;
}

/**
 * Only full-page rasters at analysis/preview resolution (<= 150 DPI) are cached
 * so heavy 300-600 DPI conversion renders never evict hot analysis/preview pages.
 */
export function isCacheableScanCleanupRaster(
    dpi: number,
    region: IScanCleanupRasterCacheKeyInput['region'],
) {
    return region === undefined && dpi <= PREVIEW_DPI;
}

/**
 * Bounded byte-budgeted LRU cache of 150 DPI page rasters shared across
 * Analyze -> Preview -> Conversion. Always clones buffers on write and read
 * because callers transfer `raster.ppm.buffer` to Web Workers.
 */
export function createBrowserScanCleanupRasterCache(maxBytes = scanCleanupRasterCacheBudgetBytes()) {
    const entries = new Map<string, ICachedRasterEntry>();
    let totalBytes = 0;
    let hits = 0;
    let misses = 0;

    function deleteEntry(key: string) {
        const existing = entries.get(key);
        if (!existing) return;
        entries.delete(key);
        totalBytes -= existing.ppm.byteLength;
    }

    function get(key: string): ICachedScanCleanupRasterHit | null {
        const existing = entries.get(key);
        if (!existing) {
            misses += 1;
            return null;
        }
        hits += 1;
        // Refresh recency in Map iteration order.
        entries.delete(key);
        entries.set(key, existing);
        return {
            raster: {
                ppm: new Uint8Array(existing.ppm),
                width: existing.width,
                height: existing.height,
                dpi: existing.dpi,
            },
            pageOpsEngineSha256: existing.pageOpsEngineSha256,
        };
    }

    function set(key: string, raster: IPageRaster, pageOpsEngineSha256: string | null) {
        const byteLength = raster.ppm.byteLength;
        if (byteLength === 0 || byteLength > maxBytes) {
            return;
        }
        deleteEntry(key);
        while (totalBytes + byteLength > maxBytes && entries.size > 0) {
            const oldestKey = entries.keys().next().value;
            if (oldestKey === undefined) break;
            deleteEntry(oldestKey);
        }
        const stored: ICachedRasterEntry = {
            ppm: new Uint8Array(raster.ppm),
            width: raster.width,
            height: raster.height,
            dpi: raster.dpi,
            pageOpsEngineSha256,
        };
        entries.set(key, stored);
        totalBytes += stored.ppm.byteLength;
    }

    function invalidateByRef(ref: string) {
        const prefix = `${ref}\u0000`;
        for (const key of [...entries.keys()]) {
            if (key.startsWith(prefix)) {
                deleteEntry(key);
            }
        }
    }

    function invalidateByRevision(ref: string, revision: string) {
        const prefix = `${ref}\u0000${revision}\u0000`;
        for (const key of [...entries.keys()]) {
            if (key.startsWith(prefix)) {
                deleteEntry(key);
            }
        }
    }

    function clear() {
        entries.clear();
        totalBytes = 0;
    }

    function stats() {
        return {
            hits,
            misses,
            entries: entries.size,
            bytes: totalBytes,
            maxBytes,
        };
    }

    return {
        get,
        set,
        invalidateByRef,
        invalidateByRevision,
        clear,
        stats,
    };
}

export const browserScanCleanupRasterCache = createBrowserScanCleanupRasterCache();
