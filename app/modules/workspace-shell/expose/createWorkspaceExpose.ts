import type { Ref } from 'vue';
import type { IAnnotationInventoryCompleteness } from '@app/types/annotations';
import type { TPageSelection } from '@pdf-core/pdfPageSelection';
import {
    pageSelectionCount,
    parsePageNumber,
} from '@pdf-core/pdfPageSelection';
import type {
    IWorkspaceExpose,
    IWorkspaceAutomationStateSnapshot,
    IWorkspaceToolbarSnapshot,
    IWorkspaceViewerCapabilities,
} from '@app/types/workspaceExpose';
import type { IScrollToPageOptions } from '@app/modules/pdf-viewer/public';
import type { TDocumentContext } from '@app/modules/workspace-shell/documentContext';
import type { TDocumentViewContext } from '@app/modules/workspace-shell/documentViewContext';
import { stepPdfViewRotation } from '@app/utils/pdfViewRotation';
import {createWorkspaceDocumentRecovery} from '@app/modules/workspace-shell/checkpoint/createWorkspaceDocumentRecovery';

/** Commands and display state the workspace owns beyond the document context. */
export interface IWorkspaceExposeOwners extends Pick<IWorkspaceExpose,
    | 'handleSave' | 'handleOptimizePdfForInteraction' | 'handleSaveAs' | 'handleExportDocx'
    | 'handleInsertImageFromFile' | 'handlePasteImageFromClipboard' | 'handleCrop'
    | 'captureSplitPayload' | 'restoreSplitPayload' | 'waitForDocumentOpenSettled'
    | 'runAgentAction' | 'readAgentResource'> {
    handleGoToPage: (page: number, options?: IScrollToPageOptions) => void;
    ensurePdfProjectionForEdit: () => Promise<boolean>;
    initialVisualReady: Readonly<Ref<boolean>>;
    canRepairSave: Readonly<Ref<boolean>>;
    canOptimizePdf: Readonly<Ref<boolean>>;
    canExportDocx: Readonly<Ref<boolean>>;
    viewerCapabilities: Readonly<Ref<IWorkspaceViewerCapabilities>>;
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

/** Builds the workspace command surface that tabs, menus and automation call. */
export function createWorkspaceExpose(
    document: TDocumentContext,
    viewContext: TDocumentViewContext,
    owners: IWorkspaceExposeOwners,
): IWorkspaceExpose {
    const {
        file,
        save,
        history,
        isOpeningDocument,
        annotations,
        metadata: {
            pageLabelState, bookmarkState,
        },
        pageOps,
        fileOps,
        print,
        exportWorkflow,
    } = document;
    const {
        view,
        search,
        navigation,
        openSurface,
        viewerDefaults,
    } = viewContext;
    const viewerCapabilities = () => owners.viewerCapabilities.value;
    const hasOpenError = () => Boolean(file.pdfError.value) || Boolean(file.djvuError.value);
    const pdfViewer = () => view.pdfViewerRef.value;

    function getSelectedPagePayload() {
        const selection = view.selectedPageSelection.value;
        return selection?.pageCount === view.totalPages.value
            ? selection
            : view.selectedThumbnailPages.value;
    }

    async function handleSaveFromCommandSurface() {
        if (
            !file.hasPdf.value
            || save.isAnySaving.value
            || history.isHistoryBusy.value
            || !viewerCapabilities().save
        ) {
            return false;
        }
        if (
            !save.canSave.value
            && !save.hasPendingUnsavedChanges.value
            && !annotations.hasOpenAnnotationNotes.value
        ) {
            return true;
        }
        return owners.handleSave();
    }

    function getToolbarSnapshot(): IWorkspaceToolbarSnapshot {
        const isOpening = isOpeningDocument.value;
        // While a document opens, page one prevents stale position from the
        // replaced document leaking into the new open.
        const currentPage = isOpening
            ? 1
            : normalizeToolbarSnapshotPage(view.currentPage.value);
        const totalPages = normalizeToolbarSnapshotTotalPages(
            view.totalPages.value,
            isOpening ? 0 : currentPage,
        );
        const zoom = view.zoom.value;
        // A custom zoom is the user's requested display value. The viewer can
        // report a nearby effective scale while its late layout work settles,
        // but that must not make the toolbar visibly jump to a different zoom.
        const effectiveZoom = view.zoomMode.value === 'custom'
            ? zoom
            : view.effectiveZoom.value;
        return {
            hasPdf: file.hasPdf.value,
            initialVisualReady: owners.initialVisualReady.value,
            hasOpenError: hasOpenError(),
            isPreparingPrint: print.isPreparingPrint.value,
            isPreparingCurrentPagePrint: print.isPreparingCurrentPagePrint.value,
            canSave: save.canSave.value,
            canRepairSave: owners.canRepairSave.value,
            canOptimizePdf: owners.canOptimizePdf.value,
            canUndo: history.canUndo.value,
            canRedo: history.canRedo.value,
            canExportDocx: owners.canExportDocx.value,
            isSaving: save.isSaving.value,
            isSavingAs: save.isSavingAs.value,
            isAnySaving: save.isAnySaving.value,
            isHistoryBusy: history.isHistoryBusy.value,
            isExportingDocx: document.docxExport.isExporting.value,
            isFitWidthActive: navigation.isFitWidthActive.value,
            isFitHeightActive: navigation.isFitHeightActive.value,
            showSidebar: view.showSidebar.value,
            sidebarTab: view.sidebarTab.value,
            sidebarWidth: search.sidebarWidth.value,
            dragMode: view.dragMode.value,
            continuousScroll: view.continuousScroll.value,
            isDjvuMode: file.isDjvuMode.value,
            viewerCapabilities: viewerCapabilities(),
            isCapturingRegion: pdfViewer()?.isCapturingRegion ?? false,
            isCropSelecting: viewContext.crop.isCropSelecting.value,
            isPlacingPageNote: viewContext.annotationTool.value === 'note',
            zoom,
            effectiveZoom,
            zoomMode: view.zoomMode.value,
            fitMode: view.fitMode.value,
            viewMode: view.viewMode.value,
            viewRotation: view.viewRotation.value,
            currentPage,
            totalPages,
            selectedPageCount: selectedPagePayloadCount(getSelectedPagePayload()),
            isPageOperationInProgress: pageOps.isPageOperationInProgress.value,
        };
    }

    // A view command the reader issues (toolbar, menu, keyboard) moves the
    // view as a scroll does; a saved view restored as state does not.
    function readerCommand(command: () => void) {
        return () => {
            view.documentViewerRef.value?.observeReaderCommand?.();
            command();
        };
    }

    function getAutomationStateSnapshot(): IWorkspaceAutomationStateSnapshot {
        const reloadSrc = file.pdfReloadSrc.value;
        return {
            documentIdentity: file.documentRevisionInfo.value,
            annotationComments: [...annotations.annotationComments.value],
            annotationCommentsStatus: annotations.annotationCommentsStatus.value,
            annotationInventory: cloneAnnotationInventory(annotations.annotationInventory.value),
            annotationDirty: annotations.annotationDirty.value,
            pageLabels: pageLabelState.pageLabels.value,
            pageLabelRanges: structuredClone(pageLabelState.pageLabelRanges.value),
            pageLabelsResolved: pageLabelState.pageLabelsResolved.value,
            isPageOperationInProgress: pageOps.isPageOperationInProgress.value,
            totalPages: view.totalPages.value,
            dirtyState: {
                annotationDirty: annotations.annotationDirty.value,
                bookmarksDirty: bookmarkState.bookmarksDirty.value,
                fileDirty: file.isDirty.value,
                recoveryDirtyBaseline: file.recoveryDirtyBaseline.value,
                hasAnnotationChanges: annotations.hasAnnotationChanges(),
                annotationDirtyEntityCount: pdfViewer()?.getAnnotationDirtyEntityCount?.() ?? 0,
                hasPendingUnsavedChanges: save.hasPendingUnsavedChanges.value,
                pageLabelsDirty: pageLabelState.pageLabelsDirty.value,
                pendingEmbeddedAnnotationDeleteCount: annotations.pendingEmbeddedAnnotationDeleteCount.value,
            },
            originalPath: file.originalPath.value,
            pdfSourceState: {
                hasInMemoryData: file.pdfData.value !== null,
                reloadKind: reloadSrc instanceof Blob
                    ? 'blob'
                    : reloadSrc?.kind ?? 'none',
                reloadPath: reloadSrc instanceof Blob
                    ? null
                    : reloadSrc?.path ?? null,
            },
            requiresSaveAsOnFirstSave: file.requiresSaveAsOnFirstSave.value,
            sortedAnnotationNoteWindows: annotations.sortedAnnotationNoteWindows.value.map(note => ({
                ...note,
                markerRect: note.markerRect ? {...note.markerRect} : null,
            })),
            workingCopyPath: file.workingCopyPath.value,
        };
    }

    async function runPageOperation(operation: () => Promise<boolean>) {
        return await owners.ensurePdfProjectionForEdit() && operation();
    }

    function whenCapable(capability: keyof IWorkspaceViewerCapabilities, action: () => void) {
        return () => {
            if (viewerCapabilities()[capability]) {
                action();
            }
        };
    }

    return {
        hasPdf: file.hasPdf,
        handleSaveAs: owners.handleSaveAs,
        handlePrint: print.handlePrint,
        handlePrintCurrentPage: () => { void print.handlePrintCurrentPage(); },
        handleUndo: () => { void history.handleUndo(); },
        handleRedo: () => { void history.handleRedo(); },
        handleOpenFileFromUi: fileOps.handleOpenFileFromUi,
        handleCombineImages: fileOps.handleCombineImages,
        handleOpenFileDirectWithPersist: fileOps.handleOpenFileDirectWithPersist,
        handleOpenFileDirectBatchWithPersist: fileOps.handleOpenFileDirectBatchWithPersist,
        handleOpenFileWithResult: fileOps.handleOpenFileWithResult,
        handleCloseFileFromUi: fileOps.handleCloseFileFromUi,
        handleExportDocx: owners.handleExportDocx,
        handleExportImages: () => exportWorkflow.handleExportImages(),
        handleExportMultiPageTiff: () => exportWorkflow.handleExportMultiPageTiff(),
        handleGoToPage: owners.handleGoToPage,
        handleToggleSidebar: () => { view.showSidebar.value = !view.showSidebar.value; },
        handleEnableDragMode: () => { navigation.enableDragMode(); },
        handleDisableDragMode: () => { viewContext.annotationToolState.handleAnnotationToolChange('none'); },
        handleQuickNote: () => { void viewContext.annotationActions.handleQuickNoteAction(); },
        handleInsertImageFromFile: owners.handleInsertImageFromFile,
        handlePasteImageFromClipboard: owners.handlePasteImageFromClipboard,
        handlePageDelete: (pages) => {
            void runPageOperation(() => pageOps.pageOpsDelete(pages, view.totalPages.value));
        },
        handlePageReorder: (order) => {
            void runPageOperation(() => pageOps.pageOpsReorder(order));
        },
        handlePageMove: (move) => {
            void runPageOperation(() => pageOps.pageOpsMove(move));
        },
        captureSplitPayload: page => owners.captureSplitPayload(page ?? view.currentPage.value),
        restoreSplitPayload: owners.restoreSplitPayload,
        closeAllDropdowns: view.closeAllDropdowns,
        waitForDocumentOpenSettled: owners.waitForDocumentOpenSettled,
        runAgentAction: owners.runAgentAction,
        readAgentResource: owners.readAgentResource,
        handleOcrComplete: async payload => document.ocr.applyResult(
            payload as Parameters<typeof document.ocr.applyResult>[0],
        ),
        ...createWorkspaceDocumentRecovery(document, pdfViewer),
        pageOpsDelete: (pages, totalPages) => runPageOperation(() => pageOps.pageOpsDelete(pages, totalPages)),
        handlePageRotate: (pages, angle) => runPageOperation(() => pageOps.handlePageRotate(pages, angle)),
        pageOpsInsert: (totalPages, afterPage) => runPageOperation(() => pageOps.pageOpsInsert(totalPages, afterPage)),
        pageOpsReorder: order => runPageOperation(() => pageOps.pageOpsReorder(order)),
        pageOpsMove: move => runPageOperation(() => pageOps.pageOpsMove(move)),
        handleCropPages: (pages, margins) => runPageOperation(() => pageOps.handleCropPages(pages, margins)),
        handleSave: handleSaveFromCommandSurface,
        handleSelectAll: () => { pdfViewer()?.selectAllAnnotations?.(); },
        handleRepairSave: async () => owners.canRepairSave.value && save.handleRepairSave(),
        handleOptimizePdfForInteraction: async () => (
            owners.canOptimizePdf.value && owners.handleOptimizePdfForInteraction()
        ),
        handleZoomIn: viewerDefaults.handleZoomIn,
        handleZoomOut: viewerDefaults.handleZoomOut,
        handleFitWidth: () => { navigation.handleFitMode('width'); },
        handleFitHeight: () => { navigation.handleFitMode('height'); },
        handleActualSize: viewerDefaults.handleActualSize,
        setCustomZoomFromDisplay: viewerDefaults.setCustomZoomFromDisplay,
        handleCaptureRegion: whenCapable('regionCapture', viewContext.handleCaptureRegion),
        handleCrop: whenCapable('crop', owners.handleCrop),
        handleToggleContinuousScroll: whenCapable('continuousScroll', readerCommand(() => {
            view.continuousScroll.value = !view.continuousScroll.value;
        })),
        handleViewModeSingle: whenCapable('viewMode', readerCommand(() => { view.viewMode.value = 'single'; })),
        handleViewModeFacing: whenCapable('viewMode', readerCommand(() => { view.viewMode.value = 'facing'; })),
        handleViewModeFacingFirstSingle: whenCapable('viewMode', readerCommand(() => { view.viewMode.value = 'facing-first-single'; })),
        handleViewRotationCw: whenCapable('viewRotation', readerCommand(() => { view.viewRotation.value = stepPdfViewRotation(view.viewRotation.value, 'clockwise'); })),
        handleViewRotationCcw: whenCapable('viewRotation', readerCommand(() => { view.viewRotation.value = stepPdfViewRotation(view.viewRotation.value, 'counterclockwise'); })),
        restoreViewState: (state) => {
            const capabilities = viewerCapabilities();
            viewerDefaults.applyView({
                ...state,
                continuousScroll: capabilities.continuousScroll ? state.continuousScroll : null,
                viewMode: capabilities.viewMode ? state.viewMode : null,
                viewRotation: capabilities.viewRotation ? state.viewRotation : null,
            });
            if (state.currentPage !== null) {
                owners.handleGoToPage(state.currentPage);
            }
        },
        handleDeletePages: () => {
            const pages = getSelectedPagePayload();
            if (selectedPagePayloadCount(pages) > 0) {
                void runPageOperation(() => pageOps.pageOpsDelete(pages, view.totalPages.value));
            }
        },
        handleExtractPages: () => {
            const pages = getSelectedPagePayload();
            if (selectedPagePayloadCount(pages) > 0) {
                void runPageOperation(() => pageOps.pageOpsExtract(pages));
            }
        },
        handleRotateCw: (explicitPages?: number[]) => {
            const pages = explicitPages ?? getSelectedPagePayload();
            if (selectedPagePayloadCount(pages) === 0) {
                return Promise.resolve(false);
            }
            return runPageOperation(() => pageOps.handlePageRotate(pages, 90));
        },
        handleRotateCcw: (explicitPages?: number[]) => {
            const pages = explicitPages ?? getSelectedPagePayload();
            if (selectedPagePayloadCount(pages) === 0) {
                return Promise.resolve(false);
            }
            return runPageOperation(() => pageOps.handlePageRotate(pages, 270));
        },
        handleInsertPages: () => {
            void runPageOperation(() => pageOps.pageOpsInsert(view.totalPages.value, view.totalPages.value));
        },
        handleConvertToPdf: () => {
            if (viewerCapabilities().conversionDialog) {
                file.openConvertDialog();
                return;
            }
            void fileOps.handleOpenFileFromUi();
        },
        getToolbarSnapshot,
        getOpenFailure: () => {
            const message = file.pdfError.value ?? file.djvuError.value;
            const presentation = file.pdfFailurePresentation.value;
            return message
                ? {
                    message: presentation?.description ?? String(message),
                    failure: presentation?.failure ?? null,
                    ...(presentation?.technicalDetails ? {technicalDetails: presentation.technicalDetails} : {}),
                    ...(presentation?.actions ? {actions: presentation.actions} : {}),
                }
                : null;
        },
        getAutomationStateSnapshot,
        createRecoverySnapshotBytes: save.createRecoverySnapshotBytes,
        scrollToPage: (page: number) => {
            view.documentViewerRef.value?.scrollToPage(page);
        },
        captureReadingAnchor: () => view.documentViewerRef.value?.captureReadingAnchor?.() ?? null,
        followReader: () => {
            // The reader outranks a restored place: their navigation, or a move of
            // the view (scroll, wheel, press, view command) since this began, leaves
            // it where they took it; the opening's own navigations are restores.
            // Moves are counted by the viewer chassis's interaction authority, which
            // outlives the PDF/DjVu routing that hides and re-shows it; only a
            // different chassis counts its moves from its own start.
            const startTicket = openSurface.navigationTicket.value;
            let readEpoch = view.documentViewerRef.value?.getReaderInteractionEpoch ?? null;
            let baseline = readEpoch?.() ?? null;
            let moved = false;
            const readerMoved = () => {
                const ticket = openSurface.navigationTicket.value;
                const epoch = readEpoch?.() ?? null;
                moved ||= (ticket !== startTicket && (ticket?.request.source ?? 'restore') !== 'restore')
                    || (epoch !== null && baseline !== null && epoch > baseline);
                const authority = view.documentViewerRef.value?.getReaderInteractionEpoch;
                if (authority && authority !== readEpoch) {
                    readEpoch = authority;
                    baseline = 0;
                }
                return moved;
            };
            const stop = watchSyncEffect(readerMoved);
            let withdrawSeed = () => {};
            return {
                moved: readerMoved,
                seed: (state, source) => {
                    withdrawSeed = viewerDefaults.seedViewForSource(state, source);
                },
                finish: async (anchor) => {
                    if (anchor) {
                        await owners.waitForDocumentOpenSettled();
                    }
                    stop();
                    withdrawSeed();
                    if (anchor && !readerMoved()) {
                        view.documentViewerRef.value?.restoreReadingAnchor?.(anchor);
                    }
                },
            };
        },
        getAllShapes: () => pdfViewer()?.getAllShapes?.() ?? [],
        getDeletedEmbeddedShapeAnnotationIds: () => pdfViewer()?.getDeletedEmbeddedShapeAnnotationIds?.() ?? [],
        getDeletedEmbeddedShapeStableKeys: () => pdfViewer()?.getDeletedEmbeddedShapeStableKeys?.() ?? [],
        highlightSelection: () => pdfViewer()?.highlightSelection?.() ?? Promise.resolve(false),
        commentAtPoint: (pageNumber, pageX, pageY, options) => {
            const parsedPageNumber = parsePageNumber(pageNumber);
            return parsedPageNumber === null
                ? Promise.resolve(false)
                : pdfViewer()?.commentAtPoint?.(parsedPageNumber, pageX, pageY, options)
                    ?? Promise.resolve(false);
        },
    };
}
