import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    DEFAULT_DOCUMENT_THUMBNAIL_ASPECT_RATIO,
    DOCUMENT_THUMBNAIL_SCROLL_SEGMENT_MAX_HEIGHT,
    DocumentThumbnailLayout,
} from '@app/modules/document-viewer/thumbnails/documentThumbnailLayout';

describe('DocumentThumbnailLayout', () => {
    it('grows only the measured row chrome and shifts following virtual rows', () => {
        const layout = new DocumentThumbnailLayout({
            pageCount: 3,
            renderWidth: 100,
            estimatedAspectRatio: 1,
            itemChromeHeight: 30,
            itemGap: 8,
        });
        const previousThirdTop = layout.getPageTop(3);
        const previousTotal = layout.getTotalHeight();

        expect(layout.updatePageChromeHeight(2, 66)).toBe(true);
        expect(layout.getPageHeight(1)).toBe(130);
        expect(layout.getPageHeight(2)).toBe(166);
        expect(layout.getPageTop(3)).toBe(previousThirdTop + 36);
        expect(layout.getTotalHeight()).toBe(previousTotal + 36);

        expect(layout.updatePageChromeHeight(2, null)).toBe(true);
        expect(layout.getPageTop(3)).toBe(previousThirdTop);
    });
    it('virtualizes a large document to a viewport-sized page range', () => {
        const layout = new DocumentThumbnailLayout({
            pageCount: 100_000,
            renderWidth: 160,
        });
        const range = layout.resolveVirtualRange(2_000_000, 800, 700);

        expect(range.startPage).toBeGreaterThan(1);
        expect(range.endPage - range.startPage).toBeLessThan(20);
        expect(layout.getTotalHeight()).toBeGreaterThan(10_000_000);
    });

    it('keeps large-document scroll segments bounded and reaches the last page', () => {
        const pageCount = 138_000;
        const layout = new DocumentThumbnailLayout({
            pageCount,
            renderWidth: 160,
        });
        const segmentCount = layout.getScrollSegmentCount();

        expect(segmentCount).toBeGreaterThan(1);
        expect(layout.getTotalHeight()).toBeGreaterThan(DOCUMENT_THUMBNAIL_SCROLL_SEGMENT_MAX_HEIGHT);

        let previousStartPage = 0;
        for (let index = 0; index < segmentCount; index += 1) {
            const segment = layout.getScrollSegment(index);
            expect(segment.startPage).toBeGreaterThan(previousStartPage);
            expect(segment.endPage).toBeGreaterThanOrEqual(segment.startPage);
            expect(segment.height).toBeLessThanOrEqual(DOCUMENT_THUMBNAIL_SCROLL_SEGMENT_MAX_HEIGHT);
            expect(layout.resolvePageAtScrollOffsetInSegment(0, index)).toBe(segment.startPage);
            expect(layout.resolvePageAtScrollOffsetInSegment(segment.height, index)).toBe(segment.endPage);
            previousStartPage = segment.startPage;
        }

        const lastSegmentIndex = layout.getScrollSegmentIndexForPage(pageCount);
        const lastSegment = layout.getScrollSegment(lastSegmentIndex);
        expect(lastSegment.endPage).toBe(pageCount);
        expect(layout.resolvePageAtScrollOffsetInSegment(lastSegment.height, lastSegmentIndex)).toBe(pageCount);
        let previousPage = lastSegment.startPage;
        for (const offset of [
            0,
            lastSegment.height * 0.25,
            lastSegment.height * 0.5,
            lastSegment.height * 0.75,
            lastSegment.height,
        ]) {
            const page = layout.resolvePageAtScrollOffsetInSegment(offset, lastSegmentIndex) ?? lastSegment.startPage;
            expect(page).toBeGreaterThanOrEqual(previousPage);
            previousPage = page;
        }
        expect(
            layout.getPageTopInScrollSegment(pageCount, lastSegmentIndex) + layout.getPageHeight(pageCount),
        ).toBeLessThanOrEqual(lastSegment.height);
    });

    it('derives segment boundaries from physical geometry at wide and measured sizes', () => {
        const pageCount = 138_000;
        const layout = new DocumentThumbnailLayout({
            pageCount,
            renderWidth: 520,
        });
        const wideFirstSegment = layout.getScrollSegment(0);

        expect(wideFirstSegment.endPage).toBeLessThan(16_384);
        for (let index = 0; index < layout.getScrollSegmentCount(); index += 1) {
            expect(layout.getScrollSegment(index).height).toBeLessThanOrEqual(
                DOCUMENT_THUMBNAIL_SCROLL_SEGMENT_MAX_HEIGHT,
            );
        }

        const measured = new DocumentThumbnailLayout({
            pageCount,
            renderWidth: 520,
        });
        const measuredBefore = measured.getScrollSegment(0).endPage;
        for (let page = 1; page <= 1_000; page += 1) {
            measured.updatePageAspect(page, 2.4);
        }
        const measuredAfter = measured.getScrollSegment(0).endPage;

        expect(measuredAfter).toBeLessThan(measuredBefore);
        for (let index = 0; index < measured.getScrollSegmentCount(); index += 1) {
            expect(measured.getScrollSegment(index).height).toBeLessThanOrEqual(
                DOCUMENT_THUMBNAIL_SCROLL_SEGMENT_MAX_HEIGHT,
            );
        }
    });

    it('returns adjacent segment transitions at physical scroll boundaries', () => {
        const layout = new DocumentThumbnailLayout({
            pageCount: 40_000,
            renderWidth: 160,
        });
        const first = layout.getScrollSegment(0);
        const next = layout.resolveScrollSegmentTransition(
            first.height,
            first.height - 12,
            600,
            0,
        );

        expect(next).toEqual({
            segmentIndex: 1,
            scrollTop: 0,
        });
        const previous = layout.resolveScrollSegmentTransition(
            0,
            12,
            600,
            1,
        );
        expect(previous?.segmentIndex).toBe(0);
        expect(previous?.scrollTop).toBe(first.height - 600);
    });

    it('uses deterministic placeholders and replaces individual aspects from page metrics', () => {
        const layout = new DocumentThumbnailLayout({
            pageCount: 4,
            renderWidth: 100,
        });
        const initialPageTwoTop = layout.getPageTop(2);
        const initialPageThreeTop = layout.getPageTop(3);

        expect(layout.getPageAspect(1)).toBe(DEFAULT_DOCUMENT_THUMBNAIL_ASPECT_RATIO);
        expect(layout.updatePageAspect(2, 2)).toBe(true);
        expect(layout.getPageTop(2)).toBe(initialPageTwoTop);
        expect(layout.getPageTop(3)).toBeGreaterThan(initialPageThreeTop);
        expect(layout.getPageAspect(1)).toBe(DEFAULT_DOCUMENT_THUMBNAIL_ASPECT_RATIO);
        expect(layout.getPageAspect(2)).toBe(2);
    });

    it('seeds unknown placeholders from the document while preserving exact page aspects', () => {
        const layout = new DocumentThumbnailLayout({
            pageCount: 4,
            renderWidth: 100,
        });
        layout.updatePageAspect(2, 2);

        expect(layout.setEstimatedAspectRatio(1.5)).toBe(true);
        expect(layout.getPageAspect(1)).toBe(1.5);
        expect(layout.getPageAspect(2)).toBe(2);
        expect(layout.getPageAspect(4)).toBe(1.5);
    });

    it('does not leak learned geometry into the next document', () => {
        const layout = new DocumentThumbnailLayout({
            pageCount: 4,
            renderWidth: 100,
        });
        layout.setEstimatedAspectRatio(2.4);
        layout.updatePageAspect(2, 1.2);

        layout.resetDocument({
            pageCount: 3,
            renderWidth: 100,
        });

        expect(layout.getPageAspect(1)).toBe(DEFAULT_DOCUMENT_THUMBNAIL_ASPECT_RATIO);
        expect(layout.getPageAspect(2)).toBe(DEFAULT_DOCUMENT_THUMBNAIL_ASPECT_RATIO);
    });

    it('preserves the visible page and intra-page offset across width and aspect changes', () => {
        const layout = new DocumentThumbnailLayout({
            pageCount: 500,
            renderWidth: 120,
        });
        const originalScrollTop = layout.getPageTop(220) + 42;
        const anchor = layout.captureAnchor(originalScrollTop);

        layout.updatePageAspect(100, 2.4);
        layout.reset({
            pageCount: 500,
            renderWidth: 180,
        });
        const restored = layout.resolveAnchorScrollTop(anchor);

        expect(layout.resolvePageAtOffset(restored)).toBe(220);
        expect(restored - layout.getPageTop(220)).toBe(42);
    });

    it('updates one page in a large document without rebuilding unrelated prefix geometry', () => {
        const layout = new DocumentThumbnailLayout({
            estimatedAspectRatio: 1,
            pageCount: 10_000,
            renderWidth: 100,
        });
        const beforePageTwo = layout.getPageTop(2);
        const beforePageThree = layout.getPageTop(3);
        const beforePageTwoHeight = layout.getPageHeight(2);

        expect(layout.updatePageAspect(2, 2)).toBe(true);
        expect(layout.getPageTop(2)).toBe(beforePageTwo);
        expect(layout.getPageTop(3)).toBe(
            beforePageThree - beforePageTwoHeight + layout.getPageHeight(2),
        );
    });

    it('finds pages at exact offset boundaries and snapshots shared geometry', () => {
        const layout = new DocumentThumbnailLayout({
            pageCount: 3,
            renderWidth: 100,
        });
        layout.updatePageAspect(1, 1);
        layout.updatePageAspect(2, 2);
        layout.updatePageAspect(3, 1);

        expect(layout.resolvePageAtOffset(0)).toBe(1);
        expect(layout.resolvePageAtOffset(layout.getPageTop(2))).toBe(2);
        expect(layout.resolvePageAtOffset(layout.getPageTop(3))).toBe(3);
        expect(layout.resolvePageAtOffset(Number.MAX_SAFE_INTEGER)).toBe(3);
        expect(layout.snapshot().totalHeight).toBe(layout.getTotalHeight());
    });

    it('can adopt the first measured aspect for unknown PDF placeholders and later invalidate it', () => {
        const layout = new DocumentThumbnailLayout({
            adoptFirstAspectAsEstimate: true,
            pageCount: 100,
            renderWidth: 120,
        });

        expect(layout.updatePageAspect(2, 1.5)).toBe(true);
        expect(layout.getPageAspect(1)).toBe(1.5);
        expect(layout.getPageAspect(100)).toBe(1.5);
        expect(layout.updatePageAspect(1, 2)).toBe(true);
        expect(layout.updatePageAspect(1, null)).toBe(true);
        expect(layout.getPageAspect(1)).toBe(1.5);
    });

    it('does not apply the first adopted aspect delta twice', () => {
        const layout = new DocumentThumbnailLayout({
            adoptFirstAspectAsEstimate: true,
            itemChromeHeight: 30,
            pageCount: 3,
            renderWidth: 120,
        });

        expect(layout.updatePageAspect(1, 1.5)).toBe(true);
        expect(layout.snapshot()).toEqual({
            heights: [
                210,
                210,
                210,
            ],
            tops: [
                0,
                218,
                436,
            ],
            totalHeight: 646,
        });
    });

    it('constructs million-page documents without page-sized allocations', () => {
        const layout = new DocumentThumbnailLayout({
            pageCount: 1_000_000,
            renderWidth: 160,
        });

        expect(layout.getLoadedBlockCount()).toBe(0);
        expect(layout.getPageHeight(1_000_000)).toBe(257);
        expect(layout.getPageTop(1_000_000)).toBe(264_999_735);
        expect(layout.snapshot().heights).toHaveLength(256);
        expect(layout.snapshot({
            endPage: 1_000_000,
            startPage: 999_900,
        }).heights).toHaveLength(101);

        expect(layout.updatePageAspect(999_999, 2)).toBe(true);
        expect(layout.getLoadedBlockCount()).toBe(1);
        expect(layout.getPageAspect(999_999)).toBe(2);
    });

    it('keeps sparse block geometry equivalent to exact small-document rows', () => {
        const layout = new DocumentThumbnailLayout({
            estimatedAspectRatio: 1,
            itemChromeHeight: 20,
            itemGap: 6,
            pageCount: 6,
            renderWidth: 100,
        });

        layout.updatePageAspect(2, 1.5);
        layout.updatePageChromeHeight(5, 44);

        expect(layout.snapshot()).toEqual({
            heights: [
                120,
                170,
                120,
                120,
                144,
                120,
            ],
            tops: [
                0,
                126,
                302,
                428,
                554,
                704,
            ],
            totalHeight: 824,
        });
        expect(layout.resolvePageAtOffset(302)).toBe(3);
        expect(layout.resolvePageAtOffset(301)).toBe(2);
        expect(layout.resolveInsertionIndex(301)).toBe(2);
    });

    it('limits an unbounded snapshot while preserving absolute tops for a range', () => {
        const layout = new DocumentThumbnailLayout({
            pageCount: 100_000,
            renderWidth: 100,
        });

        const snapshot = layout.snapshot({
            endPage: 4_203,
            startPage: 4_200,
        });
        expect(snapshot.heights).toHaveLength(4);
        expect(snapshot.tops[0]).toBe(layout.getPageTop(4_200));
        expect(snapshot.tops[3]).toBe(layout.getPageTop(4_203));
        expect(layout.snapshot().heights).toHaveLength(256);
    });
});
