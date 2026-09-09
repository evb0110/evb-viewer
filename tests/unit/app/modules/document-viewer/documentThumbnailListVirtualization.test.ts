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
import {nextTick} from 'vue';
import {
    createDocumentThumbnailSourceHarness,
    installDocumentThumbnailListEnvironment,
    mountDocumentThumbnailList,
    restoreDocumentThumbnailListEnvironment,
    scrollDocumentThumbnailRail,
    settleDocumentThumbnailList,
    widenDocumentThumbnailFrames,
} from '@tests/helpers/document-viewer/documentThumbnailListHarness';

vi.mock('@app/composables/useTypedI18n', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    useTypedI18n: () => ({t: (key: string) => key}),
}));

beforeEach(installDocumentThumbnailListEnvironment);
afterEach(restoreDocumentThumbnailListEnvironment);

describe('DocumentThumbnailList virtualization', () => {
    it('keeps a 500-page source to a bounded mounted row count', async () => {
        const harness = createDocumentThumbnailSourceHarness(500, '/large.pdf');
        const {host} = mountDocumentThumbnailList(harness.source);
        await settleDocumentThumbnailList();

        const rows = host.querySelectorAll('[data-document-thumbnail-item]');
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.length).toBeLessThan(30);
        expect(host.querySelectorAll('[data-thumbnail-page]').length).toBe(rows.length);

        // Every raster came from the thumbnail provider. A rail that fell back
        // to full-page renders would rasterize at viewer resolution, which is
        // the cost this bounded row count exists to avoid.
        expect(harness.renderCalls.length).toBeGreaterThan(0);
        expect(harness.pageRenderCalls).toEqual([]);
    });

    it('reaches the last page through bounded physical scroll segments', async () => {
        const harness = createDocumentThumbnailSourceHarness(138_000, '/very-large.pdf');
        const {host} = mountDocumentThumbnailList(harness.source);
        await settleDocumentThumbnailList();

        for (let attempt = 0; attempt < 10; attempt += 1) {
            await scrollDocumentThumbnailRail(host, 34_637_992);
        }

        const rows = host.querySelectorAll('[data-document-thumbnail-item]');
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.length).toBeLessThan(30);
        expect(host.querySelector('[data-thumbnail-page="138000"]')).not.toBeNull();
        expect(host.querySelector('[data-thumbnail-page="1"]')).toBeNull();
        expect(Number(host.querySelector('[data-thumbnail-scroll-segment]')?.getAttribute('data-thumbnail-scroll-segment')))
            .toBeGreaterThan(0);
    });

    it('retries source-rail scroll restoration after a clamped write and late geometry growth', async () => {
        const harness = createDocumentThumbnailSourceHarness(500, '/growing-geometry.pdf');
        const mounted = mountDocumentThumbnailList(harness.source);
        await settleDocumentThumbnailList();

        const rail = mounted.host.querySelector<HTMLElement>('[data-document-thumbnail-rail]')!;
        let maxScrollTop = 0;
        let scrollTop = 0;
        Object.defineProperty(rail, 'scrollTop', {
            configurable: true,
            get: () => scrollTop,
            set: (value: number) => {
                scrollTop = Math.min(Math.max(0, value), maxScrollTop);
            },
        });

        mounted.setCurrentPage(20);
        await nextTick();
        mounted.setActive(false);
        await nextTick();
        mounted.setActive(true);
        await nextTick();
        widenDocumentThumbnailFrames(300);
        mounted.setItemMetricsKey(1);
        await nextTick();
        expect(rail.scrollTop).toBe(0);

        maxScrollTop = 2_000;
        await settleDocumentThumbnailList();

        expect(rail.scrollTop).toBeGreaterThan(0);
    });
});
