// @vitest-environment happy-dom

import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { Ref } from 'vue';
import {
    nextTick,
    ref,
} from 'vue';

const resizeObserverMock = vi.hoisted(() => ({callback: null as (() => void) | null}));

vi.mock('@vueuse/core', async () => {
    const actual = await vi.importActual('@vueuse/core');
    return {
        ...actual,
        useResizeObserver: vi.fn((_target, callback) => {
            resizeObserverMock.callback = callback;
            return {stop: vi.fn()};
        }),
    };
});

const { usePdfViewerResizeLifecycle } = await import(
    '@app/modules/pdf-viewer/runtime/composables/usePdfViewerResizeLifecycle'
);

type TResizeLifecycleOptions = Parameters<typeof usePdfViewerResizeLifecycle>[0];

function createResizeLifecycle(
    isActive = ref(true),
    options?: {
        numPages?: number;
        computeFitWidthScale?: () => boolean;
        settlePreviewFitScale?: (commit?: boolean) => boolean;
        isLoading?: Ref<boolean>;
        isResizing?: Ref<boolean>;
        currentPage?: Ref<number>;
        pdfDocument?: Ref<unknown | null>;
        pendingNavigationAnchorPage?: Readonly<Ref<number | null>>;
        transactionController?: TResizeLifecycleOptions['transactionController'];
        captureViewportAnchor?: TResizeLifecycleOptions['captureViewportAnchor'];
        applyResizeAnchorPreview?: TResizeLifecycleOptions['applyResizeAnchorPreview'];
        viewerContainer?: Ref<HTMLElement | null>;
    },
) {
    const getMostVisiblePage = vi.fn(() => 2);
    const computeFitWidthScale = vi.fn(options?.computeFitWidthScale ?? (() => true));
    const settlePreviewFitScale = vi.fn(
        options?.settlePreviewFitScale ?? (commit => commit === true),
    );
    const scheduleResizeAwareRerender = vi.fn();
    const setResizeTransitionVisible = vi.fn();
    const submitResizeIntent = vi.fn();
    const applyResizeAnchorPreview = vi.fn(options?.applyResizeAnchorPreview);
    const isResizing = options?.isResizing ?? ref(false);
    const lifecycle = usePdfViewerResizeLifecycle({
        submitResizeIntent,
        applyResizeAnchorPreview,
        viewerContainer: options?.viewerContainer ?? ref(null),
        isLoading: options?.isLoading ?? ref(false),
        isActive,
        isResizing,
        pdfDocument: options?.pdfDocument ?? ref({}),
        currentPage: options?.currentPage ?? ref(4),
        pendingNavigationAnchorPage: options?.pendingNavigationAnchorPage,
        visibleRange: ref({
            start: 4,
            end: 5,
        }),
        numPages: ref(options?.numPages ?? 10),
        computeFitWidthScale,
        settlePreviewFitScale,
        captureViewportAnchor: options?.captureViewportAnchor,
        getMostVisiblePage,
        summarizeViewerMetricsForLog: vi.fn(() => null),
        summarizeVisiblePageSnapshotForLog: vi.fn(() => ({})),
        scheduleResizeAwareRerender,
        setResizeTransitionVisible,
        transactionController: options?.transactionController,
    });

    return {
        applyResizeAnchorPreview,
        computeFitWidthScale,
        settlePreviewFitScale,
        getMostVisiblePage,
        isActive,
        isResizing,
        lifecycle,
        scheduleResizeAwareRerender,
        setResizeTransitionVisible,
        submitResizeIntent,
    };
}

