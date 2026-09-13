import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type {IDocumentPageMetrics} from '@app/modules/document-viewer/source/documentPageSource';
import {
    createDocumentThumbnailMetricsCache,
    DOCUMENT_THUMBNAIL_METRICS_CACHE_LIMIT,
} from '@app/modules/document-viewer/thumbnails/documentThumbnailMetricsCache';

function metrics(pageNumber: number) {
    return Promise.resolve<IDocumentPageMetrics>({
        widthPoints: 500 + pageNumber,
        heightPoints: 700,
        rotation: 0,
    });
}

describe('createDocumentThumbnailMetricsCache', () => {
    it('keeps every page while the demand window fits the budget', () => {
        const cache = createDocumentThumbnailMetricsCache(4);
        const stored = [
            1,
            2,
            3,
            4,
        ].map(pageNumber => {
            const promise = metrics(pageNumber);
            cache.set(pageNumber, promise);
            return promise;
        });

        expect(cache.size).toBe(4);
        expect(cache.get(1)).toBe(stored[0]);
        expect(cache.get(4)).toBe(stored[3]);
    });

    it('evicts the least recently used page at the budget boundary', () => {
        const cache = createDocumentThumbnailMetricsCache(3);
        cache.set(1, metrics(1));
        cache.set(2, metrics(2));
        cache.set(3, metrics(3));
        expect(cache.size).toBe(3);

        cache.set(4, metrics(4));

        expect(cache.size).toBe(3);
        expect(cache.peek(1)).toBeUndefined();
        expect(cache.peek(2)).toBeDefined();
        expect(cache.peek(4)).toBeDefined();
    });

    it('promotes a hit so a hot page outlives colder neighbours', () => {
        const cache = createDocumentThumbnailMetricsCache(3);
        cache.set(1, metrics(1));
        cache.set(2, metrics(2));
        cache.set(3, metrics(3));

        expect(cache.get(1)).toBeDefined();
        cache.set(4, metrics(4));

        expect(cache.peek(1)).toBeDefined();
        expect(cache.peek(2)).toBeUndefined();
    });

    it('re-setting a resident page refreshes it without growing the cache', () => {
        const cache = createDocumentThumbnailMetricsCache(2);
        cache.set(1, metrics(1));
        cache.set(2, metrics(2));
        const replacement = metrics(1);
        cache.set(1, replacement);

        expect(cache.size).toBe(2);
        expect(cache.peek(1)).toBe(replacement);

        cache.set(3, metrics(3));

        expect(cache.peek(2)).toBeUndefined();
        expect(cache.peek(1)).toBe(replacement);
    });

    it('peeks without changing eviction order', () => {
        const cache = createDocumentThumbnailMetricsCache(2);
        cache.set(1, metrics(1));
        cache.set(2, metrics(2));

        expect(cache.peek(1)).toBeDefined();
        cache.set(3, metrics(3));

        expect(cache.peek(1)).toBeUndefined();
        expect(cache.peek(2)).toBeDefined();
    });

    it('drops and clears entries on demand', () => {
        const cache = createDocumentThumbnailMetricsCache(4);
        cache.set(1, metrics(1));
        cache.set(2, metrics(2));

        cache.delete(1);
        expect(cache.peek(1)).toBeUndefined();
        expect(cache.size).toBe(1);

        cache.clear();
        expect(cache.size).toBe(0);
        expect(cache.peek(2)).toBeUndefined();
    });

    it('stays inside its budget while a very large document streams through', () => {
        const cache = createDocumentThumbnailMetricsCache();
        for (let pageNumber = 1; pageNumber <= 5000; pageNumber += 1) {
            cache.set(pageNumber, metrics(pageNumber));
            expect(cache.size).toBeLessThanOrEqual(DOCUMENT_THUMBNAIL_METRICS_CACHE_LIMIT);
        }

        expect(cache.size).toBe(DOCUMENT_THUMBNAIL_METRICS_CACHE_LIMIT);
        expect(cache.peek(1)).toBeUndefined();
        expect(cache.peek(5000)).toBeDefined();
        expect(cache.limit).toBe(DOCUMENT_THUMBNAIL_METRICS_CACHE_LIMIT);
    });

    it('never drops below a single entry regardless of the requested limit', () => {
        const cache = createDocumentThumbnailMetricsCache(0);
        const promise = metrics(7);
        cache.set(7, promise);

        expect(cache.limit).toBe(1);
        expect(cache.peek(7)).toBe(promise);
    });

    it('does not swallow rejections of cached promises', async () => {
        const cache = createDocumentThumbnailMetricsCache(2);
        const failure = Promise.reject(new Error('metrics failed'));
        const onRejected = vi.fn();
        cache.set(1, failure);

        await cache.get(1)?.catch(onRejected);

        expect(onRejected).toHaveBeenCalledTimes(1);
    });
});
