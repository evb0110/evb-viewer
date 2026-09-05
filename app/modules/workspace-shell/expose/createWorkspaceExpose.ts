import type {
    ComputedRef,
    Ref,
} from 'vue';
import { ZOOM } from '@app/constants/pdfLayout';
import type {
    IAnnotationCommentSummary,
    IAnnotationInventoryCompleteness,
    TAnnotationCommentsStatus,
} from '@app/types/annotations';
import type { TDocumentRef } from '@contracts/documentRef';
import type { ICropMargins } from '@app/types/crop';
import type {
    TPageMoveOperation,
    TPageSelection,
} from '@contracts/pageNumbers';
import { pageSelectionCount } from '@contracts/pageNumbers';
import type { IPdfPageLabelRange } from '@contracts/pdfPageLabels';
import type {
    TFitMode,
    TPdfViewRotation,
    TPdfViewMode,
    TZoomMode,
} from '@contracts/shared';
import type {
    IWorkspaceAgentPort,
    IWorkspaceExportPort,
    IWorkspaceExpose,
    IWorkspaceFilePort,
    IWorkspaceAutomationStateSnapshot,
    IWorkspaceToolbarSnapshot,
    IWorkspaceViewerCapabilities,
} from '@app/types/workspaceExpose';
import { createDefaultWorkspaceViewerCapabilities } from '@app/types/workspaceExpose';
import { clampPdfManualZoom } from '@app/modules/pdf-viewer/public';
import type { IScrollToPageOptions } from '@app/modules/pdf-viewer/public';
import type { IAnnotationNoteWindowViewModel } from '@app/types/annotationNoteWindow';
import {
    createWorkspaceExposeCommandHandlers,
    createWorkspaceExposeCommandRunner,
    createWorkspaceExposeFromCommandHandlers,
    type TWorkspaceExposeCommandHandlerMap,
} from '@app/modules/workspace-shell/expose/workspaceExposeDescriptors';
import type {
    IWorkspaceDocumentViewerNavigationPort,
    IWorkspacePdfViewerExposeAutomationPort,
} from '@app/modules/workspace-shell/types/workspaceOrchestration.types';
import type { TDocumentSidebarTab } from '@app/utils/document-viewer/sidebar/documentSidebarTabs';
import type { TPdfSource } from '@app/types/pdfUi';
import type { TWorkspaceOrchestration } from '@app/modules/workspace-shell/useWorkspaceOrchestration';
import { stepPdfViewRotation } from '@app/utils/pdfViewRotation';

