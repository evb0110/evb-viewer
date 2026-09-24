import {
    computed,
    effectScope,
    nextTick,
    ref,
} from 'vue';
import {
    describe,
    expect,
    it,
} from 'vitest';
import { useDocumentOpenVisualSettle } from '@app/modules/workspace-shell/composables/useDocumentOpenVisualSettle';
import {
    createDocumentOpenSurfaceSession,
    type IDocumentOpenSurfaceSnapshot,
} from '@app/modules/document-viewer/runtime/documentOpenSurfaceSession';

interface IHarnessOverrides {
    djvuError?: unknown;
    isLoading?: boolean;
    pdfDocument?: unknown;
    pdfError?: unknown;
    pdfSrc?: unknown;
    showDjvuSource?: boolean;
    totalPages?: number;
    openSurfaceSnapshot?: IDocumentOpenSurfaceSnapshot;
}

function createHarness(overrides: IHarnessOverrides = {}) {
    const pdfSrc = ref(overrides.pdfSrc ?? null);
    const pdfDocument = ref(overrides.pdfDocument ?? null);
    const totalPages = ref(overrides.totalPages ?? 0);
    const isLoading = ref(overrides.isLoading ?? false);
    const pdfError = ref(overrides.pdfError ?? null);
    const djvuError = ref(overrides.djvuError ?? null);
    const showDjvuSource = ref(overrides.showDjvuSource ?? false);
    const surfaceSession = createDocumentOpenSurfaceSession();
    const openSurface = overrides.openSurfaceSnapshot
        ? {
            snapshot: ref(overrides.openSurfaceSnapshot),
            viewportSession: surfaceSession.viewportSession,
            getDiagnosticHistory: () => [],
        }
        : surfaceSession;

    const settle = useDocumentOpenVisualSettle({
        pdfSrc,
        pdfDocument,
        totalPages,
        isLoading,
        pdfError,
        djvuError,
        showDjvuSource,
        openSurface,
    });

    return {
        djvuError,
        isLoading,
        pdfDocument,
        pdfError,
        pdfSrc,
        settle,
        surfaceSession,
        showDjvuSource,
        totalPages,
    };
}

function commitHarnessSurfaceReady(harness: ReturnType<typeof createHarness>) {
    const generation = harness.surfaceSession.begin({
        documentId: 'fixture.pdf',
        documentRevision: 'revision-1',
    });
    harness.surfaceSession.commitGeometry(generation, {
        width: 612,
        height: 792,
        margin: 20,
    });
    const fence = harness.surfaceSession.createRenderFence({
        generation,
        documentRevision: 'revision-1',
        renderVersion: 1,
        requestId: 1,
        pageNumber: 1,
    })!;
    harness.surfaceSession.commitCanvas(fence);
    harness.surfaceSession.commitViewport({
        generation,
        documentRevision: 'revision-1',
        viewportIntentId: fence.viewportIntentId,
        documentGeometryRevision: 1,
        interactionEpoch: 0,
        pageNumber: 1,
        left: 0,
        top: 0,
    });
    expect(harness.surfaceSession.markReady(fence)).toBe(true);
}

describe('useDocumentOpenVisualSettle', () => {
    it('settles a PDF only once its first page is on screen', () => {
        const harness = createHarness({
            pdfSrc: { path: 'fixture.pdf' },
            pdfDocument: {},
            totalPages: 1,
            isLoading: false,
        });
        expect(harness.settle.documentOpenAccepted.value).toBe(true);
        expect(harness.settle.documentOpenSettled.value).toBe(false);

        commitHarnessSurfaceReady(harness);

        expect(harness.settle.documentOpenSettled.value).toBe(true);
    });

    it('keeps document readiness latched while page navigation transitions within the same generation', async () => {
        const harness = createHarness({
            pdfSrc: {path: 'fixture.pdf'},
            pdfDocument: {},
            totalPages: 3,
            isLoading: false,
        });
        commitHarnessSurfaceReady(harness);
        expect(harness.settle.initialDocumentVisualReady.value).toBe(true);

        const initialGeneration = harness.surfaceSession.snapshot.value.generation;
        const pendingDocumentOpen = computed(() => !harness.settle.initialDocumentVisualReady.value);
        const scope = effectScope();

        harness.surfaceSession.metadataReady(3);
        harness.surfaceSession.requestNavigation(2);
        await nextTick();

        expect(harness.surfaceSession.viewportSession.value).toMatchObject({
            generation: initialGeneration,
            lifecycle: 'transitioning',
            requestedPage: 2,
        });
        expect(harness.surfaceSession.snapshot.value.generation).toBe(initialGeneration);
        expect(harness.settle.initialDocumentVisualReady.value).toBe(true);
        expect(pendingDocumentOpen.value).toBe(false);
        scope.stop();

        const nextGeneration = harness.surfaceSession.begin({
            documentId: 'second.pdf',
            documentRevision: 'revision-2',
        });
        expect(nextGeneration).toBeGreaterThan(initialGeneration);
        expect(harness.settle.initialDocumentVisualReady.value).toBe(false);
    });

    it('does not accept a PDF that is still loading', () => {
        const harness = createHarness({
            pdfSrc: { path: 'fixture.pdf' },
            pdfDocument: {},
            totalPages: 431,
            isLoading: true,
        });
        expect(harness.settle.documentOpenAccepted.value).toBe(false);

        harness.isLoading.value = false;

        expect(harness.settle.documentOpenAccepted.value).toBe(true);
        expect(harness.settle.documentOpenSettled.value).toBe(false);
    });

    it('settles immediately for document-open errors', () => {
        const harness = createHarness({
            pdfError: new Error('open failed'),
            showDjvuSource: true,
            isLoading: true,
        });

        expect(harness.settle.documentOpenAccepted.value).toBe(true);
        expect(harness.settle.documentOpenSettled.value).toBe(true);
    });
});
