// @vitest-environment happy-dom

import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    computed,
    createApp,
    defineComponent,
    h,
    nextTick,
    ref,
    shallowRef,
} from 'vue';
import type {PDFDocumentProxy} from 'pdfjs-dist';
import {asAnnotationId} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import type {INoteEntity} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import type {TPdfDocumentSession} from '@app/modules/pdf-viewer/runtime/sessions/pdfDocumentSession';
import type {TPdfViewportSession} from '@app/modules/pdf-viewer/runtime/sessions/createPdfViewportSession';
import type {TPdfRenderingSession} from '@app/modules/pdf-viewer/runtime/sessions/createPdfRenderingSession';
import { cast } from '@tests/helpers/cast';

vi.mock('@app/services/pdfjs/getPdfjsViewerRuntimeProbeFailures', () => ({
    EventBus: vi.fn(),
    GenericL10n: vi.fn(),
}));

const { createPdfAnnotationSession } = await import(
    '@app/modules/pdf-viewer/runtime/sessions/createPdfAnnotationSession'
);

const mountedSessions: Array<() => void> = [];

afterEach(() => {
    mountedSessions.splice(0).forEach(unmount => unmount());
});

function note(id: string): INoteEntity {
    return {
        kind: 'note',
        identity: {id: asAnnotationId(id)},
        pageIndex: 0,
        revision: 0,
        persistedRevision: -1,
        deleted: false,
        createdAt: 1,
        modifiedAt: 1,
        author: null,
        contents: '',
        position: {
            left: 0.1,
            top: 0.2,
            width: 0.02,
            height: 0.02,
        },
        color: '#ffff00',
        open: false,
    };
}

/** Enough of a proxy for identity comparisons; the session only swaps on it. */
function createDocumentProxy(fingerprint: string) {
    return cast<PDFDocumentProxy>({
        numPages: 1,
        fingerprints: [fingerprint],
    });
}

function mountAnnotationSession() {
    const pdfDocument = shallowRef<PDFDocumentProxy | null>(null);
    let session: ReturnType<typeof createPdfAnnotationSession> | undefined;
    const host = document.createElement('div');
    document.body.append(host);
    const AnnotationSessionHost = defineComponent({ setup() {
        session = createPdfAnnotationSession({
            // Only the three sibling sessions are cast: each is a wide surface
            // this fixture has no reason to stub whole. The options themselves
            // stay typed so a renamed or retyped option fails to compile here.
            document: cast<TPdfDocumentSession>({
                pdfDocument,
                numPages: ref(1),
                registerDisposable: vi.fn(),
                subscribe: vi.fn(() => vi.fn()),
                captureFence: vi.fn(() => ({
                    loadToken: 0,
                    documentVersion: 0,
                    documentRevision: null,
                    openSurfaceGeneration: 0,
                })),
                isCurrent: vi.fn(() => true),
            }),
            viewport: cast<TPdfViewportSession>({
                currentPage: ref(1),
                visibleRange: computed(() => ({
                    start: 1,
                    end: 1,
                })),
                scale: {effectiveScale: computed(() => 1)},
                scroll: {updateVisibleRange: vi.fn()},
                singlePageScroll: {scrollToPage: vi.fn()},
            }),
            rendering: cast<TPdfRenderingSession>({
                attachAnnotationProjection: vi.fn(() => vi.fn()),
                hideManagedAnnotationEditors: vi.fn(),
                invalidatePages: vi.fn(),
                isPageRendered: vi.fn(() => false),
                renderAnnotationEditorLayerForPage: vi.fn(),
                renderVisiblePages: vi.fn(),
                renderedPageStateVersion: ref(0),
            }),
            viewerContainer: ref(null),
            originalPath: computed(() => '/documents/original.pdf'),
            src: computed(() => ({
                kind: 'path',
                path: '/managed/working.pdf',
                size: 4,
            })),
            sourcePdfData: computed(() => null),
            workingCopyPath: computed(() => '/managed/working.pdf'),
            documentRevisionToken: computed(() => null),
            isAnySaving: computed(() => false),
            isActive: computed(() => true),
            bufferPages: computed(() => 1),
            annotationTool: computed(() => 'none'),
            annotationCursorMode: computed(() => false),
            annotationKeepActive: computed(() => false),
            annotationSettings: computed(() => null),
            authorName: computed(() => null),
            clearPendingImagePlacement: vi.fn(),
            emitAnnotationModified: vi.fn(),
            emitAnnotationState: vi.fn(),
            emitAnnotationComments: vi.fn(),
            emitAnnotationEnrichmentState: vi.fn(),
            emitAnnotationInventory: vi.fn(),
            emitAnnotationOpenNote: vi.fn(),
            emitAnnotationContextMenu: vi.fn(),
            emitAnnotationToolAutoReset: vi.fn(),
            emitAnnotationSetting: vi.fn(),
            emitAnnotationCommentClick: vi.fn(),
            emitShapeContextMenu: vi.fn(),
        });
        return () => h('div');
    } });
    const app = createApp(AnnotationSessionHost);
    app.mount(host);
    mountedSessions.push(() => {
        app.unmount();
        host.remove();
    });
    if (!session) {
        throw new Error('The annotation session host did not expose a session.');
    }
    const activeSession = session;
    return {
        pdfDocument,
        createNote: (id: string) => {
            activeSession.annotationApplication.value.store.createNote(note(id));
        },
        canUndo: () => activeSession.appAnnotationHistory.canUndo.value,
        canRedo: () => activeSession.appAnnotationHistory.canRedo.value,
        application: () => activeSession.annotationApplication.value,
        canonicalAnnotationIds: () => activeSession.annotationApplication.value.store
            .list()
            .map(entity => entity.identity.id),
    };
}

describe('annotation history across a document proxy swap', () => {
    it('clears annotation history when a structural page operation reloads the document', async () => {
        const harness = mountAnnotationSession();
        harness.pdfDocument.value = createDocumentProxy('before-page-op');
        await nextTick();

        harness.createNote('page-op-note');
        const applicationBeforeSwap = harness.application();

        expect(harness.canUndo()).toBe(true);
        expect(harness.canonicalAnnotationIds()).toHaveLength(1);

        // A page operation rewrites the working copy in place and reloads it:
        // the proxy is cleared, then a new one is published under the same path.
        harness.pdfDocument.value = null;
        await nextTick();
        harness.pdfDocument.value = createDocumentProxy('after-page-op');
        await nextTick();

        expect(harness.canUndo()).toBe(false);
        expect(harness.canRedo()).toBe(false);
        expect(harness.canonicalAnnotationIds()).toEqual([]);
        expect(harness.application()).not.toBe(applicationBeforeSwap);
    });

    it('keeps history when the first document of the session arrives', async () => {
        const harness = mountAnnotationSession();
        harness.createNote('pre-load-note');

        expect(harness.canUndo()).toBe(true);

        harness.pdfDocument.value = createDocumentProxy('first-load');
        await nextTick();

        expect(harness.canUndo()).toBe(true);
        expect(harness.canonicalAnnotationIds()).toHaveLength(1);
    });

    it('keeps history when a reload republishes the same document proxy', async () => {
        const harness = mountAnnotationSession();
        const loaded = createDocumentProxy('republished');
        harness.pdfDocument.value = loaded;
        await nextTick();
        harness.createNote('republished-note');

        harness.pdfDocument.value = null;
        await nextTick();
        harness.pdfDocument.value = loaded;
        await nextTick();

        expect(harness.canUndo()).toBe(true);
        expect(harness.canonicalAnnotationIds()).toHaveLength(1);
    });
});
