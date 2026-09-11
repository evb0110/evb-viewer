import type {Ref} from 'vue';
import {THUMBNAIL_WIDTH} from '@app/constants/pdfLayout';
import {forEachKnownPageMetric} from '@app/modules/pdf-viewer/engine/pdf-page-layout/normalizePageMetrics';
import type {IPdfPageMetric} from '@app/types/pdfUi';
import {
    DEFAULT_DOCUMENT_THUMBNAIL_ITEM_CHROME_HEIGHT,
    DocumentThumbnailLayout,
    type IDocumentThumbnailLayoutAnchor,
} from '@app/utils/document-viewer/thumbnails/documentThumbnailLayout';

interface IUsePdfThumbnailVirtualLayoutOptions {
    captureAnchor: () => IDocumentThumbnailLayoutAnchor | null;
    pageCount: Ref<number>;
    scheduleReaction: (anchor: IDocumentThumbnailLayoutAnchor | null) => void;
}

export const usePdfThumbnailVirtualLayout = (options: IUsePdfThumbnailVirtualLayoutOptions) => {
    const itemChromeHeight = ref(DEFAULT_DOCUMENT_THUMBNAIL_ITEM_CHROME_HEIGHT);
    const layoutWidth = ref(THUMBNAIL_WIDTH);
    const revision = ref(0);
    const activeScrollSegmentIndex = ref(0);
    const layout = shallowRef(new DocumentThumbnailLayout({
        itemChromeHeight: itemChromeHeight.value,
        pageCount: options.pageCount.value,
        renderWidth: layoutWidth.value,
    }));

    function commitLayoutReaction(anchor: IDocumentThumbnailLayoutAnchor | null) {
        revision.value += 1;
        options.scheduleReaction(anchor);
    }

    /**
     * Projects the document session's page metrics into the rail layout in
     * one commit. The session is the only owner of page geometry; the rail
     * used to learn aspects from its own renders, one page per commit, and
     * the first opening of the sidebar showed every visible row growing in
     * turn as its thumbnail arrived.
     *
     * Unmeasured pages take the most common known aspect. Adopting the first
     * measured page instead pinned the estimate to the front matter, which
     * mismatched the body of most books.
     */
    function applyPageMetrics(
        pageMetrics: readonly IPdfPageMetric[],
    ) {
        const anchor = options.captureAnchor();
        const aspectCounts = new Map<number, {
            aspect: number;
            count: number
        }>();
        let changed = false;
        forEachKnownPageMetric(pageMetrics, (metric, index) => {
            const page = index + 1;
            const aspect = metric.height / metric.width;
            if (page > options.pageCount.value || !Number.isFinite(aspect) || aspect <= 0) {
                return;
            }
            const aspectKey = Math.round(aspect * 1_000);
            const counted = aspectCounts.get(aspectKey);
            if (counted) {
                counted.count += 1;
            } else {
                aspectCounts.set(aspectKey, {
                    aspect,
                    count: 1,
                });
            }
            const known = layout.value.getExactPageAspect(page);
            if (known !== undefined && Math.abs(known - aspect) < 0.001) {
                return;
            }
            changed = layout.value.updatePageAspect(page, aspect) || changed;
        });
        let dominant: {
            aspect: number;
            count: number
        } | null = null;
        for (const entry of aspectCounts.values()) {
            if (!dominant || entry.count > dominant.count) {
                dominant = entry;
            }
        }
        if (dominant && layout.value.setEstimatedAspectRatio(dominant.aspect)) {
            changed = true;
        }
        if (changed) {
            commitLayoutReaction(anchor);
        }
    }

    function hasExactAspects() {
        void revision.value;
        return layout.value.getExactAspectCount() > 0;
    }

    function getExactAspect(page: number) {
        void revision.value;
        return layout.value.getExactPageAspect(page);
    }

    function getAspect(page: number) {
        void revision.value;
        return layout.value.getPageAspect(page);
    }

    function resetDocumentLayout() {
        const anchor = options.captureAnchor();
        layout.value.resetDocument({
            itemChromeHeight: itemChromeHeight.value,
            pageCount: options.pageCount.value,
            renderWidth: layoutWidth.value,
        });
        activeScrollSegmentIndex.value = layout.value.getScrollSegmentIndexForPage(1);
        commitLayoutReaction(anchor);
    }

    watch([
        options.pageCount,
        itemChromeHeight,
        layoutWidth,
    ], () => {
        const anchor = options.captureAnchor();
        layout.value.reset({
            itemChromeHeight: itemChromeHeight.value,
            pageCount: options.pageCount.value,
            renderWidth: layoutWidth.value,
        });
        activeScrollSegmentIndex.value = Math.min(
            Math.max(0, layout.value.getScrollSegmentCount() - 1),
            activeScrollSegmentIndex.value,
        );
        commitLayoutReaction(anchor);
    }, {flush: 'sync'});

    function getPageTop(page: number) {
        void revision.value;
        return layout.value.getPageTopInScrollSegment(page, activeScrollSegmentIndex.value);
    }

    function getPageBounds(page: number) {
        const top = Math.max(0, getPageTop(page));
        const height = Math.max(1, layout.value.getPageHeight(page));
        return {
            bottom: top + height,
            height,
            top,
        };
    }

    function getMaxScrollTop(clientHeight: number) {
        return Math.max(0, contentHeight.value - clientHeight);
    }

    function getViewport(container: HTMLElement) {
        return {
            clientHeight: container.clientHeight,
            scrollHeight: contentHeight.value,
            scrollTop: container.scrollTop,
        };
    }

    function resolvePageAtOffset(offset: number) {
        void revision.value;
        return layout.value.resolvePageAtScrollOffsetInSegment(offset, activeScrollSegmentIndex.value);
    }

    function resolveInsertionIndex(offset: number) {
        void revision.value;
        return layout.value.resolveInsertionIndexInScrollSegment(offset, activeScrollSegmentIndex.value);
    }

    function setActiveScrollSegment(index: number) {
        const segmentCount = layout.value.getScrollSegmentCount();
        const nextIndex = segmentCount === 0
            ? 0
            : Math.min(segmentCount - 1, Math.max(0, Math.trunc(index)));
        if (nextIndex === activeScrollSegmentIndex.value) {
            return false;
        }
        activeScrollSegmentIndex.value = nextIndex;
        revision.value += 1;
        return true;
    }

    function setActiveScrollSegmentForPage(page: number) {
        return setActiveScrollSegment(layout.value.getScrollSegmentIndexForPage(page));
    }

    function resolveScrollSegmentTransition(
        scrollTop: number,
        previousScrollTop: number,
        viewportHeight: number,
    ) {
        void revision.value;
        const transition = layout.value.resolveScrollSegmentTransition(
            scrollTop,
            previousScrollTop,
            viewportHeight,
            activeScrollSegmentIndex.value,
        );
        if (!transition) {
            return null;
        }
        setActiveScrollSegment(transition.segmentIndex);
        return transition;
    }

    const contentHeight = computed(() => {
        void revision.value;
        return layout.value.getScrollSegment(activeScrollSegmentIndex.value).height;
    });

    return {
        activeScrollSegmentIndex,
        applyPageMetrics,
        contentHeight,
        getAspect,
        getExactAspect,
        getPageTop,
        getPageBounds,
        getMaxScrollTop,
        getViewport,
        hasExactAspects,
        itemChromeHeight,
        layout,
        layoutWidth,
        resetDocumentLayout,
        resolveInsertionIndex,
        resolvePageAtOffset,
        resolveScrollSegmentTransition,
        setActiveScrollSegment,
        setActiveScrollSegmentForPage,
    };
};
