// @vitest-environment happy-dom

import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    computed,
    effectScope,
    nextTick,
    ref,
} from 'vue';
import { usePdfViewportViewModel } from '@app/modules/pdf-viewer/runtime/viewport/usePdfViewportViewModel';
import {createTestPdfViewportWritePort} from '@tests/helpers/createTestPdfViewportWritePort';
import { resolvePdfRenderPerformancePolicy } from '@app/modules/pdf-viewer/engine/pdf-render-performance/resolvePdfRenderPerformancePolicy';

const performancePolicy = resolvePdfRenderPerformancePolicy({
    lowCpu: false,
    lowMemory: false,
});

class ResizeObserverDouble {
    public static instances: ResizeObserverDouble[] = [];

    public observe = vi.fn();

    public unobserve = vi.fn();

    public disconnect = vi.fn();

    public constructor(private readonly callback: ResizeObserverCallback) {
        ResizeObserverDouble.instances.push(this);
    }

    public trigger() {
        this.callback([], this);
    }
}

describe('usePdfViewportViewModel', () => {
    let originalResizeObserver: typeof ResizeObserver | undefined;

    beforeEach(() => {
        ResizeObserverDouble.instances.length = 0;
        originalResizeObserver = globalThis.ResizeObserver;
        Object.defineProperty(globalThis, 'ResizeObserver', {
            configurable: true,
            value: ResizeObserverDouble,
        });
    });

    afterEach(() => {
        Object.defineProperty(globalThis, 'ResizeObserver', {
            configurable: true,
            value: originalResizeObserver,
        });
        vi.restoreAllMocks();
    });

    it('updates active-spread horizontal lock when the viewer width changes', async () => {
        const scope = effectScope();
        const container = document.createElement('div');
        let clientWidth = 500;
        Object.defineProperty(container, 'clientWidth', {
            configurable: true,
            get: () => clientWidth,
        });
        Object.defineProperty(container, 'scrollWidth', {
            configurable: true,
            get: () => 700,
        });
        container.scrollLeft = 0;
        const isActive = ref(true);

        const viewModel = scope.run(() => usePdfViewportViewModel({
            performancePolicy,
            isActive: computed(() => isActive.value),
            viewportWritePort: createTestPdfViewportWritePort().port,
            viewerContainer: ref(container),
            bufferPages: computed(() => 2),
            viewMode: computed(() => 'single' as const),
            numPages: ref(1),
            currentPage: ref(1),
            continuousScroll: computed(() => false),
            basePageWidth: ref(600),
            basePageHeight: ref(800),
            pageMetrics: ref([{
                width: 600,
                height: 800,
            }]),
            pageMetricsVersion: ref(0),
            effectiveScale: ref(1),
            scaledMargin: ref(20),
            visibleRange: ref({
                start: 1,
                end: 1,
            }),
            navigationAnchorPage: computed(() => null),
            resizeTransitionAnchorPage: ref(null),
            zoomVirtualizationFreeze: ref(null),
            scaleContainerStyle: computed(() => ({})),
            selectionMarkupStyle: computed(() => null),
            classState: {
                isAnySaving: computed(() => false),
                isDragging: ref(false),
                isViewerPanDragModeActive: computed(() => false),
                isSelectionMarkupToolActive: computed(() => false),
                isTextSelectionModeActive: computed(() => false),
                fitMode: computed(() => 'width' as const),
                zoomMode: computed(() => 'fit-width' as const),
                resizeTransitionVisible: ref(false),
                zoomSnapSuppressed: ref(false),
            },
        }));
        if (!viewModel) {
            throw new Error('Failed to create viewport view model');
        }

        expect(viewModel.viewerClass.value['pdfViewer--active-spread-fits-width']).toBe(false);

        await nextTick();
        clientWidth = 700;
        ResizeObserverDouble.instances[0]?.trigger();

        expect(viewModel.viewerClass.value['pdfViewer--active-spread-fits-width']).toBe(true);

        isActive.value = false;
        expect(viewModel.pagesToRender.value).toEqual([]);

        scope.stop();
    });

    it('keeps an outgoing facing spread wide during pending navigation', () => {
        const scope = effectScope();
        const writePort = createTestPdfViewportWritePort();
        const container = document.createElement('div');
        Object.defineProperty(container, 'clientWidth', {
            configurable: true,
            value: 500,
        });
        Object.defineProperty(container, 'scrollWidth', {
            configurable: true,
            value: 700,
        });
        container.scrollLeft = 50;

        const viewModel = scope.run(() => usePdfViewportViewModel({
            performancePolicy,
            isActive: computed(() => true),
            viewportWritePort: writePort.port,
            viewerContainer: ref(container),
            bufferPages: computed(() => 2),
            viewMode: computed(() => 'facing' as const),
            numPages: ref(4),
            currentPage: ref(1),
            continuousScroll: computed(() => false),
            basePageWidth: ref(300),
            basePageHeight: ref(800),
            pageMetrics: ref([
                {
                    width: 300,
                    height: 800,
                },
                {
                    width: 300,
                    height: 800,
                },
                {
                    width: 300,
                    height: 800,
                },
                {
                    width: 300,
                    height: 800,
                },
            ]),
            pageMetricsVersion: ref(0),
            effectiveScale: ref(0.7),
            scaledMargin: ref(20),
            visibleRange: ref({
                start: 1,
                end: 2,
            }),
            navigationAnchorPage: computed(() => 3),
            getCommittedPageScale: pageNumber => pageNumber <= 2 ? 1 : null,
            resizeTransitionAnchorPage: ref(null),
            zoomVirtualizationFreeze: ref(null),
            scaleContainerStyle: computed(() => ({})),
            selectionMarkupStyle: computed(() => null),
            classState: {
                isAnySaving: computed(() => false),
                isDragging: ref(false),
                isViewerPanDragModeActive: computed(() => false),
                isSelectionMarkupToolActive: computed(() => false),
                isTextSelectionModeActive: computed(() => false),
                fitMode: computed(() => 'width' as const),
                zoomMode: computed(() => 'fit-width' as const),
                resizeTransitionVisible: ref(false),
                zoomSnapSuppressed: ref(false),
            },
        }));
        try {
            if (!viewModel) {
                throw new Error('Failed to create viewport view model');
            }

            expect(viewModel.viewerClass.value['pdfViewer--active-spread-fits-width']).toBe(false);

            expect(viewModel.syncHorizontalScrollForZoomMode()).toBe(false);
            expect(container.scrollLeft).toBe(50);
            expect(writePort.writes).toHaveLength(0);
        } finally {
            scope.stop();
        }
    });
});
