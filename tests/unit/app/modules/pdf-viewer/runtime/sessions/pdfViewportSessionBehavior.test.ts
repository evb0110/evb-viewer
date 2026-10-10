import type {IPdfDocument} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
// @vitest-environment happy-dom

import { requirePageNumber } from '@contracts/pageNumbers';
import {
    computed,
    createApp,
    defineComponent,
    nextTick,
    ref,
    shallowRef,
    watch,
} from 'vue';
import {
    afterAll,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {yieldToBrowser} from '@app/utils/yieldToBrowser';
import type {
    IPdfDocumentTransition,
    TPdfDocumentView,
} from '@app/modules/pdf-viewer/runtime/sessions/pdfDocumentSession';
import { createPdfViewportSession } from '@app/modules/pdf-viewer/runtime/sessions/createPdfViewportSession';
import { createPdfRenderingSession } from '@app/modules/pdf-viewer/runtime/sessions/createPdfRenderingSession';
import type {
    IPdfPageRasterScheduler,
    IPdfRasterDemand,
    IPdfRasterDemandPolicy,
    IPdfRasterRenderTarget,
    TPdfRasterOutcome,
} from '@app/modules/pdf-viewer/engine/pdf-page-raster-scheduler/pdfPageRasterScheduler';
import { resolvePdfRenderPerformancePolicy } from '@app/modules/pdf-viewer/engine/pdf-render-performance/resolvePdfRenderPerformancePolicy';
import {
    createDocumentOpenSurfaceSession,
    type IDocumentOpenSurfaceSession,
} from '@app/modules/document-viewer/runtime/documentOpenSurfaceSession';
import { createDocumentViewerRuntime } from '@app/modules/document-viewer/runtime/documentViewerRuntime';
import { createPageNavigationRequest } from '@app/modules/document-viewer/navigation/documentNavigationRequest';
import { fenceDocumentViewportPaneRelocationScroll } from '@app/modules/document-viewer/runtime/documentViewportWritePort';
import { createWorkspacePageNavigationFence } from '@app/modules/workspace-shell/viewers/createWorkspacePageNavigationFence';
import { BrowserLogger } from '@app/utils/browserLogger';
import type { IDocumentViewerRuntime } from '@app/modules/document-viewer/runtime/documentViewerRuntime';
import { createPdfOpeningViewportStallDiagnostic } from '@app/modules/pdf-viewer/runtime/viewport/createPdfOpeningViewportStallDiagnostic';
import { createTestPdfViewportWritePort } from '@tests/helpers/createTestPdfViewportWritePort';

// Nuxt supplies these globals when the renderer owns its failure presenter.
vi.stubGlobal('useToast', () => ({add: vi.fn()}));
vi.stubGlobal('useTypedI18n', () => ({t: (key: string) => key}));
afterAll(() => vi.unstubAllGlobals());

vi.mock('@app/utils/browserLogger', () => ({BrowserLogger: {
    diagnostic: vi.fn(),
    diagnosticThrottled: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    warnThrottled: vi.fn(),
    debug: vi.fn(),
}}));

const performancePolicy = resolvePdfRenderPerformancePolicy({
    lowCpu: false,
    lowMemory: false,
});

function defineDimension(element: HTMLElement, property: string, value: number) {
    Object.defineProperty(element, property, {
        configurable: true,
        value,
    });
}

function appendPageBox(
    container: HTMLElement,
    page: number,
    box: {
        height: number;
        left?: number;
        top: number;
        width?: number;
    },
) {
    const element = document.createElement('div');
    element.className = 'page_container';
    element.dataset.page = String(page);
    defineDimension(element, 'offsetTop', box.top);
    defineDimension(element, 'offsetHeight', box.height);
    defineDimension(element, 'offsetLeft', box.left ?? 0);
    defineDimension(element, 'offsetWidth', box.width ?? 600);
    container.append(element);
    return element;
}

function createDocumentFixture(pageCount = 100) {
    const subscribers: Array<(transition: IPdfDocumentTransition) => void | Promise<void>> = [];
    const pageMetrics = ref(Array.from({ length: pageCount }, () => ({
        width: 600,
        height: 900,
    })));
    const pageMetricsVersion = ref(0);
    const document = {numPages: pageCount} as IPdfDocument;
    const loadToken = ref(1);
    const loadedPageMetrics = new Set<number>();
    const fixture = {
        pdfDocument: shallowRef<IPdfDocument | null>(document),
        numPages: ref(pageCount),
        isLoading: ref(false),
        basePageWidth: ref<number | null>(600),
        basePageHeight: ref<number | null>(900),
        pageMetrics,
        pageMetricsVersion,
        acceptedSource: computed(() => new Blob(['pdf'], {type: 'application/pdf'})),
        ensurePageMetricsInRange: vi.fn(async (start: number, end: number) => {
            for (let page = start; page <= end; page += 1) {
                loadedPageMetrics.add(page);
            }
            return true;
        }),
        /** Pages whose metrics the document has read from the PDF. */
        loadedPageMetrics,
        hasExactPageGeometry: vi.fn(() => true),
        captureFence: () => ({
            loadToken: loadToken.value,
            documentVersion: 1,
            documentRevision: 'revision-1',
            openSurfaceGeneration: 1,
        }),
        isCurrent: () => true,
        loadToken,
        getRenderVersion: () => 1,
        subscribe(callback: (transition: IPdfDocumentTransition) => void | Promise<void>) {
            subscribers.push(callback);
            return () => {
                const index = subscribers.indexOf(callback);
                if (index >= 0) {
                    subscribers.splice(index, 1);
                }
            };
        },
        disposers: [] as Array<() => void | Promise<void>>,
        registerDisposable(disposer: () => void | Promise<void>) {
            this.disposers.push(disposer);
        },
        // Read by the rendering session when a fixture attaches one.
        rasterScheduler: null as IPdfPageRasterScheduler | null,
        pendingPageMutationRevisionSwap: null as {
            revision: string;
            invalidatedPages: readonly number[];
            preservePageMetrics: boolean;
        } | null,
        activeLoadPlan: {
            isSelectiveReload: false,
            preserveVisibleContent: false,
        },
        openSurfaceGeneration: 1,
        openSurfaceRevision: 'revision-1',
        evictPage: vi.fn(),
        nextReloadPreservesVisibleContent: false,
        preserveNextReloadVisibleContent(shouldPreserve: boolean) {
            this.nextReloadPreservesVisibleContent = shouldPreserve;
        },
        carryAnchorThroughPageMutation: vi.fn((anchor: unknown) => anchor),
        async emit(transition: IPdfDocumentTransition) {
            for (const subscriber of [...subscribers]) {
                await subscriber(transition);
            }
        },
    };
    // The fixture supplies the document-session methods used by the viewport
    // session while keeping the page-source work out of these behavior tests.
    return fixture as typeof fixture & TPdfDocumentView;
}

function createChassisAuthority(surface: IDocumentOpenSurfaceSession) {
    return createDocumentViewerRuntime(ref('pdf'), 1, surface);
}

function createViewportFixture(input: {
    bufferPages?: number;
    chassisAuthority?: IDocumentViewerRuntime;
    continuousScroll?: boolean;
    fitMode?: Ref<'width' | 'height'>;
    isActive?: Ref<boolean>;
    isResizing?: Ref<boolean>;
    isPageFreshlyRenderedForNavigation?: (pageNumber: number) => boolean;
    onEmitCurrentPage?: (page: number) => void;
    pageCount?: number;
    /** Attaches a rendering session whose rasters go through this scheduler. */
    rasterScheduler?: IPdfPageRasterScheduler;
    viewMode?: 'single' | 'facing' | 'facing-first-single';
    zoom?: Ref<number>;
    zoomMode?: 'custom' | 'fit-width' | 'fit-height';
} = {}) {
    const container = document.createElement('div');
    defineDimension(container, 'clientHeight', 800);
    defineDimension(container, 'clientWidth', 800);
    defineDimension(container, 'scrollHeight', 120_000);
    container.scrollTop = 0;
    const viewerContainer = ref<HTMLElement | null>(container);
    const documentSession = createDocumentFixture(input.pageCount);
    const zoom = input.zoom ?? ref(1);
    const outputScale = ref(1);
    const zoomMode = ref(input.zoomMode ?? 'fit-width');
    const viewMode = ref(input.viewMode ?? 'single');
    const fitMode = input.fitMode ?? ref<'width' | 'height'>('width');
    const isActive = input.isActive ?? ref(true);
    const emittedPages: number[] = [];
    const emitEffectiveZoom = vi.fn();
    const viewportWrites = createTestPdfViewportWritePort();
    const {port} = viewportWrites;
    let viewport: ReturnType<typeof createPdfViewportSession> | undefined;
    const root = document.createElement('div');
    const app = createApp(defineComponent({
        name: 'PdfViewportSessionBehaviorFixture',
        setup() {
            viewport = createPdfViewportSession({
                document: documentSession,
                chassisAuthority: input.chassisAuthority ?? null,
                performancePolicy,
                maxBufferCanvasPixels: 100,
                settledMaxCanvasPixels: 1_000_000,
                viewerContainer,
                viewportWritePort: port,
                zoom: computed(() => zoom.value),
                zoomMode: computed(() => zoomMode.value),
                fitMode: computed(() => fitMode.value),
                viewMode: computed(() => viewMode.value),
                continuousScroll: computed(() => input.continuousScroll ?? true),
                bufferPages: computed(() => input.bufferPages ?? 3),
                isActive: computed(() => isActive.value),
                isResizing: computed(() => input.isResizing?.value ?? false),
                outputScale,
                isPageFreshlyRenderedForNavigation:
                    input.isPageFreshlyRenderedForNavigation ?? (() => true),
                selectionMarkupStyle: computed(() => null),
                classState: {
                    isAnySaving: computed(() => false),
                    isDragging: ref(false),
                    isViewerPanDragModeActive: computed(() => false),
                    isSelectionMarkupToolActive: computed(() => false),
                    isTextSelectionModeActive: computed(() => false),
                    fitMode: computed(() => fitMode.value),
                    zoomMode: computed(() => zoomMode.value),
                },
                emitCurrentPage: page => {
                    emittedPages.push(page);
                    input.onEmitCurrentPage?.(page);
                },
                emitNavigationFeedbackPage: vi.fn(),
                emitZoomState: state => {
                    if (state.kind === 'custom') zoom.value = state.scale;
                },
                emitEffectiveZoom,
                summarizeViewerStateForLog: vi.fn(),
            });
            if (input.rasterScheduler) {
                documentSession.rasterScheduler = input.rasterScheduler;
                createPdfRenderingSession({
                    document: documentSession,
                    viewport,
                    chassisAuthority: null,
                    openSurfaceRenderOwner: undefined,
                    performancePolicy,
                    viewerContainer,
                    isActive: computed(() => isActive.value),
                    isResizing: computed(() => false),
                    viewMode: computed(() => viewMode.value),
                    outputScale,
                    rasterDisplayProfile: computed(() => null),
                    bufferPages: computed(() => input.bufferPages ?? 3),
                    searchPageMatches: computed(() => new Map()),
                    currentSearchMatch: computed(() => null),
                    currentSearchMatchNavigationId: computed(() => 0),
                    workingCopyPath: computed(() => null),
                    documentRevisionToken: computed(() => null),
                    maxBufferCanvasPixels: 100,
                    emitInitialVisualReady: vi.fn(),
                    emitLoadError: vi.fn(),
                });
            }
            return () => null;
        },
    }));
    app.mount(root);
    if (!viewport) {
        throw new Error('Failed to create PDF viewport session fixture');
    }
    return {
        app,
        container,
        // Unmounts and runs what the sessions registered, newest first, as closing the document does.
        async dispose() {
            app.unmount();
            for (const disposer of documentSession.disposers.splice(0).reverse()) {
                await disposer();
            }
        },
        documentSession,
        emitEffectiveZoom,
        emittedPages,
        fitMode,
        isActive,
        outputScale,
        viewport,
        viewportWrites,
        viewMode,
        zoom,
        zoomMode,
    };
}

/** Mounts a page with the raster host the rendering session paints into. */
function appendRasterTarget(container: HTMLElement, page: number) {
    const host = document.createElement('div');
    host.className = 'page_canvas__render-layer';
    appendPageBox(container, page, {
        height: 900,
        top: (page - 1) * 920,
    }).append(host);
}

/** A scheduler whose every raster ends without pixels, as a discarded one does. */
function createDiscardingRasterScheduler() {
    const discard = <TPrepared>(demand: IPdfRasterDemand, target: IPdfRasterRenderTarget<TPrepared>) => {
        target.release(demand.pageNumber, 'raster-not-committed');
    };
    const scheduler: IPdfPageRasterScheduler = {
        documentFence: {
            loadToken: 1,
            documentVersion: 1,
            documentRevision: 'revision-1',
        },
        setDemand: <TInput, TPrepared>(request: {
            input: TInput;
            policy: IPdfRasterDemandPolicy<TInput>;
            target: IPdfRasterRenderTarget<TPrepared>;
        }) => request.policy.expand(request.input).forEach(demand => discard(demand, request.target)),
        request: async <TPrepared>(request: {
            demand: IPdfRasterDemand;
            target: IPdfRasterRenderTarget<TPrepared>;
        }): Promise<TPdfRasterOutcome> => {
            discard(request.demand, request.target);
            return {
                status: 'discarded',
                demand: request.demand,
            };
        },
        invalidate: vi.fn(),
        cancelSource: async () => {},
        releaseSource: async () => {},
        snapshot: () => {
            throw new Error('Not used by these tests');
        },
        dispose: async () => {},
    };
    return scheduler;
}

/** Collects the ids of the mandatory raster requests the viewport publishes. */
function recordMandatoryRasterRequests(viewport: ReturnType<typeof createPdfViewportSession>) {
    const ids = new Set<number>();
    const stop = watch(viewport.demand, (demand) => {
        if (demand.mandatoryRaster) ids.add(demand.mandatoryRaster.id);
    }, {
        flush: 'sync',
        immediate: true,
    });
    return {
        ids,
        stop,
    };
}

function setCurrentPage(
    viewport: ReturnType<typeof createPdfViewportSession>,
    page: number,
) {
    // The user has moved the viewport to the top of this page.
    viewport.singlePageScroll.cancelProgrammaticNavigation('test-user-scroll', {
        affinity: 'start',
        page,
        pageXFraction: 0,
        pageYFraction: 0,
        viewportXFraction: 0,
        viewportYFraction: 0,
    });
}

function transition(
    phase: IPdfDocumentTransition['phase'],
    plan: IPdfDocumentTransition['plan'],
): IPdfDocumentTransition {
    return {
        phase,
        isSameDocumentRewrite: false,
        fence: {
            loadToken: 2,
            documentVersion: 2,
            documentRevision: 'revision-2',
            openSurfaceGeneration: 2,
        },
        plan,
        reason: 'test',
        isCurrent: () => true,
    };
}

describe('PdfViewportSession behavior', () => {
    it('reports an opening viewport stall once after five seconds and resets after cancellation', () => {
        vi.useFakeTimers();
        const warn = vi.mocked(BrowserLogger.warn);
        warn.mockClear();
        const surface = createDocumentOpenSurfaceSession();
        const generation = surface.begin({
            documentId: 'diagnostic-stall.pdf',
            documentRevision: 'revision-1',
        });
        surface.metadataReady(1);
        surface.commitGeometry(generation, {
            width: 600,
            height: 900,
            margin: 20,
        });
        surface.commitCanvas(surface.createRenderFence({
            generation,
            documentRevision: 'revision-1',
            renderVersion: 1,
            requestId: 1,
            pageNumber: 1,
        })!);
        const diagnostic = createPdfOpeningViewportStallDiagnostic({
            captureCommitDiagnostics: () => ({hasContainer: false}),
            getActiveIntent: () => null,
            getAuthorityPhase: () => 'idle',
            getCurrentDocumentRevision: () => 2,
            getLayoutRevision: () => 4,
            getSurface: () => surface,
        });
        try {
            diagnostic.observe('active-current-intent');
            vi.advanceTimersByTime(4_999);
            expect(warn).not.toHaveBeenCalled();

            diagnostic.observe('viewport-commit-rejected');
            vi.advanceTimersByTime(1);
            expect(warn).toHaveBeenCalledTimes(1);
            expect(warn).toHaveBeenLastCalledWith(
                'pdf-viewer',
                'PDF opening viewport reconciliation remained blocked',
                expect.objectContaining({rejectionReason: 'viewport-commit-rejected'}),
            );
            vi.advanceTimersByTime(10_000);
            expect(warn).toHaveBeenCalledTimes(1);

            diagnostic.observe(null);
            diagnostic.observe('active-current-intent');
            diagnostic.cancel();
            vi.advanceTimersByTime(5_000);
            expect(warn).toHaveBeenCalledTimes(1);
        } finally {
            diagnostic.cancel();
            vi.useRealTimers();
        }
    });

    it('publishes visible raster demand synchronously for effective zoom and DPR changes', () => {
        const fixture = createViewportFixture({
            bufferPages: 0,
            continuousScroll: true,
            pageCount: 10,
            zoomMode: 'custom',
        });
        try {
            appendPageBox(fixture.container, 1, {
                height: 900,
                top: 0,
            });
            fixture.viewport.markPageMounted(requirePageNumber(1));
            const initialRevision = fixture.viewport.demand.value.revision;

            fixture.zoom.value = 3.02;
            const zoomRevision = fixture.viewport.demand.value.revision;
            expect(zoomRevision).toBeGreaterThan(initialRevision);
            expect(fixture.viewport.demand.value.requiredPages).toEqual([1]);

            fixture.outputScale.value = 2;
            expect(fixture.viewport.demand.value.revision).toBeGreaterThan(zoomRevision);
            expect(fixture.viewport.demand.value.requiredPages).toEqual([1]);
        } finally {
            fixture.app.unmount();
        }
    });

    it('remeasures continuous facing visibility as newly mounted rows settle without user scroll', async () => {
        const fixture = createViewportFixture({
            bufferPages: 0,
            continuousScroll: true,
            pageCount: 30,
            viewMode: 'facing',
            zoomMode: 'custom',
        });
        try {
            setCurrentPage(fixture.viewport, 9);
            fixture.viewport.visibleRange.value = {
                start: 9,
                end: 10,
            };
            await nextTick();

            const settlingRow: HTMLElement[] = [];
            for (const [
                page,
                top,
            ] of [
                    [
                        9,
                        0,
                    ],
                    [
                        10,
                        0,
                    ],
                    [
                        11,
                        400,
                    ],
                    [
                        12,
                        400,
                    ],
                    [
                        13,
                        810,
                    ],
                    [
                        14,
                        810,
                    ],
                ] as const) {
                const element = appendPageBox(fixture.container, page, {
                    height: 390,
                    top,
                });
                if (page >= 13) {
                    settlingRow.push(element);
                }
                fixture.viewport.markPageMounted(requirePageNumber(page));
            }
            expect(fixture.viewport.visibleRange.value).toEqual({
                start: 9,
                end: 12,
            });
            settlingRow.forEach(element => defineDimension(element, 'offsetTop', 790));
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

            expect(fixture.viewport.visibleRange.value).toEqual({
                start: 9,
                end: 14,
            });
            expect(fixture.viewport.demand.value.visibleRange).toEqual({
                start: 9,
                end: 14,
            });
            expect(fixture.viewport.demand.value.requiredPages).toEqual([
                9,
                10,
                11,
                12,
                13,
                14,
            ]);
        } finally {
            fixture.app.unmount();
        }
    });

    it('orders required and nearby mounted demand within the shared pixel budget', async () => {
        const fixture = createViewportFixture({
            bufferPages: 4,
            continuousScroll: false,
            pageCount: 100,
        });
        try {
            fixture.documentSession.basePageWidth.value = 2;
            fixture.documentSession.basePageHeight.value = 20;
            fixture.documentSession.pageMetrics.value = Array.from({length: 100}, (_, index) => ({
                width: 2,
                height: index === 42 ? 500 : 20,
            }));
            fixture.documentSession.pageMetricsVersion.value += 1;
            setCurrentPage(fixture.viewport, 43);
            fixture.viewport.visibleRange.value = {
                start: 43,
                end: 43,
            };
            for (let page = 39; page <= 47; page += 1) {
                fixture.viewport.markPageMounted(requirePageNumber(page));
            }
            await nextTick();

            expect(fixture.viewport.demand.value.requiredPages).toEqual([43]);
            expect(fixture.viewport.demand.value.nearbyPages).toEqual([
                44,
                42,
            ]);
            expect(fixture.viewport.demand.value.residentPages).toEqual([
                43,
                44,
                42,
            ]);

            fixture.viewport.markPageUnmounted(requirePageNumber(44));
            expect(fixture.viewport.demand.value.residentPages).toEqual([
                43,
                42,
                45,
            ]);
            expect(fixture.viewport.demand.value.residentPages).not.toContain(44);
        } finally {
            fixture.app.unmount();
        }
    });

    it.each([
        'wheel',
        'scroll',
    ] as const)('retains the physical raster until %s supersedes a distant navigation', async (interaction) => {
        const fixture = createViewportFixture({
            bufferPages: 0,
            isPageFreshlyRenderedForNavigation: () => false,
            pageCount: 100,
        });
        try {
            fixture.documentSession.basePageHeight.value = 100;
            fixture.documentSession.pageMetrics.value = Array.from({length: 100}, () => ({
                width: 600,
                height: 100,
            }));
            fixture.documentSession.pageMetricsVersion.value += 1;
            fixture.viewport.visibleRange.value = {
                start: 1,
                end: 1,
            };
            fixture.viewport.markPageMounted(requirePageNumber(1));
            fixture.viewport.markPageMounted(requirePageNumber(64));

            fixture.viewport.handleTrustedScroll({isTrusted: true} as Event);
            expect(fixture.viewport.singlePageScroll.scrollToPage(requirePageNumber(64))).toBe(true);
            await vi.waitFor(() => {
                expect(fixture.viewport.demand.value.requiredPages).toContain(64);
            });
            expect(fixture.viewport.demand.value.residentPages).toEqual(expect.arrayContaining([
                1,
                64,
            ]));
            const cancellationRevision = fixture.viewport.cancelRasterRevision.value;
            if (interaction === 'wheel') {
                fixture.viewport.markUserViewportInteraction();
            } else {
                fixture.container.scrollTop = 200;
                fixture.viewport.handleTrustedScroll({isTrusted: true} as Event);
            }
            expect(fixture.viewport.cancelRasterRevision.value).toBe(cancellationRevision + 1);

        } finally {
            fixture.viewport.singlePageScroll.cancelProgrammaticNavigation('test-cleanup');
            fixture.app.unmount();
        }
    });

    it('keeps a distant navigation alive through the inertial tail of an older fling', async () => {
        const fixture = createViewportFixture({
            bufferPages: 0,
            isPageFreshlyRenderedForNavigation: () => false,
            pageCount: 100,
        });
        try {
            fixture.documentSession.basePageHeight.value = 100;
            fixture.documentSession.pageMetrics.value = Array.from({length: 100}, () => ({
                width: 600,
                height: 100,
            }));
            fixture.documentSession.pageMetricsVersion.value += 1;
            fixture.viewport.visibleRange.value = {
                start: 1,
                end: 1,
            };
            fixture.viewport.markPageMounted(requirePageNumber(1));
            fixture.viewport.markPageMounted(requirePageNumber(64));

            fixture.viewport.handleTrustedScroll({isTrusted: true} as Event);
            expect(fixture.viewport.singlePageScroll.scrollToPage(requirePageNumber(64))).toBe(true);
            // The command declares itself newer than any gesture in flight.
            expect(fixture.viewportWrites.commandFences).toHaveLength(1);
            await vi.waitFor(() => {
                expect(fixture.viewport.demand.value.requiredPages).toContain(64);
            });
            const cancellationRevision = fixture.viewport.cancelRasterRevision.value;

            // The compositor applies one more inertial delta before scroll
            // suppression reaches it.
            fixture.viewportWrites.setCommandResidueLive(true);
            fixture.container.scrollTop = 200;
            fixture.viewport.handleTrustedScroll({isTrusted: true} as Event);

            expect(fixture.viewport.cancelRasterRevision.value).toBe(cancellationRevision);
            expect(fixture.viewport.demand.value.destinationPage).toBe(64);
            expect(fixture.viewport.demand.value.requiredPages).toContain(64);
        } finally {
            fixture.viewport.singlePageScroll.cancelProgrammaticNavigation('test-cleanup');
            fixture.app.unmount();
        }
    });

    it('requests a navigation target again when its raster pass ends without its pixels', async () => {
        const paintedPages = new Set<number>();
        const fixture = createViewportFixture({
            bufferPages: 0,
            isPageFreshlyRenderedForNavigation: page => paintedPages.has(page),
            pageCount: 100,
        });
        const nextMandatoryRaster = async (afterId: number) => {
            let id = 0;
            await vi.waitFor(() => {
                const mandatory = fixture.viewport.demand.value.mandatoryRaster;
                expect(mandatory?.id).toBeGreaterThan(afterId);
                expect(mandatory?.range).toEqual({
                    start: 64,
                    end: 64,
                });
                id = mandatory!.id;
            });
            return id;
        };
        try {
            fixture.viewport.markPageMounted(requirePageNumber(1));
            fixture.viewport.markPageMounted(requirePageNumber(64));
            expect(fixture.viewport.singlePageScroll.scrollToPage(requirePageNumber(64))).toBe(true);

            // The pass discarded its raster: Fit Width moved the scale under it.
            const discardedId = await nextMandatoryRaster(0);
            fixture.viewport.settleMandatoryRaster(discardedId, false);

            const paintedId = await nextMandatoryRaster(discardedId);
            paintedPages.add(64);
            fixture.viewport.settleMandatoryRaster(paintedId, true);
            await vi.waitFor(() => {
                expect(fixture.viewport.currentPage.value).toBe(64);
                expect(fixture.viewport.singlePageScroll.isProgrammaticNavigationActive.value).toBe(false);
            });
            expect(fixture.viewport.demand.value.mandatoryRaster).toBeNull();
        } finally {
            fixture.viewport.singlePageScroll.cancelProgrammaticNavigation('test-cleanup');
            fixture.app.unmount();
        }
    });

    it('keeps asking for a navigation target whose raster was discarded at a stale scale', async () => {
        const fixture = createViewportFixture({
            bufferPages: 0,
            isPageFreshlyRenderedForNavigation: () => false,
            pageCount: 100,
            rasterScheduler: createDiscardingRasterScheduler(),
        });
        appendRasterTarget(fixture.container, 64);
        const requests = recordMandatoryRasterRequests(fixture.viewport);
        try {
            fixture.viewport.markPageMounted(requirePageNumber(1));
            fixture.viewport.markPageMounted(requirePageNumber(64));
            expect(fixture.viewport.singlePageScroll.scrollToPage(requirePageNumber(64))).toBe(true);

            await vi.waitFor(() => expect(requests.ids.size).toBeGreaterThan(1));
            expect(fixture.viewport.singlePageScroll.isProgrammaticNavigationActive.value).toBe(true);
            expect(fixture.viewport.demand.value.destinationPage).toBe(64);
        } finally {
            requests.stop();
            fixture.viewport.singlePageScroll.cancelProgrammaticNavigation('test-cleanup');
            await fixture.dispose();
        }
    });

    it('asks once for a navigation target whose page awaits its rotated revision', async () => {
        const fixture = createViewportFixture({
            bufferPages: 0,
            isPageFreshlyRenderedForNavigation: () => false,
            pageCount: 100,
            rasterScheduler: createDiscardingRasterScheduler(),
        });
        // Page 64 was rotated; its raster waits for the rewritten revision.
        fixture.documentSession.pendingPageMutationRevisionSwap = {
            revision: 'revision-2',
            invalidatedPages: [64],
            preservePageMetrics: true,
        };
        appendRasterTarget(fixture.container, 64);
        const requests = recordMandatoryRasterRequests(fixture.viewport);
        try {
            fixture.viewport.markPageMounted(requirePageNumber(1));
            fixture.viewport.markPageMounted(requirePageNumber(64));
            expect(fixture.viewport.singlePageScroll.scrollToPage(requirePageNumber(64))).toBe(true);

            await vi.waitFor(() => {
                expect(fixture.viewport.currentPage.value).toBe(64);
                expect(fixture.viewport.singlePageScroll.isProgrammaticNavigationActive.value).toBe(false);
            });
            expect(requests.ids.size).toBe(1);
        } finally {
            requests.stop();
            fixture.viewport.singlePageScroll.cancelProgrammaticNavigation('test-cleanup');
            await fixture.dispose();
        }
    });

    it('asks once for a navigation target that has no mounted raster target', async () => {
        const fixture = createViewportFixture({
            bufferPages: 0,
            isPageFreshlyRenderedForNavigation: () => false,
            pageCount: 100,
            rasterScheduler: createDiscardingRasterScheduler(),
        });
        // Page 64 is in the layout, but no page container for it is in the DOM.
        const requests = recordMandatoryRasterRequests(fixture.viewport);
        try {
            fixture.viewport.markPageMounted(requirePageNumber(1));
            fixture.viewport.markPageMounted(requirePageNumber(64));
            expect(fixture.viewport.singlePageScroll.scrollToPage(requirePageNumber(64))).toBe(true);

            await vi.waitFor(() => {
                expect(fixture.viewport.currentPage.value).toBe(64);
                expect(fixture.viewport.singlePageScroll.isProgrammaticNavigationActive.value).toBe(false);
            });
            expect(requests.ids.size).toBe(1);
        } finally {
            requests.stop();
            fixture.viewport.singlePageScroll.cancelProgrammaticNavigation('test-cleanup');
            await fixture.dispose();
        }
    });

    it('recomputes the mounted geometry window from the active scroll offset', async () => {
        const fixture = createViewportFixture({
            bufferPages: 0,
            pageCount: 100,
        });
        try {
            fixture.container.scrollTop = 10_000;
            fixture.viewport.visibleRange.value = {
                start: 1,
                end: 1,
            };
            fixture.documentSession.pageMetricsVersion.value += 1;
            await nextTick();
            const provisionalStart = fixture.viewport.visibleRange.value.start;
            expect(provisionalStart).toBeGreaterThan(1);
            expect(fixture.viewport.viewModel.pagesToRender.value).toContain(provisionalStart);

            fixture.documentSession.basePageHeight.value = 100;
            fixture.documentSession.pageMetrics.value = Array.from({length: 100}, () => ({
                width: 600,
                height: 100,
            }));
            fixture.documentSession.pageMetricsVersion.value += 1;
            await nextTick();

            expect(fixture.viewport.visibleRange.value.start).toBeGreaterThan(provisionalStart);
            expect(fixture.viewport.viewModel.pagesToRender.value)
                .toContain(fixture.viewport.visibleRange.value.start);
            expect(fixture.viewport.viewModel.pagesToRender.value).not.toContain(provisionalStart);
        } finally {
            fixture.app.unmount();
        }
    });

    it('projects trusted native scroll into the visible page and demand', async () => {
        const fixture = createViewportFixture({
            bufferPages: 0,
            pageCount: 100,
        });
        try {
            fixture.documentSession.basePageHeight.value = 100;
            fixture.documentSession.pageMetrics.value = Array.from({length: 100}, () => ({
                width: 600,
                height: 100,
            }));
            fixture.documentSession.pageMetricsVersion.value += 1;
            await nextTick();
            const epoch = fixture.viewport.userViewportInteractionEpoch.value;

            fixture.container.scrollTop = 10_000;
            fixture.viewport.handleTrustedScroll({isTrusted: true} as Event);

            expect(fixture.viewport.userViewportInteractionEpoch.value).toBe(epoch + 1);
            expect(fixture.viewport.currentPage.value).toBeGreaterThan(1);
            expect(fixture.viewport.visibleRange.value.start).toBeGreaterThan(1);
            expect(fixture.emittedPages.at(-1)).toBe(fixture.viewport.currentPage.value);
        } finally {
            fixture.app.unmount();
        }
    });

    it('does not publish a pane-deactivation scroll reset as user navigation', async () => {
        const fixture = createViewportFixture({
            bufferPages: 0,
            pageCount: 100,
        });
        try {
            fixture.documentSession.basePageHeight.value = 100;
            fixture.documentSession.pageMetrics.value = Array.from({length: 100}, () => ({
                width: 600,
                height: 100,
            }));
            fixture.documentSession.pageMetricsVersion.value += 1;
            await nextTick();

            fixture.container.scrollTop = 300;
            fixture.viewport.handleTrustedScroll({isTrusted: true} as Event);
            setCurrentPage(fixture.viewport, 4);
            const interactionEpoch = fixture.viewport.userViewportInteractionEpoch.value;
            const visibleRange = {...fixture.viewport.visibleRange.value};
            expect(fixture.viewport.currentPage.value).toBe(4);

            fixture.isActive.value = false;
            await nextTick();
            fixture.container.scrollTop = 0;
            fenceDocumentViewportPaneRelocationScroll(fixture.container);
            fixture.viewport.handleTrustedScroll({isTrusted: true} as Event);

            expect(fixture.viewport.userViewportInteractionEpoch.value).toBe(interactionEpoch);
            expect(fixture.viewport.currentPage.value).toBe(4);
            expect(fixture.viewport.visibleRange.value).toEqual(visibleRange);
        } finally {
            fixture.app.unmount();
        }
    });

    it('keeps an inactive pane user scroll authoritative after relocation is fenced', async () => {
        const fixture = createViewportFixture({
            bufferPages: 0,
            pageCount: 100,
        });
        try {
            fixture.documentSession.basePageHeight.value = 100;
            fixture.documentSession.pageMetrics.value = Array.from({length: 100}, () => ({
                width: 600,
                height: 100,
            }));
            fixture.documentSession.pageMetricsVersion.value += 1;
            await nextTick();

            fixture.container.scrollTop = 300;
            fixture.viewport.handleTrustedScroll({isTrusted: true} as Event);
            setCurrentPage(fixture.viewport, 4);
            fixture.isActive.value = false;
            await nextTick();
            const interactionEpoch = fixture.viewport.userViewportInteractionEpoch.value;
            expect(fixture.viewport.currentPage.value).toBe(4);

            fixture.container.scrollTop = 700;
            fixture.viewport.handleTrustedScroll({isTrusted: true} as Event);

            expect(fixture.viewport.userViewportInteractionEpoch.value).toBe(interactionEpoch + 1);
            expect(fixture.viewport.currentPage.value).toBeGreaterThan(4);
        } finally {
            fixture.app.unmount();
        }
    });

    it('rebases a continuous scrollbar at the physical segment boundary', async () => {
        const fixture = createViewportFixture({
            pageCount: 20_000,
            zoomMode: 'custom',
        });
        try {
            fixture.documentSession.pageMetrics.value = Array.from({length: 20_000}, () => ({
                width: 600,
                height: 1_000,
            }));
            fixture.documentSession.pageMetricsVersion.value += 1;
            await nextTick();

            fixture.container.scrollTop = 8_388_608 - fixture.container.clientHeight;
            fixture.viewport.handleTrustedScroll({isTrusted: true} as Event);
            await nextTick();

            expect(fixture.viewport.currentPage.value).toBe(8_226);
            expect(fixture.container.scrollTop).toBe(912);
            expect(fixture.viewport.visibleRange.value).toEqual({
                start: 8_226,
                end: 8_226,
            });
        } finally {
            fixture.app.unmount();
        }
    });

    it('observes physical wheel scrolling while a sidebar resize is active', async () => {
        const fixture = createViewportFixture({isResizing: ref(true)});
        try {
            await nextTick();
            fixture.viewport.markUserViewportInteraction();
            const epoch = fixture.viewport.userViewportInteractionEpoch.value;
            fixture.container.scrollTop = 2_000;
            fixture.viewport.handleTrustedScroll({isTrusted: true} as Event);
            expect(fixture.viewport.userViewportInteractionEpoch.value).toBe(epoch + 1);
            expect(fixture.viewport.currentPage.value).toBeGreaterThan(1);
        } finally {
            fixture.app.unmount();
        }
    });

    it('releases a retained navigation row when a direct scroll moves the viewport', async () => {
        const fixture = createViewportFixture({
            bufferPages: 0,
            pageCount: 100,
        });
        try {
            fixture.documentSession.basePageHeight.value = 100;
            fixture.documentSession.pageMetrics.value = Array.from({length: 100}, () => ({
                width: 600,
                height: 100,
            }));
            fixture.documentSession.pageMetricsVersion.value += 1;
            await nextTick();

            fixture.viewport.singlePageScroll.scrollToPage(requirePageNumber(1));
            await vi.waitFor(() => {
                expect(fixture.viewport.singlePageScroll.navigationAnchorPage.value).toBe(1);
            });
            await yieldToBrowser();
            await yieldToBrowser();

            fixture.container.scrollTop = 10_000;
            fixture.viewport.handleTrustedScroll({isTrusted: true} as Event);

            expect(fixture.viewport.singlePageScroll.navigationAnchorPage.value).toBeNull();
            expect(fixture.viewport.currentPage.value).toBeGreaterThan(1);
            expect(fixture.viewport.visibleRange.value.start).toBeGreaterThan(1);
            expect(fixture.viewport.viewModel.pagesToRender.value)
                .toContain(fixture.viewport.visibleRange.value.start);
            expect(fixture.viewport.viewModel.pagesToRender.value).not.toContain(1);
        } finally {
            fixture.app.unmount();
        }
    });

    it('keeps an authored scroll passive and observes the next user scroll', async () => {
        const fixture = createViewportFixture({
            bufferPages: 0,
            pageCount: 100,
        });
        try {
            fixture.documentSession.basePageHeight.value = 100;
            fixture.documentSession.pageMetrics.value = Array.from({length: 100}, () => ({
                width: 600,
                height: 100,
            }));
            fixture.documentSession.pageMetricsVersion.value += 1;
            await nextTick();
            // The write port recognizes the first scroll as the echo of the
            // viewer's own write.
            vi.spyOn(
                fixture.viewport.viewportWritePort,
                'consumeAuthorityScroll',
            ).mockReturnValueOnce(true).mockReturnValue(false);
            const epoch = fixture.viewport.userViewportInteractionEpoch.value;

            // The echo moves the rendered range but does not reinterpret the
            // page the viewer placed.
            fixture.container.scrollTop = 5_000;
            fixture.viewport.handleTrustedScroll({isTrusted: true} as Event);
            expect(fixture.viewport.userViewportInteractionEpoch.value).toBe(epoch);
            expect(fixture.viewport.visibleRange.value.start).toBeGreaterThan(1);
            expect(fixture.viewport.currentPage.value).toBe(1);

            // The user's own scroll moves the page indicator onto a visible page.
            fixture.container.scrollTop = 7_500;
            fixture.viewport.handleTrustedScroll({isTrusted: true} as Event);
            expect(fixture.viewport.userViewportInteractionEpoch.value).toBe(epoch + 1);
            expect(fixture.viewport.currentPage.value).toBeGreaterThanOrEqual(fixture.viewport.visibleRange.value.start);
            expect(fixture.viewport.currentPage.value).toBeLessThanOrEqual(fixture.viewport.visibleRange.value.end);
        } finally {
            fixture.app.unmount();
        }
    });

    it('protects the complete facing-page target row and stops layout writes after cancellation', async () => {
        const fixture = createViewportFixture({
            continuousScroll: false,
            pageCount: 10,
            viewMode: 'facing',
            zoomMode: 'fit-height',
        });
        try {
            setCurrentPage(fixture.viewport, 4);
            fixture.viewport.visibleRange.value = {
                start: 1,
                end: 2,
            };
            const metrics = Promise.withResolvers<boolean>();
            fixture.documentSession.ensurePageMetricsInRange.mockReturnValue(metrics.promise);
            expect(fixture.viewport.singlePageScroll.scrollToPage(requirePageNumber(4))).toBe(true);

            expect(fixture.viewport.getProtectedVisibleRange()).toEqual({
                start: 3,
                end: 4,
            });

            // Cancel while the target row is still being measured.
            await yieldToBrowser();
            fixture.viewport.singlePageScroll.cancelProgrammaticNavigation('test-cancel');
            const writesAtCancel = fixture.viewportWrites.writes.length;
            metrics.resolve(true);
            await yieldToBrowser();

            expect(fixture.viewportWrites.writes).toHaveLength(writesAtCancel);
            expect(fixture.viewport.demand.value.destinationPage).toBeNull();
            expect(fixture.viewport.singlePageScroll.isProgrammaticNavigationActive.value).toBe(false);
        } finally {
            fixture.app.unmount();
        }
    });

    it('projects a visible final page into a document that lost it', async () => {
        const fixture = createViewportFixture({pageCount: 2});
        try {
            fixture.viewport.visibleRange.value = {
                start: 1,
                end: 2,
            };
            fixture.documentSession.numPages.value = 1;

            expect(fixture.viewport.getProtectedVisibleRange()).toEqual({
                start: 1,
                end: 1,
            });
            expect(fixture.viewport.demand.value.visibleRange).toEqual({
                start: 1,
                end: 1,
            });
        } finally {
            await fixture.dispose();
        }
    });

    it('projects a retained navigation destination into a document that lost it', async () => {
        const fixture = createViewportFixture({
            continuousScroll: false,
            pageCount: 2,
        });
        try {
            const metrics = Promise.withResolvers<boolean>();
            fixture.documentSession.ensurePageMetricsInRange.mockReturnValue(metrics.promise);
            expect(fixture.viewport.singlePageScroll.scrollToPage(requirePageNumber(2))).toBe(true);
            expect(fixture.viewport.getProtectedVisibleRange()).toEqual({
                start: 2,
                end: 2,
            });

            fixture.documentSession.numPages.value = 1;

            expect(fixture.viewport.getProtectedVisibleRange()).toEqual({
                start: 1,
                end: 1,
            });
            expect(fixture.viewport.demand.value.destinationPage).toBe(1);
            metrics.resolve(false);
        } finally {
            await fixture.dispose();
        }
    });

    it('places the opening page before the document reports its length', async () => {
        const fixture = createViewportFixture({pageCount: 0});
        try {
            await fixture.documentSession.emit(transition('loading', {
                isReload: false,
                isSelectiveReload: false,
                pagesToInvalidate: null,
                preserveVisibleContent: false,
                preservePageStructure: false,
            }));

            expect(fixture.emittedPages).toEqual([1]);

            fixture.documentSession.numPages.value = 12;
            await nextTick();

            expect(fixture.emittedPages).toEqual([1]);
        } finally {
            fixture.app.unmount();
        }
    });

    it('keeps the restored in-page point when a Blob reload becomes ready', async () => {
        const fixture = createViewportFixture({
            pageCount: 8,
            zoomMode: 'custom',
        });
        const reloadPlan = {
            isReload: true,
            isSelectiveReload: false,
            pagesToInvalidate: null,
            preserveVisibleContent: false,
            preservePageStructure: false,
        };
        const stop = watch(fixture.viewport.demand, (demand) => {
            if (demand.mandatoryRaster) {
                fixture.viewport.settleMandatoryRaster(demand.mandatoryRaster.id, true);
            }
        }, {flush: 'post'});
        try {
            appendPageBox(fixture.container, 2, {
                height: 900,
                top: 940,
            });
            fixture.viewport.markPageMounted(requirePageNumber(2));
            setCurrentPage(fixture.viewport, 2);
            await fixture.documentSession.emit(transition('loading', reloadPlan));
            expect(fixture.viewport.singlePageScroll.submitNavigationRequest(createPageNavigationRequest(2, 'restore', {
                page: 2,
                pageXFraction: 0.5,
                pageYFraction: (230 + 400) / 900,
                viewportXFraction: 0.5,
                viewportYFraction: 0.5,
                affinity: 'center',
            }))).toBe(true);
            await vi.waitFor(() => {
                expect(fixture.viewport.singlePageScroll.isProgrammaticNavigationActive.value).toBe(false);
                expect(fixture.container.scrollTop).toBe(1_170);
            });

            await fixture.documentSession.emit(transition('ready', reloadPlan));

            expect(fixture.container.scrollTop).toBe(1_170);
            expect(fixture.viewport.currentPage.value).toBe(2);
        } finally {
            stop();
            await fixture.dispose();
        }
    });

    it('keeps reload target and custom display zoom while fit reloads retain their fit mode', async () => {
        const customZoom = ref(1.94);
        const fixture = createViewportFixture({
            continuousScroll: false,
            pageCount: 300,
            zoom: customZoom,
            zoomMode: 'custom',
        });
        try {
            const settleReadyPlacement = async () => {
                const ready = fixture.documentSession.emit(transition('ready', reloadPlan));
                let rasterId = 0;
                await vi.waitFor(() => {
                    const mandatory = fixture.viewport.demand.value.mandatoryRaster;
                    expect(mandatory).not.toBeNull();
                    expect(mandatory?.options.suppressResidentRasterDemand).toBe(true);
                    rasterId = mandatory!.id;
                });
                fixture.viewport.settleMandatoryRaster(rasterId, true);
                await vi.waitFor(() => {
                    const mandatory = fixture.viewport.demand.value.mandatoryRaster;
                    expect(mandatory?.id).toBeGreaterThan(rasterId);
                    expect(mandatory?.options.suppressResidentRasterDemand).toBe(true);
                    rasterId = mandatory!.id;
                });
                fixture.viewport.settleMandatoryRaster(rasterId, true);
                await ready;
            };
            setCurrentPage(fixture.viewport, 200);
            const reloadPlan = {
                isReload: true,
                isSelectiveReload: false,
                pagesToInvalidate: null,
                preserveVisibleContent: false,
                preservePageStructure: false,
            };
            await fixture.documentSession.emit(transition('loading', reloadPlan));
            await settleReadyPlacement();

            expect(fixture.zoom.value).toBe(1.94);
            expect(fixture.emittedPages.at(-1)).toBe(200);

            fixture.zoomMode.value = 'fit-width';
            await fixture.documentSession.emit(transition('loading', reloadPlan));
            await settleReadyPlacement();
            expect(fixture.zoomMode.value).toBe('fit-width');
            expect(fixture.emittedPages.at(-1)).toBe(200);
        } finally {
            fixture.app.unmount();
        }
    });

    it('does not hydrate a large reload metric prefix before restoring a distant page', async () => {
        const fixture = createViewportFixture({
            continuousScroll: false,
            pageCount: 20_001,
            zoomMode: 'custom',
        });
        const reloadPlan = {
            isReload: true,
            isSelectiveReload: false,
            pagesToInvalidate: null,
            preserveVisibleContent: false,
            preservePageStructure: false,
        };
        try {
            setCurrentPage(fixture.viewport, 20_001);
            await fixture.documentSession.emit(transition('loading', reloadPlan));
            const ready = fixture.documentSession.emit(transition('ready', reloadPlan));

            await vi.waitFor(() => expect(fixture.documentSession.loadedPageMetrics.has(20_001)).toBe(true));

            let rasterId = 0;
            await vi.waitFor(() => {
                const mandatory = fixture.viewport.demand.value.mandatoryRaster;
                expect(mandatory).not.toBeNull();
                rasterId = mandatory!.id;
            });
            fixture.viewport.settleMandatoryRaster(rasterId, true);
            await vi.waitFor(() => {
                const mandatory = fixture.viewport.demand.value.mandatoryRaster;
                expect(mandatory?.id).toBeGreaterThan(rasterId);
                rasterId = mandatory!.id;
            });
            fixture.viewport.settleMandatoryRaster(rasterId, true);
            await ready;
            expect([...fixture.documentSession.loadedPageMetrics]).toEqual([20_001]);
        } finally {
            fixture.app.unmount();
        }
    });

    it('reconciles a staged opening canvas when viewport layout publishes later', async () => {
        const surface = createDocumentOpenSurfaceSession();
        const generation = surface.begin({
            documentId: 'warm-open.pdf',
            documentRevision: 'revision-1',
        });
        surface.metadataReady(10);
        expect(surface.commitGeometry(generation, {
            width: 600,
            height: 900,
            margin: 20,
        })).toBe(true);
        const fixture = createViewportFixture({
            chassisAuthority: createChassisAuthority(surface),
            pageCount: 0,
        });
        try {
            const renderFence = surface.createRenderFence({
                generation,
                documentRevision: 'revision-1',
                renderVersion: 1,
                requestId: 3,
                pageNumber: 1,
            });
            expect(renderFence).not.toBeNull();
            expect(surface.commitCanvas(renderFence!)).toBe(true);
            await nextTick();
            expect(surface.snapshot.value.committedViewport).toBeNull();

            fixture.container.scrollTop = 4_000;
            fixture.documentSession.numPages.value = 10;
            fixture.documentSession.pageMetrics.value = Array.from({length: 10}, () => ({
                width: 600,
                height: 900,
            }));
            fixture.documentSession.pageMetricsVersion.value += 1;

            await vi.waitFor(() => expect(surface.snapshot.value.committedViewport).toMatchObject({
                documentRevision: 'revision-1',
                pageNumber: 1,
                viewportIntentId: renderFence!.viewportIntentId,
            }));
            expect(fixture.container.scrollTop).toBe(0);
        } finally {
            fixture.app.unmount();
        }
    });

    it('replays the settled PDF page when the shared opening surface becomes ready', async () => {
        const currentPage = ref(1);
        const surface = createDocumentOpenSurfaceSession();
        const generation = surface.begin({
            documentId: 'ready-reprojection.pdf',
            documentRevision: 'revision-1',
        });
        surface.metadataReady(10);
        expect(surface.commitGeometry(generation, {
            width: 600,
            height: 900,
            margin: 20,
        })).toBe(true);
        expect(surface.requestNavigation(6)).toBe(6);
        const navigationFence = createWorkspacePageNavigationFence({
            currentPage,
            openSurface: surface,
        });
        navigationFence.begin(6);
        const outcomes: boolean[] = [];
        const fixture = createViewportFixture({
            chassisAuthority: createChassisAuthority(surface),
            onEmitCurrentPage: page => {
                outcomes.push(navigationFence.consumePageUpdate(page).accepted);
            },
            pageCount: 10,
        });
        try {
            expect(fixture.viewport.scale.seedOpeningFitScale(845 / 612)).toBe(true);
            await nextTick();
            fixture.emitEffectiveZoom.mockClear();
            // The PDF viewer settles on page 6 while the shared surface still
            // holds its unplaced opening ticket. A user scroll is held back in
            // that state, so seed the viewer's page directly.
            fixture.viewport.singlePageScroll.viewportAuthority.observeUserScroll({
                affinity: 'start',
                page: 6,
                pageXFraction: 0,
                pageYFraction: 0,
                viewportXFraction: 0,
                viewportYFraction: 0,
            });
            await nextTick();
            expect(outcomes).toEqual([false]);
            expect(currentPage.value).toBe(1);
            const renderFence = surface.createRenderFence({
                generation,
                documentRevision: 'revision-1',
                renderVersion: 1,
                requestId: 1,
                pageNumber: 6,
            });
            expect(renderFence).not.toBeNull();
            expect(surface.commitCanvas(renderFence!)).toBe(true);
            expect(surface.commitViewport({
                generation,
                documentRevision: 'revision-1',
                viewportIntentId: renderFence!.viewportIntentId,
                documentGeometryRevision: 1,
                interactionEpoch: 0,
                pageNumber: 6,
                left: 0,
                top: 0,
            })).toBe(true);
            expect(surface.viewportSession.value.lifecycle).toBe('opening');

            expect(surface.markReady(renderFence!)).toBe(true);

            expect(outcomes).toEqual([
                false,
                true,
            ]);
            expect(fixture.emittedPages).toEqual([
                6,
                6,
            ]);
            expect(fixture.emitEffectiveZoom).toHaveBeenCalledExactlyOnceWith(845 / 612);
            expect(currentPage.value).toBe(6);
            expect(navigationFence.targetPage.value).toBeNull();
        } finally {
            fixture.app.unmount();
        }
    });

    it('does not restore a staged opening page after navigation supersedes it', async () => {
        const surface = createDocumentOpenSurfaceSession();
        const generation = surface.begin({
            documentId: 'superseded-open.pdf',
            documentRevision: 'revision-1',
        });
        surface.metadataReady(10);
        expect(surface.commitGeometry(generation, {
            width: 600,
            height: 900,
            margin: 20,
        })).toBe(true);
        const fixture = createViewportFixture({
            chassisAuthority: createChassisAuthority(surface),
            pageCount: 0,
        });
        try {
            const renderFence = surface.createRenderFence({
                generation,
                documentRevision: 'revision-1',
                renderVersion: 1,
                requestId: 4,
                pageNumber: 1,
            });
            expect(renderFence).not.toBeNull();
            expect(surface.commitCanvas(renderFence!)).toBe(true);
            await nextTick();
            expect(surface.snapshot.value.committedViewport).toBeNull();

            fixture.container.scrollTop = 4_000;
            expect(surface.requestNavigation(2)).toBe(2);
            expect(surface.viewportSession.value.requestedPage).toBe(2);
            fixture.documentSession.numPages.value = 10;
            fixture.documentSession.pageMetrics.value = Array.from({length: 10}, () => ({
                width: 600,
                height: 900,
            }));
            fixture.documentSession.pageMetricsVersion.value += 1;
            await nextTick();

            expect(surface.snapshot.value.committedViewport).toBeNull();
            expect(surface.viewportSession.value.requestedPage).toBe(2);
            expect(fixture.container.scrollTop).toBe(4_000);
        } finally {
            fixture.app.unmount();
        }
    });

    it('keeps an opening restore in charge while its previous PDF intent retires', async () => {
        const surface = createDocumentOpenSurfaceSession();
        const generation = surface.begin({
            documentId: 'save-as.pdf',
            documentRevision: 'revision-1',
        });
        surface.metadataReady(8);
        surface.commitGeometry(generation, {
            width: 600,
            height: 900,
            margin: 20,
        });
        const fixture = createViewportFixture({
            chassisAuthority: createChassisAuthority(surface),
            pageCount: 8,
            zoomMode: 'custom',
        });
        const metrics = Promise.withResolvers<boolean>();
        try {
            fixture.container.scrollTop = 1_170;
            fixture.documentSession.ensurePageMetricsInRange.mockReturnValueOnce(metrics.promise);
            surface.navigate(createPageNavigationRequest(2, 'restore', {
                page: 2,
                pageXFraction: 0.5,
                pageYFraction: 0.7,
                viewportXFraction: 0.5,
                viewportYFraction: 0.5,
                affinity: 'center',
            }));
            await vi.waitFor(() => expect(
                fixture.viewport.singlePageScroll.isProgrammaticNavigationActive.value,
            ).toBe(true));
            const renderFence = surface.createRenderFence({
                generation,
                documentRevision: 'revision-1',
                renderVersion: 1,
                requestId: 6,
                pageNumber: 2,
            });
            fixture.documentSession.loadToken.value = 2;
            expect(surface.commitCanvas(renderFence!)).toBe(true);
            await nextTick();

            expect(fixture.container.scrollTop).toBe(1_170);
            expect(surface.snapshot.value.committedViewport).toBeNull();
            expect(surface.navigationTicket.value?.request.source).toBe('restore');
        } finally {
            fixture.viewport.singlePageScroll.cancelProgrammaticNavigation('test-cleanup');
            metrics.resolve(true);
            await fixture.dispose();
        }
    });

    it('preserves destination navigation while the matching opening canvas waits for it', async () => {
        const surface = createDocumentOpenSurfaceSession();
        const generation = surface.begin({
            documentId: 'navigation-owned-open.pdf',
            documentRevision: 'revision-1',
        });
        surface.metadataReady(10);
        expect(surface.commitGeometry(generation, {
            width: 600,
            height: 900,
            margin: 20,
        })).toBe(true);
        const fixture = createViewportFixture({
            chassisAuthority: createChassisAuthority(surface),
            pageCount: 10,
        });
        const metrics = Promise.withResolvers<boolean>();
        try {
            fixture.viewport.markPageMounted(requirePageNumber(2));
            fixture.documentSession.ensurePageMetricsInRange.mockReturnValueOnce(metrics.promise);
            expect(fixture.viewport.singlePageScroll.scrollToPage(requirePageNumber(2))).toBe(true);
            await vi.waitFor(() => expect(
                fixture.viewport.singlePageScroll.isProgrammaticNavigationActive.value,
            ).toBe(true));
            const navigation = surface.navigationTicket.value;
            expect(navigation?.request.target).toEqual({
                kind: 'page',
                page: 2,
            });
            const renderFence = surface.createRenderFence({
                generation,
                documentRevision: 'revision-1',
                renderVersion: 1,
                requestId: 5,
                pageNumber: 2,
            });
            expect(renderFence).not.toBeNull();
            expect(surface.commitCanvas(renderFence!)).toBe(true);
            await nextTick();

            // The canvas does not settle the open while the navigation that
            // asked for page 2 is still on its way there.
            expect(surface.snapshot.value.committedViewport).toBeNull();
            expect(surface.navigationTicket.value).toBe(navigation);
            expect(fixture.viewport.singlePageScroll.isProgrammaticNavigationActive.value).toBe(true);
        } finally {
            fixture.viewport.singlePageScroll.cancelProgrammaticNavigation('test-cleanup');
            metrics.resolve(true);
            fixture.app.unmount();
        }
    });

    it('does not land a navigation from the previous document in the next one', async () => {
        const surface = createDocumentOpenSurfaceSession();
        surface.begin({
            documentId: 'stale-navigation.pdf',
            documentRevision: 'revision-1',
        });
        const fixture = createViewportFixture({
            chassisAuthority: createChassisAuthority(surface),
            pageCount: 10,
        });
        const metrics = Promise.withResolvers<boolean>();
        try {
            fixture.viewport.markPageMounted(requirePageNumber(2));
            fixture.documentSession.ensurePageMetricsInRange.mockReturnValueOnce(metrics.promise);
            expect(fixture.viewport.singlePageScroll.scrollToPage(requirePageNumber(2))).toBe(true);
            await vi.waitFor(() => expect(
                fixture.viewport.singlePageScroll.isProgrammaticNavigationActive.value,
            ).toBe(true));

            // Another document starts loading in this viewer.
            surface.begin({
                documentId: 'replacement.pdf',
                documentRevision: 'revision-2',
            });
            fixture.documentSession.loadToken.value = 2;
            await fixture.documentSession.emit(transition('loading', {
                isReload: false,
                isSelectiveReload: false,
                pagesToInvalidate: null,
                preserveVisibleContent: false,
                preservePageStructure: false,
            }));
            expect(fixture.viewport.demand.value.destinationPage).not.toBe(2);

            // The old navigation's layout arrives after the new load began; it
            // must not carry the new document to the old destination.
            metrics.resolve(true);
            await yieldToBrowser();
            await yieldToBrowser();
            expect(fixture.emittedPages).not.toContain(2);
        } finally {
            metrics.resolve(true);
            fixture.app.unmount();
        }
    });

    it.each([
        false,
        true,
    ])('closes with pending navigation after metadata clears (continuous: %s)', async (continuousScroll) => {
        const fixture = createViewportFixture({
            pageCount: 100,
            continuousScroll,
        });
        const metrics = Promise.withResolvers<boolean>();
        try {
            setCurrentPage(fixture.viewport, 38);
            fixture.viewport.markPageMounted(requirePageNumber(38));
            fixture.documentSession.ensurePageMetricsInRange.mockReturnValueOnce(metrics.promise);
            expect(fixture.viewport.singlePageScroll.scrollToPage(requirePageNumber(39))).toBe(true);
            await vi.waitFor(() => expect(
                fixture.viewport.singlePageScroll.isProgrammaticNavigationActive.value,
            ).toBe(true));

            fixture.documentSession.numPages.value = 0;
            fixture.documentSession.pageMetrics.value = [];
            fixture.documentSession.pdfDocument.value = null;
            await fixture.documentSession.emit(transition('invalidated', {
                isReload: false,
                isSelectiveReload: false,
                pagesToInvalidate: null,
                preserveVisibleContent: false,
                preservePageStructure: false,
            }));

            expect(fixture.viewport.singlePageScroll.isProgrammaticNavigationActive.value).toBe(false);
            expect(fixture.viewport.demand.value.operational).toBe(false);
        } finally {
            metrics.resolve(true);
            fixture.app.unmount();
        }
    });

    it('holds the last picture when a page operation rewrites the open document', async () => {
        const fixture = createViewportFixture({pageCount: 10});
        try {
            fixture.viewport.markPageMounted(requirePageNumber(1));

            await fixture.documentSession.emit({
                ...transition('invalidated', {
                    isReload: true,
                    isSelectiveReload: false,
                    pagesToInvalidate: null,
                    preserveVisibleContent: false,
                    preservePageStructure: false,
                }),
                isSameDocumentRewrite: true,
            });

            expect(fixture.documentSession.nextReloadPreservesVisibleContent).toBe(true);
        } finally {
            fixture.app.unmount();
        }
    });

    it('does not hold the last picture when a different document replaces it', async () => {
        const fixture = createViewportFixture({pageCount: 10});
        try {
            fixture.viewport.markPageMounted(requirePageNumber(1));

            await fixture.documentSession.emit(transition('invalidated', {
                isReload: true,
                isSelectiveReload: false,
                pagesToInvalidate: null,
                preserveVisibleContent: false,
                preservePageStructure: false,
            }));

            expect(fixture.documentSession.nextReloadPreservesVisibleContent).toBe(false);
        } finally {
            fixture.app.unmount();
        }
    });

    it('does not let ambient viewport echoes veto an opening surface generation', async () => {
        const surface = createDocumentOpenSurfaceSession();
        surface.begin({
            documentId: 'ambient-opening.pdf',
            documentRevision: 'revision-1',
        });
        const fixture = createViewportFixture({
            chassisAuthority: createChassisAuthority(surface),
            pageCount: 10,
        });
        try {
            fixture.fitMode.value = 'height';
            fixture.viewMode.value = 'facing';
            fixture.outputScale.value = 2;
            fixture.isActive.value = false;
            await nextTick();
            fixture.isActive.value = true;
            await nextTick();

            expect(surface.viewportSession.value.lifecycle).toBe('opening');
            expect(fixture.viewport.singlePageScroll.isProgrammaticNavigationActive.value).toBe(false);
            expect(fixture.viewportWrites.writes).toHaveLength(0);
        } finally {
            fixture.app.unmount();
        }
    });
});
