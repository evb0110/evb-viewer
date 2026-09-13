import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {ref} from 'vue';
import type {
    INativePdfMutationProjection,
    IPdfViewerSaveTransactionResult,
} from '@app/modules/pdf-viewer/public';
import type {IConsumeNativePdfMutationProjectionOptions} from '@app/modules/workspace-shell/composables/nativePdfMutationArtifact';
import {
    createDeps,
    useWorkspaceSaveServiceForTest,
} from '@tests/unit/app/modules/workspace-shell/composables/file-operations/workspaceSaveServiceFixture';
import type {IPdfNativeAnnotationIdentityBinding} from '@contracts/electronApiDocuments';
import {requireDocumentRef} from '@contracts/documentRef';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';
import {cast} from '@tests/helpers/cast';

const mocks = vi.hoisted(() => ({consumeNativePdfMutationProjection: vi.fn()}));

vi.mock('@app/modules/workspace-shell/composables/nativePdfMutationArtifact', () => ({
    consumeNativePdfMutationProjection: mocks.consumeNativePdfMutationProjection,
    NativePdfSaveRequiredError: class NativePdfSaveRequiredError extends Error {},
}));

const projection: INativePdfMutationProjection = {
    canonicalAnnotationProgram: [],
    mutations: {updates: []},
    noteTextUpdates: [],
    freeTextNotes: [],
    freeTextEditors: [],
    annotationDeletes: [],
    hasMetadataMutations: false,
    hasShapeMutations: false,
    hasMarkupMutations: false,
    phase: 'persist-native-pdf-mutations',
};

describe('workspace save service page mutation writer', () => {
    beforeEach(() => {
        mocks.consumeNativePdfMutationProjection.mockReset();
    });

    it('commits native identity bindings before the reload parser runs', async () => {
        const events: string[] = [];
        const identityBindings: readonly IPdfNativeAnnotationIdentityBinding[] = [{
            annotationId: 'note-1',
            pdfRef: '11 0 R',
        }];
        mocks.consumeNativePdfMutationProjection.mockImplementation(async (
            options: IConsumeNativePdfMutationProjectionOptions,
        ) => {
            events.push('native-replace');
            options.onIdentityBindings?.(identityBindings);
        });
        const commitAnnotationSave = vi.fn(() => {
            events.push('commit');
        });
        const loadPdfFromPath = vi.fn(async () => {
            events.push('load');
        });
        const transaction = cast<IPdfViewerSaveTransactionResult>({
            nativeRequiredFailure: undefined,
            nativeMutationProjection: projection,
            verifyAnnotationSavePath: vi.fn(),
            assertAnnotationSaveCurrent: vi.fn(),
            commitAnnotationSave,
        });
        const runSaveTransaction = vi.fn(async () => transaction);
        const {deps} = createDeps({
            annotationDirty: ref(true),
            hasAnnotationChanges: () => true,
            runSaveTransaction,
            pdfViewerRef: ref({runSaveTransaction}),
            workingCopyPath: ref(requireDocumentRef('/tmp/work.pdf')),
            documentRevisionToken: ref(requireDocumentRevisionToken('revision-1')),
        });
        const saveAnnotationsForPageMutation = useWorkspaceSaveServiceForTest(deps).createPageMutationWriterSave({
            currentPage: ref(0),
            waitForPdfReload: vi.fn(async () => {
                events.push('wait-for-reload');
            }),
            loadPdfFromPath,
        });

        await expect(saveAnnotationsForPageMutation()).resolves.toBe(true);

        expect(commitAnnotationSave).toHaveBeenCalledExactlyOnceWith(identityBindings);
        expect(events).toEqual([
            'native-replace',
            'commit',
            'wait-for-reload',
            'load',
        ]);
    });

    it.each([
        false,
        true,
    ])('does not reload a switched document when native bindings are present: %s', async (withBindings) => {
        const workingCopyPath = ref(requireDocumentRef('/tmp/work.pdf'));
        const waitForPdfReload = vi.fn(async () => undefined);
        const loadPdfFromPath = vi.fn(async () => undefined);
        const commitAnnotationSave = vi.fn();
        mocks.consumeNativePdfMutationProjection.mockImplementation(async (
            options: IConsumeNativePdfMutationProjectionOptions,
        ) => {
            if (withBindings) {
                options.onIdentityBindings?.([{
                    annotationId: 'note-1',
                    pdfRef: '11 0 R',
                }]);
            }
            workingCopyPath.value = requireDocumentRef('/tmp/other.pdf');
        });
        const transaction = cast<IPdfViewerSaveTransactionResult>({
            nativeMutationProjection: projection,
            commitAnnotationSave,
        });
        const runSaveTransaction = vi.fn(async () => transaction);
        const {deps} = createDeps({
            annotationDirty: ref(true),
            hasAnnotationChanges: () => true,
            workingCopyPath,
            documentRevisionToken: ref(requireDocumentRevisionToken('revision-1')),
            runSaveTransaction,
            pdfViewerRef: ref({runSaveTransaction}),
        });
        const save = useWorkspaceSaveServiceForTest(deps).createPageMutationWriterSave({
            currentPage: ref(0),
            waitForPdfReload,
            loadPdfFromPath,
        });

        await expect(save()).resolves.toBe(false);
        expect(waitForPdfReload).not.toHaveBeenCalled();
        expect(loadPdfFromPath).not.toHaveBeenCalled();
        expect(commitAnnotationSave).not.toHaveBeenCalled();
    });
});