describe('usePdfViewerResizeLifecycle inactive behavior', () => {
    afterEach(() => {
        vi.clearAllMocks();
        vi.useRealTimers();
        resizeObserverMock.callback = null;
    });

    it('builds an inactive anchor context without reading DOM snapshots', () => {
        const {
            getMostVisiblePage,
            lifecycle,
        } = createResizeLifecycle(ref(false));

        const anchor = lifecycle.buildResizeAnchorContext();

        expect(anchor.page).toBe(4);
        expect(getMostVisiblePage).not.toHaveBeenCalled();
    });

    it('does not force an untrusted preferred page into the initial anchor snapshot', () => {
        const { lifecycle } = createResizeLifecycle(ref(true));

        const anchor = lifecycle.buildResizeAnchorContext({
            preferredAnchorPage: 9,
            trustPreferredAnchorPage: false,
        });

        expect(anchor.page).toBe(4);
    });

    it('uses a trusted preferred page as the initial anchor snapshot', () => {
        const { lifecycle } = createResizeLifecycle(ref(true));

        const anchor = lifecycle.buildResizeAnchorContext({
            preferredAnchorPage: 9,
            trustPreferredAnchorPage: true,
        });

        expect(anchor.page).toBe(9);
    });

    it('ignores resize observer callbacks while inactive', () => {
        const {
            computeFitWidthScale,
            scheduleResizeAwareRerender,
            setResizeTransitionVisible,
        } = createResizeLifecycle(ref(false));

        resizeObserverMock.callback?.();

        expect(computeFitWidthScale).not.toHaveBeenCalled();
        expect(scheduleResizeAwareRerender).not.toHaveBeenCalled();
        expect(setResizeTransitionVisible).not.toHaveBeenCalled();
    });

    it('keeps the resize preview active for an inactive pane during layout collapse', () => {
        const isResizing = ref(true);
        const { computeFitWidthScale } = createResizeLifecycle(ref(false), {isResizing});

        resizeObserverMock.callback?.();

        expect(computeFitWidthScale).toHaveBeenCalledWith(null, {
            page: 4,
            preview: true,
        });
    });

    it('cancels pending resize rerenders when inactive before debounce settles', async () => {
        vi.useFakeTimers();
        const {
            isActive,
            scheduleResizeAwareRerender,
            setResizeTransitionVisible,
        } = createResizeLifecycle(ref(true));

        resizeObserverMock.callback?.();
        isActive.value = false;

        await vi.advanceTimersByTimeAsync(400);

        expect(scheduleResizeAwareRerender).not.toHaveBeenCalled();
        expect(setResizeTransitionVisible).toHaveBeenCalledWith({
            active: false,
            source: 'resize-cancelled',
            token: 1,
            anchorPage: 4,
        });
    });

    it('does not let a stale transition completion cancel the current hide timer', async () => {
        vi.useFakeTimers();
        const {
            lifecycle,
            setResizeTransitionVisible,
        } = createResizeLifecycle(ref(true));

        const staleToken = lifecycle.beginResizeTransition('resize-observer', 4);
        lifecycle.scheduleEndResizeTransition(staleToken, 'first-complete', 4);
        const currentToken = lifecycle.beginResizeTransition('resize-settle', 8);
        lifecycle.scheduleEndResizeTransition(currentToken, 'current-complete', 8);

        lifecycle.scheduleEndResizeTransition(staleToken, 'late-stale-complete', 4);
        await vi.runAllTimersAsync();

        expect(setResizeTransitionVisible).toHaveBeenLastCalledWith({
            active: false,
            source: 'current-complete',
            token: currentToken,
            anchorPage: 8,
        });
        expect(setResizeTransitionVisible).not.toHaveBeenCalledWith(expect.objectContaining({
            active: false,
            source: 'late-stale-complete',
        }));
    });

    it('preserves painted layers when scrollbar geometry changes without a fit-scale delta', async () => {
        vi.useFakeTimers();
        let viewportHeight = 896;
        const viewer = document.createElement('div');
        Object.defineProperties(viewer, {
            clientWidth: {value: 1574},
            clientHeight: {get: () => viewportHeight},
        });
        const viewerContainer = ref(viewer);
        const {
            computeFitWidthScale,
            scheduleResizeAwareRerender,
            setResizeTransitionVisible,
            submitResizeIntent,
        } = createResizeLifecycle(ref(true), {
            computeFitWidthScale: () => false,
            viewerContainer,
            pendingNavigationAnchorPage: ref(22),
            numPages: 383,
            captureViewportAnchor: () => ({
                affinity: 'center',
                page: 4,
                pageXFraction: 0.5,
                pageYFraction: 0.25,
                viewportXFraction: 0.5,
                viewportYFraction: 0.5,
            }),
        });

        viewportHeight = 881;
        resizeObserverMock.callback?.();
        await vi.advanceTimersByTimeAsync(400);

        expect(computeFitWidthScale).toHaveBeenCalledOnce();
        expect(submitResizeIntent).toHaveBeenCalledExactlyOnceWith({
            affinity: 'center',
            page: 22,
            pageXFraction: 0.5,
            pageYFraction: 0.25,
            viewportXFraction: 0.5,
            viewportYFraction: 0.5,
        });
        expect(scheduleResizeAwareRerender).not.toHaveBeenCalled();
        expect(setResizeTransitionVisible).not.toHaveBeenCalled();
    });

    it('suppresses the initial observer callback when geometry and fit scale are unchanged', async () => {
        vi.useFakeTimers();
        const viewerContainer = ref({
            clientWidth: 1200,
            clientHeight: 800,
        } as HTMLElement);
        const {
            computeFitWidthScale,
            scheduleResizeAwareRerender,
            setResizeTransitionVisible,
        } = createResizeLifecycle(ref(true), {
            computeFitWidthScale: () => false,
            viewerContainer,
        });

        resizeObserverMock.callback?.();
        await vi.advanceTimersByTimeAsync(400);

        expect(computeFitWidthScale).toHaveBeenCalledOnce();
        expect(scheduleResizeAwareRerender).not.toHaveBeenCalled();
        expect(setResizeTransitionVisible).not.toHaveBeenCalled();
    });

    it('uses a pending navigation page as the resize observer anchor', async () => {
        vi.useFakeTimers();
        const {
            computeFitWidthScale,
            scheduleResizeAwareRerender,
            setResizeTransitionVisible,
            submitResizeIntent,
        } = createResizeLifecycle(ref(true), { pendingNavigationAnchorPage: ref(8) });

        resizeObserverMock.callback?.();

        await vi.advanceTimersByTimeAsync(400);

        expect(computeFitWidthScale).toHaveBeenCalledWith(null, {page: 8});
        expect(submitResizeIntent).toHaveBeenCalledOnce();
        expect(setResizeTransitionVisible).toHaveBeenCalledWith({
            active: true,
            source: 'resize-observer',
            token: 1,
            anchorPage: 8,
        });
        expect(scheduleResizeAwareRerender).toHaveBeenCalledWith(
            're-render visible pages after resize',
            expect.objectContaining({
                resizeAnchor: expect.objectContaining({ page: 8 }),
                source: 'resize-observer',
                stabilize: true,
            }),
        );
    });

    it('reapplies the preserved anchor for later geometry changes in the same resize burst', async () => {
        vi.useFakeTimers();
        const viewerContainer = ref({
            clientWidth: 1_200,
            clientHeight: 800,
        } as HTMLElement);
        const semanticAnchor = {
            affinity: 'center' as const,
            page: 4,
            pageXFraction: 0.5,
            pageYFraction: 0.25,
            viewportXFraction: 0.5,
            viewportYFraction: 0.5,
        };
        const {
            applyResizeAnchorPreview,
            submitResizeIntent,
        } = createResizeLifecycle(ref(true), {
            captureViewportAnchor: () => semanticAnchor,
            viewerContainer,
        });

        resizeObserverMock.callback?.();
        expect(submitResizeIntent).not.toHaveBeenCalled();
        await nextTick();
        await Promise.resolve();

        expect(applyResizeAnchorPreview).toHaveBeenCalledTimes(2);
        expect(submitResizeIntent).toHaveBeenCalledOnce();

        (viewerContainer.value as {clientHeight: number}).clientHeight = 815;
        resizeObserverMock.callback?.();
        expect(applyResizeAnchorPreview).toHaveBeenCalledTimes(3);
        expect(applyResizeAnchorPreview).toHaveBeenNthCalledWith(3, semanticAnchor);
        await nextTick();
        await Promise.resolve();

        expect(applyResizeAnchorPreview).toHaveBeenCalledTimes(4);
        expect(applyResizeAnchorPreview).toHaveBeenLastCalledWith(semanticAnchor);
        expect(submitResizeIntent).toHaveBeenCalledOnce();
    });

    it('retains the prior page snapshot when a rapid zoom rerender has no source bitmap', () => {
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({drawImage: vi.fn()} as never);
        const viewer = document.createElement('div');
        const page = document.createElement('div');
        page.className = 'page_container page_container--rendered';
        page.dataset.page = '4';
        const pageCanvas = document.createElement('div');
        pageCanvas.className = 'page_canvas';
        const renderLayer = document.createElement('div');
        renderLayer.className = 'page_canvas__render-layer';
        const sourceCanvas = document.createElement('canvas');
        sourceCanvas.width = 640;
        sourceCanvas.height = 960;
        renderLayer.append(sourceCanvas);
        pageCanvas.append(renderLayer);
        page.append(pageCanvas);
        viewer.append(page);
        document.body.append(viewer);
        const { lifecycle } = createResizeLifecycle(ref(true), {viewerContainer: ref(viewer)});
        const anchor = lifecycle.buildResizeAnchorContext();

        lifecycle.captureResizeVisualSnapshots(anchor);
        expect(pageCanvas.querySelectorAll('.pdf-resize-canvas-snapshot')).toHaveLength(1);

        sourceCanvas.width = 0;
        sourceCanvas.height = 0;
        lifecycle.captureResizeVisualSnapshots(anchor);

        expect(pageCanvas.classList.contains('page_canvas--resize-visual-snapshot')).toBe(true);
        expect(pageCanvas.querySelectorAll('.pdf-resize-canvas-snapshot')).toHaveLength(1);

        lifecycle.cleanupResizeLifecycle();
        expect(pageCanvas.querySelector('.pdf-resize-canvas-snapshot')).toBeNull();
        document.body.replaceChildren();
    });

    it('renews a zoom snapshot lease until the final replacement canvas is presentation-ready', async () => {
        vi.useFakeTimers();
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({drawImage: vi.fn()} as never);
        const animationFrames: FrameRequestCallback[] = [];
        const requestAnimationFrame = vi.spyOn(window, 'requestAnimationFrame')
            .mockImplementation((callback) => {
                animationFrames.push(callback);
                return animationFrames.length;
            });
        const viewer = document.createElement('div');
        const page = document.createElement('div');
        page.className = 'page_container page_container--rendered';
        page.dataset.page = '4';
        const pageCanvas = document.createElement('div');
        pageCanvas.className = 'page_canvas';
        const renderLayer = document.createElement('div');
        renderLayer.className = 'page_canvas__render-layer';
        const sourceCanvas = document.createElement('canvas');
        sourceCanvas.width = 640;
        sourceCanvas.height = 960;
        renderLayer.append(sourceCanvas);
        pageCanvas.append(renderLayer);
        page.append(pageCanvas);
        viewer.append(page);
        document.body.append(viewer);
        const { lifecycle } = createResizeLifecycle(ref(true), {viewerContainer: ref(viewer)});
        const anchor = lifecycle.buildResizeAnchorContext();

        lifecycle.captureResizeVisualSnapshots(anchor, 180);
        page.classList.remove('page_container--rendered');
        const replacementCanvas = document.createElement('canvas');
        replacementCanvas.width = 640;
        replacementCanvas.height = 960;
        renderLayer.replaceChildren(replacementCanvas);

        animationFrames.shift()?.(0);
        animationFrames.shift()?.(16);

        expect(pageCanvas.classList.contains('page_canvas--resize-visual-snapshot')).toBe(true);
        expect(pageCanvas.querySelector('.pdf-resize-canvas-snapshot')).not.toBeNull();

        page.classList.add('page_container--rendered');
        lifecycle.captureResizeVisualSnapshots(anchor, 180);
        animationFrames.shift()?.(32);

        expect(pageCanvas.classList.contains('page_canvas--resize-visual-snapshot')).toBe(true);
        expect(pageCanvas.querySelector('.pdf-resize-canvas-snapshot')).not.toBeNull();

        await vi.advanceTimersByTimeAsync(179);
        animationFrames.shift()?.(211);
        expect(pageCanvas.querySelector('.pdf-resize-canvas-snapshot')).not.toBeNull();

        await vi.advanceTimersByTimeAsync(1);
        for (let frame = 0; frame < 3 && animationFrames.length > 0; frame += 1) {
            animationFrames.shift()?.(212 + frame);
        }
        expect(pageCanvas.classList.contains('page_canvas--resize-visual-snapshot')).toBe(false);
        expect(pageCanvas.querySelector('.pdf-resize-canvas-snapshot')).toBeNull();

        lifecycle.cleanupResizeLifecycle();
        requestAnimationFrame.mockRestore();
        document.body.replaceChildren();
    });

    it('keeps the trusted page when new geometry reinterprets the old scroll position', () => {
        const staleNewScaleAnchor = {
            affinity: 'center' as const,
            page: 2,
            pageXFraction: 0.5,
            pageYFraction: 0.28,
            viewportXFraction: 0.5,
            viewportYFraction: 0.5,
        };
        const {lifecycle} = createResizeLifecycle(ref(true), {captureViewportAnchor: () => staleNewScaleAnchor});

        const anchor = lifecycle.buildResizeAnchorContext({
            preferredAnchorPage: 7,
            trustPreferredAnchorPage: true,
        });

        expect(anchor.page).toBe(7);
        expect(anchor.semanticAnchor).toEqual({
            ...staleNewScaleAnchor,
            page: 7,
        });
    });

    it('attaches resize observer transactions to scheduled rerenders', async () => {
        vi.useFakeTimers();
        const beginTransaction = vi.fn(() => ({
            id: 12,
            kind: 'resize' as const,
            source: 'resize-observer' as const,
            state: 'preparing' as const,
            documentRef: {
                document: null,
                documentLoadToken: 0,
                documentVersion: 0,
            },
            target: null,
            fitPlan: {
                mode: 'none' as const,
                scalePage: null,
                hydrateRange: null,
                viewMode: null,
                pagedTargetRenderHandoff: null,
            },
            scrollPlan: null,
            renderRequest: null,
            createdAtMs: 0,
            userViewportInteractionEpoch: 0,
            cancellation: null,
        }));
        const transactionController: NonNullable<TResizeLifecycleOptions['transactionController']> = {
            beginTransaction,
            cancelActiveTransaction: vi.fn(() => true),
            isTransactionCurrent: vi.fn(() => true),
        };
        const {scheduleResizeAwareRerender} = createResizeLifecycle(ref(true), { transactionController });

        resizeObserverMock.callback?.();

        await vi.advanceTimersByTimeAsync(400);

        expect(beginTransaction).toHaveBeenCalledWith({
            kind: 'resize',
            source: 'resize-observer',
            page: 4,
            range: {
                start: 4,
                end: 5,
            },
            anchor: 'center',
        });
        expect(scheduleResizeAwareRerender).toHaveBeenCalledWith(
            're-render visible pages after resize',
            expect.objectContaining({ transactionId: 12 }),
        );
    });

    it('defers and replays resize after an authoritative reload transaction', async () => {
        vi.useFakeTimers();
        const activeTransaction = ref<{kind: 'reload'} | null>({kind: 'reload'});
        const beginTransaction = vi.fn(() => null);
        const transactionController: NonNullable<TResizeLifecycleOptions['transactionController']> = {
            activeTransaction,
            beginTransaction,
            cancelActiveTransaction: vi.fn(() => true),
            isTransactionCurrent: vi.fn(() => true),
        };
        const {
            computeFitWidthScale,
            scheduleResizeAwareRerender,
        } = createResizeLifecycle(ref(true), {transactionController});

        resizeObserverMock.callback?.();

        expect(computeFitWidthScale).not.toHaveBeenCalled();
        expect(beginTransaction).not.toHaveBeenCalled();
        expect(scheduleResizeAwareRerender).not.toHaveBeenCalled();

        activeTransaction.value = null;
        await nextTick();
        await vi.advanceTimersByTimeAsync(400);

        expect(computeFitWidthScale).toHaveBeenCalledOnce();
        expect(beginTransaction).toHaveBeenCalledOnce();
        expect(scheduleResizeAwareRerender).toHaveBeenCalledOnce();
    });

    it('consumes zoom-owned resize geometry without replaying a second rerender', async () => {
        vi.useFakeTimers();
        const activeTransaction = ref<{kind: 'zoom'} | null>({kind: 'zoom'});
        const viewer = {} as HTMLElement;
        Object.defineProperties(viewer, {
            clientHeight: {
                configurable: true,
                value: 600,
            },
            clientWidth: {
                configurable: true,
                value: 800,
            },
        });
        const beginTransaction = vi.fn(() => null);
        const staleNewScaleAnchor = {
            affinity: 'center' as const,
            page: 2,
            pageXFraction: 0.5,
            pageYFraction: 0.25,
            viewportXFraction: 0.5,
            viewportYFraction: 0.5,
        };
        const transactionController: NonNullable<TResizeLifecycleOptions['transactionController']> = {
            activeTransaction,
            beginTransaction,
            cancelActiveTransaction: vi.fn(() => true),
            isTransactionCurrent: vi.fn(() => true),
        };
        const {
            scheduleResizeAwareRerender,
            submitResizeIntent,
        } = createResizeLifecycle(ref(true), {
            captureViewportAnchor: () => staleNewScaleAnchor,
            computeFitWidthScale: () => false,
            transactionController,
            viewerContainer: ref(viewer),
        });

        resizeObserverMock.callback?.();

        expect(submitResizeIntent).not.toHaveBeenCalled();
        expect(beginTransaction).not.toHaveBeenCalled();
        expect(scheduleResizeAwareRerender).not.toHaveBeenCalled();

        Object.defineProperty(viewer, 'clientWidth', {
            configurable: true,
            value: 700,
        });
        activeTransaction.value = null;
        await nextTick();
        resizeObserverMock.callback?.();
        await vi.advanceTimersByTimeAsync(400);

        expect(submitResizeIntent).not.toHaveBeenCalled();
        expect(beginTransaction).not.toHaveBeenCalled();
        expect(scheduleResizeAwareRerender).not.toHaveBeenCalled();
    });

    it('previews the drag-start anchor on every drag frame and commits it once at settle', async () => {
        vi.useFakeTimers();
        const semanticAnchor = {
            affinity: 'center' as const,
            page: 4,
            pageXFraction: 0.35,
            pageYFraction: 0.72,
            viewportXFraction: 0.5,
            viewportYFraction: 0.5,
        };
        const isResizing = ref(false);
        const {
            applyResizeAnchorPreview,
            settlePreviewFitScale,
            computeFitWidthScale,
            scheduleResizeAwareRerender,
            submitResizeIntent,
        } = createResizeLifecycle(ref(true), {
            captureViewportAnchor: () => semanticAnchor,
            isResizing,
        });

        isResizing.value = true;
        resizeObserverMock.callback?.();
        resizeObserverMock.callback?.();
        await nextTick();
        await Promise.resolve();

        expect(computeFitWidthScale).toHaveBeenCalledWith(null, {
            page: 4,
            preview: true,
        });
        // Drag frames only correct the preview geometry. The authority intent
        // hydrates geometry and commits a position, which is settle work.
        expect(submitResizeIntent).not.toHaveBeenCalled();
        expect(applyResizeAnchorPreview).toHaveBeenCalledTimes(4);
        expect(applyResizeAnchorPreview).toHaveBeenNthCalledWith(1, semanticAnchor);
        expect(applyResizeAnchorPreview).toHaveBeenNthCalledWith(2, semanticAnchor);
        expect(scheduleResizeAwareRerender).not.toHaveBeenCalled();

        isResizing.value = false;
        resizeObserverMock.callback?.();
        await vi.advanceTimersByTimeAsync(25);
        await Promise.resolve();

        expect(submitResizeIntent).toHaveBeenCalledExactlyOnceWith(semanticAnchor);
        expect(applyResizeAnchorPreview).toHaveBeenCalledTimes(6);
        expect(applyResizeAnchorPreview).toHaveBeenNthCalledWith(6, semanticAnchor);
        expect(scheduleResizeAwareRerender).toHaveBeenCalledOnce();
        expect(computeFitWidthScale).toHaveBeenLastCalledWith(null, {
            page: 4,
            preview: true,
        });
        expect(settlePreviewFitScale).toHaveBeenCalledOnce();
        expect(settlePreviewFitScale).toHaveBeenCalledWith(true);
        expect(scheduleResizeAwareRerender).toHaveBeenCalledWith(
            're-render visible pages after resize settle',
            expect.objectContaining({
                resizeAnchor: expect.objectContaining({
                    page: 4,
                    semanticAnchor,
                }),
                source: 'resize-settle',
            }),
        );

        await vi.advanceTimersByTimeAsync(400);
        expect(scheduleResizeAwareRerender).toHaveBeenCalledOnce();
    });

    it('follows a page the authority commits during the drag instead of replaying the start anchor', async () => {
        vi.useFakeTimers();
        const currentPage = ref(1);
        const isResizing = ref(false);
        const captureViewportAnchor = vi.fn(() => ({
            affinity: 'center' as const,
            page: currentPage.value,
            pageXFraction: 0.5,
            pageYFraction: 0.1,
            viewportXFraction: 0.5,
            viewportYFraction: 0.5,
        }));
        const {
            applyResizeAnchorPreview,
            scheduleResizeAwareRerender,
            submitResizeIntent,
        } = createResizeLifecycle(ref(true), {
            captureViewportAnchor,
            currentPage,
            isResizing,
            numPages: 1_200,
        });

        isResizing.value = true;
        resizeObserverMock.callback?.();
        await nextTick();
        expect(applyResizeAnchorPreview).toHaveBeenLastCalledWith(
            expect.objectContaining({page: 1}),
        );

        // The navigation to page 500 commits mid-slide: the authority has
        // already scrolled there when it publishes the page.
        currentPage.value = 500;
        resizeObserverMock.callback?.();
        await nextTick();

        expect(applyResizeAnchorPreview).toHaveBeenLastCalledWith(
            expect.objectContaining({page: 500}),
        );

        isResizing.value = false;
        resizeObserverMock.callback?.();
        await vi.advanceTimersByTimeAsync(25);
        await Promise.resolve();

        expect(submitResizeIntent).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({page: 500}),
        );
        expect(scheduleResizeAwareRerender).toHaveBeenCalledWith(
            're-render visible pages after resize settle',
            expect.objectContaining({resizeAnchor: expect.objectContaining({page: 500})}),
        );
    });

    it('retires a drag transition that settles while a Recent document is still loading', async () => {
        vi.useFakeTimers();
        const isLoading = ref(true);
        const isResizing = ref(false);
        const {
            scheduleResizeAwareRerender,
            setResizeTransitionVisible,
        } = createResizeLifecycle(ref(true), {
            isLoading,
            isResizing,
        });

        isResizing.value = true;
        await nextTick();
        expect(setResizeTransitionVisible).toHaveBeenLastCalledWith(expect.objectContaining({
            active: true,
            source: 'resize-settle',
        }));

        isResizing.value = false;
        await nextTick();
        await vi.runAllTimersAsync();

        expect(scheduleResizeAwareRerender).not.toHaveBeenCalled();
        expect(setResizeTransitionVisible).toHaveBeenLastCalledWith(expect.objectContaining({
            active: false,
            source: 'resize-settle-cancelled',
        }));
    });

    it('reapplies the drag anchor when viewport geometry changes without a fit-scale delta', async () => {
        const isResizing = ref(false);
        const viewerContainer = ref({
            clientWidth: 1200,
            clientHeight: 800,
        } as HTMLElement);
        const semanticAnchor = {
            affinity: 'center' as const,
            page: 4,
            pageXFraction: 0.5,
            pageYFraction: 0.25,
            viewportXFraction: 0.5,
            viewportYFraction: 0.5,
        };
        const {
            applyResizeAnchorPreview,
            lifecycle,
            submitResizeIntent,
        } = createResizeLifecycle(ref(true), {
            captureViewportAnchor: () => semanticAnchor,
            computeFitWidthScale: () => false,
            isResizing,
            viewerContainer,
        });

        isResizing.value = true;
        (viewerContainer.value as {clientWidth: number}).clientWidth = 1100;
        resizeObserverMock.callback?.();
        await nextTick();
        await Promise.resolve();

        expect(applyResizeAnchorPreview).toHaveBeenCalledWith(semanticAnchor);
        expect(submitResizeIntent).not.toHaveBeenCalled();

        lifecycle.cleanupResizeLifecycle();
    });
});
