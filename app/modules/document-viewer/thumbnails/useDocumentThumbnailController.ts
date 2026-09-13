import type {Ref} from 'vue';
import type {
    IDocumentPageMetrics,
    IDocumentPageSource,
    IDocumentRenderLease,
} from '@app/modules/document-viewer/source/documentPageSource';
import {
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
import {createDocumentThumbnailMetricsCache} from '@app/modules/document-viewer/thumbnails/documentThumbnailMetricsCache';
import {
    createDocumentThumbnailScheduler,
    type IDocumentThumbnailCommittedState,
    type IDocumentThumbnailDemand,
    type TDocumentThumbnailQuality,
} from '@app/modules/document-viewer/thumbnails/documentThumbnailScheduler';
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
const SCROLL_SETTLE_MS = 160;
const RESIZE_SETTLE_MS = 140;
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
    const isScrolling = ref(false);
    const isVisible = ref(false);
    const cssWidth = ref(MIN_CSS_WIDTH);
    const itemChromeHeight = ref(DEFAULT_DOCUMENT_THUMBNAIL_ITEM_CHROME_HEIGHT);
    const settledCssWidth = ref(MIN_CSS_WIDTH);
    const metricsCache = createDocumentThumbnailMetricsCache();
    /** Pages whose thumbnail failed RENDER_ATTEMPT_LIMIT times at the demanded width. */
    const renderErrors = shallowReactive(new Set<number>());
    /** Attempt bookkeeping; every page in renderErrors also has an entry here. */
    const renderFailures = new Map<number, IRenderFailure>();
    const layout = new DocumentThumbnailLayout({
        itemChromeHeight: itemChromeHeight.value,
        pageCount: 0,
        renderWidth: MIN_CSS_WIDTH,
    });
    let resizeObserver: ResizeObserver | null = null;
    let scheduledFrame: number | null = null;
    let resizeSettleTimer: ReturnType<typeof setTimeout> | null = null;
    let scrollSettleTimer: ReturnType<typeof setTimeout> | null = null;
    let lastManualInteractionAtMs = 0;
    let lastProgrammaticScrollAtMs = 0;
    let hasSourceAspectEstimate = false;
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

    function applyPageMetrics(pageNumber: number, metrics: IDocumentPageMetrics) {
        if (metrics.widthPoints <= 0 || metrics.heightPoints <= 0) {
            return;
        }
        const root = options.scrollRoot.value;
        const anchor = resizeAnchorLifecycle.read()
            ?? readCurrentAnchor();
        const aspectRatio = metrics.heightPoints / metrics.widthPoints;
        const estimateChanged = !hasSourceAspectEstimate && layout.setEstimatedAspectRatio(aspectRatio);
        hasSourceAspectEstimate = true;
        const pageChanged = layout.updatePageAspect(pageNumber, aspectRatio);
        if (!estimateChanged && !pageChanged) {
            return;
        }
        layoutRevision.value += 1;
        if (root && anchor) {
            writeScrollTop(root, resolveAnchorScrollTop(anchor, root));
            lastKnownAnchor = anchor;
        }
        if (resizeAnchorLifecycle.isActive()) resizeAnchorLifecycle.preserve();
    }

    async function getPageMetrics(
        source: IDocumentPageSource,
        pageNumber: number,
        signal: AbortSignal,
    ) {
        let promise = metricsCache.get(pageNumber);
        if (!promise) {
            promise = source.getPageMetrics(pageNumber, signal);
            metricsCache.set(pageNumber, promise);
            promise.catch(() => {
                if (metricsCache.peek(pageNumber) === promise) metricsCache.delete(pageNumber);
            });
        }
        const metrics = await promise;
        signal.throwIfAborted();
        if (options.source.value === source) applyPageMetrics(pageNumber, metrics);
        return metrics;
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
            await getPageMetrics(source, request.pageNumber, request.signal);
            request.signal.throwIfAborted();
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

    function measureItemChromeHeights() {
        const root = options.scrollRoot.value;
        const entries = Array.from(root?.querySelectorAll<HTMLElement>('.document-thumbnail-list__item') ?? [])
            .flatMap(item => {
                const pageNumber = Number(item.dataset.thumbnailPage);
                const height = measureItemChromeHeight(item);
                return Number.isSafeInteger(pageNumber) && pageNumber > 0 && height !== null
                    ? [{
                        pageNumber,
                        height,
                    }]
                    : [];
            });
        const baseHeight = entries.find(entry => entry.pageNumber !== options.currentPage.value)?.height
            ?? itemChromeHeight.value;
        return {
            baseHeight,
            entries: entries.map(entry => ({
                pageNumber: entry.pageNumber,
                height: Math.abs(entry.height - baseHeight) < 0.5 ? null : entry.height,
            })),
        };
    }

    function updatePageChromeHeights(entries: Array<{
        pageNumber: number;
        height: number | null
    }>) {
        const root = options.scrollRoot.value;
        const anchor = resizeAnchorLifecycle.read()
            ?? readCurrentAnchor();
        const changed = entries.reduce(
            (didChange, entry) => layout.updatePageChromeHeight(entry.pageNumber, entry.height) || didChange,
            false,
        );
        if (!changed) {
            return;
        }
        layoutRevision.value += 1;
        if (root && anchor) {
            writeScrollTop(root, resolveAnchorScrollTop(anchor, root));
            lastKnownAnchor = anchor;
        }
        if (resizeAnchorLifecycle.isActive()) resizeAnchorLifecycle.preserve();
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
        const measuredWidth = measureCssWidth();
        if (measuredWidth !== null) {
            const measuredChrome = measureItemChromeHeights();
            updateLayoutGeometry(
                measuredWidth,
                measuredChrome.baseHeight,
            );
            updatePageChromeHeights(measuredChrome.entries);
            if (settledCssWidth.value === MIN_CSS_WIDTH && measuredWidth !== MIN_CSS_WIDTH) {
                settledCssWidth.value = measuredWidth;
            }
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
        const currentPage = Math.min(source.pageCount, Math.max(1, options.currentPage.value));
        for (
            let page = Math.max(getActiveScrollSegment().startPage, currentPage - CURRENT_NEIGHBOR_COUNT);
            page <= Math.min(getActiveScrollSegment().endPage, currentPage + CURRENT_NEIGHBOR_COUNT);
            page += 1
        ) retainedPages.add(page);

        const settledScale = resolveThumbnailOutputScale(window.devicePixelRatio || 1);
        const transient = isScrolling.value || options.isResizing.value;
        const quality: TDocumentThumbnailQuality = transient ? 'transient' : 'settled';
        const rasterCssWidth = transient ? settledCssWidth.value : cssWidth.value;
        const normalWidth = resolveThumbnailRasterWidth(rasterCssWidth * (transient ? 1 : settledScale));
        const currentWidth = resolveThumbnailRasterWidth(cssWidth.value * settledScale);
        pruneRenderFailures(retainedPages);
        const demand: IDocumentThumbnailDemand[] = [];
        for (const pageNumber of retainedPages) {
            const isCurrent = pageNumber === currentPage;
            const isVisiblePage = visiblePages.has(pageNumber);
            // A page whose retries are exhausted stays out of the demand set until
            // its error is cleared, so one broken page neither retries forever nor
            // competes with its neighbours for a render slot. A page still holding
            // an older thumbnail keeps it instead, pinned to the width that page's
            // committed render asked for: that is the width the scheduler compares
            // a settled demand against, so the demand reads as satisfied and the
            // page neither renders again nor loses the surface the row is showing.
            // Any other width — the width the rail now wants, or the raster the
            // provider actually leased, which it may shrink — reads as unsatisfied
            // and restarts the retry loop this branch exists to stop.
            if (renderErrors.has(pageNumber)) {
                const committedWidthPx = states.get(pageNumber)?.requestWidthPx;
                if (committedWidthPx === undefined) {
                    continue;
                }
                demand.push({
                    distance: Math.abs(pageNumber - currentPage),
                    pageNumber,
                    priority: 'thumbnail',
                    quality: 'settled',
                    rank: isCurrent ? 0 : isVisiblePage ? 1 : 2,
                    widthPx: committedWidthPx,
                });
                continue;
            }
            const widthPx = isCurrent ? currentWidth : normalWidth;
            demand.push({
                distance: Math.abs(pageNumber - currentPage),
                pageNumber,
                priority: 'thumbnail',
                quality: isCurrent ? 'settled' : quality,
                rank: isCurrent ? 0 : isVisiblePage ? 1 : 2,
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

    function settleRasterWidth() {
        settledCssWidth.value = cssWidth.value;
        scheduleRefresh();
    }

    function scheduleResizeSettle() {
        if (resizeSettleTimer) clearTimeout(resizeSettleTimer);
        if (options.isResizing.value) {
            return;
        }
        resizeSettleTimer = setTimeout(settleRasterWidth, RESIZE_SETTLE_MS);
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
        const recentProgrammaticScroll = isRecentProgrammaticScroll();
        if (!recentProgrammaticScroll) {
            scrollRestorer.cancel();
        }
        const transitioned = root !== null && !recentProgrammaticScroll
            ? transitionScrollSegment(root)
            : false;
        isScrolling.value = true;
        if (!transitioned && !options.isResizing.value && !resizeAnchorLifecycle.isActive()) {
            readCurrentAnchor();
        }
        viewportRevision.value += 1;
        if (!recentProgrammaticScroll) {
            markManualInteraction();
        }
        if (scrollSettleTimer) clearTimeout(scrollSettleTimer);
        scheduleRefresh();
        scrollSettleTimer = setTimeout(() => {
            isScrolling.value = false;
            scheduleRefresh();
        }, SCROLL_SETTLE_MS);
    }

    function markManualInteraction() {
        lastManualInteractionAtMs = Date.now();
    }

    function isAutoFollowSuppressed() {
        return (Date.now() - lastManualInteractionAtMs) < DOCUMENT_THUMBNAIL_AUTO_FOLLOW_COOLDOWN_MS;
    }

    function revealCurrentPage(optionsOverride: {force?: boolean} = {}) {
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
        const page = Math.min(source.pageCount, Math.max(1, options.currentPage.value));
        setActiveScrollSegmentForPage(page);
        const nextScrollTop = resolveDocumentThumbnailRevealScrollTop(
            getActiveScrollViewport(root),
            resolveDocumentThumbnailPageBounds(page, getActiveSegmentLayout()),
        );
        if (nextScrollTop !== null && Math.abs(root.scrollTop - nextScrollTop) >= 1) {
            lastProgrammaticScrollAtMs = Date.now();
            writeScrollTop(root, nextScrollTop);
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
            aspectRatio: String(1 / layout.getPageAspect(pageNumber)),
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
        async source => {
            lastManualInteractionAtMs = 0;
            scheduler.reset();
            states.clear();
            metricsCache.clear();
            clearRenderFailures();
            hasSourceAspectEstimate = false;
            lastKnownAnchor = null;
            layout.resetDocument({
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
            revealCurrentPage({force: true});
            readCurrentAnchor();
            scheduleRefresh();
        },
        {immediate: true},
    );
    watch(options.currentPage, async () => {
        setActiveScrollSegmentForPage(options.currentPage.value);
        await nextTick();
        revealCurrentPage();
        readCurrentAnchor();
        viewportRevision.value += 1;
        scheduleRefresh();
    });
    watch(options.itemMetricsKey, async (_value, previousValue) => {
        if (typeof previousValue === 'number' && Number.isSafeInteger(previousValue)) {
            updatePageChromeHeights([{
                pageNumber: previousValue,
                height: null,
            }]);
        }
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
        revealCurrentPage({force: true});
        readCurrentAnchor();
        viewportRevision.value += 1;
        scheduleRefresh();
    });
    watch(options.isResizing, resizing => {
        if (resizing) {
            resizeAnchorLifecycle.begin();
            if (resizeSettleTimer) clearTimeout(resizeSettleTimer);
            scheduleRefresh();
        } else {
            void resizeAnchorLifecycle.finish().then(scheduleRefresh);
            scheduleResizeSettle();
        }
    });

    onMounted(() => {
        mounted = true;
        resizeObserver = new ResizeObserver(() => {
            const wasVisible = isVisible.value;
            measureViewport();
            if (!wasVisible && isVisible.value && options.isActive.value) revealCurrentPage({force: true});
            scheduleRefresh();
            scheduleResizeSettle();
        });
        const root = options.scrollRoot.value;
        if (root) resizeObserver.observe(root);
        measureViewport();
        revealCurrentPage({force: true});
        scheduleRefresh();
    });
    onBeforeUnmount(() => {
        mounted = false;
        scrollRestorer.cancel();
        pendingScrollSegmentTransitionIndex = null;
        if (scheduledFrame !== null) cancelAnimationFrame(scheduledFrame);
        if (resizeSettleTimer) clearTimeout(resizeSettleTimer);
        if (scrollSettleTimer) clearTimeout(scrollSettleTimer);
        resizeAnchorLifecycle.cancel();
        resizeObserver?.disconnect();
        scheduler.dispose();
        states.clear();
        clearRenderFailures();
        metricsCache.clear();
    });

    return {
        activeScrollSegmentIndex,
        contentHeight,
        handlePointerDown: markManualInteraction,
        handleScroll,
        handleWheel: markManualInteraction,
        renderErrors: renderErrors as ReadonlySet<number>,
        retryRender,
        scheduleRefresh,
        states,
        virtualItems,
    };
};
