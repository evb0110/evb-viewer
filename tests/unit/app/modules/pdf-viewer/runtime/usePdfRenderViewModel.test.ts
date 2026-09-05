import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    computed,
    effectScope,
    ref,
    shallowRef,
} from 'vue';
import { usePdfRenderViewModel } from '@app/modules/pdf-viewer/runtime/rendering/usePdfRenderViewModel';
import type { PDFDocumentProxy } from '@app/types/pdfContracts';
import type { TPdfSource } from '@app/types/pdfUi';
import { cast } from '@tests/helpers/cast';
import { createDocumentOpenSurfaceSession } from '@app/utils/document-viewer/chassis/documentOpenSurfaceSession';

function createHarness(options?: {
    hasMountedPageCanvas?: (page: number) => boolean;
    isPageBuffered?: (page: number) => boolean;
    isPageRenderedForClass?: (page: number) => boolean;
    isPageRendering?: (page: number) => boolean;
    isPageRenderFailed?: (page: number) => boolean;
    shouldShowSkeletonImmediately?: (page: number) => boolean;
    shouldShowSkeleton?: (page: number) => boolean;
    suppressLoadingOverlay?: boolean;
}) {
    const scope = effectScope();
    const mountedPages = ref([1]);
    const visibleRange = ref({
        start: 1,
        end: 1,
    });

    const viewModel = scope.run(() => usePdfRenderViewModel({
        src: computed(() => null as TPdfSource | null),
        isLoading: ref(false),
        pdfDocument: shallowRef<PDFDocumentProxy | null>(cast({})),
        getPage: vi.fn(async () => cast({})),
        openSurface: createDocumentOpenSurfaceSession(),
        isVisualReloadTransitionActive: ref(false),
        suppressLoadingOverlay: computed(() => options?.suppressLoadingOverlay ?? false),
        skeletonContentInsets: ref(null),
        pagesToRender: computed(() => mountedPages.value),
        isPageBuffered: options?.isPageBuffered ?? vi.fn(() => false),
        isPageRenderedForClass: options?.isPageRenderedForClass ?? vi.fn(() => false),
        isPageRendering: options?.isPageRendering ?? vi.fn(() => false),
        isPageRenderFailed: options?.isPageRenderFailed ?? vi.fn(() => false),
        shouldShowSkeleton: options?.shouldShowSkeleton ?? vi.fn(() => false),
        visibleRange,
        currentPage: ref(1),
        zoom: computed(() => 1),
        zoomMode: computed(() => 'fit-height' as const),
        fitMode: computed(() => 'height' as const),
        effectiveScale: ref(1),
        continuousScroll: computed(() => false),
        numPages: ref(1_000),
        linksByPage: computed<Record<number, never[]>>(() => ({})),
    }));

    return {
        scope,
        viewModel,
    };
}

