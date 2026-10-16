import {cast} from '@tests/helpers/cast';
import {existsSync} from 'node:fs';
import {
    mkdtemp, readFile, rm, writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {TPdfDocumentView} from '@app/modules/pdf-viewer/runtime/sessions/pdfDocumentSession';
import type {IPdfAnnotationParseResult} from '@contracts/pdfAnnotationParseTypes';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';
import {requirePageIndex} from '@contracts/pageNumbers';
import {
    describe,
    beforeEach,
    expect,
    it,
    vi,
} from 'vitest';
import {
    computed,
    ref,
    shallowRef,
    nextTick,
} from 'vue';
import type { IAnnotationMarkerRect } from '@app/types/annotations';
import type { IPdfDocumentAnnotationsView } from '@app/modules/pdf-viewer/runtime/sessions/createPdfDocumentAnnotations';
import { createPdfDocumentAnnotations } from '@app/modules/pdf-viewer/runtime/sessions/createPdfDocumentAnnotations';
import { requireDocumentRef } from '@contracts/documentRef';
import {
    recordPdfDocumentLoadedRevision, readPdfDocumentOriginalAnnotationSource, releasePdfDocumentOriginalAnnotations,
} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentLoadedRevision';

const {
    parsePdfAnnotations, createWorkingCopyFromPath, cleanupFile, getDocumentRevision,
} = vi.hoisted(() => ({
    parsePdfAnnotations: vi.fn(),
    createWorkingCopyFromPath: vi.fn(),
    cleanupFile: vi.fn(),
    getDocumentRevision: vi.fn(),
}));
vi.mock('@app/utils/platformDocuments', () => ({
    getDocumentWorkingCopyCapability: () => ({
        parsePdfAnnotations,
        createWorkingCopyFromPath,
        cleanupFile,
    }),
    getDocumentFilesCapability: () => ({getDocumentRevision}),
}));

/** A view whose editor holds at most one open text-box draft. */
function createEditorView() {
    const open = ref<{
        annotationId: string;
        rect: IAnnotationMarkerRect;
    } | null>(null);
    const view: IPdfDocumentAnnotationsView = {
        emitAnnotationState: () => {},
        emitAnnotationModified: () => {},
        onHistoryReplay: () => {},
        commitPendingDraftsForSave: () => {
            open.value = null;
        },
        getTextBoxDraftRect: annotationId => (open.value?.annotationId === annotationId ? open.value.rect : null),
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
        left.view.commitPendingDraftsForSave = () => fit.promise.then(() => {
            document.setTextBoxDraft('retiring-box', null);
            left.open.value = null;
        });
        const detach = document.attachView(left.view);
        document.attachView(right.view);
        const retiring = detach();
        let readyForStyle = false;
        const acceptedCompletion = Promise.resolve(document.getPendingTextCompletion()).then(() => {readyForStyle = true;});
        let saved = false;
        let handedOff = false;
        let saveFailure: unknown;
        const saving = document.commitPendingDraftsForSave().then(() => {saved = true;}, (error: unknown) => {saved = true; saveFailure = error;});
        const handoff = Promise.resolve(document.commitDraftIfOpen('retiring-box', right.view)).then(() => {handedOff = true;});
        try {
            await Promise.resolve();
            await Promise.resolve();
            expect(saved).toBe(false);
            expect(handedOff).toBe(false);
            expect(readyForStyle).toBe(false);
            expect(document.textBoxDrafts.get('retiring-box')).toBe('Accepted while moving');
            fit.resolve(undefined);
            await Promise.all([
                retiring,
                saving,
                handoff,
                acceptedCompletion,
            ]);
            expect(saved).toBe(true);
            expect(saveFailure).toBeUndefined();
            expect(handedOff).toBe(true);
            expect(readyForStyle).toBe(true);
            expect(document.textBoxDrafts.size).toBe(0);
            expect(document.getTextBoxDraftRect('retiring-box')).toBeNull();
        } finally {fit.resolve(undefined);}
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
        left.view.commitPendingDraftsForSave = () => protection.promise.then(() => {
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
        await Promise.all([
            saveRejected,
            handoffRejected,
        ]);
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
    });
    function parsed(text: string, revision = initialRevision): IPdfAnnotationParseResult {
        return {
            documentRevisionToken: revision,
            pageCount: 1,
            foreign: [],
            entities: [{
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
            }],
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
            replaceVersion: () => {version += 1;},
            detach: () => {loadToken += 1;},
        };
    }

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
            expect(capture.annotations.application.value.listCommentSummaries().map(comment => comment.text)).toEqual(['Original text']);
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
            await Promise.all([
                capture.loading,
                retirement,
            ]);
            expect(existsSync(capture.snapshot)).toBe(false);
            expect(capture.annotations.application.value.listCommentSummaries()).toEqual([]);
            expect(await readPdfDocumentOriginalAnnotationSource(capture.proxy)).toBeNull();
        } finally {
            await capture.dispose();
        }
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
    it.each([
        false,
        true,
    ])('keeps accepted drafts across a Save As identity change and resets a real loaded replacement (save: %s)', async duringSave => {
        const {
            annotations, workingCopyPath, revision,
        } = setup();
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
    });
    it('does not publish to the retired store when the source changes before a queued completion', async () => {
        const {
            annotations, resource, workingCopyPath,
        } = setup();
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
        const {
            annotations, resource, workingCopyPath,
        } = setup();
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
        expect(annotations.application.value.listCommentSummaries().map(comment => comment.text)).toEqual(['Current original path']);
    });
    it('keeps an accepted local edit when a parse finishes after that edit', async () => {
        const {
            annotations, resource, replaceVersion,
        } = setup();
        parsePdfAnnotations.mockResolvedValueOnce(parsed('Saved text'));
        await annotations.feedStoreFromWriterParse(resource, shallowRef(null));
        replaceVersion();
        const pending = Promise.withResolvers<IPdfAnnotationParseResult>();
        parsePdfAnnotations.mockReturnValueOnce(pending.promise);
        const loading = annotations.feedStoreFromWriterParse(resource, shallowRef(null));
        const id = annotations.application.value.store.list()[0]!.identity.id;
        annotations.application.value.store.updateTextBox(id, {text: 'Accepted local edit'});
        pending.resolve(parsed('Late saved baseline'));
        await loading;
        expect(annotations.application.value.listCommentSummaries().map(comment => comment.text)).toEqual(['Accepted local edit']);
    });
    it('allows a later caller to import after a rejected producer without automatically retrying', async () => {
        const {
            annotations, resource,
        } = setup();
        parsePdfAnnotations.mockRejectedValueOnce(new Error('Injected parser failure')).mockResolvedValueOnce(parsed('Later caller imported text'));
        await annotations.feedStoreFromWriterParse(resource, shallowRef(null));
        expect(annotations.application.value.listCommentSummaries()).toEqual([]);
        await annotations.feedStoreFromWriterParse(resource, shallowRef(null));
        expect(annotations.application.value.listCommentSummaries().map(comment => comment.text)).toEqual(['Later caller imported text']);
    });
    it('admits the ready document after an earlier view has no current revision fence', async () => {
        const {
            annotations, resource,
        } = setup();
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
        expect(annotations.application.value.listCommentSummaries().map(comment => comment.text)).toEqual(['Ready document']);
    });
    it('publishes imported text after the first view detaches while another view is waiting', async () => {
        const {
            annotations, resource, detach,
        } = setup();
        const pending = Promise.withResolvers<IPdfAnnotationParseResult>();
        parsePdfAnnotations.mockReturnValueOnce(pending.promise);
        const first = annotations.feedStoreFromWriterParse(resource, shallowRef(null));
        detach();
        const second = annotations.feedStoreFromWriterParse(resource, shallowRef(null));
        pending.resolve(parsed('Imported text for both views'));
        await Promise.all([
            first,
            second,
        ]);
        expect(annotations.application.value.listCommentSummaries().map(comment => comment.text)).toEqual(['Imported text for both views']);
    });
    it('keeps replacement revision text when the superseded producer ignores cancellation', async () => {
        const {
            annotations, revision, resource,
        } = setup();
        const old = Promise.withResolvers<IPdfAnnotationParseResult>();
        parsePdfAnnotations.mockReturnValueOnce(old.promise).mockResolvedValueOnce(parsed('Current revision', nextRevision));
        const previous = annotations.feedStoreFromWriterParse(resource, shallowRef(null));
        revision.value = nextRevision;
        await annotations.feedStoreFromWriterParse(resource, shallowRef(null));
        old.resolve(parsed('Superseded revision'));
        await previous;
        expect(annotations.application.value.listCommentSummaries().map(comment => comment.text)).toEqual(['Current revision']);
    });
    it('refreshes a replacement document version without retaining its old imported projection', async () => {
        const {
            annotations, resource, replaceVersion,
        } = setup();
        parsePdfAnnotations.mockResolvedValueOnce(parsed('Before replacement')).mockResolvedValueOnce(parsed('After replacement'));
        await annotations.feedStoreFromWriterParse(resource, shallowRef(null));
        expect(annotations.application.value.listCommentSummaries().map(comment => comment.text)).toEqual(['Before replacement']);
        replaceVersion();
        await annotations.feedStoreFromWriterParse(resource, shallowRef(null));
        expect(annotations.application.value.listCommentSummaries().map(comment => comment.text)).toEqual(['After replacement']);
    });
});
