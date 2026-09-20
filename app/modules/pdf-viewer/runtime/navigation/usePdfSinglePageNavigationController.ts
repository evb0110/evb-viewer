import {
    parsePageNumber, requirePageNumber, 
} from '@contracts/pageNumbers';
import type { TPageNumber } from '@contracts/pageNumbers';
import {tryOnScopeDispose} from '@vueuse/core';
import {clamp} from 'es-toolkit/math';
import {createPdfNavigationMachineState} from '@app/modules/pdf-viewer/runtime/navigation/createPdfNavigationMachineState';
import type {IUsePdfSinglePageScrollOptions} from '@app/modules/pdf-viewer/runtime/navigation/pdfSinglePageScrollTypes';
import type {IScrollToPageOptions} from '@app/modules/pdf-viewer/engine/pdf-outline-navigation/scrollToPageOptions';
import type {IPdfPageSlotRegistry} from '@app/modules/pdf-viewer/runtime/page-slots/pdfPageSlotRegistry';
import {
    createPdfViewportGeometryFromLayout,
    getViewportGeometryRowForPage,
    resolveAnchorFromScroll,
    resolveRetainedAnchorFromScroll,
    resolveScrollForAnchor,
    type IPdfSemanticAnchor,
    type IPdfViewportGeometry,
} from '@app/modules/pdf-viewer/runtime/viewport/pdfViewportGeometry';
import {
    createViewportAuthority as createViewportAuthorityService,
    type IPdfViewportIntent,
    type IPdfViewportPositionCommit,
    type TPdfViewportIntentKind,
} from '@app/modules/pdf-viewer/runtime/viewport/createViewportAuthority';
import {
    createPageNavigationRequest,
    type IPdfNavigationRequest,
} from '@app/modules/pdf-viewer/engine/viewport/createPageNavigationRequest';
import {
    isPdfNavigationReady,
    resolvePdfNavigationAnchor,
    resolvePdfNavigationTarget,
    type IResolvedPdfNavigationTarget,
} from '@app/modules/pdf-viewer/runtime/viewport/pdfNavigationRequestResolver';
import {
    captureDocumentViewportResizeAnchor,
    createWheelFlipGate,
    canScrollWithinPageBounds,
    resolveWheelDirection,
    resolveWheelTargetPage,
    type IDocumentOpenSurfaceViewportIntentIdentity,
} from '@app/modules/document-viewer/public';
import { getLayoutPhysicalScrollOrigin } from '@app/modules/pdf-viewer/engine/pdf-page-layout/pdfPageLayoutMetrics';
import {getPageScrollBounds} from '@app/modules/pdf-viewer/runtime/navigation/singlePageScrollGeometry';
import {getCurrentSpreadRenderedBoundsFromDom} from '@app/modules/pdf-viewer/engine/pdf-horizontal-scroll-clamp/getCurrentSpreadRenderedBoundsFromDom';
import {HORIZONTAL_SCROLL_CLAMP_EPSILON_PX} from '@app/modules/pdf-viewer/engine/pdf-horizontal-scroll-clamp/resolvePageBoundedHorizontalScroll';
import {logPdfRenderTrace} from '@app/utils/pdfRenderTrace';
import {runGuardedTask} from '@app/utils/asyncGuard';
import {createLatestWinsPdfMetricHydrator} from '@app/modules/pdf-viewer/runtime/navigation/createLatestWinsPdfMetricHydrator';
import {createPdfNavigationVisualHandoff} from '@app/modules/pdf-viewer/runtime/navigation/createPdfNavigationVisualHandoff';
import {
    getRequestAnchor,
    getRequestPage,
} from '@app/modules/pdf-viewer/runtime/navigation/pdfNavigationRequestAnchors';
import {
    hasMeasurableMountedPage,
    resolvePagedAnchorFromViewport,
    resolvePagedScrollForAnchor,
} from '@app/modules/pdf-viewer/runtime/navigation/pdfMountedPageViewportGeometry';
import {yieldToBrowser} from '@app/utils/yieldToBrowser';
import {createPdfNavigationCommitRefiner} from '@app/modules/pdf-viewer/runtime/navigation/createPdfNavigationCommitRefiner';

interface IUsePdfSinglePageNavigationControllerOptions extends IUsePdfSinglePageScrollOptions {
    requestedCurrentPage: Ref<number | undefined>;
    viewerContainer: Ref<HTMLElement | null>;
    cancelPendingSearchScroll: () => void;
    pageSlots: IPdfPageSlotRegistry;
    bindCurrentPageProjection?: ((projection: Readonly<Ref<number>>) => void) | undefined;
    getDocumentRevision: () => number;
    getGeometryRevision: () => number;
    onViewportPositionCommitted?: ((commit: IPdfViewportPositionCommit, expected?: IDocumentOpenSurfaceViewportIntentIdentity | null) => boolean) | undefined;
    onUserViewportPageObserved?: ((pageNumber: TPageNumber) => void) | undefined;
    captureSurfaceNavigation?: ((pageNumber: TPageNumber) => IDocumentOpenSurfaceViewportIntentIdentity | null) | undefined;
    captureCurrentSurfaceNavigation?: (() => IDocumentOpenSurfaceViewportIntentIdentity | null) | undefined;
    isSurfaceNavigationCurrent?: ((expected: IDocumentOpenSurfaceViewportIntentIdentity) => boolean) | undefined;
    onSurfaceNavigationAbandoned?: ((expected: IDocumentOpenSurfaceViewportIntentIdentity, page: number) => boolean) | undefined;
    onPageVisualReady?: ((pageNumber: TPageNumber) => void) | undefined;
    beginLayoutGeometryReplacement?: (() => () => void) | undefined;
}

interface IPdfSinglePageWheelEvent {
    deltaX: number;
    deltaY: number;
    timeStamp: number;
    preventDefault: () => void;
}

interface IPdfViewportIntentDocument {
    document: NonNullable<IUsePdfSinglePageScrollOptions['pdfDocument']['value']>;
    revision: number;
    page: TPageNumber | null;
    navigationSequence?: number | undefined;
    surface: IDocumentOpenSurfaceViewportIntentIdentity | null;
}

export function shouldSubmitRequestedCurrentPage(
    requestedPage: number,
    committedPage: number,
    pendingPage: number | null,
) {
    // Explicit page commands remain authoritative while the outer page model catches up.
    return pendingPage === null && requestedPage !== committedPage;
}