describe('usePdfRenderViewModel', () => {
    it('replaces the skeleton when render demand reaches a terminal error', () => {
        const {
            scope,
            viewModel,
        } = createHarness({
            isPageRenderFailed: () => true,
            shouldShowSkeleton: () => true,
        });

        expect(viewModel?.shouldShowPageSkeleton(1)).toBe(false);
        expect(viewModel?.isPageRenderFailed(1)).toBe(true);

        scope.stop();
    });

    it('keeps page skeletons while an uncommitted canvas is mounted and rendering', () => {
        vi.useFakeTimers();
        try {
            const hasMountedCanvas = ref(false);
            const isRendering = ref(false);
            const {
                scope,
                viewModel,
            } = createHarness({
                hasMountedPageCanvas: () => hasMountedCanvas.value,
                isPageRendering: () => isRendering.value,
                shouldShowSkeleton: () => true,
            });

            if (!viewModel) {
                throw new Error('Failed to create PDF render view model');
            }

            expect(viewModel.shouldShowPageSkeleton(1)).toBe(true);

            hasMountedCanvas.value = true;
            isRendering.value = true;
            expect(viewModel.shouldShowPageSkeleton(1)).toBe(true);

            scope.stop();
        } finally {
            vi.useRealTimers();
        }
    });

    it('hides page skeletons after the page is finalized as rendered', () => {
        vi.useFakeTimers();
        try {
            const isRendered = ref(false);
            const {
                scope,
                viewModel,
            } = createHarness({
                hasMountedPageCanvas: () => true,
                isPageRenderedForClass: () => isRendered.value,
                isPageRendering: () => true,
                shouldShowSkeleton: () => true,
            });

            if (!viewModel) {
                throw new Error('Failed to create PDF render view model');
            }

            expect(viewModel.shouldShowPageSkeleton(1)).toBe(true);

            isRendered.value = true;
            expect(viewModel.shouldShowPageSkeleton(1)).toBe(false);

            scope.stop();
        } finally {
            vi.useRealTimers();
        }
    });

    it('keeps page skeletons visible when no final canvas is ready', () => {
        vi.useFakeTimers();
        try {
            const {
                scope,
                viewModel,
            } = createHarness({ shouldShowSkeleton: () => true });

            if (!viewModel) {
                throw new Error('Failed to create PDF render view model');
            }

            expect(viewModel.shouldShowPageSkeleton(1)).toBe(true);

            scope.stop();
        } finally {
            vi.useRealTimers();
        }
    });

    it('shows immediate navigation skeletons without waiting for the delayed timer', () => {
        vi.useFakeTimers();
        try {
            const {
                scope,
                viewModel,
            } = createHarness({
                shouldShowSkeleton: () => true,
                shouldShowSkeletonImmediately: () => true,
            });

            if (!viewModel) {
                throw new Error('Failed to create PDF render view model');
            }

            expect(viewModel.shouldShowPageSkeleton(1)).toBe(true);

            scope.stop();
        } finally {
            vi.useRealTimers();
        }
    });

    it('blocks immediate navigation skeletons while skeletons are globally suppressed', () => {
        vi.useFakeTimers();
        try {
            const {
                scope,
                viewModel,
            } = createHarness({
                shouldShowSkeleton: () => true,
                shouldShowSkeletonImmediately: () => true,
                suppressLoadingOverlay: true,
            });

            if (!viewModel) {
                throw new Error('Failed to create PDF render view model');
            }

            expect(viewModel.shouldShowPageSkeleton(1)).toBe(false);

            scope.stop();
        } finally {
            vi.useRealTimers();
        }
    });

    it('keeps recovery skeletons for an orphan canvas without current-generation readiness', () => {
        vi.useFakeTimers();
        try {
            const hasMountedCanvas = ref(true);
            const {
                scope,
                viewModel,
            } = createHarness({
                hasMountedPageCanvas: () => hasMountedCanvas.value,
                isPageRendering: () => false,
                shouldShowSkeleton: () => true,
            });

            if (!viewModel) {
                throw new Error('Failed to create PDF render view model');
            }

            expect(viewModel.shouldShowPageSkeleton(1)).toBe(true);

            scope.stop();
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not treat DOM canvas existence as navigation visual readiness', () => {
        vi.useFakeTimers();
        try {
            const {
                scope,
                viewModel,
            } = createHarness({
                hasMountedPageCanvas: () => true,
                shouldShowSkeleton: () => true,
            });

            if (!viewModel) {
                throw new Error('Failed to create PDF render view model');
            }

            expect(viewModel.shouldShowPageSkeleton(1)).toBe(true);

            scope.stop();
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not treat an orphaned canvas as recovery visual readiness', () => {
        vi.useFakeTimers();
        try {
            const {
                scope,
                viewModel,
            } = createHarness({
                hasMountedPageCanvas: () => true,
                isPageRendering: () => false,
                shouldShowSkeleton: () => true,
            });

            if (!viewModel) {
                throw new Error('Failed to create PDF render view model');
            }

            expect(viewModel.shouldShowPageSkeleton(1)).toBe(true);

            scope.stop();
        } finally {
            vi.useRealTimers();
        }
    });
});
