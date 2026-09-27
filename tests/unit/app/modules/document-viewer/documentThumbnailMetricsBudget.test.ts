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

    it('keeps completed pixels on a return journey without asking for page geometry', async () => {
        const harness = createDocumentThumbnailSourceHarness(5000, '/budget.pdf');
        const {host} = mountDocumentThumbnailList(harness.source);
        await settleDocumentThumbnailList();
        const target = await scrollToRenderedPage(harness, host, 10_000);
        await scrollAwayAndBack(host, 10_000);
        expect(countDocumentThumbnailCalls(harness.renderCalls, target)).toBe(1);
        expect(harness.metricsCalls).toEqual([]);
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
