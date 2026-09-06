import type {IPdfDocument} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    computed,
    nextTick,
    ref,
    shallowRef,
} from 'vue';
import { usePdfViewerRerenderCoordinator } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerRerenderCoordinator';
import { usePdfViewerTransactionController } from '@app/modules/pdf-viewer/runtime/transactions/usePdfViewerTransactionController';
import type { IResizeAnchorContext } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerCurrentPageSync';
import type { IBuildResizeAnchorContextOptions } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerResizeLifecycle';
import type { IPdfNavigationState } from '@app/modules/pdf-viewer/runtime/navigation/createPdfNavigationMachineState';
import type { IPdfSemanticAnchor } from '@app/modules/pdf-viewer/runtime/viewport/pdfViewportGeometry';
import { PDF_RERENDER_SOURCE } from '@app/modules/pdf-viewer/runtime/rerender-protocol/pdfRerenderProtocol';
import { cast } from '@tests/helpers/cast';

/**
 * The anchor a fit change re-projects onto: the top of the preserved page.
 * Typed as the production anchor so a change to that contract fails here at
 * compile time instead of leaving the assertions matching a stale shape.
 */
function fitTopAnchor(page: number): IPdfSemanticAnchor {
    return {
        page,
        pageXFraction: 0.5,
        pageYFraction: 0,
        viewportXFraction: 0.5,
        viewportYFraction: 0,
        affinity: 'start',
    };
}

function createResizeAnchor(page: number): IResizeAnchorContext {
    return {
        page,
        capturedAtMs: Date.now(),
        transitionToken: 1,
        visibleRange: {
            start: page,
            end: page,
        },
        viewerMetrics: null,
        semanticAnchor: {
            page,
            pageXFraction: 0.5,
            pageYFraction: 0.25,
            viewportXFraction: 0.5,
            viewportYFraction: 0.25,
            affinity: 'center',
        },
    };
}

interface ITestPageRange {
    start: number;
    end: number;
}

type TReRenderAllVisiblePagesMock = (
    getVisibleRange: () => ITestPageRange,
    options?: Record<string, unknown>,
) => Promise<void>;

function createReRenderAllVisiblePagesMock() {
    return vi.fn<TReRenderAllVisiblePagesMock>(async () => {});
}

function createDeferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((resolver) => {
        resolve = resolver;
    });
    return {
        promise,
        resolve,
    };
}

function getRenderedRangeFromFirstCall(
    reRenderAllVisiblePages: ReturnType<typeof createReRenderAllVisiblePagesMock>,
) {
    const firstCall = reRenderAllVisiblePages.mock.calls[0];
    if (!firstCall) {
        throw new Error('Expected at least one visible rerender call');
    }
    return firstCall[0]();
}

async function flushCurrentPageFitRerender() {
    await nextTick();
    await vi.advanceTimersByTimeAsync(300);
    await nextTick();
    await Promise.resolve();
}

async function flushZoomOrchestrationHostTask() {
    await nextTick();
    await new Promise(resolve => setTimeout(resolve, 0));
}

// A fit change reprojects geometry on one scheduler round and starts the
// replacement render on the next, so both rounds have to drain before the
// re-anchor and the render order can be read.
async function flushFitModeReplacementStart() {
    await nextTick();
    await Promise.resolve();
    await nextTick();
    await Promise.resolve();
}

// Settlement runs the other way round: the resolved replacement render is a
// microtask, and the confirmation it schedules lands on the next tick.
async function flushFitModeReplacementSettled() {
    await Promise.resolve();
    await nextTick();
    await Promise.resolve();
    await nextTick();
}

type TCoordinatorDeps = Parameters<typeof usePdfViewerRerenderCoordinator>[0];

function createDeps(overrides: Partial<TCoordinatorDeps> = {}): TCoordinatorDeps {
    const currentPage = ref(1);
    const visibleRange = ref({
        start: 1,
        end: 1,
    });

    const deps = {
        viewerContainer: ref(null),
        pdfDocument: shallowRef<IPdfDocument | null>(cast({})),
        isLoading: ref(false),
        numPages: ref(10),
        currentPage,
        visibleRange,
        zoom: computed(() => 1),
        zoomMode: computed(() => 'custom' as const),
        fitMode: computed(() => 'width' as const),
        viewMode: computed(() => 'single' as const),
        isResizing: computed(() => false),
        continuousScroll: computed(() => false),
        getVisibleRange: () => visibleRange.value,
        reRenderAllVisiblePages: vi.fn(async () => {}),
        isPageRendered: vi.fn(() => true),
        summarizeViewerMetricsForLog: vi.fn(() => null),
        summarizeVisiblePageSnapshotForLog: vi.fn(() => null),
        syncCurrentPageFromViewport: vi.fn(async () => {}),
        buildResizeAnchorContext: vi.fn((options?: IBuildResizeAnchorContextOptions) => {
            return createResizeAnchor(options?.preferredAnchorPage ?? currentPage.value);
        }),
        applyResizeAnchorPreview: vi.fn(() => true),
        scheduleEndResizeTransition: vi.fn(),
        enqueueZoomSync: vi.fn(),
        scheduleResizeAwareRerender: vi.fn(),
        cancelInFlightPageRenders: vi.fn(),
        computeFitWidthScale: vi.fn(() => false),
        syncHorizontalScrollForZoomMode: vi.fn(() => true),
        setupPagePlaceholders: vi.fn(),
        scrollToPage: vi.fn(),
        getMostVisiblePage: vi.fn(() => currentPage.value),
        resetContinuousScrollState: vi.fn(),
        resetZoomRerenderQueueState: vi.fn(),
        consumeZoomViewportAnchor: vi.fn(() => null),
        beginResizeTransition: vi.fn(() => 1),
        consumeSuppressedZoomRerender: vi.fn(() => false),
        ...overrides,
    };
    const navigationState = shallowRef<IPdfNavigationState>({
        anchor: 'top',
        currentPage: deps.currentPage.value,
        source: 'paged',
        status: 'idle',
        targetPage: null,
        txn: 1,
    });
    return {
        ...deps,
        transactionController: deps.transactionController ?? usePdfViewerTransactionController({
            navigationState,
            currentPage: deps.currentPage,
            visibleRange: deps.visibleRange,
            numPages: deps.numPages,
            viewMode: cast(deps.viewMode),
            pdfDocument: cast(deps.pdfDocument),
            userViewportInteractionEpoch: ref(0),
        }),
    };
}