export const usePdfSinglePageNavigationController = (options: IUsePdfSinglePageNavigationControllerOptions) => {
    const pageCount = () => Math.max(1, options.numPages.value);
    const toPageNumber = (page: number) => requirePageNumber(page, pageCount());
    // Readiness probes run after awaited renders. A document that was closed
    // mid-flight leaves no live page range, so report "not fresh" rather than
    // throwing a page-number contract violation into the viewport authority.
    const isPageFreshForNavigation = (page: number) => {
        const pageNumber = options.numPages.value > 0 ? parsePageNumber(page, options.numPages.value) : null;
        if (pageNumber === null) {
            return false;
        }
        return options.isPageFreshlyRenderedForNavigation?.(pageNumber) ?? true;
    };
    // The viewport authority's committed page outlives a document swap by a
    // tick. requirePageNumber rejects rather than clamps, so branding that stale
    // page unbounded would throw the viewport update away instead of letting it
    // settle into the shorter document.
    const toBoundedPageNumber = (page: number) => toPageNumber(clamp(Math.trunc(page), 1, pageCount()));
    let intentSequence = 0;
    let navigationIntentSequence = 0;
    let viewportPreviewWriteSequence = 0;
    const navigationVisualHandoff = createPdfNavigationVisualHandoff();
    const wheelNavigationCursorPage = ref<number | null>(null);
    const desiredNavigation = shallowRef<{
        request: IPdfNavigationRequest;
        sequence: number;
        document?: IUsePdfSinglePageScrollOptions['pdfDocument']['value'];
        documentRevision?: number;
        surface?: IDocumentOpenSurfaceViewportIntentIdentity | null;
    } | null>(null);
    const desiredNavigationPage = computed(() => desiredNavigation.value
        ? getNavigationRequestPage(desiredNavigation.value.request)
        : null);
    const wheelFlipGate = createWheelFlipGate();
    let geometry: IPdfViewportGeometry | null = null;
    const resolvedTargets = new Map<string, IResolvedPdfNavigationTarget>();
    // A load token alone is insufficient: cleanup retires the PDF proxy before
    // the next load begins. Every continuation belongs to this exact document.
    const intentDocuments = new Map<string, IPdfViewportIntentDocument>();
    function captureIntentDocument(intentId: string) {
        const document = options.pdfDocument.value;
        if (!document || options.isLoading.value || options.numPages.value <= 0) {
            return null;
        }
        const captured: IPdfViewportIntentDocument = {
            document,
            revision: options.getDocumentRevision(),
            page: null,
            surface: options.captureCurrentSurfaceNavigation?.() ?? null,
        };
        intentDocuments.set(intentId, captured);
        return captured;
    }
    function isIntentDocumentCurrent(intent: IPdfViewportIntent) {
        const captured = intentDocuments.get(intent.id);
        return captured !== undefined
            && captured.document === options.pdfDocument.value
            && captured.revision === options.getDocumentRevision()
            && !options.isLoading.value
            && options.numPages.value > 0
            && (captured.surface
                ? options.isSurfaceNavigationCurrent?.(captured.surface) !== false
                : options.captureCurrentSurfaceNavigation?.() == null);
    }
    function requireIntentDocument(intent: IPdfViewportIntent, signal?: AbortSignal) {
        const captured = intentDocuments.get(intent.id);
        if (signal?.aborted || !captured || !isIntentDocumentCurrent(intent)) {
            throw new DOMException('PDF viewport document retired', 'AbortError');
        }
        return captured;
    }
    function requireIntentPage(intent: IPdfViewportIntent, signal?: AbortSignal) {
        const captured = requireIntentDocument(intent, signal);
        if (captured.page === null) {
            throw new DOMException('PDF viewport target unresolved', 'AbortError');
        }
        return captured.page;
    }
    const metricHydrator = createLatestWinsPdfMetricHydrator(async page => (
        await options.ensurePageMetricsInRange?.(page, page) ?? false
    ));
    let getGeometryAnchorPage = () => options.currentPage.value;

    function refreshGeometry() {
        const container = options.viewerContainer.value;
        const metrics = options.getPageLayoutMetrics?.() ?? null;
        if (!container || !metrics) {
            geometry = null;
            return null;
        }
        const geometryRevision = options.getGeometryRevision();
        geometry = createPdfViewportGeometryFromLayout(metrics, {
            width: container.clientWidth,
            height: container.clientHeight,
            paddingInline: options.scaledMargin.value,
        }, geometryRevision, options.getPhysicalScrollOrigin?.()
            ?? getLayoutPhysicalScrollOrigin(metrics, getGeometryAnchorPage()));
        return geometry;
    }

    function resolveAnchorForViewport(
        snapshot: IPdfViewportGeometry,
        pageNumber: TPageNumber,
        viewportFraction?: {
            x: number;
            y: number;
        },
    ) {
        const container = options.viewerContainer.value;
        if (!options.continuousScroll.value && container) {
            return resolvePagedAnchorFromViewport(container, pageNumber, viewportFraction);
        }
        return resolveAnchorFromScroll(snapshot, {
            left: container?.scrollLeft ?? 0,
            top: container?.scrollTop ?? 0,
        }, viewportFraction);
    }

    function resolveScrollForViewport(snapshot: IPdfViewportGeometry, anchor: IPdfSemanticAnchor) {
        const container = options.viewerContainer.value;
        if (container && !options.continuousScroll.value) {
            return resolvePagedScrollForAnchor(container, anchor, options.scaledMargin.value);
        }
        return resolveScrollForAnchor(snapshot, anchor);
    }

    function resolveNavigationScrollForViewport(snapshot: IPdfViewportGeometry, anchor: IPdfSemanticAnchor) {
        const container = options.viewerContainer.value;
        if (container && hasMeasurableMountedPage(container, requirePageNumber(anchor.page))) {
            const scroll = resolvePagedScrollForAnchor(container, anchor, options.scaledMargin.value);
            const spread = getCurrentSpreadRenderedBoundsFromDom({
                container,
                pageNumber: requirePageNumber(anchor.page),
                viewMode: options.viewMode.value,
                totalPages: options.numPages.value,
            });
            scroll.left = spread && spread.width <= container.clientWidth + HORIZONTAL_SCROLL_CLAMP_EPSILON_PX
                ? 0
                : scroll.left;
            return scroll;
        }
        return resolveScrollForViewport(snapshot, anchor);
    }

    const refineNavigationCommit = createPdfNavigationCommitRefiner({
        getContainer: () => options.viewerContainer.value,
        refreshGeometry,
        resolvedTargets,
        resolveAnchorForViewport,
        resolveNavigationScrollForViewport,
    });

    const viewportAuthority = createViewportAuthorityService({
        getDocumentRevision: options.getDocumentRevision,
        getGeometryRevision: options.getGeometryRevision,
        isIntentCurrent: isIntentDocumentCurrent,
        beginLayoutGeometryReplacement: options.beginLayoutGeometryReplacement,
        awaitMetrics: async (intent, signal) => {
            const captured = requireIntentDocument(intent, signal);
            const resolved = intent.navigation
                ? await resolvePdfNavigationTarget(intent.navigation.target, captured.document, signal)
                : null;
            requireIntentDocument(intent, signal);
            if (resolved) {
                resolvedTargets.set(intent.id, resolved);
                navigationVisualHandoff.resolveIntent(intent.id, resolved.page, signal.aborted);
            }
            const page = requirePageNumber(
                resolved?.page ?? getRequestPage(intent.navigation, intent.anchor?.page ?? options.currentPage.value),
                captured.document.numPages,
            );
            captured.page = page;
            const desired = desiredNavigation.value;
            if (intent.navigation && desired && desired.sequence === captured.navigationSequence) {
                if (desired.surface === undefined) {
                    desired.surface = options.captureSurfaceNavigation?.(page) ?? null;
                }
                captured.surface = desired.surface;
            }
            await metricHydrator.ensure(page, signal);
            requireIntentDocument(intent, signal);
            if (!options.continuousScroll.value || intent.navigation) {
                await options.prepareNavigationLayout?.(page, signal);
                requireIntentDocument(intent, signal);
            }
            refreshGeometry();
            return options.getGeometryRevision();
        },
        resolve: (intent) => {
            const container = options.viewerContainer.value;
            const snapshot = geometry ?? refreshGeometry();
            const resolved = resolvedTargets.get(intent.id);
            const anchor = intent.navigation && resolved
                ? resolvePdfNavigationAnchor(intent.navigation, resolved, snapshot)
                : intent.anchor ?? getRequestAnchor(intent.navigation, options.currentPage.value);
            if (!container || !snapshot) {
                throw new DOMException('PDF viewport geometry unavailable', 'AbortError');
            }
            const scroll = intent.kind === 'dpr'
                ? {
                    left: container.scrollLeft,
                    top: container.scrollTop,
                }
                : resolveScrollForViewport(snapshot, anchor);
            return Promise.resolve({
                anchor,
                ...scroll,
                ...(intent.zoom === undefined ? {} : {zoom: intent.zoom}),
                ...(intent.viewMode === undefined ? {} : {viewMode: intent.viewMode}),
            });
        },
        refine: (intent, commit) => {
            if (intent.navigation) return refineNavigationCommit(intent, commit);
            if (intent.kind === 'dpr') return Promise.resolve(commit);
            // Slots now carry the committed layout, including padding and
            // scrollbar admission. Resolve the semantic point once against
            // those mounted bounds before the authority writes the viewport.
            const snapshot = refreshGeometry();
            const container = options.viewerContainer.value;
            const anchor = intent.viewportPoint && container ? {
                ...commit.anchor,
                viewportXFraction: intent.viewportPoint.x / Math.max(1, container.clientWidth),
                viewportYFraction: intent.viewportPoint.y / Math.max(1, container.clientHeight),
            } : commit.anchor;
            return Promise.resolve(snapshot ? {
                ...commit,
                anchor,
                ...resolveNavigationScrollForViewport(snapshot, anchor),
            } : commit);
        },
        refineAfterVisual: (intent, commit) => (
            intent.navigation
                ? refineNavigationCommit(intent, commit)
                : Promise.resolve(commit)
        ),
        awaitSlots: async (intent, signal) => {
            const page = requireIntentPage(intent, signal);
            const captured = requireIntentDocument(intent, signal);
            const row = geometry ? getViewportGeometryRowForPage(geometry, page) : null;
            const start = row?.startPage ?? page;
            const end = row?.endPage ?? page;
            await nextTick();
            requireIntentDocument(intent, signal);
            await Promise.all(Array.from({length: end - start + 1}, (_, offset) => (
                options.pageSlots.whenMounted(requirePageNumber(start + offset, captured.document.numPages), signal)
            )));
        },
        awaitLayoutGeometrySettled: async (_intent, _signal) => {
            await yieldToBrowser();
        },
        apply: (intent, commit) => {
            requireIntentDocument(intent);
            const container = options.viewerContainer.value;
            if (!container || intent.kind === 'dpr') {
                return;
            }
            const applied = options.viewportWritePort.apply(container, {
                intent: options.viewportWritePort.beginIntent(intent.id),
                reason: `viewport-authority:${intent.kind}`,
                left: commit.left,
                top: commit.top,
            });
            logPdfRenderTrace('navigation-viewport-authority-applied', {
                intentId: intent.id,
                kind: intent.kind,
                page: commit.anchor.page,
                requestedLeft: commit.left,
                requestedTop: commit.top,
                actualLeft: container.scrollLeft,
                actualTop: container.scrollTop,
                applied,
            });
            // The authority clears its pending target immediately after apply.
            // Project the just-written scroll position into visibleRange first so
            // virtualization transfers ownership to the target row instead of
            // collapsing back to the stale pre-navigation window for one frame.
            options.updateVisibleRange(container, options.numPages.value);
            requireIntentDocument(intent);
            void nextTick(() => logPdfRenderTrace('navigation-viewport-authority-after-range-update', {
                intentId: intent.id,
                page: commit.anchor.page,
                actualLeft: container.scrollLeft,
                actualTop: container.scrollTop,
            }));
            return {
                left: container.scrollLeft,
                top: container.scrollTop,
            };
        },
        onPositionCommitted: (commit) => {
            const captured = intentDocuments.get(commit.intentId);
            const accepted = options.onViewportPositionCommitted?.(commit, captured?.surface);
            const sequence = captured?.navigationSequence;
            if (sequence !== undefined && desiredNavigation.value?.sequence === sequence) {
                if (accepted !== false) {
                    desiredNavigation.value = null;
                }
            }
        },
        awaitVisual: async (intent, signal) => {
            const page = requireIntentPage(intent, signal);
            const row = geometry ? getViewportGeometryRowForPage(geometry, page) : null;
            const container = options.viewerContainer.value;
            const readiness = intent.navigation?.readiness ?? 'page-canvas';
            const range = {
                start: row?.startPage ?? page,
                end: row?.endPage ?? page,
            };
            logPdfRenderTrace('navigation-await-visual-enter', () => ({
                intentId: intent.id,
                kind: intent.kind,
                page,
                range,
                readiness,
                hasContainer: container !== null,
                currentPage: options.currentPage.value,
                visibleRange: options.visibleRange.value,
            }));
            const waitForTextLayer = readiness === 'text-layer'
                ? options.waitForPageTextLayerReady
                : undefined;
            const ensureTextLayerReady = async () => {
                if (!waitForTextLayer) {
                    return;
                }
                const ready = await waitForTextLayer(page, signal);
                requireIntentDocument(intent, signal);
                if (!ready) {
                    throw new DOMException('PDF navigation text layer readiness timed out', 'AbortError');
                }
            };
            if (container && isPdfNavigationReady(
                container,
                page,
                readiness,
                isPageFreshForNavigation,
            )) {
                await ensureTextLayerReady();
                requireIntentDocument(intent, signal);
                options.onPageVisualReady?.(page);
                logPdfRenderTrace('navigation-await-visual-exit', {
                    intentId: intent.id,
                    page,
                    readiness,
                    outcome: 'already-ready',
                });
                return;
            }
            await options.renderVisiblePages(range, {
                authoritativeRaster: true,
                preserveRenderedPages: true,
                retainOnlyCurrentResidentRaster: true,
                suppressResidentRasterDemand: false,
                ...(readiness === 'text-layer' ? {prioritizeTextLayer: true} : {}),
            });
            requireIntentDocument(intent, signal);
            await ensureTextLayerReady();
            requireIntentDocument(intent, signal);
            if (container && !isPdfNavigationReady(
                container,
                page,
                readiness,
                isPageFreshForNavigation,
            )) {
                logPdfRenderTrace('navigation-await-visual-exit', {
                    intentId: intent.id,
                    page,
                    readiness,
                    outcome: 'render-settled-not-ready',
                });
                throw new DOMException(`PDF navigation readiness not reached: ${readiness}`, 'AbortError');
            }
            if (container) {
                options.onPageVisualReady?.(page);
            }
            logPdfRenderTrace('navigation-await-visual-exit', {
                intentId: intent.id,
                page,
                readiness,
                outcome: container ? 'ready' : 'container-detached',
            });
        },
        beforeApply: async (intent, signal) => {
            if (signal.aborted || !navigationVisualHandoff.releaseIntent(intent.id)) {
                return;
            }
            await nextTick();
            requireIntentDocument(intent, signal);
            refreshGeometry();
        },
        postArrival: async (request, signal) => {
            if (!signal.aborted) {
                await options.onNavigationPostArrival?.(request, signal);
            }
            if (signal.aborted) {
                return;
            }
            const container = options.viewerContainer.value;
            if (container && request.postArrival) {
                container.dispatchEvent(new CustomEvent('pdf-navigation-post-arrival', {detail: {
                    effect: request.postArrival,
                    request,
                }}));
            }
        },
        clearDemand: intentId => {
            resolvedTargets.delete(intentId);
            intentDocuments.delete(intentId);
        },
    });
    getGeometryAnchorPage = () => (
        viewportAuthority.pendingTargetPage.value
        ?? desiredNavigationPage.value
        ?? options.currentPage.value
    );
    options.bindCurrentPageProjection?.(viewportAuthority.currentPage);

    function requestFor(page: number, scrollOptions?: IScrollToPageOptions) {
        if (scrollOptions?.navigationRequest) {
            return scrollOptions.navigationRequest;
        }
        const source = scrollOptions?.navigationSource
            ?? (scrollOptions?.markerRect ? 'annotation' : 'toolbar');
        const request = createPageNavigationRequest(page, source);
        if (scrollOptions?.markerRect) {
            request.target = {
                kind: 'rect',
                page,
                rect: scrollOptions.markerRect,
            };
            request.alignment = 'rect-center';
        } else if (scrollOptions?.textAnchor) {
            request.target = {
                kind: 'text-anchor',
                page,
                ...scrollOptions.textAnchor,
            };
            request.alignment = 'rect-center';
        } else if (typeof scrollOptions?.pageYRatio === 'number') {
            request.target = {
                kind: 'rect',
                page,
                rect: {
                    left: 0.5,
                    top: clamp(scrollOptions.pageYRatio, 0, 1),
                    width: 0,
                    height: 0,
                },
            };
            request.alignment = 'page-top';
        }
        if (source === 'search') {
            request.searchNavigationId = scrollOptions?.searchNavigationId;
            request.readiness = 'text-layer';
            request.postArrival = 'search-highlight';
        } else if (source === 'annotation') {
            request.readiness = 'annotation-editor';
            request.postArrival = 'annotation-pulse';
        } else if (source === 'bookmark') {
            request.readiness = 'page-canvas';
        } else if (source === 'thumbnail') {
            request.readiness = 'page-canvas';
        }
        return request;
    }

    async function submitNavigationIntent(request: IPdfNavigationRequest, sequence: number) {
        const intentId = `viewport-navigation-${String(++navigationIntentSequence)}`;
        const captured = captureIntentDocument(intentId);
        if (!captured) {
            return;
        }
        captured.navigationSequence = sequence;
        if (desiredNavigation.value?.surface !== undefined) {
            captured.surface = desiredNavigation.value.surface;
        }
        refreshGeometry();
        navigationVisualHandoff.registerIntent(intentId, sequence);
        try {
            return await viewportAuthority.submit({
                id: intentId,
                kind: request.source === 'search' ? 'search' : request.source === 'wheel' ? 'wheel-page' : 'navigate',
                documentRevision: captured.revision,
                geometryRevision: options.getGeometryRevision(),
                navigation: request,
            });
        } catch (error) {
            if (desiredNavigation.value?.sequence === sequence) {
                clearQueuedNavigation();
            }
            throw error;
        } finally {
            navigationVisualHandoff.finishIntent(intentId);
            navigationVisualHandoff.clearSequence(sequence);
            scheduleNavigationReconcile();
        }
    }

    let navigationReconcileScheduled = false;
    function scheduleNavigationReconcile() {
        if (navigationReconcileScheduled) return;
        navigationReconcileScheduled = true;
        void nextTick(() => {
            navigationReconcileScheduled = false;
            replayQueuedNavigation();
        });
    }

    function submitDetachedNavigationIntent(request: IPdfNavigationRequest, sequence: number) {
        runGuardedTask(() => submitNavigationIntent(request, sequence), {
            category: 'background-diagnostic',
            scope: 'pdf-navigation',
            message: `PDF viewport navigation ${sequence} failed`,
        });
    }

    function getNavigationRequestPage(request: IPdfNavigationRequest) {
        return 'page' in request.target ? request.target.page : null;
    }

    function clampNavigationRequest(
        request: IPdfNavigationRequest,
        totalPages: number,
    ): IPdfNavigationRequest {
        if (!('page' in request.target)) {
            return request;
        }
        const page = clamp(Math.trunc(request.target.page), 1, totalPages);
        return {
            ...request,
            target: {
                ...request.target,
                page,
            },
        };
    }

    function canReplayQueuedNavigation() {
        return Boolean(
            desiredNavigation.value
            && viewportAuthority.activeIntent.value === null
            && isNavigationRuntimeReady(),
        );
    }

    function isNavigationRuntimeReady() {
        return Boolean(
            options.viewerContainer.value
            && !options.isLoading.value
            && options.pdfDocument.value
            && options.numPages.value > 0
            && options.getDocumentRevision() > 0
            && options.getGeometryRevision() > 0
            && options.getPageLayoutMetrics?.() !== null,
        );
    }
    const navigationRuntimeReady = computed(isNavigationRuntimeReady);

    function replayQueuedNavigation() {
        if (!canReplayQueuedNavigation()) {
            logPdfRenderTrace('navigation-queued-replay-deferred', () => ({
                hasQueuedNavigation: desiredNavigation.value !== null,
                activeIntentId: viewportAuthority.activeIntent.value?.id ?? null,
                hasContainer: options.viewerContainer.value !== null,
                isLoading: options.isLoading.value,
                hasDocument: options.pdfDocument.value !== null,
                numPages: options.numPages.value,
                documentRevision: options.getDocumentRevision(),
                geometryRevision: options.getGeometryRevision(),
                hasLayoutMetrics: options.getPageLayoutMetrics?.() !== null,
            }));
            return false;
        }
        const queued = desiredNavigation.value;
        if (!queued) {
            return false;
        }
        if (queued.document && (queued.document !== options.pdfDocument.value
            || queued.documentRevision !== options.getDocumentRevision())) {
            clearQueuedNavigation();
            return false;
        }
        if (queued.surface !== undefined && (queued.surface
            ? options.isSurfaceNavigationCurrent?.(queued.surface) === false
            : options.captureCurrentSurfaceNavigation?.() != null)) {
            clearQueuedNavigation();
            return false;
        }
        queued.document = options.pdfDocument.value;
        queued.documentRevision = options.getDocumentRevision();
        const request = clampNavigationRequest(queued.request, options.numPages.value);
        desiredNavigation.value = {
            ...queued,
            request,
        };
        const page = getNavigationRequestPage(request);
        if (page !== null) {
            const pageNumber = requirePageNumber(page, options.numPages.value);
            if (queued.surface === undefined) {
                queued.surface = options.captureSurfaceNavigation?.(pageNumber) ?? null;
                desiredNavigation.value = {
                    ...queued,
                    request,
                };
            }
            options.emitNavigationFeedbackPage?.(page);
        }
        submitDetachedNavigationIntent(request, queued.sequence);
        logPdfRenderTrace('navigation-queued-replay-submitted', {
            sequence: queued.sequence,
            page,
        });
        return true;
    }

    function queueNavigationRequest(request: IPdfNavigationRequest) {
        if (request.source !== 'wheel') {
            wheelNavigationCursorPage.value = null;
            // An explicit command is newer than a fling still emitting inertial
            // packets, so that gesture can no longer cancel or displace it.
            options.viewportWritePort.fenceCommandAgainstLiveGesture();
        }
        intentSequence += 1;
        desiredNavigation.value = {
            request,
            sequence: intentSequence,
        };
        const page = getNavigationRequestPage(request);
        if (page !== null) {
            // Preserve the raw requested page until metadata supplies the only
            // authoritative clamp. This makes rapid commands durable during
            // Recent/open transitions without committing viewport state early.
            navigationVisualHandoff.assign(page, intentSequence);
            options.emitNavigationFeedbackPage?.(page);
        }
        viewportAuthority.suspend();
        replayQueuedNavigation();
        return true;
    }

    function clearQueuedNavigation() {
        const abandoned = desiredNavigation.value;
        desiredNavigation.value = null;
        if (abandoned?.surface) {
            options.onSurfaceNavigationAbandoned?.(abandoned.surface, viewportAuthority.currentPage.value);
        }
        intentSequence += 1;
        if (viewportAuthority.activeIntent.value === null) {
            navigationVisualHandoff.clear();
        }
        wheelNavigationCursorPage.value = null;
        options.emitNavigationFeedbackPage?.(null);
    }

    function submitPageNavigation(pageNumber: TPageNumber, scrollOptions?: IScrollToPageOptions) {
        if (!Number.isFinite(pageNumber)) {
            return false;
        }
        const page = Math.max(1, Math.trunc(pageNumber));
        const request = requestFor(page, scrollOptions);
        return queueNavigationRequest(request);
    }

    function submitNavigationRequest(request: IPdfNavigationRequest) {
        return queueNavigationRequest(request);
    }

    function submitViewportStateIntent(
        kind: Exclude<TPdfViewportIntentKind, 'navigate' | 'search' | 'wheel-page' | 'user-scroll'>,
        state: {
            zoom?: number;
            viewMode?: IUsePdfSinglePageScrollOptions['viewMode']['value'];
            dpr?: number;
            viewportPoint?: {
                x: number;
                y: number
            };
            anchor?: IPdfSemanticAnchor;
        } = {},
    ) {
        const documentRevision = options.getDocumentRevision();
        const geometryRevision = options.getGeometryRevision();
        if (!navigationRuntimeReady.value || documentRevision <= 0 || geometryRevision <= 0) {
            // ResizeObserver and reactive layout watchers can run while a PDF
            // surface is being mounted or torn down. At that boundary there
            // is deliberately no live document generation to own a viewport
            // write, so treat the transient intent as cancelled instead of
            // violating the viewport authority's revision invariant.
            logPdfRenderTrace('navigation-viewport-state-intent-cancelled', () => ({
                kind,
                documentRevision,
                geometryRevision,
                reason: 'inactive-revision',
            }));
            return Promise.resolve({
                outcome: 'cancelled' as const,
                intent: null,
                positionCommit: null,
            });
        }
        intentSequence += 1;
        const container = options.viewerContainer.value;
        const snapshot = refreshGeometry();
        const inheritedNavigation = desiredNavigation.value?.request;
        const absorbedNavigation = navigationRuntimeReady.value
            && (state.anchor === undefined || kind === 'resize' || kind === 'zoom')
            && state.viewportPoint === undefined
            ? inheritedNavigation
            : undefined;
        const inheritedNavigationPage = absorbedNavigation
            ? getNavigationRequestPage(absorbedNavigation)
            : null;
        const inheritedResolvedTarget = viewportAuthority.activeIntent.value
            ? resolvedTargets.get(viewportAuthority.activeIntent.value.id)
            : null;
        const anchor = (absorbedNavigation ? undefined : state.anchor) ?? (container && snapshot && state.viewportPoint
            ? captureCurrentSemanticAnchor(state.viewportPoint) ?? getRequestAnchor(undefined, viewportAuthority.currentPage.value)
            : absorbedNavigation && inheritedResolvedTarget
                ? resolvePdfNavigationAnchor(absorbedNavigation, inheritedResolvedTarget, snapshot)
                : absorbedNavigation
                    ? getRequestAnchor(
                        absorbedNavigation,
                        inheritedNavigationPage ?? options.currentPage.value,
                    )
                    : desiredNavigationPage.value !== null
                        ? getRequestAnchor(undefined, desiredNavigationPage.value)
                        : container && snapshot
                            ? resolveGeometryChangeAnchor(snapshot, kind)
                            : viewportAuthority.committedAnchor.value
                                ?? getRequestAnchor(undefined, options.currentPage.value));
        const absorbedNavigationSequence = desiredNavigation.value?.sequence ?? null;
        if (absorbedNavigation) {
            // Geometry may execute the destination, but the desired command
            // stays owned here until a matching position commits.
            if (inheritedNavigationPage !== null) {
                navigationVisualHandoff.assign(inheritedNavigationPage, intentSequence);
            }
        }
        logPdfRenderTrace('navigation-viewport-state-intent-submitted', () => ({
            kind,
            inheritedNavigationPage,
            absorbedNavigationSequence,
            desiredPage: desiredNavigationPage.value,
            committedPage: viewportAuthority.currentPage.value,
            anchorPage: anchor.page,
        }));
        const viewportStateIntentId = `viewport-state-${intentSequence}`;
        const captured = captureIntentDocument(viewportStateIntentId);
        if (absorbedNavigation) {
            if (captured) {
                captured.navigationSequence = absorbedNavigationSequence ?? undefined;
                if (desiredNavigation.value?.surface !== undefined) {
                    captured.surface = desiredNavigation.value.surface;
                }
            }
            navigationVisualHandoff.registerIntent(viewportStateIntentId, intentSequence);
        }
        const submission = viewportAuthority.submit({
            id: viewportStateIntentId,
            kind,
            documentRevision,
            geometryRevision,
            anchor,
            ...(absorbedNavigation === undefined ? {} : {navigation: absorbedNavigation}),
            ...(state.zoom === undefined ? {} : {zoom: state.zoom}),
            ...(state.viewportPoint === undefined ? {} : {viewportPoint: state.viewportPoint}),
            ...(state.viewMode === undefined ? {} : {viewMode: state.viewMode}),
            ...(state.dpr === undefined ? {} : {dpr: state.dpr}),
        });
        const handoffSequence = intentSequence;
        return submission.finally(() => {
            navigationVisualHandoff.finishIntent(viewportStateIntentId);
            navigationVisualHandoff.clearSequence(handoffSequence);
            scheduleNavigationReconcile();
        });
    }

    // Geometry changes retain the committed page instead of reinterpreting an old pixel offset.
    function resolveGeometryChangeAnchor(
        snapshot: IPdfViewportGeometry,
        kind: TPdfViewportIntentKind,
    ): IPdfSemanticAnchor {
        const semanticPage = toBoundedPageNumber(viewportAuthority.currentPage.value);
        if (kind === 'fit') {
            // Fit replaces row heights, so retain the committed page instead of the old pixel offset.
            return getRequestAnchor(undefined, semanticPage);
        }
        const liveAnchor = resolveAnchorForViewport(snapshot, toBoundedPageNumber(viewportAuthority.currentPage.value));
        // A zoom ref and page layout can update before this watcher runs. Keep
        // the live point fractions, but do not reinterpret the old pixel scroll
        // against new-scale rows and jump to an earlier page. The viewport
        // authority's committed page is the semantic owner here; the outer
        // requested-page prop can briefly lag after a completed toolbar
        // navigation.
        return kind === 'zoom'
            ? {
                ...liveAnchor,
                page: semanticPage,
            }
            : liveAnchor;
    }

    function observeNativeUserScroll(anchorOverride?: IPdfSemanticAnchor) {
        if (desiredNavigation.value !== null) {
            clearQueuedNavigation();
        }
        const container = options.viewerContainer.value;
        const snapshot = refreshGeometry();
        const anchor = anchorOverride ?? (container && snapshot
            ? resolveAnchorForViewport(snapshot, toBoundedPageNumber(viewportAuthority.currentPage.value))
            : getRequestAnchor(undefined, options.currentPage.value));
        viewportAuthority.observeUserScroll(anchor);
        if (container) options.viewportWritePort.observeUserScroll(container);
        return anchor.page;
    }

    function captureCurrentSemanticAnchor(viewportPoint?: {
        x: number;
        y: number
    }) {
        const container = options.viewerContainer.value;
        // A zoom ref can already contain the next scale while Vue still
        // paints the previous page track. Sample the mounted reading point,
        // rather than interpreting its scroll offset with next-scale metrics.
        const mounted = container ? captureDocumentViewportResizeAnchor(container, viewportPoint ? {viewportPoint} : undefined) : null;
        if (mounted) {
            return {
                page: mounted.pageNumber,
                pageXFraction: mounted.pageRatioX,
                pageYFraction: mounted.pageRatioY,
                viewportXFraction: mounted.viewportRatioX,
                viewportYFraction: mounted.viewportRatioY,
                affinity: 'center' as const,
            };
        }
        const snapshot = refreshGeometry();
        if (viewportPoint && container && snapshot) {
            return resolveAnchorForViewport(snapshot, toBoundedPageNumber(viewportAuthority.currentPage.value), {
                x: viewportPoint.x / Math.max(1, container.clientWidth),
                y: viewportPoint.y / Math.max(1, container.clientHeight),
            });
        }
        return container && snapshot
            ? options.continuousScroll.value
                ? resolveRetainedAnchorFromScroll(snapshot, {
                    left: container.scrollLeft,
                    top: container.scrollTop,
                }, viewportAuthority.committedAnchor.value)
                : resolvePagedAnchorFromViewport(container, toBoundedPageNumber(viewportAuthority.currentPage.value))
            : viewportAuthority.committedAnchor.value;
    }

    function applyViewportAnchorPreview(anchor: IPdfSemanticAnchor | null | undefined) {
        if (desiredNavigation.value || viewportAuthority.getActiveNavigationRequest()) {
            return null;
        }
        const container = options.viewerContainer.value;
        const snapshot = refreshGeometry();
        if (!anchor || !container || !snapshot) {
            return false;
        }
        const scroll = resolveScrollForViewport(snapshot, anchor);
        const applied = options.viewportWritePort.apply(container, {
            intent: options.viewportWritePort.beginIntent(
                `pdf-viewport-preview-${String(++viewportPreviewWriteSequence)}`,
            ),
            reason: 'viewport-anchor-preview',
            ...scroll,
        });
        options.updateVisibleRange(container, options.numPages.value);
        return applied;
    }

    function commitCurrentViewportPosition(
        pageNumber: TPageNumber,
        intentId: string,
        intentKind: TPdfViewportIntentKind = 'document-restore',
    ) {
        const container = options.viewerContainer.value;
        const snapshot = refreshGeometry();
        if (!container || !snapshot || viewportAuthority.activeIntent.value !== null) {
            return false;
        }
        const page = toPageNumber(clamp(Math.trunc(pageNumber), 1, pageCount()));
        const anchor = {
            ...resolveAnchorForViewport(snapshot, page),
            page,
        };
        return viewportAuthority.commitSettledPosition({
            intentId,
            intentKind,
            documentRevision: options.getDocumentRevision(),
            geometryRevision: options.getGeometryRevision(),
            page,
            left: container.scrollLeft,
            top: container.scrollTop,
            anchor,
        }) !== null;
    }

    function commitCurrentViewportIfSettled(pageNumber: TPageNumber) {
        const container = options.viewerContainer.value;
        const snapshot = refreshGeometry();
        if (!container || !snapshot || viewportAuthority.activeIntent.value !== null) {
            return false;
        }
        const page = toPageNumber(clamp(Math.trunc(pageNumber), 1, pageCount()));
        const expected = resolveScrollForViewport(snapshot, getRequestAnchor(undefined, page));
        if (
            Math.abs(container.scrollLeft - expected.left) > 1
            || Math.abs(container.scrollTop - expected.top) > 1
        ) {
            return false;
        }
        return commitCurrentViewportPosition(page, `viewport-observed-${String(++intentSequence)}`);
    }

    function captureViewportCommitDiagnostics(pageNumber: TPageNumber) {
        const container = options.viewerContainer.value;
        const layout = options.getPageLayoutMetrics?.() ?? null;
        const snapshot = container && layout
            ? createPdfViewportGeometryFromLayout(layout, {
                width: container.clientWidth,
                height: container.clientHeight,
            }, options.getGeometryRevision(), getLayoutPhysicalScrollOrigin(
                layout,
                options.currentPage.value,
            ))
            : null;
        const page = toPageNumber(clamp(Math.trunc(pageNumber), 1, pageCount()));
        const expected = snapshot
            ? resolveScrollForViewport(snapshot, getRequestAnchor(undefined, page))
            : null;
        return {
            hasContainer: container !== null,
            containerConnected: container?.isConnected ?? false,
            hasLayout: layout !== null,
            hasGeometry: snapshot !== null,
            actualLeft: container?.scrollLeft ?? null,
            actualTop: container?.scrollTop ?? null,
            expectedLeft: expected?.left ?? null,
            expectedTop: expected?.top ?? null,
            clientWidth: container?.clientWidth ?? null,
            clientHeight: container?.clientHeight ?? null,
            scrollWidth: container?.scrollWidth ?? null,
            scrollHeight: container?.scrollHeight ?? null,
            layoutTotalPages: layout?.base.totalPages ?? null,
            layoutScale: layout?.scale ?? null,
        };
    }

    function cancelProgrammaticNavigation(
        reason = 'explicit-cancel',
        anchorOverride?: IPdfSemanticAnchor,
    ) {
        wheelFlipGate.reset();
        logPdfRenderTrace('navigation-retained-anchor-cleared', () => ({
            reason,
            desiredPage: desiredNavigationPage.value,
            pendingPage: viewportAuthority.pendingTargetPage.value,
            currentPage: viewportAuthority.currentPage.value,
        }));
        clearQueuedNavigation();
        // Trusted physical input owns the viewport immediately. Release the
        // detached navigation's handoff here, after the shared clear path has
        // preserved it for lifecycle and geometry callers.
        navigationVisualHandoff.clear();
        const page = observeNativeUserScroll(anchorOverride);
        // Physical input is authoritative even when the browser cannot move
        // the viewport (for example, while a programmatic scroll and canvas
        // commit are still settling). Publish the live anchor at the input
        // boundary so the shared session cannot remain transitioning merely
        // because no follow-up scroll event was emitted.
        options.onUserViewportPageObserved?.(requirePageNumber(page));
        return page;
    }

    function resetContinuousScrollState() {
        wheelFlipGate.reset();
        observeNativeUserScroll();
    }

    function cancelDestinationNavigationTarget(source?: IPdfNavigationRequest['source']) {
        const activeIntent = viewportAuthority.activeIntent.value;
        const queuedMatches = desiredNavigation.value !== null && (!source || desiredNavigation.value.request.source === source);
        const activeMatches = activeIntent?.navigation !== undefined && (!source || activeIntent.navigation.source === source);
        const hasDestinationDemand = queuedMatches || activeMatches;
        if (!source || hasDestinationDemand) wheelFlipGate.reset();
        logPdfRenderTrace('navigation-destination-intent-cancelled', () => ({
            desiredPage: desiredNavigationPage.value,
            pendingPage: viewportAuthority.pendingTargetPage.value,
            currentPage: viewportAuthority.currentPage.value,
            activeIntentId: activeIntent?.id ?? null,
            activeIntentKind: activeIntent?.kind ?? null,
            activeIntentHasNavigation: activeIntent?.navigation !== undefined,
            hasDestinationDemand,
        }));
        if (!hasDestinationDemand) {
            return;
        }
        if (queuedMatches || desiredNavigation.value === null) clearQueuedNavigation();
        // Preserve geometry-only transitions and destinations owned by another source.
        if (activeMatches) {
            viewportAuthority.suspend();
        }
    }
    function retireStaleViewportIntent(currentDocumentRevision: number) {
        const activeIntent = viewportAuthority.activeIntent.value;
        if (
            activeIntent === null
            || activeIntent.documentRevision === currentDocumentRevision
        ) {
            return false;
        }
        logPdfRenderTrace('navigation-stale-viewport-intent-retired', {
            intentId: activeIntent.id,
            kind: activeIntent.kind,
            intentDocumentRevision: activeIntent.documentRevision,
            currentDocumentRevision,
        });
        if (activeIntent.navigation !== undefined) {
            const staleNavigationSequence = intentDocuments.get(activeIntent.id)?.navigationSequence;
            if (
                staleNavigationSequence !== undefined
                && desiredNavigation.value?.sequence === staleNavigationSequence
            ) {
                clearQueuedNavigation();
            }
        }
        viewportAuthority.suspend();
        return true;
    }

    function handleWheel(event: IPdfSinglePageWheelEvent) {
        if (
            event.deltaY === 0
            || options.continuousScroll.value
            || Math.abs(event.deltaY) < Math.abs(event.deltaX)
        ) {
            return false;
        }
        const container = options.viewerContainer.value;
        if (!container) {
            return false;
        }
        const direction = resolveWheelDirection(event.deltaY);
        const bounds = getPageScrollBounds({
            container,
            pageNumber: toBoundedPageNumber(viewportAuthority.currentPage.value),
            totalPages: options.numPages.value,
            viewMode: options.viewMode.value,
            scaledMargin: options.scaledMargin.value,
        });
        wheelFlipGate.recordWheelPacket(event.timeStamp, event.deltaY);
        if (bounds === null) {
            return false;
        }
        if (canScrollWithinPageBounds(container, bounds, direction)) {
            wheelFlipGate.recordInteriorScroll();
            return false;
        }
        if (wheelFlipGate.shouldBlockFlip(direction, event.timeStamp, {delta: event.deltaY})) {
            event.preventDefault();
            return true;
        }
        const desiredPage = wheelNavigationCursorPage.value
            ?? navigationAnchorPage.value
            ?? viewportAuthority.currentPage.value;
        const target = resolveWheelTargetPage(
            desiredPage,
            options.viewMode.value,
            options.numPages.value,
            direction,
        );
        if (target === desiredPage) {
            return false;
        }
        event.preventDefault();
        const submitted = submitPageNavigation(toPageNumber(target), {navigationSource: 'wheel'});
        if (submitted) {
            wheelNavigationCursorPage.value = target;
            wheelFlipGate.recordFlip(direction, event.timeStamp, event.deltaY);
        }
        return submitted;
    }

    watch(viewportAuthority.currentPage, page => options.emitCurrentPage(page));
    watch(viewportAuthority.pendingTargetPage, page => options.emitNavigationFeedbackPage?.(page));

    watch(
        [
            options.requestedCurrentPage,
            options.numPages,
            options.viewerContainer,
        ],
        ([
            requested,
            ,
            ,
        ]) => {
            if (typeof requested === 'number' && Number.isFinite(requested)) {
                const requestedPage = options.numPages.value > 0
                    ? clamp(Math.trunc(requested), 1, options.numPages.value)
                    : Math.max(1, Math.trunc(requested));
                const pendingPage = desiredNavigation.value
                    ? getNavigationRequestPage(desiredNavigation.value.request)
                    : viewportAuthority.pendingAnchorPage.value;
                const shouldSubmit = navigationRuntimeReady.value
                    ? shouldSubmitRequestedCurrentPage(
                        requestedPage,
                        viewportAuthority.currentPage.value,
                        pendingPage,
                    )
                    // Pre-ready the prop carries the open surface's initial or
                    // restored page, but it is still an echo: explicit commands
                    // enter through submitPageNavigation, and the open's
                    // default page must never supersede a queued user command.
                    : pendingPage === null
                        && requestedPage !== viewportAuthority.currentPage.value;
                logPdfRenderTrace('navigation-requested-page-observed', () => ({
                    requested,
                    requestedPage,
                    currentPage: viewportAuthority.currentPage.value,
                    pendingPage,
                    shouldSubmit,
                    runtimeReady: navigationRuntimeReady.value,
                }));
                if (!shouldSubmit) {
                    return;
                }
                options.cancelPendingSearchScroll();
                // Pre-ready the page count is still a placeholder, so clamping
                // against it would reject a restored page beyond that placeholder.
                submitPageNavigation(requirePageNumber(requestedPage));
            }
        },
        {
            flush: 'post',
            immediate: true,
        },
    );

    tryOnScopeDispose(() => {
        desiredNavigation.value = null;
        viewportAuthority.dispose();
        metricHydrator.dispose();
    });

    watch(navigationRuntimeReady, () => {
        // Metadata and the PDF document can become ready before layout
        // publishes its first geometry revision. Replay at the complete
        // operational boundary instead of waiting for unrelated state.
        replayQueuedNavigation();
    }, {
        flush: 'post',
        immediate: true,
    });
    const navigationAnchorPage = computed(() => (
        viewportAuthority.pendingTargetPage.value
        ?? desiredNavigationPage.value
    ));
    const navigationState = computed(() => {
        const activeIntent = viewportAuthority.activeIntent.value;
        const targetPage = viewportAuthority.pendingTargetPage.value;
        if (!activeIntent || targetPage === null) {
            return createPdfNavigationMachineState(
                intentSequence,
                viewportAuthority.currentPage.value,
            );
        }
        const source = activeIntent.kind === 'search'
            ? 'search' as const
            : activeIntent.kind === 'wheel-page'
                ? 'wheel' as const
                : options.continuousScroll.value ? 'continuous' as const : 'paged' as const;
        const phase = viewportAuthority.phase.value;
        return {
            anchor: null,
            currentPage: viewportAuthority.currentPage.value,
            source,
            status: phase === 'applying' || phase === 'awaiting-visual'
                ? 'settling' as const
                : 'navigating' as const,
            targetPage,
            txn: intentSequence,
        };
    });
    const searchNavigationTargetPage = computed(() => viewportAuthority.activeIntent.value?.kind === 'search'
        ? viewportAuthority.pendingTargetPage.value
        : null);
    const searchNavigationState = computed(() => searchNavigationTargetPage.value === null ? 'idle' : 'navigating');
    const currentPageAuthority = {
        canSyncFromViewport: () => (
            viewportAuthority.activeIntent.value === null
            && options.isResizeTransitionActive?.value !== true
        ),
        commitViewportPage: (page: number) => {
            if (viewportAuthority.activeIntent.value !== null) {
                logPdfRenderTrace('viewport-current-page-commit-rejected', {
                    page,
                    activeIntentId: viewportAuthority.activeIntent.value.id,
                    activeIntentKind: viewportAuthority.activeIntent.value.kind,
                });
                return false;
            }
            const container = options.viewerContainer.value;
            const snapshot = refreshGeometry();
            const anchor = container && snapshot
                ? resolveAnchorForViewport(snapshot, toPageNumber(page))
                : getRequestAnchor(undefined, page);
            viewportAuthority.observeUserScroll({
                ...anchor,
                page: toPageNumber(page),
            });
            logPdfRenderTrace('viewport-current-page-commit-observed', () => ({
                page,
                anchorPage: anchor.page,
                scrollLeft: container?.scrollLeft ?? null,
                scrollTop: container?.scrollTop ?? null,
            }));
            if (container) options.viewportWritePort.observeUserScroll(container);
            return true;
        },
    };
    return {
        navigationState,
        currentPageAuthority,
        handleWheel,
        scrollToPage: submitPageNavigation,
        snapToPage: (page: number, _anchor?: unknown, scrollOptions?: IScrollToPageOptions) => submitPageNavigation(toPageNumber(page), scrollOptions),
        beginSearchNavigation: (page: number) => submitPageNavigation(toPageNumber(page), {navigationSource: 'search'}),
        revealSearchNavigationTarget: (page: number, scrollOptions?: IScrollToPageOptions) => submitPageNavigation(toPageNumber(page), {
            ...scrollOptions,
            navigationSource: 'search',
        }),
        endSearchNavigation: () => cancelDestinationNavigationTarget('search'),
        cancelProgrammaticNavigation,
        cancelDestinationNavigationTarget,
        retireStaleViewportIntent,
        resetContinuousScrollState,
        viewportAuthority,
        submitNavigationRequest,
        submitViewportStateIntent,
        captureCurrentSemanticAnchor,
        applyOpeningViewportAnchor: (pageNumber: TPageNumber) => applyViewportAnchorPreview(
            getRequestAnchor(undefined, pageNumber),
        ),
        applyResizeAnchorPreview: applyViewportAnchorPreview,
        commitCurrentViewportPosition,
        commitCurrentViewportIfSettled,
        captureViewportCommitDiagnostics,
        navigationAnchorPage,
        navigationVisualHandoffTargetPage: navigationVisualHandoff.targetPage,
        pagedNavigationTargetPage: navigationAnchorPage,
        continuousNavigationTargetPage: computed(() => null),
        searchNavigationTargetPage,
        searchNavigationState,
        isProgrammaticNavigationActive: computed(() => viewportAuthority.phase.value !== 'idle'
            && viewportAuthority.phase.value !== 'settled'
            && viewportAuthority.phase.value !== 'cancelled'),
        shouldCancelProgrammaticNavigationForViewportScroll: () => (
            navigationAnchorPage.value === null
            && viewportAuthority.activeIntent.value === null
        ),
    };
};
