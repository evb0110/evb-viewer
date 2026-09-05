import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    ref,
    type Ref,
} from 'vue';
import type { ICropMargins } from '@app/types/crop';
import type { TPageSelection } from '@contracts/pageNumbers';
import {
    createAllPageSelection,
    createPageMoveRange,
    createPredicatePageSelection,
} from '@contracts/pageNumbers';

const operationMocks = vi.hoisted(() => ({
    deletePages: vi.fn(),
    deletePageRanges: vi.fn(),
    extractPages: vi.fn(),
    rotatePages: vi.fn(),
    insertPages: vi.fn(),
    insertFile: vi.fn(),
    reorderPages: vi.fn(),
    movePages: vi.fn(),
    cropPages: vi.fn(),
    removeCrop: vi.fn(),
}));

vi.mock('@app/modules/pdf-viewer/runtime/composables/pdf/usePageOperations', () => ({ usePageOperations: () => ({
    isOperationInProgress: ref(false),
    deletePages: operationMocks.deletePages,
    deletePageRanges: operationMocks.deletePageRanges,
    extractPages: operationMocks.extractPages,
    rotatePages: operationMocks.rotatePages,
    insertPages: operationMocks.insertPages,
    insertFile: operationMocks.insertFile,
    reorderPages: operationMocks.reorderPages,
    movePages: operationMocks.movePages,
    cropPages: operationMocks.cropPages,
    removeCrop: operationMocks.removeCrop,
}) }));

const { usePageOpsHandlers } = await import('@app/modules/workspace-shell/composables/usePageOpsHandlers');

function createHarness(options: {
    canMutatePages?: Ref<boolean>;
    selectedPages?: number[];
    selectedPageSelection?: Ref<TPageSelection | null>;
    totalPages?: number;
} = {}) {
    const { canMutatePages = ref(true) } = options;
    const invalidateThumbnailPages = vi.fn();
    const invalidatePages = vi.fn();
    const onExportPages = vi.fn();
    const setSelectedThumbnailPages = vi.fn();
    const setSelectedPageSelection = vi.fn();
    const reloadWaiterCancel = vi.fn();
    const pageContextMenu = ref({
        visible: false,
        pages: [] as number[],
    });
    const preparePdfReloadWaiter = vi.fn(() => ({
        promise: Promise.resolve(),
        cancel: reloadWaiterCancel,
    }));

    const handlers = usePageOpsHandlers({
        workingCopyPath: ref('/tmp/work.pdf'),
        pageLabels: ref(null),
        bookmarkItems: ref([]),
        currentPage: ref(4),
        totalPages: ref(options.totalPages ?? 10),
        selectedThumbnailPages: ref(options.selectedPages ?? []),
        ...(options.selectedPageSelection === undefined ? {} : {selectedPageSelection: options.selectedPageSelection}),
        setSelectedThumbnailPages,
        setSelectedPageSelection,
        invalidateThumbnailPages,
        pdfViewerRef: ref({
            invalidatePages,
            runSaveTransaction: vi.fn(),
        }),
        pageContextMenu,
        closePageContextMenu: vi.fn(),
        onExportPages,
        canMutatePages,
        ensureHistoryBaselineForMutation: vi.fn(async () => true),
        saveAnnotationsForPageMutation: vi.fn(async () => true),
        reloadWorkingCopyIntoHistory: vi.fn(async () => true),
        preparePdfReloadWaiter,
        clearOcrCache: vi.fn(),
        resetSearchCache: vi.fn(),
    });

    return {
        handlers,
        invalidateThumbnailPages,
        invalidatePages,
        onExportPages,
        setSelectedThumbnailPages,
        setSelectedPageSelection,
        pageContextMenu,
        preparePdfReloadWaiter,
        reloadWaiterCancel,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    operationMocks.deletePages.mockResolvedValue(true);
    operationMocks.deletePageRanges.mockResolvedValue(true);
    operationMocks.extractPages.mockResolvedValue(true);
    operationMocks.rotatePages.mockResolvedValue(true);
    operationMocks.movePages.mockResolvedValue(true);
    operationMocks.cropPages.mockResolvedValue(true);
    operationMocks.removeCrop.mockResolvedValue(true);
});

