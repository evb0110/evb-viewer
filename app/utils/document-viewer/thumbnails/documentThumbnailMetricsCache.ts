import type {IDocumentPageMetrics} from '@app/utils/document-viewer/source/documentPageSource';

/**
 * Page metrics are fixed-shape records (two point dimensions and a rotation),
 * so an entry count is a faithful stand-in for a byte budget: the whole cache
 * at its limit is a few tens of kilobytes including the promise wrappers.
 *
 * The budget is several times the largest demand window the rail can ask for
 * (the visible range plus the 700 px virtual overscan plus the current-page
 * neighbours), so every page the rail can currently show stays resident and
 * scrolling back over a chapter still hits. Beyond that the least recently
 * used pages go first, which keeps a 5000-page document from growing the
 * cache without bound.
 *
 * An eviction is cheap: aspect ratios that drive layout are kept by
 * DocumentThumbnailLayout, so re-measuring an evicted page costs one extra
 * getPageMetrics call and never a layout shift.
 */
export const DOCUMENT_THUMBNAIL_METRICS_CACHE_LIMIT = 256;

export interface IBoundedLruCache<TKey, TValue> {
    clear(): void;
    delete(key: TKey): void;
    /** Reads and marks the key as most recently used. */
    get(key: TKey): TValue | undefined;
    readonly limit: number;
    /** Reads without changing eviction order. */
    peek(key: TKey): TValue | undefined;
    set(key: TKey, value: TValue): void;
    readonly size: number;
}

export function createBoundedLruCache<TKey, TValue>(limit: number): IBoundedLruCache<TKey, TValue> {
    const maxEntries = Math.max(1, Math.trunc(limit));
    // Map insertion order is the eviction order: oldest key first.
    const entries = new Map<TKey, TValue>();

    function touch(key: TKey, value: TValue) {
        entries.delete(key);
        entries.set(key, value);
    }

    function evictToBudget() {
        while (entries.size > maxEntries) {
            const oldest = entries.keys().next();
            if (oldest.done) {
                return;
            }
            entries.delete(oldest.value);
        }
    }

    return {
        clear() {
            entries.clear();
        },
        delete(key) {
            entries.delete(key);
        },
        get(key) {
            const value = entries.get(key);
            if (value === undefined) {
                return undefined;
            }
            touch(key, value);
            return value;
        },
        get limit() {
            return maxEntries;
        },
        peek(key) {
            return entries.get(key);
        },
        set(key, value) {
            touch(key, value);
            evictToBudget();
        },
        get size() {
            return entries.size;
        },
    };
}

export function createDocumentThumbnailMetricsCache(
    limit: number = DOCUMENT_THUMBNAIL_METRICS_CACHE_LIMIT,
): IBoundedLruCache<number, Promise<IDocumentPageMetrics>> {
    return createBoundedLruCache<number, Promise<IDocumentPageMetrics>>(limit);
}
