import {
    parsePageNumber, requirePageNumber,
} from '@contracts/pageNumbers';
import type { TPageNumber } from '@contracts/pageNumbers';
import {queuePostFlushCb} from 'vue';
import {tryOnScopeDispose} from '@vueuse/core';
import {clamp} from 'es-toolkit/math';
import type {IUsePdfSinglePageScrollOptions} from '@app/modules/pdf-viewer/runtime/navigation/pdfSinglePageScrollTypes';
import type {IScrollToPageOptions} from '@app/modules/pdf-viewer/engine/pdf-outline-navigation/scrollToPageOptions';
import type {IPdfDocument} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import {createPdfPageNavigationRequest} from '@app/modules/pdf-viewer/engine/pdf-outline-navigation/createPdfPageNavigationRequest';
import {
    createPdfViewportGeometryFromLayout,
    readArrivedViewportClientSize,
    resolveAnchorFromScroll,
    resolvePageIndicatorFromScroll,
    resolveRetainedAnchorFromScroll,
    resolveScrollForAnchor,
    type IPdfSemanticAnchor,
    type IPdfViewportGeometry,
    captureDocumentViewportResizeAnchor,
    createWheelFlipGate,
    canScrollWithinPageBounds,
    resolveWheelDirection,
    resolveWheelTargetPage,
    type IDocumentNavigationRequest,
    type IDocumentNavigationTicket,
    type TDocumentNavigationReport,
    type IDocumentViewerRuntime,
} from '@app/modules/document-viewer/public';
import {
    createViewportAuthority as createViewportAuthorityService,
    type IPdfViewportIntent,
    type IPdfViewportPositionCommit,
    type IPdfViewportWorkCancellation,
    type TPdfRelayoutReceipt,
} from '@app/modules/pdf-viewer/runtime/viewport/createViewportAuthority';
import {
    isPdfNavigationReady,
    resolvePdfNavigationAnchor,
    resolvePdfNavigationTarget,
    type IResolvedPdfNavigationTarget,
} from '@app/modules/pdf-viewer/runtime/viewport/pdfNavigationRequestResolver';
import {getPageScrollBounds} from '@app/modules/pdf-viewer/runtime/navigation/singlePageScrollGeometry';
import {logPdfRenderTrace} from '@app/utils/pdfRenderTrace';
import {BrowserLogger} from '@app/utils/browserLogger';
import {runGuardedTask} from '@app/utils/asyncGuard';
import {
    getRequestAnchor,
    getRequestPage,
} from '@app/modules/pdf-viewer/runtime/navigation/pdfNavigationRequestAnchors';
import {
    hasMeasurableMountedPage,
    resolvePagedAnchorFromViewport,
    resolvePagedScrollForAnchor,
} from '@app/modules/pdf-viewer/runtime/navigation/pdfMountedPageViewportGeometry';
import {createPdfNavigationCommitRefiner} from '@app/modules/pdf-viewer/runtime/navigation/createPdfNavigationCommitRefiner';
import {resolvePdfProtectedVisibleRange} from '@app/modules/pdf-viewer/engine/pdf-visible-render-range-policy/isPdfVisibleRenderRangeCurrent';

interface IUsePdfSinglePageNavigationControllerOptions extends IUsePdfSinglePageScrollOptions {
    /** Retained for source compatibility; projected page changes are not commands. */
    chassisAuthority?: IDocumentViewerRuntime | null | undefined;
    viewerContainer: Ref<HTMLElement | null>;
    bindCurrentPageProjection?: ((projection: Readonly<Ref<number>>) => void) | undefined;
    getDocumentRevision: () => number;
    getGeometryRevision: () => number;
    onViewportPositionCommitted?: ((commit: IPdfViewportPositionCommit) => boolean) | undefined;
    onUserViewportPageObserved?: ((pageNumber: TPageNumber) => void) | undefined;
    onPageVisualReady?: ((pageNumber: TPageNumber) => void) | undefined;
    onViewportWorkCancelled?: ((cancellation: IPdfViewportWorkCancellation) => void) | undefined;
}

interface IPdfSinglePageWheelEvent {
    cancelable?: boolean;
    deltaX: number;
    deltaY: number;
    timeStamp: number;
    preventDefault: () => void;
}

/**
 * The layout change being flushed, whose receipt every caller of that flush
 * shares, fenced by the document and the reader's input it began under.
 * `anchor` is null while a navigation owns the view; `transform` then maps
 * the point the reader sees, such as through a page's turn. `flush` names
 * the latest post flush asked to place it.
 */
interface IPdfPendingRelayout {
    anchor: IPdfSemanticAnchor | null;
    transform: (anchor: IPdfSemanticAnchor) => IPdfSemanticAnchor;
    documentRevision: number;
    interactionEpoch: number;
    flush: number;
    receipt: Promise<TPdfRelayoutReceipt>;
    settle: (receipt: TPdfRelayoutReceipt) => void;
}

