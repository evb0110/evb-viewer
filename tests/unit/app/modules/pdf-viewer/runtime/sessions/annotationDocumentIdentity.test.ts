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
import type {IAnnotationCommentSummary} from '@app/types/annotations';
import type { TPdfSource } from '@app/types/pdfUi';
import type { PDFDocumentProxy } from 'pdfjs-dist';

vi.mock('@app/services/pdfjs/getPdfjsViewerRuntimeProbeFailures', () => ({
    EventBus: vi.fn(),
    GenericL10n: vi.fn(),
}));

const {
    createPdfAnnotationSession,
    resolveAnnotationSnapshotDocumentIdentity,
} = await import(
    '@app/modules/pdf-viewer/runtime/sessions/createPdfAnnotationSession'
);

const lastModified = 1_735_689_600_000;

function createPick(bytes: Uint8Array<ArrayBuffer>) {
    return new File([bytes], 'shared-name.pdf', {lastModified});
}

function createPlacedImageComment(annotationId: string): IAnnotationCommentSummary {
    return {
        source: 'pdf',
        id: annotationId,
        stableKey: 'nm:placed-image-session-1',
        pageIndex: 0,
        pageNumber: 1,
        text: '',
        subtype: 'Stamp',
        author: null,
        createdAt: null,
        modifiedAt: null,
        color: null,
        uid: null,
        annotationId,
        annotationName: 'placed-image-session-1',
        hasNote: false,
        markerRect: {
            left: 0.1,
            top: 0.2,
            width: 0.3,
            height: 0.4,
        },
    };
}

const mountedSessions: Array<() => void> = [];

afterEach(() => {
    mountedSessions.splice(0).forEach(unmount => unmount());
});

