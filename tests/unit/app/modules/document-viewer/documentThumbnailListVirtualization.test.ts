// @vitest-environment happy-dom

import type * as TViMockOriginalModule from '@app/composables/useTypedI18n';

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createApp, h, nextTick, ref} from 'vue';
import DocumentThumbnailList from '@app/components/document-viewer/DocumentThumbnailList.vue';
import {placeDocumentThumbnailRailsWithin} from '@app/modules/document-viewer/thumbnails/useDocumentThumbnailController';
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

// Relocation needs actual row positions. The shared raster harness gives all
// elements one frame rectangle, which cannot identify the viewport's anchor.
function measureRailRows(padding = 0) {
    const style = document.createElement('style');
    style.textContent = `[data-document-thumbnail-rail] { padding: ${String(padding)}px; }`;
    document.body.append(style);
    const fallback = vi.mocked(HTMLElement.prototype.getBoundingClientRect).getMockImplementation()!;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        const rail = this.closest<HTMLElement>('[data-document-thumbnail-rail]');
        if (!rail || (this !== rail && !this.matches('[data-thumbnail-page]'))) {
            return fallback.call(this);
        }
        const top = this === rail ? 0 : padding + Number.parseFloat(this.style.transform.slice(11)) - rail.scrollTop;
        const height = this === rail ? 600 : Number.parseFloat(this.style.height);
        return {
            ...fallback.call(this),
            top,
            y: top,
            bottom: top + height,
            height,
        };
    });
}

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
            await vi.advanceTimersByTimeAsync(200);
            await scrollDocumentThumbnailRail(host, 34_637_992);
        }

        const rows = host.querySelectorAll('[data-document-thumbnail-item]');
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.length).toBeLessThan(30);
        expect(host.querySelector('[data-thumbnail-page="138000"]')).not.toBeNull();
        expect(host.querySelector('[data-thumbnail-page="1"]')).toBeNull();
        expect(
            Number(host.querySelector('[data-thumbnail-scroll-segment]')?.getAttribute('data-thumbnail-scroll-segment')),
        ).toBeGreaterThan(0);
    });

    it('places the source rail against the patched track after a clamp and geometry growth', async () => {
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

        rail.scrollTop = 500;
        expect(rail.scrollTop).toBe(0);
        mounted.setCurrentPage(20);
        await nextTick();
        mounted.setActive(false);
        await nextTick();
        mounted.setActive(true);
        await nextTick();
        widenDocumentThumbnailFrames(300);
        mounted.setItemMetricsKey(1);
        maxScrollTop = 2_000;
        await settleDocumentThumbnailList();

        expect(rail.scrollTop).toBeGreaterThan(0);
    });

    it('places a rail that detaches and remounts while placement is pending', async () => {
        measureRailRows();
        const harness = createDocumentThumbnailSourceHarness(500);
        const mounted = mountDocumentThumbnailList(harness.source);
        await settleDocumentThumbnailList();
        await scrollDocumentThumbnailRail(mounted.host, 4_200);
        const rail = mounted.host.querySelector<HTMLElement>('[data-document-thumbnail-rail]')!;
        const placement = placeDocumentThumbnailRailsWithin(mounted.host);
        rail.remove();
        rail.scrollTop = 0;
        mounted.host.append(rail);
        await placement;
        expect(rail.scrollTop).toBe(4_200);
    });

    it('places padded rails after splitting and closing the empty split, keeps cooldown and leaves unrelated scrollers alone', async () => {
        measureRailRows(8);
        const harness = createDocumentThumbnailSourceHarness(500);
        const mounted = mountDocumentThumbnailList(harness.source);
        await settleDocumentThumbnailList();
        await scrollDocumentThumbnailRail(mounted.host, 4_200);
        const rail = mounted.host.querySelector<HTMLElement>('[data-document-thumbnail-rail]')!;
        const pane = document.createElement('div');
        const split = document.createElement('div');
        const emptyPane = document.createElement('div');
        const unrelatedScroller = document.createElement('div');
        document.body.append(split);
        split.append(pane, emptyPane);
        pane.append(rail, unrelatedScroller);
        await vi.advanceTimersByTimeAsync(800);
        rail.scrollTop = 0;
        unrelatedScroller.scrollTop = 900;
        await placeDocumentThumbnailRailsWithin(pane);
        expect.soft(rail.scrollTop).toBe(4_200);
        expect(unrelatedScroller.scrollTop).toBe(900);
        mounted.setCurrentPage(30);
        await settleDocumentThumbnailList();
        expect(rail.scrollTop).toBe(4_200);

        // Closing the empty sibling moves the same persistent pane back out
        // of the split; its rail must keep the anchor on that move as well.
        split.replaceWith(pane);
        rail.scrollTop = 0;
        await placeDocumentThumbnailRailsWithin(pane);
        expect(rail.scrollTop).toBe(4_200);
        expect(unrelatedScroller.scrollTop).toBe(900);

        // Scrolling and immediately relocating before the queued scroll frame runs
        // must restore the scrolled offset rather than the Teleport-reset 0.
        rail.scrollTop = 6_400;
        rail.dispatchEvent(new Event('scroll'));
        rail.scrollTop = 0;
        await placeDocumentThumbnailRailsWithin(pane);
        expect(rail.scrollTop).toBe(6_400);
    });

    it('skips a disconnected rail when its pending relocation placement completes', async () => {
        measureRailRows();
        const harness = createDocumentThumbnailSourceHarness(500);
        const mounted = mountDocumentThumbnailList(harness.source);
        await settleDocumentThumbnailList();
        await scrollDocumentThumbnailRail(mounted.host, 800);
        const rail = mounted.host.querySelector<HTMLElement>('[data-document-thumbnail-rail]')!;
        const placement = placeDocumentThumbnailRailsWithin(mounted.host);
        rail.remove();
        rail.scrollTop = 0;
        await placement;
        expect(rail.scrollTop).toBe(0);
        mounted.host.append(rail);
    });

    it('keeps the semantic position when track geometry changes during relocation', async () => {
        measureRailRows();
        const harness = createDocumentThumbnailSourceHarness(500);
        const mounted = mountDocumentThumbnailList(harness.source);
        await settleDocumentThumbnailList();
        await scrollDocumentThumbnailRail(mounted.host, 4_200);
        const rail = mounted.host.querySelector<HTMLElement>('[data-document-thumbnail-rail]')!;
        const track = rail.querySelector<HTMLElement>('.document-thumbnail-list__content')!;
        const heightBefore = Number.parseFloat(track.style.height);
        const anchorRow = Array.from(rail.querySelectorAll<HTMLElement>('[data-thumbnail-page]')).find((row) => {
            const rect = row.getBoundingClientRect();
            return rect.top <= 300 && rect.bottom >= 300;
        })!;
        const anchorPage = anchorRow.dataset.thumbnailPage;
        const beforeRect = anchorRow.getBoundingClientRect();
        const anchorRatio = (300 - beforeRect.top) / beforeRect.height;
        // Reuse the rail's semantic position, then let the same Vue patch
        // install wider rows in its new pane before placement resolves.
        const placement = placeDocumentThumbnailRailsWithin(mounted.host);
        widenDocumentThumbnailFrames(300);
        measureRailRows();
        mounted.setItemMetricsKey(1);
        rail.scrollTop = 0;
        await placement;
        await settleDocumentThumbnailList();
        const heightAfter = Number.parseFloat(track.style.height);
        expect(heightAfter).toBeGreaterThan(heightBefore);
        const afterRect = rail.querySelector<HTMLElement>(`[data-thumbnail-page="${anchorPage}"]`)!.getBoundingClientRect();
        expect(Math.abs(afterRect.top + afterRect.height * anchorRatio - 300)).toBeLessThanOrEqual(1);
    });

    it('preserves a pending scroll position when resize starts before the scroll frame flushes', async () => {
        measureRailRows();
        const harness = createDocumentThumbnailSourceHarness(500);
        const isResizing = ref(false);
        const host = document.createElement('div');
        document.body.append(host);
        const app = createApp({
            render: () =>
                h(DocumentThumbnailList, {
                    source: harness.source,
                    currentPage: 1,
                    isActive: true,
                    isResizing: isResizing.value,
                }),
        });
        app.component('UIcon', {render: () => h('span')});
        app.mount(host);
        try {
            await settleDocumentThumbnailList();
            const rail = host.querySelector<HTMLElement>('[data-document-thumbnail-rail]')!;
            expect(rail.scrollTop).toBe(0);

            // Scroll, then begin resizing before the queued rAF runs.
            rail.scrollTop = 4_200;
            rail.dispatchEvent(new Event('scroll'));
            isResizing.value = true;
            await nextTick();
            await settleDocumentThumbnailList();

            // Releasing resize must restore the post-scroll position, not 0.
            rail.scrollTop = 0;
            isResizing.value = false;
            await nextTick();
            await settleDocumentThumbnailList();
            expect(rail.scrollTop).toBe(4_200);
        } finally {
            app.unmount();
            host.remove();
        }
    });

    it('preserves a pending scroll anchor across same-document page-count replacement and frozen resize relocation', async () => {
        measureRailRows();
        const initial = createDocumentThumbnailSourceHarness(500);
        const replacement = createDocumentThumbnailSourceHarness(505);
        const activeSource = ref(initial.source);
        const isResizing = ref(false);
        const host = document.createElement('div');
        document.body.append(host);
        const app = createApp({
            render: () =>
                h(DocumentThumbnailList, {
                    source: activeSource.value,
                    currentPage: 1,
                    isActive: true,
                    isResizing: isResizing.value,
                }),
        });
        app.component('UIcon', {render: () => h('span')});
        app.mount(host);
        try {
            await settleDocumentThumbnailList();
            const rail = host.querySelector<HTMLElement>('[data-document-thumbnail-rail]')!;

            // Scroll, then immediately replace the same document with a different page count before refresh.
            rail.scrollTop = 4_200;
            rail.dispatchEvent(new Event('scroll'));
            activeSource.value = replacement.source;
            await nextTick();
            await settleDocumentThumbnailList();
            expect(rail.scrollTop).toBe(4_200);

            // Start resize at 4_200, emit a mid-resize scroll, relocate, then release resize:
            // the starting anchor (4_200) must remain frozen through resize.
            isResizing.value = true;
            await nextTick();
            rail.scrollTop = 1_200;
            rail.dispatchEvent(new Event('scroll'));
            rail.scrollTop = 0;
            await placeDocumentThumbnailRailsWithin(host);
            expect(rail.scrollTop).toBe(4_200);
            isResizing.value = false;
            await nextTick();
            await settleDocumentThumbnailList();
            expect(rail.scrollTop).toBe(4_200);
        } finally {
            app.unmount();
            host.remove();
        }
    });
});
