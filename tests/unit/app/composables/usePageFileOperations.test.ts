import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';
import { usePageFileOperations } from '@app/composables/usePageFileOperations';

function createDeps(overrides: Partial<Parameters<typeof usePageFileOperations>[0]> = {}) {
    return {
        pdfSrc: ref<unknown>({}),
        isAnySaving: ref(false),
        isHistoryBusy: ref(false),
        isExportingDocx: ref(false),
        isAnyAnnotationNoteSaving: ref(false),
        annotationNoteWindows: ref([]),
        annotationDirty: ref(false),
        isDirty: ref(false),
        pageLabelsDirty: ref(false),
        bookmarksDirty: ref(false),
        hasAnnotationChanges: vi.fn(() => false),
        persistAllAnnotationNotes: vi.fn(async (_force: boolean) => true),
        handleSave: vi.fn(async () => {}),
        openFile: vi.fn(async () => {}),
        openFileDirect: vi.fn(async (_path: string) => {}),
        openFileDirectBatch: vi.fn(async (_paths: string[]) => {}),
        closeFile: vi.fn(async () => {}),
        closeAllDropdowns: vi.fn(),
        ...overrides,
    };
}

describe('usePageFileOperations', () => {
    it('persists unsaved changes before closing by default', async () => {
        const isDirty = ref(true);
        const deps = createDeps({
            isDirty,
            handleSave: vi.fn(async () => {
                isDirty.value = false;
            }),
        });
        const { handleCloseFileFromUi } = usePageFileOperations(deps);

        await handleCloseFileFromUi();

        expect(deps.handleSave).toHaveBeenCalledOnce();
        expect(deps.closeFile).toHaveBeenCalledOnce();
        expect(deps.closeAllDropdowns).toHaveBeenCalledOnce();
    });

    it('can close without persisting when persist is false', async () => {
        const deps = createDeps({ isDirty: ref(true) });
        const { handleCloseFileFromUi } = usePageFileOperations(deps);

        await handleCloseFileFromUi({ persist: false });

        expect(deps.handleSave).not.toHaveBeenCalled();
        expect(deps.closeFile).toHaveBeenCalledOnce();
        expect(deps.closeAllDropdowns).toHaveBeenCalledOnce();
    });
});
