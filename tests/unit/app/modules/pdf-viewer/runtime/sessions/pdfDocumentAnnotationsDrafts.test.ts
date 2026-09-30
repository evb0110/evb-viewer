import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    computed,
    ref,
} from 'vue';
import type { IAnnotationMarkerRect } from '@app/types/annotations';
import type { IPdfDocumentAnnotationsView } from '@app/modules/pdf-viewer/runtime/sessions/createPdfDocumentAnnotations';
import { createPdfDocumentAnnotations } from '@app/modules/pdf-viewer/runtime/sessions/createPdfDocumentAnnotations';
import { requireDocumentRef } from '@contracts/documentRef';

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
