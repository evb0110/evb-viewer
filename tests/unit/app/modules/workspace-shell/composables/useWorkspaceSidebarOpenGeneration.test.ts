import {
    computed,
    effectScope,
    ref,
} from 'vue';
import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';
import { useWorkspaceSidebarOpenGeneration } from '@app/modules/workspace-shell/composables/useWorkspaceSidebarOpenGeneration';
import { useDocumentOpenVisualSettle } from '@app/modules/workspace-shell/composables/useDocumentOpenVisualSettle';
import {
    createDocumentOpenSurfaceSession,
    type IDocumentOpenSurfaceSession,
    type IDocumentOpenSurfaceSnapshot,
} from '@app/modules/document-viewer/runtime/documentOpenSurfaceSession';

// Every harness owns a Vue effect scope. Stopping it in an `afterEach` rather
// than at the end of each test keeps the watchers of a failed assertion from
// outliving it and reacting to the next test's refs.
const activeScopes: Array<ReturnType<typeof effectScope>> = [];

function createTrackedScope() {
    const scope = effectScope();
    activeScopes.push(scope);
    return scope;
}

type TSurfacePhase = IDocumentOpenSurfaceSnapshot['phase'];

function createSurfaceSnapshot(phase: TSurfacePhase, generation = 1) {
    return {
        generation,
        identity: {
            documentId: '/documents/current.pdf',
            documentRevision: `open-intent:${String(generation)}`,
        },
        phase,
        presentation: phase === 'ready' ? 'committed' : phase === 'failed' ? 'failed' : 'idle',
        geometry: null,
        openingPageGeometry: null,
        openingPageFrame: null,
        committedRender: null,
        committedViewport: null,
        failure: null,
    } satisfies IDocumentOpenSurfaceSnapshot;
}

function createHarness(overrides: {
    initialDocumentVisualReady?: boolean;
    isOpeningDocumentForToolbar?: boolean;
    sidebarPresentationEnabled?: boolean;
    surfacePhase?: TSurfacePhase;
} = {}) {
    const sidebarPresentationEnabled = ref(overrides.sidebarPresentationEnabled ?? true);
    const isOpeningDocumentForToolbar = ref(overrides.isOpeningDocumentForToolbar ?? false);
    const initialDocumentVisualReady = ref(overrides.initialDocumentVisualReady ?? true);
    const hasDocumentOpenError = ref(false);
    const surfacePhase = ref<TSurfacePhase>(overrides.surfacePhase ?? 'ready');
    const surfaceGeneration = ref(1);
    const scope = createTrackedScope();
    const session = scope.run(() => useWorkspaceSidebarOpenGeneration({
        sidebarPresentationEnabled,
        isOpeningDocumentForToolbar,
        initialDocumentVisualReady,
        hasDocumentOpenError,
        openSurfaceSnapshot: computed(() => createSurfaceSnapshot(
            surfacePhase.value,
            surfaceGeneration.value,
        )),
    }))!;

    return {
        hasDocumentOpenError,
        initialDocumentVisualReady,
        isOpeningDocumentForToolbar,
        session,
        sidebarPresentationEnabled,
        surfaceGeneration,
        surfacePhase,
    };
}

const SURFACE_GEOMETRY = {
    width: 612,
    height: 792,
    margin: 20,
};

const DOCUMENT_IDENTITY = {
    documentId: '/documents/current.pdf',
    documentRevision: 'revision-1',
};

function stageSurfaceRender(surface: IDocumentOpenSurfaceSession, generation: number) {
    expect(surface.commitGeometry(generation, SURFACE_GEOMETRY)).toBe(true);
    const fence = surface.createRenderFence({
        generation,
        documentRevision: DOCUMENT_IDENTITY.documentRevision,
        renderVersion: 1,
        requestId: 1,
        pageNumber: 1,
    });
    expect(fence).not.toBeNull();
    expect(surface.commitCanvas(fence!)).toBe(true);
    expect(surface.commitViewport({
        generation,
        documentRevision: DOCUMENT_IDENTITY.documentRevision,
        viewportIntentId: fence!.viewportIntentId,
        documentGeometryRevision: 1,
        interactionEpoch: 0,
        pageNumber: 1,
        left: 0,
        top: 0,
    })).toBe(true);
    return fence!;
}

/**
 * Drives the sidebar gate from a real open surface, with initial visual
 * readiness derived the way the workspace derives it, so a generation that is
 * no longer the surface owner cannot be faked into releasing suspension.
 */
