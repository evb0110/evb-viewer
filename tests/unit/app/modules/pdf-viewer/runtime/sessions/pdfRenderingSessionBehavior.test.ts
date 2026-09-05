// @vitest-environment happy-dom

import {
    computed,
    createApp,
    defineComponent,
    readonly,
    ref,
    shallowReadonly,
    shallowRef,
} from 'vue';
import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { IPageRange } from '@app/types/pdfUi';
import type { IPdfDocumentTransition } from '@app/modules/pdf-viewer/runtime/sessions/pdfDocumentSession';
import type { IPdfViewportDemand } from '@app/modules/pdf-viewer/runtime/sessions/createPdfViewportSession';
import type { TPdfPageRenderState } from '@app/modules/pdf-viewer/runtime/rendering/pdfPageRenderState';
import type { IRenderVisiblePagesOptions } from '@app/modules/pdf-viewer/runtime/rendering/pdfRendererTypes';
import { createPdfPageRasterScheduler } from '@app/modules/pdf-viewer/engine/pdf-page-raster-scheduler/pdfPageRasterScheduler';
import { createDocumentOpenSurfaceSession } from '@app/utils/document-viewer/chassis/documentOpenSurfaceSession';
import type { IDocumentViewerChassisAuthority } from '@app/utils/document-viewer/chassis/documentViewerChassisAuthority';
import { cast } from '@tests/helpers/cast';

const rendererFixture = vi.hoisted(() => {
    const api = {
        adoptCommittedCanvasVersions: vi.fn(),
        applySearchHighlights: vi.fn(),
        attachAnnotationProjection: vi.fn(() => vi.fn()),
        cancelPendingSearchScroll: vi.fn(),
        cleanupAllLayers: vi.fn(async () => undefined),
        hideManagedAnnotationEditors: vi.fn(),
        queuePrioritizedTextLayerPromotions: vi.fn(),
        releasePageLayers: vi.fn(),
        renderAnnotationEditorLayerForPage: vi.fn(),
        renderCommittedPageLayers: vi.fn(async (_commit: {
            pageNumber: number;
            requestId: number;
            version: number;
        }) => undefined),
        renderLayerPromotions: vi.fn(async () => undefined),
        resolveLayerPromotionDemand: vi.fn<(
            pages: readonly number[],
        ) => {
            range: IPageRange;
            options: IRenderVisiblePagesOptions;
        } | null>(() => null),
        canvasHiddenAnnotationIds: {value: new Set<string>()},
        requestScrollToCurrentResult: vi.fn(),
    };
    return {
        api,
        options: null as Record<string, unknown> | null,
    };
});

const rerenderCoordinatorFixture = vi.hoisted(() => ({options: null as Record<string, unknown> | null}));

const canvasFixture = vi.hoisted(() => ({
    prepare: vi.fn(),
    mount: vi.fn(),
    cleanup: vi.fn(),
    cleanupResult: vi.fn((result: {canvas: HTMLCanvasElement}) => result.canvas.remove()),
}));

vi.mock('@app/utils/browserLogger', () => ({BrowserLogger: {
    diagnostic: vi.fn(),
    diagnosticThrottled: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    warnThrottled: vi.fn(),
    debug: vi.fn(),
}}));
vi.mock('@app/utils/startupMetrics', () => ({markStartupMetricOnce: vi.fn()}));
vi.mock('@app/utils/pdfRenderTrace', () => ({logPdfRenderTrace: vi.fn()}));
vi.mock('@app/modules/pdf-viewer/runtime/rendering/usePdfPageRenderer', () => ({usePdfPageRenderer: vi.fn((options: Record<string, unknown>) => {
    rendererFixture.options = options;
    return rendererFixture.api;
})}));
vi.mock('@app/modules/pdf-viewer/runtime/composables/pdf/usePdfCanvasRenderer', () => ({usePdfCanvasRenderer: () => ({
    prepareCanvasRender: canvasFixture.prepare,
    applyContainerUserUnit: vi.fn(),
    mountCanvas: canvasFixture.mount,
    cleanupCanvas: canvasFixture.cleanup,
    cleanupCanvasRenderResult: canvasFixture.cleanupResult,
})}));
vi.mock('@app/modules/pdf-viewer/runtime/composables/usePdfViewerRerenderCoordinator', () => ({usePdfViewerRerenderCoordinator: vi.fn((options: Record<string, unknown>) => {
    rerenderCoordinatorFixture.options = options;
    return {
        reRenderVisiblePagesAndSyncCurrentPage: vi.fn(async () => undefined),
        cleanupZoomOrchestration: vi.fn(),
    };
})}));
vi.mock('@app/modules/pdf-viewer/runtime/composables/usePdfViewerResizeLifecycle', () => ({usePdfViewerResizeLifecycle: vi.fn(() => ({
    buildResizeAnchorContext: vi.fn(() => null),
    beginResizeTransition: vi.fn(),
    captureResizeVisualSnapshots: vi.fn(),
    scheduleEndResizeTransition: vi.fn(),
    cleanupResizeLifecycle: vi.fn(),
}))}));
vi.mock('@app/modules/pdf-viewer/runtime/composables/usePdfViewerZoomRerenderQueue', () => ({usePdfViewerZoomRerenderQueue: vi.fn(() => ({
    scheduleResizeAwareRerender: vi.fn(),
    enqueueZoomSync: vi.fn(),
    resetZoomRerenderQueueState: vi.fn(),
    cleanupZoomRerenderQueue: vi.fn(),
}))}));
vi.mock('@app/modules/pdf-viewer/runtime/composables/usePdfViewerRenderStallRecovery', () => ({usePdfViewerRenderStallRecovery: vi.fn(() => ({
    resetRenderStallRecoveryState: vi.fn(),
    invalidatePages: vi.fn(),
    consumePendingInvalidation: vi.fn(() => null),
    handlePageRenderStall: vi.fn(),
}))}));
vi.mock('@app/modules/pdf-viewer/runtime/composables/usePdfViewerInitialRenderRecovery', () => ({usePdfViewerInitialRenderRecovery: vi.fn(() => ({scheduleRecoverInitialRender: vi.fn()}))}));
vi.mock('@app/modules/pdf-viewer/runtime/lifecycle/usePdfViewerActivationRestore', () => ({usePdfViewerActivationRestore: vi.fn(() => ({
    nextActivationRestoreRunId: vi.fn(() => 1),
    isActivationRunCurrent: vi.fn(() => true),
    renderActiveDocumentAfterActivation: vi.fn(async () => undefined),
}))}));

const {createPdfRenderingSession} = await import(
    '@app/modules/pdf-viewer/runtime/sessions/createPdfRenderingSession'
);

