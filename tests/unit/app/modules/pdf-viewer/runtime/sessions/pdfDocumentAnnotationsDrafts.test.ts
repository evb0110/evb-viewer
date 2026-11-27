// @vitest-environment happy-dom
import {deriveSelectedTextForParsedHighlights} from '@app/modules/pdf-viewer/runtime/sessions/deriveSelectedTextForParsedHighlights';
import {setBrowserLogSink} from '@app/utils/browserLogger';
import {cast} from '@tests/helpers/cast';
import {existsSync} from 'node:fs';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {IPdfDocumentLoadPlan, TPdfDocumentView} from '@app/modules/pdf-viewer/runtime/sessions/pdfDocumentSession';
import {usePdfAnnotationEditorSurface} from '@app/modules/pdf-viewer/runtime/annotations/usePdfAnnotationEditorSurface';
import {DEFAULT_ANNOTATION_SETTINGS} from '@app/constants/annotationDefaults';
import type {IPdfAnnotationParseResult} from '@contracts/pdfAnnotationParseTypes';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';
import {isStaleRevisionError} from '@contracts/documentMutationErrors';
import {requirePageIndex} from '@contracts/pageNumbers';
import {describe, beforeEach, expect, it, vi} from 'vitest';
import {computed, effectScope, ref, shallowRef, nextTick} from 'vue';
import type {IAnnotationMarkerRect} from '@app/types/annotations';
import type {TPdfSource} from '@app/types/pdfUi';
import type {IPdfDocumentAnnotationsView} from '@app/modules/pdf-viewer/runtime/sessions/createPdfDocumentAnnotations';
import {createPdfDocumentAnnotations} from '@app/modules/pdf-viewer/runtime/sessions/createPdfDocumentAnnotations';
import {requireDocumentRef} from '@contracts/documentRef';
import {
    recordPdfDocumentLoadedRevision,
    readPdfDocumentOriginalAnnotationSource,
    releasePdfDocumentOriginalAnnotations,
} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentLoadedRevision';

vi.mock('@app/composables/useFailureToast', () => ({useFailureToast: () => ({presentNoticeToast: vi.fn()})}));

const {parsePdfAnnotations, createWorkingCopyFromPath, cleanupFile, getDocumentRevision, revisionPins} = vi.hoisted(() => ({
    parsePdfAnnotations: vi.fn(),
    createWorkingCopyFromPath: vi.fn(),
    cleanupFile: vi.fn(),
    getDocumentRevision: vi.fn(),
    // Desktop offers revision pins; a platform without them copies the document instead.
    revisionPins: {
        offered: false,
        pin: vi.fn(),
        release: vi.fn(),
    },
}));
vi.mock('@app/utils/platformDocuments', () => ({
    getDocumentWorkingCopyCapability: () => ({
        parsePdfAnnotations,
        createWorkingCopyFromPath,
        cleanupFile,
        ...(revisionPins.offered
            ? {
                  pinDocumentRevision: revisionPins.pin,
                  releasePinnedDocumentRevision: revisionPins.release,
              }
            : {}),
    }),
    getDocumentFilesCapability: () => ({getDocumentRevision}),
}));

/** A view whose editor holds at most one text box open; a clean editor shows no draft rectangle. */
function createEditorView() {
    const open = ref<{
        annotationId: string;
        rect: IAnnotationMarkerRect | null;
    } | null>(null);
    const view: IPdfDocumentAnnotationsView = {
        emitAnnotationState: () => {},
        emitAnnotationModified: () => {},
        document: cast<TPdfDocumentView>({}),
        originalPath: shallowRef(null),
        commitPendingDraftsForSave: () => {
            open.value = null;
        },
        isEditing: (annotationId) => open.value?.annotationId === annotationId,
        getTextBoxDraftRect: (annotationId) => (open.value?.annotationId === annotationId ? open.value.rect : null),
    };
    return {
        view,
        open,
    };
}

function createDocument() {
    return createPdfDocumentAnnotations({
        workingCopyPath: computed(() => requireDocumentRef('/managed/working.pdf')),
        source: computed(() => null),
        documentRevisionToken: computed(() => null),
    });
}

const rightRect = {
    left: 0.6,
    top: 0.2,
    width: 0.3,
    height: 0.1,
};