describe('usePdfViewerRerenderCoordinator', () => {
    it('does not overwrite view-mode snapshot restoration with a bare page snap', async () => {
        const viewMode = ref<'single' | 'facing'>('single');
        const reRenderAllVisiblePages = createReRenderAllVisiblePagesMock();
        const scrollToPage = vi.fn();
        const syncHorizontalScrollForZoomMode = vi.fn(() => true);

        usePdfViewerRerenderCoordinator(createDeps({
            currentPage: ref(4),
            visibleRange: ref({
                start: 4,
                end: 4,
            }),
            viewMode: computed(() => viewMode.value),
            getVisibleRange: () => ({
                start: 4,
                end: 4,
            }),
            reRenderAllVisiblePages,
            scrollToPage,
            getMostVisiblePage: vi.fn(() => 4),
            syncHorizontalScrollForZoomMode,
        }));

        viewMode.value = 'facing';
        await nextTick();
        await Promise.resolve();
        await nextTick();

        expect(reRenderAllVisiblePages).toHaveBeenCalledWith(
            expect.any(Function),
            expect.objectContaining({rerenderSource: 'view-mode'}),
        );
        expect(scrollToPage).not.toHaveBeenCalled();
        expect(syncHorizontalScrollForZoomMode).toHaveBeenCalled();
    });

    it('rerenders visible pages with an anchored rotation transition', async () => {
        const viewRotation = ref<0 | 90 | 180 | 270>(0);
        const reRenderAllVisiblePages = createReRenderAllVisiblePagesMock();
        const resetContinuousScrollState = vi.fn();
        const cancelInFlightPageRenders = vi.fn();

        usePdfViewerRerenderCoordinator(createDeps({
            viewRotation: computed(() => viewRotation.value),
            reRenderAllVisiblePages,
            resetContinuousScrollState,
            cancelInFlightPageRenders,
        }));

        viewRotation.value = 90;
        await nextTick();
        await Promise.resolve();
        await nextTick();

        expect(resetContinuousScrollState).toHaveBeenCalled();
        expect(cancelInFlightPageRenders).toHaveBeenCalled();
        expect(reRenderAllVisiblePages).toHaveBeenCalledWith(
            expect.any(Function),
            expect.objectContaining({rerenderSource: PDF_RERENDER_SOURCE.ViewRotation}),
        );
    });

    it('skips scheduling a zoom rerender when the zoom change was already handled by reload recovery', async () => {
        const zoom = ref(1);
        const consumeSuppressedZoomRerender = vi.fn(() => true);
        const enqueueZoomSync = vi.fn();
        const cancelInFlightPageRenders = vi.fn();

        usePdfViewerRerenderCoordinator(createDeps({
            numPages: ref(10),
            zoom: computed(() => zoom.value),
            fitMode: computed(() => 'width' as const),
            getVisibleRange: () => ({
                start: 1,
                end: 1,
            }),
            enqueueZoomSync,
            cancelInFlightPageRenders,
            consumeSuppressedZoomRerender,
        }));

        zoom.value = 1.94;
        await flushZoomOrchestrationHostTask();

        expect(consumeSuppressedZoomRerender).toHaveBeenCalledWith(1.94);
        expect(cancelInFlightPageRenders).not.toHaveBeenCalled();
        expect(enqueueZoomSync).not.toHaveBeenCalled();
    });

    it('uses the visible current page as a trusted toolbar zoom anchor', async () => {
        const zoom = ref(1);
        const pdfDocument = shallowRef<IPdfDocument | null>(cast({}));
        const currentPage = ref(157);
        const visibleRange = ref({
            start: 156,
            end: 158,
        });
        const buildResizeAnchorContext = vi.fn(() => createResizeAnchor(157));
        const enqueueZoomSync = vi.fn();

        usePdfViewerRerenderCoordinator(createDeps({
            pdfDocument,
            numPages: ref(348),
            currentPage,
            visibleRange,
            zoom: computed(() => zoom.value),
            fitMode: computed(() => 'width' as const),
            getVisibleRange: () => visibleRange.value,
            buildResizeAnchorContext,
            enqueueZoomSync,
            getMostVisiblePage: vi.fn(() => 157),
        }));

        zoom.value = 1.43;
        await flushZoomOrchestrationHostTask();

        expect(buildResizeAnchorContext).toHaveBeenCalledWith({
            preferredAnchorPage: 157,
            trustPreferredAnchorPage: true,
        });
        expect(enqueueZoomSync).toHaveBeenCalledWith(expect.objectContaining({
            source: 'zoom-change',
            stabilize: true,
            resizeAnchor: expect.objectContaining({ page: 157 }),
        }));
    });

    it('commits custom zoom geometry before queueing the replacement raster', async () => {
        const zoom = ref(1);
        const setupPagePlaceholders = vi.fn();
        const enqueueZoomSync = vi.fn();

        usePdfViewerRerenderCoordinator(createDeps({
            zoom: computed(() => zoom.value),
            zoomMode: computed(() => 'custom' as const),
            fitMode: computed(() => 'width' as const),
            setupPagePlaceholders,
            enqueueZoomSync,
        }));

        zoom.value = 1.25;
        await flushZoomOrchestrationHostTask();

        expect(setupPagePlaceholders).toHaveBeenCalledOnce();
        expect(setupPagePlaceholders.mock.invocationCallOrder[0]!).toBeLessThan(
            enqueueZoomSync.mock.invocationCallOrder[0]!,
        );
    });

    it('commits custom zoom geometry when the mode changes before queueing the replacement raster', async () => {
        const zoom = ref(1);
        const zoomMode = ref<'fit-width' | 'custom'>('fit-width');
        const setupPagePlaceholders = vi.fn();
        const enqueueZoomSync = vi.fn();

        usePdfViewerRerenderCoordinator(createDeps({
            zoom: computed(() => zoom.value),
            zoomMode: computed(() => zoomMode.value),
            fitMode: computed(() => 'width' as const),
            setupPagePlaceholders,
            enqueueZoomSync,
        }));

        zoomMode.value = 'custom';
        await flushZoomOrchestrationHostTask();

        expect(zoom.value).toBe(1);
        expect(setupPagePlaceholders).toHaveBeenCalledOnce();
        expect(enqueueZoomSync).toHaveBeenCalledWith(expect.objectContaining({source: PDF_RERENDER_SOURCE.ZoomModeChange}));
        expect(setupPagePlaceholders.mock.invocationCallOrder[0]!).toBeLessThan(
            enqueueZoomSync.mock.invocationCallOrder[0]!,
        );
    });

    it('keeps the visible page owner while gesture geometry changes', async () => {
        const zoom = ref(1);
        const pdfDocument = shallowRef<IPdfDocument | null>(cast({}));
        const currentPage = ref(157);
        const visibleRange = ref({
            start: 156,
            end: 158,
        });
        const buildResizeAnchorContext = vi.fn(() => createResizeAnchor(157));
        const enqueueZoomSync = vi.fn();
        const gestureAnchor = createResizeAnchor(157);

        usePdfViewerRerenderCoordinator(createDeps({
            pdfDocument,
            numPages: ref(348),
            currentPage,
            visibleRange,
            zoom: computed(() => zoom.value),
            fitMode: computed(() => 'width' as const),
            getVisibleRange: () => visibleRange.value,
            buildResizeAnchorContext,
            enqueueZoomSync,
            consumeZoomViewportAnchor: vi.fn(() => ({
                x: 80,
                y: 120,
                capturedAtMs: 1_000,
                resizeAnchor: gestureAnchor,
            })),
            getMostVisiblePage: vi.fn(() => 157),
        }));

        zoom.value = 1.43;
        await flushZoomOrchestrationHostTask();

        expect(buildResizeAnchorContext).not.toHaveBeenCalled();
        expect(enqueueZoomSync).toHaveBeenCalledWith(expect.objectContaining({
            source: 'zoom-gesture-change',
            stabilize: true,
            resizeAnchor: gestureAnchor,
        }));
    });

    it('defers and coalesces discrete zoom orchestration onto one latest host task', async () => {
        vi.useFakeTimers();
        try {
            const zoom = ref(1);
            const zoomMode = ref<'fit-width' | 'custom'>('fit-width');
            const submitZoomViewportStateIntent = vi.fn();
            const buildResizeAnchorContext = vi.fn(() => createResizeAnchor(1));
            const cancelInFlightPageRenders = vi.fn();
            const enqueueZoomSync = vi.fn();
            const {cleanupZoomOrchestration} = usePdfViewerRerenderCoordinator(createDeps({
                zoom: computed(() => zoom.value),
                zoomMode: computed(() => zoomMode.value),
                fitMode: computed(() => 'width' as const),
                submitZoomViewportStateIntent,
                buildResizeAnchorContext,
                cancelInFlightPageRenders,
                enqueueZoomSync,
            }));

            zoom.value = 2;
            zoomMode.value = 'custom';
            await nextTick();
            await Promise.resolve();

            expect(submitZoomViewportStateIntent).not.toHaveBeenCalled();
            expect(buildResizeAnchorContext).not.toHaveBeenCalled();
            expect(cancelInFlightPageRenders).not.toHaveBeenCalled();
            expect(enqueueZoomSync).not.toHaveBeenCalled();

            await vi.advanceTimersByTimeAsync(0);

            expect(submitZoomViewportStateIntent).toHaveBeenCalledOnce();
            expect(submitZoomViewportStateIntent).toHaveBeenCalledWith(2);
            expect(buildResizeAnchorContext).toHaveBeenCalledOnce();
            expect(cancelInFlightPageRenders).toHaveBeenCalledOnce();
            expect(enqueueZoomSync).toHaveBeenCalledOnce();
            expect(submitZoomViewportStateIntent.mock.invocationCallOrder[0]!).toBeLessThan(
                cancelInFlightPageRenders.mock.invocationCallOrder[0]!,
            );
            expect(cancelInFlightPageRenders.mock.invocationCallOrder[0]!).toBeLessThan(
                buildResizeAnchorContext.mock.invocationCallOrder[0]!,
            );
            expect(buildResizeAnchorContext.mock.invocationCallOrder[0]!).toBeLessThan(
                enqueueZoomSync.mock.invocationCallOrder[0]!,
            );
            expect(enqueueZoomSync).toHaveBeenCalledWith(expect.objectContaining({
                source: PDF_RERENDER_SOURCE.ZoomModeChange,
                stabilize: true,
            }));
            cleanupZoomOrchestration();
        } finally {
            vi.useRealTimers();
        }
    });

    it('cancels and fences queued zoom orchestration during cleanup', async () => {
        vi.useFakeTimers();
        try {
            const zoom = ref(1);
            const submitZoomViewportStateIntent = vi.fn();
            const enqueueZoomSync = vi.fn();
            const {cleanupZoomOrchestration} = usePdfViewerRerenderCoordinator(createDeps({
                zoom: computed(() => zoom.value),
                submitZoomViewportStateIntent,
                enqueueZoomSync,
            }));

            zoom.value = 2;
            await nextTick();
            cleanupZoomOrchestration();
            await vi.advanceTimersByTimeAsync(0);

            expect(submitZoomViewportStateIntent).not.toHaveBeenCalled();
            expect(enqueueZoomSync).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it('fences queued zoom orchestration from a replacement document', async () => {
        vi.useFakeTimers();
        try {
            const zoom = ref(1);
            const pdfDocument = shallowRef<IPdfDocument | null>(cast({id: 'old'}));
            const submitZoomViewportStateIntent = vi.fn();
            const enqueueZoomSync = vi.fn();
            usePdfViewerRerenderCoordinator(createDeps({
                pdfDocument,
                zoom: computed(() => zoom.value),
                submitZoomViewportStateIntent,
                enqueueZoomSync,
            }));

            zoom.value = 2;
            await nextTick();
            pdfDocument.value = cast({id: 'replacement'});
            await vi.advanceTimersByTimeAsync(0);

            expect(submitZoomViewportStateIntent).not.toHaveBeenCalled();
            expect(enqueueZoomSync).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it('cancels queued custom zoom orchestration when a fit transition takes ownership', async () => {
        vi.useFakeTimers();
        try {
            const zoom = ref(1);
            const zoomMode = ref<'custom' | 'fit-width'>('custom');
            const submitZoomViewportStateIntent = vi.fn();
            const enqueueZoomSync = vi.fn();
            usePdfViewerRerenderCoordinator(createDeps({
                zoom: computed(() => zoom.value),
                zoomMode: computed(() => zoomMode.value),
                fitMode: computed(() => 'width' as const),
                submitZoomViewportStateIntent,
                enqueueZoomSync,
            }));

            zoom.value = 2;
            await nextTick();
            zoomMode.value = 'fit-width';
            await nextTick();
            await vi.advanceTimersByTimeAsync(0);

            expect(submitZoomViewportStateIntent).not.toHaveBeenCalled();
            expect(enqueueZoomSync).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not rerender continuous fit-width when passive scrolling changes the current page', async () => {
        const currentPage = ref(1);
        const computeFitWidthScale = vi.fn(() => true);
        const cancelInFlightPageRenders = vi.fn();
        const reRenderAllVisiblePages = createReRenderAllVisiblePagesMock();
        const syncCurrentPageFromViewport = vi.fn(async () => {});
        const syncHorizontalScrollForZoomMode = vi.fn(() => true);
        const buildResizeAnchorContext = vi.fn(() => createResizeAnchor(currentPage.value));

        usePdfViewerRerenderCoordinator(createDeps({
            currentPage,
            visibleRange: ref({
                start: 1,
                end: 2,
            }),
            zoomMode: computed(() => 'fit-width' as const),
            continuousScroll: computed(() => true),
            getVisibleRange: () => ({
                start: 1,
                end: 2,
            }),
            reRenderAllVisiblePages,
            syncCurrentPageFromViewport,
            buildResizeAnchorContext,
            cancelInFlightPageRenders,
            computeFitWidthScale,
            syncHorizontalScrollForZoomMode,
            getMostVisiblePage: vi.fn(() => 2),
        }));

        currentPage.value = 2;
        await nextTick();
        await nextTick();

        expect(computeFitWidthScale).not.toHaveBeenCalled();
        expect(buildResizeAnchorContext).not.toHaveBeenCalled();
        expect(cancelInFlightPageRenders).not.toHaveBeenCalled();
        expect(reRenderAllVisiblePages).not.toHaveBeenCalled();
        expect(syncCurrentPageFromViewport).not.toHaveBeenCalled();
        expect(syncHorizontalScrollForZoomMode).not.toHaveBeenCalled();
    });

    it('rerenders paged fit-width when the current page changes', async () => {
        vi.useFakeTimers();
        try {
            const currentPage = ref(1);
            const computeFitWidthScale = vi.fn(() => true);
            const cancelInFlightPageRenders = vi.fn();
            const reRenderAllVisiblePages = createReRenderAllVisiblePagesMock();
            const syncCurrentPageFromViewport = vi.fn(async () => {});
            const buildResizeAnchorContext = vi.fn(() => createResizeAnchor(currentPage.value));

            usePdfViewerRerenderCoordinator(createDeps({
                currentPage,
                zoomMode: computed(() => 'fit-width' as const),
                getVisibleRange: () => ({
                    start: 2,
                    end: 2,
                }),
                reRenderAllVisiblePages,
                syncCurrentPageFromViewport,
                buildResizeAnchorContext,
                cancelInFlightPageRenders,
                computeFitWidthScale,
                getMostVisiblePage: vi.fn(() => 2),
            }));

            currentPage.value = 2;
            await flushCurrentPageFitRerender();

            expect(computeFitWidthScale).toHaveBeenCalledWith(null, { page: 2 });
            expect(buildResizeAnchorContext).toHaveBeenCalledWith({
                preferredAnchorPage: 2,
                trustPreferredAnchorPage: true,
            });
            expect(cancelInFlightPageRenders).toHaveBeenCalled();
            expect(reRenderAllVisiblePages).toHaveBeenCalledWith(
                expect.any(Function),
                expect.objectContaining({
                    renderBufferOverride: 0,
                    rerenderSource: 'fit-width-current-page',
                }),
            );
            expect(syncCurrentPageFromViewport).toHaveBeenCalledWith(
                expect.objectContaining({ source: 'fit-width-current-page' }),
            );
        } finally {
            vi.useRealTimers();
        }
    });

    it('prepares paged fit-height layout before rendering without submitting a second navigation', async () => {
        vi.useFakeTimers();
        try {
            const currentPage = ref(1);
            const computeFitWidthScale = vi.fn(() => true);
            const cancelInFlightPageRenders = vi.fn();
            const reRenderAllVisiblePages = createReRenderAllVisiblePagesMock();
            const scrollToPage = vi.fn(() => true);
            const syncCurrentPageFromViewport = vi.fn(async () => {});
            const buildResizeAnchorContext = vi.fn(() => createResizeAnchor(currentPage.value));
            const ensurePageMetricsInRange = vi.fn(async () => true);
            const setupPagePlaceholders = vi.fn();

            usePdfViewerRerenderCoordinator(createDeps({
                currentPage,
                zoomMode: computed(() => 'fit-height' as const),
                fitMode: computed(() => 'height' as const),
                viewMode: computed(() => 'facing-first-single' as const),
                getVisibleRange: () => ({
                    start: 2,
                    end: 3,
                }),
                reRenderAllVisiblePages,
                syncCurrentPageFromViewport,
                buildResizeAnchorContext,
                cancelInFlightPageRenders,
                ensurePageMetricsInRange,
                computeFitWidthScale,
                setupPagePlaceholders,
                scrollToPage,
                getMostVisiblePage: vi.fn(() => 2),
            }));

            currentPage.value = 2;
            await flushCurrentPageFitRerender();

            expect(computeFitWidthScale).toHaveBeenCalledWith(null, { page: 2 });
            expect(ensurePageMetricsInRange).toHaveBeenCalledWith(2, 3);
            expect(setupPagePlaceholders).toHaveBeenCalled();
            expect(ensurePageMetricsInRange.mock.invocationCallOrder[0]!).toBeLessThan(
                computeFitWidthScale.mock.invocationCallOrder[0]!,
            );
            expect(setupPagePlaceholders.mock.invocationCallOrder[0]!).toBeLessThan(
                reRenderAllVisiblePages.mock.invocationCallOrder[0]!,
            );
            expect(buildResizeAnchorContext).not.toHaveBeenCalled();
            expect(cancelInFlightPageRenders).toHaveBeenCalled();
            expect(reRenderAllVisiblePages).toHaveBeenCalledWith(
                expect.any(Function),
                expect.objectContaining({
                    rerenderSource: 'fit-height-current-page',
                    renderBufferOverride: 0,
                }),
            );
            expect(syncCurrentPageFromViewport).not.toHaveBeenCalled();
            expect(scrollToPage).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it('still renders paged fit-height when the hydrated fit scale is unchanged', async () => {
        vi.useFakeTimers();
        try {
            const currentPage = ref(1);
            const computeFitWidthScale = vi.fn(() => false);
            const reRenderAllVisiblePages = createReRenderAllVisiblePagesMock();

            usePdfViewerRerenderCoordinator(createDeps({
                currentPage,
                zoomMode: computed(() => 'fit-height' as const),
                fitMode: computed(() => 'height' as const),
                getVisibleRange: () => ({
                    start: 2,
                    end: 2,
                }),
                reRenderAllVisiblePages,
                buildResizeAnchorContext: vi.fn(() => createResizeAnchor(currentPage.value)),
                ensurePageMetricsInRange: vi.fn(async () => false),
                computeFitWidthScale,
                getMostVisiblePage: vi.fn(() => 2),
            }));

            currentPage.value = 2;
            await flushCurrentPageFitRerender();

            expect(computeFitWidthScale).toHaveBeenCalledWith(null, { page: 2 });
            expect(reRenderAllVisiblePages).toHaveBeenCalledWith(
                expect.any(Function),
                expect.objectContaining({
                    rerenderSource: 'fit-height-current-page',
                    renderBufferOverride: 0,
                }),
            );
        } finally {
            vi.useRealTimers();
        }
    });

    it.each([
        [
            'fit-height',
            'height',
            'fit-height-current-page',
        ],
        [
            'fit-width',
            'width',
            'fit-width-current-page',
        ],
    ] as const)(
        'keeps paged %s navigation under the navigation authority alone',
        async (zoomMode, fitMode, currentPageSource) => {
            vi.useFakeTimers();
            try {
                const currentPage = ref(1);
                const pagedNavigationTargetPage = ref<number | null>(null);
                const reRenderAllVisiblePages = createReRenderAllVisiblePagesMock();
                const scrollToPage = vi.fn();

                usePdfViewerRerenderCoordinator(createDeps({
                    currentPage,
                    pagedNavigationTargetPage,
                    zoomMode: computed(() => zoomMode),
                    fitMode: computed(() => fitMode),
                    reRenderAllVisiblePages,
                    scrollToPage,
                    ensurePageMetricsInRange: vi.fn(async () => true),
                    computeFitWidthScale: vi.fn(() => true),
                }));

                pagedNavigationTargetPage.value = 4;
                currentPage.value = 4;
                await flushCurrentPageFitRerender();

                expect(reRenderAllVisiblePages).not.toHaveBeenCalled();
                expect(scrollToPage).not.toHaveBeenCalled();

                pagedNavigationTargetPage.value = null;
                currentPage.value = 5;
                await flushCurrentPageFitRerender();

                expect(reRenderAllVisiblePages).toHaveBeenCalledOnce();
                expect(reRenderAllVisiblePages).toHaveBeenCalledWith(
                    expect.any(Function),
                    expect.objectContaining({rerenderSource: currentPageSource}),
                );
                // Current-page fit refresh may prepare/render, but it must not
                // submit a second navigation intent for the same page.
                expect(scrollToPage).not.toHaveBeenCalled();
            } finally {
                vi.useRealTimers();
            }
        },
    );

    it.each([
        [
            'height',
            'width',
        ],
        [
            'width',
            'height',
        ],
    ] as const)(
        're-anchors the committed page when a fit-%s replacement layout emits its own scroll',
        async (nextFitMode, initialFitMode) => {
            const fitMode = ref<'width' | 'height'>(initialFitMode);
            const interactionEpoch = ref(7);
            const physicalNavigationEpoch = ref(3);
            const computeFitWidthScale = vi.fn(() => true);
            const applyResizeAnchorPreview = vi.fn(() => true);
            const replacementRender = createDeferred();
            const reRenderAllVisiblePages = vi.fn<TReRenderAllVisiblePagesMock>(async () => {
                // Replacement geometry moves every row, and the browser emits
                // its own scroll for the clamped offset.
                interactionEpoch.value += 1;
                return replacementRender.promise;
            });

            usePdfViewerRerenderCoordinator(createDeps({
                currentPage: ref(500),
                numPages: ref(1859),
                visibleRange: ref({
                    start: 500,
                    end: 500,
                }),
                zoomMode: computed(() => fitMode.value === 'height' ? 'fit-height' as const : 'fit-width' as const),
                fitMode: computed(() => fitMode.value),
                getVisibleRange: () => ({
                    start: 500,
                    end: 500,
                }),
                reRenderAllVisiblePages,
                buildResizeAnchorContext: vi.fn(() => createResizeAnchor(500)),
                computeFitWidthScale,
                applyResizeAnchorPreview,
                getUserViewportInteractionEpoch: () => interactionEpoch.value,
                getUserPhysicalNavigationEpoch: () => physicalNavigationEpoch.value,
                getMostVisiblePage: vi.fn(() => 500),
            }));

            fitMode.value = nextFitMode;
            await flushFitModeReplacementStart();

            expect(applyResizeAnchorPreview).toHaveBeenCalledWith(fitTopAnchor(500));
            expect(applyResizeAnchorPreview.mock.invocationCallOrder[0]!).toBeLessThan(
                reRenderAllVisiblePages.mock.invocationCallOrder[0]!,
            );
            expect(reRenderAllVisiblePages).toHaveBeenCalledWith(
                expect.any(Function),
                expect.objectContaining({
                    rerenderSource: 'zoom-mode',
                    renderBufferOverride: 0,
                }),
            );

            const anchorCallsBeforeSettle = applyResizeAnchorPreview.mock.calls.length;
            replacementRender.resolve();
            await flushFitModeReplacementSettled();

            // The layout-generated scroll advanced the interaction epoch, but
            // no physical navigation happened, so the settled confirmation
            // still re-anchors page 500.
            expect(applyResizeAnchorPreview.mock.calls.length).toBeGreaterThan(anchorCallsBeforeSettle);
            expect(applyResizeAnchorPreview.mock.calls.at(-1)).toEqual([fitTopAnchor(500)]);
        },
    );

    it('holds the committed pixels of the fit page before the replacement render releases them', async () => {
        const fitMode = ref<'width' | 'height'>('width');
        const computeFitWidthScale = vi.fn(() => true);
        const captureResizeVisualSnapshots = vi.fn();
        const setupPagePlaceholders = vi.fn();
        const cancelInFlightPageRenders = vi.fn();
        const reRenderAllVisiblePages = createReRenderAllVisiblePagesMock();

        usePdfViewerRerenderCoordinator(createDeps({
            currentPage: ref(500),
            numPages: ref(1859),
            visibleRange: ref({
                start: 500,
                end: 500,
            }),
            zoomMode: computed(() => fitMode.value === 'height' ? 'fit-height' as const : 'fit-width' as const),
            fitMode: computed(() => fitMode.value),
            getVisibleRange: () => ({
                start: 500,
                end: 500,
            }),
            reRenderAllVisiblePages,
            computeFitWidthScale,
            captureResizeVisualSnapshots,
            cancelInFlightPageRenders,
            setupPagePlaceholders,
            getMostVisiblePage: vi.fn(() => 500),
        }));

        fitMode.value = 'height';
        await flushFitModeReplacementStart();

        expect(captureResizeVisualSnapshots).toHaveBeenCalledWith(
            expect.objectContaining({page: 500}),
        );
        // Cancelling the raster source releases the committed resident, which
        // re-shows the page skeleton. The snapshot has to exist before that,
        // and before the placeholder geometry changes under it.
        expect(captureResizeVisualSnapshots.mock.invocationCallOrder[0]!).toBeLessThan(
            setupPagePlaceholders.mock.invocationCallOrder[0]!,
        );
        expect(captureResizeVisualSnapshots.mock.invocationCallOrder[0]!).toBeLessThan(
            cancelInFlightPageRenders.mock.invocationCallOrder[0]!,
        );
        expect(captureResizeVisualSnapshots.mock.invocationCallOrder[0]!).toBeLessThan(
            reRenderAllVisiblePages.mock.invocationCallOrder[0]!,
        );
    });

    it('owns every scroll the replacement layout emits, from the first geometry write to settlement', async () => {
        const fitMode = ref<'width' | 'height'>('width');
        const physicalNavigationEpoch = ref(3);
        const computeFitWidthScale = vi.fn(() => true);
        const captureResizeVisualSnapshots = vi.fn();
        const setupPagePlaceholders = vi.fn();
        const applyResizeAnchorPreview = vi.fn(() => true);
        const endLayoutGeometryReplacement = vi.fn();
        const beginLayoutGeometryReplacement = vi.fn(() => endLayoutGeometryReplacement);
        const replacementRender = createDeferred();
        const reRenderAllVisiblePages = vi.fn<TReRenderAllVisiblePagesMock>(
            async () => replacementRender.promise,
        );

        usePdfViewerRerenderCoordinator(createDeps({
            currentPage: ref(500),
            numPages: ref(1859),
            visibleRange: ref({
                start: 500,
                end: 500,
            }),
            zoomMode: computed(() => fitMode.value === 'height' ? 'fit-height' as const : 'fit-width' as const),
            fitMode: computed(() => fitMode.value),
            getVisibleRange: () => ({
                start: 500,
                end: 500,
            }),
            reRenderAllVisiblePages,
            buildResizeAnchorContext: vi.fn(() => createResizeAnchor(500)),
            computeFitWidthScale,
            captureResizeVisualSnapshots,
            setupPagePlaceholders,
            applyResizeAnchorPreview,
            beginLayoutGeometryReplacement,
            getUserPhysicalNavigationEpoch: () => physicalNavigationEpoch.value,
            getMostVisiblePage: vi.fn(() => 500),
        }));

        fitMode.value = 'height';
        await flushFitModeReplacementStart();

        expect(beginLayoutGeometryReplacement).toHaveBeenCalledOnce();
        // Shrinking every row clamps `scrollTop`, and the browser reports that
        // clamp as an ordinary scroll. The window has to be open before the
        // first geometry write or that scroll is credited to the user.
        expect(beginLayoutGeometryReplacement.mock.invocationCallOrder[0]!).toBeLessThan(
            captureResizeVisualSnapshots.mock.invocationCallOrder[0]!,
        );
        expect(beginLayoutGeometryReplacement.mock.invocationCallOrder[0]!).toBeLessThan(
            setupPagePlaceholders.mock.invocationCallOrder[0]!,
        );
        expect(endLayoutGeometryReplacement).not.toHaveBeenCalled();

        replacementRender.resolve();
        await flushFitModeReplacementSettled();

        // And it closes again, so an ordinary scroll after the fit settles is
        // the user's once more.
        expect(endLayoutGeometryReplacement).toHaveBeenCalledOnce();
        expect(applyResizeAnchorPreview.mock.invocationCallOrder.at(-1)!).toBeLessThan(
            endLayoutGeometryReplacement.mock.invocationCallOrder[0]!,
        );
    });

    it('closes the layout replacement window when a superseding fit change abandons the run', async () => {
        const fitMode = ref<'width' | 'height'>('width');
        const computeFitWidthScale = vi.fn(() => true);
        const closers: Array<ReturnType<typeof vi.fn>> = [];
        const beginLayoutGeometryReplacement = vi.fn(() => {
            const close = vi.fn();
            closers.push(close);
            return close;
        });
        const reRenderAllVisiblePages = vi.fn<TReRenderAllVisiblePagesMock>(async () => {});

        usePdfViewerRerenderCoordinator(createDeps({
            currentPage: ref(500),
            numPages: ref(1859),
            visibleRange: ref({
                start: 500,
                end: 500,
            }),
            zoomMode: computed(() => fitMode.value === 'height' ? 'fit-height' as const : 'fit-width' as const),
            fitMode: computed(() => fitMode.value),
            getVisibleRange: () => ({
                start: 500,
                end: 500,
            }),
            reRenderAllVisiblePages,
            buildResizeAnchorContext: vi.fn(() => createResizeAnchor(500)),
            computeFitWidthScale,
            applyResizeAnchorPreview: vi.fn(() => true),
            beginLayoutGeometryReplacement,
            getMostVisiblePage: vi.fn(() => 500),
        }));

        fitMode.value = 'height';
        await nextTick();
        fitMode.value = 'width';
        await flushFitModeReplacementStart();
        await nextTick();
        await Promise.resolve();

        expect(closers.length).toBeGreaterThan(0);
        // A leaked window would keep crediting the viewer for the user's own
        // scrolling for the rest of the session.
        for (const close of closers) {
            expect(close).toHaveBeenCalled();
        }
    });

    it('cancels the settled fit re-anchor after a genuine physical user scroll', async () => {
        const fitMode = ref<'width' | 'height'>('width');
        const interactionEpoch = ref(7);
        const physicalNavigationEpoch = ref(3);
        const computeFitWidthScale = vi.fn(() => true);
        const applyResizeAnchorPreview = vi.fn(() => true);
        const scrollToPage = vi.fn(() => true);
        const replacementRender = createDeferred();
        const reRenderAllVisiblePages = vi.fn<TReRenderAllVisiblePagesMock>(
            async () => replacementRender.promise,
        );

        usePdfViewerRerenderCoordinator(createDeps({
            currentPage: ref(500),
            numPages: ref(1859),
            visibleRange: ref({
                start: 500,
                end: 500,
            }),
            zoomMode: computed(() => fitMode.value === 'height' ? 'fit-height' as const : 'fit-width' as const),
            fitMode: computed(() => fitMode.value),
            getVisibleRange: () => ({
                start: 500,
                end: 500,
            }),
            reRenderAllVisiblePages,
            buildResizeAnchorContext: vi.fn(() => createResizeAnchor(500)),
            computeFitWidthScale,
            applyResizeAnchorPreview,
            scrollToPage,
            getUserViewportInteractionEpoch: () => interactionEpoch.value,
            getUserPhysicalNavigationEpoch: () => physicalNavigationEpoch.value,
            getMostVisiblePage: vi.fn(() => 500),
        }));

        fitMode.value = 'height';
        await flushFitModeReplacementStart();

        expect(applyResizeAnchorPreview).toHaveBeenCalledWith(fitTopAnchor(500));
        const anchorCallsBeforeSettle = applyResizeAnchorPreview.mock.calls.length;

        interactionEpoch.value += 1;
        physicalNavigationEpoch.value += 1;
        replacementRender.resolve();
        await flushFitModeReplacementSettled();

        expect(applyResizeAnchorPreview.mock.calls.length).toBe(anchorCallsBeforeSettle);
        expect(scrollToPage).not.toHaveBeenCalled();
    });

    it('settles rapid fit-mode changes on the latest fit mode and page', async () => {
        const fitMode = ref<'width' | 'height'>('width');
        const interactionEpoch = ref(1);
        const physicalNavigationEpoch = ref(1);
        const computeFitWidthScale = vi.fn(() => true);
        const applyResizeAnchorPreview = vi.fn(
            (_anchor?: IPdfSemanticAnchor | null) => true,
        );
        const renderDeferrals: Array<ReturnType<typeof createDeferred>> = [];
        const reRenderAllVisiblePages = vi.fn<TReRenderAllVisiblePagesMock>(async () => {
            const deferred = createDeferred();
            renderDeferrals.push(deferred);
            interactionEpoch.value += 1;
            return deferred.promise;
        });

        usePdfViewerRerenderCoordinator(createDeps({
            currentPage: ref(500),
            numPages: ref(1859),
            visibleRange: ref({
                start: 500,
                end: 500,
            }),
            zoomMode: computed(() => fitMode.value === 'height' ? 'fit-height' as const : 'fit-width' as const),
            fitMode: computed(() => fitMode.value),
            getVisibleRange: () => ({
                start: 500,
                end: 500,
            }),
            reRenderAllVisiblePages,
            buildResizeAnchorContext: vi.fn(() => createResizeAnchor(500)),
            computeFitWidthScale,
            applyResizeAnchorPreview,
            getUserViewportInteractionEpoch: () => interactionEpoch.value,
            getUserPhysicalNavigationEpoch: () => physicalNavigationEpoch.value,
            getMostVisiblePage: vi.fn(() => 500),
        }));

        fitMode.value = 'height';
        await nextTick();
        fitMode.value = 'width';
        await nextTick();
        fitMode.value = 'height';
        await flushFitModeReplacementStart();

        for (const deferred of renderDeferrals) {
            deferred.resolve();
        }
        await flushFitModeReplacementSettled();

        expect(applyResizeAnchorPreview.mock.calls.every(call => (
            call[0]?.page === 500
        ))).toBe(true);
        expect(applyResizeAnchorPreview.mock.calls.at(-1)).toEqual([fitTopAnchor(500)]);
        // Fit-height is the only mode that measures against a specific page, so
        // the last measurement proves the surviving run is the latest fit mode
        // and not a superseded fit-width claim that happened to land last.
        expect(computeFitWidthScale.mock.calls.at(-1)).toEqual([
            null,
            {page: 500},
        ]);
    });

    it('reprojects fit-mode height changes before rendering and confirms the anchor after settlement', async () => {
        const fitMode = ref<'width' | 'height'>('width');
        const computeFitWidthScale = vi.fn(() => true);
        const setupPagePlaceholders = vi.fn();
        const scrollToPage = vi.fn(() => true);
        const applyResizeAnchorPreview = vi.fn(() => true);
        const reRenderAllVisiblePages = createReRenderAllVisiblePagesMock();

        usePdfViewerRerenderCoordinator(createDeps({
            currentPage: ref(4),
            visibleRange: ref({
                start: 4,
                end: 4,
            }),
            zoomMode: computed(() => fitMode.value === 'height' ? 'fit-height' as const : 'fit-width' as const),
            fitMode: computed(() => fitMode.value),
            getVisibleRange: () => ({
                start: 4,
                end: 4,
            }),
            reRenderAllVisiblePages,
            buildResizeAnchorContext: vi.fn(() => createResizeAnchor(4)),
            computeFitWidthScale,
            setupPagePlaceholders,
            scrollToPage,
            applyResizeAnchorPreview,
            getMostVisiblePage: vi.fn(() => 4),
        }));

        fitMode.value = 'height';
        await flushFitModeReplacementStart();
        await nextTick();

        expect(computeFitWidthScale).toHaveBeenCalled();
        expect(computeFitWidthScale).toHaveBeenCalledWith(null, { page: 4 });
        expect(setupPagePlaceholders.mock.invocationCallOrder[0]!).toBeLessThan(
            reRenderAllVisiblePages.mock.invocationCallOrder[0]!,
        );
        expect(applyResizeAnchorPreview.mock.invocationCallOrder[0]!).toBeLessThan(
            reRenderAllVisiblePages.mock.invocationCallOrder[0]!,
        );
        expect(reRenderAllVisiblePages.mock.invocationCallOrder[0]!).toBeLessThan(
            applyResizeAnchorPreview.mock.invocationCallOrder.at(-1)!,
        );
        expect(applyResizeAnchorPreview).toHaveBeenCalledTimes(2);
        expect(reRenderAllVisiblePages).toHaveBeenCalledWith(
            expect.any(Function),
            expect.objectContaining({
                rerenderSource: 'zoom-mode',
                renderBufferOverride: 0,
            }),
        );
        expect(applyResizeAnchorPreview).toHaveBeenCalledWith(fitTopAnchor(4));
        expect(scrollToPage).not.toHaveBeenCalled();
    });

    it('rerenders when zoom mode switches from custom 100% to fit-height without zoom or fit-mode changes', async () => {
        const zoomMode = ref<'custom' | 'fit-height'>('custom');
        const computeFitWidthScale = vi.fn(() => false);
        const setupPagePlaceholders = vi.fn();
        const scrollToPage = vi.fn(() => true);
        const applyResizeAnchorPreview = vi.fn(() => true);
        const reRenderAllVisiblePages = createReRenderAllVisiblePagesMock();
        const cancelInFlightPageRenders = vi.fn();

        usePdfViewerRerenderCoordinator(createDeps({
            currentPage: ref(4),
            visibleRange: ref({
                start: 4,
                end: 4,
            }),
            zoomMode: computed(() => zoomMode.value),
            fitMode: computed(() => 'height' as const),
            getVisibleRange: () => ({
                start: 4,
                end: 4,
            }),
            reRenderAllVisiblePages,
            cancelInFlightPageRenders,
            computeFitWidthScale,
            setupPagePlaceholders,
            scrollToPage,
            applyResizeAnchorPreview,
            getMostVisiblePage: vi.fn(() => 4),
        }));

        zoomMode.value = 'fit-height';
        await flushFitModeReplacementStart();

        expect(computeFitWidthScale).toHaveBeenCalledWith(null, { page: 4 });
        expect(setupPagePlaceholders.mock.invocationCallOrder[0]!).toBeLessThan(
            reRenderAllVisiblePages.mock.invocationCallOrder[0]!,
        );
        expect(applyResizeAnchorPreview.mock.invocationCallOrder[0]!).toBeLessThan(
            reRenderAllVisiblePages.mock.invocationCallOrder[0]!,
        );
        expect(scrollToPage).not.toHaveBeenCalled();
        expect(cancelInFlightPageRenders).toHaveBeenCalledOnce();
        expect(reRenderAllVisiblePages).toHaveBeenCalledWith(
            expect.any(Function),
            expect.objectContaining({
                rerenderSource: 'zoom-mode',
                renderBufferOverride: 0,
            }),
        );
    });

    it('coalesces rapid paged fit-height current-page rerenders so only the latest page can render', async () => {
        vi.useFakeTimers();
        try {
            const currentPage = ref(1);
            const computeFitWidthScale = vi.fn(() => true);
            const cancelInFlightPageRenders = vi.fn();
            const reRenderAllVisiblePages = createReRenderAllVisiblePagesMock();
            const scrollToPage = vi.fn();
            const ensurePageMetricsInRange = vi.fn(async () => true);

            usePdfViewerRerenderCoordinator(createDeps({
                numPages: ref(1_000),
                currentPage,
                zoomMode: computed(() => 'fit-height' as const),
                fitMode: computed(() => 'height' as const),
                getVisibleRange: () => ({
                    start: currentPage.value,
                    end: currentPage.value,
                }),
                reRenderAllVisiblePages,
                buildResizeAnchorContext: vi.fn(() => createResizeAnchor(currentPage.value)),
                cancelInFlightPageRenders,
                ensurePageMetricsInRange,
                computeFitWidthScale,
                scrollToPage,
                getMostVisiblePage: vi.fn(() => currentPage.value),
            }));

            currentPage.value = 30;
            await nextTick();
            currentPage.value = 928;
            await flushCurrentPageFitRerender();

            expect(computeFitWidthScale).toHaveBeenCalledTimes(1);
            expect(computeFitWidthScale).toHaveBeenCalledWith(null, { page: 928 });
            expect(cancelInFlightPageRenders).toHaveBeenCalledTimes(1);
            expect(reRenderAllVisiblePages).toHaveBeenCalledTimes(1);
            expect(getRenderedRangeFromFirstCall(reRenderAllVisiblePages)).toEqual({
                start: 928,
                end: 928,
            });
            expect(ensurePageMetricsInRange.mock.calls).toEqual([[
                928,
                928,
            ]]);
            expect(scrollToPage).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it('coalesces rapid paged fit-width current-page rerenders so intermediate pages cannot cancel the last page', async () => {
        vi.useFakeTimers();
        try {
            const currentPage = ref(1);
            const computeFitWidthScale = vi.fn(() => true);
            const cancelInFlightPageRenders = vi.fn();
            const reRenderAllVisiblePages = createReRenderAllVisiblePagesMock();
            const syncCurrentPageFromViewport = vi.fn(async () => {});
            const buildResizeAnchorContext = vi.fn((options?: IBuildResizeAnchorContextOptions) => {
                return createResizeAnchor(options?.preferredAnchorPage ?? currentPage.value);
            });
            const ensurePageMetricsInRange = vi.fn(async () => true);

            usePdfViewerRerenderCoordinator(createDeps({
                numPages: ref(1_000),
                currentPage,
                zoomMode: computed(() => 'fit-width' as const),
                getVisibleRange: () => ({
                    start: currentPage.value,
                    end: currentPage.value,
                }),
                reRenderAllVisiblePages,
                syncCurrentPageFromViewport,
                buildResizeAnchorContext,
                cancelInFlightPageRenders,
                ensurePageMetricsInRange,
                computeFitWidthScale,
                getMostVisiblePage: vi.fn(() => currentPage.value),
            }));

            currentPage.value = 30;
            await nextTick();
            currentPage.value = 928;
            await flushCurrentPageFitRerender();

            expect(computeFitWidthScale).toHaveBeenCalledTimes(1);
            expect(computeFitWidthScale).toHaveBeenCalledWith(null, { page: 928 });
            expect(buildResizeAnchorContext).toHaveBeenCalledOnce();
            expect(buildResizeAnchorContext).toHaveBeenCalledWith({
                preferredAnchorPage: 928,
                trustPreferredAnchorPage: true,
            });
            expect(cancelInFlightPageRenders).toHaveBeenCalledTimes(1);
            expect(reRenderAllVisiblePages).toHaveBeenCalledTimes(1);
            expect(getRenderedRangeFromFirstCall(reRenderAllVisiblePages)).toEqual({
                start: 928,
                end: 928,
            });
            expect(ensurePageMetricsInRange.mock.calls).toEqual([[
                928,
                928,
            ]]);
            expect(syncCurrentPageFromViewport).toHaveBeenCalledWith(
                expect.objectContaining({ source: 'fit-width-current-page' }),
            );
        } finally {
            vi.useRealTimers();
        }
    });

    it('waits for cancelled fit-width renders to settle before starting the replacement render', async () => {
        vi.useFakeTimers();
        try {
            const currentPage = ref(1);
            const cancellationSettled = createDeferred();
            const cancelInFlightPageRenders = vi.fn(() => cancellationSettled.promise);
            const reRenderAllVisiblePages = createReRenderAllVisiblePagesMock();
            const syncCurrentPageFromViewport = vi.fn(async () => {});

            usePdfViewerRerenderCoordinator(createDeps({
                currentPage,
                zoomMode: computed(() => 'fit-width' as const),
                getVisibleRange: () => ({
                    start: 2,
                    end: 2,
                }),
                reRenderAllVisiblePages,
                syncCurrentPageFromViewport,
                cancelInFlightPageRenders,
                ensurePageMetricsInRange: vi.fn(async () => true),
                computeFitWidthScale: vi.fn(() => true),
                buildResizeAnchorContext: vi.fn(() => createResizeAnchor(2)),
                getMostVisiblePage: vi.fn(() => 2),
            }));

            currentPage.value = 2;
            await nextTick();
            await vi.advanceTimersByTimeAsync(80);
            await nextTick();
            await Promise.resolve();

            expect(cancelInFlightPageRenders).toHaveBeenCalledOnce();
            expect(reRenderAllVisiblePages).not.toHaveBeenCalled();

            cancellationSettled.resolve();
            await Promise.resolve();
            await nextTick();
            await Promise.resolve();
            await nextTick();
            await Promise.resolve();
            await nextTick();

            expect(reRenderAllVisiblePages).toHaveBeenCalledWith(
                expect.any(Function),
                expect.objectContaining({
                    rerenderSource: 'fit-width-current-page',
                    renderBufferOverride: 0,
                }),
            );
            expect(syncCurrentPageFromViewport).toHaveBeenCalledWith(
                expect.objectContaining({ source: 'fit-width-current-page' }),
            );
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not rerender custom zoom when fit mode is width and the current page changes', async () => {
        const currentPage = ref(1);
        const computeFitWidthScale = vi.fn(() => true);
        const reRenderAllVisiblePages = createReRenderAllVisiblePagesMock();
        const syncCurrentPageFromViewport = vi.fn(async () => {});

        usePdfViewerRerenderCoordinator(createDeps({
            currentPage,
            visibleRange: ref({
                start: 1,
                end: 2,
            }),
            continuousScroll: computed(() => true),
            getVisibleRange: () => ({
                start: 1,
                end: 2,
            }),
            reRenderAllVisiblePages,
            syncCurrentPageFromViewport,
            buildResizeAnchorContext: vi.fn(() => createResizeAnchor(currentPage.value)),
            computeFitWidthScale,
            getMostVisiblePage: vi.fn(() => 2),
        }));

        currentPage.value = 2;
        await nextTick();
        await nextTick();

        expect(computeFitWidthScale).not.toHaveBeenCalled();
        expect(reRenderAllVisiblePages).not.toHaveBeenCalled();
        expect(syncCurrentPageFromViewport).not.toHaveBeenCalled();
    });

    it('schedules gesture zoom as an immediate visible-only rerender', async () => {
        const reRenderAllVisiblePages = createReRenderAllVisiblePagesMock();

        const {reRenderVisiblePagesAndSyncCurrentPage} = usePdfViewerRerenderCoordinator(createDeps({
            numPages: ref(348),
            currentPage: ref(157),
            visibleRange: ref({
                start: 157,
                end: 157,
            }),
            getVisibleRange: () => ({
                start: 157,
                end: 157,
            }),
            reRenderAllVisiblePages,
            buildResizeAnchorContext: vi.fn(() => createResizeAnchor(157)),
            getMostVisiblePage: vi.fn(() => 157),
        }));

        await reRenderVisiblePagesAndSyncCurrentPage({
            source: 'zoom-gesture-change',
            stabilize: true,
            resizeAnchor: createResizeAnchor(157),
        });

        expect(reRenderAllVisiblePages).toHaveBeenCalledWith(
            expect.any(Function),
            expect.objectContaining({
                rerenderSource: 'zoom-gesture-change',
                renderBufferOverride: 0,
            }),
        );
    });

    it('schedules toolbar zoom as an immediate visible-only rerender', async () => {
        const reRenderAllVisiblePages = createReRenderAllVisiblePagesMock();

        const {reRenderVisiblePagesAndSyncCurrentPage} = usePdfViewerRerenderCoordinator(createDeps({
            numPages: ref(348),
            currentPage: ref(157),
            visibleRange: ref({
                start: 157,
                end: 157,
            }),
            getVisibleRange: () => ({
                start: 157,
                end: 157,
            }),
            reRenderAllVisiblePages,
            buildResizeAnchorContext: vi.fn(() => createResizeAnchor(157)),
            getMostVisiblePage: vi.fn(() => 157),
        }));

        await reRenderVisiblePagesAndSyncCurrentPage({
            source: 'zoom-change',
            stabilize: true,
            resizeAnchor: createResizeAnchor(157),
        });

        expect(reRenderAllVisiblePages).toHaveBeenCalledWith(
            expect.any(Function),
            expect.objectContaining({
                rerenderSource: 'zoom-change',
                renderBufferOverride: 0,
            }),
        );
    });

    it('treats custom zoom-mode changes as zoom-like rerenders', async () => {
        const reRenderAllVisiblePages = createReRenderAllVisiblePagesMock();
        const syncCurrentPageFromViewport = vi.fn(async () => {});
        const captureResizeVisualSnapshots = vi.fn();
        const resizeAnchor = createResizeAnchor(157);

        const {reRenderVisiblePagesAndSyncCurrentPage} = usePdfViewerRerenderCoordinator(createDeps({
            numPages: ref(348),
            currentPage: ref(157),
            visibleRange: ref({
                start: 157,
                end: 157,
            }),
            getVisibleRange: () => ({
                start: 157,
                end: 157,
            }),
            reRenderAllVisiblePages,
            syncCurrentPageFromViewport,
            captureResizeVisualSnapshots,
            buildResizeAnchorContext: vi.fn(() => resizeAnchor),
            getMostVisiblePage: vi.fn(() => 157),
        }));

        await reRenderVisiblePagesAndSyncCurrentPage({
            source: PDF_RERENDER_SOURCE.ZoomModeChange,
            stabilize: true,
            resizeAnchor,
        });

        expect(reRenderAllVisiblePages).toHaveBeenCalledWith(
            expect.any(Function),
            expect.objectContaining({
                rerenderSource: PDF_RERENDER_SOURCE.ZoomModeChange,
                renderBufferOverride: 0,
            }),
        );
        expect(captureResizeVisualSnapshots).toHaveBeenCalledOnce();
        expect(captureResizeVisualSnapshots).toHaveBeenCalledWith(resizeAnchor);
        expect(syncCurrentPageFromViewport).toHaveBeenCalledWith(
            expect.objectContaining({
                source: PDF_RERENDER_SOURCE.ZoomModeChange,
                resizeAnchor,
            }),
        );
    });

    it('clamps horizontal scroll after fit-width rerenders', async () => {
        const reRenderAllVisiblePages = createReRenderAllVisiblePagesMock();
        const syncHorizontalScrollForZoomMode = vi.fn(() => true);

        const {reRenderVisiblePagesAndSyncCurrentPage} = usePdfViewerRerenderCoordinator(createDeps({
            numPages: ref(348),
            currentPage: ref(157),
            visibleRange: ref({
                start: 157,
                end: 157,
            }),
            zoomMode: computed(() => 'fit-width' as const),
            continuousScroll: computed(() => true),
            getVisibleRange: () => ({
                start: 157,
                end: 157,
            }),
            reRenderAllVisiblePages,
            buildResizeAnchorContext: vi.fn(() => createResizeAnchor(157)),
            syncHorizontalScrollForZoomMode,
            getMostVisiblePage: vi.fn(() => 157),
        }));

        await reRenderVisiblePagesAndSyncCurrentPage({
            source: 'resize-settle',
            stabilize: true,
            resizeAnchor: createResizeAnchor(157),
        });

        expect(reRenderAllVisiblePages).toHaveBeenCalledWith(
            expect.any(Function),
            expect.objectContaining({rerenderSource: 'resize-settle'}),
        );
        expect(syncHorizontalScrollForZoomMode).toHaveBeenCalled();
    });

    it('still completes fit-width rerenders when horizontal clamping reports no change', async () => {
        const reRenderAllVisiblePages = createReRenderAllVisiblePagesMock();
        const syncHorizontalScrollForZoomMode = vi.fn(() => false);

        const {reRenderVisiblePagesAndSyncCurrentPage} = usePdfViewerRerenderCoordinator(createDeps({
            numPages: ref(348),
            currentPage: ref(157),
            visibleRange: ref({
                start: 157,
                end: 157,
            }),
            zoomMode: computed(() => 'fit-width' as const),
            continuousScroll: computed(() => true),
            getVisibleRange: () => ({
                start: 157,
                end: 157,
            }),
            reRenderAllVisiblePages,
            buildResizeAnchorContext: vi.fn(() => createResizeAnchor(157)),
            syncHorizontalScrollForZoomMode,
            getMostVisiblePage: vi.fn(() => 157),
        }));

        await reRenderVisiblePagesAndSyncCurrentPage({
            source: 'resize-settle',
            stabilize: true,
            resizeAnchor: createResizeAnchor(157),
        });

        expect(reRenderAllVisiblePages).toHaveBeenCalledWith(
            expect.any(Function),
            expect.objectContaining({rerenderSource: 'resize-settle'}),
        );
        expect(syncHorizontalScrollForZoomMode).toHaveBeenCalled();
    });

    it('advances resize rerender transactions through render and settle', async () => {
        const reRenderAllVisiblePages = createReRenderAllVisiblePagesMock();
        const syncCurrentPageFromViewport = vi.fn(async () => {});
        const transactionController = {
            beginTransaction: vi.fn(() => cast({ id: 31 })),
            advanceTransaction: vi.fn(() => true),
            isTransactionCurrent: vi.fn(() => true),
        };
        const { reRenderVisiblePagesAndSyncCurrentPage } = usePdfViewerRerenderCoordinator(createDeps({
            reRenderAllVisiblePages,
            syncCurrentPageFromViewport,
            transactionController,
        }));

        await reRenderVisiblePagesAndSyncCurrentPage({
            source: 'resize-settle',
            stabilize: true,
            resizeAnchor: createResizeAnchor(3),
            transactionId: 31,
        });

        expect(transactionController.advanceTransaction).toHaveBeenCalledWith(31, 'render-requested');
        expect(transactionController.advanceTransaction).toHaveBeenCalledWith(31, 'settled');
        expect(reRenderAllVisiblePages).toHaveBeenCalledOnce();
        expect(syncCurrentPageFromViewport).toHaveBeenCalledWith(expect.objectContaining({transactionId: 31}));
    });

    it('reapplies the resize anchor after rendering before sampling the viewport', async () => {
        const resizeAnchor = createResizeAnchor(8);
        const reRenderAllVisiblePages = createReRenderAllVisiblePagesMock();
        const applyResizeAnchorPreview = vi.fn(() => true);
        const syncCurrentPageFromViewport = vi.fn(async () => {});
        const scheduleEndResizeTransition = vi.fn();
        const {reRenderVisiblePagesAndSyncCurrentPage} = usePdfViewerRerenderCoordinator(createDeps({
            reRenderAllVisiblePages,
            applyResizeAnchorPreview,
            syncCurrentPageFromViewport,
            scheduleEndResizeTransition,
        }));

        await reRenderVisiblePagesAndSyncCurrentPage({
            source: 'resize-settle',
            stabilize: true,
            resizeAnchor,
        });

        expect(reRenderAllVisiblePages.mock.invocationCallOrder[0]!).toBeLessThan(
            applyResizeAnchorPreview.mock.invocationCallOrder[0]!,
        );
        expect(applyResizeAnchorPreview).toHaveBeenCalledWith(resizeAnchor.semanticAnchor);
        expect(applyResizeAnchorPreview.mock.invocationCallOrder[0]!).toBeLessThan(
            syncCurrentPageFromViewport.mock.invocationCallOrder[0]!,
        );
        expect(scheduleEndResizeTransition).toHaveBeenCalledWith(
            resizeAnchor.transitionToken,
            'resize-rerender-complete',
            resizeAnchor.page,
        );
    });

    it.each([
        [
            'deferred',
            null,
            false,
        ],
        [
            'unavailable',
            false,
            true,
        ],
    ] as const)('handles a %s resize preview without changing fallback ownership', async (
        _outcome,
        previewOutcome,
        shouldFallback,
    ) => {
        const resizeAnchor = createResizeAnchor(8);
        const reRenderAllVisiblePages = createReRenderAllVisiblePagesMock();
        const applyResizeAnchorPreview = vi.fn(() => previewOutcome);
        const scrollToPage = vi.fn(() => true);
        const {reRenderVisiblePagesAndSyncCurrentPage} = usePdfViewerRerenderCoordinator(createDeps({
            reRenderAllVisiblePages,
            applyResizeAnchorPreview,
            scrollToPage,
        }));

        await reRenderVisiblePagesAndSyncCurrentPage({
            source: 'resize-settle',
            stabilize: true,
            resizeAnchor,
        });

        expect(applyResizeAnchorPreview).toHaveBeenCalledWith(resizeAnchor.semanticAnchor);
        if (shouldFallback) {
            expect(scrollToPage).toHaveBeenCalledWith(resizeAnchor.page, {
                preferExactDom: true,
                suppressRenderAfterSnap: true,
            });
        } else {
            expect(scrollToPage).not.toHaveBeenCalled();
        }
    });

    it.each([
        PDF_RERENDER_SOURCE.ZoomGestureChange,
        PDF_RERENDER_SOURCE.ZoomModeChange,
    ])('preserves the wheel cursor content point through %s raster settlement', async (source) => {
        const resizeAnchor = createResizeAnchor(8);
        const rasterCommit = createDeferred();
        const viewerPosition = {scrollTop: 640};
        const reRenderAllVisiblePages = vi.fn(() => rasterCommit.promise);
        const applyResizeAnchorPreview = vi.fn(() => {
            viewerPosition.scrollTop = 880;
            return true;
        });
        const scrollToPage = vi.fn(() => {
            viewerPosition.scrollTop = 0;
            return true;
        });
        const {reRenderVisiblePagesAndSyncCurrentPage} = usePdfViewerRerenderCoordinator(createDeps({
            reRenderAllVisiblePages,
            applyResizeAnchorPreview,
            scrollToPage,
        }));

        const settlement = reRenderVisiblePagesAndSyncCurrentPage({
            source,
            stabilize: true,
            resizeAnchor,
            zoomGestureSessionId: 17,
        });
        await Promise.resolve();

        expect(viewerPosition.scrollTop).toBe(640);
        expect(applyResizeAnchorPreview).not.toHaveBeenCalled();

        rasterCommit.resolve();
        await settlement;

        expect(viewerPosition.scrollTop).toBe(640);
        expect(applyResizeAnchorPreview).not.toHaveBeenCalled();
        expect(scrollToPage).not.toHaveBeenCalled();
    });

    it('retires the resize transition when its transaction goes stale after viewport sync', async () => {
        const resizeAnchor = createResizeAnchor(8);
        let transactionCurrent = true;
        const transactionController = {
            beginTransaction: vi.fn(() => cast({id: 31})),
            advanceTransaction: vi.fn(() => true),
            isTransactionCurrent: vi.fn(() => transactionCurrent),
        };
        const scheduleEndResizeTransition = vi.fn();
        const syncCurrentPageFromViewport = vi.fn(async () => {
            transactionCurrent = false;
        });
        const {reRenderVisiblePagesAndSyncCurrentPage} = usePdfViewerRerenderCoordinator(createDeps({
            transactionController,
            syncCurrentPageFromViewport,
            scheduleEndResizeTransition,
        }));

        await reRenderVisiblePagesAndSyncCurrentPage({
            source: 'resize-settle',
            stabilize: true,
            resizeAnchor,
            transactionId: 31,
        });

        expect(scheduleEndResizeTransition).toHaveBeenCalledWith(
            resizeAnchor.transitionToken,
            'stale-rerender-transaction-after-sync',
            resizeAnchor.page,
        );
        expect(transactionController.advanceTransaction).not.toHaveBeenCalledWith(31, 'settled');
    });

    it('retires the resize transition when replacement rendering fails', async () => {
        const resizeAnchor = createResizeAnchor(8);
        const renderError = new Error('replacement render failed');
        const scheduleEndResizeTransition = vi.fn();
        const {reRenderVisiblePagesAndSyncCurrentPage} = usePdfViewerRerenderCoordinator(createDeps({
            reRenderAllVisiblePages: vi.fn(async () => {
                throw renderError;
            }),
            scheduleEndResizeTransition,
        }));

        await expect(reRenderVisiblePagesAndSyncCurrentPage({
            source: 'resize-settle',
            stabilize: true,
            resizeAnchor,
        })).rejects.toBe(renderError);

        expect(scheduleEndResizeTransition).toHaveBeenCalledWith(
            resizeAnchor.transitionToken,
            'failed-rerender',
            resizeAnchor.page,
        );
    });
});
