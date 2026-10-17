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
    ref,
    shallowRef,
} from 'vue';
import { usePdfRenderViewModel } from '@app/modules/pdf-viewer/runtime/rendering/usePdfRenderViewModel';
import type {
    IContentInsets, TPdfSource,
} from '@app/types/pdfUi';
import type { ILinkAnnotation } from '@app/types/annotations';
import { cast } from '@tests/helpers/cast';
import { createDocumentOpenSurfaceSession } from '@app/modules/document-viewer/runtime/documentOpenSurfaceSession';

function createHarness(options?: {
    hasMountedPageCanvas?: (page: number) => boolean;
    isPageBuffered?: (page: number) => boolean;
    isPageRenderedForClass?: (page: number) => boolean;
    isPageRendering?: (page: number) => boolean;
    isPageRenderFailed?: (page: number) => boolean;
    shouldShowSkeletonImmediately?: (page: number) => boolean;
    shouldShowSkeleton?: (page: number) => boolean;
    linksByPage?: Record<number, ILinkAnnotation[]>;
}) {
    const scope = effectScope();
    const src = shallowRef<TPdfSource | null>(null);
    const openSurface = createDocumentOpenSurfaceSession();
    const isVisualReloadTransitionActive = ref(false);
    const skeletonContentInsets = ref<IContentInsets | null>(null);
    const visibleRange = ref({
        start: 1,
        end: 1,
    });

    const viewModel = scope.run(() => usePdfRenderViewModel({
        src: computed(() => src.value),
        isLoading: ref(false),
        pdfDocument: shallowRef<IPdfDocument | null>(cast({})),
        getPage: vi.fn(async () => cast({})),
        openSurface,
        isVisualReloadTransitionActive,
        skeletonContentInsets,
        isPageBuffered: options?.isPageBuffered ?? vi.fn(() => false),
        isPageRenderedForClass: options?.isPageRenderedForClass ?? vi.fn(() => false),
        isPageRenderFailed: options?.isPageRenderFailed ?? vi.fn(() => false),
        shouldShowSkeleton: options?.shouldShowSkeleton ?? vi.fn(() => false),
        visibleRange,
        zoom: computed(() => 1),
        zoomMode: computed(() => 'fit-height' as const),
        fitMode: computed(() => 'height' as const),
        effectiveScale: ref(1),
        continuousScroll: computed(() => false),
        numPages: ref(1_000),
        linksByPage: computed(() => options?.linksByPage ?? {}),
    }));

    return {
        scope,
        src,
        openSurface,
        isVisualReloadTransitionActive,
        skeletonContentInsets,
        viewModel,
    };
}

describe('usePdfRenderViewModel', () => {
    it('keeps links on a rendered scrolled page and loading feedback on its unrendered neighbour', () => {
        const links: ILinkAnnotation[] = [{
            id: 'page-2-link',
            pageNumber: 2,
            url: 'https://example.test/reading',
            rect: {
                left: 0.1,
                top: 0.2,
                width: 0.3,
                height: 0.1,
            },
        }];
        const harness = createHarness({
            isPageRenderedForClass: page => page === 1 || page === 2,
            shouldShowSkeleton: () => true,
            linksByPage: {2: links},
        });
        try {
            harness.src.value = new Blob([new Uint8Array([1])], {type: 'application/pdf'});
            const generation = harness.openSurface.begin({
                documentId: 'linked-pages.pdf',
                documentRevision: 'load:1',
            });
            harness.openSurface.commitGeometry(generation, {
                width: 612,
                height: 792,
                margin: 20,
            });
            const fence = harness.openSurface.createRenderFence({
                generation,
                documentRevision: 'load:1',
                renderVersion: 1,
                requestId: 1,
                pageNumber: 1,
            });
            if (!fence || !harness.viewModel) {
                throw new Error('Failed to create a rendered opening page');
            }
            expect(harness.openSurface.commitCanvas(fence)).toBe(true);
            expect(harness.openSurface.commitViewport({
                generation,
                documentRevision: 'load:1',
                viewportIntentId: fence.viewportIntentId,
                documentGeometryRevision: 1,
                interactionEpoch: 0,
                pageNumber: 1,
                left: 0,
                top: 0,
            })).toBe(true);
            expect(harness.openSurface.markReady(fence)).toBe(true);

            harness.openSurface.observeViewportPage(2);

            expect(harness.viewModel.visibleLinksByPage.value).toEqual({2: links});
            expect(harness.viewModel.shouldShowPageSkeleton(3)).toBe(true);
            harness.isVisualReloadTransitionActive.value = true;
            expect(harness.viewModel.shouldShowPageSkeleton(3)).toBe(true);
            expect(harness.viewModel.shouldShowPageSkeleton(2)).toBe(false);
            harness.skeletonContentInsets.value = {
                top: 20,
                right: 20,
                bottom: 20,
                left: 20,
            };
            expect(harness.viewModel.shouldShowPageSkeleton(3)).toBe(true);
            expect(harness.viewModel.shouldShowPageSkeleton(2)).toBe(false);
        } finally {
            harness.scope.stop();
        }
    });

    it('waits for initial skeleton geometry before showing an unrendered row', () => {
        const harness = createHarness({shouldShowSkeleton: () => true});
        try {
            harness.src.value = new Blob([new Uint8Array([1])], {type: 'application/pdf'});
            harness.openSurface.begin({
                documentId: 'opening.pdf',
                documentRevision: 'load:1',
            });
            expect(harness.viewModel?.shouldShowPageSkeleton(1)).toBe(false);
        } finally {
            harness.scope.stop();
        }
    });

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
