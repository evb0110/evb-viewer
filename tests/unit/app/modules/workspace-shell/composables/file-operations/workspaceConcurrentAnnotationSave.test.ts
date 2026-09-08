import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    computed,
    ref,
    shallowRef,
} from 'vue';
import {requireDocumentRef} from '@contracts/documentRef';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';
import {requirePageIndex} from '@contracts/pageNumbers';
import {AnnotationApplication} from '@app/modules/pdf-viewer/annotations/annotationApplication';
import {
    asAnnotationId,
    type INoteEntity,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import {usePdfViewerSaveTransaction} from '@app/modules/pdf-viewer/runtime/save/usePdfViewerSaveTransaction';
import {
    createDeferred,
    createDeps,
    useWorkspaceSaveServiceForTest,
} from '@tests/unit/app/modules/workspace-shell/composables/file-operations/workspaceSaveServiceFixture';

function savedNote(): INoteEntity {
    return {
        kind: 'note',
        identity: {
            id: asAnnotationId('saved-note'),
            pdfRef: '12R',
        },
        pageIndex: requirePageIndex(0),
        revision: 0,
        persistedRevision: 0,
        deleted: false,
        createdAt: null,
        modifiedAt: null,
        author: null,
        contents: 'saved text',
        color: '#ffff00',
        open: false,
        position: {
            left: 0.1,
            top: 0.2,
            width: 0.02,
            height: 0.02,
        },
    };
}

describe('concurrent canonical edits during workspace save', () => {
    afterEach(() => vi.restoreAllMocks());

    it.each([
        {
            mode: 'save',
            capturedEdit: false,
        },
        {
            mode: 'save-as',
            capturedEdit: false,
        },
        {
            mode: 'save',
            capturedEdit: true,
        },
        {
            mode: 'save-as',
            capturedEdit: true,
        },
    ] as const)('retains newer text and history for $mode with capturedEdit=$capturedEdit', async ({
        mode,
        capturedEdit,
    }) => {
        const application = new AnnotationApplication('concurrent-save');
        const note = savedNote();
        application.store.replaceFromDocument([note], []);
        if (capturedEdit) application.store.updateNote(note.identity.id, {contents: 'captured text'});
        const enteredPersistence = createDeferred<undefined>();
        const finishPersistence = createDeferred<undefined>();
        const originalPath = ref(requireDocumentRef('/tmp/source.pdf'));
        const workingCopyPath = ref(requireDocumentRef('/tmp/work.pdf'));
        const revision = ref(requireDocumentRevisionToken('rev-1'));
        const {deps} = createDeps({
            originalPath,
            workingCopyPath,
            documentRevisionToken: revision,
            annotationDirty: ref(true),
            hasAnnotationChanges: () => true,
            getAnnotationSaveStateToken: () => application.store.mutationEpoch,
            trySavePdfNativeMutations: vi.fn(),
        });
        const acknowledgement = vi.spyOn(application, 'acknowledgeSave');
        const transaction = usePdfViewerSaveTransaction({
            getPdfDocument: () => deps.pdfDocument.value,
            annotationApplication: shallowRef(application),
            documentRevisionToken: computed(() => revision.value),
        });
        deps.runSaveTransaction = request => transaction.runSaveTransaction(request);
        async function publishCapturedBytes() {
            enteredPersistence.resolve(undefined);
            await finishPersistence.promise;
            if (mode === 'save-as') originalPath.value = requireDocumentRef('/tmp/new.pdf');
            revision.value = requireDocumentRevisionToken('rev-2');
            return {
                success: true,
                outPath: originalPath.value,
                saveMode: mode === 'save-as' ? 'save_as_rewrite' as const : 'rewrite' as const,
                didSaveAs: mode === 'save-as',
            };
        }
        deps.trySavePdfNativeMutations = vi.fn(publishCapturedBytes);
        deps.saveWorkingCopy = vi.fn(publishCapturedBytes);
        deps.saveWorkingCopyAs = vi.fn(publishCapturedBytes);
        const service = useWorkspaceSaveServiceForTest(deps);
        const saving = mode === 'save-as' ? service.handleSaveAs() : service.handleSave();
        await enteredPersistence.promise;

        application.store.updateNote(note.identity.id, {contents: 'newer unsaved text'});
        finishPersistence.resolve(undefined);
        await expect(saving).resolves.toBe(false);

        expect(acknowledgement).toHaveBeenCalledOnce();
        expect(acknowledgement.mock.results[0]?.type).toBe('throw');
        expect(acknowledgement.mock.results[0]?.value).toMatchObject({message: expect.stringContaining('staleRevisionError')});
        expect(deps.markAnnotationSaved).not.toHaveBeenCalled();
        expect(application.store.get(note.identity.id)).toMatchObject({
            contents: 'newer unsaved text',
            persistedRevision: 0,
        });
        expect(application.store.hasChangesSinceSavedBaseline()).toBe(true);
        expect(application.store.undo()).toBe(true);
        if (capturedEdit) {
            expect(application.store.get(note.identity.id)).toMatchObject({contents: 'captured text'});
            expect(application.store.undo()).toBe(true);
        }
        expect(application.store.get(note.identity.id)).toMatchObject({contents: 'saved text'});
        expect(application.store.hasChangesSinceSavedBaseline()).toBe(false);
        expect(application.store.redo()).toBe(true);
        if (capturedEdit) expect(application.store.redo()).toBe(true);
        expect(application.store.get(note.identity.id)).toMatchObject({contents: 'newer unsaved text'});
        expect(application.store.hasChangesSinceSavedBaseline()).toBe(true);
    });
});
