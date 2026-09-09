// @vitest-environment happy-dom

import type * as TViMockOriginalModule from '@app/composables/useTypedI18n';

import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type {IDocumentThumbnailMetricsCache} from '@app/utils/document-viewer/thumbnails/documentThumbnailMetricsCache';
import {DOCUMENT_THUMBNAIL_METRICS_CACHE_LIMIT} from '@app/utils/document-viewer/thumbnails/documentThumbnailMetricsCache';
import {
    countDocumentThumbnailCalls,
    createDocumentThumbnailSourceHarness,
    installDocumentThumbnailListEnvironment,
    mountDocumentThumbnailList,
    restoreDocumentThumbnailListEnvironment,
    scrollDocumentThumbnailRail,
    scrollToRenderedPage,
    settleDocumentThumbnailList,
} from '@tests/helpers/document-viewer/documentThumbnailListHarness';

interface IMetricsCacheModule {
    createDocumentThumbnailMetricsCache: (limit?: number) => IDocumentThumbnailMetricsCache;
    DOCUMENT_THUMBNAIL_METRICS_CACHE_LIMIT: number;
}

let metricsCacheLimit = DOCUMENT_THUMBNAIL_METRICS_CACHE_LIMIT;

// The controller owns the shipped budget, so the only way to exercise the
// eviction path at unit speed is to hand it a smaller cache of the same kind.
vi.mock('@app/utils/document-viewer/thumbnails/documentThumbnailMetricsCache', async (importOriginal) => {
    const actual = await importOriginal<IMetricsCacheModule>();
    return {
        ...actual,
        createDocumentThumbnailMetricsCache: () => actual.createDocumentThumbnailMetricsCache(metricsCacheLimit),
    };
});

vi.mock('@app/composables/useTypedI18n', async (importOriginal_1) => ({
    ...(await importOriginal_1<typeof TViMockOriginalModule>()),
    useTypedI18n: () => ({t: (key: string) => key}),
}));

/** Walks far enough away that any page-metrics budget smaller than the trip is exceeded. */
async function scrollAwayAndBack(host: HTMLElement, target: number) {
    for (const offset of [
        20_000,
        40_000,
        60_000,
        80_000,
    ]) await scrollDocumentThumbnailRail(host, offset);
    await scrollDocumentThumbnailRail(host, target);
}

beforeEach(() => {
    metricsCacheLimit = DOCUMENT_THUMBNAIL_METRICS_CACHE_LIMIT;
    installDocumentThumbnailListEnvironment();
});

afterEach(restoreDocumentThumbnailListEnvironment);

describe('document thumbnail page-metrics budget', () => {
    it('releases thumbnail surfaces and stops rendering while the workspace is inactive', async () => {
        const harness = createDocumentThumbnailSourceHarness();
        const {setActive} = mountDocumentThumbnailList(harness.source);
        await settleDocumentThumbnailList();
        const callsBeforeDeactivation = harness.renderCalls.length;

        setActive(false);
        await settleDocumentThumbnailList();

        expect(harness.renderCalls.length).toBe(callsBeforeDeactivation);
        setActive(true);
        await settleDocumentThumbnailList();
        expect(harness.renderCalls.length).toBeGreaterThan(callsBeforeDeactivation);
    });

    it('measures a hot page once no matter how often it is rendered', async () => {
        const harness = createDocumentThumbnailSourceHarness(5000, '/budget.pdf');
        const {host} = mountDocumentThumbnailList(harness.source);
        await settleDocumentThumbnailList();

        await scrollDocumentThumbnailRail(host, 6_000);
        await scrollDocumentThumbnailRail(host, 0);

        const rendered = new Set(harness.renderCalls);
        expect(rendered.size).toBeGreaterThan(0);
        for (const pageNumber of rendered) {
            expect(countDocumentThumbnailCalls(harness.metricsCalls, pageNumber), String(pageNumber)).toBe(1);
        }
    });

    it('re-measures a page the budget evicted instead of holding every page of a huge document', async () => {
        metricsCacheLimit = 4;
        const harness = createDocumentThumbnailSourceHarness(5000, '/budget.pdf');
        const {host} = mountDocumentThumbnailList(harness.source);
        await settleDocumentThumbnailList();

        const target = await scrollToRenderedPage(harness, host, 10_000);
        const measurementsBefore = countDocumentThumbnailCalls(harness.metricsCalls, target);

        await scrollAwayAndBack(host, 10_000);

        expect(countDocumentThumbnailCalls(harness.renderCalls, target)).toBeGreaterThan(1);
        expect(countDocumentThumbnailCalls(harness.metricsCalls, target)).toBeGreaterThan(measurementsBefore);
        expect(new Set(harness.metricsCalls).size).toBeGreaterThan(metricsCacheLimit);
    });

    it('keeps the same journey to a single measurement per page at the shipped budget', async () => {
        const harness = createDocumentThumbnailSourceHarness(5000, '/budget.pdf');
        const {host} = mountDocumentThumbnailList(harness.source);
        await settleDocumentThumbnailList();

        const target = await scrollToRenderedPage(harness, host, 10_000);

        await scrollAwayAndBack(host, 10_000);

        expect(countDocumentThumbnailCalls(harness.renderCalls, target)).toBeGreaterThan(1);
        expect(countDocumentThumbnailCalls(harness.metricsCalls, target)).toBe(1);
    });

    it('starts a replacement document from an empty budget instead of stacking documents', async () => {
        const first = createDocumentThumbnailSourceHarness(5000, '/first.pdf');
        const {setSource} = mountDocumentThumbnailList(first.source);
        await settleDocumentThumbnailList();
        const firstMeasurements = first.metricsCalls.length;
        expect(firstMeasurements).toBeGreaterThan(0);

        const second = createDocumentThumbnailSourceHarness(5000, '/second.pdf');
        setSource(second.source);
        await settleDocumentThumbnailList();

        // The second document measures its own pages, and the first one is not
        // asked again while it is off screen.
        expect(second.metricsCalls.length).toBeGreaterThan(0);
        expect(first.metricsCalls.length).toBe(firstMeasurements);

        setSource(first.source);
        await settleDocumentThumbnailList();

        // Returning re-measures instead of reading entries the first document
        // left behind, which is what keeps the cache from growing per document.
        expect(first.metricsCalls.length).toBeGreaterThan(firstMeasurements);
        expect(countDocumentThumbnailCalls(first.metricsCalls, 1)).toBe(2);
    });
});
