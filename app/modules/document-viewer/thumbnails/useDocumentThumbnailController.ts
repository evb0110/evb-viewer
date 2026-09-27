import type {Ref} from 'vue';
import type {
    IDocumentPageSource,
    IDocumentRenderLease,
} from '@app/modules/document-viewer/source/documentPageSource';
import {
    DEFAULT_DOCUMENT_THUMBNAIL_ASPECT_RATIO,
    DEFAULT_DOCUMENT_THUMBNAIL_ITEM_CHROME_HEIGHT,
    DocumentThumbnailLayout,
    type IDocumentThumbnailVirtualRange,
} from '@app/modules/document-viewer/thumbnails/documentThumbnailLayout';
import {
    resolveThumbnailItemChromeHeightFromStyles,
    resolveThumbnailOutputScale,
    resolveThumbnailRasterWidth,
    resolveThumbnailRenderWidthFromStyles,
} from '@app/modules/document-viewer/thumbnails/documentThumbnailRenderMetrics';
import {
    useEventListener, useResizeObserver,
} from '@vueuse/core';
import {getHostCapability} from '@app/utils/getHostCapability';
import {resolveDocumentWheelInteraction} from '@app/modules/document-viewer/input/documentWheelInteraction';
import {
    createDocumentViewportWritePort, observeDocumentViewportWheelInteraction,
} from '@app/modules/document-viewer/runtime/documentViewportWritePort';
import {
    createDocumentThumbnailScheduler,
    type IDocumentThumbnailCommittedState,
    type IDocumentThumbnailDemand,
} from '@app/modules/document-viewer/thumbnails/createDocumentThumbnailScheduler';
import {createDocumentThumbnailResizeAnchorLifecycle} from '@app/modules/document-viewer/thumbnails/createDocumentThumbnailResizeAnchorLifecycle';
import {createDocumentThumbnailScrollRestorer} from '@app/modules/document-viewer/thumbnails/createDocumentThumbnailScrollRestorer';
import {
    DOCUMENT_THUMBNAIL_AUTO_FOLLOW_COOLDOWN_MS,
    DOCUMENT_THUMBNAIL_PROGRAMMATIC_SCROLL_GUARD_MS,
    resolveDocumentThumbnailPageBounds,
    resolveDocumentThumbnailRevealScrollTop,
} from '@app/modules/document-viewer/thumbnails/documentThumbnailViewport';

const MIN_CSS_WIDTH = 96;
const VIRTUAL_OVERSCAN_PX = 700;
const RENDER_OVERSCAN_PX = 420;
const CURRENT_NEIGHBOR_COUNT = 2;
/**
 * The scheduler re-queues a page after every failed render, so a page that
 * always fails would retry forever. Three consecutive failures of the same
 * request is the point where a retry has stopped looking transient, so that is
 * where the controller stops asking and surfaces the error instead.
 */
const RENDER_ATTEMPT_LIMIT = 3;

export interface IDocumentThumbnailVirtualItem {
    aspectRatio: string;
    height: number;
    pageNumber: number;
    top: number;
}

interface IRenderFailure {
    attempts: number;
    widthPx: number;
}

interface IDocumentThumbnailScrollAnchor {
    page: number;
    ratio: number;
}

interface IUseDocumentThumbnailControllerOptions {
    currentPage: Ref<number>;
    isActive: Ref<boolean>;
    isResizing: Ref<boolean>;
    itemMetricsKey: Ref<unknown>;
    /** A page re-renders, keeping its thumbnail meanwhile, when its key changes. */
    pageRevision: Ref<((pageNumber: number) => string) | undefined>;
    scrollRoot: Ref<HTMLElement | null>;
    source: Ref<IDocumentPageSource | null>;
}

function prepareSurface(lease: IDocumentRenderLease, signal: AbortSignal) {
    if (typeof lease.surface !== 'string') {
        return Promise.resolve();
    }
    const image = new Image();
    image.src = lease.surface;
    if (typeof image.decode === 'function') {
        return image.decode().then(() => signal.throwIfAborted());
    }
    return new Promise<void>((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, {once: true});
        image.onload = () => {
            signal.removeEventListener('abort', abort);
            resolve();
        };
        image.onerror = () => {
            signal.removeEventListener('abort', abort);
            reject(new Error('Thumbnail decode failed'));
        };
    }).then(() => signal.throwIfAborted());
}

