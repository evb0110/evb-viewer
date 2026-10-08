import {cast} from '@tests/helpers/cast';
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

const {parsePdfAnnotations} = vi.hoisted(() => ({parsePdfAnnotations: vi.fn()}));
vi.mock('@app/utils/platformDocuments', () => ({getDocumentWorkingCopyCapability: () => ({parsePdfAnnotations})}));

/** A view whose editor holds at most one open text-box draft. */
function createEditorView() {
    const open = ref<{
        annotationId: string;
        rect: IAnnotationMarkerRect;
    } | null>(null);
    const committed: string[] = [];
    const view: IPdfDocumentAnnotationsView = {
        emitAnnotationState: () => {},
        emitAnnotationModified: () => {},
        onHistoryReplay: () => {},
        commitPendingDraftsForSave: () => {
            if (open.value) committed.push(open.value.annotationId);
            open.value = null;
        },
        commitDraftIfOpen: (annotationId) => {
            if (open.value?.annotationId === annotationId) view.commitPendingDraftsForSave();
        },
        getTextBoxDraftRect: annotationId => (open.value?.annotationId === annotationId ? open.value.rect : null),
    };
    return {
        view,
        open,
        committed,
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
        document.setTextBoxDraft(right.view, 'box-1', 'typed in the right view');

        expect(document.getTextBoxDraftRect('box-1')).toEqual(rightRect);
        expect(document.textBoxDrafts.get('box-1')).toBe('typed in the right view');

        detachRight();
        expect(document.getTextBoxDraftRect('box-1')).toBeNull();
    });

    it('commits the draft another view has open before a second view edits the same box', () => {
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
        document.setTextBoxDraft(right.view, 'box-1', 'continued in the right view');

        expect(left.open.value).toBeNull();
        expect(left.committed).toEqual(['box-1']);
        expect(document.getTextBoxDraftRect('box-1')).toEqual(rightRect);
        expect(document.textBoxDrafts.get('box-1')).toBe('continued in the right view');
    });
});

describe('writer annotations shared by linked views', () => {
    beforeEach(() => parsePdfAnnotations.mockReset());
    const initialRevision = requireDocumentRevisionToken('drt1:shared-writer-1');
    const nextRevision = requireDocumentRevisionToken('drt1:shared-writer-2');
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
            replaceVersion: () => {version += 1;},
            detach: () => {loadToken += 1;},
        };
    }
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