export interface ICreateWorkspaceExposeDeps extends
    IWorkspaceFilePort,
    IWorkspaceExportPort,
    IWorkspaceAgentPort {
    hasPdf: Ref<boolean>;
    isOpeningDocument: Ref<boolean>;
    initialVisualReady: Ref<boolean>;
    openingPreviewReady: Ref<boolean>;
    hasOpenError: Ref<boolean>;
    isPreparingPrint: Ref<boolean>;
    isPreparingCurrentPagePrint: Ref<boolean>;
    canSave: Ref<boolean>;
    canRepairSave?: Ref<boolean>;
    canOptimizePdf?: Ref<boolean>;
    canUndo: Ref<boolean>;
    canRedo: Ref<boolean>;
    canExportDocx: Ref<boolean>;
    isSaving: Ref<boolean>;
    isSavingAs: Ref<boolean>;
    isAnySaving: Ref<boolean>;
    isHistoryBusy: Ref<boolean>;
    isExportingDocx: Ref<boolean>;
    hasOpenAnnotationNotes?: Ref<boolean>;
    isFitWidthActive: Ref<boolean>;
    isFitHeightActive: Ref<boolean>;
    showSidebar: Ref<boolean>;
    sidebarTab?: Ref<TDocumentSidebarTab>;
    sidebarWidth?: Ref<number>;
    dragMode: Ref<boolean>;
    continuousScroll: Ref<boolean>;
    isCapturingRegion: Ref<boolean>;
    isCropSelecting: Ref<boolean>;
    isPlacingPageNote: Ref<boolean>;
    closeAllDropdowns: () => void;
    zoom: Ref<number>;
    effectiveZoom: Ref<number>;
    zoomMode: Ref<TZoomMode>;
    fitMode: Ref<TFitMode>;
    viewMode: Ref<TPdfViewMode>;
    viewRotation: Ref<TPdfViewRotation>;
    currentPage: Ref<number>;
    toolbarCurrentPage?: Ref<number>;
    toolbarTotalPages?: Ref<number>;
    pdfAutomationViewerRef?: Ref<IWorkspacePdfViewerExposeAutomationPort | null>;
    documentViewerRef?: Ref<IWorkspaceDocumentViewerNavigationPort | null>;
    handleFitMode: (mode: TFitMode) => void;
    handleGoToPage: (page: number, options?: IScrollToPageOptions) => void;
    handleToggleSidebar: () => void;
    handleToggleContinuousScroll: () => void;
    handleEnableDragMode: () => void;
    handleDisableDragMode: () => void;
    handleCaptureRegion: () => void;
    handleCrop: () => void;
    handleQuickNote: () => void;
    handleInsertImageFromFile: () => Promise<void>;
    handlePasteImageFromClipboard: () => Promise<void>;
    selectedThumbnailPages: Ref<number[]>;
    selectedPageSelection?: Ref<TPageSelection | null>;
    isPageOperationInProgress?: Ref<boolean>;
    pageOpsDelete: (pages: number[] | TPageSelection, totalPages: number) => Promise<boolean>;
    pageOpsExtract: (pages: number[] | TPageSelection) => Promise<boolean>;
    handlePageRotate: (pages: number[] | TPageSelection, angle: 90 | 270) => Promise<boolean>;
    pageOpsInsert: (totalPages: number, afterPage: number) => Promise<boolean>;
    pageOpsReorder: (order: number[]) => Promise<boolean>;
    pageOpsMove: (move: TPageMoveOperation) => Promise<boolean>;
    handleCropPages: (pages: number[], margins: ICropMargins) => Promise<boolean>;
    handlePageDelete: (pages: number[]) => void;
    handlePageReorder: (order: number[]) => void;
    handlePageMove: (move: TPageMoveOperation) => void;
    ensurePdfProjectionForEdit?: () => Promise<boolean>;
    pageLabels?: Ref<string[] | null>;
    pageLabelRanges?: Ref<IPdfPageLabelRange[]>;
    pageLabelsResolved?: Ref<boolean>;
    totalPages: Ref<number>;
    isDjvuMode: Ref<boolean>;
    viewerCapabilities?: Ref<IWorkspaceViewerCapabilities>;
    openConvertDialog: () => void;
    captureSplitPayload: IWorkspaceExpose['captureSplitPayload'];
    restoreSplitPayload: IWorkspaceExpose['restoreSplitPayload'];
    waitForDocumentOpenSettled: IWorkspaceExpose['waitForDocumentOpenSettled'];
    workingCopyPath: Ref<TDocumentRef | null>;
    originalPath: Ref<TDocumentRef | null>;
    pdfData: Ref<Uint8Array | null>;
    pdfReloadSrc: Ref<TPdfSource | null>;
    requiresSaveAsOnFirstSave?: Ref<boolean>;
    annotationComments: Ref<IAnnotationCommentSummary[]>;
    annotationCommentsStatus: Ref<TAnnotationCommentsStatus>;
    annotationInventory: Ref<IAnnotationInventoryCompleteness | null>;
    annotationDirty: Ref<boolean>;
    isDirty?: Ref<boolean>;
    hasAnnotationChanges?: () => boolean;
    getAnnotationDirtyEntityCount?: () => number;
    hasPendingUnsavedChanges?: ComputedRef<boolean>;
    pendingEmbeddedAnnotationDeleteCount?: ComputedRef<number>;
    pageLabelsDirty?: Ref<boolean>;
    bookmarksDirty?: Ref<boolean>;
    sortedAnnotationNoteWindows: Ref<IAnnotationNoteWindowViewModel[]>;
    handleOcrComplete: (payload: unknown) => Promise<void>;
    createRecoverySnapshotBytes?: IWorkspaceExpose['createRecoverySnapshotBytes'];
}

