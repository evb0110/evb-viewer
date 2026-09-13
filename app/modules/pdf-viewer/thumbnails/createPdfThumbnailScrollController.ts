import type {Ref} from 'vue';
import {clamp} from 'es-toolkit/math';
import {
    applyPdfViewportWrite,
    createPdfViewportWritePort,
    type IPdfViewportWritePort,
} from '@app/modules/pdf-viewer/runtime/viewport/pdfViewportWritePort';
import {
    getDocumentThumbnailComfortPadding,
    isDocumentThumbnailWithinComfortViewport,
    resolveDocumentThumbnailRevealScrollTop,createDocumentThumbnailScrollRestorer,
} from '@app/modules/document-viewer/public';
import type {
    IDocumentThumbnailPageBounds,
    IDocumentThumbnailViewport,IDocumentThumbnailScrollSegmentTransition,
} from '@app/modules/document-viewer/public';
import {createDocumentThumbnailSegmentScroll} from '@app/modules/pdf-viewer/thumbnails/createDocumentThumbnailSegmentScroll';

interface IPdfThumbnailScrollControllerOptions {
    activeSegmentIndex: Readonly<Ref<number>>;
    containerRef: Readonly<Ref<HTMLElement | null>>;
    getPageBounds: (page: number) => IDocumentThumbnailPageBounds;
    getMaxScrollTop: (clientHeight: number) => number;
    getThumbnailElement: (page: number) => HTMLElement | null;
    getViewport: (container: HTMLElement) => IDocumentThumbnailViewport;
    isRecentProgrammaticScroll: () => boolean;
    markManualScroll: (reason: string) => void;
    markProgrammaticScroll: () => void;
    viewportWritePort?: IPdfViewportWritePort;
    resolveSegmentTransition: (
        scrollTop: number,
        previousScrollTop: number,
        viewportHeight: number,
    ) => IDocumentThumbnailScrollSegmentTransition | null;
    scheduleVisibleThumbnailRender: () => void;
    setActiveSegmentForPage: (page: number) => boolean;
    updateScrollPosition: () => void;
    updateViewportMetrics: () => void;
}

export function createPdfThumbnailScrollController(
    options: IPdfThumbnailScrollControllerOptions,
) {
    let scrollRestorer: ReturnType<typeof createDocumentThumbnailScrollRestorer> | null = null;
    let writeSequence = 0;
    const viewportWritePort = options.viewportWritePort ?? createPdfViewportWritePort();

    function applyViewportScrollTop(
        container: HTMLElement,
        scrollTop: number,
        reason: string,
    ) {
        writeSequence += 1;
        return applyPdfViewportWrite(viewportWritePort, container, {
            intentId: `thumbnail-scroll:${String(writeSequence)}`,
            reason,
            top: scrollTop,
        });
    }

    const segmentScroll = createDocumentThumbnailSegmentScroll({
        activeSegmentIndex: options.activeSegmentIndex,
        applyTransition: (container, transition) => {
            applyViewportScrollTop(container, transition.scrollTop, 'thumbnail-segment-transition');
            scrollRestorer?.schedule(transition.scrollTop);
            options.updateViewportMetrics();
            void options.scheduleVisibleThumbnailRender();
        },
        containerRef: options.containerRef,
        markProgrammaticScroll: options.markProgrammaticScroll,
        resolveTransition: options.resolveSegmentTransition,
    });
    scrollRestorer = createDocumentThumbnailScrollRestorer({
        applyScrollTop: (container, scrollTop) => {
            options.markProgrammaticScroll();
            applyViewportScrollTop(container, scrollTop, 'thumbnail-scroll-retry');
            segmentScroll.observeScrollTop(container.scrollTop);
            options.updateViewportMetrics();
            void options.scheduleVisibleThumbnailRender();
        },
        getContainer: () => options.containerRef.value,
    });

    function applyScrollTop(container: HTMLElement, nextScrollTop: number) {
        if (Math.abs(nextScrollTop - container.scrollTop) < 1) {
            return false;
        }

        options.markProgrammaticScroll();
        applyViewportScrollTop(container, nextScrollTop, 'thumbnail-programmatic-scroll');
        segmentScroll.observeScrollTop(container.scrollTop);
        options.updateViewportMetrics();
        void options.scheduleVisibleThumbnailRender();
        scrollRestorer?.schedule(nextScrollTop);
        return true;
    }

    function resolveCurrentPageSyncScrollTop(container: HTMLElement, page: number) {
        options.setActiveSegmentForPage(page);
        return resolveDocumentThumbnailRevealScrollTop(
            options.getViewport(container),
            options.getPageBounds(page),
        );
    }

    function resolveRefinedCurrentPageScrollTop(container: HTMLElement, page: number) {
        options.setActiveSegmentForPage(page);
        const thumbnail = options.getThumbnailElement(page);
        if (
            !thumbnail
            || isDocumentThumbnailWithinComfortViewport(
                container,
                options.getPageBounds(page),
            )
        ) {
            return null;
        }

        const containerRect = container.getBoundingClientRect();
        const thumbnailRect = thumbnail.getBoundingClientRect();
        const thumbnailTop = container.scrollTop + thumbnailRect.top - containerRect.top;
        const thumbnailBottom = thumbnailTop + thumbnailRect.height;
        const comfortPadding = getDocumentThumbnailComfortPadding(container);
        const scrollsTowardBottom = thumbnailBottom > (
            container.scrollTop + container.clientHeight - comfortPadding
        );
        const nextScrollTop = scrollsTowardBottom
            ? thumbnailBottom + comfortPadding - container.clientHeight
            : thumbnailTop - comfortPadding;

        return clamp(nextScrollTop, 0, options.getMaxScrollTop(container.clientHeight));
    }

    function handleContainerScroll() {
        const container = options.containerRef.value;
        const recentProgrammaticScroll = options.isRecentProgrammaticScroll();
        if (!recentProgrammaticScroll) {
            scrollRestorer?.cancel();
        }
        const transitioned = segmentScroll.handleScrollBoundary(recentProgrammaticScroll);
        options.updateScrollPosition();
        if (!transitioned && !segmentScroll.hasPendingTransition() && container) {
            segmentScroll.observeScrollTop(container.scrollTop);
        }
        if (!recentProgrammaticScroll) {
            if (container) {
                viewportWritePort.observeUserScroll(container);
            }
            options.markManualScroll('scroll');
        }
        void options.scheduleVisibleThumbnailRender();
    }

    return {
        applyScrollTop,
        cancel() {
            scrollRestorer.cancel();
            segmentScroll.cancel();
        },
        handleContainerScroll,
        resolveCurrentPageSyncScrollTop,
        resolveRefinedCurrentPageScrollTop,
    };
}
