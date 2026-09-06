import type {IPdfDocument} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import {
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
    shallowRef,
} from 'vue';
import { usePdfViewerFitWidthController } from '@app/modules/pdf-viewer/runtime/viewport/usePdfViewerFitWidthController';
import { cast } from '@tests/helpers/cast';

describe('usePdfViewerFitWidthController', () => {
    it('syncs fit-width zoom mode when the current page changes', async () => {
        const currentPage = ref(1);
        const emitZoomMode = vi.fn();
        const syncHorizontalScrollForZoomMode = vi.fn();
        const isFitWidthScaleCurrent = vi.fn(() => true);
        const viewerContainer = ref(cast<HTMLElement>({}));
        const scope = effectScope();

        try {
            scope.run(() => {
                usePdfViewerFitWidthController({
                    viewerContainer,
                    pdfDocument: shallowRef<IPdfDocument | null>(cast({})),
                    isLoading: ref(false),
                    continuousScroll: computed(() => true),
                    fitMode: computed(() => 'width' as const),
                    zoomMode: computed(() => 'custom' as const),
                    zoom: computed(() => 1),
                    effectiveScale: computed(() => 1),
                    fitWidthScale: ref(1),
                    viewMode: computed(() => 'single' as const),
                    currentPage,
                    numPages: ref(10),
                    pageMetricsVersion: ref(0),
                    visibleRange: ref({
                        start: 1,
                        end: 1,
                    }),
                    computeFitWidthScale: vi.fn(() => false),
                    isFitWidthScaleCurrent,
                    syncHorizontalScrollForZoomMode,
                    cancelInFlightRenders: vi.fn(),
                    reRenderAllVisiblePages: vi.fn(async () => {}),
                    emitZoomMode,
                });
            });

            currentPage.value = 2;
            await nextTick();

            expect(isFitWidthScaleCurrent).toHaveBeenCalledWith(viewerContainer.value);
            expect(emitZoomMode).toHaveBeenCalledWith('fit-width');
            expect(syncHorizontalScrollForZoomMode).toHaveBeenCalledOnce();
        } finally {
            scope.stop();
        }
    });

    it('does not treat custom 100% as fit-width when the fit scale differs', async () => {
        const currentPage = ref(1);
        const emitZoomMode = vi.fn();
        const syncHorizontalScrollForZoomMode = vi.fn();
        const isFitWidthScaleCurrent = vi.fn(() => true);
        const viewerContainer = ref(cast<HTMLElement>({}));
        const scope = effectScope();

        try {
            scope.run(() => {
                usePdfViewerFitWidthController({
                    viewerContainer,
                    pdfDocument: shallowRef<IPdfDocument | null>(cast({})),
                    isLoading: ref(false),
                    continuousScroll: computed(() => true),
                    fitMode: computed(() => 'width' as const),
                    zoomMode: computed(() => 'custom' as const),
                    zoom: computed(() => 1),
                    effectiveScale: computed(() => 1),
                    fitWidthScale: ref(0.5),
                    viewMode: computed(() => 'single' as const),
                    currentPage,
                    numPages: ref(10),
                    pageMetricsVersion: ref(0),
                    visibleRange: ref({
                        start: 1,
                        end: 1,
                    }),
                    computeFitWidthScale: vi.fn(() => false),
                    isFitWidthScaleCurrent,
                    syncHorizontalScrollForZoomMode,
                    cancelInFlightRenders: vi.fn(),
                    reRenderAllVisiblePages: vi.fn(async () => {}),
                    emitZoomMode,
                });
            });

            currentPage.value = 2;
            await nextTick();

            expect(isFitWidthScaleCurrent).not.toHaveBeenCalled();
            expect(emitZoomMode).not.toHaveBeenCalled();
            expect(syncHorizontalScrollForZoomMode).toHaveBeenCalledOnce();
        } finally {
            scope.stop();
        }
    });

    it('keeps explicit continuous fit-width active when passive scrolling reaches a differently sized page', async () => {
        const currentPage = ref(1);
        const emitZoomMode = vi.fn();
        const syncHorizontalScrollForZoomMode = vi.fn();
        const isFitWidthScaleCurrent = vi.fn(() => false);
        const viewerContainer = ref(cast<HTMLElement>({}));
        const scope = effectScope();

        try {
            scope.run(() => {
                usePdfViewerFitWidthController({
                    viewerContainer,
                    pdfDocument: shallowRef<IPdfDocument | null>(cast({})),
                    isLoading: ref(false),
                    continuousScroll: computed(() => true),
                    fitMode: computed(() => 'width' as const),
                    zoomMode: computed(() => 'fit-width' as const),
                    zoom: computed(() => 1),
                    effectiveScale: computed(() => 3.44),
                    fitWidthScale: ref(3.44),
                    viewMode: computed(() => 'single' as const),
                    currentPage,
                    numPages: ref(10),
                    pageMetricsVersion: ref(0),
                    visibleRange: ref({
                        start: 1,
                        end: 2,
                    }),
                    computeFitWidthScale: vi.fn(() => false),
                    isFitWidthScaleCurrent,
                    syncHorizontalScrollForZoomMode,
                    cancelInFlightRenders: vi.fn(),
                    reRenderAllVisiblePages: vi.fn(async () => {}),
                    emitZoomMode,
                });
            });

            currentPage.value = 2;
            await nextTick();

            expect(isFitWidthScaleCurrent).not.toHaveBeenCalled();
            expect(emitZoomMode).not.toHaveBeenCalledWith('custom');
            expect(syncHorizontalScrollForZoomMode).toHaveBeenCalledOnce();
        } finally {
            scope.stop();
        }
    });
});