export interface ICreateWorkspaceExposeFromOwnersOptions {
    orchestration: TWorkspaceOrchestration;
    handleSave: ICreateWorkspaceExposeDeps['handleSave'];
    handleOptimizePdfForInteraction: ICreateWorkspaceExposeDeps['handleOptimizePdfForInteraction'];
    handleSaveAs: ICreateWorkspaceExposeDeps['handleSaveAs'];
    handleExportDocx: ICreateWorkspaceExposeDeps['handleExportDocx'];
    handleGoToPage: ICreateWorkspaceExposeDeps['handleGoToPage'];
    handleCrop: ICreateWorkspaceExposeDeps['handleCrop'];
    handleInsertImageFromFile: ICreateWorkspaceExposeDeps['handleInsertImageFromFile'];
    handlePasteImageFromClipboard: ICreateWorkspaceExposeDeps['handlePasteImageFromClipboard'];
    initialVisualReady: ICreateWorkspaceExposeDeps['initialVisualReady'];
    openingPreviewReady: ICreateWorkspaceExposeDeps['openingPreviewReady'];
    toolbarCurrentPage: NonNullable<ICreateWorkspaceExposeDeps['toolbarCurrentPage']>;
    toolbarTotalPages: NonNullable<ICreateWorkspaceExposeDeps['toolbarTotalPages']>;
    isOpeningDocument: ICreateWorkspaceExposeDeps['isOpeningDocument'];
    canRepairSave: NonNullable<ICreateWorkspaceExposeDeps['canRepairSave']>;
    canOptimizePdf: NonNullable<ICreateWorkspaceExposeDeps['canOptimizePdf']>;
    canExportDocx: ICreateWorkspaceExposeDeps['canExportDocx'];
    viewerCapabilities: NonNullable<ICreateWorkspaceExposeDeps['viewerCapabilities']>;
    captureSplitPayload: ICreateWorkspaceExposeDeps['captureSplitPayload'];
    restoreSplitPayload: ICreateWorkspaceExposeDeps['restoreSplitPayload'];
    waitForDocumentOpenSettled: ICreateWorkspaceExposeDeps['waitForDocumentOpenSettled'];
    runAgentAction: ICreateWorkspaceExposeDeps['runAgentAction'];
    readAgentResource: ICreateWorkspaceExposeDeps['readAgentResource'];
    ensurePdfProjectionForEdit?: ICreateWorkspaceExposeDeps['ensurePdfProjectionForEdit'];
    handlePageDelete: ICreateWorkspaceExposeDeps['handlePageDelete'];
    handlePageReorder: ICreateWorkspaceExposeDeps['handlePageReorder'];
    handlePageMove: ICreateWorkspaceExposeDeps['handlePageMove'];
}

function getSelectedPages(selectedThumbnailPages: Ref<number[]>) {
    return selectedThumbnailPages.value;
}

function getSelectedPagePayload(deps: Pick<
    ICreateWorkspaceExposeDeps,
    'selectedPageSelection' | 'selectedThumbnailPages' | 'totalPages'
>) {
    const selection = deps.selectedPageSelection?.value;
    return selection?.pageCount === deps.totalPages.value
        ? selection
        : getSelectedPages(deps.selectedThumbnailPages);
}

function selectedPagePayloadCount(payload: number[] | TPageSelection) {
    return Array.isArray(payload) ? payload.length : pageSelectionCount(payload);
}

function normalizeToolbarSnapshotPage(page: number | undefined) {
    if (typeof page !== 'number' || !Number.isFinite(page)) {
        return 1;
    }
    return Math.max(1, Math.floor(page));
}

function normalizeToolbarSnapshotTotalPages(totalPages: number | undefined, minimum: number) {
    if (typeof totalPages !== 'number' || !Number.isFinite(totalPages)) {
        return minimum;
    }
    return Math.max(minimum, Math.floor(totalPages));
}

function clampZoomLevel(level: number) {
    return clampPdfManualZoom(level);
}