describe('text-box drafts of a document shown in two views', () => {
    it('reports a draft where the view editing it shows it, and forgets a detached view', () => {
        const document = createDocument();
        const left = createEditorView();
        const right = createEditorView();
        document.attachView(left.view);
        const detachRight = document.attachView(right.view);

        right.open.value = {
            annotationId: 'box-1',
            rect: rightRect,
        };
        document.setTextBoxDraft('box-1', 'typed in the right view');

        expect(document.getTextBoxDraftRect('box-1')).toEqual(rightRect);
        expect(document.textBoxDrafts.get('box-1')).toBe('typed in the right view');

        detachRight();
        expect(document.getTextBoxDraftRect('box-1')).toBeNull();
    });

    it('does not finish live text when another view only checks for an accepted completion', () => {
        const document = createDocument();
        const left = createEditorView();
        document.attachView(left.view);
        left.open.value = {
            annotationId: 'live-box',
            rect: rightRect,
        };
        document.setTextBoxDraft('live-box', 'Still typing');
        expect(document.getPendingTextCompletion()).toBeUndefined();
        expect(document.getTextBoxDraftRect('live-box')).toEqual(rightRect);
        expect(document.textBoxDrafts.get('live-box')).toBe('Still typing');
    });

    it('commits the draft another view has open before a second view edits the same box', async () => {
        const document = createDocument();
        const left = createEditorView();
        const right = createEditorView();
        document.attachView(left.view);
        document.attachView(right.view);
        left.open.value = {
            annotationId: 'box-1',
            rect: rightRect,
        };

        right.open.value = {
            annotationId: 'box-1',
            rect: rightRect,
        };
        await document.commitDraftIfOpen('box-1', right.view);
        document.setTextBoxDraft('box-1', 'continued in the right view');

        expect(left.open.value).toBeNull();
        expect(document.getTextBoxDraftRect('box-1')).toEqual(rightRect);
        expect(document.textBoxDrafts.get('box-1')).toBe('continued in the right view');
    });

    it('commits an unchanged editor another view has open before a second view edits the same box', async () => {
        const document = createDocument();
        const left = createEditorView();
        const right = createEditorView();
        document.attachView(left.view);
        document.attachView(right.view);
        left.open.value = {
            annotationId: 'box-1',
            rect: null,
        };

        await document.commitDraftIfOpen('box-1', right.view);

        expect(left.open.value).toBeNull();
    });

    it('keeps a retiring editor responsible for its held draft until Save and a linked handoff can use it', async () => {
        const document = createDocument();
        const left = createEditorView();
        const right = createEditorView();
        const fit = Promise.withResolvers<undefined>();
        left.open.value = {
            annotationId: 'retiring-box',
            rect: rightRect,
        };
        document.setTextBoxDraft('retiring-box', 'Accepted while moving');
        left.view.commitPendingDraftsForSave = () =>
            fit.promise.then(() => {
                document.setTextBoxDraft('retiring-box', null);
                left.open.value = null;
            });
        const detach = document.attachView(left.view);
        document.attachView(right.view);
        const retiring = detach();
        let readyForStyle = false;
        const acceptedCompletion = Promise.resolve(document.getPendingTextCompletion()).then(() => {
            readyForStyle = true;
        });
        let saved = false;
        let handedOff = false;
        let saveFailure: unknown;
        const saving = document.commitPendingDraftsForSave().then(
            () => {
                saved = true;
            },
            (error: unknown) => {
                saved = true;
                saveFailure = error;
            },
        );
        const handoff = Promise.resolve(document.commitDraftIfOpen('retiring-box', right.view)).then(() => {
            handedOff = true;
        });
        try {
            await Promise.resolve();
            await Promise.resolve();
            expect(saved).toBe(false);
            expect(handedOff).toBe(false);
            expect(readyForStyle).toBe(false);
            expect(document.textBoxDrafts.get('retiring-box')).toBe('Accepted while moving');
            fit.resolve(undefined);
            await Promise.all([retiring, saving, handoff, acceptedCompletion]);
            expect(saved).toBe(true);
            expect(saveFailure).toBeUndefined();
            expect(handedOff).toBe(true);
            expect(readyForStyle).toBe(true);
            expect(document.textBoxDrafts.size).toBe(0);
            expect(document.getTextBoxDraftRect('retiring-box')).toBeNull();
        } finally {
            fit.resolve(undefined);
        }
    });

    it('keeps a rejected shared draft editable and refuses both Save and a linked editor handoff', async () => {
        const document = createDocument();
        const left = createEditorView();
        const right = createEditorView();
        const protection = Promise.withResolvers<undefined>();
        left.open.value = {
            annotationId: 'box-1',
            rect: rightRect,
        };
        document.setTextBoxDraft('box-1', 'Unprotected text');
        left.view.commitPendingDraftsForSave = () =>
            protection.promise.then(() => {
                left.open.value = null;
                document.setTextBoxDraft('box-1', null);
            });
        document.attachView(left.view);
        document.attachView(right.view);
        const saving = document.commitPendingDraftsForSave();
        const handingOff = document.commitDraftIfOpen('box-1', right.view);
        const saveRejected = expect(saving).rejects.toThrow('ENOSPC');
        const handoffRejected = expect(handingOff).rejects.toThrow('ENOSPC');
        expect(document.getTextBoxDraftRect('box-1')).toEqual(rightRect);
        expect(document.textBoxDrafts.get('box-1')).toBe('Unprotected text');
        protection.reject(new Error('ENOSPC'));
        await Promise.all([saveRejected, handoffRejected]);
        expect(document.getTextBoxDraftRect('box-1')).toEqual(rightRect);
        expect(document.textBoxDrafts.get('box-1')).toBe('Unprotected text');
    });
});

