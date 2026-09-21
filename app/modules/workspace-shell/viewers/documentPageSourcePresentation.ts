import type {
    IDocumentPageMetrics,
    IDocumentRenderLease,
    TDocumentRenderPriority,
    IDocumentPageSource, IDocumentViewerRuntime , IDocumentViewerRenderSession , IDocumentOpenSurfaceRenderOwner, 
} from '@app/modules/document-viewer/public';
import type {
    IDocumentPageSourceTransition,
    IDocumentPageSourceFence,
    IDocumentPageSourceFeaturePackEmit,
} from '@app/modules/workspace-shell/viewers/documentPageSourceFeaturePackState';
import {
    getFailureReceipt,
    type FailureReceipt,
} from '@contracts/diagnostics/failureReceipt';
import type { FailurePresentation } from '@app/composables/useFailureToast';
import { BrowserLogger } from '@app/utils/browserLogger';
import {
    runDocumentViewerActivationPresentation,
    waitForDocumentViewerVisibleLayout,
} from '@app/modules/document-viewer/public';
const DOCUMENT_RENDER_PRIORITY_RANK: Record<TDocumentRenderPriority, number> = {
    navigation: 5,
    visible: 4,
    nearby: 3,
    thumbnail: 2,
    prefetch: 1,
};
export interface IDocumentPageSourceVisualState {
    generation: number;
    error: string | null;
    failurePresentation: FailurePresentation | null;
    ready: boolean;
    lease: IDocumentRenderLease | null;
    priority: TDocumentRenderPriority;
    retryCount: number;
    widthPx: number;
    unsubscribeInvalidation: (() => void) | null;
}
export type TDocumentPageSourceVisual = 'none' | 'skeleton' | 'fresh' | 'error';

function attachFailureReceipt(error: unknown, receipt: FailureReceipt) {
    if (!error || typeof error !== 'object' || getFailureReceipt(error)) {
        return;
    }
    try {
        Object.defineProperty(error, 'failure', {
            configurable: true,
            value: receipt,
        });
    } catch {
        // Some browser event objects are not extensible. The presentation
        // still owns the receipt; callers can use createFailureError below.
    }
}