/**
 * Builds the public workspace command surface exposed to parent tabs/menu bindings.
 * Keeping this mapping centralized avoids duplicating command wiring in component files.
 */
export function createWorkspaceExpose(deps: ICreateWorkspaceExposeDeps): IWorkspaceExpose {
    const viewerCapabilities = () => deps.viewerCapabilities?.value ?? (
        deps.isDjvuMode.value
            ? {
                ...createDefaultWorkspaceViewerCapabilities(),
                closeableDocument: true,
                conversionBanner: true,
                conversionDialog: true,
                continuousScroll: true,
                viewMode: true,
            }
            : {
                ...createDefaultWorkspaceViewerCapabilities(),
                closeableDocument: deps.hasPdf.value,
                continuousScroll: deps.hasPdf.value,
                crop: true,
                optimizePdf: deps.hasPdf.value,
                pdfDocument: deps.hasPdf.value,
                pdfMutationActions: deps.hasPdf.value,
                regionCapture: true,
                repairSave: deps.hasPdf.value,
                save: deps.hasPdf.value,
                saveAs: deps.hasPdf.value,
                sidebar: deps.hasPdf.value,
                viewMode: deps.hasPdf.value,
                viewRotation: deps.hasPdf.value,
            }
    );
    const canRepairSave = () => deps.canRepairSave?.value ?? (
        deps.hasPdf.value
        && !deps.isOpeningDocument.value
        && !deps.hasOpenError.value
        && !deps.isAnySaving.value
        && !deps.isHistoryBusy.value
        && viewerCapabilities().repairSave
    );
    const canOptimizePdf = () => deps.canOptimizePdf?.value ?? (
        deps.hasPdf.value
        && !deps.isOpeningDocument.value
        && !deps.hasOpenError.value
        && !deps.isAnySaving.value
        && !deps.isHistoryBusy.value
        && viewerCapabilities().optimizePdf
    );

    async function handleSaveFromCommandSurface() {
        const hasSaveableOpenNotes = deps.hasOpenAnnotationNotes?.value === true;
        const hasPendingChanges = deps.hasPendingUnsavedChanges?.value === true;
        if (
            !deps.hasPdf.value
            || deps.isAnySaving.value
            || deps.isHistoryBusy.value
            || !viewerCapabilities().save
        ) {
            return false;
        }
        if (!deps.canSave.value && !hasPendingChanges && !hasSaveableOpenNotes) {
            return true;
        }

        return deps.handleSave();
    }

    async function handleRepairSaveFromCommandSurface() {
        if (!canRepairSave()) {
            return false;
        }

        return deps.handleRepairSave();
    }

    async function handleOptimizePdfForInteractionFromCommandSurface() {
        if (!canOptimizePdf()) {
            return false;
        }

        return deps.handleOptimizePdfForInteraction();
    }

    function getToolbarSnapshot(): IWorkspaceToolbarSnapshot {
        const isOpeningDocument = deps.isOpeningDocument.value;
        const openingPreviewReady = deps.openingPreviewReady.value;
        const toolbarCurrentPage = deps.toolbarCurrentPage?.value ?? deps.currentPage.value;
        const currentPage = isOpeningDocument && !openingPreviewReady
            ? 1
            : normalizeToolbarSnapshotPage(toolbarCurrentPage);
        const totalPages = normalizeToolbarSnapshotTotalPages(
            deps.toolbarTotalPages?.value ?? deps.totalPages.value,
            isOpeningDocument && !openingPreviewReady ? 0 : currentPage,
        );
        // Before any opening preview exists, page one prevents stale position
        // from the replaced document leaking into the new open. Once the
        // native source paints, its page and count become toolbar authority.
        const zoom = deps.zoom.value;
        const effectiveZoom = deps.effectiveZoom.value;
        return {
            hasPdf: deps.hasPdf.value,
            initialVisualReady: deps.initialVisualReady.value,
            openingPreviewReady,
            isOpeningDocument,
            hasOpenError: deps.hasOpenError.value,
            isPreparingPrint: deps.isPreparingPrint.value,
            isPreparingCurrentPagePrint: deps.isPreparingCurrentPagePrint.value,
            canSave: deps.canSave.value,
            canRepairSave: canRepairSave(),
            canOptimizePdf: canOptimizePdf(),
            canUndo: deps.canUndo.value,
            canRedo: deps.canRedo.value,
            canExportDocx: deps.canExportDocx.value,
            isSaving: deps.isSaving.value,
            isSavingAs: deps.isSavingAs.value,
            isAnySaving: deps.isAnySaving.value,
            isHistoryBusy: deps.isHistoryBusy.value,
            isExportingDocx: deps.isExportingDocx.value,
            isFitWidthActive: deps.isFitWidthActive.value,
            isFitHeightActive: deps.isFitHeightActive.value,
            showSidebar: deps.showSidebar.value,
            sidebarTab: deps.sidebarTab?.value ?? 'thumbnails',
            sidebarWidth: deps.sidebarWidth?.value ?? 272,
            dragMode: deps.dragMode.value,
            continuousScroll: deps.continuousScroll.value,
            isDjvuMode: deps.isDjvuMode.value,
            viewerCapabilities: viewerCapabilities(),
            isCapturingRegion: deps.isCapturingRegion.value,
            isCropSelecting: deps.isCropSelecting.value,
            isPlacingPageNote: deps.isPlacingPageNote.value,
            zoom,
            effectiveZoom,
            zoomMode: deps.zoomMode.value,
            fitMode: deps.fitMode.value,
            viewMode: deps.viewMode.value,
            viewRotation: deps.viewRotation.value,
            currentPage,
            totalPages,
            selectedPageCount: selectedPagePayloadCount(getSelectedPagePayload(deps)),
            isPageOperationInProgress: deps.isPageOperationInProgress?.value ?? false,
        };
    }

    function resolveDisplayZoom() {
        if (Number.isFinite(deps.effectiveZoom.value) && deps.effectiveZoom.value > 0) {
            return deps.effectiveZoom.value;
        }
        return clampZoomLevel(deps.zoom.value);
    }

    function setCustomZoomFromDisplay(displayZoom: number) {
        const targetDisplayZoom = clampZoomLevel(displayZoom);
        deps.zoom.value = targetDisplayZoom;
        deps.effectiveZoom.value = targetDisplayZoom;
        deps.zoomMode.value = 'custom';
    }

    /**
     * Copy the inventory record out of reactive state.
     *
     * The snapshot is a value handed to automation clients, not a window onto
     * live state: returning the ref's own object would let a caller mutate the
     * workspace's completeness record, and would make every snapshot taken
     * from the same ref alias the one before it, so a mutation applied to one
     * reading silently rewrites the others.
     */
    function cloneAnnotationInventory(
        inventory: IAnnotationInventoryCompleteness | null,
    ): IAnnotationInventoryCompleteness | null {
        if (!inventory) {
            return null;
        }
        return {
            complete: inventory.complete,
            omissions: [...inventory.omissions],
            scannedPageCount: inventory.scannedPageCount,
            totalPageCount: inventory.totalPageCount,
            failedPageCount: inventory.failedPageCount,
        };
    }

    function getAutomationStateSnapshot(): IWorkspaceAutomationStateSnapshot {
        const reloadSrc = deps.pdfReloadSrc.value;
        return {
            annotationComments: [...deps.annotationComments.value],
            annotationCommentsStatus: deps.annotationCommentsStatus.value,
            annotationInventory: cloneAnnotationInventory(deps.annotationInventory.value),
            annotationDirty: deps.annotationDirty.value,
            pageLabels: deps.pageLabels?.value ?? null,
            pageLabelRanges: structuredClone(deps.pageLabelRanges?.value ?? []),
            pageLabelsResolved: deps.pageLabelsResolved?.value ?? false,
            isPageOperationInProgress: deps.isPageOperationInProgress?.value ?? false,
            totalPages: deps.totalPages.value,
            dirtyState: {
                annotationDirty: deps.annotationDirty.value,
                bookmarksDirty: deps.bookmarksDirty?.value ?? false,
                fileDirty: deps.isDirty?.value ?? false,
                hasAnnotationChanges: deps.hasAnnotationChanges?.() ?? false,
                annotationDirtyEntityCount: deps.getAnnotationDirtyEntityCount?.() ?? 0,
                hasPendingUnsavedChanges: deps.hasPendingUnsavedChanges?.value ?? false,
                pageLabelsDirty: deps.pageLabelsDirty?.value ?? false,
                pendingEmbeddedAnnotationDeleteCount: deps.pendingEmbeddedAnnotationDeleteCount?.value ?? 0,
            },
            originalPath: deps.originalPath.value,
            pdfSourceState: {
                hasInMemoryData: deps.pdfData.value !== null,
                reloadKind: reloadSrc instanceof Blob
                    ? 'blob'
                    : reloadSrc?.kind ?? 'none',
                reloadPath: reloadSrc instanceof Blob
                    ? null
                    : reloadSrc?.path ?? null,
            },
            requiresSaveAsOnFirstSave: deps.requiresSaveAsOnFirstSave?.value ?? false,
            sortedAnnotationNoteWindows: deps.sortedAnnotationNoteWindows.value.map(note => ({
                ...note,
                markerRect: note.markerRect ? {...note.markerRect} : null,
            })),
            workingCopyPath: deps.workingCopyPath.value,
        };
    }

    async function runPageOperation(operation: () => Promise<boolean>) {
        if (deps.ensurePdfProjectionForEdit && !await deps.ensurePdfProjectionForEdit()) {
            return false;
        }
        return operation();
    }

    const customHandlers: Partial<TWorkspaceExposeCommandHandlerMap> = {
        pageOpsDelete: (pages, totalPages) => runPageOperation(
            () => deps.pageOpsDelete(pages, totalPages),
        ),
        handlePageRotate: (pages, angle) => runPageOperation(
            () => deps.handlePageRotate(pages, angle),
        ),
        pageOpsInsert: (totalPages, afterPage) => runPageOperation(
            () => deps.pageOpsInsert(totalPages, afterPage),
        ),
        pageOpsReorder: order => runPageOperation(() => deps.pageOpsReorder(order)),
        pageOpsMove: move => runPageOperation(() => deps.pageOpsMove(move)),
        handleCropPages: (pages, margins) => runPageOperation(
            () => deps.handleCropPages(pages, margins),
        ),
        handleSave: handleSaveFromCommandSurface,
        handleRepairSave: handleRepairSaveFromCommandSurface,
        handleOptimizePdfForInteraction: handleOptimizePdfForInteractionFromCommandSurface,
        handleZoomIn: () => {
            setCustomZoomFromDisplay(resolveDisplayZoom() + ZOOM.STEP);
        },
        handleZoomOut: () => {
            const displayZoom = resolveDisplayZoom();
            if (displayZoom <= ZOOM.MIN) {
                return;
            }
            setCustomZoomFromDisplay(displayZoom - ZOOM.STEP);
        },
        handleFitWidth: () => {
            deps.handleFitMode('width');
        },
        handleFitHeight: () => {
            deps.handleFitMode('height');
        },
        handleActualSize: () => {
            setCustomZoomFromDisplay(1);
        },
        setCustomZoomFromDisplay,
        handleCaptureRegion: () => {
            if (!viewerCapabilities().regionCapture) {
                return;
            }
            deps.handleCaptureRegion();
        },
        handleCrop: () => {
            if (!viewerCapabilities().crop) {
                return;
            }
            deps.handleCrop();
        },
        handleToggleContinuousScroll: () => {
            if (!viewerCapabilities().continuousScroll) {
                return;
            }
            deps.handleToggleContinuousScroll();
        },
        handleViewModeSingle: () => {
            if (!viewerCapabilities().viewMode) {
                return;
            }
            deps.viewMode.value = 'single';
        },
        handleViewModeFacing: () => {
            if (!viewerCapabilities().viewMode) {
                return;
            }
            deps.viewMode.value = 'facing';
        },
        handleViewModeFacingFirstSingle: () => {
            if (!viewerCapabilities().viewMode) {
                return;
            }
            deps.viewMode.value = 'facing-first-single';
        },
        handleViewRotationCw: () => {
            if (!viewerCapabilities().viewRotation) {
                return;
            }
            deps.viewRotation.value = stepPdfViewRotation(deps.viewRotation.value, 'clockwise');
        },
        handleViewRotationCcw: () => {
            if (!viewerCapabilities().viewRotation) {
                return;
            }
            deps.viewRotation.value = stepPdfViewRotation(deps.viewRotation.value, 'counterclockwise');
        },
        setViewRotation: (rotation) => {
            if (!viewerCapabilities().viewRotation) {
                return;
            }
            deps.viewRotation.value = rotation;
        },
        handleDeletePages: () => {
            const pages = getSelectedPagePayload(deps);
            if (selectedPagePayloadCount(pages) > 0) {
                void deps.pageOpsDelete(pages, deps.totalPages.value);
            }
        },
        handleExtractPages: () => {
            const pages = getSelectedPagePayload(deps);
            if (selectedPagePayloadCount(pages) > 0) {
                void deps.pageOpsExtract(pages);
            }
        },
        handleRotateCw: (explicitPages?: number[]) => {
            const pages = explicitPages ?? getSelectedPagePayload(deps);
            if (selectedPagePayloadCount(pages) > 0) {
                void deps.handlePageRotate(pages, 90);
            }
        },
        handleRotateCcw: (explicitPages?: number[]) => {
            const pages = explicitPages ?? getSelectedPagePayload(deps);
            if (selectedPagePayloadCount(pages) > 0) {
                void deps.handlePageRotate(pages, 270);
            }
        },
        handleInsertPages: () => {
            void deps.pageOpsInsert(deps.totalPages.value, deps.totalPages.value);
        },
        handleConvertToPdf: () => {
            if (viewerCapabilities().conversionDialog) {
                deps.openConvertDialog();
                return;
            }
            void deps.handleOpenFileFromUi();
        },
        getToolbarSnapshot,
        getAutomationStateSnapshot,
        createRecoverySnapshotBytes: deps.createRecoverySnapshotBytes
            ?? (() => Promise.resolve(null)),
        scrollToPage: (page: number) => {
            deps.documentViewerRef?.value?.scrollToPage(page);
        },
        getAllShapes: () => deps.pdfAutomationViewerRef?.value?.getAllShapes?.() ?? [],
        getDeletedEmbeddedShapeAnnotationIds: () => deps.pdfAutomationViewerRef?.value?.getDeletedEmbeddedShapeAnnotationIds?.() ?? [],
        getDeletedEmbeddedShapeStableKeys: () => deps.pdfAutomationViewerRef?.value?.getDeletedEmbeddedShapeStableKeys?.() ?? [],
        highlightSelection: () => deps.pdfAutomationViewerRef?.value?.highlightSelection?.() ?? Promise.resolve(false),
        commentAtPoint: (pageNumber, pageX, pageY, options) => (
            deps.pdfAutomationViewerRef?.value?.commentAtPoint?.(pageNumber, pageX, pageY, options) ?? Promise.resolve(false)
        ),
    };

    const depsHandlers: Partial<TWorkspaceExposeCommandHandlerMap> = deps;
    const commandHandlers = createWorkspaceExposeCommandHandlers((descriptor) => {
        const customHandler = customHandlers[descriptor.name];
        if (customHandler) {
            return createWorkspaceExposeCommandRunner(customHandler);
        }

        if (descriptor.real === 'passthrough') {
            const handler = depsHandlers[descriptor.name];
            if (handler) {
                return createWorkspaceExposeCommandRunner(handler);
            }
            if (descriptor.group === 'pageOps') {
                return createWorkspaceExposeCommandRunner(() => (
                    descriptor.kind === 'async' && descriptor.deferred === 'mountWaitBoolean'
                        ? Promise.resolve(false)
                        : undefined
                ));
            }
            return null;
        }

        return null;
    });

    return createWorkspaceExposeFromCommandHandlers(deps.hasPdf, commandHandlers);
}