function createGenerationHarness() {
    const sidebarPresentationEnabled = ref(true);
    const isOpeningDocumentForToolbar = ref(false);
    const hasDocumentOpenError = ref(false);
    const surface = createDocumentOpenSurfaceSession();
    const scope = createTrackedScope();
    const harness = scope.run(() => {
        const settle = useDocumentOpenVisualSettle({
            pdfSrc: ref({path: DOCUMENT_IDENTITY.documentId}),
            pdfDocument: ref({}),
            totalPages: ref(1),
            isLoading: ref(false),
            pdfError: ref(null),
            djvuError: ref(null),
            showDjvuSource: ref(false),
            openSurface: surface,
        });
        const session = useWorkspaceSidebarOpenGeneration({
            sidebarPresentationEnabled,
            isOpeningDocumentForToolbar,
            initialDocumentVisualReady: settle.initialDocumentVisualReady,
            hasDocumentOpenError,
            openSurfaceSnapshot: surface.snapshot,
        });
        return {
            session,
            settle,
        };
    })!;

    return {
        ...harness,
        hasDocumentOpenError,
        isOpeningDocumentForToolbar,
        sidebarPresentationEnabled,
        surface,
    };
}

describe('useWorkspaceSidebarOpenGeneration', () => {
    afterEach(() => {
        for (const scope of activeScopes.splice(0)) {
            scope.stop();
        }
    });

    it('hides the previous sidebar as soon as a staged open claims the surface', () => {
        const harness = createHarness();

        expect(harness.session.toolbarShowSidebarForDisplay.value).toBe(true);

        harness.isOpeningDocumentForToolbar.value = true;
        harness.initialDocumentVisualReady.value = false;
        harness.surfacePhase.value = 'pending';

        expect(harness.session.toolbarShowSidebarForDisplay.value).toBe(false);
    });

    it('shows a sidebar from a remounted workspace once that generation committed its viewport', () => {
        const harness = createHarness({
            initialDocumentVisualReady: false,
            isOpeningDocumentForToolbar: true,
            surfacePhase: 'viewport-committed',
        });

        expect(harness.session.toolbarShowSidebarForDisplay.value).toBe(true);
    });

    it('honors an explicit sidebar open during the current document generation', () => {
        const harness = createHarness({sidebarPresentationEnabled: false});

        harness.isOpeningDocumentForToolbar.value = true;
        harness.initialDocumentVisualReady.value = false;
        harness.surfacePhase.value = 'pending';
        expect(harness.session.toolbarShowSidebarForDisplay.value).toBe(false);

        harness.sidebarPresentationEnabled.value = true;

        expect(harness.session.toolbarShowSidebarForDisplay.value).toBe(true);
    });

    it('keeps the sidebar hidden through the whole open, not only while the picker is pending', () => {
        const harness = createHarness();

        harness.isOpeningDocumentForToolbar.value = true;
        harness.initialDocumentVisualReady.value = false;
        harness.surfacePhase.value = 'pending';
        // The staged source is mounted, so the placeholder flag drops long
        // before the new generation paints anything.
        harness.isOpeningDocumentForToolbar.value = false;
        harness.surfacePhase.value = 'geometry-committed';

        expect(harness.session.toolbarShowSidebarForDisplay.value).toBe(false);

        harness.surfacePhase.value = 'canvas-committed';
        expect(harness.session.toolbarShowSidebarForDisplay.value).toBe(false);
    });

    it('shows the sidebar once the claiming generation owns a committed visual surface', () => {
        const harness = createHarness();

        harness.isOpeningDocumentForToolbar.value = true;
        harness.initialDocumentVisualReady.value = false;
        harness.surfacePhase.value = 'pending';
        harness.isOpeningDocumentForToolbar.value = false;
        harness.surfacePhase.value = 'ready';
        harness.initialDocumentVisualReady.value = true;

        expect(harness.session.toolbarShowSidebarForDisplay.value).toBe(true);
    });

    it('restores the previous sidebar when the staged open turns out to be invalid', () => {
        const harness = createHarness();

        harness.isOpeningDocumentForToolbar.value = true;
        harness.initialDocumentVisualReady.value = false;
        harness.surfacePhase.value = 'pending';
        expect(harness.session.toolbarShowSidebarForDisplay.value).toBe(false);

        // Validation rejects the staged bytes. The previous document stays
        // mounted, so its sidebar has to come back.
        harness.isOpeningDocumentForToolbar.value = false;
        harness.hasDocumentOpenError.value = true;

        expect(harness.session.toolbarShowSidebarForDisplay.value).toBe(true);
    });

    it('restores the previous sidebar when the open surface itself reports failure', () => {
        const harness = createHarness();

        harness.isOpeningDocumentForToolbar.value = true;
        harness.initialDocumentVisualReady.value = false;
        harness.surfacePhase.value = 'pending';
        expect(harness.session.toolbarShowSidebarForDisplay.value).toBe(false);

        // The surface fails on its own, before the workspace ever raises an
        // open error, so the failed phase has to release suspension by itself.
        harness.isOpeningDocumentForToolbar.value = false;
        harness.surfacePhase.value = 'failed';

        expect(harness.hasDocumentOpenError.value).toBe(false);
        expect(harness.session.toolbarShowSidebarForDisplay.value).toBe(true);
    });

    it('restores the sidebar when a claimed open surface is abandoned without painting', () => {
        const harness = createHarness();

        harness.isOpeningDocumentForToolbar.value = true;
        harness.initialDocumentVisualReady.value = false;
        harness.surfacePhase.value = 'pending';
        harness.isOpeningDocumentForToolbar.value = false;
        harness.surfacePhase.value = 'idle';

        expect(harness.session.toolbarShowSidebarForDisplay.value).toBe(true);
    });

    it('never presents a sidebar the user has closed', () => {
        const harness = createHarness({sidebarPresentationEnabled: false});

        expect(harness.session.toolbarShowSidebarForDisplay.value).toBe(false);

        harness.isOpeningDocumentForToolbar.value = true;
        harness.initialDocumentVisualReady.value = false;
        harness.surfacePhase.value = 'pending';
        expect(harness.session.toolbarShowSidebarForDisplay.value).toBe(false);

        harness.isOpeningDocumentForToolbar.value = false;
        harness.surfacePhase.value = 'ready';
        harness.initialDocumentVisualReady.value = true;
        expect(harness.session.toolbarShowSidebarForDisplay.value).toBe(false);
    });

    it('keeps the sidebar suspended when a superseded open completes late, and releases it only for the claiming generation', () => {
        const harness = createGenerationHarness();

        // The document is open and settled, so its sidebar is presented.
        harness.isOpeningDocumentForToolbar.value = true;
        const firstGeneration = harness.surface.begin(DOCUMENT_IDENTITY);
        harness.isOpeningDocumentForToolbar.value = false;
        const supersededFence = stageSurfaceRender(harness.surface, firstGeneration);
        expect(harness.surface.markReady(supersededFence)).toBe(true);
        expect(harness.session.toolbarShowSidebarForDisplay.value).toBe(true);

        // Reopening the same path claims the surface again. Identity and
        // revision are unchanged, so only the generation separates the settled
        // document from the one now opening.
        harness.isOpeningDocumentForToolbar.value = true;
        const secondGeneration = harness.surface.begin(DOCUMENT_IDENTITY);
        harness.isOpeningDocumentForToolbar.value = false;
        expect(secondGeneration).toBeGreaterThan(firstGeneration);
        expect(harness.settle.initialDocumentVisualReady.value).toBe(false);
        expect(harness.session.toolbarShowSidebarForDisplay.value).toBe(false);

        // The superseded generation's readiness and failure both arrive late.
        // Neither owns the surface any more, so neither may hand the sidebar
        // back before the claiming generation has painted anything.
        expect(harness.surface.markReady(supersededFence)).toBe(false);
        expect(harness.surface.reject(supersededFence, 'superseded')).toBe(false);
        expect(harness.surface.snapshot.value.phase).not.toBe('ready');
        expect(harness.surface.snapshot.value.phase).not.toBe('failed');
        expect(harness.settle.initialDocumentVisualReady.value).toBe(false);
        expect(harness.session.toolbarShowSidebarForDisplay.value).toBe(false);

        // Only the claiming generation's own terminal state releases it.
        const claimingFence = stageSurfaceRender(harness.surface, secondGeneration);
        expect(harness.session.toolbarShowSidebarForDisplay.value).toBe(false);
        expect(harness.surface.markReady(claimingFence)).toBe(true);

        expect(harness.settle.initialDocumentVisualReady.value).toBe(true);
        expect(harness.session.toolbarShowSidebarForDisplay.value).toBe(true);
    });

    it('releases the sidebar when the claiming generation itself fails', () => {
        const harness = createGenerationHarness();

        harness.isOpeningDocumentForToolbar.value = true;
        const firstGeneration = harness.surface.begin(DOCUMENT_IDENTITY);
        harness.isOpeningDocumentForToolbar.value = false;
        const supersededFence = stageSurfaceRender(harness.surface, firstGeneration);
        expect(harness.surface.markReady(supersededFence)).toBe(true);

        harness.isOpeningDocumentForToolbar.value = true;
        const secondGeneration = harness.surface.begin(DOCUMENT_IDENTITY);
        harness.isOpeningDocumentForToolbar.value = false;
        const claimingFence = stageSurfaceRender(harness.surface, secondGeneration);
        expect(harness.session.toolbarShowSidebarForDisplay.value).toBe(false);

        // The surface reports the failure itself; the workspace never raises an
        // open error, so the failed phase has to release suspension on its own.
        expect(harness.surface.reject(claimingFence, 'parser refused the file')).toBe(true);

        expect(harness.surface.snapshot.value.phase).toBe('failed');
        expect(harness.hasDocumentOpenError.value).toBe(false);
        expect(harness.session.toolbarShowSidebarForDisplay.value).toBe(true);
    });

    it('does not re-suspend a settled sidebar when a resident canvas is evicted mid-session', () => {
        const harness = createHarness();

        // A budget eviction drops initial visual readiness without any open
        // claiming the surface. The sidebar still describes this document.
        harness.initialDocumentVisualReady.value = false;

        expect(harness.session.toolbarShowSidebarForDisplay.value).toBe(true);
    });
});
