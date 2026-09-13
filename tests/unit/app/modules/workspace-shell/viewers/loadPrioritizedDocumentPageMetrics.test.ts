import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    createColdOpenProvisionalDocumentPageMetrics,
    createProvisionalDocumentPageMetrics,
    hydrateRemainingDocumentPageMetrics,
    isSparseDocumentPageMetrics,
    loadInitialDocumentPageMetric,
} from '@app/modules/workspace-shell/viewers/loadPrioritizedDocumentPageMetrics';
import { requireDocumentRef } from '@contracts/documentRef';
import type { IDocumentPageSource } from '@app/modules/document-viewer/source/documentPageSource';

function createSource(pageCount: number) {
    const calls: number[] = [];
    const source: IDocumentPageSource = {
        kind: 'djvu',
        documentRef: requireDocumentRef('/documents/scan.djvu'),
        pageCount,
        async getPageMetrics(pageNumber: number) {
            calls.push(pageNumber);
            return {
                widthPoints: 600 + pageNumber,
                heightPoints: 800 + pageNumber,
                rotation: 0 as const,
            };
        },
        renderPage: vi.fn(async () => {
            throw new Error('renderPage is outside this metrics test');
        }),
        dispose: vi.fn(),
    };
    return {
        calls,
        source,
    };
}