export function resolveDocumentPageSourceRenderWidthPx(
    metrics: IDocumentPageMetrics,
    effectiveZoom: number,
    pixelRatio: number,
) {
    return Math.max(1, Math.round(metrics.widthPoints * effectiveZoom * pixelRatio));
}
function isOwnedConnectedDocumentPageImage(
    image: HTMLImageElement,
    pageNumber: number,
    openingTarget: HTMLElement | null,
) {
    if (openingTarget) {
        return image.parentElement === openingTarget && openingTarget.isConnected;
    }
    const page = image.closest<HTMLElement>('[data-testid="document-page-source-page"]');
    return Boolean(page?.isConnected && page.dataset.pageNumber === String(pageNumber));
}
function waitForDocumentPageImagePaint(image: HTMLImageElement, signal: AbortSignal) {
    if (signal.aborted || !image.isConnected) {
        return Promise.resolve(false);
    }
    if (document.visibilityState !== 'visible') {
        return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
        let animationFrame = 0;
        const finish = (painted: boolean) => {
            cancelAnimationFrame(animationFrame);
            signal.removeEventListener('abort', handleAbort);
            document.removeEventListener('visibilitychange', handleVisibilityChange);
            resolve(painted);
        };
        const handleAbort = () => finish(false);
        const handleVisibilityChange = () => {
            if (document.visibilityState !== 'visible') finish(true);
        };
        signal.addEventListener('abort', handleAbort, {once: true});
        document.addEventListener('visibilitychange', handleVisibilityChange);
        animationFrame = requestAnimationFrame(() => finish(true));
    });
}
export function createDocumentPageSourcePresentation(options: {
    chassisAuthority: IDocumentViewerRuntime | null;
    emit: IDocumentPageSourceFeaturePackEmit;
    ensureExactPageMetric: (
        source: IDocumentPageSource, generation: number, pageNumber: number,
        signal: AbortSignal, isCurrent: () => boolean,
    ) => Promise<IDocumentPageMetrics>;
    flushMetricPublication: () => void;
    getOpeningTarget: (pageNumber: number) => HTMLElement | null;
    isFenceCurrent: (fence: IDocumentPageSourceFence) => boolean;
    openSurfaceRenderOwner: IDocumentOpenSurfaceRenderOwner | undefined;
    readContinuousScroll: () => boolean;
    readCurrentPage: () => number;
    readFence: () => IDocumentPageSourceFence;
    readIsActive: () => boolean;
    readLoadSignal: () => AbortSignal | null;
    readMetric: (pageNumber: number) => IDocumentPageMetrics | undefined;
    readPageScale: (pageNumber: number) => number;
    readPixelRatio: () => number;
    readRenderDemand: () => {
        bufferPages: readonly number[];
        residentPages: readonly number[];
        visiblePages: readonly number[];
    };
    readSource: () => IDocumentPageSource | null;
    readViewport: () => HTMLElement | null;
    readViewportScrollDirection: () => -1 | 0 | 1;
    renderSession: IDocumentViewerRenderSession | undefined;
    scheduleRender: () => void;
}) {
    const pageStates = shallowReactive(new Map<number, IDocumentPageSourceVisualState>());
    const renderControllers = new Map<number, AbortController>();
    // An <img> finishing its load is invisible to Vue; this map makes getVisual re-derive when the
    // opening-shell handoff remounts an already-ready page with a fresh image element.
    const loadedSurfaceImages = shallowReactive(new Map<number, HTMLImageElement>());
    let nextViewportRenderRequestId = 0;
    const beginPending = (_pageNumber: number, state: IDocumentPageSourceVisualState) => {
        state.error = null;
        state.failurePresentation = null;
        state.ready = false;
    };
    const createVisualState = (
        generation: number,
        priority: TDocumentRenderPriority,
        widthPx: number,
    ) => shallowReactive<IDocumentPageSourceVisualState>({
        generation,
        error: null,
        failurePresentation: null,
        ready: false,
        lease: null,
        priority,
        retryCount: 0,
        widthPx,
        unsubscribeInvalidation: null,
    });
    const subscribeInvalidation = (
        pageNumber: number,
        state: IDocumentPageSourceVisualState,
        lease: IDocumentRenderLease,
    ) => lease.onInvalidated?.(() => {
        const invalidated = pageStates.get(pageNumber);
        if (invalidated !== state || invalidated.lease !== lease) {
            return;
        }
        const image = getMountedImage(pageNumber, invalidated);
        if (image?.dataset.pageSourceCandidate) image.remove();
        invalidated.unsubscribeInvalidation?.();
        invalidated.unsubscribeInvalidation = null;
        invalidated.lease = null;
        beginPending(pageNumber, invalidated);
        if (invalidated.priority !== 'nearby') {
            options.scheduleRender();
        }
    }) ?? null;
    const getSurface = (pageNumber: number) => {
        const surface = pageStates.get(pageNumber)?.lease?.surface;
        return typeof surface === 'string' ? surface : null;
    };
    const getRenderGeneration = (pageNumber: number): number | '' => (
        pageStates.get(pageNumber)?.generation ?? ''
    );
    const getMountedImage = (pageNumber: number, state: IDocumentPageSourceVisualState) => {
        const openingTarget = options.getOpeningTarget(pageNumber);
        const candidates = openingTarget
            ? openingTarget.querySelectorAll<HTMLImageElement>('[data-testid="document-page-source-image"]')
            : options.readViewport()?.querySelectorAll<HTMLImageElement>('[data-testid="document-page-source-image"]');
        return [...(candidates ?? [])].find(image => (
            image.dataset.pageRenderGeneration === String(state.generation)
            && image.dataset.documentLoadGeneration === String(options.readFence().loadGeneration)
            && isOwnedConnectedDocumentPageImage(image, pageNumber, openingTarget)
        )) ?? null;
    };
    const getConnectedImage = (pageNumber: number, state: IDocumentPageSourceVisualState) => {
        const image = getMountedImage(pageNumber, state);
        return image?.complete && image.naturalWidth > 0 ? image : null;
    };
    const getVisual = (pageNumber: number): TDocumentPageSourceVisual => {
        const state = pageStates.get(pageNumber);
        loadedSurfaceImages.get(pageNumber);
        const connected = Boolean(state && getConnectedImage(pageNumber, state));
        const pending: TDocumentPageSourceVisual = 'skeleton';
        if (state?.error) {
            return 'error';
        }
        const visual = options.chassisAuthority?.openSurface.viewportSession.value.visual;
        if (visual?.kind === 'page' && visual.pageNumber === pageNumber) {
            if (visual.presentation === 'error') {
                return 'error';
            }
            if (visual.presentation === 'canvas' && connected) {
                return 'fresh';
            }
            return visual.presentation === 'skeleton' ? 'skeleton' : pending;
        }
        return state?.ready && connected ? 'fresh' : pending;
    };
    const getVisualError = (pageNumber: number) => {
        const viewportVisual = options.chassisAuthority?.openSurface.viewportSession.value.visual;
        return pageStates.get(pageNumber)?.error
            ?? (viewportVisual?.kind === 'page' && viewportVisual.pageNumber === pageNumber
                ? viewportVisual.error
                : null)
            ?? `Unable to display page ${String(pageNumber)}`;
    };
    const getVisualFailurePresentation = (pageNumber: number) => (
        pageStates.get(pageNumber)?.failurePresentation ?? null
    );
    const createFailureError = (pageNumber: number, message?: string) => {
        const error = new Error(message ?? getVisualError(pageNumber));
        const receipt = getVisualFailurePresentation(pageNumber)?.failure;
        if (receipt) {
            attachFailureReceipt(error, receipt);
        }
        return error;
    };
    function commitTerminalError(pageNumber: number, cause?: unknown) {
        const lifecycleFence = options.readFence();
        let state = pageStates.get(pageNumber);
        if (!state) {
            state = createVisualState(lifecycleFence.loadGeneration, 'navigation', 0);
            pageStates.set(pageNumber, state);
        }
        state.unsubscribeInvalidation?.();
        state.lease?.release();
        state.unsubscribeInvalidation = null;
        state.lease = null;
        const message = `Unable to display page ${String(pageNumber)}`;
        state.error = message;
        const receipt = state.failurePresentation?.failure ?? BrowserLogger.error(
            'pdf-page-source',
            'Failed to render document page',
            cause ?? message,
            getFailureReceipt(cause) ?? {
                code: 'RENDERER_PDF_PAGE_RENDER_FAILED',
                context: {},
            },
        );
        state.failurePresentation = {
            failure: receipt,
            title: 'Unable to display page',
            description: message,
        };
        attachFailureReceipt(cause, receipt);
        state.ready = false;
        const openSurface = options.chassisAuthority?.openSurface;
        const snapshot = openSurface?.snapshot.value;
        const viewportState = openSurface?.viewportSession.value;
        const surfaceGeneration = lifecycleFence.openSurfaceGeneration;
        if (
            openSurface
            && snapshot
            && viewportState?.requestedPage === pageNumber
            && surfaceGeneration !== null
            && snapshot.generation === surfaceGeneration
        ) {
            if (viewportState.lifecycle === 'transitioning') {
                const navigationFence = options.openSurfaceRenderOwner
                    && openSurface.createOwnedRenderFence(options.openSurfaceRenderOwner, {
                        generation: surfaceGeneration,
                        documentRevision: snapshot.identity?.documentRevision ?? '',
                        rendererVersion: lifecycleFence.loadGeneration,
                        rendererRequestId: ++nextViewportRenderRequestId,
                        pageNumber,
                    });
                if (navigationFence) {
                    openSurface.reject(navigationFence, message);
                }
            } else if (snapshot.committedRender?.pageNumber === pageNumber) {
                openSurface.reject(snapshot.committedRender, message);
            } else {
                openSurface.fail(surfaceGeneration, message);
            }
        }
        return message;
    }
    function commitReady(pageNumber: number, state: IDocumentPageSourceVisualState) {
        const lifecycleFence = options.readFence();
        const openSurface = options.chassisAuthority?.openSurface;
        const snapshot = openSurface?.snapshot.value;
        const viewportState = openSurface?.viewportSession.value;
        const image = getConnectedImage(pageNumber, state);
        const navigationTicket = openSurface?.navigationTicket.value ?? null;
        if (
            !state.ready
            || !image
            || pageStates.get(pageNumber) !== state
            || !openSurface
            || !snapshot
            || !viewportState
            || lifecycleFence.openSurfaceGeneration === null
            || snapshot.generation !== lifecycleFence.openSurfaceGeneration
            || viewportState.requestedPage !== pageNumber
            || viewportState.viewportIntent?.pageNumber !== pageNumber
            || ![
                'opening',
                'transitioning',
            ].includes(viewportState.lifecycle)
            || navigationTicket !== null && !openSurface.isNavigationCurrent(navigationTicket)
        ) {
            return false;
        }
        const fence = options.openSurfaceRenderOwner
            && openSurface.createOwnedRenderFence(options.openSurfaceRenderOwner, {
                generation: lifecycleFence.openSurfaceGeneration,
                documentRevision: snapshot.identity?.documentRevision ?? '',
                rendererVersion: lifecycleFence.loadGeneration,
                rendererRequestId: ++nextViewportRenderRequestId,
                pageNumber,
            });
        const viewport = options.readViewport();
        if (!fence || !openSurface.commitCanvas(fence) || !viewport) {
            return false;
        }
        const placed = navigationTicket
            ? openSurface.reportNavigation(navigationTicket, {
                kind: 'placed',
                page: pageNumber,
                left: viewport.scrollLeft,
                top: viewport.scrollTop,
                geometryRevision: lifecycleFence.loadGeneration,
                interactionEpoch: options.chassisAuthority?.viewportWritePort.getInteractionEpoch() ?? 0,
            })
            : openSurface.commitViewport({
                generation: lifecycleFence.openSurfaceGeneration,
                documentRevision: fence.documentRevision,
                viewportIntentId: viewportState.viewportIntent.id,
                documentGeometryRevision: lifecycleFence.loadGeneration,
                interactionEpoch: options.chassisAuthority?.viewportWritePort.getInteractionEpoch() ?? 0,
                pageNumber,
                left: viewport.scrollLeft,
                top: viewport.scrollTop,
            });
        if (!placed || !openSurface.markReady(fence)) {
            return false;
        }
        return navigationTicket
            ? openSurface.reportNavigation(navigationTicket, {
                kind: 'arrived',
                page: pageNumber,
            })
            : true;
    }
    function markReady(pageNumber: number, state: IDocumentPageSourceVisualState) {
        const initialOpen = options.chassisAuthority?.openSurface.viewportSession.value.lifecycle === 'opening';
        state.ready = true;
        state.error = null;
        state.failurePresentation = null;
        state.retryCount = 0;
        const committed = commitReady(pageNumber, state);
        if (committed && initialOpen) {
            options.emit('initial-visual-ready', {pageNumber});
        }
        return committed;
    }
    async function renderPage(pageNumber: number) {
        const activeSource = options.readSource();
        const fence = options.readFence();
        const loadSignal = options.readLoadSignal();
        const currentPage = options.readCurrentPage();
        const isCurrent = () => (
            options.isFenceCurrent(fence)
            && options.readIsActive()
            && options.readSource() === activeSource
            && loadSignal?.aborted === false
        );
        if (!activeSource || !loadSignal || !options.readIsActive()) {
            return;
        }
        const existingState = pageStates.get(pageNumber);
        if (existingState?.error || (existingState?.lease && existingState.retryCount > 2)) {
            return;
        }
        const demand = options.readRenderDemand();
        const direction = options.readViewportScrollDirection();
        const leading = options.readContinuousScroll()
            && direction !== 0
            && demand.bufferPages.includes(pageNumber)
            && Math.sign(pageNumber - currentPage) === direction;
        const priority: TDocumentRenderPriority = pageNumber === (
            options.chassisAuthority?.openSurface.viewportSession.value.requestedPage ?? currentPage
        )
            ? 'navigation'
            : demand.visiblePages.includes(pageNumber) || leading ? 'visible' : 'nearby';
        try {
            await options.ensureExactPageMetric(
                activeSource,
                fence.loadGeneration,
                pageNumber,
                loadSignal,
                isCurrent,
            );
            if (!isCurrent()) {
                return;
            }
            options.flushMetricPublication();
            await nextTick();
            if (!isCurrent()) {
                return;
            }
        } catch (error) {
            if (!(error instanceof DOMException && error.name === 'AbortError') && isCurrent()) {
                const message = commitTerminalError(pageNumber, error);
                if (pageNumber === options.readCurrentPage()) {
                    options.emit('loadError', error instanceof Error ? error : createFailureError(pageNumber, message));
                }
            }
            return;
        }
        const metric = options.readMetric(pageNumber);
        if (!metric || !isCurrent()) {
            return;
        }
        const widthPx = resolveDocumentPageSourceRenderWidthPx(
            metric,
            options.readPageScale(pageNumber),
            options.readPixelRatio(),
        );
        const previous = pageStates.get(pageNumber);
        const activeController = renderControllers.get(pageNumber);
        if (previous?.widthPx === widthPx && previous.lease) {
            if (DOCUMENT_RENDER_PRIORITY_RANK[priority] > DOCUMENT_RENDER_PRIORITY_RANK[previous.priority]) {
                previous.lease.promotePriority?.(priority);
                previous.priority = priority;
            }
            if (!previous.ready && getConnectedImage(pageNumber, previous)) {
                markReady(pageNumber, previous);
            }
            if (previous.ready && priority === 'navigation') {
                void nextTick(() => commitReady(pageNumber, previous));
            }
            return;
        }
        if (previous?.widthPx === widthPx && activeController) {
            return;
        }
        activeController?.abort();
        const preserveExistingVisual = Boolean(previous?.lease && getMountedImage(pageNumber, previous));
        if (previous && preserveExistingVisual && priority === 'navigation') {
            commitReady(pageNumber, previous);
        }
        if (previous && !preserveExistingVisual) {
            previous.unsubscribeInvalidation?.();
            previous.lease?.release();
            previous.unsubscribeInvalidation = null;
            previous.lease = null;
            beginPending(pageNumber, previous);
        }
        const renderController = new AbortController();
        renderControllers.set(pageNumber, renderController);
        const renderAttempt: { generation: number | null } = {generation: null};
        try {
            const outcome = await options.renderSession?.runPageRender(pageNumber, async (renderGeneration) => {
                renderAttempt.generation = renderGeneration;
                const nextState = previous ?? createVisualState(renderGeneration, priority, widthPx);
                if (!preserveExistingVisual) {
                    nextState.generation = renderGeneration;
                    nextState.priority = priority;
                    nextState.widthPx = widthPx;
                    pageStates.set(pageNumber, nextState);
                    beginPending(pageNumber, nextState);
                }
                await nextTick();
                if (!isCurrent() || renderController.signal.aborted) {
                    throw new DOMException('Superseded page render', 'AbortError');
                }
                return activeSource.renderPage({
                    pageNumber,
                    widthPx,
                    priority,
                    signal: renderController.signal,
                });
            });
            if (!outcome) {
                return;
            }
            if (!isCurrent()) {
                outcome.value.release();
                return;
            }
            const {
                generation: renderGeneration,
                value: lease,
            } = outcome;
            let candidate: HTMLImageElement | null = null;
            try {
                renderController.signal.throwIfAborted();
                const current = pageStates.get(pageNumber);
                if (
                    !outcome.committed
                    || !isCurrent()
                    || renderControllers.get(pageNumber) !== renderController
                    || !current
                    || (preserveExistingVisual
                        ? current !== previous
                        : current.generation !== renderGeneration)
                ) {
                    lease.release();
                    return;
                }
                if (preserveExistingVisual) {
                    const oldImage = getConnectedImage(pageNumber, current);
                    if (!oldImage || typeof lease.surface !== 'string') {
                        throw new Error('Unable to connect replacement page image');
                    }
                    candidate = oldImage.cloneNode() as HTMLImageElement;
                    candidate.dataset.pageRenderGeneration = String(renderGeneration);
                    candidate.dataset.pageSourceCandidate = 'true';
                    Object.assign(candidate.style, {
                        inset: '0',
                        position: 'absolute',
                    });
                    oldImage.parentElement?.append(candidate);
                    candidate.src = lease.surface;
                    await candidate.decode();
                    renderController.signal.throwIfAborted();
                    if (
                        !await waitForDocumentPageImagePaint(candidate, renderController.signal)
                        || !isCurrent()
                        || pageStates.get(pageNumber) !== current
                        || !isOwnedConnectedDocumentPageImage(
                            candidate,
                            pageNumber,
                            options.getOpeningTarget(pageNumber),
                        )
                    ) {
                        throw new DOMException('Superseded page render', 'AbortError');
                    }
                }
                const previousLease = current.lease;
                const previousUnsubscribeInvalidation = current.unsubscribeInvalidation;
                current.generation = renderGeneration;
                current.error = null;
                current.lease = lease;
                current.priority = priority;
                current.widthPx = widthPx;
                current.unsubscribeInvalidation = subscribeInvalidation(pageNumber, current, lease);
                if (candidate) markReady(pageNumber, current);
                await nextTick();
                previousUnsubscribeInvalidation?.();
                previousLease?.release();
                const renderedImage = getConnectedImage(pageNumber, current);
                if (renderedImage && renderedImage !== candidate) candidate?.remove();
            } catch (error) {
                candidate?.remove();
                lease.release();
                throw error;
            }
        } catch (error) {
            const current = pageStates.get(pageNumber);
            if (
                renderControllers.get(pageNumber) === renderController
                && !renderController.signal.aborted
                && isCurrent()
                && (preserveExistingVisual
                    ? current === previous
                    : current?.generation === renderAttempt.generation)
                && !(error instanceof DOMException && error.name === 'AbortError')
            ) {
                if (current && current.retryCount < 2) {
                    current.retryCount += 1;
                    if (!preserveExistingVisual) {
                        beginPending(pageNumber, current);
                    }
                    options.scheduleRender();
                } else {
                    if (current) current.retryCount += 1;
                    if (!preserveExistingVisual) commitTerminalError(pageNumber, error);
                    if (pageNumber === options.readCurrentPage()) {
                        options.emit('loadError', preserveExistingVisual
                            ? error
                            : error instanceof Error
                                ? error
                                : createFailureError(pageNumber));
                    }
                }
            }
        } finally {
            if (renderControllers.get(pageNumber) === renderController) {
                renderControllers.delete(pageNumber);
                options.scheduleRender();
            }
        }
    }
    function resolveSurfaceEvent(pageNumber: number, surface: string, event: Event) {
        const state = pageStates.get(pageNumber);
        const image = event.currentTarget;
        const fence = options.readFence();
        if (
            !(image instanceof HTMLImageElement)
            || !state
            || state.lease?.surface !== surface
            || image.dataset.pageRenderGeneration !== String(state.generation)
            || image.dataset.documentLoadGeneration !== String(fence.loadGeneration)
            || image.dataset.openSurfaceGeneration !== String(fence.openSurfaceGeneration ?? '')
            || !isOwnedConnectedDocumentPageImage(image, pageNumber, options.getOpeningTarget(pageNumber))
        ) {
            return null;
        }
        return {
            fence,
            image,
            state,
        };
    }
    async function handleSurfaceLoad(pageNumber: number, surface: string, event: Event) {
        const target = resolveSurfaceEvent(pageNumber, surface, event);
        if (!target) {
            return;
        }
        loadedSurfaceImages.set(pageNumber, markRaw(target.image));
        const controller = renderControllers.get(pageNumber) ?? new AbortController();
        if (!await waitForDocumentPageImagePaint(target.image, controller.signal)) {
            return;
        }
        const state = pageStates.get(pageNumber);
        if (
            !options.isFenceCurrent(target.fence)
            || !options.readIsActive()
            || state !== target.state
            || state.lease?.surface !== surface
            || !isOwnedConnectedDocumentPageImage(
                target.image,
                pageNumber,
                options.getOpeningTarget(pageNumber),
            )
        ) {
            return;
        }
        if (!target.image.dataset.pageSourceCandidate) {
            target.image.parentElement?.querySelectorAll<HTMLImageElement>(
                '[data-page-source-candidate]',
            ).forEach(image => image.remove());
        }
        markReady(pageNumber, state);
    }
    function handleSurfaceError(pageNumber: number, surface: string, event: Event) {
        const target = resolveSurfaceEvent(pageNumber, surface, event);
        if (!target) {
            return;
        }
        target.state.lease?.release();
        target.state.unsubscribeInvalidation?.();
        target.state.unsubscribeInvalidation = null;
        target.state.lease = null;
        target.image.parentElement?.querySelectorAll<HTMLImageElement>(
            '[data-page-source-candidate]',
        ).forEach(image => image.remove());
        if (target.state.retryCount >= 2) {
            target.state.retryCount += 1;
            const message = commitTerminalError(pageNumber, event);
            if (pageNumber === options.readCurrentPage()) {
                options.emit('loadError', createFailureError(pageNumber, message));
            }
            return;
        }
        target.state.retryCount += 1;
        beginPending(pageNumber, target.state);
        void renderPage(pageNumber);
    }
    function releasePage(pageNumber: number) {
        renderControllers.get(pageNumber)?.abort();
        renderControllers.delete(pageNumber);
        const state = pageStates.get(pageNumber);
        const image = state && getConnectedImage(pageNumber, state);
        state?.unsubscribeInvalidation?.();
        state?.lease?.release();
        if (image?.dataset.pageSourceCandidate) image.remove();
        pageStates.delete(pageNumber);
        loadedSurfaceImages.delete(pageNumber);
        options.renderSession?.releasePage(pageNumber);
    }
    async function restore(
        transition: IDocumentPageSourceTransition,
        restoreOptions: {
            measureViewport: () => void;
            renderMountedPages: () => Promise<void>;
            restoreViewport?: () => void;
        },
    ) {
        const isCurrent = transition.isCurrent;
        await runDocumentViewerActivationPresentation({
            isCurrent,
            waitForVisibleLayout: () => waitForDocumentViewerVisibleLayout(
                options.readViewport,
                {isCurrent},
            ),
            measure: restoreOptions.measureViewport,
            reconcile: async () => {
                if (!isCurrent()) {
                    return;
                }
                restoreOptions.restoreViewport?.();
                const currentPage = options.readCurrentPage();
                for (const pageNumber of new Set([
                    currentPage,
                    ...options.readRenderDemand().residentPages,
                ])) {
                    if (!isCurrent()) {
                        return;
                    }
                    const state = pageStates.get(pageNumber);
                    if (!state?.lease) {
                        continue;
                    }
                    const image = getConnectedImage(pageNumber, state);
                    const metric = options.readMetric(pageNumber);
                    if (image?.complete && image.naturalWidth > 0) {
                        if (metric && state.widthPx === resolveDocumentPageSourceRenderWidthPx(
                            metric,
                            options.readPageScale(pageNumber),
                            options.readPixelRatio(),
                        )) {
                            markReady(pageNumber, state);
                        }
                        continue;
                    }
                    if (!isCurrent()) {
                        return;
                    }
                    state.unsubscribeInvalidation?.();
                    state.lease.release();
                    state.unsubscribeInvalidation = null;
                    state.lease = null;
                    beginPending(pageNumber, state);
                }
                if (!isCurrent()) {
                    return;
                }
                await renderPage(currentPage);
                if (isCurrent()) {
                    await restoreOptions.renderMountedPages();
                }
            },
        });
    }
    return {
        beginSourceGeneration() {
            renderControllers.forEach(controller => controller.abort());
            renderControllers.clear();
            for (const pageNumber of [...pageStates.keys()]) {
                releasePage(pageNumber);
            }
        },
        commitReady,
        commitTerminalError,
        dispose() {
            for (const pageNumber of [...pageStates.keys()]) {
                releasePage(pageNumber);
            }
        },
        getRenderGeneration,
        getSurface,
        getVisual,
        getVisualError,
        getVisualFailurePresentation,
        createFailureError,
        handleSurfaceError,
        handleSurfaceLoad,
        pageStates,
        releasePage,
        renderControllers,
        renderPage,
        restore,
    };
}
