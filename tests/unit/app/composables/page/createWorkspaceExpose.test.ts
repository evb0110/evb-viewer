import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';
import { createWorkspaceExpose } from '@app/composables/page/createWorkspaceExpose';

function cast<T>(obj: unknown): T {
    return obj as T;
}

function createDeps(overrides: Partial<Parameters<typeof createWorkspaceExpose>[0]> = {}) {
    return cast<Parameters<typeof createWorkspaceExpose>[0]>({
        handleSave: vi.fn(async () => {}),
        handleSaveAs: vi.fn(async () => {}),
        handleUndo: vi.fn(),
        handleRedo: vi.fn(),
        handleOpenFileFromUi: vi.fn(async () => {}),
        handleOpenFileDirectWithPersist: vi.fn(async (_path: string) => {}),
        handleOpenFileDirectBatchWithPersist: vi.fn(async (_paths: string[]) => {}),
        handleOpenFileWithResult: vi.fn(async () => {}),
        handleCloseFileFromUi: vi.fn(async () => {}),
        handleExportDocx: vi.fn(async () => {}),
        handleExportImages: vi.fn(async () => {}),
        handleExportMultiPageTiff: vi.fn(async () => {}),
        hasPdf: ref(false),
        closeAllDropdowns: vi.fn(),
        zoom: ref(1),
        viewMode: ref('single'),
        handleFitMode: vi.fn(),
        selectedThumbnailPages: ref<number[]>([]),
        pageOpsDelete: vi.fn(async (_pages: number[], _totalPages: number) => {}),
        pageOpsExtract: vi.fn(async (_pages: number[]) => {}),
        handlePageRotate: vi.fn(async (_pages: number[], _angle: 90 | 270) => {}),
        pageOpsInsert: vi.fn(async (_totalPages: number, _afterPage: number) => {}),
        totalPages: ref(7),
        isDjvuMode: ref(false),
        openConvertDialog: vi.fn(),
        captureSplitPayload: vi.fn(async () => ({})),
        restoreSplitPayload: vi.fn(async () => {}),
        ...overrides,
    });
}

describe('createWorkspaceExpose', () => {
    it('clamps zoom in/out commands', () => {
        const deps = createDeps({ zoom: ref(4.9) });
        const exposed = createWorkspaceExpose(deps);

        exposed.handleZoomIn();
        exposed.handleZoomIn();
        expect(deps.zoom.value).toBe(5);

        deps.zoom.value = 0.3;
        exposed.handleZoomOut();
        exposed.handleZoomOut();
        expect(deps.zoom.value).toBe(0.25);
    });

    it('routes fit commands through handleFitMode', () => {
        const deps = createDeps();
        const exposed = createWorkspaceExpose(deps);

        exposed.handleFitWidth();
        exposed.handleFitHeight();

        expect(deps.handleFitMode).toHaveBeenNthCalledWith(1, 'width');
        expect(deps.handleFitMode).toHaveBeenNthCalledWith(2, 'height');
    });

    it('runs page actions only when pages are selected', async () => {
        const deps = createDeps();
        const exposed = createWorkspaceExpose(deps);

        exposed.handleDeletePages();
        exposed.handleExtractPages();
        exposed.handleRotateCw();
        exposed.handleRotateCcw();

        expect(deps.pageOpsDelete).not.toHaveBeenCalled();
        expect(deps.pageOpsExtract).not.toHaveBeenCalled();
        expect(deps.handlePageRotate).not.toHaveBeenCalled();

        deps.selectedThumbnailPages.value = [
            1,
            3,
        ];

        exposed.handleDeletePages();
        exposed.handleExtractPages();
        exposed.handleRotateCw();
        exposed.handleRotateCcw();

        expect(deps.pageOpsDelete).toHaveBeenCalledWith([
            1,
            3,
        ], 7);
        expect(deps.pageOpsExtract).toHaveBeenCalledWith([
            1,
            3,
        ]);
        expect(deps.handlePageRotate).toHaveBeenNthCalledWith(1, [
            1,
            3,
        ], 90);
        expect(deps.handlePageRotate).toHaveBeenNthCalledWith(2, [
            1,
            3,
        ], 270);
    });

    it('opens conversion dialog in DjVu mode and file picker otherwise', async () => {
        const deps = createDeps({ isDjvuMode: ref(true) });
        const exposed = createWorkspaceExpose(deps);

        exposed.handleConvertToPdf();
        expect(deps.openConvertDialog).toHaveBeenCalledOnce();
        expect(deps.handleOpenFileFromUi).not.toHaveBeenCalled();

        deps.isDjvuMode.value = false;
        exposed.handleConvertToPdf();
        expect(deps.handleOpenFileFromUi).toHaveBeenCalledOnce();
    });
});
