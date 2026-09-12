import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    computed,
    ref,
} from 'vue';
import type {
    IAnnotationInventoryCompleteness,
    TAnnotationInventoryOmission,
} from '@app/types/annotations';
import { createWorkspaceExpose } from '@app/modules/workspace-shell/expose/createWorkspaceExpose';
import { createDefaultWorkspaceViewerCapabilities } from '@app/types/workspaceExpose';
import type { IWorkspaceDocumentViewerNavigationPort } from '@app/modules/workspace-shell/types/workspaceOrchestration.types';
import {
    createRangePageSelection,
    type TPageMoveOperation,
    type TPageSelection,
} from '@contracts/pageNumbers';
import { requireDocumentRef } from '@contracts/documentRef';
import type { TPdfSource } from '@app/types/pdfUi';

function createDeps(overrides: Partial<Parameters<typeof createWorkspaceExpose>[0]> = {}) {
    return {
        documentIdentity: ref(null),
        handleSave: vi.fn(async () => true),
        handleRepairSave: vi.fn(async () => true),
        handleOptimizePdfForInteraction: vi.fn(async () => true),
        handleSaveAs: vi.fn(async () => true),
        handlePrint: vi.fn(async () => {}),
        handlePrintCurrentPage: vi.fn(async () => {}),
        handleUndo: vi.fn(),
        handleRedo: vi.fn(),
        handleCombineImages: vi.fn(async () => true),
        handleOpenFileFromUi: vi.fn(async () => true),
        handleOpenFileDirectWithPersist: vi.fn(async (_path: string) => true),
        handleOpenFileDirectBatchWithPersist: vi.fn(async (_paths: string[]) => true),
        handleOpenFileWithResult: vi.fn(async () => true),
        handleCloseFileFromUi: vi.fn(async () => true),
        handleExportDocx: vi.fn(async () => {}),
        handleExportImages: vi.fn(async () => {}),
        handleExportMultiPageTiff: vi.fn(async () => {}),
        hasPdf: ref(false),
        isOpeningDocument: ref(false),
        openingPreviewReady: ref(false),
        initialVisualReady: ref(false),
        hasOpenError: ref(false),
        isPreparingPrint: ref(false),
        isPreparingCurrentPagePrint: ref(false),
        canSave: ref(false),
        canUndo: ref(false),
        canRedo: ref(false),
        canExportDocx: ref(false),
        isSaving: ref(false),
        isSavingAs: ref(false),
        isAnySaving: ref(false),
        isHistoryBusy: ref(false),
        isExportingDocx: ref(false),
        isFitWidthActive: ref(false),
        isFitHeightActive: ref(false),
        showSidebar: ref(false),
        dragMode: ref(false),
        continuousScroll: ref(false),
        isCapturingRegion: ref(false),
        isCropSelecting: ref(false),
        isPlacingPageNote: ref(false),
        closeAllDropdowns: vi.fn(),
        zoom: ref(1),
        effectiveZoom: ref(1),
        zoomMode: ref('custom'),
        fitMode: ref('width'),
        viewMode: ref('single'),
        viewRotation: ref(0),
        currentPage: ref(1),
        handleFitMode: vi.fn(),
        handleGoToPage: vi.fn(),
        handleToggleSidebar: vi.fn(),
        handleToggleContinuousScroll: vi.fn(),
        handleEnableDragMode: vi.fn(),
        handleDisableDragMode: vi.fn(),
        handleCaptureRegion: vi.fn(),
        handleCrop: vi.fn(),
        handleQuickNote: vi.fn(),
        handleInsertImageFromFile: vi.fn(async () => {}),
        handlePasteImageFromClipboard: vi.fn(async () => {}),
        selectedThumbnailPages: ref<number[]>([]),
        pageOpsDelete: vi.fn(async (_pages: number[] | TPageSelection, _totalPages: number) => true),
        pageOpsExtract: vi.fn(async (_pages: number[] | TPageSelection) => true),
        handlePageRotate: vi.fn(async (_pages: number[] | TPageSelection, _angle: 90 | 270) => true),
        pageOpsInsert: vi.fn(async (_totalPages: number, _afterPage: number) => true),
        pageOpsReorder: vi.fn(async (_order: number[]) => true),
        pageOpsMove: vi.fn(async (_move: TPageMoveOperation) => true),
        handleCropPages: vi.fn(async (_pages: number[], _margins) => true),
        handlePageDelete: vi.fn(),
        handlePageReorder: vi.fn(),
        handlePageMove: vi.fn(),
        totalPages: ref(7),
        isDjvuMode: ref(false),
        openConvertDialog: vi.fn(),
        captureSplitPayload: vi.fn(async () => ({kind: 'empty' as const})),
        restoreSplitPayload: vi.fn(async () => ({status: 'cancelled' as const})),
        waitForDocumentOpenSettled: vi.fn(async () => {}),
        runAgentAction: vi.fn(async () => ({})),
        readAgentResource: vi.fn(async () => ({})),
        workingCopyPath: ref(null),
        originalPath: ref(null),
        pdfData: ref(null),
        pdfReloadSrc: ref(null),
        annotationComments: ref([]),
        annotationCommentsStatus: ref('ready'),
        annotationInventory: ref(null),
        annotationDirty: ref(false),
        sortedAnnotationNoteWindows: ref([]),
        handleOcrComplete: vi.fn(async () => {}),
        ...overrides,
    } satisfies Parameters<typeof createWorkspaceExpose>[0];
}