function createTransition(
    phase: IPdfDocumentTransition['phase'],
    plan: Partial<IPdfDocumentTransition['plan']> = {},
): IPdfDocumentTransition {
    return {
        phase,
        fence: {
            loadToken: 7,
            documentVersion: 9,
            documentRevision: 'revision-7',
            openSurfaceGeneration: 11,
        },
        plan: {
            isReload: false,
            isSelectiveReload: false,
            pagesToInvalidate: null,
            preserveVisibleContent: false,
            preservePageStructure: false,
            ...plan,
        },
        reason: 'test',
        isCurrent: () => true,
    };
}

function createRenderingFixture(fixtureOptions: {
    autoResolve?: boolean;
    authoritativeRaster?: boolean;
    bufferPages?: number;
    clampBufferedPages?: readonly number[];
    prioritizeTextLayer?: boolean;
    residentPages?: readonly number[];
    withChassisAuthority?: boolean;
} = {}) {
    const subscribers: Array<(transition: IPdfDocumentTransition) => void | Promise<void>> = [];
    const disposables: Array<() => void | Promise<void>> = [];
    const currentPage = ref(3);
    const demand = shallowRef<IPdfViewportDemand>({
        revision: 1,
        visibleRange: {
            start: 3,
            end: 3,
        },
        requiredPages: [3],
        nearbyPages: fixtureOptions.residentPages?.filter(page => page !== 3) ?? [],
        residentPages: fixtureOptions.residentPages ?? [3],
        mountedPages: fixtureOptions.residentPages ?? [3],
        currentPage: 3,
        destinationPage: null,
        operational: true,
        mandatoryRaster: {
            id: 1,
            range: {
                start: 3,
                end: 3,
            },
            options: {
                ...(fixtureOptions.authoritativeRaster === undefined
                    ? {}
                    : {authoritativeRaster: fixtureOptions.authoritativeRaster}),
                ...(fixtureOptions.prioritizeTextLayer === true
                    ? {prioritizeTextLayer: true}
                    : {}),
                bufferOverride: 0,
                suppressResidentRasterDemand: true,
            },
        },
    });
    const cancelRasterRevision = ref(0);
    const userPhysicalNavigationEpoch = ref(0);
    const beginLayoutGeometryReplacement = vi.fn(() => vi.fn());
    const cancelPendingSearchRevision = ref(0);
    const visualReadySignal = shallowRef({
        revision: 0,
        pageNumber: 0,
    });
    const navigationCommittedSignal = shallowRef({
        revision: 0,
        pageNumber: 0,
    });
    const openSurface = fixtureOptions.withChassisAuthority
        ? createDocumentOpenSurfaceSession()
        : null;
    const settleMandatoryRaster = vi.fn();
    const effectiveScale = ref(1);
    const viewport = {
        currentPage,
        visibleRange: ref<IPageRange>({
            start: 3,
            end: 3,
        }),
        demand: shallowReadonly(demand),
        cancelRasterRevision: readonly(cancelRasterRevision),
        cancelPendingSearchRevision: readonly(cancelPendingSearchRevision),
        visualReadySignal: shallowReadonly(visualReadySignal),
        navigationCommittedSignal: shallowReadonly(navigationCommittedSignal),
        userViewportInteractionEpoch: ref(0),
        userPhysicalNavigationEpoch,
        beginLayoutGeometryReplacement,
        pageSlots: {isMounted: vi.fn((page: number) => demand.value.mountedPages.includes(page))},
        settleMandatoryRaster,
        notifyRenderStateChanged: vi.fn(),
        scale: {
            effectiveScale,
            computeFitWidthScale: vi.fn(),
            scaledMargin: ref(20),
        },
        transactionController: {
            activeTransaction: ref(null),
            beginTransaction: vi.fn(() => ({id: 1})),
            isTransactionCurrent: vi.fn(() => true),
            advanceTransaction: vi.fn(),
            cancelActiveTransaction: vi.fn(),
        },
        scroll: {
            getVisiblePageRange: vi.fn(() => ({
                start: 3,
                end: 3,
            })),
            updateVisibleRange: vi.fn(),
            getMostVisiblePage: vi.fn(() => 3),
        },
        singlePageScroll: {
            scrollToPage: vi.fn(),
            beginSearchNavigation: vi.fn(),
            revealSearchNavigationTarget: vi.fn(),
            endSearchNavigation: vi.fn(),
            navigationAnchorPage: ref(null),
            pagedNavigationTargetPage: ref(null),
            resetContinuousScrollState: vi.fn(),
            cancelDestinationNavigationTarget: vi.fn(),
            submitViewportStateIntent: vi.fn(),
            commitCurrentViewportIfSettled: vi.fn((pageNumber: number) => {
                if (!openSurface) {
                    return false;
                }
                const snapshot = openSurface.snapshot.value;
                const viewportIntentId = openSurface.viewportSession.value.viewportIntent?.id;
                if (snapshot.identity === null || viewportIntentId === undefined) {
                    return false;
                }
                return openSurface.commitViewport({
                    generation: snapshot.generation,
                    documentRevision: snapshot.identity.documentRevision,
                    viewportIntentId,
                    documentGeometryRevision: 1,
                    interactionEpoch: 0,
                    pageNumber,
                    left: 0,
                    top: 0,
                });
            }),
        },
        openVirtualSurfaceGeometry: {openingVirtualExtentMinimumScrollHeight: ref<number | null>(null)},
        summarizeViewerMetricsForLog: vi.fn(),
        summarizeVisiblePageSnapshotForLog: vi.fn(),
        syncCurrentPageFromViewport: vi.fn(async () => undefined),
        getVisibleRange: vi.fn(() => ({
            start: 3,
            end: 3,
        })),
        commitVisibleRange: vi.fn(),
        setupPagePlaceholders: vi.fn(),
        viewModel: {syncHorizontalScrollForZoomMode: vi.fn()},
        viewportWritePort: {},
        handleResizeTransitionSignal: vi.fn(),
        isVisibleRenderRangeCurrent: vi.fn(() => true),
        getProtectedVisibleRange: vi.fn(() => ({
            start: 3,
            end: 3,
        })),
    };
    const renderTasks: Array<{
        cancel: ReturnType<typeof vi.fn>;
        resolve: () => void;
        reject: (error: unknown) => void;
    }> = [];
    const pdfPage = {
        pageNumber: 3,
        getViewport: vi.fn(({scale}: {scale: number}) => ({
            width: 100 * scale,
            height: 120 * scale,
            userUnit: 1,
            rawDims: {
                pageWidth: 100,
                pageHeight: 120,
            },
        })),
        render: vi.fn(() => {
            const deferred = Promise.withResolvers<undefined>();
            const cancel = vi.fn(() => deferred.reject(Object.assign(
                new Error('cancelled'),
                {name: 'RenderingCancelledException'},
            )));
            renderTasks.push({
                cancel,
                resolve: () => deferred.resolve(undefined),
                reject: deferred.reject,
            });
            if (fixtureOptions.autoResolve !== false) {
                deferred.resolve(undefined);
            }
            return {
                cancel,
                promise: deferred.promise,
            };
        }),
    };
    const pdfDocument = {numPages: 5};
    let currentDocumentLoadToken = 7;
    const leasePage = vi.fn(async (pageNumber: number) => ({
        page: pageNumber === 3 ? pdfPage : {
            ...pdfPage,
            pageNumber,
        },
        release: vi.fn(),
    }));
    const rasterScheduler = createPdfPageRasterScheduler({
        documentFence: {
            loadToken: 7,
            documentVersion: 9,
            documentRevision: 'revision-7',
        },
        leasePage: leasePage as never,
    });
    const documentSession = {
        pdfDocument: shallowRef(pdfDocument),
        acceptedSource: shallowRef(new Blob(['pdf'], {type: 'application/pdf'})),
        isLoading: ref(false),
        numPages: ref(5),
        basePageWidth: ref(100),
        basePageHeight: ref(120),
        pageMetrics: ref(Array.from({length: 5}, () => ({
            width: 100,
            height: 120,
            rotation: 0,
            userUnit: 1,
        }))),
        rasterScheduler,
        openSurfaceGeneration: 11,
        openSurfaceRevision: 'revision-7',
        getRenderVersion: () => 9,
        captureFence: () => ({
            ...createTransition('ready').fence,
            loadToken: currentDocumentLoadToken,
        }),
        isCurrent: vi.fn((fence: IPdfDocumentTransition['fence']) => (
            fence.loadToken === currentDocumentLoadToken
            && fence.documentVersion === 9
            && fence.documentRevision === 'revision-7'
            && fence.openSurfaceGeneration === 11
        )),
        ensurePageMetricsInRange: vi.fn(async () => true),
        leasePage,
        evictPage: vi.fn(),
        cleanupPageCache: vi.fn(),
        invalidatePagesOnNextReload: vi.fn(),
        scheduleLoad: vi.fn(),
        subscribe(callback: (transition: IPdfDocumentTransition) => void | Promise<void>) {
            subscribers.push(callback);
            return () => undefined;
        },
        registerDisposable(dispose: () => void | Promise<void>) {
            disposables.push(dispose);
        },
    };
    const viewerElement = document.createElement('div');
    viewerElement.getBoundingClientRect = vi.fn(() => cast<DOMRect>({
        top: 0,
        right: 1000,
        bottom: 800,
        left: 0,
        width: 1000,
        height: 800,
    }));
    const viewerContainer = ref<HTMLElement | null>(viewerElement);
    const outputScale = ref(1);
    const canvasHosts = new Map<number, HTMLElement>();
    for (const pageNumber of [
        3,
        4,
        5,
    ]) {
        const page = document.createElement('div');
        page.className = 'page_container';
        page.dataset.page = String(pageNumber);
        page.getBoundingClientRect = vi.fn(() => cast<DOMRect>({
            width: 100,
            height: 120,
        }));
        const canvasSurface = document.createElement('div');
        canvasSurface.className = 'page_canvas';
        const canvasHost = document.createElement('div');
        canvasHost.className = 'page_canvas__render-layer';
        canvasHosts.set(pageNumber, canvasHost);
        canvasSurface.append(canvasHost);
        page.append(
            canvasSurface,
            Object.assign(document.createElement('div'), {className: 'text-layer'}),
            Object.assign(document.createElement('div'), {className: 'annotation-layer'}),
            Object.assign(document.createElement('div'), {className: 'annotation-editor-layer'}),
        );
        viewerElement.append(page);
    }
    const canvasHost = canvasHosts.get(3)!;
    document.body.append(viewerElement);
    canvasFixture.prepare.mockImplementation(async (
        pageProxy: typeof pdfPage,
        scale: number,
        renderOptions: {contentIntent?: string},
    ) => {
        const canvas = document.createElement('canvas');
        canvas.width = 100;
        canvas.height = 120;
        canvas.getBoundingClientRect = vi.fn(() => cast<DOMRect>({
            top: 0,
            right: 100,
            bottom: 120,
            left: 0,
            width: 100,
            height: 120,
        }));
        const wasClamped = renderOptions.contentIntent === 'canvas-only-buffer'
            && fixtureOptions.clampBufferedPages?.includes(pageProxy.pageNumber) === true;
        return {
            canvas,
            viewport: pageProxy.getViewport({scale}),
            annotationCanvasMap: new Map(),
            scaleX: 1,
            scaleY: 1,
            rawDims: {
                pageWidth: 100,
                pageHeight: 120,
            },
            requestedPixels: 12_000,
            grantedPixels: 12_000,
            pixelScaleFactor: 1,
            wasClamped,
            userUnit: 1,
            totalScaleFactor: scale,
            startRender: () => pageProxy.render(),
        };
    });
    const emitInitialVisualReady = vi.fn();
    const chassisAuthority = openSurface
        ? cast<IDocumentViewerChassisAuthority>({openSurface})
        : null;
    let rendering: ReturnType<typeof createPdfRenderingSession> | undefined;
    const root = document.createElement('div');
    const app = createApp(defineComponent({
        name: 'PdfRenderingSessionBehaviorFixture',
        setup() {
            rendering = createPdfRenderingSession({
                document: documentSession as never,
                viewport: viewport as never,
                chassisAuthority,
                openSurfaceRenderOwner: openSurface?.claimRenderOwner(),
                performancePolicy: {clampedVisibleRefineMode: 'immediate'} as never,
                viewerContainer,
                isActive: computed(() => true),
                isResizing: computed(() => false),
                isAnySaving: computed(() => false),
                zoom: computed(() => 1),
                zoomMode: computed(() => 'fit-width'),
                fitMode: computed(() => 'width'),
                viewMode: computed(() => 'single'),
                continuousScroll: computed(() => true),
                outputScale,
                rasterDisplayProfile: computed(() => null),
                bufferPages: computed(() => fixtureOptions.bufferPages ?? 0),
                showAnnotations: computed(() => true),
                searchPageMatches: computed(() => new Map()),
                currentSearchMatch: computed(() => null),
                currentSearchMatchNavigationId: computed(() => 0),
                workingCopyPath: computed(() => null),
                documentRevisionToken: computed(() => null),
                maxBufferCanvasPixels: 1_000,
                consumeZoomViewportAnchor: () => null,
                isZoomInteractionLocked: () => false,
                setZoomRerenderBusy: vi.fn(),
                markDelayedSkeletonPageRendered: vi.fn(),
                emitInitialVisualReady,
                emitLoadError: vi.fn(),
            });
            return () => null;
        },
    }));
    app.mount(root);
    if (!rendering) {
        throw new Error('Failed to create PDF rendering session fixture');
    }
    return {
        app,
        beginLayoutGeometryReplacement,
        demand,
        disposables,
        emitInitialVisualReady,
        effectiveScale,
        navigationCommittedSignal,
        openSurface,
        rendering,
        renderTasks,
        rasterScheduler,
        documentSession,
        pdfPage,
        canvasHost,
        outputScale,
        settleMandatoryRaster,
        subscribers,
        userPhysicalNavigationEpoch,
        viewerContainer,
        replaceDocument() {
            currentDocumentLoadToken += 1;
            documentSession.pdfDocument.value = {numPages: 5};
        },
        async emit(transition: IPdfDocumentTransition) {
            for (const subscriber of subscribers) {
                await subscriber(transition);
            }
        },
        async dispose() {
            for (const dispose of disposables.reverse()) {
                await dispose();
            }
            await rasterScheduler.dispose();
            app.unmount();
            viewerContainer.value?.remove();
        },
    };
}