function mountAnnotationSession(initial: {
    originalPath?: string | null;
    workingCopyPath?: string | null;
    src?: TPdfSource | null;
} = {}) {
    const originalPath = ref<string | null>(initial.originalPath ?? null);
    const workingCopyPath = ref<string | null>(initial.workingCopyPath ?? null);
    const src = shallowRef<TPdfSource | null>(initial.src ?? null);
    const pdfDocument = shallowRef<PDFDocumentProxy | null>(null);
    const emitAnnotationComments = vi.fn();
    let session: ReturnType<typeof createPdfAnnotationSession> | undefined;
    const host = document.createElement('div');
    document.body.append(host);
    const AnnotationSessionHost = defineComponent({ setup() {
        session = createPdfAnnotationSession({
            document: {
                pdfDocument,
                numPages: ref(0),
                registerDisposable: vi.fn(),
                subscribe: vi.fn(() => vi.fn()),
                captureFence: vi.fn(() => ({
                    loadToken: 0,
                    documentVersion: 0,
                    documentRevision: null,
                    openSurfaceGeneration: 0,
                })),
                isCurrent: vi.fn(() => true),
            },
            viewport: {
                currentPage: ref(1),
                visibleRange: computed(() => ({
                    start: 1,
                    end: 1,
                })),
                scale: {effectiveScale: computed(() => 1)},
                scroll: {updateVisibleRange: vi.fn()},
                singlePageScroll: {scrollToPage: vi.fn()},
            },
            rendering: {
                attachAnnotationProjection: vi.fn(() => vi.fn()),
                hideManagedAnnotationEditors: vi.fn(),
                invalidatePages: vi.fn(),
                isPageRendered: vi.fn(() => false),
                renderAnnotationEditorLayerForPage: vi.fn(),
                renderVisiblePages: vi.fn(),
                renderedPageStateVersion: ref(0),
            },
            viewerContainer: ref(null),
            originalPath: computed(() => originalPath.value),
            src: computed(() => src.value),
            sourcePdfData: computed(() => null),
            workingCopyPath: computed(() => workingCopyPath.value),
            documentRevisionToken: computed(() => null),
            isAnySaving: computed(() => false),
            isActive: computed(() => true),
            bufferPages: computed(() => 1),
            annotationTool: computed(() => 'none'),
            annotationCursorMode: computed(() => false),
            annotationKeepActive: computed(() => false),
            annotationSettings: computed(() => null),
            authorName: computed(() => null),
            stopDrag: vi.fn(),
            clearPendingImagePlacement: vi.fn(),
            emitAnnotationModified: vi.fn(),
            emitAnnotationState: vi.fn(),
            emitAnnotationComments,
            emitAnnotationEnrichmentState: vi.fn(),
            emitAnnotationInventory: vi.fn(),
            emitAnnotationOpenNote: vi.fn(),
            emitAnnotationContextMenu: vi.fn(),
            emitAnnotationToolAutoReset: vi.fn(),
            emitAnnotationSetting: vi.fn(),
            emitAnnotationCommentClick: vi.fn(),
            emitAnnotationToolCancel: vi.fn(),
            emitAnnotationNotePlacementChange: vi.fn(),
            emitShapeContextMenu: vi.fn(),
        } as never);
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
        originalPath,
        workingCopyPath,
        src,
        pdfDocument,
        emitAnnotationComments,
        storeDocumentKey: () => activeSession.annotationApplication.value.documentKey,
        snapshotDocumentKey: () => resolveAnnotationSnapshotDocumentIdentity({
            originalPath: originalPath.value,
            workingCopyPath: workingCopyPath.value,
            source: src.value,
        }),
        canonicalAnnotationIds: () => activeSession.annotationApplication.value.store
            .list()
            .map(entity => entity.identity.id),
        ingest: (id: string) => activeSession.annotationApplication.value.store.createTextMarkup({
            kind: 'text-markup',
            identity: {id: asAnnotationId(id)},
            pageIndex: 0,
            revision: 0,
            persistedRevision: -1,
            deleted: false,
            createdAt: null,
            modifiedAt: null,
            author: null,
            subtype: 'Highlight',
            contents: 'note',
            selectedText: null,
            quadPoints: [{
                left: 0.1,
                top: 0.2,
                width: 0.3,
                height: 0.04,
            }],
            color: '#ffff00',
            opacity: 1,
        }),
        syncPlacedImages: (annotationIds: readonly string[]) => activeSession.annotationCommentModel
            .applyFromSync(annotationIds.map(createPlacedImageComment)),
        projectedComments: () => activeSession.annotationApplication.value.listCommentSummaries(),
        hasCanonicalChanges: () => activeSession.hasCanonicalAnnotationChanges(),
        deleteEmbeddedAnnotationDeferred: (comment: IAnnotationCommentSummary) =>
            activeSession.annotationMutationService.deleteEmbeddedAnnotationDeferred(comment),
    };
}

describe('annotation document identity', () => {
    it('keys the canonical store on the working copy while the snapshot keeps the original path', () => {
        const harness = mountAnnotationSession({
            originalPath: '/documents/original.pdf',
            workingCopyPath: '/managed/working.pdf',
            src: {
                kind: 'path',
                path: '/managed/working.pdf',
                size: 4,
            },
        });

        expect(harness.storeDocumentKey()).toBe('path:/managed/working.pdf');
        expect(harness.snapshotDocumentKey()).toBe('source:/documents/original.pdf');
    });

    it('rebuilds the canonical store for a new working copy and keeps it across an original-path change', async () => {
        const harness = mountAnnotationSession({
            originalPath: '/documents/original.pdf',
            workingCopyPath: '/managed/working.pdf',
            src: {
                kind: 'path',
                path: '/managed/working.pdf',
                size: 4,
            },
        });
        harness.ingest('editor-highlight');

        expect(harness.canonicalAnnotationIds()).toHaveLength(1);

        harness.originalPath.value = '/documents/renamed.pdf';
        await nextTick();

        // The snapshot cache follows the document the user opened; the
        // canonical store follows the bytes PDF.js currently holds.
        expect(harness.snapshotDocumentKey()).toBe('source:/documents/renamed.pdf');
        expect(harness.storeDocumentKey()).toBe('path:/managed/working.pdf');
        expect(harness.canonicalAnnotationIds()).toHaveLength(1);

        harness.emitAnnotationComments.mockClear();
        harness.workingCopyPath.value = '/managed/other-working.pdf';
        await nextTick();

        expect(harness.storeDocumentKey()).toBe('path:/managed/other-working.pdf');
        expect(harness.canonicalAnnotationIds()).toHaveLength(0);
        expect(harness.emitAnnotationComments).toHaveBeenCalledWith([]);
    });

    it('separates picks that share a name, a size and a timestamp', async () => {
        const first = createPick(Uint8Array.of(1, 2, 3, 4));
        const second = createPick(Uint8Array.of(5, 6, 7, 8));
        const harness = mountAnnotationSession({src: first});

        expect(second).toMatchObject({
            name: first.name,
            size: first.size,
            lastModified: first.lastModified,
        });

        const firstKey = harness.storeDocumentKey();
        harness.ingest('editor-highlight');

        expect(firstKey).not.toContain(first.name);
        expect(harness.canonicalAnnotationIds()).toHaveLength(1);

        harness.src.value = second;
        await nextTick();

        expect(harness.storeDocumentKey()).not.toBe(firstKey);
        expect(harness.canonicalAnnotationIds()).toHaveLength(0);

        harness.src.value = first;
        await nextTick();

        expect(harness.storeDocumentKey()).toBe(firstKey);
    });

    it('leaves placed-image summaries to the canonical parser during a hard reopen', async () => {
        const harness = mountAnnotationSession({
            originalPath: '/documents/original.pdf',
            workingCopyPath: '/managed/working.pdf',
            src: {
                kind: 'path',
                path: '/managed/working.pdf',
                size: 4,
            },
        });
        const firstDocument = {
            fingerprints: ['first'],
            numPages: 1,
        } as PDFDocumentProxy;
        const reopenedDocument = {
            fingerprints: ['reopened'],
            numPages: 1,
        } as PDFDocumentProxy;

        harness.syncPlacedImages(['44R']);
        expect(harness.canonicalAnnotationIds()).toEqual([]);
        expect(harness.projectedComments()).toEqual([]);
        expect(harness.hasCanonicalChanges()).toBe(false);

        harness.pdfDocument.value = firstDocument;
        await nextTick();
        harness.pdfDocument.value = null;
        await nextTick();
        harness.pdfDocument.value = reopenedDocument;
        await nextTick();

        harness.syncPlacedImages(['91R']);
        expect(harness.canonicalAnnotationIds()).toEqual([]);
        expect(harness.projectedComments()).toEqual([]);
        expect(harness.hasCanonicalChanges()).toBe(false);
    });

    it('fails closed on duplicate placed-image names through the production comment sync', () => {
        const harness = mountAnnotationSession({
            workingCopyPath: '/managed/working.pdf',
            src: {
                kind: 'path',
                path: '/managed/working.pdf',
                size: 4,
            },
        });

        harness.syncPlacedImages([
            '44R',
            '45R',
        ]);

        expect(harness.canonicalAnnotationIds()).toEqual([]);
        expect(harness.projectedComments()).toEqual([]);
        expect(harness.hasCanonicalChanges()).toBe(false);
    });
});
