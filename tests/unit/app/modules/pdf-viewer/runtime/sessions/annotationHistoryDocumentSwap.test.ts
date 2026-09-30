import type {IPdfDocument} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
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
import {asAnnotationId} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import type {INoteEntity} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import type {TPdfDocumentSession} from '@app/modules/pdf-viewer/runtime/sessions/pdfDocumentSession';
import type {TPdfViewportSession} from '@app/modules/pdf-viewer/runtime/sessions/createPdfViewportSession';
import type {TPdfRenderingSession} from '@app/modules/pdf-viewer/runtime/sessions/createPdfRenderingSession';
import { cast } from '@tests/helpers/cast';
import {requirePageIndex} from '@contracts/pageNumbers';
import {requireEpochMs} from '@contracts/timestamps';
import {requireDocumentRef} from '@contracts/documentRef';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';
import type {TDocumentRevisionToken} from '@contracts/documentRevision';
import {
    createPdfDocumentAnnotations,
    pdfDocumentAnnotationsKey,
} from '@app/modules/pdf-viewer/runtime/sessions/createPdfDocumentAnnotations';
import type {TPdfDocumentAnnotations} from '@app/modules/pdf-viewer/runtime/sessions/createPdfDocumentAnnotations';

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
        pageIndex: requirePageIndex(0),
        revision: 0,
        persistedRevision: -1,
        deleted: false,
        createdAt: requireEpochMs(1),
        modifiedAt: requireEpochMs(1),
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
    return cast<IPdfDocument>({
        numPages: 1,
        fingerprints: [fingerprint],
    });
}

interface IMountAnnotationSessionOptions {
    /** The workspace document's owner every view of it shares. */
    documentAnnotations?: TPdfDocumentAnnotations;
    /** The working-copy revision of the bytes this view's PDF.js document holds. */
    loadedRevision?: {value: TDocumentRevisionToken | null};
}

function mountAnnotationSession(mountOptions: IMountAnnotationSessionOptions = {}) {
    const pdfDocument = shallowRef<IPdfDocument | null>(null);
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
                    documentRevision: mountOptions.loadedRevision?.value ?? null,
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
            originalPath: computed(() => requireDocumentRef('/documents/original.pdf')),
            src: computed(() => ({
                kind: 'path',
                path: requireDocumentRef('/managed/working.pdf'),
                size: 4,
            })),
            sourcePdfData: computed(() => null),
            workingCopyPath: computed(() => requireDocumentRef('/managed/working.pdf')),
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
    if (mountOptions.documentAnnotations) {
        app.provide(pdfDocumentAnnotationsKey, mountOptions.documentAnnotations);
    }
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

describe('annotation history shared by two views of one document', () => {
    function createSharedDocument() {
        const documentRevisionToken = ref<TDocumentRevisionToken | null>(requireDocumentRevisionToken('revision-1'));
        const documentAnnotations = createPdfDocumentAnnotations({
            workingCopyPath: computed(() => requireDocumentRef('/managed/working.pdf')),
            source: computed(() => null),
            documentRevisionToken,
        });
        const mountView = () => {
            const loadedRevision = {value: documentRevisionToken.value};
            const view = mountAnnotationSession({
                documentAnnotations,
                loadedRevision,
            });
            return {
                ...view,
                /** Publishes a new PDF.js document holding the given revision. */
                async reload(revision: TDocumentRevisionToken, fingerprint: string) {
                    loadedRevision.value = revision;
                    view.pdfDocument.value = null;
                    await nextTick();
                    view.pdfDocument.value = createDocumentProxy(fingerprint);
                    await nextTick();
                },
            };
        };
        return {
            documentRevisionToken,
            mountView,
        };
    }

    it('keeps edits made after a reload when the other view finishes loading the older revision late', async () => {
        const shared = createSharedDocument();
        const left = shared.mountView();
        const right = shared.mountView();
        left.pdfDocument.value = createDocumentProxy('left-first');
        right.pdfDocument.value = createDocumentProxy('right-first');
        await nextTick();
        left.createNote('before-reload');

        // A file-history undo rewrites the working copy; the left view loads it first.
        const nextRevision = requireDocumentRevisionToken('revision-2');
        shared.documentRevisionToken.value = nextRevision;
        await left.reload(nextRevision, 'left-second');
        expect(left.canonicalAnnotationIds()).toEqual([]);
        left.createNote('after-reload');

        // The right view's load of the replaced bytes lands afterwards.
        await right.reload(requireDocumentRevisionToken('revision-1'), 'right-stale');
        expect(right.canonicalAnnotationIds()).toEqual([asAnnotationId('after-reload')]);
        expect(right.canUndo()).toBe(true);

        // Its load of the current bytes keeps the store the left view started.
        await right.reload(nextRevision, 'right-second');
        expect(left.canonicalAnnotationIds()).toEqual([asAnnotationId('after-reload')]);
        expect(left.canUndo()).toBe(true);
        expect(left.application()).toBe(right.application());
    });

    it('shows an edit made in one view in the other, with its undo', async () => {
        const shared = createSharedDocument();
        const left = shared.mountView();
        const right = shared.mountView();

        left.createNote('left-note');

        expect(right.canonicalAnnotationIds()).toEqual([asAnnotationId('left-note')]);
        expect(right.canUndo()).toBe(true);
    });
});