describe('prioritized document page metrics', () => {
    it('keeps a stable cold-open page frame before trusted metrics arrive', () => {
        const metrics = createColdOpenProvisionalDocumentPageMetrics(7);

        expect(metrics).toHaveLength(7);
        expect(metrics[6]).toEqual({
            widthPoints: 612,
            heightPoints: 792,
            rotation: 0,
        });
    });

    it('creates a complete provisional page-shell model from the prioritized metric', () => {
        const initialMetric = {
            widthPoints: 600,
            heightPoints: 800,
            rotation: 0 as const,
        };

        const metrics = createProvisionalDocumentPageMetrics(431, initialMetric);

        expect(metrics).toHaveLength(431);
        expect(metrics.every(metric => (
            metric.widthPoints === 600
            && metric.heightPoints === 800
            && metric.rotation === 0
        ))).toBe(true);
        expect(metrics[0]).not.toBe(metrics[1]);
    });

    it('keeps a million-page provisional model sparse', () => {
        const arrayFrom = vi.spyOn(Array, 'from');
        const metrics = createProvisionalDocumentPageMetrics(1_000_000, {
            widthPoints: 600,
            heightPoints: 800,
            rotation: 0,
        });

        expect(metrics).toHaveLength(1_000_000);
        expect(isSparseDocumentPageMetrics(metrics)).toBe(true);
        expect(Object.keys(metrics).filter(key => /^\d+$/.test(key))).toEqual([]);
        expect(metrics[999_999]).toEqual({
            widthPoints: 600,
            heightPoints: 800,
            rotation: 0,
        });
        expect(arrayFrom).not.toHaveBeenCalled();
        arrayFrom.mockRestore();
    });

    it('loads only the initial page on the first-visual critical path', async () => {
        const {
            calls,
            source,
        } = createSource(400);
        const metric = await loadInitialDocumentPageMetric(source, 7, new AbortController().signal);

        expect(calls).toEqual([7]);
        expect(metric).toMatchObject({
            widthPoints: 607,
            heightPoints: 807,
        });
    });

    it('hydrates remaining metrics nearest-first after the initial page commits', async () => {
        const {
            calls,
            source,
        } = createSource(5);
        const metrics = await hydrateRemainingDocumentPageMetrics({
            source,
            initialPage: 3,
            initialMetric: {
                widthPoints: 603,
                heightPoints: 803,
                rotation: 0,
            },
            signal: new AbortController().signal,
            isCurrent: () => true,
            concurrency: 1,
        });

        expect(calls).toEqual([
            2,
            4,
            1,
            5,
        ]);
        expect(metrics?.map(metric => metric.widthPoints)).toEqual([
            601,
            602,
            603,
            604,
            605,
        ]);
    });

    it('publishes exact metrics incrementally instead of waiting for the full document', async () => {
        const {
            calls,
            source,
        } = createSource(4);
        const published: number[] = [];

        await hydrateRemainingDocumentPageMetrics({
            source,
            initialPage: 1,
            initialMetric: {
                widthPoints: 601,
                heightPoints: 801,
                rotation: 0,
            },
            signal: new AbortController().signal,
            isCurrent: () => true,
            concurrency: 1,
            onMetric: pageNumber => published.push(pageNumber),
        });

        expect(published).toEqual(calls);
        expect(published).toEqual([
            2,
            3,
            4,
        ]);
    });

    it('reprioritizes the next metric around the latest requested target page', async () => {
        const {
            calls,
            source,
        } = createSource(6);
        let priorityPage = 2;

        await hydrateRemainingDocumentPageMetrics({
            source,
            initialPage: 1,
            initialMetric: {
                widthPoints: 601,
                heightPoints: 801,
                rotation: 0,
            },
            signal: new AbortController().signal,
            isCurrent: () => true,
            concurrency: 1,
            getPriorityPage: () => priorityPage,
            onMetric: () => {
                priorityPage = 6;
            },
        });

        expect(calls.slice(0, 2)).toEqual([
            2,
            6,
        ]);
    });

    it('does not hydrate sparse metrics in a large document', async () => {
        const {
            calls,
            source,
        } = createSource(1_000_000);

        const metrics = await hydrateRemainingDocumentPageMetrics({
            source,
            initialPage: 500_000,
            initialMetric: {
                widthPoints: 600,
                heightPoints: 800,
                rotation: 0,
            },
            signal: new AbortController().signal,
            isCurrent: () => true,
            concurrency: 1,
            getPriorityPages: () => [
                500_000,
                499_999,
                500_001,
                500_002,
                499_998,
            ],
            maxHydratedPages: 3,
        });

        expect(calls).toEqual([]);
        expect(metrics).not.toBeNull();
        if (!metrics || !isSparseDocumentPageMetrics(metrics)) {
            throw new Error('expected sparse metrics');
        }
        expect(metrics.exactPageCount).toBe(1);
        expect(metrics).toHaveLength(1_000_000);
    });

    it('keeps nearest-first scheduling practical for very large scans', async () => {
        const {
            calls,
            source,
        } = createSource(40_000);

        const metrics = await hydrateRemainingDocumentPageMetrics({
            source,
            initialPage: 20_000,
            initialMetric: {
                widthPoints: 20_600,
                heightPoints: 20_800,
                rotation: 0,
            },
            signal: new AbortController().signal,
            isCurrent: () => true,
            concurrency: 1,
        });

        if (metrics === null || !isSparseDocumentPageMetrics(metrics)) {
            throw new Error('large document metrics must remain sparse');
        }
        expect(metrics).toHaveLength(40_000);
        expect(metrics.exactPageCount).toBe(1);
        expect(calls).toEqual([]);
        expect(metrics?.[20_000]).toEqual({
            widthPoints: 20_600,
            heightPoints: 20_800,
            rotation: 0,
        });
    });

    it('drops background metrics when the source generation is superseded', async () => {
        const {
            calls,
            source,
        } = createSource(5);
        let current = true;
        const originalGetPageMetrics = source.getPageMetrics.bind(source);
        source.getPageMetrics = async (pageNumber, signal) => {
            const metric = await originalGetPageMetrics(pageNumber, signal);
            current = false;
            return metric;
        };

        await expect(hydrateRemainingDocumentPageMetrics({
            source,
            initialPage: 1,
            initialMetric: {
                widthPoints: 601,
                heightPoints: 801,
                rotation: 0,
            },
            signal: new AbortController().signal,
            isCurrent: () => current,
            concurrency: 1,
        })).resolves.toBeNull();
        expect(calls).toEqual([2]);
    });

    it('does not enumerate a million-page background hydration', async () => {
        const {
            calls,
            source,
        } = createSource(1_000_000);
        const controller = new AbortController();
        source.getPageMetrics = async (pageNumber, signal) => {
            calls.push(pageNumber);
            controller.abort();
            signal?.throwIfAborted();
            return {
                widthPoints: 600,
                heightPoints: 800,
                rotation: 0,
            };
        };

        const metrics = await hydrateRemainingDocumentPageMetrics({
            source,
            initialPage: 500_000,
            initialMetric: {
                widthPoints: 600,
                heightPoints: 800,
                rotation: 0,
            },
            signal: controller.signal,
            isCurrent: () => true,
            concurrency: 1,
        });
        expect(metrics).toHaveLength(1_000_000);
        expect(calls).toEqual([]);
    });
});
