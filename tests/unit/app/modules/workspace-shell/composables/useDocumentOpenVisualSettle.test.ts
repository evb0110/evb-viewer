import {
    computed,
    effectScope,
    nextTick,
    ref,
} from 'vue';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { useDocumentOpenVisualSettle } from '@app/modules/workspace-shell/composables/useDocumentOpenVisualSettle';
import {
    createDocumentOpenSurfaceSession,
    type IDocumentOpenSurfaceSnapshot,
} from '@app/modules/document-viewer/runtime/documentOpenSurfaceSession';

const mocks = vi.hoisted(() => ({browserWarn: vi.fn()}));

vi.mock('@app/utils/browserLogger', () => ({BrowserLogger: {warn: mocks.browserWarn}}));

interface IHarnessOverrides {
    djvuError?: unknown;
    hasPdf?: boolean;
    isLoading?: boolean;
    pageLabelsResolved?: boolean;
    pdfDocument?: unknown;
    pdfError?: unknown;
    pdfSrc?: unknown;
    showDjvuSource?: boolean;
    totalPages?: number;
    openSurfaceSnapshot?: IDocumentOpenSurfaceSnapshot;
}

function createHarness(overrides: IHarnessOverrides = {}) {
    const hasPdf = ref(overrides.hasPdf ?? false);
    const pdfSrc = ref(overrides.pdfSrc ?? null);
    const pdfDocument = ref(overrides.pdfDocument ?? null);
    const totalPages = ref(overrides.totalPages ?? 0);
    const pageLabelsResolved = ref(overrides.pageLabelsResolved ?? false);
    const isLoading = ref(overrides.isLoading ?? false);
    const pdfError = ref(overrides.pdfError ?? null);
    const djvuError = ref(overrides.djvuError ?? null);
    const showDjvuSource = ref(overrides.showDjvuSource ?? false);
    const markAnnotationCommentsLoading = vi.fn();
    const surfaceSession = createDocumentOpenSurfaceSession();
    const openSurface = overrides.openSurfaceSnapshot
        ? {
            snapshot: ref(overrides.openSurfaceSnapshot),
            viewportSession: surfaceSession.viewportSession,
            getDiagnosticHistory: () => [],
        }
        : surfaceSession;

    const settle = useDocumentOpenVisualSettle({
        tabId: 'tab-1',
        hasPdf,
        pdfSrc,
        pdfDocument,
        totalPages,
        pageLabelsResolved,
        isLoading,
        pdfError,
        djvuError,
        showDjvuSource,
        openSurface,
        markAnnotationCommentsLoading,
    });

    return {
        djvuError,
        hasPdf,
        isLoading,
        markAnnotationCommentsLoading,
        pageLabelsResolved,
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

async function flushSettleWatchers() {
    await nextTick();
    await Promise.resolve();
    await Promise.resolve();
}

function observeSettlement(promise: Promise<void>) {
    const settled = vi.fn();
    void promise.then(settled);
    return settled;
}

async function expectStillPending(settled: ReturnType<typeof vi.fn>) {
    await flushSettleWatchers();
    expect(settled).not.toHaveBeenCalled();
}

describe('useDocumentOpenVisualSettle', () => {
    beforeEach(() => {
        mocks.browserWarn.mockReset();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('keeps standard PDF behavior gated on initial visual readiness', async () => {
        const harness = createHarness({
            hasPdf: true,
            pdfSrc: { path: 'fixture.pdf' },
            pdfDocument: {},
            totalPages: 1,
            pageLabelsResolved: true,
            isLoading: false,
        });
        const settled = observeSettlement(harness.settle.waitForDocumentOpenSettled());

        await expectStillPending(settled);

        commitHarnessSurfaceReady(harness);

        await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce());
    });

    it('keeps document readiness latched while page navigation transitions within the same generation', async () => {
        const harness = createHarness({
            hasPdf: true,
            pdfSrc: {path: 'fixture.pdf'},
            pdfDocument: {},
            totalPages: 3,
            pageLabelsResolved: true,
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

    it('accepts a settled PDF document for routing without waiting for its first canvas', async () => {
        const harness = createHarness({
            hasPdf: true,
            pdfSrc: { path: 'fixture.pdf' },
            pdfDocument: {},
            totalPages: 431,
            pageLabelsResolved: true,
            isLoading: false,
        });
        const accepted = observeSettlement(harness.settle.waitForDocumentOpenSettled({acceptDocumentWithoutVisual: true}));
        const visual = observeSettlement(harness.settle.waitForDocumentOpenSettled());

        await vi.waitFor(() => expect(accepted).toHaveBeenCalledOnce());
        await expectStillPending(visual);

        commitHarnessSurfaceReady(harness);

        await vi.waitFor(() => expect(visual).toHaveBeenCalledOnce());
    });

    it('settles independently while optional page-label extraction never resolves', async () => {
        const harness = createHarness({
            hasPdf: true,
            pdfSrc: { path: 'fixture.pdf' },
            pdfDocument: {},
            totalPages: 1,
            pageLabelsResolved: false,
            isLoading: false,
        });
        const accepted = observeSettlement(harness.settle.waitForDocumentOpenSettled({acceptDocumentWithoutVisual: true}));
        const visual = observeSettlement(harness.settle.waitForDocumentOpenSettled());

        await vi.waitFor(() => expect(accepted).toHaveBeenCalledOnce());
        await expectStillPending(visual);

        commitHarnessSurfaceReady(harness);

        await vi.waitFor(() => expect(visual).toHaveBeenCalledOnce());
        expect(harness.pageLabelsResolved.value).toBe(false);
    });

    it('still settles immediately for document-open errors', async () => {
        const harness = createHarness({
            pdfError: new Error('open failed'),
            showDjvuSource: true,
            isLoading: true,
        });
        const settled = observeSettlement(harness.settle.waitForDocumentOpenSettled());

        await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce());
    });

    it('cancels the pending visual wait without waiting for its timeout', async () => {
        vi.useFakeTimers();
        const harness = createHarness({
            showDjvuSource: true,
            isLoading: true,
            totalPages: 1,
        });
        const abortController = new AbortController();
        const wait = harness.settle.waitForDocumentOpenSettled({signal: abortController.signal});

        await nextTick();
        abortController.abort(new DOMException('Tab closed', 'AbortError'));

        await expect(wait).rejects.toThrow('Tab closed');
        expect(mocks.browserWarn).not.toHaveBeenCalled();
    });

    it('rejects timeout waits without resolving the pending visual waiter', async () => {
        vi.useFakeTimers();
        const harness = createHarness({
            showDjvuSource: true,
            isLoading: true,
            totalPages: 1,
        });
        const wait = harness.settle.waitForDocumentOpenSettled();
        const rejection = expect(wait).rejects.toThrow('Document open visual settle timed out');

        await nextTick();
        await vi.advanceTimersByTimeAsync(30_000);
        await rejection;

        harness.isLoading.value = false;
        commitHarnessSurfaceReady(harness);

        await expect(harness.settle.waitForDocumentOpenSettled()).resolves.toBeUndefined();
    });

    it('reports the unmet initial visual gate and matching surface fences on timeout', async () => {
        vi.useFakeTimers();
        const harness = createHarness({
            hasPdf: true,
            pdfSrc: {path: 'fixture.pdf'},
            pdfDocument: {},
            totalPages: 1,
            isLoading: false,
            openSurfaceSnapshot: {
                generation: 3,
                identity: {
                    documentId: 'fixture.pdf',
                    documentRevision: 'revision-1',
                },
                phase: 'viewport-committed',
                presentation: 'page-shell',
                geometry: {
                    width: 612,
                    height: 792,
                    margin: 20,
                },
                openingPageGeometry: null,
                openingPageFrame: null,
                committedRender: {
                    generation: 3,
                    documentRevision: 'revision-1',
                    viewportIntentId: 'viewport-1',
                    renderVersion: 4,
                    requestId: 5,
                    pageNumber: 1,
                },
                committedViewport: {
                    generation: 3,
                    documentRevision: 'revision-1',
                    viewportIntentId: 'viewport-1',
                    documentGeometryRevision: 6,
                    interactionEpoch: 7,
                    pageNumber: 1,
                    left: 0,
                    top: 0,
                },
                failure: null,
            },
        });
        const wait = harness.settle.waitForDocumentOpenSettled();
        const rejection = expect(wait).rejects.toThrow('Document open visual settle timed out');

        await nextTick();
        await vi.advanceTimersByTimeAsync(30_000);
        await rejection;

        expect(mocks.browserWarn).toHaveBeenCalledWith(
            'recent-open',
            'Document open visual settle timed out',
            expect.objectContaining({
                initialVisualReady: false,
                openSurface: {
                    generation: 3,
                    phase: 'viewport-committed',
                    presentation: 'page-shell',
                    committedRender: {
                        pageNumber: 1,
                        documentRevision: 'revision-1',
                        renderVersion: 4,
                        requestId: 5,
                    },
                    committedViewport: {
                        pageNumber: 1,
                        documentRevision: 'revision-1',
                        viewportIntentId: 'viewport-1',
                        documentGeometryRevision: 6,
                        interactionEpoch: 7,
                    },
                },
            }),
        );
    });
});