function addRange(target: Set<number>, range: IDocumentThumbnailVirtualRange, pageCount: number) {
    for (
        let page = Math.max(1, range.startPage);
        page <= Math.min(pageCount, range.endPage);
        page += 1
    ) target.add(page);
}

export const useDocumentThumbnailController = (options: IUseDocumentThumbnailControllerOptions) => {
    const states = shallowReactive(new Map<number, IDocumentThumbnailCommittedState>());
    const layoutRevision = ref(0);
    const viewportRevision = ref(0);
    const isVisible = ref(false);
    const cssWidth = ref(MIN_CSS_WIDTH);
    const outputScale = ref(resolveThumbnailOutputScale(window.devicePixelRatio));
    const viewportWritePort = createDocumentViewportWritePort();
    const itemChromeHeight = ref(DEFAULT_DOCUMENT_THUMBNAIL_ITEM_CHROME_HEIGHT);
    /** Pages whose thumbnail failed RENDER_ATTEMPT_LIMIT times at the demanded width. */
    const renderErrors = shallowReactive(new Set<number>());
    /** Attempt bookkeeping; every page in renderErrors also has an entry here. */
    const renderFailures = new Map<number, IRenderFailure>();
    const layout = new DocumentThumbnailLayout({
        itemChromeHeight: itemChromeHeight.value,
        pageCount: 0,
        renderWidth: MIN_CSS_WIDTH,
    });
    let scheduledFrame: number | null = null;
    let lastManualInteractionAtMs = 0;
    let lastProgrammaticScrollAtMs = 0;
    let lastKnownAnchor: IDocumentThumbnailScrollAnchor | null = null;
    const activeScrollSegmentIndex = ref(0);
    let lastObservedScrollTop = 0;
    let pendingScrollSegmentTransitionIndex: number | null = null;
    let mounted = false;

    function setActiveScrollSegment(index: number) {
        const segmentCount = layout.getScrollSegmentCount();
        const nextIndex = segmentCount === 0
            ? 0
            : Math.min(segmentCount - 1, Math.max(0, Math.trunc(index)));
        if (nextIndex === activeScrollSegmentIndex.value) {
            return false;
        }
        activeScrollSegmentIndex.value = nextIndex;
        viewportRevision.value += 1;
        return true;
    }

    function setActiveScrollSegmentForPage(page: number) {
        return setActiveScrollSegment(layout.getScrollSegmentIndexForPage(page));
    }

    function getActiveScrollSegment() {
        return layout.getScrollSegment(activeScrollSegmentIndex.value);
    }

    function getActiveSegmentLayout() {
        const segmentIndex = activeScrollSegmentIndex.value;
        return {
            getPageHeight: (page: number) => layout.getPageHeight(page),
            getPageTop: (page: number) => layout.getPageTopInScrollSegment(page, segmentIndex),
        };
    }

    function getActiveScrollViewport(root: HTMLElement) {
        return {
            clientHeight: root.clientHeight,
            scrollHeight: getActiveScrollSegment().height,
            scrollTop: root.scrollTop,
        };
    }

    const scrollRestorer = createDocumentThumbnailScrollRestorer({
        applyScrollTop: (root, scrollTop) => {
            lastProgrammaticScrollAtMs = Date.now();
            root.scrollTop = scrollTop;
            lastObservedScrollTop = root.scrollTop;
        },
        getContainer: () => options.scrollRoot.value,
    });

    function writeScrollTop(root: HTMLElement, scrollTop: number) {
        lastProgrammaticScrollAtMs = Date.now();
        root.scrollTop = scrollTop;
        lastObservedScrollTop = root.scrollTop;
        scrollRestorer.schedule(scrollTop);
    }

    function captureDomAnchor(root: HTMLElement) {
        const rootRect = root.getBoundingClientRect();
        const centerY = rootRect.top + (rootRect.height / 2);
        const items = Array.from(root.querySelectorAll<HTMLElement>('[data-pane-relocation-scroll-item]'))
            .map(element => ({
                element,
                rect: element.getBoundingClientRect(),
            }))
            .filter(({rect}) => (
                Math.min(rect.bottom, rootRect.bottom) - Math.max(rect.top, rootRect.top) > 0
            ));
        const measured = items.find(({rect}) => rect.top <= centerY && rect.bottom >= centerY)
            ?? items[0];
        const page = Number(measured?.element.dataset.thumbnailPage);
        if (!measured || !Number.isSafeInteger(page) || page < 1) {
            return null;
        }
        const itemRect = measured.rect;
        return {
            page,
            ratio: itemRect.height > 0
                ? Math.max(0, Math.min(1, (centerY - itemRect.top) / itemRect.height))
                : 0,
        };
    }

    function readCurrentAnchor() {
        const root = options.scrollRoot.value;
        if (!root || root.clientHeight <= 0) {
            return lastKnownAnchor;
        }
        // A rail at its top stays there when rows above the centre change height.
        if (root.scrollTop < 1 && activeScrollSegmentIndex.value === 0) {
            lastKnownAnchor = {
                page: 1,
                ratio: 0,
            };
            return lastKnownAnchor;
        }
        const centerOffset = root.scrollTop + (root.clientHeight / 2);
        const modelPage = layout.resolvePageAtScrollOffsetInSegment(centerOffset, activeScrollSegmentIndex.value);
        const modelAnchor = modelPage === null
            ? null
            : {
                page: modelPage,
                ratio: Math.max(0, Math.min(
                    1,
                    (
                        centerOffset
                        - layout.getPageTopInScrollSegment(modelPage, activeScrollSegmentIndex.value)
                    ) / layout.getPageHeight(modelPage),
                )),
            };
        const anchor = captureDomAnchor(root) ?? modelAnchor;
        if (anchor) {
            lastKnownAnchor = anchor;
        }
        return anchor ?? lastKnownAnchor;
    }

    function captureResizeAnchor() {
        return lastKnownAnchor ?? readCurrentAnchor();
    }

    function resolveAnchorScrollTop(anchor: IDocumentThumbnailScrollAnchor, root: HTMLElement) {
        const page = Math.max(1, Math.trunc(anchor.page));
        const segmentIndex = layout.getScrollSegmentIndexForPage(page);
        setActiveScrollSegment(segmentIndex);
        const segment = layout.getScrollSegment(segmentIndex);
        const pageTop = layout.getPageTopInScrollSegment(page, segmentIndex);
        const pageHeight = layout.getPageHeight(page);
        return Math.min(
            Math.max(0, segment.height - root.clientHeight),
            Math.max(0, pageTop + (pageHeight * anchor.ratio) - (root.clientHeight / 2)),
        );
    }

    function restoreResizeAnchor(anchor: IDocumentThumbnailScrollAnchor | null) {
        const root = options.scrollRoot.value;
        if (!root || !anchor || root.clientHeight <= 0) {
            return false;
        }
        const nextScrollTop = resolveAnchorScrollTop(anchor, root);
        if (Math.abs(root.scrollTop - nextScrollTop) >= 1) {
            writeScrollTop(root, nextScrollTop);
        }
        lastKnownAnchor = anchor;
        viewportRevision.value += 1;
        return true;
    }

    const resizeAnchorLifecycle = createDocumentThumbnailResizeAnchorLifecycle({
        capture: captureResizeAnchor,
        restore: restoreResizeAnchor,
    });

    function resolvePageRevision(pageNumber: number) {
        return options.pageRevision.value?.(pageNumber) ?? '';
    }

    function clearRenderFailure(pageNumber: number) {
        renderFailures.delete(pageNumber);
        renderErrors.delete(pageNumber);
    }

    function clearRenderFailures() {
        renderFailures.clear();
        renderErrors.clear();
    }

    /** Failures only live as long as the page they belong to stays in demand. */
    function pruneRenderFailures(retainedPages: ReadonlySet<number>) {
        for (const pageNumber of [...renderFailures.keys()]) {
            if (!retainedPages.has(pageNumber)) clearRenderFailure(pageNumber);
        }
    }

    const scheduler = createDocumentThumbnailScheduler({
        maxConcurrency: 3,
        onError(_error, demand) {
            const previous = renderFailures.get(demand.pageNumber);
            // Attempts only accumulate across the same request: a width change in
            // flight is a new request, not another failure of the previous one.
            const attempts = previous?.widthPx === demand.widthPx ? previous.attempts + 1 : 1;
            renderFailures.set(demand.pageNumber, {
                attempts,
                widthPx: demand.widthPx,
            });
            if (attempts < RENDER_ATTEMPT_LIMIT) {
                return;
            }
            renderErrors.add(demand.pageNumber);
            // Reconcile from inside the failure: the scheduler re-queues this page
            // as soon as this callback returns, so the demand has to be gone by
            // then or the exhausted page would keep retrying in a tight loop.
            reconcileDemand();
        },
        onStateChange(pageNumber, state) {
            if (state) {
                states.set(pageNumber, state);
                clearRenderFailure(pageNumber);
            } else states.delete(pageNumber);
        },
        prepareSurface,
        async render(request) {
            const source = options.source.value;
            const provider = source?.thumbnailProvider;
            if (!source || !provider) throw new Error('Thumbnail provider is unavailable');
            return provider.renderThumbnail(request);
        },
    });

    function measureCssWidth() {
        const root = options.scrollRoot.value;
        if (!root || root.clientWidth <= 0) {
            return null;
        }
        const item = root.querySelector<HTMLElement>('.document-thumbnail-list__item');
        const frame = item?.querySelector<HTMLElement>('[data-document-thumbnail-frame]') ?? null;
        const renderedFrameWidth = frame?.getBoundingClientRect().width ?? 0;
        // A frame narrower than the floor is a row caught mid-animation, not a
        // real column width. Adopting it would pin every item height to that
        // frame and leave the rail squashed once the width settles.
        if (Number.isFinite(renderedFrameWidth) && renderedFrameWidth >= MIN_CSS_WIDTH) {
            return renderedFrameWidth;
        }
        return resolveThumbnailRenderWidthFromStyles({
            containerClientWidth: root.clientWidth,
            containerStyle: getComputedStyle(root),
            minWidth: MIN_CSS_WIDTH,
            thumbnailStyle: item ? getComputedStyle(item) : null,
        });
    }

    function measureItemChromeHeight(item: HTMLElement) {
        const label = item.querySelector<HTMLElement>('[data-document-thumbnail-label]');
        if (!label) {
            return null;
        }

        return resolveThumbnailItemChromeHeightFromStyles({
            labelHeight: label.getBoundingClientRect().height,
            thumbnailStyle: getComputedStyle(item),
        });
    }

    function updateLayoutGeometry(nextWidth: number, nextItemChromeHeight: number) {
        if (nextWidth === cssWidth.value && nextItemChromeHeight === itemChromeHeight.value) {
            return;
        }
        const root = options.scrollRoot.value;
        const anchor = resizeAnchorLifecycle.read()
            ?? readCurrentAnchor();
        cssWidth.value = nextWidth;
        itemChromeHeight.value = nextItemChromeHeight;
        layout.reset({
            itemChromeHeight: nextItemChromeHeight,
            pageCount: options.source.value?.pageCount ?? 0,
            renderWidth: nextWidth,
        });
        layoutRevision.value += 1;
        if (root && anchor) {
            writeScrollTop(root, resolveAnchorScrollTop(anchor, root));
            lastKnownAnchor = anchor;
        }
        if (resizeAnchorLifecycle.isActive()) resizeAnchorLifecycle.preserve();
    }

    function measureViewport() {
        const root = options.scrollRoot.value;
        const nextVisible = Boolean(root && root.clientWidth > 0 && root.clientHeight > 0);
        isVisible.value = nextVisible;
        outputScale.value = resolveThumbnailOutputScale(window.devicePixelRatio);
        const measuredWidth = measureCssWidth();
        if (measuredWidth !== null) {
            const item = root?.querySelector<HTMLElement>('.document-thumbnail-list__item');
            updateLayoutGeometry(measuredWidth, item ? measureItemChromeHeight(item) ?? itemChromeHeight.value : itemChromeHeight.value);
        }
        if (resizeAnchorLifecycle.isActive()) {
            resizeAnchorLifecycle.preserve();
        } else {
            readCurrentAnchor();
        }
        viewportRevision.value += 1;
    }

    function resolveRange(overscanPx: number) {
        const root = options.scrollRoot.value;
        if (!root || !isVisible.value) {
            return {
                startPage: 0,
                endPage: -1,
            };
        }
        return layout.resolveVirtualRangeInScrollSegment(
            root.scrollTop,
            root.clientHeight,
            overscanPx,
            activeScrollSegmentIndex.value,
        );
    }

    function buildDemand() {
        const source = options.source.value;
        if (!source?.thumbnailProvider || !isVisible.value || !options.isActive.value) {
            return [];
        }
        const visibleRange = resolveRange(0);
        const retainedRange = resolveRange(RENDER_OVERSCAN_PX);
        const visiblePages = new Set<number>();
        const retainedPages = new Set<number>();
        addRange(visiblePages, visibleRange, source.pageCount);
        addRange(retainedPages, retainedRange, source.pageCount);
        const centerPage = (visibleRange.startPage + visibleRange.endPage) / 2;
        const widthPx = resolveThumbnailRasterWidth(cssWidth.value * outputScale.value);
        pruneRenderFailures(retainedPages);
        const demand: IDocumentThumbnailDemand[] = [];
        for (const pageNumber of retainedPages) {
            if (renderErrors.has(pageNumber)) continue;
            const visible = visiblePages.has(pageNumber);
            demand.push({
                distance: Math.abs(pageNumber - centerPage),
                pageNumber,
                priority: visible ? 'visible' : 'thumbnail',
                rank: visible ? 0 : 1,
                revision: resolvePageRevision(pageNumber),
                widthPx,
            });
        }
        return demand;
    }

    function reconcileDemand() {
        scheduler.reconcile(buildDemand());
    }

    function refresh() {
        scheduledFrame = null;
        measureViewport();
        reconcileDemand();
    }

    /**
     * Drops a surfaced render error and asks the scheduler for that page again.
     * Errors otherwise clear on a successful render, on a source replacement, or
     * when the page leaves the retained window, so scrolling away and back also
     * gives a broken page a fresh run.
     */
    function retryRender(pageNumber: number) {
        if (!renderErrors.has(pageNumber)) {
            return;
        }
        clearRenderFailure(pageNumber);
        reconcileDemand();
    }

    function scheduleRefresh() {
        if (!mounted || scheduledFrame !== null) {
            return;
        }
        scheduledFrame = requestAnimationFrame(refresh);
    }

    function isRecentProgrammaticScroll() {
        return (Date.now() - lastProgrammaticScrollAtMs)
            < DOCUMENT_THUMBNAIL_PROGRAMMATIC_SCROLL_GUARD_MS;
    }

    function transitionScrollSegment(root: HTMLElement) {
        if (pendingScrollSegmentTransitionIndex !== null) {
            return false;
        }
        const transition = layout.resolveScrollSegmentTransition(
            root.scrollTop,
            lastObservedScrollTop,
            root.clientHeight,
            activeScrollSegmentIndex.value,
        );
        if (!transition) {
            lastObservedScrollTop = root.scrollTop;
            return false;
        }

        setActiveScrollSegment(transition.segmentIndex);
        pendingScrollSegmentTransitionIndex = transition.segmentIndex;
        lastProgrammaticScrollAtMs = Date.now();
        void nextTick(() => {
            if (pendingScrollSegmentTransitionIndex !== transition.segmentIndex) {
                return;
            }
            pendingScrollSegmentTransitionIndex = null;
            const currentRoot = options.scrollRoot.value;
            if (!currentRoot || activeScrollSegmentIndex.value !== transition.segmentIndex) {
                return;
            }
            writeScrollTop(currentRoot, transition.scrollTop);
            scheduleRefresh();
        });
        viewportRevision.value += 1;
        return true;
    }

    function handleScroll() {
        const root = options.scrollRoot.value;
        const authoredScroll = root !== null && viewportWritePort.consumeAuthorityScroll(root);
        const recentProgrammaticScroll = authoredScroll || isRecentProgrammaticScroll();
        if (!recentProgrammaticScroll) {
            scrollRestorer.cancel();
        }
        const transitioned = root !== null && !recentProgrammaticScroll
            ? transitionScrollSegment(root)
            : false;
        if (!transitioned && !options.isResizing.value && !resizeAnchorLifecycle.isActive()) {
            readCurrentAnchor();
        }
        viewportRevision.value += 1;
        if (!recentProgrammaticScroll) {
            markManualInteraction();
        }
        scheduleRefresh();
    }

    function markManualInteraction() {
        lastManualInteractionAtMs = Date.now();
    }

    function handlePointerDown() {
        markManualInteraction();
        scrollRestorer.cancel();
        resizeAnchorLifecycle.cancel();
        pendingScrollSegmentTransitionIndex = null;
        viewportWritePort.fenceCommandAgainstLiveGesture();
        const root = options.scrollRoot.value;
        const intent = viewportWritePort.beginIntent('thumbnail-press');
        if (root) viewportWritePort.apply(root, {
            intent,
            reason: 'thumbnail-press',
            top: root.scrollTop,
        });
    }

    function handleWheel(event: WheelEvent) {
        const root = options.scrollRoot.value;
        if (!root) return;
        const interaction = resolveDocumentWheelInteraction(event, root);
        const owner = observeDocumentViewportWheelInteraction(viewportWritePort, interaction, root);
        if (owner === 'command-residue') return;
        scrollRestorer.cancel();
        resizeAnchorLifecycle.cancel();
        markManualInteraction();
    }

    function isAutoFollowSuppressed() {
        return (Date.now() - lastManualInteractionAtMs) < DOCUMENT_THUMBNAIL_AUTO_FOLLOW_COOLDOWN_MS;
    }

    function revealPage(pageNumber: number, optionsOverride: {force?: boolean} = {}) {
        const source = options.source.value;
        const root = options.scrollRoot.value;
        if (
            !source
            || !root
            || !options.isActive.value
            || root.clientHeight <= 0
            || (!optionsOverride.force && isAutoFollowSuppressed())
        ) {
            return;
        }
        const page = Math.min(source.pageCount, Math.max(1, pageNumber));
        setActiveScrollSegmentForPage(page);
        const nextScrollTop = resolveDocumentThumbnailRevealScrollTop(
            getActiveScrollViewport(root),
            resolveDocumentThumbnailPageBounds(page, getActiveSegmentLayout()),
        );
        if (nextScrollTop !== null && Math.abs(root.scrollTop - nextScrollTop) >= 1) {
            writeScrollTop(root, nextScrollTop);
            // Mount the revealed rows in the next patch, not after the scroll event.
            viewportRevision.value += 1;
        }
    }

    const virtualItems = computed<IDocumentThumbnailVirtualItem[]>(() => {
        void layoutRevision.value;
        void viewportRevision.value;
        const source = options.source.value;
        if (!source || !isVisible.value) {
            return [];
        }
        const pages = new Set<number>();
        addRange(pages, resolveRange(VIRTUAL_OVERSCAN_PX), source.pageCount);
        const currentPage = Math.min(source.pageCount, Math.max(1, options.currentPage.value));
        for (
            let page = Math.max(getActiveScrollSegment().startPage, currentPage - CURRENT_NEIGHBOR_COUNT);
            page <= Math.min(getActiveScrollSegment().endPage, currentPage + CURRENT_NEIGHBOR_COUNT);
            page += 1
        ) pages.add(page);
        return [...pages].sort((left, right) => left - right).map(pageNumber => ({
            aspectRatio: String(1 / DEFAULT_DOCUMENT_THUMBNAIL_ASPECT_RATIO),
            height: layout.getPageHeight(pageNumber),
            pageNumber,
            top: layout.getPageTopInScrollSegment(pageNumber, activeScrollSegmentIndex.value),
        }));
    });

    const contentHeight = computed(() => {
        void layoutRevision.value;
        return `${String(getActiveScrollSegment().height)}px`;
    });

    watch(
        () => virtualItems.value.map(item => item.pageNumber).join(','),
        async () => {
            await nextTick();
            measureViewport();
            scheduleRefresh();
        },
        {flush: 'post'},
    );

    watch(
        options.source,
        async (source, previous) => {
            // With page revisions, a reloaded source of the same document keeps
            // the rows and their thumbnails; pages re-render as keys change.
            if (
                options.pageRevision.value
                && source
                && previous
                && source.documentRef === previous.documentRef
                && source.pageCount === previous.pageCount
            ) {
                clearRenderFailures();
                scheduleRefresh();
                return;
            }
            lastManualInteractionAtMs = 0;
            scheduler.reset();
            states.clear();
            clearRenderFailures();
            lastKnownAnchor = null;
            layout.reset({
                itemChromeHeight: itemChromeHeight.value,
                pageCount: source?.pageCount ?? 0,
                renderWidth: cssWidth.value,
            });
            activeScrollSegmentIndex.value = source
                ? layout.getScrollSegmentIndexForPage(options.currentPage.value)
                : 0;
            lastObservedScrollTop = 0;
            pendingScrollSegmentTransitionIndex = null;
            layoutRevision.value += 1;
            await nextTick();
            measureViewport();
            revealPage(options.currentPage.value, {force: true});
            readCurrentAnchor();
            scheduleRefresh();
        },
        {immediate: true},
    );
    // A changed page revision replaces its pixels without changing row geometry.
    watch(options.pageRevision, () => {
        scheduleRefresh();
    });
    watch(options.currentPage, async () => {
        setActiveScrollSegmentForPage(options.currentPage.value);
        await nextTick();
        revealPage(options.currentPage.value);
        readCurrentAnchor();
        viewportRevision.value += 1;
        scheduleRefresh();
    });
    watch(options.itemMetricsKey, async () => {
        await nextTick();
        measureViewport();
        scheduleRefresh();
    }, {flush: 'post'});
    watch(options.isActive, async active => {
        if (!active) {
            scheduler.reset();
            return;
        }
        await nextTick();
        measureViewport();
        revealPage(options.currentPage.value, {force: true});
        readCurrentAnchor();
        viewportRevision.value += 1;
        scheduleRefresh();
    });
    watch(options.isResizing, resizing => {
        if (resizing) {
            resizeAnchorLifecycle.begin();
            scheduleRefresh();
        } else {
            void resizeAnchorLifecycle.finish().then(scheduleRefresh);
        }
    });

    useEventListener(window, 'resize', scheduleRefresh);
    const unsubscribeWheelScrollSequence = getHostCapability().onWheelScrollSequenceChange(boundary => {
        viewportWritePort.observeWheelScrollSequence(boundary);
    });
    useResizeObserver(options.scrollRoot, () => {
        const wasVisible = isVisible.value;
        measureViewport();
        if (!wasVisible && isVisible.value && options.isActive.value) revealPage(options.currentPage.value, {force: true});
        scheduleRefresh();
    });
    onMounted(() => {
        mounted = true;
        measureViewport();
        revealPage(options.currentPage.value, {force: true});
        scheduleRefresh();
    });
    onBeforeUnmount(() => {
        mounted = false;
        unsubscribeWheelScrollSequence();
        scrollRestorer.cancel();
        pendingScrollSegmentTransitionIndex = null;
        if (scheduledFrame !== null) cancelAnimationFrame(scheduledFrame);
        resizeAnchorLifecycle.cancel();
        scheduler.dispose();
        states.clear();
        clearRenderFailures();
    });

    return {
        activeScrollSegmentIndex,
        contentHeight,
        handlePointerDown,
        handleScroll,
        handleWheel,
        userScrollSuppressed: viewportWritePort.userScrollSuppressed,
        outputScale,
        rasterWidth: computed(() => resolveThumbnailRasterWidth(cssWidth.value * outputScale.value)),
        renderErrors: renderErrors as ReadonlySet<number>,
        retryRender,
        revealPage: (pageNumber: number) => revealPage(pageNumber, {force: true}),
        scheduleRefresh,
        states,
        virtualItems,
    };
};
