import {performance} from 'node:perf_hooks';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {ref} from 'vue';
import type {TDocumentRef} from '@contracts/documentRef';
import type {TPageSelection} from '@pdf-core/pdfPageSelection';
import {usePageOpsHandlers} from '@app/modules/workspace-shell/composables/usePageOpsHandlers';

const pageOpsMocks = vi.hoisted(() => ({
    deletePages: vi.fn(async () => true),
    deletePageRanges: vi.fn(async () => true),
}));

vi.mock('@app/modules/pdf-viewer/public', () => ({
    usePageOperations: () => ({
        isOperationInProgress: ref(false),
        batchProgress: ref(null),
        lastOutcome: ref(null),
        cancelState: ref('idle'),
        canCancelOperation: ref(false),
        cancelActiveOperation: vi.fn(),
        deletePages: pageOpsMocks.deletePages,
        deletePageRanges: pageOpsMocks.deletePageRanges,
        extractPages: vi.fn(async () => true),
        rotatePages: vi.fn(async () => true),
        insertPages: vi.fn(async () => true),
        insertFile: vi.fn(async () => true),
        reorderPages: vi.fn(async () => true),
        movePages: vi.fn(async () => true),
        cropPages: vi.fn(async () => true),
        removeCropFromPages: vi.fn(async () => true),
    }),
}));

vi.mock('@app/utils/platformDocuments', () => ({
    getDocumentWorkingCopyCapability: () => ({}),
}));

function createHandlers(initialSelected: number[], totalPageCount: number) {
    const selectedThumbnailPages = ref<number[]>(initialSelected);
    const selectedPageSelection = ref<TPageSelection | null>(null);
    const setSelectedThumbnailPages = vi.fn((pages: number[]) => {
        selectedThumbnailPages.value = pages;
    });
    const setSelectedPageSelection = vi.fn((selection: TPageSelection) => {
        selectedPageSelection.value = selection;
    });

    const handlers = usePageOpsHandlers({
        workingCopyPath: ref<TDocumentRef | null>(null),
        pageLabels: ref<string[] | null>(null),
        bookmarkItems: ref([]),
        views: {
            viewPorts: ref(new Map()),
            mapPageIdentity: vi.fn(),
        },
        totalPages: ref(totalPageCount),
        commitPdfEditors: vi.fn(async () => undefined),
        beginPageRotationPreview: vi.fn(async () => undefined),
        invalidateThumbnailPages: vi.fn(),
        onExportPages: vi.fn(),
        ensureHistoryBaselineForMutation: vi.fn(async () => true),
        saveAnnotationsForPageMutation: vi.fn(async () => true),
        reloadWorkingCopyIntoHistory: vi.fn(async () => null),
        clearOcrCache: vi.fn(),
        resetSearchCache: vi.fn(),
    });

    const viewHandlers = handlers.forView({
        selectedThumbnailPages,
        setSelectedThumbnailPages,
        selectedPageSelection,
        setSelectedPageSelection,
        pageContextMenu: ref({
            visible: false,
            pages: [],
        }),
        closePageContextMenu: vi.fn(),
        emitOpenInNewTab: vi.fn(),
    });

    return {
        selectedThumbnailPages,
        setSelectedThumbnailPages,
        viewHandlers,
    };
}

describe('usePageOpsHandlers legacy array delete selection remap', () => {
    it('removes deleted pages and shifts remaining pages accurately for unsorted deletion lists', async () => {
        pageOpsMocks.deletePages.mockClear();
        const {
            selectedThumbnailPages,
            viewHandlers,
        } = createHandlers([1, 2, 4, 5, 8, 10], 10);

        const didDelete = await viewHandlers.pageOpsDelete([7, 2, 5], 10);

        expect(didDelete).toBe(true);
        expect(pageOpsMocks.deletePages).toHaveBeenCalledWith([7, 2, 5], 10, undefined);
        // 1 -> 1 (0 deleted < 1), 2 -> deleted, 4 -> 3 (1 deleted < 4), 5 -> deleted,
        // 8 -> 5 (3 deleted < 8), 10 -> 7 (3 deleted < 10)
        expect(selectedThumbnailPages.value).toEqual([1, 3, 5, 7]);
    });

    it('remaps 10k selected pages across 5k deleted pages in O((S + D) log D)', async () => {
        pageOpsMocks.deletePages.mockClear();
        const total = 20_000;
        const selected = Array.from({length: 10_000}, (_, index) => index * 2 + 1);
        const deleted = Array.from({length: 5_000}, (_, index) => (5_000 - index) * 4);
        const {
            selectedThumbnailPages,
            viewHandlers,
        } = createHandlers(selected, total);

        const startedAt = performance.now();
        const didDelete = await viewHandlers.pageOpsDelete(deleted, total);
        const elapsedMs = performance.now() - startedAt;

        expect(didDelete).toBe(true);
        expect(selectedThumbnailPages.value).toHaveLength(10_000);
        // Page 1 has 0 deleted pages before it -> 1.
        // Page 19999 has 4999 multiples of 4 below it (4..19996) -> 19999 - 4999 = 15000.
        expect(selectedThumbnailPages.value[0]).toBe(1);
        expect(selectedThumbnailPages.value[9_999]).toBe(15_000);
        expect(elapsedMs).toBeLessThan(250);
    });
});
