import {
    describe, expect, it,
} from 'vitest';
import {
    DOCUMENT_THUMBNAIL_SCROLL_SEGMENT_MAX_HEIGHT,
    DocumentThumbnailLayout,
} from '@app/modules/document-viewer/thumbnails/documentThumbnailLayout';

describe('DocumentThumbnailLayout', () => {
    it('gives every page a stable portrait slot and a common label band', () => {
        const layout = new DocumentThumbnailLayout({
            pageCount: 3,
            renderWidth: 100,
            itemChromeHeight: 30,
        });
        expect([
            1,
            2,
            3,
        ].map(page => layout.getPageHeight(page))).toEqual([
            172,
            172,
            172,
        ]);
        expect([
            1,
            2,
            3,
        ].map(page => layout.getPageTop(page))).toEqual([
            0,
            180,
            360,
        ]);
        expect(layout.getTotalHeight()).toBe(532);
        layout.reset({
            pageCount: 3,
            renderWidth: 100,
            itemChromeHeight: 66,
        });
        expect(layout.getPageTop(3)).toBe(432);
    });

    it('virtualizes a million-page document without page-sized geometry', () => {
        const layout = new DocumentThumbnailLayout({
            pageCount: 1_000_000,
            renderWidth: 160,
        });
        const segmentIndex = layout.getScrollSegmentIndexForPage(999_900);
        const range = layout.resolveVirtualRangeInScrollSegment(
            layout.getPageTopInScrollSegment(999_900, segmentIndex), 800, 700, segmentIndex,
        );
        expect(range.startPage).toBeLessThanOrEqual(999_900);
        expect(range.endPage).toBeGreaterThanOrEqual(999_900);
        expect(range.endPage - range.startPage).toBeLessThan(20);
        expect(layout.getPageHeight(1_000_000)).toBe(257);
        expect(layout.getPageTop(1_000_000)).toBe(264_999_735);
    });

    it('keeps wide-column physical segments bounded and reaches the last page', () => {
        const pageCount = 138_000;
        const layout = new DocumentThumbnailLayout({
            pageCount,
            renderWidth: 520,
        });
        expect(layout.getScrollSegmentCount()).toBeGreaterThan(1);
        expect(layout.getScrollSegment(0).endPage).toBeLessThan(16_384);
        let previousEnd = 0;
        for (let index = 0; index < layout.getScrollSegmentCount(); index += 1) {
            const segment = layout.getScrollSegment(index);
            expect(segment.startPage).toBe(previousEnd + 1);
            expect(segment.height).toBeLessThanOrEqual(DOCUMENT_THUMBNAIL_SCROLL_SEGMENT_MAX_HEIGHT);
            expect(layout.resolvePageAtScrollOffsetInSegment(0, index)).toBe(segment.startPage);
            expect(layout.resolvePageAtScrollOffsetInSegment(segment.height, index)).toBe(segment.endPage);
            expect(layout.getPageTopInScrollSegment(segment.endPage, index) + layout.getPageHeight(segment.endPage)).toBe(segment.height);
            previousEnd = segment.endPage;
        }
        expect(previousEnd).toBe(pageCount);
    });

    it('returns adjacent segment transitions at physical scroll boundaries', () => {
        const layout = new DocumentThumbnailLayout({
            pageCount: 40_000,
            renderWidth: 160,
        });
        const first = layout.getScrollSegment(0);
        expect(layout.resolveScrollSegmentTransition(first.height, first.height - 12, 600, 0)).toEqual({
            segmentIndex: 1,
            scrollTop: 0,
        });
        expect(layout.resolveScrollSegmentTransition(0, 12, 600, 1)).toEqual({
            segmentIndex: 0,
            scrollTop: first.height - 600,
        });
    });

    it('finds exact row boundaries after resizing and replacing a document', () => {
        const layout = new DocumentThumbnailLayout({
            pageCount: 500,
            renderWidth: 120,
        });
        layout.reset({
            pageCount: 500,
            renderWidth: 180,
        });
        expect(layout.resolvePageAtScrollOffsetInSegment(layout.getPageTop(220) + 42, 0)).toBe(220);
        layout.reset({
            pageCount: 3,
            renderWidth: 100,
        });
        expect(layout.resolvePageAtScrollOffsetInSegment(layout.getPageTop(2), 0)).toBe(2);
        expect(layout.resolvePageAtScrollOffsetInSegment(Number.MAX_SAFE_INTEGER, 0)).toBe(3);
        layout.reset({
            pageCount: 0,
            renderWidth: 100,
        });
        expect(layout.getTotalHeight()).toBe(0);
        expect(layout.resolveVirtualRangeInScrollSegment(0, 800, 700, 0)).toEqual({
            startPage: 0,
            endPage: -1,
        });
    });
});
