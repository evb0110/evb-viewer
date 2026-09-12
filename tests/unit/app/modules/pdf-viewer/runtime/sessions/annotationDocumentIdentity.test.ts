import type {IPdfDocument} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import { cast } from '@tests/helpers/cast';
import { createElectronPlatformApiFixture } from '@tests/helpers/createElectronPlatformApiFixture';
// @vitest-environment happy-dom

import { requireDocumentRef } from '@contracts/documentRef';
import { requireDocumentRevisionToken } from '@contracts/documentRevision';
import {requirePageIndex} from '@contracts/pageNumbers';
import {requireEpochMs} from '@contracts/timestamps';
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
    type Ref,
} from 'vue';
import {asAnnotationId} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import type {IAnnotationCommentSummary} from '@app/types/annotations';
import type {IPdfPlacedImageFinalizePayload} from '@app/types/pdfImagePlacement';
import type { TPdfSource } from '@app/types/pdfUi';
import type { IDocumentsFileIoCapability } from '@contracts/electronApiDocuments';
import type { IDocumentRevisionInfo } from '@contracts/documentRevision';
vi.mock('@app/services/pdfjs/getPdfjsViewerRuntimeProbeFailures', () => ({
    EventBus: vi.fn(),
    GenericL10n: vi.fn(),
}));