describe('PdfRenderingSession behavior', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        rendererFixture.options = null;
        rerenderCoordinatorFixture.options = null;
        rendererFixture.api.resolveLayerPromotionDemand.mockReturnValue(null);
        rendererFixture.api.renderLayerPromotions.mockResolvedValue(undefined);
        rendererFixture.api.renderCommittedPageLayers.mockImplementation(async (commit: {
            pageNumber: number;
            requestId: number;
            version: number;
        }) => {
            const state = rendererFixture.options?.pageRenderState as {completeRender: (page: number, version: number, requestId: number) => boolean;};
            state.completeRender(commit.pageNumber, commit.version, commit.requestId);
        });
        canvasFixture.mount.mockImplementation((
            host: HTMLElement,
            canvas: HTMLCanvasElement,
            previous?: HTMLCanvasElement,
        ) => {
            if (previous?.parentElement === host) {
                previous.replaceWith(canvas);
            } else {
                host.prepend(canvas);
            }
        });
        canvasFixture.cleanup.mockImplementation((canvas: HTMLCanvasElement) => {
            canvas.width = 0;
            canvas.height = 0;
            canvas.remove();
        });
    });

    it('gives the rerender coordinator the viewport physical navigation epoch and layout window', async () => {
        const fixture = createRenderingFixture();

        const options = rerenderCoordinatorFixture.options as {
            getUserPhysicalNavigationEpoch?: () => number;
            beginLayoutGeometryReplacement?: unknown;
        } | null;
        // Reading the epoch through the coordinator's own getter proves it is
        // bound to the physical counter rather than to the interaction epoch a
        // fit change advances itself, which would make every fit re-anchor
        // cancel itself.
        fixture.userPhysicalNavigationEpoch.value = 42;
        expect(options?.getUserPhysicalNavigationEpoch?.()).toBe(42);
        expect(options?.beginLayoutGeometryReplacement).toBe(fixture.beginLayoutGeometryReplacement);

        await fixture.dispose();
    });

    it('adopts a resident page when a host open generation starts after the canvas painted', async () => {
        const fixture = createRenderingFixture({withChassisAuthority: true});
        try {
            await fixture.rendering.renderVisiblePages({
                start: 3,
                end: 3,
            });
            expect(fixture.canvasHost.querySelector('canvas')).not.toBeNull();

            const generation = fixture.openSurface!.begin({
                documentId: 'saved-result.pdf',
                documentRevision: 'open-intent:1',
            }, null, 3);
            fixture.openSurface!.metadataReady(5);

            await vi.waitFor(() => expect(fixture.openSurface!.snapshot.value).toMatchObject({
                generation,
                phase: 'ready',
                presentation: 'committed',
                geometry: {
                    width: 100,
                    height: 120,
                    margin: 20,
                },
                committedRender: {pageNumber: 3},
                committedViewport: {pageNumber: 3},
            }));
            expect(fixture.emitInitialVisualReady).toHaveBeenCalledExactlyOnceWith({pageNumber: 3});
        } finally {
            await fixture.dispose();
        }
    });

    it('publishes queued work once, starts the actual RenderTask, and commits canvas before layers', async () => {
        const fixture = createRenderingFixture({autoResolve: false});
        try {
            await vi.waitFor(() => expect(fixture.pdfPage.render).toHaveBeenCalledOnce());
            expect(canvasFixture.prepare).toHaveBeenCalledWith(
                fixture.pdfPage,
                expect.any(Number),
                expect.objectContaining({pageRenderCoordination: expect.objectContaining({signal: expect.any(AbortSignal)})}),
            );
            expect(fixture.canvasHost.querySelector('canvas')).toBeNull();
            expect(rendererFixture.api.renderCommittedPageLayers).not.toHaveBeenCalled();

            fixture.renderTasks[0]!.resolve();
            await vi.waitFor(() => expect(fixture.canvasHost.querySelector('canvas')).not.toBeNull());

            expect(fixture.canvasHost.querySelector('canvas')).not.toBeNull();
            expect(rendererFixture.api.renderCommittedPageLayers).toHaveBeenCalledOnce();
        } finally {
            await fixture.dispose();
        }
    });

    it('does not restart or invalidate matching in-flight demand', async () => {
        const fixture = createRenderingFixture({autoResolve: false});
        const invalidate = vi.spyOn(fixture.rasterScheduler, 'invalidate');
        try {
            await vi.waitFor(() => expect(fixture.pdfPage.render).toHaveBeenCalledOnce());
            fixture.demand.value = {
                ...fixture.demand.value,
                revision: 2,
                mandatoryRaster: null,
            };
            await new Promise(resolve => requestAnimationFrame(() => resolve(undefined)));

            expect(fixture.pdfPage.render).toHaveBeenCalledOnce();
            expect(invalidate).not.toHaveBeenCalled();
            fixture.renderTasks[0]!.resolve();
        } finally {
            await fixture.dispose();
        }
    });

    it('keeps the resident canvas visible until a stale-scale replacement swaps atomically', async () => {
        const fixture = createRenderingFixture({autoResolve: false});
        try {
            await vi.waitFor(() => expect(fixture.renderTasks).toHaveLength(1));
            fixture.renderTasks[0]!.resolve();
            await vi.waitFor(() => expect(fixture.canvasHost.querySelector('canvas')).not.toBeNull());
            const resident = fixture.canvasHost.querySelector('canvas');
            expect(fixture.rendering.isPageRenderedForClass(3)).toBe(true);
            expect(fixture.rendering.isPageVisualReady(3)).toBe(true);

            fixture.outputScale.value = 2;
            await vi.waitFor(() => expect(fixture.renderTasks).toHaveLength(2));
            expect(fixture.canvasHost.querySelector('canvas')).toBe(resident);
            expect(fixture.rendering.isPageRenderedForClass(3)).toBe(true);
            expect(fixture.rendering.isPageVisualReady(3)).toBe(false);

            fixture.renderTasks[1]!.resolve();
            await vi.waitFor(() => expect(fixture.canvasHost.querySelector('canvas')).not.toBe(resident));
            expect(resident?.isConnected).toBe(false);
            expect(fixture.rendering.isPageRenderedForClass(3)).toBe(true);
            expect(fixture.rendering.isPageVisualReady(3)).toBe(true);
        } finally {
            await fixture.dispose();
        }
    });

    it('coalesces rapid visible-page scale demand to the latest effective scale', async () => {
        const fixture = createRenderingFixture({autoResolve: false});
        try {
            await vi.waitFor(() => expect(fixture.renderTasks).toHaveLength(1));
            fixture.renderTasks[0]!.resolve();
            await vi.waitFor(() => expect(fixture.rendering.isPageVisualReady(3)).toBe(true));
            const resident = fixture.canvasHost.querySelector('canvas');
            fixture.demand.value = {
                ...fixture.demand.value,
                revision: 2,
                mandatoryRaster: null,
            };

            fixture.effectiveScale.value = 3.02;
            fixture.demand.value = {
                ...fixture.demand.value,
                revision: 3,
            };
            expect(fixture.rendering.isPageVisualReady(3)).toBe(false);
            expect(fixture.rendering.getCommittedPageScale(3)).toBe(1);
            fixture.effectiveScale.value = 5.27;
            fixture.demand.value = {
                ...fixture.demand.value,
                revision: 4,
            };

            expect(fixture.rendering.isPageVisualReady(3)).toBe(false);
            expect(fixture.canvasHost.querySelector('canvas')).toBe(resident);
            await vi.waitFor(() => expect(fixture.renderTasks).toHaveLength(2));
            expect(canvasFixture.prepare).toHaveBeenLastCalledWith(
                expect.anything(),
                5.27,
                expect.anything(),
            );

            fixture.renderTasks[1]!.resolve();
            await vi.waitFor(() => expect(fixture.rendering.isPageVisualReady(3)).toBe(true));
            expect(fixture.rendering.getCommittedPageScale(3)).toBeCloseTo(5.27);
            expect(fixture.canvasHost.querySelector('canvas')).not.toBe(resident);
        } finally {
            await fixture.dispose();
        }
    });

    it('supersedes an in-flight obsolete-scale raster with the latest visible demand', async () => {
        const fixture = createRenderingFixture({autoResolve: false});
        try {
            await vi.waitFor(() => expect(fixture.renderTasks).toHaveLength(1));
            fixture.renderTasks[0]!.resolve();
            await vi.waitFor(() => expect(fixture.rendering.isPageVisualReady(3)).toBe(true));
            fixture.demand.value = {
                ...fixture.demand.value,
                revision: 2,
                mandatoryRaster: null,
            };

            fixture.effectiveScale.value = 3.02;
            fixture.demand.value = {
                ...fixture.demand.value,
                revision: 3,
            };
            await vi.waitFor(() => expect(fixture.renderTasks).toHaveLength(2));

            fixture.effectiveScale.value = 5.27;
            fixture.demand.value = {
                ...fixture.demand.value,
                revision: 4,
            };

            await vi.waitFor(() => expect(fixture.renderTasks[1]!.cancel).toHaveBeenCalledOnce());
            await vi.waitFor(() => expect(fixture.renderTasks).toHaveLength(3));
            expect(canvasFixture.prepare).toHaveBeenLastCalledWith(
                expect.anything(),
                5.27,
                expect.anything(),
            );
            expect(fixture.rendering.isPageVisualReady(3)).toBe(false);

            fixture.renderTasks[2]!.resolve();
            await vi.waitFor(() => expect(fixture.rendering.isPageVisualReady(3)).toBe(true));
            expect(fixture.pdfPage.render).toHaveBeenCalledTimes(3);
        } finally {
            await fixture.dispose();
        }
    });

    it('keeps failed work terminal until an explicit repair', async () => {
        const fixture = createRenderingFixture({autoResolve: false});
        try {
            await vi.waitFor(() => expect(fixture.renderTasks).toHaveLength(1));
            fixture.renderTasks[0]!.reject(new Error('paint failed'));
            await vi.waitFor(() => expect(canvasFixture.cleanupResult).toHaveBeenCalled());
            fixture.demand.value = {
                ...fixture.demand.value,
                revision: 2,
                mandatoryRaster: null,
            };
            await new Promise(resolve => requestAnimationFrame(() => resolve(undefined)));
            expect(fixture.renderTasks).toHaveLength(1);

            const repair = fixture.rendering.renderVisiblePages({
                start: 3,
                end: 3,
            }, {
                forceRerender: true,
                rasterDemandPages: [3],
            });
            await vi.waitFor(() => expect(fixture.renderTasks).toHaveLength(2));
            fixture.renderTasks[1]!.resolve();
            await repair;
            expect(fixture.canvasHost.querySelector('canvas')).not.toBeNull();
        } finally {
            await fixture.dispose();
        }
    });

    it('rejects a stale container commit without exposing its detached canvas', async () => {
        const fixture = createRenderingFixture({autoResolve: false});
        try {
            await vi.waitFor(() => expect(fixture.renderTasks).toHaveLength(1));
            const stalePage = fixture.canvasHost.closest('.page_container')!;
            stalePage.remove();
            fixture.renderTasks[0]!.resolve();
            await vi.waitFor(() => expect(canvasFixture.cleanupResult).toHaveBeenCalled());

            expect(fixture.canvasHost.querySelector('canvas')).toBeNull();
            expect(rendererFixture.api.renderCommittedPageLayers).not.toHaveBeenCalled();
            const renderState = rendererFixture.options?.pageRenderState as TPdfPageRenderState;
            expect(renderState.getSlot(3).job).toBe('idle');
        } finally {
            await fixture.dispose();
        }
    });

    it('rejects a commit when the document scheduler fence is no longer current', async () => {
        const fixture = createRenderingFixture({autoResolve: false});
        const replacementScheduler = createPdfPageRasterScheduler({
            documentFence: {
                loadToken: 8,
                documentVersion: 10,
                documentRevision: 'revision-8',
            },
            leasePage: fixture.documentSession.leasePage as never,
        });
        try {
            await vi.waitFor(() => expect(fixture.renderTasks).toHaveLength(1));
            fixture.documentSession.rasterScheduler = replacementScheduler;
            fixture.renderTasks[0]!.resolve();
            await vi.waitFor(() => expect(canvasFixture.cleanupResult).toHaveBeenCalled());

            expect(fixture.canvasHost.querySelector('canvas')).toBeNull();
            expect(rendererFixture.api.renderCommittedPageLayers).not.toHaveBeenCalled();
        } finally {
            await replacementScheduler.dispose();
            await fixture.dispose();
        }
    });

    it('settles mandatory raster only after the first canvas attempt completes', async () => {
        const fixture = createRenderingFixture({autoResolve: false});
        try {
            await vi.waitFor(() => expect(fixture.renderTasks).toHaveLength(1));
            const pageRendererOptions = rendererFixture.options as {requestSearchPageRaster: () => Promise<void>};
            expect(pageRendererOptions.requestSearchPageRaster).toBeTypeOf('function');
            expect(fixture.settleMandatoryRaster).not.toHaveBeenCalled();

            fixture.renderTasks[0]!.resolve();
            await vi.waitFor(() => expect(fixture.canvasHost.querySelector('canvas')).not.toBeNull());
            await vi.waitFor(() => expect(fixture.settleMandatoryRaster).toHaveBeenCalledWith(1));
        } finally {
            await fixture.dispose();
        }
    });

    it('runs an authoritative mandatory raster as one-shot scheduler work', async () => {
        const fixture = createRenderingFixture({
            autoResolve: false,
            authoritativeRaster: true,
        });
        try {
            await vi.waitFor(() => expect(fixture.renderTasks).toHaveLength(1));
            expect(fixture.rasterScheduler.snapshot().inFlightByLane['navigation-target']).toBe(1);
            expect(fixture.settleMandatoryRaster).not.toHaveBeenCalled();

            fixture.renderTasks[0]!.resolve();
            await vi.waitFor(() => expect(fixture.rendering.isPageVisualReady(3)).toBe(true));
            await vi.waitFor(() => expect(fixture.settleMandatoryRaster).toHaveBeenCalledWith(1));
        } finally {
            await fixture.dispose();
        }
    });

    it('passes text-first priority from mandatory raster demand into committed layers', async () => {
        const fixture = createRenderingFixture({
            authoritativeRaster: true,
            prioritizeTextLayer: true,
        });
        try {
            await vi.waitFor(() => expect(
                rendererFixture.api.renderCommittedPageLayers,
            ).toHaveBeenCalledOnce());
            expect(rendererFixture.api.renderCommittedPageLayers).toHaveBeenCalledWith(
                expect.objectContaining({
                    pageNumber: 3,
                    renderOptions: expect.objectContaining({prioritizeTextLayer: true}),
                }),
            );
            expect(rendererFixture.api.queuePrioritizedTextLayerPromotions).toHaveBeenCalledWith(
                [3],
                expect.objectContaining({prioritizeTextLayer: true}),
            );
            await vi.waitFor(() => expect(fixture.settleMandatoryRaster).toHaveBeenCalledWith(1));
        } finally {
            await fixture.dispose();
        }
    });

    it('promotes an already-current mandatory text target before settling demand', async () => {
        const fixture = createRenderingFixture();
        const promotion = Promise.withResolvers<undefined>();
        try {
            await vi.waitFor(() => expect(fixture.settleMandatoryRaster).toHaveBeenCalledWith(1));
            rendererFixture.api.resolveLayerPromotionDemand.mockReturnValue({
                range: {
                    start: 3,
                    end: 3,
                },
                options: {
                    bufferOverride: 0,
                    contentIntent: 'layers-only-promotion',
                    rasterDemandPages: [3],
                },
            });
            rendererFixture.api.renderLayerPromotions.mockImplementation(() => promotion.promise);
            fixture.demand.value = {
                ...fixture.demand.value,
                revision: 2,
                mandatoryRaster: {
                    id: 2,
                    range: {
                        start: 3,
                        end: 3,
                    },
                    options: {
                        bufferOverride: 0,
                        prioritizeTextLayer: true,
                    },
                },
            };

            await vi.waitFor(() => expect(
                rendererFixture.api.renderLayerPromotions,
            ).toHaveBeenCalledWith(
                {
                    start: 3,
                    end: 3,
                },
                {
                    bufferOverride: 0,
                    contentIntent: 'layers-only-promotion',
                    prioritizeTextLayer: true,
                    rasterDemandPages: [3],
                },
            ));
            expect(rendererFixture.api.resolveLayerPromotionDemand).toHaveBeenCalledWith([3]);
            expect(fixture.settleMandatoryRaster).not.toHaveBeenCalledWith(2);

            promotion.resolve(undefined);
            await vi.waitFor(() => expect(fixture.settleMandatoryRaster).toHaveBeenCalledWith(2));
        } finally {
            promotion.resolve(undefined);
            await fixture.dispose();
        }
    });

    it('joins in-flight target work before settling a superseding mandatory raster', async () => {
        const fixture = createRenderingFixture({autoResolve: false});
        try {
            await vi.waitFor(() => expect(fixture.renderTasks).toHaveLength(1));
            fixture.demand.value = {
                ...fixture.demand.value,
                revision: 2,
                mandatoryRaster: {
                    id: 2,
                    range: {
                        start: 3,
                        end: 3,
                    },
                    options: {
                        authoritativeRaster: true,
                        bufferOverride: 0,
                        preserveInFlightRequiredPages: true,
                    },
                },
            };
            await new Promise(resolve => setTimeout(resolve, 0));

            expect(fixture.renderTasks).toHaveLength(1);
            expect(fixture.settleMandatoryRaster).not.toHaveBeenCalledWith(2);
            fixture.renderTasks[0]!.resolve();
            await vi.waitFor(() => expect(fixture.rendering.isPageVisualReady(3)).toBe(true));
            await vi.waitFor(() => expect(fixture.settleMandatoryRaster).toHaveBeenCalledWith(2));
        } finally {
            await fixture.dispose();
        }
    });

    it('settles mandatory raster without waiting for unrelated resident pages', async () => {
        const fixture = createRenderingFixture({
            autoResolve: false,
            residentPages: [
                3,
                4,
            ],
        });
        try {
            await vi.waitFor(() => expect(fixture.renderTasks).toHaveLength(1));
            expect(fixture.documentSession.leasePage).toHaveBeenCalledWith(3, 'render-cache');
            expect(fixture.documentSession.leasePage).not.toHaveBeenCalledWith(4, 'render-cache');

            fixture.renderTasks[0]!.resolve();
            await vi.waitFor(() => expect(fixture.settleMandatoryRaster).toHaveBeenCalledWith(1));
            fixture.demand.value = {
                ...fixture.demand.value,
                revision: 2,
                mandatoryRaster: null,
            };
            await vi.waitFor(() => expect(fixture.documentSession.leasePage).toHaveBeenCalledWith(4, 'render-cache'));
        } finally {
            await fixture.dispose();
        }
    });

    it('starts superseding mandatory demand on a host task without waiting for a frame', async () => {
        const fixture = createRenderingFixture();
        const requestAnimationFrameSpy = vi.spyOn(window, 'requestAnimationFrame');
        const cancelAnimationFrameSpy = vi.spyOn(window, 'cancelAnimationFrame');
        try {
            await vi.waitFor(() => expect(fixture.settleMandatoryRaster).toHaveBeenCalledWith(1));
            requestAnimationFrameSpy.mockImplementation(() => 42);
            fixture.demand.value = {
                ...fixture.demand.value,
                revision: 2,
                mandatoryRaster: null,
            };
            expect(requestAnimationFrameSpy).toHaveBeenCalled();
            fixture.documentSession.ensurePageMetricsInRange.mockClear();

            fixture.demand.value = {
                ...fixture.demand.value,
                revision: 3,
                mandatoryRaster: {
                    id: 2,
                    range: {
                        start: 3,
                        end: 3,
                    },
                    options: {bufferOverride: 0},
                },
            };

            expect(cancelAnimationFrameSpy).toHaveBeenCalledWith(42);
            expect(fixture.documentSession.ensurePageMetricsInRange).not.toHaveBeenCalled();
            await vi.waitFor(() => expect(
                fixture.documentSession.ensurePageMetricsInRange,
            ).toHaveBeenCalledOnce());
            await vi.waitFor(() => expect(fixture.settleMandatoryRaster).toHaveBeenCalledWith(2));
        } finally {
            cancelAnimationFrameSpy.mockRestore();
            requestAnimationFrameSpy.mockRestore();
            await fixture.dispose();
        }
    });

    it('cancels a queued mandatory-demand task when the session is disposed', async () => {
        const fixture = createRenderingFixture();
        await vi.waitFor(() => expect(fixture.settleMandatoryRaster).toHaveBeenCalledWith(1));
        fixture.documentSession.ensurePageMetricsInRange.mockClear();

        fixture.demand.value = {
            ...fixture.demand.value,
            revision: 2,
            mandatoryRaster: {
                id: 2,
                range: {
                    start: 3,
                    end: 3,
                },
                options: {bufferOverride: 0},
            },
        };
        await fixture.dispose();
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(fixture.documentSession.ensurePageMetricsInRange).not.toHaveBeenCalled();
    });

    it('shares the exact in-flight job across overlapping same-key direct requests', async () => {
        const fixture = createRenderingFixture({autoResolve: false});
        try {
            const first = fixture.rendering.renderVisiblePages({
                start: 3,
                end: 3,
            }, {bufferOverride: 0});
            const second = fixture.rendering.renderVisiblePages({
                start: 3,
                end: 3,
            }, {bufferOverride: 0});

            await vi.waitFor(() => expect(fixture.renderTasks).toHaveLength(1));
            fixture.renderTasks[0]!.resolve();
            await Promise.all([
                first,
                second,
            ]);

            expect(fixture.pdfPage.render).toHaveBeenCalledOnce();
            expect(fixture.canvasHost.querySelector('canvas')).not.toBeNull();
            expect(canvasFixture.cleanupResult).not.toHaveBeenCalled();
        } finally {
            await fixture.dispose();
        }
    });

    it('publishes a resident shift when the newly required raster is already current', async () => {
        const fixture = createRenderingFixture({
            autoResolve: false,
            bufferPages: 1,
        });
        const residentPages = () => fixture.rasterScheduler.snapshot().residentPages
            .map(resident => resident.pageNumber)
            .sort((left, right) => left - right);
        try {
            await vi.waitFor(() => expect(fixture.renderTasks).toHaveLength(1));
            fixture.renderTasks[0]!.resolve();
            await vi.waitFor(() => expect(residentPages()).toEqual([3]));

            fixture.demand.value = {
                ...fixture.demand.value,
                revision: 2,
                nearbyPages: [4],
                residentPages: [
                    3,
                    4,
                ],
                mountedPages: [
                    3,
                    4,
                ],
                mandatoryRaster: null,
            };
            await vi.waitFor(() => expect(fixture.renderTasks).toHaveLength(2));
            fixture.renderTasks[1]!.resolve();
            await vi.waitFor(() => expect(residentPages()).toEqual([
                3,
                4,
            ]));

            fixture.demand.value = {
                ...fixture.demand.value,
                revision: 3,
                visibleRange: {
                    start: 4,
                    end: 4,
                },
                requiredPages: [4],
                nearbyPages: [5],
                residentPages: [
                    4,
                    5,
                ],
                mountedPages: [
                    4,
                    5,
                ],
                currentPage: 4,
            };
            await vi.waitFor(() => expect(fixture.renderTasks).toHaveLength(3));
            fixture.renderTasks[2]!.resolve();
            await vi.waitFor(() => expect(residentPages()).toEqual([
                4,
                5,
            ]));

            expect(fixture.canvasHost.querySelector('canvas')).toBeNull();
            expect(fixture.rasterScheduler.snapshot().residentPages)
                .toContainEqual(expect.objectContaining({
                    lane: 'viewport-visible',
                    pageNumber: 4,
                }));
        } finally {
            await fixture.dispose();
        }
    });

    it('omits resident siblings only from explicit visible-only raster passes', async () => {
        const fixture = createRenderingFixture();
        const requestAnimationFrameSpy = vi.spyOn(window, 'requestAnimationFrame');
        const setDemandSpy = vi.spyOn(fixture.rasterScheduler, 'setDemand');
        const frameCallbacks: FrameRequestCallback[] = [];
        const submittedPages = () => {
            const request = setDemandSpy.mock.calls.at(-1)?.[0] as {input: Array<{pageNumber: number}>} | undefined;
            return request?.input.map(demand => demand.pageNumber).sort((left, right) => left - right);
        };
        try {
            await vi.waitFor(() => expect(fixture.settleMandatoryRaster).toHaveBeenCalledWith(1));
            requestAnimationFrameSpy.mockImplementation((callback) => {
                frameCallbacks.push(callback);
                return frameCallbacks.length;
            });
            fixture.demand.value = {
                ...fixture.demand.value,
                revision: 2,
                nearbyPages: [4],
                residentPages: [
                    3,
                    4,
                ],
                mountedPages: [
                    3,
                    4,
                ],
                mandatoryRaster: null,
            };

            frameCallbacks.shift()?.(performance.now());
            await vi.waitFor(() => expect(submittedPages()).toEqual([
                3,
                4,
            ]));

            fixture.effectiveScale.value = 5;
            fixture.demand.value = {
                ...fixture.demand.value,
                revision: 3,
            };
            setDemandSpy.mockClear();
            frameCallbacks.shift()?.(performance.now());
            await vi.waitFor(() => expect(submittedPages()).toEqual([3]));
            await vi.waitFor(() => expect(fixture.rendering.isPageVisualReady(3)).toBe(true));

            setDemandSpy.mockClear();
            const queuedFrames = frameCallbacks.splice(0);
            queuedFrames.forEach(callback => callback(performance.now()));
            if (queuedFrames.length > 0) {
                await vi.waitFor(() => expect(setDemandSpy).toHaveBeenCalled());
            }
            setDemandSpy.mockClear();
            await fixture.rendering.reRenderAllVisiblePages(() => ({
                start: 3,
                end: 3,
            }), {renderBufferOverride: 0});
            expect(submittedPages()).toEqual([3]);

            setDemandSpy.mockClear();
            frameCallbacks.shift()?.(performance.now());
            await vi.waitFor(() => expect(submittedPages()).toEqual([
                3,
                4,
            ]));

            setDemandSpy.mockClear();
            await fixture.rendering.renderVisiblePages({
                start: 3,
                end: 3,
            }, {bufferOverride: 0});
            expect(submittedPages()).toEqual([
                3,
                4,
            ]);
        } finally {
            setDemandSpy.mockRestore();
            requestAnimationFrameSpy.mockRestore();
            await fixture.dispose();
        }
    });

    it('keeps complete residency while immediately refining a promoted clamped buffer', async () => {
        const fixture = createRenderingFixture({
            autoResolve: false,
            bufferPages: 1,
            clampBufferedPages: [4],
        });
        const residentPages = () => fixture.rasterScheduler.snapshot().residentPages
            .map(resident => resident.pageNumber)
            .sort((left, right) => left - right);
        try {
            await vi.waitFor(() => expect(fixture.renderTasks).toHaveLength(1));
            fixture.renderTasks[0]!.resolve();
            fixture.demand.value = {
                ...fixture.demand.value,
                revision: 2,
                nearbyPages: [4],
                residentPages: [
                    3,
                    4,
                ],
                mountedPages: [
                    3,
                    4,
                ],
                mandatoryRaster: null,
            };
            await vi.waitFor(() => expect(fixture.renderTasks).toHaveLength(2));
            fixture.renderTasks[1]!.resolve();
            await vi.waitFor(() => expect(residentPages()).toEqual([
                3,
                4,
            ]));

            fixture.demand.value = {
                ...fixture.demand.value,
                revision: 3,
                visibleRange: {
                    start: 4,
                    end: 4,
                },
                requiredPages: [4],
                nearbyPages: [5],
                residentPages: [
                    4,
                    5,
                ],
                mountedPages: [
                    4,
                    5,
                ],
                currentPage: 4,
            };
            await vi.waitFor(() => expect(fixture.renderTasks).toHaveLength(4));
            fixture.renderTasks[2]!.resolve();
            fixture.renderTasks[3]!.resolve();
            await vi.waitFor(() => expect(residentPages()).toEqual([
                4,
                5,
            ]));

            const renderState = rendererFixture.options?.pageRenderState as TPdfPageRenderState;
            expect(renderState.getSlot(4).committedRasterQuality?.wasClamped).toBe(false);
            expect(fixture.rasterScheduler.snapshot().residentPages)
                .toContainEqual(expect.objectContaining({
                    lane: 'viewport-visible',
                    pageNumber: 4,
                }));

            const requestSearchPageRaster = rendererFixture.options?.requestSearchPageRaster as (
                pageNumber: number,
            ) => Promise<void>;
            await requestSearchPageRaster(4);
            expect(residentPages()).toEqual([
                4,
                5,
            ]);

            fixture.viewerContainer.value?.querySelector(
                '.page_container[data-page="4"] .page_canvas canvas',
            )?.remove();
            const repair = fixture.rendering.renderVisiblePages({
                start: 4,
                end: 4,
            }, {
                forceRerender: true,
                rasterDemandPages: [4],
            });
            await vi.waitFor(() => expect(fixture.renderTasks).toHaveLength(5));
            fixture.renderTasks[4]!.resolve();
            await repair;
            expect(residentPages()).toEqual([
                4,
                5,
            ]);
        } finally {
            await fixture.dispose();
        }
    });

    it('schedules a new render key when authoritative demand supersedes in-flight buffer work', async () => {
        const fixture = createRenderingFixture({
            autoResolve: false,
            bufferPages: 1,
        });
        try {
            await vi.waitFor(() => expect(fixture.renderTasks).toHaveLength(1));
            fixture.renderTasks[0]!.resolve();

            fixture.demand.value = {
                ...fixture.demand.value,
                revision: 2,
                nearbyPages: [4],
                residentPages: [
                    3,
                    4,
                ],
                mountedPages: [
                    3,
                    4,
                ],
                mandatoryRaster: null,
            };
            await vi.waitFor(() => expect(fixture.renderTasks).toHaveLength(2));

            fixture.demand.value = {
                ...fixture.demand.value,
                revision: 3,
                visibleRange: {
                    start: 4,
                    end: 4,
                },
                requiredPages: [4],
                nearbyPages: [5],
                residentPages: [
                    4,
                    5,
                ],
                mountedPages: [
                    4,
                    5,
                ],
                currentPage: 4,
            };
            await vi.waitFor(() => expect(fixture.renderTasks[1]!.cancel).toHaveBeenCalledOnce());
            await vi.waitFor(() => expect(fixture.renderTasks).toHaveLength(4));
            fixture.renderTasks[2]!.resolve();
            fixture.renderTasks[3]!.resolve();
            await vi.waitFor(() => expect(fixture.rasterScheduler.snapshot().residentPages
                .map(resident => resident.pageNumber)
                .sort((left, right) => left - right)).toEqual([
                4,
                5,
            ]));
            expect(fixture.viewerContainer.value?.querySelector(
                '.page_container[data-page="4"] .page_canvas canvas',
            )).not.toBeNull();
        } finally {
            await fixture.dispose();
        }
    });

    it('invalidates resident raster identity on unmount and renders the same key after remount', async () => {
        const fixture = createRenderingFixture({autoResolve: false});
        try {
            await vi.waitFor(() => expect(fixture.renderTasks).toHaveLength(1));
            fixture.renderTasks[0]!.resolve();
            await vi.waitFor(() => expect(fixture.canvasHost.querySelector('canvas')).not.toBeNull());
            expect(fixture.rasterScheduler.snapshot().residentPages).toHaveLength(1);

            fixture.rendering.releaseUnmountedPage(3);
            expect(fixture.rasterScheduler.snapshot().residentPages).toHaveLength(0);
            expect(fixture.canvasHost.querySelector('canvas')).toBeNull();
            expect(rendererFixture.api.releasePageLayers).toHaveBeenCalledWith(3);

            const remount = fixture.rendering.renderVisiblePages({
                start: 3,
                end: 3,
            }, {bufferOverride: 0});
            await vi.waitFor(() => expect(fixture.renderTasks).toHaveLength(2));
            fixture.renderTasks[1]!.resolve();
            await remount;

            expect(fixture.canvasHost.querySelector('canvas')).not.toBeNull();
            expect(fixture.pdfPage.render).toHaveBeenCalledTimes(2);
        } finally {
            await fixture.dispose();
        }
    });

    it('repairs a tracked page whose mounted canvas disappeared', async () => {
        const fixture = createRenderingFixture({autoResolve: false});
        try {
            await vi.waitFor(() => expect(fixture.renderTasks).toHaveLength(1));
            fixture.renderTasks[0]!.resolve();
            await vi.waitFor(() => expect(fixture.canvasHost.querySelector('canvas')).not.toBeNull());
            fixture.canvasHost.querySelector('canvas')!.remove();
            fixture.demand.value = {
                ...fixture.demand.value,
                revision: 2,
                mandatoryRaster: null,
            };
            await vi.waitFor(() => expect(fixture.renderTasks).toHaveLength(2));
            fixture.renderTasks[1]!.resolve();
            await vi.waitFor(() => expect(fixture.canvasHost.querySelector('canvas')).not.toBeNull());

            expect(fixture.canvasHost.querySelector('canvas')).not.toBeNull();
            expect(fixture.pdfPage.render).toHaveBeenCalledTimes(2);
        } finally {
            await fixture.dispose();
        }
    });
});
