import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    computed,
    ref,
} from 'vue';
import {usePdfThumbnailVirtualLayout} from '@app/modules/pdf-viewer/thumbnails/usePdfThumbnailVirtualLayout';
import type {IPdfPageMetric} from '@app/types/pdfUi';
import {DOCUMENT_THUMBNAIL_SCROLL_SEGMENT_MAX_HEIGHT} from '@app/utils/document-viewer/thumbnails/documentThumbnailLayout';

describe('usePdfThumbnailVirtualLayout', () => {
    it('projects sparse page metrics without allocating by page count', () => {
        const pageCount = ref(1_000_000);
        const scheduleReaction = vi.fn();
        const layout = usePdfThumbnailVirtualLayout({
            captureAnchor: () => null,
            pageCount: computed(() => pageCount.value),
            scheduleReaction,
        });

        expect(layout.hasExactAspects()).toBe(false);
        expect(layout.layout.value.getLoadedBlockCount()).toBe(0);

        const metrics: IPdfPageMetric[] = [];
        metrics.length = pageCount.value;
        metrics[999_998] = {
            height: 180,
            width: 100,
        };
        layout.applyPageMetrics(metrics);

        expect(layout.getExactAspect(999_999)).toBe(1.8);
        expect(layout.hasExactAspects()).toBe(true);
        expect(layout.layout.value.getLoadedBlockCount()).toBe(1);
        expect(scheduleReaction).toHaveBeenCalledTimes(1);

        layout.applyPageMetrics(metrics);

        expect(scheduleReaction).toHaveBeenCalledTimes(1);
    });

    it('estimates unmeasured pages from the most common known aspect in one commit', () => {
        const pageCount = ref(200);
        const scheduleReaction = vi.fn();
        const layout = usePdfThumbnailVirtualLayout({
            captureAnchor: () => null,
            pageCount,
            scheduleReaction,
        });

        const metrics: IPdfPageMetric[] = [];
        metrics.length = pageCount.value;
        metrics[0] = {
            height: 150,
            width: 100,
        };
        for (let index = 98; index <= 102; index += 1) {
            metrics[index] = {
                height: 160,
                width: 100,
            };
        }
        layout.applyPageMetrics(metrics);

        expect(scheduleReaction).toHaveBeenCalledTimes(1);
        expect(layout.getExactAspect(1)).toBe(1.5);
        expect(layout.getExactAspect(50)).toBeUndefined();
        expect(layout.getAspect(50)).toBe(1.6);
        expect(layout.getPageBounds(50).height).toBe(layout.getPageBounds(100).height);

        layout.resetDocumentLayout();

        expect(layout.hasExactAspects()).toBe(false);
        expect(layout.layout.value.getLoadedBlockCount()).toBe(0);
        expect(layout.contentHeight.value).toBeGreaterThan(0);
    });

    it('maps the last page into a bounded physical segment', () => {
        const pageCount = ref(138_000);
        const layout = usePdfThumbnailVirtualLayout({
            captureAnchor: () => null,
            pageCount,
            scheduleReaction: () => {},
        });

        layout.setActiveScrollSegmentForPage(pageCount.value);

        expect(layout.activeScrollSegmentIndex.value).toBeGreaterThan(0);
        expect(layout.contentHeight.value).toBeLessThanOrEqual(DOCUMENT_THUMBNAIL_SCROLL_SEGMENT_MAX_HEIGHT);
        expect(layout.resolvePageAtOffset(layout.contentHeight.value)).toBe(pageCount.value);
        expect(layout.getPageTop(pageCount.value)).toBeLessThan(layout.contentHeight.value);

        const transition = layout.resolveScrollSegmentTransition(
            layout.contentHeight.value,
            0,
            500,
        );
        expect(transition).toBeNull();
    });
});