describe('usePageOpsHandlers crop reload strategy', () => {
    it('waits for document reload after rotation instead of selectively invalidating stale thumbnails', async () => {
        const {
            handlers,
            invalidateThumbnailPages,
            invalidatePages,
            preparePdfReloadWaiter,
        } = createHarness();

        await handlers.handlePageRotate([
            2,
            3,
        ], 90);

        expect(invalidateThumbnailPages).not.toHaveBeenCalled();
        expect(invalidatePages).not.toHaveBeenCalled();
        expect(preparePdfReloadWaiter).toHaveBeenCalledWith(4, { captureScrollSnapshot: false });
        expect(operationMocks.rotatePages).toHaveBeenCalledWith({
            kind: 'explicit',
            pageCount: 10,
            pages: [
                2,
                3,
            ],
        }, 10, 90);
    });

    it('cancels the page-only reload waiter when rotation fails', async () => {
        const {
            handlers,
            reloadWaiterCancel,
        } = createHarness();
        operationMocks.rotatePages.mockResolvedValueOnce(false);

        const result = await handlers.handlePageRotate([2], 90);

        expect(result).toBe(false);
        expect(reloadWaiterCancel).toHaveBeenCalledOnce();
    });

    it('lets crop operations reload fully instead of reusing stale page geometry', async () => {
        const {
            handlers,
            invalidateThumbnailPages,
            invalidatePages,
            preparePdfReloadWaiter,
        } = createHarness();

        const margins: ICropMargins = {
            top: 12,
            bottom: 24,
            left: 36,
            right: 48,
        };

        await handlers.handleCropPages([4], margins);
        await handlers.handleRemoveCrop([4]);

        expect(invalidateThumbnailPages).not.toHaveBeenCalled();
        expect(invalidatePages).not.toHaveBeenCalled();
        expect(preparePdfReloadWaiter).toHaveBeenNthCalledWith(1, 4, { captureScrollSnapshot: false });
        expect(preparePdfReloadWaiter).toHaveBeenNthCalledWith(2, 4, { captureScrollSnapshot: false });
        expect(operationMocks.cropPages).toHaveBeenCalledWith([4], 10, margins);
        expect(operationMocks.removeCrop).toHaveBeenCalledWith([4], 10);
    });

    it('cancels the page-only reload waiter when crop fails', async () => {
        const {
            handlers,
            reloadWaiterCancel,
        } = createHarness();
        operationMocks.cropPages.mockResolvedValueOnce(false);

        const result = await handlers.handleCropPages([4], {
            top: 1,
            bottom: 2,
            left: 3,
            right: 4,
        });

        expect(result).toBe(false);
        expect(reloadWaiterCancel).toHaveBeenCalledOnce();
    });

    it('ignores empty insert-before and insert-after page context sets', () => {
        const { handlers } = createHarness();

        handlers.handlePageContextMenuInsertBefore();
        handlers.handlePageContextMenuInsertAfter();

        expect(operationMocks.insertPages).not.toHaveBeenCalled();
    });

    it('conserves surviving thumbnail/sidebar selection through delete and reorder', async () => {
        const {
            handlers,
            setSelectedThumbnailPages,
        } = createHarness({selectedPages: [
            1,
            3,
            5,
        ]});
        operationMocks.deletePages.mockResolvedValueOnce(true);
        operationMocks.insertPages.mockResolvedValueOnce(true);
        operationMocks.reorderPages.mockResolvedValueOnce(true);

        await handlers.pageOpsDelete([2], 10);
        await handlers.pageOpsReorder([
            3,
            1,
            2,
            4,
            5,
            6,
            7,
            8,
            9,
        ]);

        expect(setSelectedThumbnailPages).toHaveBeenCalledTimes(2);
        expect(setSelectedThumbnailPages).toHaveBeenNthCalledWith(1, [
            1,
            2,
            4,
        ]);
        expect(setSelectedThumbnailPages).toHaveBeenNthCalledWith(2, [
            2,
            1,
            5,
        ]);
    });

    it('keeps a million-page selection lazy while moving one page', async () => {
        const selectedPageSelection = ref<TPageSelection>(
            createPredicatePageSelection(1_000_000, 'odd'),
        );
        const {
            handlers,
            setSelectedPageSelection,
            setSelectedThumbnailPages,
        } = createHarness({
            selectedPageSelection,
            totalPages: 1_000_000,
        });
        const move = createPageMoveRange(1_000_000, 900_000, 900_000, 0);

        await expect(handlers.pageOpsMove(move)).resolves.toBe(true);

        expect(operationMocks.movePages).toHaveBeenCalledOnce();
        expect(operationMocks.movePages).toHaveBeenCalledWith(move);
        expect(setSelectedThumbnailPages).toHaveBeenCalledWith([]);
        expect(setSelectedPageSelection).toHaveBeenCalledOnce();
        expect(setSelectedPageSelection.mock.calls[0]?.[0]).toMatchObject({
            kind: 'mapped',
            pageCount: 1_000_000,
            moves: [move],
        });
    });

    it('sends a million-page toolbar rotation as one compact user operation', async () => {
        const selectedPageSelection = ref<TPageSelection>(createAllPageSelection(1_000_000));
        const { handlers } = createHarness({
            selectedPageSelection,
            totalPages: 1_000_000,
        });

        await expect(handlers.handlePageRotate(selectedPageSelection.value, 90)).resolves.toBe(true);

        expect(operationMocks.rotatePages).toHaveBeenCalledOnce();
        expect(operationMocks.rotatePages).toHaveBeenCalledWith(
            selectedPageSelection.value,
            1_000_000,
            90,
        );
    });

    it('deletes a million-page select-all through one compact native range request', async () => {
        const selectedPageSelection = ref<TPageSelection>(createAllPageSelection(1_000_000));
        const {
            handlers,
            setSelectedPageSelection,
            setSelectedThumbnailPages,
        } = createHarness({
            selectedPageSelection,
            totalPages: 1_000_000,
        });

        await expect(handlers.pageOpsDelete(selectedPageSelection.value, 1_000_000)).resolves.toBe(true);

        expect(operationMocks.deletePageRanges).toHaveBeenCalledOnce();
        expect(operationMocks.deletePageRanges).toHaveBeenCalledWith([{
            startPage: 2,
            endPage: 1_000_000,
        }], 1_000_000);
        expect(operationMocks.deletePages).not.toHaveBeenCalled();
        expect(setSelectedPageSelection).toHaveBeenCalledWith({
            kind: 'none',
            pageCount: 1,
        });
        expect(setSelectedThumbnailPages).toHaveBeenCalledWith([]);
    });

    it('keeps thumbnail selection when a structural page mutation fails', async () => {
        const {
            handlers,
            setSelectedThumbnailPages,
        } = createHarness();
        operationMocks.deletePages.mockResolvedValueOnce(false);

        await handlers.pageOpsDelete([2], 10);

        expect(setSelectedThumbnailPages).not.toHaveBeenCalled();
    });

    it('blocks PDF page operations while DjVu mode is active', async () => {
        const {
            handlers,
            onExportPages,
            pageContextMenu,
            preparePdfReloadWaiter,
            setSelectedThumbnailPages,
        } = createHarness({ canMutatePages: ref(false) });

        await expect(handlers.pageOpsDelete([2], 10)).resolves.toBe(false);
        await expect(handlers.pageOpsExtract([2])).resolves.toBe(false);
        await expect(handlers.pageOpsInsert(10, 2)).resolves.toBe(false);
        await expect(handlers.pageOpsReorder([
            2,
            1,
        ])).resolves.toBe(false);
        await expect(handlers.handlePageRotate([2], 90)).resolves.toBe(false);
        await expect(handlers.handleCropPages([2], {
            top: 1,
            bottom: 1,
            left: 1,
            right: 1,
        })).resolves.toBe(false);
        await expect(handlers.handleRemoveCrop([2])).resolves.toBe(false);

        handlers.handlePageFileDrop({
            afterPage: 2,
            filePaths: ['/tmp/extra.pdf'],
        });
        pageContextMenu.value.pages = [2];
        handlers.handlePageContextMenuDelete();
        handlers.handlePageContextMenuExtract();
        handlers.handlePageContextMenuExport();
        handlers.handlePageContextMenuInsertAfter();
        await Promise.resolve();

        expect(operationMocks.deletePages).not.toHaveBeenCalled();
        expect(operationMocks.extractPages).not.toHaveBeenCalled();
        expect(operationMocks.rotatePages).not.toHaveBeenCalled();
        expect(operationMocks.insertPages).not.toHaveBeenCalled();
        expect(operationMocks.insertFile).not.toHaveBeenCalled();
        expect(operationMocks.reorderPages).not.toHaveBeenCalled();
        expect(operationMocks.cropPages).not.toHaveBeenCalled();
        expect(operationMocks.removeCrop).not.toHaveBeenCalled();
        expect(onExportPages).not.toHaveBeenCalled();
        expect(preparePdfReloadWaiter).not.toHaveBeenCalled();
        expect(setSelectedThumbnailPages).not.toHaveBeenCalled();
    });
});