interface IPdfViewportIntentDocument {
    document: NonNullable<IUsePdfSinglePageScrollOptions['pdfDocument']['value']>;
    revision: number;
    page: TPageNumber | null;
    navigationTicket?: IDocumentNavigationTicket | undefined;
    resolvedTarget?: IResolvedPdfNavigationTarget | undefined;
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
    const wheelFlipGate = createWheelFlipGate();
    let geometry: IPdfViewportGeometry | null = null;
    const navigationRuntime = options.chassisAuthority;
    const navigationTicket = computed(() => navigationRuntime?.navigationTicket.value ?? null);
    // The page a ticket accepted by the shared surface is heading for, before
    // (or between) its execution attempts here.
    const ticketTargetPage = computed(() => {
        const ticket = navigationTicket.value;
        return ticket
            ? getNavigationRequestPage(ticket.request) ?? navigationRuntime?.navigationPage.value ?? null
            : null;
    });
    const resolvedTargets = new Map<string, IResolvedPdfNavigationTarget>();
    let activeNavigationTicket: IDocumentNavigationTicket | null = null;
    let navigationRestartRequested = false;
    let pendingRelayout: IPdfPendingRelayout | null = null;
    let heldRelayoutAnchor: {
        anchor: IPdfSemanticAnchor;
        left: number;
        top: number;
    } | null = null;
    function isNavigationTicketCurrent(ticket: IDocumentNavigationTicket) {
        return navigationRuntime?.openSurface.isNavigationCurrent(ticket) ?? false;
    }
    function reportNavigation(
        ticket: IDocumentNavigationTicket,
        report: TDocumentNavigationReport,
    ) {
        return navigationRuntime?.openSurface.reportNavigation(ticket, report) ?? false;
    }
    // A load token alone is insufficient: cleanup retires the PDF proxy before
    // the next load begins. Every continuation belongs to this exact document.
    function captureIntentDocument(
        intent: Omit<IPdfViewportIntent, 'interactionEpoch'> & {interactionEpoch?: number},
        ticket?: IDocumentNavigationTicket,
    ) {
        const document = options.pdfDocument.value;
        if (!document || options.isLoading.value || options.numPages.value <= 0) {
            return null;
        }
        const captured: IPdfViewportIntentDocument = {
            document,
            revision: options.getDocumentRevision(),
            page: null,
            ...(ticket ? {navigationTicket: ticket} : {}),
        };
        intent.documentContext = captured;
        return captured;
    }
    function isIntentDocumentCurrent(intent: IPdfViewportIntent) {
        const captured = intent.documentContext as IPdfViewportIntentDocument | undefined;
        return captured !== undefined
            && captured.document === options.pdfDocument.value
            && captured.revision === options.getDocumentRevision()
            && !options.isLoading.value
            && options.numPages.value > 0
            && (!captured.navigationTicket || isNavigationTicketCurrent(captured.navigationTicket));
    }
    function requireIntentDocument(intent: IPdfViewportIntent, signal?: AbortSignal) {
        const captured = intent.documentContext as IPdfViewportIntentDocument | undefined;
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
    function livePageCount(document: IPdfDocument) {
        // The opening ticket can run one tick before PDF.js publishes its
        // document length. The session's reactive count is the live source at
        // that boundary; retain a one-page provisional range so page 1 can be
        // placed without turning a late close/open tick into a RangeError.
        return Math.max(1, options.numPages.value, document.numPages);
    }
    /** The client size the view is read and placed in: the one it has once it scrolls again. */
    function readViewportSize(container: HTMLElement) {
        return readArrivedViewportClientSize(container, options.isHorizontalScrollLocked?.() ?? false);
    }
    function refreshGeometry() {
        const container = options.viewerContainer.value;
        const metrics = options.getPageLayoutMetrics?.() ?? null;
        if (!container || !metrics) {
            geometry = null;
            return null;
        }
        const geometryRevision = options.getGeometryRevision();
        geometry = createPdfViewportGeometryFromLayout(metrics, {
            ...readViewportSize(container),
            paddingInline: options.scaledMargin.value,
        }, geometryRevision, options.getPhysicalScrollOrigin());
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
            return resolvePagedAnchorFromViewport(container, readViewportSize(container), pageNumber, viewportFraction);
        }
        return resolveAnchorFromScroll(snapshot, {
            left: container?.scrollLeft ?? 0,
            top: container?.scrollTop ?? 0,
        }, viewportFraction);
    }

    function resolveScrollForViewport(snapshot: IPdfViewportGeometry, anchor: IPdfSemanticAnchor) {
        const container = options.viewerContainer.value;
        if (container && !options.continuousScroll.value) {
            return resolvePagedScrollForAnchor(container, readViewportSize(container), anchor, options.scaledMargin.value);
        }
        return resolveScrollForAnchor(snapshot, anchor);
    }