describe('writer annotations shared by linked views', () => {
    const initialRevision = requireDocumentRevisionToken('drt1:shared-writer-1');
    const nextRevision = requireDocumentRevisionToken('drt1:shared-writer-2');
    beforeEach(() => {
        parsePdfAnnotations.mockReset();
        createWorkingCopyFromPath.mockReset();
        cleanupFile.mockReset();
        getDocumentRevision.mockReset().mockResolvedValue({token: initialRevision});
        revisionPins.offered = false;
        revisionPins.pin.mockReset();
        revisionPins.release.mockReset().mockResolvedValue(undefined);
    });
    function parsed(text: string, revision = initialRevision): IPdfAnnotationParseResult {
        return {
            documentRevisionToken: revision,
            pageCount: 1,
            foreign: [],
            entities: [
                {
                    kind: 'text-box',
                    pageIndex: requirePageIndex(0),
                    objectNumber: 11,
                    generationNumber: 0,
                    name: 'imported-box',
                    author: null,
                    createdAt: null,
                    modifiedAt: null,
                    text,
                    rect: {
                        left: 0.1,
                        top: 0.2,
                        width: 0.3,
                        height: 0.1,
                    },
                    rotation: 0,
                    fontSize: 12,
                    color: '#336699',
                },
            ],
        };
    }
    function setup() {
        const revision = shallowRef(initialRevision);
        const workingCopyPath = shallowRef<string | null>(requireDocumentRef('/managed/working.pdf'));
        const annotations = createPdfDocumentAnnotations({
            workingCopyPath,
            source: computed(() => null),
            documentRevisionToken: revision,
        });
        const document = shallowRef<TPdfDocumentView['pdfDocument']['value']>(cast<TPdfDocumentView['pdfDocument']['value']>({}));
        let version = 1;
        let loadToken = 1;
        const resource = cast<TPdfDocumentView>({
            pdfDocument: document,
            captureFence: () => ({
                loadToken,
                documentVersion: version,
                documentRevision: revision.value,
                openSurfaceGeneration: 1,
            }),
        });
        return {
            annotations,
            workingCopyPath,
            revision,
            resource,
            document,
            replaceVersion: () => {
                version += 1;
            },
            detach: () => {
                loadToken += 1;
            },
        };
    }

    it('names the revision of the read that committed to the store, through a page change and a failed re-read', async () => {
        const {annotations, revision, resource, document, replaceVersion} = setup();
        const empty = (token: typeof initialRevision) => ({...parsed('unused', token), entities: []});
        const readRevision = () => annotations.application.value.store.readRevision;
        recordPdfDocumentLoadedRevision(document.value!, initialRevision);
        parsePdfAnnotations.mockResolvedValueOnce(empty(initialRevision));

        expect(readRevision()).toBeNull();
        await expect(annotations.feedStoreFromWriterParse(resource, shallowRef(null))).resolves.toBe(true);
        expect(readRevision()).toBe(initialRevision);

        // A rotation publishes other bytes; until their read commits, the geometry is the older read's.
        revision.value = nextRevision;
        document.value = cast<TPdfDocumentView['pdfDocument']['value']>({});
        recordPdfDocumentLoadedRevision(document.value!, nextRevision);
        replaceVersion();
        expect(readRevision()).toBe(initialRevision);
        parsePdfAnnotations.mockRejectedValueOnce(new Error('simulated failure'));
        await expect(annotations.feedStoreFromWriterParse(resource, shallowRef(null))).resolves.toBe(false);
        expect(readRevision()).toBe(initialRevision);
        parsePdfAnnotations.mockResolvedValueOnce(empty(nextRevision));
        await expect(annotations.feedStoreFromWriterParse(resource, shallowRef(null))).resolves.toBe(true);
        expect(readRevision()).toBe(nextRevision);
    });

    it('keeps the older read named when a re-read fails while keeping its original source', async () => {
        const {annotations, revision, resource, document, replaceVersion} = setup();
        recordPdfDocumentLoadedRevision(document.value!, initialRevision);
        parsePdfAnnotations.mockResolvedValueOnce(parsed('Old frame'));
        createWorkingCopyFromPath.mockResolvedValueOnce(requireDocumentRef('/managed/pinned.pdf'));
        await expect(annotations.feedStoreFromWriterParse(resource, shallowRef(null))).resolves.toBe(true);

        revision.value = nextRevision;
        document.value = cast<TPdfDocumentView['pdfDocument']['value']>({});
        recordPdfDocumentLoadedRevision(document.value!, nextRevision);
        replaceVersion();
        parsePdfAnnotations.mockResolvedValueOnce(parsed('New frame', nextRevision));
        createWorkingCopyFromPath.mockRejectedValueOnce(new Error('simulated failure'));
        await expect(annotations.feedStoreFromWriterParse(resource, shallowRef(null))).resolves.toBe(false);

        expect(annotations.application.value.listCommentSummaries().map((row) => row.text)).toEqual(['Old frame']);
        expect(annotations.application.value.store.readRevision).toBe(initialRevision);
    });

    it('joins the read of the document a view presents, and has none to join without one', async () => {
        const {annotations, resource, document} = setup();
        const {view} = createEditorView();
        expect(annotations.joinRead()).toBeNull();
        annotations.attachView({...view, document: resource});
        recordPdfDocumentLoadedRevision(document.value!, initialRevision);
        parsePdfAnnotations.mockResolvedValueOnce(parsed('Read on join'));

        await expect(annotations.joinRead()).resolves.toBe(true);
        expect(annotations.application.value.listCommentSummaries().map((row) => row.text)).toEqual(['Read on join']);
        expect(annotations.application.value.store.readRevision).toBe(initialRevision);
    });

    it('A1 review late original capture keeps current document readiness', async () => {
        const workingCopyPath = shallowRef(requireDocumentRef('/managed/A.pdf'));
        const revision = shallowRef(initialRevision);
        const session = shallowRef(1);
        const annotations = createPdfDocumentAnnotations({
            workingCopyPath,
            source: computed(() => ({kind: 'path' as const, path: workingCopyPath.value, size: 1})),
            documentRevisionToken: revision,
            documentSession: session,
        });
        const document = shallowRef(cast<TPdfDocumentView['pdfDocument']['value']>({}));
        let version = 1;
        const resource = cast<TPdfDocumentView>({
            pdfDocument: document,
            captureFence: () => ({
                loadToken: version,
                documentVersion: version,
                documentRevision: revision.value,
                openSurfaceGeneration: version,
            }),
        });
        const started = Promise.withResolvers<void>();
        const capture = Promise.withResolvers<ReturnType<typeof requireDocumentRef>>();
        createWorkingCopyFromPath.mockImplementationOnce(() => {
            started.resolve();
            return capture.promise;
        });
        const oldDocument = document.value!;
        recordPdfDocumentLoadedRevision(oldDocument, initialRevision);
        parsePdfAnnotations.mockResolvedValueOnce(parsed('Retired A')).mockResolvedValueOnce(parsed('Current B', nextRevision));
        const readingA = annotations.feedStoreFromWriterParse(resource, shallowRef(null));
        await started.promise;
        try {
            workingCopyPath.value = requireDocumentRef('/managed/B.pdf');
            revision.value = nextRevision;
            document.value = cast<TPdfDocumentView['pdfDocument']['value']>({});
            version += 1;
            session.value += 1;
            await annotations.feedStoreFromWriterParse(resource, shallowRef(null));
            expect(annotations.comments.value.map((row) => row.text)).toEqual(['Current B']);
            expect(annotations.commentsStatus.value).toBe('ready');
            capture.resolve(requireDocumentRef('/managed/snapshot-A.pdf'));
            await readingA;
            expect(annotations.comments.value.map((row) => row.text)).toEqual(['Current B']);
            expect(annotations.commentsStatus.value).toBe('ready');
        } finally {
            capture.resolve(requireDocumentRef('/managed/snapshot-A.pdf'));
            await readingA;
            await releasePdfDocumentOriginalAnnotations(oldDocument);
        }
    });

    it('A1 review late retired read keeps current document readiness', async () => {
        const workingCopyPath = shallowRef(requireDocumentRef('/managed/A.pdf'));
        const revision = shallowRef(initialRevision);
        const session = shallowRef(1);
        const annotations = createPdfDocumentAnnotations({
            workingCopyPath,
            source: computed(() => ({kind: 'path' as const, path: workingCopyPath.value, size: 1})),
            documentRevisionToken: revision,
            documentSession: session,
        });
        const document = shallowRef(cast<TPdfDocumentView['pdfDocument']['value']>({}));
        let version = 1;
        const resource = cast<TPdfDocumentView>({
            pdfDocument: document,
            captureFence: () => ({
                loadToken: version,
                documentVersion: version,
                documentRevision: revision.value,
                openSurfaceGeneration: version,
            }),
        });
        const old = Promise.withResolvers<IPdfAnnotationParseResult>();
        parsePdfAnnotations.mockReturnValueOnce(old.promise).mockResolvedValueOnce(parsed('Current B', nextRevision));
        const readingA = annotations.feedStoreFromWriterParse(resource, shallowRef(null));
        workingCopyPath.value = requireDocumentRef('/managed/B.pdf');
        revision.value = nextRevision;
        document.value = cast<TPdfDocumentView['pdfDocument']['value']>({});
        version += 1;
        session.value += 1;
        await annotations.feedStoreFromWriterParse(resource, shallowRef(null));
        expect(annotations.comments.value.map((row) => row.text)).toEqual(['Current B']);
        expect(annotations.commentsStatus.value).toBe('ready');
        old.resolve(parsed('Retired A'));
        await readingA;
        expect(annotations.comments.value.map((row) => row.text)).toEqual(['Current B']);
        expect(annotations.commentsStatus.value).toBe('ready');
    });

    it('#1608 retains a failed annotation revision lookup cause', async () => {
        const retained: string[] = [];
        setBrowserLogSink((entry) => {
            if (entry.level === 'warn' || entry.level === 'error') {
                retained.push(JSON.stringify(entry));
            }
        });
        const annotations = createPdfDocumentAnnotations({
            workingCopyPath: computed(() => requireDocumentRef('/managed/working.pdf')),
            source: computed(() => null),
            documentRevisionToken: computed(() => null),
        });
        const resource = cast<TPdfDocumentView>({
            pdfDocument: shallowRef({}),
            captureFence: () => ({documentVersion: 1, documentRevision: null}),
        });
        getDocumentRevision.mockRejectedValueOnce(new Error('Annotation revision read EIO'));
        try {
            expect(await annotations.feedStoreFromWriterParse(resource, shallowRef(null))).toBe(false);
            expect(retained.join(' ')).toContain('Annotation revision read EIO');
        } finally {
            setBrowserLogSink(() => {});
        }
    });

    async function captureOriginalSource() {
        const directory = await mkdtemp(join(tmpdir(), 'annotation-source-capture-'));
        const snapshot = requireDocumentRef(join(directory, 'original.pdf'));
        const started = Promise.withResolvers<undefined>();
        const capture = Promise.withResolvers<typeof snapshot>();
        createWorkingCopyFromPath.mockImplementationOnce(async () => {
            await writeFile(snapshot, 'Immutable original appearance');
            started.resolve(undefined);
            return capture.promise;
        });
        cleanupFile.mockImplementation((path: string) => rm(path));
        const state = setup();
        const proxy = state.document.value!;
        recordPdfDocumentLoadedRevision(proxy, initialRevision);
        parsePdfAnnotations.mockResolvedValueOnce(parsed('Original text'));
        const loading = state.annotations.feedStoreFromWriterParse(state.resource, shallowRef(null));
        await started.promise;
        return {
            ...state,
            proxy,
            loading,
            snapshot,
            finish: () => capture.resolve(snapshot),
            dispose: async () => {
                capture.resolve(snapshot);
                await loading;
                await releasePdfDocumentOriginalAnnotations(proxy);
                await rm(directory, {
                    recursive: true,
                    force: true,
                });
            },
        };
    }

    it('waits for immutable original bytes before publishing the parsed Save baseline', async () => {
        const capture = await captureOriginalSource();
        try {
            expect(capture.annotations.application.value.listCommentSummaries()).toEqual([]);
            expect(await readFile(capture.snapshot, 'utf8')).toBe('Immutable original appearance');
            capture.finish();
            await capture.loading;
            expect(capture.annotations.application.value.listCommentSummaries().map((comment) => comment.text)).toEqual(['Original text']);
            expect(await readPdfDocumentOriginalAnnotationSource(capture.proxy)).toBe(capture.snapshot);
        } finally {
            await capture.dispose();
        }
        expect(existsSync(capture.snapshot)).toBe(false);
    });

    it('releases a late original copy after its PDF proxy retired during capture', async () => {
        const capture = await captureOriginalSource();
        try {
            capture.document.value = null;
            capture.revision.value = nextRevision;
            const retirement = releasePdfDocumentOriginalAnnotations(capture.proxy);
            expect(await readFile(capture.snapshot, 'utf8')).toBe('Immutable original appearance');
            capture.finish();
            await Promise.all([capture.loading, retirement]);
            expect(existsSync(capture.snapshot)).toBe(false);
            expect(capture.annotations.application.value.listCommentSummaries()).toEqual([]);
            expect(await readPdfDocumentOriginalAnnotationSource(capture.proxy)).toBeNull();
        } finally {
            await capture.dispose();
        }
    });

    it('pins the parsed revision instead of copying the document where the platform offers pins', async () => {
        revisionPins.offered = true;
        const pinned = requireDocumentRef('/app-temp/pinned-revisions/opened.pdf');
        revisionPins.pin.mockResolvedValueOnce(pinned);
        const {annotations, resource, document} = setup();
        const proxy = document.value!;
        recordPdfDocumentLoadedRevision(proxy, initialRevision);
        parsePdfAnnotations.mockResolvedValueOnce(parsed('Original text'));

        await expect(annotations.feedStoreFromWriterParse(resource, shallowRef(null))).resolves.toBe(true);

        expect(revisionPins.pin).toHaveBeenCalledWith(requireDocumentRef('/managed/working.pdf'), initialRevision);
        expect(createWorkingCopyFromPath).not.toHaveBeenCalled();
        expect(await readPdfDocumentOriginalAnnotationSource(proxy)).toBe(pinned);
        expect(revisionPins.release).not.toHaveBeenCalled();
        await releasePdfDocumentOriginalAnnotations(proxy);
        expect(revisionPins.release).toHaveBeenCalledWith(pinned);
    });

    it('releases a pin at once when the document moved on while it was made', async () => {
        revisionPins.offered = true;
        const pinned = requireDocumentRef('/app-temp/pinned-revisions/retired.pdf');
        const {annotations, resource, document, revision} = setup();
        const proxy = document.value!;
        revisionPins.pin.mockImplementationOnce(async () => {
            revision.value = nextRevision;
            return pinned;
        });
        recordPdfDocumentLoadedRevision(proxy, initialRevision);
        parsePdfAnnotations.mockResolvedValueOnce(parsed('Original text'));

        await expect(annotations.feedStoreFromWriterParse(resource, shallowRef(null))).resolves.toBe(false);

        expect(revisionPins.release).toHaveBeenCalledWith(pinned);
        expect(createWorkingCopyFromPath).not.toHaveBeenCalled();
        expect(await readPdfDocumentOriginalAnnotationSource(proxy)).toBeNull();
        expect(annotations.application.value.listCommentSummaries()).toEqual([]);
    });

    it('leaves original appearance source unavailable without copying when pinning rejects with SOURCE_BACKING_CHANGED', async () => {
        revisionPins.offered = true;
        revisionPins.pin.mockRejectedValueOnce(
            Object.assign(new Error('The original document changed after it was opened'), {code: 'SOURCE_BACKING_CHANGED'}),
        );
        const {annotations, resource, document} = setup();
        const proxy = document.value!;
        recordPdfDocumentLoadedRevision(proxy, initialRevision);
        parsePdfAnnotations.mockResolvedValueOnce(parsed('Original text'));

        await expect(annotations.feedStoreFromWriterParse(resource, shallowRef(null))).resolves.toBe(false);

        expect(createWorkingCopyFromPath).not.toHaveBeenCalled();
        expect(await readPdfDocumentOriginalAnnotationSource(proxy)).toBeNull();
        expect(annotations.application.value.listCommentSummaries()).toEqual([]);
    });

    it('removes the copied bytes when their source revision cannot be verified', async () => {
        const capture = await captureOriginalSource();
        try {
            getDocumentRevision.mockRejectedValueOnce(new Error('Source revision unavailable'));
            capture.finish();
            await capture.loading;
            expect(existsSync(capture.snapshot)).toBe(false);
            expect(capture.annotations.application.value.listCommentSummaries()).toEqual([]);
        } finally {
            await capture.dispose();
        }
    });
    it.each([false, true])(
        'keeps accepted drafts across a Save As identity change and resets a real loaded replacement (save: %s)',
        async (duringSave) => {
            const {annotations, workingCopyPath, revision} = setup();
            const view = createEditorView();
            annotations.attachView(view.view);
            annotations.setTextBoxDraft('accepted-draft', 'Accepted while Save As finishes');
            const previous = annotations.application.value;
            workingCopyPath.value = requireDocumentRef('/managed/replacement.pdf');
            await nextTick();
            if (duringSave) {
                expect(annotations.textBoxDrafts.get('accepted-draft')).toBe('Accepted while Save As finishes');
            }
            annotations.replaceLoadedDocument(revision.value, duringSave);
            if (duringSave) {
                expect(annotations.application.value).toBe(previous);
                expect(annotations.textBoxDrafts.get('accepted-draft')).toBe('Accepted while Save As finishes');
            } else {
                expect(annotations.application.value).not.toBe(previous);
                expect(annotations.textBoxDrafts.size).toBe(0);
                expect(annotations.application.value.listCommentSummaries()).toEqual([]);
            }
        },
    );
    it('does not publish to the retired store when the source changes before a queued completion', async () => {
        const {annotations, resource, workingCopyPath} = setup();
        const retired = annotations.application.value;
        const pending = Promise.withResolvers<IPdfAnnotationParseResult>();
        parsePdfAnnotations.mockReturnValueOnce(pending.promise);
        const loading = annotations.feedStoreFromWriterParse(resource, shallowRef(null));
        pending.resolve(parsed('Retired source'));
        workingCopyPath.value = requireDocumentRef('/managed/replacement.pdf');
        await loading;
        await nextTick();
        expect(retired.listCommentSummaries()).toEqual([]);
        expect(annotations.application.value.listCommentSummaries()).toEqual([]);
    });
    it('ignores a retired original path before a deferred view refresh replaces the producer', async () => {
        const {annotations, resource, workingCopyPath} = setup();
        workingCopyPath.value = null;
        await nextTick();
        const originalPath = shallowRef('/source/original.pdf');
        const pending = Promise.withResolvers<IPdfAnnotationParseResult>();
        parsePdfAnnotations.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(parsed('Current original path'));
        const loading = annotations.feedStoreFromWriterParse(resource, originalPath);
        pending.resolve(parsed('Retired original path'));
        originalPath.value = '/source/replacement.pdf';
        await loading;
        expect(annotations.application.value.listCommentSummaries()).toEqual([]);
        await annotations.feedStoreFromWriterParse(resource, originalPath);
        expect(annotations.application.value.listCommentSummaries().map((comment) => comment.text)).toEqual(['Current original path']);
    });
    it('keeps an accepted local edit when a parse finishes after that edit', async () => {
        const {annotations, resource, replaceVersion} = setup();
        parsePdfAnnotations.mockResolvedValueOnce(parsed('Saved text'));
        await annotations.feedStoreFromWriterParse(resource, shallowRef(null));
        const initialSignal: AbortSignal = parsePdfAnnotations.mock.calls.at(-1)![1].signal;
        expect(initialSignal.aborted).toBe(false);
        replaceVersion();
        const pending = Promise.withResolvers<IPdfAnnotationParseResult>();
        parsePdfAnnotations.mockReturnValueOnce(pending.promise);
        const loading = annotations.feedStoreFromWriterParse(resource, shallowRef(null));
        const signal: AbortSignal = parsePdfAnnotations.mock.calls.at(-1)![1].signal;
        expect(signal.aborted).toBe(false);
        const id = annotations.application.value.store.list()[0]!.identity.id;
        annotations.application.value.store.updateTextBox(id, {text: 'Accepted local edit'});
        expect(signal.aborted).toBe(false);
        pending.resolve(parsed('Late saved baseline'));
        expect(await loading).toBe(true);
        expect(annotations.application.value.listCommentSummaries().map((comment) => comment.text)).toEqual(['Accepted local edit']);
    });
    it('reads the saved revision a partial store needs after a save the loaded document predates', async () => {
        const {annotations, revision, resource} = setup();
        const loadedBeforeSave = cast<TPdfDocumentView>({
            ...resource,
            captureFence: () => ({
                ...resource.captureFence(),
                documentRevision: initialRevision,
            }),
        });
        revision.value = nextRevision;
        parsePdfAnnotations.mockResolvedValue(parsed('Saved revision', nextRevision));
        expect(await annotations.feedStoreFromWriterParse(loadedBeforeSave, shallowRef(null))).toBe(false);
        expect(parsePdfAnnotations).not.toHaveBeenCalled();
        expect(await annotations.feedStoreFromWriterParse(loadedBeforeSave, shallowRef(null), true)).toBe(true);
        expect(annotations.application.value.listCommentSummaries().map((comment) => comment.text)).toEqual(['Saved revision']);
        expect(await annotations.feedStoreFromWriterParse(loadedBeforeSave, shallowRef(null), true)).toBe(false);
        expect(parsePdfAnnotations).toHaveBeenCalledTimes(1);
    });
    it('reads the saved revision into a partial store when a save finishes', async () => {
        const isSaving = shallowRef(false);
        const revision = shallowRef(initialRevision);
        const annotations = createPdfDocumentAnnotations({
            workingCopyPath: computed(() => requireDocumentRef('/managed/working.pdf')),
            source: computed(() => null),
            documentRevisionToken: revision,
            isSaving,
        });
        const {view} = createEditorView();
        const loaded = cast<TPdfDocumentView>({
            pdfDocument: shallowRef(cast<TPdfDocumentView['pdfDocument']['value']>({})),
            pendingPageMutationRevisionSwap: null,
            captureFence: () => ({
                loadToken: 1,
                documentVersion: 1,
                documentRevision: initialRevision,
                openSurfaceGeneration: 1,
            }),
        });
        annotations.attachView({
            ...view,
            document: loaded,
        });
        parsePdfAnnotations.mockResolvedValue(parsed('Saved revision', nextRevision));
        isSaving.value = true;
        revision.value = nextRevision;
        await nextTick();
        expect(parsePdfAnnotations).not.toHaveBeenCalled();
        isSaving.value = false;
        await nextTick();
        expect(parsePdfAnnotations).toHaveBeenCalledOnce();
        // A later reader joins the read the finished save started.
        await annotations.feedStoreFromWriterParse(loaded, shallowRef(null), true);
        expect(parsePdfAnnotations).toHaveBeenCalledOnce();
        expect(annotations.application.value.listCommentSummaries().map((comment) => comment.text)).toEqual(['Saved revision']);
    });
    it('allows a later caller to import after a rejected producer without automatically retrying', async () => {
        const {annotations, resource} = setup();
        parsePdfAnnotations
            .mockRejectedValueOnce(new Error('Injected parser failure'))
            .mockResolvedValueOnce(parsed('Later caller imported text'));
        await annotations.feedStoreFromWriterParse(resource, shallowRef(null));
        expect(annotations.application.value.listCommentSummaries()).toEqual([]);
        await annotations.feedStoreFromWriterParse(resource, shallowRef(null));
        expect(annotations.application.value.listCommentSummaries().map((comment) => comment.text)).toEqual(['Later caller imported text']);
    });
    it('refuses a Save that joined a re-read that failed and keeps the edit made during it', async () => {
        const {annotations, resource, replaceVersion} = setup();
        parsePdfAnnotations.mockResolvedValueOnce(parsed('Saved text'));
        await annotations.feedStoreFromWriterParse(resource, shallowRef(null));
        replaceVersion();
        const failing = Promise.withResolvers<IPdfAnnotationParseResult>();
        parsePdfAnnotations.mockReturnValueOnce(failing.promise);
        const reading = annotations.feedStoreFromWriterParse(resource, shallowRef(null));
        const id = annotations.application.value.store.list()[0]!.identity.id;
        annotations.application.value.store.updateTextBox(id, {text: 'Typed during the read'});
        const saving = annotations.commitPendingDraftsForSave({joinRead: true});
        failing.reject(new Error('Injected parser failure'));
        await expect(saving).rejects.toSatisfy(isStaleRevisionError);
        expect(await reading).toBe(false);
        expect(annotations.application.value.listCommentSummaries().map((comment) => comment.text)).toEqual(['Typed during the read']);

        replaceVersion();
        parsePdfAnnotations.mockResolvedValueOnce(parsed('Saved text'));
        void annotations.feedStoreFromWriterParse(resource, shallowRef(null));
        await expect(annotations.commitPendingDraftsForSave({joinRead: true})).resolves.toBeUndefined();
    });
    it('admits the ready document after an earlier view has no current revision fence', async () => {
        const {annotations, resource} = setup();
        parsePdfAnnotations.mockResolvedValueOnce(parsed('Ready document'));
        const pendingView = cast<TPdfDocumentView>({
            ...resource,
            captureFence: () => ({
                ...resource.captureFence(),
                documentRevision: null,
            }),
        });
        await annotations.feedStoreFromWriterParse(pendingView, shallowRef(null));
        await annotations.feedStoreFromWriterParse(resource, shallowRef(null));
        expect(annotations.application.value.listCommentSummaries().map((comment) => comment.text)).toEqual(['Ready document']);
    });
    it('publishes imported text after the first view detaches while another view is waiting', async () => {
        const {annotations, resource, detach} = setup();
        const pending = Promise.withResolvers<IPdfAnnotationParseResult>();
        parsePdfAnnotations.mockReturnValueOnce(pending.promise);
        const first = annotations.feedStoreFromWriterParse(resource, shallowRef(null));
        detach();
        const second = annotations.feedStoreFromWriterParse(resource, shallowRef(null));
        pending.resolve(parsed('Imported text for both views'));
        await Promise.all([first, second]);
        expect(annotations.application.value.listCommentSummaries().map((comment) => comment.text)).toEqual([
            'Imported text for both views',
        ]);
    });
    it('keeps replacement revision text when the superseded producer ignores cancellation', async () => {
        const {annotations, revision, resource} = setup();
        const old = Promise.withResolvers<IPdfAnnotationParseResult>();
        parsePdfAnnotations.mockReturnValueOnce(old.promise).mockResolvedValueOnce(parsed('Current revision', nextRevision));
        const previous = annotations.feedStoreFromWriterParse(resource, shallowRef(null));
        revision.value = nextRevision;
        await annotations.feedStoreFromWriterParse(resource, shallowRef(null));
        old.resolve(parsed('Superseded revision'));
        await previous;
        expect(annotations.application.value.listCommentSummaries().map((comment) => comment.text)).toEqual(['Current revision']);
    });
    it('lists a store no read settled for as loading, an empty read as ready, and keeps the list through a re-read', async () => {
        const source = shallowRef<TPdfSource | null>({
            kind: 'path',
            path: requireDocumentRef('/managed/working.pdf'),
            size: 1,
        });
        const annotations = createPdfDocumentAnnotations({
            workingCopyPath: computed(() => requireDocumentRef('/managed/working.pdf')),
            source,
            documentRevisionToken: computed(() => initialRevision),
        });
        let version = 1;
        const resource = cast<TPdfDocumentView>({
            pdfDocument: shallowRef(cast<TPdfDocumentView['pdfDocument']['value']>({})),
            captureFence: () => ({
                loadToken: 1,
                documentVersion: version,
                documentRevision: initialRevision,
                openSurfaceGeneration: 1,
            }),
        });
        const listed = () => annotations.comments.value.map((comment) => comment.text);
        expect(annotations.commentsStatus.value).toBe('loading');
        expect(listed()).toEqual([]);

        const emptyRead = Promise.withResolvers<IPdfAnnotationParseResult>();
        parsePdfAnnotations.mockReturnValueOnce(emptyRead.promise);
        const reading = annotations.feedStoreFromWriterParse(resource, shallowRef(null));
        expect(annotations.commentsStatus.value).toBe('loading');
        emptyRead.resolve({
            ...parsed('unused'),
            entities: [],
        });
        await reading;
        expect(annotations.commentsStatus.value).toBe('ready');
        expect(listed()).toEqual([]);

        // A reload reads the document again. The read store stays ready and
        // lists what it holds until the new read reconciles it.
        version += 1;
        const reread = Promise.withResolvers<IPdfAnnotationParseResult>();
        parsePdfAnnotations.mockReturnValueOnce(reread.promise);
        const rereading = annotations.feedStoreFromWriterParse(resource, shallowRef(null));
        expect(annotations.commentsStatus.value).toBe('ready');
        reread.resolve(parsed('Imported after reload'));
        await rereading;
        expect(listed()).toEqual(['Imported after reload']);
        expect(annotations.commentsStatus.value).toBe('ready');

        source.value = null;
        expect(listed()).toEqual([]);
        expect(annotations.commentsStatus.value).toBe('loading');
    });
    it('paints no rotated page from the previous rotation until the store is read for the rotated document', async () => {
        const {annotations, resource, document, revision, replaceVersion} = setup();
        let plan: IPdfDocumentLoadPlan = {
            isReload: false,
            isSelectiveReload: false,
            pagesToInvalidate: null,
            preserveVisibleContent: false,
            preservePageStructure: false,
        };
        Object.defineProperty(resource, 'activeLoadPlan', {get: () => plan});
        const scope = effectScope();
        const surface = scope.run(() =>
            usePdfAnnotationEditorSurface({
                annotationApplication: annotations.application,
                entitiesByPage: annotations.entitiesByPage,
                paintsPage: (pageIndex) => annotations.paintsPage(resource, pageIndex),
                activeTool: computed(() => 'select'),
                settings: computed(() => DEFAULT_ANNOTATION_SETTINGS),
            }),
        )!;
        // The native parser projects geometry for each page's rotation.
        const read = (left: number, at = initialRevision): IPdfAnnotationParseResult => {
            const [box] = parsed('Rotated page', at).entities;
            return {
                ...parsed('Rotated page', at),
                pageCount: 2,
                entities: [
                    {...box!, rect: {...(box as {rect: IAnnotationMarkerRect}).rect, left}},
                    {...box!, name: 'unrotated-page-box', objectNumber: 12, pageIndex: requirePageIndex(1), text: 'Unrotated page'},
                ],
            } as IPdfAnnotationParseResult;
        };
        // Each page reads its entities through a cached computed, as the editor layer does.
        const pages = [0, 1].map((pageIndex) =>
            computed(() => surface.getEntitiesForPage(pageIndex).map((entity) => (entity as {rect: IAnnotationMarkerRect}).rect.left)),
        );
        const painted = (pageIndex: number) => pages[pageIndex]!.value;
        parsePdfAnnotations.mockResolvedValueOnce(read(0.1));
        await annotations.feedStoreFromWriterParse(resource, shallowRef(null));
        expect(painted(0)).toEqual([0.1]);

        // Rotating page 1 writes a revision and presents a new PDF.js document.
        plan = {
            isReload: true,
            isSelectiveReload: true,
            pagesToInvalidate: [1],
            preserveVisibleContent: true,
            preservePageStructure: true,
            preservePageMetrics: true,
            rotationDelta: 90,
        };
        revision.value = nextRevision;
        replaceVersion();
        document.value = cast<TPdfDocumentView['pdfDocument']['value']>({});
        expect(painted(0)).toEqual([]);
        expect(painted(1)).toEqual([0.1]);
        // The store keeps the entity; only its paint waits for the rotated geometry.
        expect(annotations.entitiesByPage.value.get(0)?.length).toBe(1);

        const rotatedRead = Promise.withResolvers<IPdfAnnotationParseResult>();
        parsePdfAnnotations.mockReturnValueOnce(rotatedRead.promise);
        const reading = annotations.feedStoreFromWriterParse(resource, shallowRef(null));
        expect(painted(0)).toEqual([]);
        rotatedRead.resolve(read(0.6, nextRevision));
        await reading;
        expect(painted(0)).toEqual([0.6]);
        scope.stop();
    });
    it('refreshes a replacement document version without retaining its old imported projection', async () => {
        const {annotations, resource, replaceVersion} = setup();
        parsePdfAnnotations.mockResolvedValueOnce(parsed('Before replacement')).mockResolvedValueOnce(parsed('After replacement'));
        await annotations.feedStoreFromWriterParse(resource, shallowRef(null));
        expect(annotations.application.value.listCommentSummaries().map((comment) => comment.text)).toEqual(['Before replacement']);
        replaceVersion();
        await annotations.feedStoreFromWriterParse(resource, shallowRef(null));
        expect(annotations.application.value.listCommentSummaries().map((comment) => comment.text)).toEqual(['After replacement']);
    });
});

it('#1608 retains the cause of failed imported highlight preview text', async () => {
    const retained: string[] = [];
    setBrowserLogSink((entry) => {
        if (entry.level === 'warn' || entry.level === 'error') {
            retained.push(JSON.stringify(entry));
        }
    });
    try {
        const text = await deriveSelectedTextForParsedHighlights({
            documentSession: cast<Parameters<typeof deriveSelectedTextForParsedHighlights>[0]['documentSession']>({
                leasePage: async () => {
                    throw new Error('Imported highlight text stream corrupt');
                },
            }),
            result: cast<Parameters<typeof deriveSelectedTextForParsedHighlights>[0]['result']>({
                entities: [
                    {
                        kind: 'highlight',
                        pageIndex: 0,
                        objectNumber: 11,
                        generationNumber: 0,
                        subtype: 'Highlight',
                        quadPoints: [],
                    },
                ],
            }),
            transition: {isCurrent: () => true},
        });
        expect(text?.get('11 0 R')).toBeNull();
        expect(retained.join(' ')).toContain('Imported highlight text stream corrupt');
    } finally {
        setBrowserLogSink(() => {});
    }
});
