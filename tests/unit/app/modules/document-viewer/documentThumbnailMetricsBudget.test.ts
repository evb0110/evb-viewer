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
import {
    countDocumentThumbnailCalls,
    createDocumentThumbnailSourceHarness,
    documentThumbnailRow,
    installDocumentThumbnailListEnvironment,
    mountDocumentThumbnailList,
    restoreDocumentThumbnailListEnvironment,
    scrollDocumentThumbnailRail,
    scrollToRenderedPage,
    settleDocumentThumbnailList,
} from '@tests/helpers/document-viewer/documentThumbnailListHarness';

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
    installDocumentThumbnailListEnvironment();
});

afterEach(restoreDocumentThumbnailListEnvironment);

describe('document thumbnail retained surfaces', () => {
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

    it('keeps completed pixels on a return journey, measuring only the document\'s slot shape', async () => {
        const harness = createDocumentThumbnailSourceHarness(5000, '/budget.pdf');
        const {host} = mountDocumentThumbnailList(harness.source);
        await settleDocumentThumbnailList();
        const target = await scrollToRenderedPage(harness, host, 10_000);
        await scrollAwayAndBack(host, 10_000);
        expect(countDocumentThumbnailCalls(harness.renderCalls, target)).toBe(1);
        // The first, middle and last pages give the slot shape, once; the
        // journey itself asks for no page's geometry.
        expect([...harness.metricsCalls].sort((left, right) => left - right)).toEqual([
            1,
            2500,
            5000,
        ]);
    });

    it('shapes the slots like the source\'s pages and again when a reload turns them', async () => {
        const frameAspect = (host: HTMLElement) => host
            .querySelector<HTMLElement>('[data-thumbnail-page="1"] .document-thumbnail-list__frame')
            ?.style.aspectRatio ?? '';
        const spreads = createDocumentThumbnailSourceHarness(12, '/book.pdf', {
            widthPoints: 793,
            heightPoints: 566,
        });
        const {
            host,
            setSource,
        } = mountDocumentThumbnailList(spreads.source, true, () => 'revision');
        await settleDocumentThumbnailList();
        expect(parseFloat(frameAspect(host))).toBeCloseTo(793 / 566, 3);

        // Every page turned by a page operation: the same document reloads.
        const turned = createDocumentThumbnailSourceHarness(12, '/book.pdf', {
            widthPoints: 566,
            heightPoints: 793,
        });
        setSource(turned.source);
        await settleDocumentThumbnailList();
        expect(parseFloat(frameAspect(host))).toBeCloseTo(566 / 793, 3);
    });

    it('keeps the current page in view when a later-measured slot shape moves it', async () => {
        const spreads = createDocumentThumbnailSourceHarness(12, '/spreads.pdf', {
            widthPoints: 793,
            heightPoints: 566,
        });
        const {
            host,
            setCurrentPage,
            setSource,
        } = mountDocumentThumbnailList(spreads.source);
        await settleDocumentThumbnailList();

        // A portrait book opened at page 4 whose page sizes arrive late: it is
        // first laid out in the spread book's short slots.
        let reportSizes!: () => void;
        const sizesReported = new Promise<void>((resolve) => {
            reportSizes = resolve;
        });
        const portrait = createDocumentThumbnailSourceHarness(12, '/portrait.pdf');
        setCurrentPage(4);
        setSource({
            ...portrait.source,
            getPageMetrics: async (pageNumber, signal) => {
                await sizesReported;
                return portrait.source.getPageMetrics(pageNumber, signal);
            },
        });
        await settleDocumentThumbnailList();
        reportSizes();
        await settleDocumentThumbnailList();

        const rail = host.querySelector<HTMLElement>('[data-document-thumbnail-rail]')!;
        const row = documentThumbnailRow(host, 4)!;
        const top = Number(/translateY\((-?[\d.]+)px\)/.exec(row.style.transform)?.[1]);
        const bottom = top + parseFloat(row.style.height);
        expect(parseFloat(host.querySelector<HTMLElement>('[data-thumbnail-page="4"] .document-thumbnail-list__frame')!
            .style.aspectRatio)).toBeCloseTo(500 / 700, 3);
        expect(top, `page 4 spans ${String(top)}..${String(bottom)}, the rail shows ${String(rail.scrollTop)}+600`)
            .toBeGreaterThanOrEqual(rail.scrollTop);
        expect(bottom).toBeLessThanOrEqual(rail.scrollTop + 600);
    });

    it('starts a replacement document from an empty budget instead of stacking documents', async () => {
        const first = createDocumentThumbnailSourceHarness(5000, '/first.pdf');
        const {setSource} = mountDocumentThumbnailList(first.source);
        await settleDocumentThumbnailList();
        const firstMeasurements = first.renderCalls.length;
        expect(firstMeasurements).toBeGreaterThan(0);

        const second = createDocumentThumbnailSourceHarness(5000, '/second.pdf');
        setSource(second.source);
        await settleDocumentThumbnailList();

        // The second document renders its own pages, and the first one is not
        // asked again while it is off screen.
        expect(second.renderCalls.length).toBeGreaterThan(0);
        expect(first.renderCalls.length).toBe(firstMeasurements);

        setSource(first.source);
        await settleDocumentThumbnailList();

        // Returning re-renders instead of reading entries the first document
        // left behind, which is what keeps the cache from growing per document.
        expect(first.renderCalls.length).toBeGreaterThan(firstMeasurements);
        expect(countDocumentThumbnailCalls(first.renderCalls, 1)).toBe(2);
    });
});
