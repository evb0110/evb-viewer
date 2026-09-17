import type {IScanCleanupPreviewResult} from '@contracts/scan-cleanup/electronApiScanCleanup';

/**
 * 96 MiB matches the IPC payload ceiling and is the bound that is meant to
 * bind: an interior page of the 392-page reference scan measures 1.03 MiB, so
 * the budget holds ~93 of them. The entry count only guards against a
 * degenerate stream of tiny payloads growing the map without limit. At eight it
 * bound first instead — the largest occupancy observed across the eight replay
 * scenarios was 8.45 MiB of 96 MiB, an effective history of two to three pages,
 * because one navigation inserts up to three entries.
 */
const SCAN_CLEANUP_PREVIEW_CACHE_MAX_ENTRIES = 128;
const SCAN_CLEANUP_PREVIEW_CACHE_MAX_BYTES = 96 * 1024 * 1024;

/**
 * A preview cache key is `<identity>\u0000<validity>`. The identity names the
 * page and the settings it was rendered from; the validity names the detection
 * evidence folded into that render, which arrives for the whole document at
 * once. Entries are stored under the identity, so a page holds one entry and a
 * validity change revalidates it on next access instead of leaving it
 * unreachable under a key nobody will ask for again.
 */
export const SCAN_CLEANUP_PREVIEW_CACHE_KEY_SEPARATOR = '\u0000';

interface ICachedPreview {
    byteLength: number;
    rawOutputIndex: number | null;
    result: Omit<IScanCleanupPreviewResult, 'rawImageData'> & {rawImageData?: Uint8Array};
    validity: string;
}

function splitCacheKey(key: string) {
    const separator = key.indexOf(SCAN_CLEANUP_PREVIEW_CACHE_KEY_SEPARATOR);
    return separator < 0
        ? {
            identity: key,
            validity: '',
        }
        : {
            identity: key.slice(0, separator),
            validity: key.slice(separator + 1),
        };
}

function sameBytes(left: Uint8Array, right: Uint8Array) {
    return left.buffer === right.buffer
        && left.byteOffset === right.byteOffset
        && left.byteLength === right.byteLength;
}

function compactPreview(result: IScanCleanupPreviewResult, validity: string): ICachedPreview {
    const rawOutputIndex = result.outputs.findIndex(output => sameBytes(output.imageData, result.rawImageData));
    const retainedBuffers = new Set<ArrayBufferLike>();
    let byteLength = 0;
    const addBytes = (bytes: Uint8Array) => {
        if (!retainedBuffers.has(bytes.buffer)) {
            retainedBuffers.add(bytes.buffer);
            byteLength += bytes.buffer.byteLength;
        }
    };
    for (const output of result.outputs) addBytes(output.imageData);
    if (rawOutputIndex < 0) addBytes(result.rawImageData);
    const {
        rawImageData,
        ...rest
    } = result;
    return {
        byteLength,
        rawOutputIndex: rawOutputIndex < 0 ? null : rawOutputIndex,
        result: rawOutputIndex < 0 ? {
            ...rest,
            rawImageData,
        } : rest,
        validity,
    };
}

function materializePreview(entry: ICachedPreview): IScanCleanupPreviewResult {
    const rawImageData = entry.rawOutputIndex === null
        ? entry.result.rawImageData
        : entry.result.outputs[entry.rawOutputIndex]?.imageData;
    if (!rawImageData) throw new Error('Scan cleanup preview cache entry lost its source raster');
    return {
        ...entry.result,
        rawImageData,
    };
}

export interface IScanCleanupPreviewCache {
    readonly byteLength: number;
    readonly size: number;
    clear: () => void;
    delete: (key: string) => boolean;
    get: (key: string) => IScanCleanupPreviewResult | undefined;
    has: (key: string) => boolean;
    set: (key: string, result: IScanCleanupPreviewResult) => void;
}

export function createScanCleanupPreviewCache(options: {
    maxEntries?: number;
    maxBytes?: number;
} = {}): IScanCleanupPreviewCache {
    const maxEntries = options.maxEntries ?? SCAN_CLEANUP_PREVIEW_CACHE_MAX_ENTRIES;
    const maxBytes = options.maxBytes ?? SCAN_CLEANUP_PREVIEW_CACHE_MAX_BYTES;
    const entries = new Map<string, ICachedPreview>();
    let totalBytes = 0;
    const remove = (identity: string) => {
        const entry = entries.get(identity);
        if (!entry) {
            return false;
        }
        entries.delete(identity);
        totalBytes -= entry.byteLength;
        return true;
    };
    // An entry whose validity no longer matches can never be served again, so a
    // lookup that finds one drops it there and then rather than leaving its
    // bytes for LRU pressure to reclaim.
    const revalidate = (key: string, dropStale: boolean) => {
        const {
            identity,
            validity,
        } = splitCacheKey(key);
        const entry = entries.get(identity);
        if (!entry) {
            return null;
        }
        if (entry.validity !== validity) {
            if (dropStale) remove(identity);
            return null;
        }
        return {
            identity,
            entry,
        };
    };
    return {
        get byteLength() {
            return totalBytes;
        },
        get size() {
            return entries.size;
        },
        clear() {
            entries.clear();
            totalBytes = 0;
        },
        delete: key => remove(splitCacheKey(key).identity),
        get(key) {
            const current = revalidate(key, true);
            if (!current) {
                return undefined;
            }
            entries.delete(current.identity);
            entries.set(current.identity, current.entry);
            return materializePreview(current.entry);
        },
        has: key => revalidate(key, false) !== null,
        set(key, result) {
            const {
                identity,
                validity,
            } = splitCacheKey(key);
            remove(identity);
            const entry = compactPreview(result, validity);
            entries.set(identity, entry);
            totalBytes += entry.byteLength;
            while (entries.size > maxEntries || totalBytes > maxBytes) {
                const oldestIdentity = entries.keys().next().value;
                if (oldestIdentity === undefined) break;
                remove(oldestIdentity);
            }
        },
    };
}