describe('createWorkspaceExpose', () => {
    it('keeps a compact selection available to snapshots and page actions', () => {
        const selection = createRangePageSelection(1_000_000, 2, 100_002);
        const deps = createDeps({
            totalPages: ref(1_000_000),
            selectedThumbnailPages: ref([]),
            selectedPageSelection: ref(selection),
        });
        const exposed = createWorkspaceExpose(deps);

        expect(exposed.getToolbarSnapshot().selectedPageCount).toBe(100_001);
        exposed.handleDeletePages();
        exposed.handleExtractPages();
        exposed.handleRotateCw();

        expect(deps.pageOpsDelete).toHaveBeenCalledWith(selection, 1_000_000);
        expect(deps.pageOpsExtract).toHaveBeenCalledWith(selection);
        expect(deps.handlePageRotate).toHaveBeenCalledWith(selection, 90);
    });
    it('reports inventory completeness beside the annotation list it qualifies', () => {
        const incompleteInventory: IAnnotationInventoryCompleteness = {
            complete: false,
            omissions: ['page-parse-failure'],
            scannedPageCount: 2,
            totalPageCount: 3,
            failedPageCount: 1,
        };
        const annotationInventory = ref<IAnnotationInventoryCompleteness | null>(incompleteInventory);
        const deps = createDeps({annotationInventory});

        // An automation client reads `annotationComments` as the document's
        // annotations, so a truncated scan has to say so in the same snapshot.
        expect(createWorkspaceExpose(deps).getAutomationStateSnapshot().annotationInventory)
            .toEqual(incompleteInventory);
    });

    it('hands out an inventory record that cannot write back into workspace state', () => {
        const liveInventory: IAnnotationInventoryCompleteness = {
            complete: false,
            omissions: ['page-parse-failure'],
            scannedPageCount: 2,
            totalPageCount: 3,
            failedPageCount: 1,
        };
        const annotationInventory = ref<IAnnotationInventoryCompleteness | null>(liveInventory);
        const expose = createWorkspaceExpose(createDeps({annotationInventory}));

        const snapshot = expose.getAutomationStateSnapshot().annotationInventory;
        expect(snapshot).not.toBeNull();
        expect(snapshot).not.toBe(annotationInventory.value);
        snapshot!.complete = true;
        snapshot!.failedPageCount = 0;
        (snapshot!.omissions as TAnnotationInventoryOmission[]).push('page-cap');

        // A snapshot is a value, not a window: mutating one reading must not
        // rewrite the workspace's own record or the next reading of it.
        expect(annotationInventory.value).toEqual(liveInventory);
        expect(expose.getAutomationStateSnapshot().annotationInventory).toEqual({
            complete: false,
            omissions: ['page-parse-failure'],
            scannedPageCount: 2,
            totalPageCount: 3,
            failedPageCount: 1,
        });
    });

    it('reports a null inventory until a scan has measured one', () => {
        expect(createWorkspaceExpose(createDeps()).getAutomationStateSnapshot().annotationInventory)
            .toBeNull();
    });

    it('reports the active DjVu source as the automation document identity', () => {
        const expose = createWorkspaceExpose(createDeps({
            isDjvuMode: ref(true),
            originalPath: ref(requireDocumentRef('/tmp/reader.djvu')),
        }));

        expect(expose.getAutomationStateSnapshot().originalPath).toBe('/tmp/reader.djvu');
    });

    it('reports path-backed PDF ownership without exposing bytes', () => {
        const deps = createDeps({
            pdfData: ref(null),
            pdfReloadSrc: ref<TPdfSource>({
                kind: 'path',
                path: requireDocumentRef('/tmp/working.pdf'),
                size: 4_096,
            }),
        });

        expect(createWorkspaceExpose(deps).getAutomationStateSnapshot().pdfSourceState)
            .toEqual({
                hasInMemoryData: false,
                reloadKind: 'path',
                reloadPath: '/tmp/working.pdf',
            });
    });

    it('runs save only when the toolbar save command is enabled', async () => {
        const deps = createDeps({
            hasPdf: ref(true),
            canSave: ref(true),
        });
        const exposed = createWorkspaceExpose(deps);

        await exposed.handleSave();

        expect(deps.handleSave).toHaveBeenCalledOnce();
    });

    it('steps whole-document view rotation without invoking page mutation', () => {
        const viewRotation = ref<0 | 90 | 180 | 270>(0);
        const handlePageRotate = vi.fn();
        const exposed = createWorkspaceExpose(createDeps({
            hasPdf: ref(true),
            viewRotation,
            handlePageRotate,
        }));

        exposed.handleViewRotationCw();
        exposed.handleViewRotationCw();
        exposed.handleViewRotationCcw();

        expect(viewRotation.value).toBe(90);
        expect(exposed.getToolbarSnapshot().viewRotation).toBe(90);
        expect(handlePageRotate).not.toHaveBeenCalled();
    });

    it('ignores save shortcuts when the toolbar save command is disabled', async () => {
        const deps = createDeps({
            hasPdf: ref(true),
            canSave: ref(false),
        });
        const exposed = createWorkspaceExpose(deps);

        await expect(exposed.handleSave()).resolves.toBe(true);

        expect(deps.handleSave).not.toHaveBeenCalled();
    });

    it('runs save when pending changes outlive a stale disabled toolbar state', async () => {
        const deps = createDeps({
            hasPdf: ref(true),
            canSave: ref(false),
            hasPendingUnsavedChanges: computed(() => true),
            handleSave: vi.fn(async () => true),
        });
        const exposed = createWorkspaceExpose(deps);

        await expect(exposed.handleSave()).resolves.toBe(true);

        expect(deps.handleSave).toHaveBeenCalledOnce();
    });

    it('runs repair save when a PDF is open even if ordinary save is disabled', async () => {
        const deps = createDeps({
            hasPdf: ref(true),
            canSave: ref(false),
        });
        const exposed = createWorkspaceExpose(deps);

        await exposed.handleRepairSave();

        expect(deps.handleRepairSave).toHaveBeenCalledOnce();
        expect(exposed.getToolbarSnapshot().canRepairSave).toBe(true);
    });

    it('runs PDF optimization when a PDF is open even if ordinary save is disabled', async () => {
        const deps = createDeps({
            hasPdf: ref(true),
            canSave: ref(false),
        });
        const exposed = createWorkspaceExpose(deps);

        await exposed.handleOptimizePdfForInteraction();

        expect(deps.handleOptimizePdfForInteraction).toHaveBeenCalledOnce();
    });

    it('ignores save while another save operation is active', async () => {
        const deps = createDeps({
            hasPdf: ref(true),
            canSave: ref(true),
            isAnySaving: ref(true),
        });
        const exposed = createWorkspaceExpose(deps);

        await exposed.handleSave();

        expect(deps.handleSave).not.toHaveBeenCalled();
    });

    it('clamps zoom in/out commands', () => {
        const deps = createDeps({
            zoom: ref(9.9),
            effectiveZoom: ref(9.9),
        });
        const exposed = createWorkspaceExpose(deps);

        exposed.handleZoomIn();
        exposed.handleZoomIn();
        expect(deps.zoom.value).toBe(10);
        expect(deps.zoomMode.value).toBe('custom');

        deps.zoom.value = 0.3;
        deps.effectiveZoom.value = 0.3;
        exposed.handleZoomOut();
        exposed.handleZoomOut();
        expect(deps.zoom.value).toBe(0.25);
    });

    it('converts fit zoom steps into custom zoom based on effective zoom', () => {
        const deps = createDeps({
            zoom: ref(1),
            effectiveZoom: ref(2.5),
            zoomMode: ref('fit-width'),
            fitMode: ref('width'),
        });
        const exposed = createWorkspaceExpose(deps);

        exposed.handleZoomIn();

        expect(deps.zoom.value).toBeCloseTo(2.75, 6);
        expect(deps.effectiveZoom.value).toBeCloseTo(2.75, 6);
        expect(deps.zoomMode.value).toBe('custom');
    });

    it('exposes exact custom display zoom for automation', () => {
        const deps = createDeps({
            zoom: ref(1),
            effectiveZoom: ref(1),
            zoomMode: ref('fit-width'),
        });
        const exposed = createWorkspaceExpose(deps);

        exposed.setCustomZoomFromDisplay(0.29);

        expect(deps.zoom.value).toBeCloseTo(0.29, 6);
        expect(deps.effectiveZoom.value).toBeCloseTo(0.29, 6);
        expect(deps.zoomMode.value).toBe('custom');

        // A late viewer layout measurement must not replace the user's custom
        // display value in the toolbar snapshot.
        deps.effectiveZoom.value = 2.61;
        expect(exposed.getToolbarSnapshot().effectiveZoom).toBeCloseTo(0.29, 6);
    });

    it('does not jump upward when zooming out from fit below the manual minimum', () => {
        const deps = createDeps({
            zoom: ref(1),
            effectiveZoom: ref(0.12),
            zoomMode: ref('fit-height'),
            fitMode: ref('height'),
        });
        const exposed = createWorkspaceExpose(deps);

        exposed.handleZoomOut();

        expect(deps.zoom.value).toBe(1);
        expect(deps.effectiveZoom.value).toBe(0.12);
        expect(deps.zoomMode.value).toBe('fit-height');
    });

    it('ignores view controls that the active viewer cannot honor', () => {
        const deps = createDeps({
            hasPdf: ref(true),
            viewerCapabilities: ref({
                ...createDefaultWorkspaceViewerCapabilities(),
                closeableDocument: true,
                pdfDocument: true,
                print: true,
            }),
        });
        const exposed = createWorkspaceExpose(deps);

        exposed.handleToggleContinuousScroll();
        exposed.handleViewModeFacing();
        exposed.handleViewModeFacingFirstSingle();

        expect(deps.handleToggleContinuousScroll).not.toHaveBeenCalled();
        expect(deps.viewMode.value).toBe('single');
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

    it('rotates explicit pages without changing thumbnail selection', () => {
        const deps = createDeps({selectedThumbnailPages: ref([3])});
        const exposed = createWorkspaceExpose(deps);

        exposed.handleRotateCw([1]);

        expect(deps.handlePageRotate).toHaveBeenCalledWith([1], 90);
        expect(deps.selectedThumbnailPages.value).toEqual([3]);
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

    it('suppresses region capture in DjVu mode', () => {
        const deps = createDeps({ isDjvuMode: ref(true) });
        const exposed = createWorkspaceExpose(deps);

        exposed.handleCaptureRegion();
        expect(deps.handleCaptureRegion).not.toHaveBeenCalled();

        deps.isDjvuMode.value = false;
        exposed.handleCaptureRegion();
        expect(deps.handleCaptureRegion).toHaveBeenCalledOnce();
    });

    it('suppresses crop in DjVu mode', () => {
        const deps = createDeps({ isDjvuMode: ref(true) });
        const exposed = createWorkspaceExpose(deps);

        exposed.handleCrop();
        expect(deps.handleCrop).not.toHaveBeenCalled();

        deps.isDjvuMode.value = false;
        exposed.handleCrop();
        expect(deps.handleCrop).toHaveBeenCalledOnce();
    });

    it('includes print preparation state in the toolbar snapshot', () => {
        const deps = createDeps({
            isPreparingPrint: ref(true),
            isPreparingCurrentPagePrint: ref(true),
        });
        const exposed = createWorkspaceExpose(deps);

        expect(exposed.getToolbarSnapshot().isPreparingPrint).toBe(true);
        expect(exposed.getToolbarSnapshot().isPreparingCurrentPagePrint).toBe(true);
    });

    it('keeps toolbar current page owned by the reactive workspace authority', () => {
        const currentPage = ref(2);
        const documentViewerRef = ref<IWorkspaceDocumentViewerNavigationPort | null>({
            getCurrentPage: () => 8,
            scrollToPage: vi.fn(),
        });
        const deps = createDeps({
            currentPage,
            totalPages: ref(10),
            documentViewerRef,
        });
        const exposed = createWorkspaceExpose(deps);
        const snapshot = computed(exposed.getToolbarSnapshot);

        expect(snapshot.value.currentPage).toBe(2);

        currentPage.value = 6;

        expect(snapshot.value.currentPage).toBe(6);
    });

    it('publishes known page count and prepared scale while the first visual is pending', () => {
        const documentViewerRef = ref<IWorkspaceDocumentViewerNavigationPort | null>({
            getCurrentPage: () => 99,
            scrollToPage: vi.fn(),
        });
        const deps = createDeps({
            hasPdf: ref(true),
            isOpeningDocument: ref(true),
            currentPage: ref(42),
            totalPages: ref(564),
            zoom: ref(2.38),
            effectiveZoom: ref(2.38),
            documentViewerRef,
        });
        const exposed = createWorkspaceExpose(deps);

        expect(exposed.getToolbarSnapshot()).toMatchObject({
            isOpeningDocument: true,
            currentPage: 1,
            totalPages: 564,
            zoom: 2.38,
            effectiveZoom: 2.38,
        });
    });

    it('publishes native preview pagination while PDF.js is still opening', () => {
        const deps = createDeps({
            hasPdf: ref(true),
            isOpeningDocument: ref(true),
            openingPreviewReady: ref(true),
            currentPage: ref(4),
            totalPages: ref(7),
            toolbarCurrentPage: ref(42),
            toolbarTotalPages: ref(564),
            selectedThumbnailPages: ref([4]),
        });
        const exposed = createWorkspaceExpose(deps);

        expect(exposed.getToolbarSnapshot()).toMatchObject({
            isOpeningDocument: true,
            openingPreviewReady: true,
            currentPage: 42,
            totalPages: 564,
        });

        exposed.handleDeletePages();
        expect(deps.pageOpsDelete).toHaveBeenCalledWith([4], 7);
    });

    it('keeps opening pagination empty when no authoritative count exists', () => {
        const exposed = createWorkspaceExpose(createDeps({
            hasPdf: ref(true),
            isOpeningDocument: ref(true),
            currentPage: ref(42),
            totalPages: ref(0),
        }));

        expect(exposed.getToolbarSnapshot()).toMatchObject({
            isOpeningDocument: true,
            currentPage: 1,
            totalPages: 0,
        });
    });

    it('delegates public automation methods through the narrow PDF automation port', async () => {
        const commentAtPoint = vi.fn(async () => true);
        const highlightSelection = vi.fn(async () => true);
        const shape = {
            id: 'shape-1',
            type: 'rectangle' as const,
            pageIndex: 0,
            x: 10,
            y: 20,
            width: 100,
            height: 50,
            color: '#ff0000',
            opacity: 1,
            strokeWidth: 2,
        };
        const pdfAutomationViewerRef = ref({
            commentAtPoint,
            getAllShapes: () => [shape],
            getDeletedEmbeddedShapeAnnotationIds: () => ['44R'],
            getDeletedEmbeddedShapeStableKeys: () => ['evb-shape:deleted'],
            highlightSelection,
        });
        const deps = createDeps({pdfAutomationViewerRef});
        const exposed = createWorkspaceExpose(deps);

        expect(exposed.getAllShapes?.()).toEqual([shape]);
        expect(exposed.getDeletedEmbeddedShapeAnnotationIds?.()).toEqual(['44R']);
        expect(exposed.getDeletedEmbeddedShapeStableKeys?.()).toEqual(['evb-shape:deleted']);
        await expect(exposed.highlightSelection?.()).resolves.toBe(true);
        await expect(
            exposed.commentAtPoint?.(1, 20, 30, {preferTextAnchor: true}),
        ).resolves.toBe(true);
        expect(highlightSelection).toHaveBeenCalledOnce();
        expect(commentAtPoint).toHaveBeenCalledWith(1, 20, 30, {preferTextAnchor: true});
    });

    it('hands automation the real annotation creation outcome', async () => {
        const commentAtPoint = vi.fn(async (): Promise<boolean> => false);
        const highlightSelection = vi.fn(async (): Promise<boolean> => false);
        const pdfAutomationViewerRef = ref({
            commentAtPoint,
            highlightSelection,
        });
        const exposed = createWorkspaceExpose(createDeps({pdfAutomationViewerRef}));

        await expect(exposed.highlightSelection?.()).resolves.toBe(false);
        await expect(
            exposed.commentAtPoint?.(1, 20, 30, {preferTextAnchor: false}),
        ).resolves.toBe(false);

        // A hard-coded refusal would pass the assertions above, so the same
        // calls have to carry a success through once the viewer reports one.
        commentAtPoint.mockResolvedValue(true);
        highlightSelection.mockResolvedValue(true);

        await expect(exposed.highlightSelection?.()).resolves.toBe(true);
        await expect(
            exposed.commentAtPoint?.(1, 20, 30, {preferTextAnchor: false}),
        ).resolves.toBe(true);
    });
});