    function resolveNavigationScrollForViewport(snapshot: IPdfViewportGeometry, anchor: IPdfSemanticAnchor) {
        const container = options.viewerContainer.value;
        if (container && hasMeasurableMountedPage(container, requirePageNumber(anchor.page))) {
            return resolvePagedScrollForAnchor(container, readViewportSize(container), anchor, options.scaledMargin.value);
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
        getInteractionEpoch: () => options.viewportWritePort.getInteractionEpoch(),
        getGeometryRevision: options.getGeometryRevision,
        resolveIndicatorPage: (anchor, previousPage) => {
            const container = options.viewerContainer.value;
            // Start anchors carry a known placement/segment transition while
            // geometry still describes the previous physical scroll origin.
            return container && geometry && options.continuousScroll.value && anchor.affinity === 'center'
                ? resolvePageIndicatorFromScroll(geometry, {
                    left: container.scrollLeft,
                    top: container.scrollTop,
                }, previousPage)
                : anchor.page;
        },
        isIntentCurrent: isIntentDocumentCurrent,
        shouldStageNavigationVisual: intent => intent.navigation?.readiness === 'text-layer' || isUnplacedOpeningNavigation(intent.navigationTicket),
        reportNavigation,
        hasPendingNavigationTicket: () => ticketTargetPage.value !== null,
        onWorkCancelled: cancellation => options.onViewportWorkCancelled?.(cancellation),
        awaitMetrics: async (intent, signal) => {
            const captured = requireIntentDocument(intent, signal);
            const resolved = intent.navigation
                ? await resolvePdfNavigationTarget(intent.navigation.target, captured.document, signal)
                : null;
            requireIntentDocument(intent, signal);
            if (resolved) {
                captured.page = requirePageNumber(
                    clamp(Math.trunc(resolved.page), 1, livePageCount(captured.document)),
                );
                captured.resolvedTarget = resolved;
                resolvedTargets.set(intent.id, resolved);
                if (intent.navigationTicket) {
                    reportNavigation(intent.navigationTicket, {
                        kind: 'resolved',
                        page: captured.page,
                    });
                    if (!isNavigationTicketCurrent(intent.navigationTicket)) {
                        throw new DOMException('PDF navigation was superseded', 'AbortError');
                    }
                }
            }
            const page = requirePageNumber(clamp(
                Math.trunc(resolved?.page ?? getRequestPage(intent.navigation, intent.anchor?.page ?? options.currentPage.value)),
                1,
                livePageCount(captured.document),
            ));
            captured.page = page;
            if (!options.continuousScroll.value || intent.navigation) {
                await options.prepareNavigationLayout?.(page, signal);
                requireIntentDocument(intent, signal);
            }
            refreshGeometry();
        },
        resolve: (intent) => {
            const container = options.viewerContainer.value;
            const snapshot = geometry ?? refreshGeometry();
            const resolved = intent.documentContext?.resolvedTarget
                ?? resolvedTargets.get(intent.id);
            const anchor = intent.navigation && resolved
                ? resolvePdfNavigationAnchor(intent.navigation, resolved, snapshot)
                : intent.anchor ?? getRequestAnchor(intent.navigation, options.currentPage.value);
            if (!container || !snapshot) {
                throw new DOMException('PDF viewport geometry unavailable', 'AbortError');
            }
            return Promise.resolve({
                anchor,
                ...resolveScrollForViewport(snapshot, anchor),
            });
        },
        refine: async (intent, commit, signal) => {
            if (!intent.navigation) {
                return commit;
            }
            // The target row is retained in the virtual window as the
            // navigation target; one render flush mounts it, and its
            // mounted bounds place the destination.
            if (!hasMatchingOpeningRenderFence(intent, requireIntentPage(intent, signal))) {
                await nextTick();
                requireIntentDocument(intent, signal);
            }
            return refineNavigationCommit(intent, commit);
        },
        refineAfterVisual: (intent, commit) => (
            intent.navigation
                ? refineNavigationCommit(intent, commit)
                : Promise.resolve(commit)
        ),
        apply: (intent, commit) => {
            requireIntentDocument(intent);
            const container = options.viewerContainer.value;
            if (!container) {
                return null;
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
            if (!applied) {
                return null;
            }
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
            options.onViewportPositionCommitted?.(commit);
        },
        // The point is placed again only when the released layout moved it
        // or the view no longer shows the committed offsets.
        settleHandoff: (_intent, placement) => new Promise((resolve) => {
            afterLayoutPatch(() => {
                let target = null;
                try {
                    const container = options.viewerContainer.value;
                    const shows = (left: number, top: number) => container !== null
                        && Math.abs(left - container.scrollLeft) < 1 && Math.abs(top - container.scrollTop) < 1;
                    target = resolvePlacementForLayout(placement.anchor);
                    if (target && shows(target.left, target.top) && shows(placement.commit.left, placement.commit.top)) {
                        target = null;
                    }
                } finally {
                    resolve(target);
                }
            });
        }),
        awaitVisual: async (intent, signal) => {
            const page = requireIntentPage(intent, signal);
            const container = options.viewerContainer.value;
            const readiness = intent.navigation?.readiness ?? 'page-canvas';
            const getRange = () => resolvePdfProtectedVisibleRange({
                visibleRange: options.visibleRange.value,
                navigationTargetPage: page,
                viewMode: options.viewMode.value,
                totalPages: options.numPages.value,
            });
            let range = getRange();
            const isReady = (candidate: number) => container && isPdfNavigationReady(
                container, candidate, candidate === page ? readiness : 'page-canvas', isPageFreshForNavigation,
            );
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
            if (hasMatchingOpeningRenderFence(intent, page)) {
                options.onPageVisualReady?.(page);
                return;
            }
            if (!Array.from({length: range.end - range.start + 1}, (_, index) => range.start + index).every(isReady)) {
                // One mandatory demand owns all destination-visible rows, including
                // cold neighbours of a cached target. Recompute after scale/layout
                // changes; a failed neighbour settles with its own error feedback.
                for (;;) {
                    const settled = await options.renderVisiblePages(range, {
                        authoritativeRaster: true,
                        preserveRenderedPages: true,
                        retainOnlyCurrentResidentRaster: true,
                        suppressResidentRasterDemand: false,
                        ...(readiness === 'text-layer' ? {prioritizeTextLayer: true} : {}),
                    });
                    requireIntentDocument(intent, signal);
                    const currentRange = getRange();
                    if (settled && currentRange.start >= range.start && currentRange.end <= range.end) break;
                    range = currentRange;
                }
            }
            requireIntentDocument(intent, signal);
            if (waitForTextLayer && !await waitForTextLayer(page, signal)) {
                throw new DOMException('PDF navigation text layer readiness timed out', 'AbortError');
            }
            requireIntentDocument(intent, signal);
            if (container && !isReady(page)) {
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
            if (signal.aborted) return;
            await nextTick();
            requireIntentDocument(intent, signal);
            refreshGeometry();
        },
        clearDemand: intentId => {
            resolvedTargets.delete(intentId);
        },
    });
    options.bindCurrentPageProjection?.(viewportAuthority.currentPage);

    function requestFor(page: number, scrollOptions?: IScrollToPageOptions) {
        return createPdfPageNavigationRequest(page, scrollOptions);
    }

    function getNavigationRequestPage(request: IDocumentNavigationRequest | null | undefined) {
        return request && 'page' in request.target ? request.target.page : null;
    }

    function isNavigationRuntimeReady() {
        return Boolean(
            options.viewerContainer.value
            && !options.isLoading.value
            && options.pdfDocument.value
            && options.numPages.value > 0
            && options.getDocumentRevision() > 0
            && options.getPageLayoutMetrics?.() !== null,
        );
    }
    const navigationRuntimeReady = computed(isNavigationRuntimeReady);

    function currentNavigationTicket() {
        return navigationTicket.value;
    }

    function hasMatchingOpeningRenderFence(
        intent: IPdfViewportIntent,
        page: TPageNumber,
    ) {
        const ticket = intent.navigationTicket;
        const surface = navigationRuntime?.openSurface;
        if (!ticket || !surface || surface.viewportSession.value.lifecycle !== 'opening') {
            return false;
        }
        const render = surface.snapshot.value.committedRender;
        return render?.generation === ticket.generation
            && render.documentRevision === ticket.documentRevision
            && render.viewportIntentId === ticket.id
            && render.pageNumber === page;
    }

    function isUnplacedOpeningNavigation(ticket: IDocumentNavigationTicket | undefined) {
        if (!ticket) {
            return false;
        }
        const surface = navigationRuntime?.openSurface;
        const viewport = surface?.viewportSession.value;
        return Boolean(
            surface
            && viewport?.lifecycle === 'opening'
            && viewport.stagedRenderFence === null
            && viewport.committedRenderFence === null
            && viewport.committedViewportFence === null
            && surface.isNavigationCurrent(ticket),
        );
    }

    async function submitNavigationIntent(ticket: IDocumentNavigationTicket) {
        if (!isNavigationTicketCurrent(ticket) || !isNavigationRuntimeReady()) {
            return null;
        }
        const intent: Omit<IPdfViewportIntent, 'interactionEpoch'> = {
            id: ticket.id,
            kind: ticket.request.source === 'search'
                ? 'search'
                : ticket.request.source === 'wheel' ? 'wheel-page' : 'navigate',
            documentRevision: options.getDocumentRevision(),
            navigation: ticket.request,
            navigationTicket: ticket,
        };
        const captured = captureIntentDocument(intent, ticket);
        if (!captured) return null;
        refreshGeometry();
        return viewportAuthority.submit(intent);
    }

    function startNavigationTicket(ticket: IDocumentNavigationTicket) {
        if (activeNavigationTicket === ticket) {
            navigationRestartRequested = true;
            return false;
        }
        if (!isNavigationTicketCurrent(ticket)) return false;
        if (!isNavigationRuntimeReady()) return false;
        // A cancelled attempt is replayed only by the readiness watch below:
        // every input that can cancel a live ticket (document, geometry,
        // readiness) is one of its sources.
        activeNavigationTicket = ticket;
        void submitNavigationIntent(ticket).catch(error => {
            runGuardedTask(() => { throw error; }, {
                category: 'background-diagnostic',
                scope: 'pdf-navigation',
                message: `PDF viewport navigation ${ticket.id} failed`,
            });
        }).finally(() => {
            if (activeNavigationTicket !== ticket) return;
            activeNavigationTicket = null;
            if (navigationRestartRequested) {
                navigationRestartRequested = false;
                if (isNavigationTicketCurrent(ticket)) startNavigationTicket(ticket);
            }
        });
        return true;
    }

    // The surface's ticket for an accepted command; true when placed at once or
    // submitted without a shared surface, false when refused.
    function submitPageNavigation(pageNumber: TPageNumber, scrollOptions?: IScrollToPageOptions) {
        if (!Number.isFinite(pageNumber)) {
            return false;
        }
        const page = Math.max(1, Math.trunc(pageNumber));
        if (
            scrollOptions?.navigationSource === 'annotation'
            && scrollOptions.markerRect
            && page === viewportAuthority.currentPage.value
            && currentNavigationTicket() === null
            && viewportAuthority.activeIntent.value === null
        ) {
            const container = options.viewerContainer.value;
            const snapshot = refreshGeometry();
            if (container && snapshot && hasMeasurableMountedPage(container, toPageNumber(page))) {
                return place(resolvePdfNavigationAnchor(requestFor(page, scrollOptions), {
                    page,
                    rect: scrollOptions.markerRect,
                }, snapshot), 'navigate');
            }
        }
        const request = requestFor(page, scrollOptions);
        return submitNavigationRequest(request);
    }

    function submitNavigationRequest(request: IDocumentNavigationRequest) {
        viewportAuthority.suspend();
        const ticket = navigationRuntime?.navigate(request) ?? null;
        if (!navigationRuntime) {
            // The chassis watcher owns this fence when a shared surface exists.
            // Direct PDF-session callers still need to fence the live gesture
            // before the authored viewport write can race its residue tail.
            options.viewportWritePort.fenceCommandAgainstLiveGesture();
            const intent: Omit<IPdfViewportIntent, 'interactionEpoch'> = {
                id: `pdf-test-navigation:${String(++intentSequence)}`,
                kind: request.source === 'search' ? 'search' : request.source === 'wheel' ? 'wheel-page' : 'navigate',
                documentRevision: options.getDocumentRevision(),
                navigation: request,
            };
            if (!captureIntentDocument(intent)) return false;
            void viewportAuthority.submit(intent);
            return true;
        }
        if (!ticket) return false;
        intentSequence += 1;
        startNavigationTicket(ticket);
        return ticket;
    }

    /**
     * Captures the document point under a viewport point before a layout
     * change, to be placed at the same fraction of the viewport afterwards.
     * The anchor the last relayout placed is reused while the viewport has not
     * moved since, so a burst of resize packets or zoom steps cannot drift.
     */
    function captureRelayoutAnchor(
        point?: {
            x: number;
            y: number;
        },
        viewportSize?: {
            width: number;
            height: number;
        },
    ): IPdfSemanticAnchor | null {
        const container = options.viewerContainer.value;
        if (!container) {
            return null;
        }
        const width = viewportSize?.width ?? container.clientWidth;
        const height = viewportSize?.height ?? container.clientHeight;
        const x = point?.x ?? width / 2;
        const y = point?.y ?? height / 2;
        const viewportXFraction = clamp(x / Math.max(1, width), 0, 1);
        const viewportYFraction = clamp(y / Math.max(1, height), 0, 1);
        const held = heldRelayoutAnchor;
        if (
            held
            && held.left === container.scrollLeft
            && held.top === container.scrollTop
            && Math.abs(held.anchor.viewportXFraction - viewportXFraction) < 0.001
            && Math.abs(held.anchor.viewportYFraction - viewportYFraction) < 0.001
        ) {
            return held.anchor;
        }
        const anchor = captureCurrentSemanticAnchor({
            x,
            y,
        });
        return anchor && {
            ...anchor,
            viewportXFraction,
            viewportYFraction,
        };
    }

    /**
     * Every layout change goes through here: zoom, fit, view mode, rotation
     * and viewport resize. The anchor is taken before the change, while the
     * DOM still shows the old layout, and placed once Vue has patched the
     * new one, before the browser paints. The returned receipt settles in
     * that same flush. A navigation in flight owns the view: the change
     * refines its placed destination, or the navigation, not placed yet,
     * resolves against the new layout on its own.
     */
    function relayout(
        change?: () => void,
        anchor?: IPdfSemanticAnchor | null | ((point: IPdfSemanticAnchor) => IPdfSemanticAnchor),
    ): Promise<TPdfRelayoutReceipt> {
        const interactionEpoch = options.viewportWritePort.getInteractionEpoch();
        // The reader's input since a pending change began owns that change's
        // point; this change starts afresh from what the reader now sees (R2).
        if (pendingRelayout && pendingRelayout.interactionEpoch !== interactionEpoch) {
            pendingRelayout.settle({outcome: 'superseded'});
            pendingRelayout = null;
        }
        if (!pendingRelayout && isNavigationRuntimeReady()) {
            const {
                promise, resolve,
            } = Promise.withResolvers<TPdfRelayoutReceipt>();
            pendingRelayout = {
                anchor: currentNavigationTicket() !== null || viewportAuthority.activeIntent.value !== null
                    ? null
                    : typeof anchor === 'function' ? captureRelayoutAnchor() : anchor ?? captureRelayoutAnchor(),
                transform: point => point,
                documentRevision: options.getDocumentRevision(),
                interactionEpoch,
                flush: 0,
                receipt: promise,
                settle: resolve,
            };
        }
        const pending = pendingRelayout;
        if (!pending) {
            change?.();
            return Promise.resolve({outcome: 'cancelled'});
        }
        // Compose transforms, including several rotations before Vue flushes,
        // on the pending point, or on the point the reader sees while a
        // navigation keeps its own destination.
        if (typeof anchor === 'function') {
            if (pending.anchor) {
                pending.anchor = anchor(pending.anchor);
            } else {
                const previous = pending.transform;
                pending.transform = point => anchor(previous(point));
            }
        }
        // Each call asks the post flush after its own change: a change made
        // inside a post flush is patched by a later pass of the same flush.
        const flush = ++pending.flush;
        afterLayoutPatch(() => {
            if (pendingRelayout !== pending || pending.flush !== flush) {
                return;
            }
            pendingRelayout = null;
            let receipt: TPdfRelayoutReceipt = {outcome: 'cancelled'};
            try {
                receipt = placePendingRelayout(pending);
            } finally {
                pending.settle(receipt);
            }
        });
        change?.();
        return pending.receipt;
    }

    /**
     * Runs `place` in the post flush, after Vue patched the layout and before
     * the browser paints. A failure is reported and never escapes into the
     * flush that runs the other callbacks.
     */
    function afterLayoutPatch(place: () => void) {
        queuePostFlushCb(() => {
            try {
                place();
            } catch (error) {
                if (!(error instanceof DOMException && error.name === 'AbortError')) {
                    BrowserLogger.error('pdf-viewer', 'Failed to place the PDF viewport after a layout change', error, {code: 'RENDERER_PDF_VIEWPORT_PLACEMENT_FAILED'});
                }
            }
        });
    }

    function resolvePlacementForLayout(anchor: IPdfSemanticAnchor) {
        const container = options.viewerContainer.value;
        const snapshot = refreshGeometry();
        return container && snapshot
            ? {
                anchor,
                ...resolveNavigationScrollForViewport(snapshot, anchor),
            }
            : null;
    }

    function placePendingRelayout(pending: IPdfPendingRelayout): TPdfRelayoutReceipt {
        if (!isNavigationRuntimeReady() || options.getDocumentRevision() !== pending.documentRevision) {
            return {outcome: 'cancelled'};
        }
        // The reader's input since the change was asked for owns the view (R2),
        // as does an admitted reload that has not placed its mapped point.
        if (options.viewportWritePort.getInteractionEpoch() !== pending.interactionEpoch
            || viewportAuthority.isWorkPlacementPending()) {
            return {outcome: 'superseded'};
        }
        const refined = viewportAuthority.refineLayout(resolvePlacementForLayout, pending.transform);
        if (refined) {
            return refined;
        }
        if (!pending.anchor) {
            // The navigation this change belonged to ended before the flush.
            return {outcome: 'superseded'};
        }
        const commit = placeAnchor(pending.anchor, 'relayout');
        return commit ? {
            outcome: 'placed',
            commit,
        } : {outcome: 'cancelled'};
    }

    /** Writes the anchor's scroll for the current layout and projects the visible range. */
    function writeAnchor(anchor: IPdfSemanticAnchor, reason: string, preferMountedPage = false) {
        const container = options.viewerContainer.value;
        const snapshot = refreshGeometry();
        if (!container || !snapshot) {
            return null;
        }
        const applied = options.viewportWritePort.apply(container, {
            intent: options.viewportWritePort.beginIntent(`pdf-${reason}-${String(++intentSequence)}`),
            reason,
            ...(preferMountedPage
                ? resolveNavigationScrollForViewport(snapshot, anchor)
                : resolveScrollForViewport(snapshot, anchor)),
        });
        options.updateVisibleRange(container, options.numPages.value);
        return applied ? {
            container,
            snapshot,
        } : null;
    }

    /**
     * The one placement without a navigation ticket: opening, reload,
     * relayout (zoom, fit, rotation, view mode, resize, split) and a
     * same-page annotation reveal. It writes the anchor for the exact
     * current layout and reports the result as the committed position.
     * A ticket's execution ends in the same write and report.
     */
    function place(point: IPdfSemanticAnchor, kind: 'relayout' | 'document-restore' | 'navigate') {
        return placeAnchor(point, kind) !== null;
    }

    function placeAnchor(point: IPdfSemanticAnchor, kind: 'relayout' | 'document-restore' | 'navigate') {
        if (!isNavigationRuntimeReady()) {
            return null;
        }
        // A point carried through a page edit can name a deleted final page.
        const anchor = {...point, page: toBoundedPageNumber(point.page)};
        const written = writeAnchor(anchor, kind, kind === 'navigate');
        if (!written) {
            return null;
        }
        const {
            container,
            snapshot,
        } = written;
        let committed: IPdfSemanticAnchor = anchor;
        if (kind === 'relayout') {
            heldRelayoutAnchor = {
                anchor,
                left: container.scrollLeft,
                top: container.scrollTop,
            };
            // A pointer anchor keeps its point under the pointer; the
            // committed reading point is the viewport centre (R3).
            if (anchor.affinity !== 'start' && (anchor.viewportXFraction !== 0.5 || anchor.viewportYFraction !== 0.5)) {
                committed = resolveAnchorForViewport(snapshot, anchor.page);
            }
        }
        return viewportAuthority.commitSettledPosition({
            intentId: `pdf-${kind}-${String(intentSequence)}`,
            intentKind: kind,
            documentRevision: options.getDocumentRevision(),
            geometryRevision: options.getGeometryRevision(),
            page: committed.page,
            left: container.scrollLeft,
            top: container.scrollTop,
            anchor: committed,
        });
    }

    function isUnplacedOpeningTicket(ticket: IDocumentNavigationTicket | null) {
        const viewport = navigationRuntime?.openSurface.viewportSession.value;
        return Boolean(
            ticket
            && viewport?.lifecycle === 'opening'
            && viewport.committedRenderFence === null
            && viewport.committedViewportFence === null,
        );
    }

    function observeNativeUserScroll(anchorOverride: IPdfSemanticAnchor | undefined, observeWritePort: boolean) {
        const ticket = currentNavigationTicket();
        const holdOpeningTicket = isUnplacedOpeningTicket(ticket);
        if (ticket && isNavigationTicketCurrent(ticket) && !holdOpeningTicket) {
            if (navigationRuntime) {
                reportNavigation(ticket, {
                    kind: 'abandoned',
                    by: 'user-input',
                });
            }
        }
        const container = options.viewerContainer.value;
        const snapshot = refreshGeometry();
        const anchor = anchorOverride ?? (container && snapshot
            ? resolveAnchorForViewport(snapshot, toBoundedPageNumber(viewportAuthority.currentPage.value))
            : getRequestAnchor(undefined, options.currentPage.value));
        if (!holdOpeningTicket) {
            viewportAuthority.observeUserScroll(anchor);
        }
        if (container && observeWritePort) options.viewportWritePort.observeUserScroll(container);
        return viewportAuthority.currentPage.value;
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
        // A point in a paged spread's gutter is on neither page; it stays on
        // the current page instead of the half that rounds nearer.
        const offPage = mounted && !options.continuousScroll.value && mounted.pageNumber !== viewportAuthority.currentPage.value
            && [mounted.pageRatioX, mounted.pageRatioY].some(ratio => ratio === 0 || ratio === 1);
        if (mounted && !offPage) {
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
                : resolvePagedAnchorFromViewport(container, readViewportSize(container), toBoundedPageNumber(viewportAuthority.currentPage.value))
            : viewportAuthority.committedAnchor.value;
    }

    /**
     * `observeWritePort: false` is for input the chassis already reported to
     * the write port (wheel packets, mousedown), so one packet counts once.
     */
    function cancelProgrammaticNavigation(
        reason = 'explicit-cancel',
        anchorOverride?: IPdfSemanticAnchor,
        {observeWritePort = true}: {observeWritePort?: boolean} = {},
    ) {
        wheelFlipGate.reset();
        logPdfRenderTrace('navigation-retained-anchor-cleared', () => ({
            reason,
            commandPage: navigationAnchorPage.value,
            pendingPage: viewportAuthority.pendingTargetPage.value,
            currentPage: viewportAuthority.currentPage.value,
        }));
        const page = observeNativeUserScroll(anchorOverride, observeWritePort);
        // Physical input is authoritative even when the browser cannot move
        // the viewport (for example, while a programmatic scroll and canvas
        // commit are still settling). Publish the live anchor at the input
        // boundary so the shared session cannot remain transitioning merely
        // because no follow-up scroll event was emitted.
        if (!isUnplacedOpeningTicket(currentNavigationTicket())) {
            options.onUserViewportPageObserved?.(requirePageNumber(page));
        }
        return page;
    }

    function cancelDestinationNavigationTarget(source?: IDocumentNavigationRequest['source']) {
        const activeIntent = viewportAuthority.activeIntent.value;
        const ticket = currentNavigationTicket();
        const ticketMatches = ticket !== null && (!source || ticket.request.source === source);
        const activeMatches = activeIntent?.navigation !== undefined && (!source || activeIntent.navigation.source === source);
        const hasDestinationDemand = ticketMatches || activeMatches;
        if (!source || hasDestinationDemand) wheelFlipGate.reset();
        logPdfRenderTrace('navigation-destination-intent-cancelled', () => ({
            commandPage: navigationAnchorPage.value,
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
        if (ticketMatches && ticket && isNavigationTicketCurrent(ticket)) {
            reportNavigation(ticket, {
                kind: 'abandoned',
                by: 'command',
            });
        }
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
        viewportAuthority.suspend();
        return true;
    }

    function handleWheel(event: IPdfSinglePageWheelEvent, deltaPx = event.deltaY) {
        if (options.continuousScroll.value) {
            return false;
        }
        const container = options.viewerContainer.value;
        if (!container) {
            return false;
        }
        const packet = {
            cancelable: event.cancelable,
            deltaY: deltaPx,
            timeStamp: event.timeStamp,
        };
        if (deltaPx === 0 || Math.abs(deltaPx) < Math.abs(event.deltaX)) {
            if (wheelFlipGate.consumeGestureJitter(packet)) {
                event.preventDefault();
                return true;
            }
            return false;
        }
        const direction = resolveWheelDirection(deltaPx);
        const bounds = getPageScrollBounds({
            container,
            pageNumber: toBoundedPageNumber(viewportAuthority.currentPage.value),
            totalPages: options.numPages.value,
            viewMode: options.viewMode.value,
            scaledMargin: options.scaledMargin.value,
        });
        if (bounds === null) {
            return false;
        }
        if (canScrollWithinPageBounds(container, bounds, direction)) {
            wheelFlipGate.recordInteriorScroll(packet);
            return false;
        }
        if (wheelFlipGate.shouldBlockFlip(direction, packet)) {
            event.preventDefault();
            return true;
        }
        const desiredPage = navigationAnchorPage.value ?? viewportAuthority.currentPage.value;
        const target = resolveWheelTargetPage(desiredPage, options.viewMode.value, options.numPages.value, direction);
        if (target === desiredPage) {
            return false;
        }
        event.preventDefault();
        const submitted = submitPageNavigation(toPageNumber(target), {
            navigationSource: 'wheel',
            alignPageBottom: direction < 0,
        }) !== false;
        if (submitted) {
            wheelFlipGate.recordFlip(direction, packet);
        }
        return submitted;
    }


    tryOnScopeDispose(() => {
        // A closed view places nothing; a pending layout change still answers.
        pendingRelayout?.settle({outcome: 'cancelled'});
        pendingRelayout = null;
        viewportAuthority.dispose();
    });

    watch([
        navigationTicket,
        navigationRuntimeReady,
        () => options.getDocumentRevision(),
        () => options.getGeometryRevision(),
        () => options.pdfDocument.value,
        options.numPages,
    ], ([ticket]) => {
        // Renderer mounts and geometry publication can occur after a ticket
        // was minted. Replaying the complete ticket is safe because the
        // ticket id remains the sole ordering key and an active execution is
        // coalesced until its causal cancellation has settled.
        if (ticket) startNavigationTicket(ticket);
    }, {
        flush: 'post',
        immediate: true,
    });
    // Where the view holds its handoff; nowhere once the navigation releases it.
    const navigationAnchorPage = computed(() => viewportAuthority.handoffReleased.value
        ? null
        : viewportAuthority.pendingTargetPage.value ?? ticketTargetPage.value);
    // Where rendering must land now. Reload work and a retained surface ticket
    // keep the page they asked for while a page edit installs a shorter
    // document, so project that request into the current page count.
    const renderTargetPage = computed(() => {
        const page = viewportAuthority.targetPage.value ?? navigationAnchorPage.value;
        return page === null ? null : toBoundedPageNumber(page);
    });
    const searchNavigationTargetPage = computed(() => currentNavigationTicket()?.request.source === 'search'
        ? navigationAnchorPage.value
        : null);
    const searchNavigationState = computed(() => searchNavigationTargetPage.value === null ? 'idle' : 'navigating');
    return {
        handleWheel,
        scrollToPage: submitPageNavigation,
        place,
        resumeNavigation: () => {
            const ticket = navigationTicket.value;
            if (ticket) startNavigationTicket(ticket);
        },
        revealSearchNavigationTarget: (page: number, scrollOptions?: IScrollToPageOptions) => submitPageNavigation(toPageNumber(page), {
            ...scrollOptions,
            navigationSource: 'search',
        }),
        endSearchNavigation: () => cancelDestinationNavigationTarget('search'),
        cancelProgrammaticNavigation,
        cancelDestinationNavigationTarget,
        retireStaleViewportIntent,
        viewportAuthority,
        submitNavigationRequest,
        relayout,
        /** The receipt of the layout change waiting for its flush, or null when none is. */
        pendingRelayoutReceipt: () => pendingRelayout?.receipt ?? null,
        captureRelayoutAnchor,
        captureCurrentSemanticAnchor,
        navigationAnchorPage,
        renderTargetPage,
        searchNavigationTargetPage,
        searchNavigationState,
        isProgrammaticNavigationActive: computed(() => viewportAuthority.phase.value !== 'idle'
            && viewportAuthority.phase.value !== 'settled'
            && viewportAuthority.phase.value !== 'cancelled'),
    };
};
