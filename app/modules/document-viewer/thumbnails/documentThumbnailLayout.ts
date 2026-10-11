export const DEFAULT_DOCUMENT_THUMBNAIL_ITEM_CHROME_HEIGHT = 30;
export const DEFAULT_DOCUMENT_THUMBNAIL_ASPECT_RATIO = 297 / 210;
// The widest slot a document's pages can give: a two-page spread is about 0.7.
const MIN_DOCUMENT_THUMBNAIL_ASPECT_RATIO = 0.5;
// A physical segment stays below Chromium's scroll-height limit.
export const DOCUMENT_THUMBNAIL_SCROLL_SEGMENT_MAX_HEIGHT = 8_388_608;

export interface IDocumentThumbnailVirtualRange {
    endPage: number;
    startPage: number;
}

export interface IDocumentThumbnailScrollSegment extends IDocumentThumbnailVirtualRange {
    height: number;
    index: number;
    top: number;
}

export interface IDocumentThumbnailScrollSegmentTransition {
    scrollTop: number;
    segmentIndex: number;
}

export interface IDocumentThumbnailLayoutOptions {
    /** Slot height over width, shared by every page of the document. */
    aspectRatio?: number;
    itemChromeHeight?: number;
    itemGap?: number;
    pageCount: number;
    renderWidth: number;
}

/**
 * One slot per page, all shaped like the document's pages: a raster's
 * dimensions never change scroll geometry.
 */
export class DocumentThumbnailLayout {
    private pageCount = 0;
    private rowHeight = 1;
    private aspectRatio = DEFAULT_DOCUMENT_THUMBNAIL_ASPECT_RATIO;
    private itemGap = 8;
    private itemChromeHeight = DEFAULT_DOCUMENT_THUMBNAIL_ITEM_CHROME_HEIGHT;

    constructor(options: IDocumentThumbnailLayoutOptions) {
        this.reset(options);
    }

    reset(options: IDocumentThumbnailLayoutOptions) {
        this.pageCount = Math.max(0, Math.trunc(options.pageCount));
        this.itemChromeHeight = options.itemChromeHeight ?? this.itemChromeHeight;
        this.itemGap = options.itemGap ?? this.itemGap;
        this.aspectRatio = options.aspectRatio ?? this.aspectRatio;
        this.rowHeight = Math.max(1, Math.ceil(
            options.renderWidth * this.aspectRatio + this.itemChromeHeight,
        ));
    }

    get stride() {
        return this.rowHeight + this.itemGap;
    }

    private get pagesPerSegment() {
        return Math.max(1, Math.floor((DOCUMENT_THUMBNAIL_SCROLL_SEGMENT_MAX_HEIGHT + this.itemGap) / this.stride));
    }

    getPageHeight(page: number) {
        return page >= 1 && page <= this.pageCount ? this.rowHeight : 0;
    }

    getPageTop(page: number) {
        return Math.max(0, Math.min(this.pageCount, Math.trunc(page) - 1)) * this.stride;
    }

    getTotalHeight() {
        return Math.max(0, this.pageCount * this.stride - this.itemGap);
    }

    getScrollSegmentCount() {
        return Math.ceil(this.pageCount / this.pagesPerSegment);
    }

    getScrollSegmentIndexForPage(page: number) {
        return Math.floor(Math.max(0, Math.min(this.pageCount - 1, page - 1)) / this.pagesPerSegment);
    }

    getScrollSegment(index: number): IDocumentThumbnailScrollSegment {
        if (this.pageCount === 0) {
            return {
                startPage: 0,
                endPage: -1,
                height: 0,
                index: 0,
                top: 0,
            };
        }
        const boundedIndex = Math.max(0, Math.min(this.getScrollSegmentCount() - 1, Math.trunc(index)));
        const startPage = boundedIndex * this.pagesPerSegment + 1;
        const endPage = Math.min(this.pageCount, startPage + this.pagesPerSegment - 1);
        return {
            index: boundedIndex,
            startPage,
            endPage,
            top: this.getPageTop(startPage),
            height: (endPage - startPage + 1) * this.stride - this.itemGap,
        };
    }

    getPageTopInScrollSegment(page: number, segmentIndex: number) {
        return this.getPageTop(page) - this.getScrollSegment(segmentIndex).top;
    }

    resolvePageAtScrollOffsetInSegment(offset: number, segmentIndex: number) {
        const segment = this.getScrollSegment(segmentIndex);
        return this.pageCount === 0 ? null : Math.min(
            segment.endPage,
            segment.startPage + Math.floor(Math.max(0, offset) / this.stride),
        );
    }

    resolveScrollSegmentTransition(
        scrollTop: number,
        previousScrollTop: number,
        viewportHeight: number,
        segmentIndex: number,
    ): IDocumentThumbnailScrollSegmentTransition | null {
        const segment = this.getScrollSegment(segmentIndex);
        const direction = scrollTop - previousScrollTop;
        const reachedEnd = direction > 0
            && segment.index < this.getScrollSegmentCount() - 1
            && scrollTop >= Math.max(0, segment.height - viewportHeight) - 1;
        const reachedStart = direction < 0 && segment.index > 0 && scrollTop <= 1;
        if (!reachedEnd && !reachedStart) return null;
        const nextIndex = segment.index + (reachedEnd ? 1 : -1);
        return {
            segmentIndex: nextIndex,
            scrollTop: reachedEnd ? 0 : Math.max(0, this.getScrollSegment(nextIndex).height - viewportHeight),
        };
    }

    resolveVirtualRangeInScrollSegment(
        scrollTop: number,
        viewportHeight: number,
        overscanPx: number,
        segmentIndex: number,
    ): IDocumentThumbnailVirtualRange {
        return {
            startPage: this.resolvePageAtScrollOffsetInSegment(scrollTop - overscanPx, segmentIndex) ?? 0,
            endPage: this.resolvePageAtScrollOffsetInSegment(scrollTop + viewportHeight + overscanPx, segmentIndex) ?? -1,
        };
    }
}

/**
 * The slot shape of a document from a few of its pages' displayed sizes
 * (height over width): their median, so one cover does not decide it, kept
 * between a wide spread and the portrait slot taller pages always had.
 */
export function resolveDocumentThumbnailAspectRatio(pageSizes: ReadonlyArray<{
    widthPoints: number;
    heightPoints: number;
}>) {
    const ratios = pageSizes
        .filter(size => size.widthPoints > 0 && size.heightPoints > 0)
        .map(size => size.heightPoints / size.widthPoints)
        .sort((left, right) => left - right);
    const median = ratios[Math.floor(ratios.length / 2)];
    return median === undefined
        ? DEFAULT_DOCUMENT_THUMBNAIL_ASPECT_RATIO
        : Math.min(DEFAULT_DOCUMENT_THUMBNAIL_ASPECT_RATIO, Math.max(MIN_DOCUMENT_THUMBNAIL_ASPECT_RATIO, median));
}