export function createWorkspaceExposeFromOwners(
    options: ICreateWorkspaceExposeFromOwnersOptions,
) {
    const {
        annotationSession,
        documentControls,
        exportWorkflow,
        fileLifecycle,
        interactionControls,
        metadata,
        printWorkflow,
        saveWorkflow,
        viewNavigation,
        viewerShell,
    } = options.orchestration;
    return createWorkspaceExpose({
        ...annotationSession,
        ...documentControls,
        ...exportWorkflow,
        ...fileLifecycle,
        ...interactionControls,
        ...metadata,
        ...printWorkflow,
        ...saveWorkflow,
        ...viewNavigation,
        ...viewerShell,
        toolbarCurrentPage: options.toolbarCurrentPage,
        toolbarTotalPages: options.toolbarTotalPages,
        handleSave: options.handleSave,
        handleOptimizePdfForInteraction: options.handleOptimizePdfForInteraction,
        handleSaveAs: options.handleSaveAs,
        handlePrintCurrentPage: () => { void printWorkflow.handlePrintCurrentPage(); },
        handleUndo: () => { void viewNavigation.handleUndo(); },
        handleRedo: () => { void viewNavigation.handleRedo(); },
        handleExportDocx: options.handleExportDocx,
        initialVisualReady: options.initialVisualReady,
        openingPreviewReady: options.openingPreviewReady,
        isOpeningDocument: options.isOpeningDocument,
        hasOpenError: computed(() => Boolean(fileLifecycle.pdfError.value) || Boolean(fileLifecycle.djvuError.value)),
        canRepairSave: options.canRepairSave,
        canOptimizePdf: options.canOptimizePdf,
        canExportDocx: options.canExportDocx,
        // Preserve the automation/toolbar snapshot field as a compatibility
        // projection. The note tool is the only placement state now.
        isPlacingPageNote: computed(() => annotationSession.annotationTool.value === 'note'),
        handleGoToPage: options.handleGoToPage,
        handleToggleSidebar: () => { viewerShell.showSidebar.value = !viewerShell.showSidebar.value; },
        handleToggleContinuousScroll: () => {
            viewerShell.continuousScroll.value = !viewerShell.continuousScroll.value;
        },
        handleEnableDragMode: () => { viewNavigation.enableDragMode(); },
        handleDisableDragMode: () => { annotationSession.handleAnnotationToolChange('none'); },
        handleCaptureRegion: () => { void interactionControls.handleCaptureRegion(); },
        handleCrop: options.handleCrop,
        handleQuickNote: () => { void annotationSession.handleQuickNoteAction(); },
        handleInsertImageFromFile: options.handleInsertImageFromFile,
        handlePasteImageFromClipboard: options.handlePasteImageFromClipboard,
        pageOpsDelete: documentControls.pageOpsDelete,
        pageOpsExtract: documentControls.pageOpsExtract,
        handlePageRotate: documentControls.handlePageRotate,
        pageOpsInsert: documentControls.pageOpsInsert,
        viewerCapabilities: options.viewerCapabilities,
        captureSplitPayload: options.captureSplitPayload,
        restoreSplitPayload: options.restoreSplitPayload,
        waitForDocumentOpenSettled: options.waitForDocumentOpenSettled,
        runAgentAction: options.runAgentAction,
        readAgentResource: options.readAgentResource,
        ...(options.ensurePdfProjectionForEdit === undefined
            ? {}
            : {ensurePdfProjectionForEdit: options.ensurePdfProjectionForEdit}),
        handlePageDelete: options.handlePageDelete,
        handlePageReorder: options.handlePageReorder,
        handlePageMove: options.handlePageMove,
        pdfAutomationViewerRef: viewerShell.pdfViewerRef,
        getAnnotationDirtyEntityCount: () => viewerShell.pdfViewerRef.value?.getAnnotationDirtyEntityCount?.() ?? 0,
        handleOcrComplete: payload => saveWorkflow.handleOcrComplete(
            payload as Parameters<typeof saveWorkflow.handleOcrComplete>[0],
        ),
        createRecoverySnapshotBytes: saveWorkflow.createRecoverySnapshotBytes,
    });
}