const revisionRead = vi.fn<IDocumentsFileIoCapability['getDocumentRevision']>();
const electronApi = createElectronPlatformApiFixture({documentFiles: {getDocumentRevision: revisionRead}});
vi.mock('@app/utils/platform', () => ({getPlatformAPI: () => electronApi}));

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
        pageIndex: requirePageIndex(0),
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
    authorName?: string | null;
    originalPath?: string | null;
    workingCopyPath?: string | null;
    src?: TPdfSource | null;
} = {}) {
    const originalPath = ref<string | null>(initial.originalPath ?? null);
    const workingCopyPath = ref<string | null>(initial.workingCopyPath ?? null);
    const src = shallowRef<TPdfSource | null>(initial.src ?? null);
    const pdfDocument = shallowRef<IPdfDocument | null>(null);
    const emitAnnotationComments = vi.fn();
    const viewRotation = ref<0 | 90 | 180 | 270>(0);
    let annotationProjectionReady: Ref<boolean> | undefined;
    let currentTransition = true;
    let session: ReturnType<typeof createPdfAnnotationSession> | undefined;
    const host = document.createElement('div');
    document.body.append(host);
    const AnnotationSessionHost = defineComponent({ setup() {
        session = createPdfAnnotationSession({
            document: {
                pdfDocument,
                numPages: ref(1),
                pageMetrics: ref([{
                    width: 600,
                    height: 800,
                    rotation: 0,
                }]),
                registerDisposable: vi.fn(),
                subscribe: vi.fn(() => vi.fn()),
                captureFence: vi.fn(() => ({
                    loadToken: 0,
                    documentVersion: 0,
                    documentRevision: null,
                    openSurfaceGeneration: 0,
                })),
                isCurrent: vi.fn(() => currentTransition),
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
                attachAnnotationProjection: vi.fn((options: {annotationProjectionReady: Ref<boolean>}) => {
                    annotationProjectionReady = options.annotationProjectionReady;
                    return vi.fn();
                }),
                hideManagedAnnotationEditors: vi.fn(),
                invalidatePages: vi.fn(),
                isPageRendered: vi.fn(() => false),
                renderAnnotationEditorLayerForPage: vi.fn(),
                renderVisiblePages: vi.fn(),
                renderedPageStateVersion: ref(0),
            },
            viewRotation: computed(() => viewRotation.value),
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
            authorName: computed(() => initial.authorName ?? null),
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
        session: activeSession,
        viewRotation,
        originalPath,
        workingCopyPath,
        src,
        pdfDocument,
        emitAnnotationComments,
        annotationProjectionReady: () => annotationProjectionReady?.value,
        invalidateCurrentTransition: () => {
            currentTransition = false;
        },
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
            pageIndex: requirePageIndex(0),
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
    it('does not publish readiness when a revision read resumes after its transition is stale', async () => {
        const revision = requireDocumentRevisionToken('revision-a');
        const revisionReadResult = Promise.withResolvers<IDocumentRevisionInfo>();
        revisionRead.mockReturnValue(revisionReadResult.promise);
        const harness = mountAnnotationSession({
            workingCopyPath: '/managed/working.pdf',
            src: {
                kind: 'path',
                path: requireDocumentRef('/managed/working.pdf'),
                size: 4,
            },
        });

        harness.pdfDocument.value = cast<IPdfDocument>({numPages: 1});
        await nextTick();
        expect(revisionRead).toHaveBeenCalledWith(requireDocumentRef('/managed/working.pdf'));
        expect(harness.annotationProjectionReady()).toBe(false);

        harness.invalidateCurrentTransition();
        revisionReadResult.resolve({
            token: revision,
            version: 1,
            documentRef: requireDocumentRef('/managed/working.pdf'),
            authority: 'electron-working-copy',
            contentRevision: 1,
            mintedAt: requireEpochMs(1),
        });
        await revisionReadResult.promise;
        await Promise.resolve();
        await nextTick();

        expect(harness.annotationProjectionReady()).toBe(false);
    });

    it('keys the canonical store on the working copy while the snapshot keeps the original path', () => {
        const harness = mountAnnotationSession({
            originalPath: '/documents/original.pdf',
            workingCopyPath: '/managed/working.pdf',
            src: {
                kind: 'path',
                path: requireDocumentRef('/managed/working.pdf'),
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
                path: requireDocumentRef('/managed/working.pdf'),
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
                path: requireDocumentRef('/managed/working.pdf'),
                size: 4,
            },
        });
        const firstDocument = cast<IPdfDocument>({
            fingerprints: ['first'],
            numPages: 1,
        });
        const reopenedDocument = cast<IPdfDocument>({
            fingerprints: ['reopened'],
            numPages: 1,
        });

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
                path: requireDocumentRef('/managed/working.pdf'),
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


function imagePlacement(overrides: Partial<IPdfPlacedImageFinalizePayload> = {}): IPdfPlacedImageFinalizePayload {
    return {
        pageNumber: 1,
        viewRotation: 0,
        x: 0.2,
        y: 0.2,
        width: 0.25,
        height: 0.125,
        rotationDegrees: 17,
        bytes: Uint8Array.of(1, 2, 3),
        sourcePixelWidth: 2,
        sourcePixelHeight: 1,
        mimeType: 'image/png',
        fileName: 'stamp.png',
        targetPixelWidth: 200,
        targetPixelHeight: 100,
        ...overrides,
    };
}

describe('canonical image placement', () => {
    it('creates and replaces images in the same undo history as unsaved text', async () => {
        const {session} = mountAnnotationSession();
        const store = session.annotationApplication.value.store;
        const text = session.annotationEditorSurface.createTextBoxAt(0, {
            left: 0.1,
            top: 0.1,
            width: 0.2,
            height: 0.1,
        }, {text: 'unsaved text'});
        expect(await session.finalizeImagePlacement(imagePlacement())).toBe(true);
        const image = store.list().find(entity => entity.kind === 'placed-image')!;
        expect(image).toMatchObject({
            rotation: 17,
            image: {
                kind: 'raster',
                dataBase64: 'AQID',
            },
        });
        expect(await session.finalizeImagePlacement(imagePlacement({
            appAnnotationId: image.identity.id,
            bytes: Uint8Array.of(4, 5, 6),
            rotationDegrees: 43,
        }))).toBe(true);
        expect(store.list()).toHaveLength(2);
        expect(store.get(image.identity.id)).toMatchObject({
            rotation: 43,
            image: {dataBase64: 'BAUG'},
        });
        await store.undo();
        expect(store.get(image.identity.id)).toMatchObject({
            rotation: 17,
            image: {dataBase64: 'AQID'},
        });
        await store.undo();
        expect(store.list().map(entity => entity.identity.id)).toEqual([text.identity.id]);
        await store.undo();
        expect(store.list()).toEqual([]);
        await store.redo();
        await store.redo();
        await store.redo();
        expect(store.get(text.identity.id)).toMatchObject({text: 'unsaved text'});
        expect(store.get(image.identity.id)).toMatchObject({
            rotation: 43,
            image: {dataBase64: 'BAUG'},
        });
    });

    it.each([
        {
            authorName: '  Image author  ',
            expected: 'Image author',
        },
        {
            authorName: '   ',
            expected: null,
        },
    ])('normalizes the new image author $authorName', async ({
        authorName,
        expected,
    }) => {
        const {session} = mountAnnotationSession({authorName});
        expect(await session.finalizeImagePlacement(imagePlacement())).toBe(true);
        expect(session.annotationApplication.value.store.list()[0]?.author).toBe(expected);
    });

    it.each([
        90,
        180,
    ] as const)('uses the draft coordinate rotation when the current view is %i', async currentViewRotation => {
        const {
            session,
            viewRotation,
        } = mountAnnotationSession();
        viewRotation.value = currentViewRotation;
        expect(await session.finalizeImagePlacement(imagePlacement({
            rotationDegrees: 25,
            viewRotation: 90,
        }))).toBe(true);
        const image = session.annotationApplication.value.store.list()[0];
        expect(image).toMatchObject({rotation: 295});
        if (image?.kind !== 'placed-image') throw new Error('Missing stamp');
        expect(image.rect.width * 600).toBeCloseTo(0.25 * 800);
        expect(image.rect.height * 800).toBeCloseTo(0.125 * 600);
    });

    it('does not mutate either document when the session changes during image encoding', async () => {
        const harness = mountAnnotationSession({workingCopyPath: '/managed/first.pdf'});
        const oldStore = harness.session.annotationApplication.value.store;
        const finalization = harness.session.finalizeImagePlacement(imagePlacement());
        harness.workingCopyPath.value = '/managed/second.pdf';
        await nextTick();
        expect(await finalization).toBe(false);
        expect(oldStore.list()).toEqual([]);
        expect(harness.session.annotationApplication.value.store.list()).toEqual([]);
    });

    it('leaves the store unchanged when an in-flight placement is canceled', async () => {
        const {session} = mountAnnotationSession();
        const controller = new AbortController();
        const finalization = session.finalizeImagePlacement(imagePlacement({signal: controller.signal}));
        controller.abort();
        expect(await finalization).toBe(false);
        expect(session.annotationApplication.value.store.list()).toEqual([]);
    });
});


describe('live canonical text box sidebar drafts', () => {
    it('reattaches a recovered inline draft to the active editor surface', () => {
        const source = mountAnnotationSession();
        const surface = source.session.annotationEditorSurface;
        const entity = surface.createTextBoxAt(0, {
            left: 0.1,
            top: 0.1,
            width: 0.2,
            height: 0.1,
        }, {text: 'Canonical'});
        surface.beginTextEditing(entity.identity.id);
        surface.setTextBoxDraftPending(entity.identity.id, 'Completed draft');

        const recovery = source.session.captureCanonicalAnnotationRecovery();
        const restored = mountAnnotationSession();
        const restoredSurface = restored.session.annotationEditorSurface;
        restored.session.restoreCanonicalAnnotationRecovery(recovery);

        expect(restored.session.annotationApplication.value.store.get(entity.identity.id))
            .toMatchObject({text: 'Canonical'});
        expect(restoredSurface.hasPendingTextBoxDrafts()).toBe(true);
        expect(restoredSurface.editingId.value).toBe(entity.identity.id);
        expect(restored.session.annotationCommentsCache.value[0]?.text).toBe('Completed draft');
    });

    it('projects each input and restores canonical text on cancel without mutating history', () => {
        const {
            session,
            emitAnnotationComments,
        } = mountAnnotationSession();
        const surface = session.annotationEditorSurface;
        const entity = surface.createTextBoxAt(0, {
            left: 0.1,
            top: 0.1,
            width: 0.2,
            height: 0.1,
        }, {text: 'Original'});
        surface.beginTextEditing(entity.identity.id);
        const epoch = session.annotationApplication.value.store.mutationEpoch;
        for (const text of [
            'Draft',
            'Текст العربية',
            '',
        ]) {
            surface.setTextBoxDraftPending(entity.identity.id, text);
            expect(session.annotationCommentsCache.value[0]?.text).toBe(text);
            expect(emitAnnotationComments.mock.lastCall?.[0][0]?.text).toBe(text);
        }
        expect(session.annotationApplication.value.listCommentSummaries()[0]?.text).toBe('Original');
        expect(session.annotationApplication.value.store.mutationEpoch).toBe(epoch);
        surface.endTextEditing(entity.identity.id, {cancelled: true});
        expect(session.annotationCommentsCache.value[0]?.text).toBe('Original');
        expect(emitAnnotationComments.mock.lastCall?.[0][0]?.text).toBe('Original');
    });

    it('replaces the draft with committed text and preserves undo', async () => {
        const {session} = mountAnnotationSession();
        const surface = session.annotationEditorSurface;
        const entity = surface.createTextBoxAt(0, {
            left: 0.1,
            top: 0.1,
            width: 0.2,
            height: 0.1,
        }, {text: 'Original'});
        surface.beginTextEditing(entity.identity.id);
        surface.setTextBoxDraftPending(entity.identity.id, 'Committed');
        surface.commitGesture(entity.identity.id, {text: 'Committed'});
        surface.endTextEditing(entity.identity.id);
        expect(session.annotationCommentsCache.value[0]?.text).toBe('Committed');
        await session.annotationApplication.value.store.undo();
        expect(session.annotationCommentsCache.value[0]?.text).toBe('Original');
    });

    it('drops a draft when the text box is deleted or the document is replaced', async () => {
        const harness = mountAnnotationSession();
        const {session} = harness;
        const surface = session.annotationEditorSurface;
        const entity = surface.createTextBoxAt(0, {
            left: 0.1,
            top: 0.1,
            width: 0.2,
            height: 0.1,
        }, {text: 'Original'});
        surface.setTextBoxDraftPending(entity.identity.id, 'Discarded');
        surface.deleteAnnotation(entity.identity.id);
        await session.annotationApplication.value.store.undo();
        expect(session.annotationCommentsCache.value[0]?.text).toBe('Original');
        surface.setTextBoxDraftPending(entity.identity.id, 'Previous document');
        harness.workingCopyPath.value = '/managed/different.pdf';
        await nextTick();
        session.annotationApplication.value.store.createTextBox(entity);
        expect(session.annotationCommentsCache.value[0]?.text).toBe('Original');
    });
});
