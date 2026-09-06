import type {IPdfDocument} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    computed,
    effectScope,
    ref,
    shallowRef,
} from 'vue';
import { usePdfViewerLoadingState } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerLoadingState';
import {
    createDocumentOpenSurfaceSession,
    type IDocumentOpenSurfaceRenderFence,
} from '@app/utils/document-viewer/chassis/documentOpenSurfaceSession';
function createHarness() {
    const scope = effectScope();
    const src = shallowRef<Blob | null>(new Blob([new Uint8Array([1])], {type: 'application/pdf'}));
    const isLoading = ref(false);
    const pdfDocument = shallowRef<IPdfDocument | null>({} as IPdfDocument);
    const currentPage = ref(1);
    const openSurface = createDocumentOpenSurfaceSession();
    const state = scope.run(() => usePdfViewerLoadingState({
        src: computed(() => src.value),
        isLoading,
        pdfDocument,
        currentPage,
        openSurface,
    }));
    if (!state) {
        throw new Error('Failed to create PDF viewer loading state');
    }
    return {
        scope,
        src,
        isLoading,
        pdfDocument,
        currentPage,
        openSurface,
        state,
    };
}

function beginSurface(
    harness: ReturnType<typeof createHarness>,
    revision: string,
    pageNumber = 1,
) {
    const generation = harness.openSurface.begin({
        documentId: 'scan.pdf',
        documentRevision: revision,
    }, null, pageNumber);
    harness.openSurface.commitGeometry(generation, {
        width: 612,
        height: 792,
        margin: 20,
    });
    return generation;
}

function commitPage(
    harness: ReturnType<typeof createHarness>,
    generation: number,
    revision: string,
    pageNumber: number,
    requestId = 1,
) {
    const fence = harness.openSurface.createRenderFence({
        generation,
        documentRevision: revision,
        renderVersion: 1,
        requestId,
        pageNumber,
    });
    if (!fence) {
        throw new Error('Failed to create render fence');
    }
    expect(harness.openSurface.commitCanvas(fence)).toBe(true);
    expect(harness.openSurface.commitViewport({
        generation,
        documentRevision: revision,
        viewportIntentId: fence.viewportIntentId,
        documentGeometryRevision: 1,
        interactionEpoch: 0,
        pageNumber,
        left: 0,
        top: 0,
    })).toBe(true);
    return fence;
}

function markReady(
    harness: ReturnType<typeof createHarness>,
    fence: IDocumentOpenSurfaceRenderFence,
) {
    expect(harness.openSurface.markReady(fence)).toBe(true);
}

describe('usePdfViewerLoadingState', () => {
    it('hides the loading overlay after a failed load leaves no document', () => {
        const harness = createHarness();
        harness.pdfDocument.value = null;

        expect(harness.state.isViewerLoadingOverlayVisible.value).toBe(false);
        harness.scope.stop();
    });

    it('accepts only the current generation and revision committed by the open surface', () => {
        const harness = createHarness();
        const staleGeneration = beginSurface(harness, 'load:1');
        const staleFence = commitPage(harness, staleGeneration, 'load:1', 1);
        const currentGeneration = beginSurface(harness, 'load:2');

        expect(harness.openSurface.markReady(staleFence)).toBe(false);
        expect(harness.state.isViewerLoadingOverlayVisible.value).toBe(true);

        const currentFence = commitPage(harness, currentGeneration, 'load:2', 1, 2);
        markReady(harness, currentFence);
        expect(harness.state.isViewerLoadingOverlayVisible.value).toBe(false);
        harness.scope.stop();
    });

    it('waits for the current page when early navigation supersedes the opening page', () => {
        const harness = createHarness();
        const generation = beginSurface(harness, 'load:1');
        expect(harness.openSurface.requestNavigation(2, 0)).not.toBeNull();
        harness.currentPage.value = 2;

        expect(harness.openSurface.createRenderFence({
            generation,
            documentRevision: 'load:1',
            renderVersion: 1,
            requestId: 1,
            pageNumber: 1,
        })).toBeNull();
        expect(harness.state.isViewerLoadingOverlayVisible.value).toBe(true);

        const currentFence = commitPage(harness, generation, 'load:1', 2, 2);
        markReady(harness, currentFence);
        expect(harness.state.isViewerLoadingOverlayVisible.value).toBe(false);
        harness.scope.stop();
    });

    it('becomes pending again when navigation advances beyond the committed page', () => {
        const harness = createHarness();
        const generation = beginSurface(harness, 'load:1');
        markReady(harness, commitPage(harness, generation, 'load:1', 1));
        expect(harness.state.isViewerLoadingOverlayVisible.value).toBe(false);

        expect(harness.openSurface.requestNavigation(2, 0)).not.toBeNull();
        harness.currentPage.value = 2;
        expect(harness.state.isViewerLoadingOverlayVisible.value).toBe(true);

        markReady(harness, commitPage(harness, generation, 'load:1', 2, 2));
        expect(harness.state.isViewerLoadingOverlayVisible.value).toBe(false);
        harness.scope.stop();
    });
});
