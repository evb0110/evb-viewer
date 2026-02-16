import {
    ref,
    shallowRef,
    computed,
    type Ref,
} from 'vue';
import {
    syncRef,
    useStorage,
} from '@vueuse/core';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type {
    TFitMode,
    TPdfViewMode,
} from '@app/types/shared';
import { useOcrTextContent } from '@app/composables/pdf/useOcrTextContent';
import type {
    IAnnotationCommentSummary,
    IShapeAnnotation,
} from '@app/types/annotations';
import { STORAGE_KEYS } from '@app/constants/storage-keys';
import { useSidebarResize } from '@app/composables/useSidebarResize';
import { useAnnotationContextMenu } from '@app/composables/pdf/useAnnotationContextMenu';
import { BrowserLogger } from '@app/utils/browser-logger';
import { usePageContextMenu } from '@app/composables/pdf/usePageContextMenu';
import { useAnnotationNoteWindows } from '@app/composables/pdf/useAnnotationNoteWindows';
import { usePageLabelState } from '@app/composables/pdf/usePageLabelState';
import { useBookmarkState } from '@app/composables/pdf/useBookmarkState';
import { useDropdownManager } from '@app/composables/useDropdownManager';
import { usePdfHistory } from '@app/composables/usePdfHistory';
import { usePageAnnotationTools } from '@app/composables/usePageAnnotationTools';
import { usePageSearch } from '@app/composables/usePageSearch';
import { usePageAnnotationActions } from '@app/composables/usePageAnnotationActions';
import { usePageSaveOrchestration } from '@app/composables/usePageSaveOrchestration';
import { usePageStatusBar } from '@app/composables/usePageStatusBar';
import { usePageOpsHandlers } from '@app/composables/usePageOpsHandlers';
import { usePageFileOperations } from '@app/composables/usePageFileOperations';
import { usePageShortcuts } from '@app/composables/usePageShortcuts';
import { useDjvu } from '@app/composables/useDjvu';
import { useDocumentTransitions } from '@app/composables/page/useDocumentTransitions';
import { useWorkspaceExport } from '@app/composables/page/useWorkspaceExport';
import { useWorkspaceFileSwitch } from '@app/composables/page/useWorkspaceFileSwitch';
import { setupWorkspaceUiSyncWatchers } from '@app/composables/page/workspace-ui-sync';
import {
    createSerializeCurrentPdfForEmbeddedFallback,
    hasAnnotationChanges as detectAnnotationChanges,
} from '@app/composables/page/workspace-annotation-utils';
import type { TOpenFileResult } from '@app/types/electron-api';
import type { TTabUpdate } from '@app/types/tabs';
import {
    getElectronAPI,
    hasElectronAPI,
} from '@app/utils/electron';
import { useWorkspaceViewState } from '@app/composables/page/workspace-view-state';
import { useDocxExport } from '@app/composables/useDocxExport';
import type { TSplitPayload } from '@app/types/split-payload';

type TPdfSidebarTab = 'annotations' | 'thumbnails' | 'bookmarks' | 'search';

export interface IPdfViewerExpose {
    scrollToPage: (page: number) => void;
    captureRegionToClipboard: () => Promise<boolean>;
    isCapturingRegion: { value: boolean };
    saveDocument: () => Promise<Uint8Array | null>;
    highlightSelection: () => Promise<boolean>;
    commentSelection: () => Promise<boolean>;
    commentAtPoint: (
        pageNumber: number,
        pageX: number,
        pageY: number,
        options?: { preferTextAnchor?: boolean },
    ) => Promise<boolean>;
    startCommentPlacement: () => void;
    cancelCommentPlacement: () => void;
    undoAnnotation: () => void;
    redoAnnotation: () => void;
    focusAnnotationComment: (comment: IAnnotationCommentSummary) => Promise<void>;
    updateAnnotationComment: (comment: IAnnotationCommentSummary, text: string) => boolean;
    deleteAnnotationComment: (comment: IAnnotationCommentSummary) => Promise<boolean>;
    getMarkupSubtypeOverrides: () => Map<string, import('@app/types/annotations').TMarkupSubtype>;
    getAllShapes: () => IShapeAnnotation[];
    loadShapes: (shapes: IShapeAnnotation[]) => void;
    clearShapes: () => void;
    deleteSelectedShape: () => void;
    hasShapes: { value: boolean };
    selectedShapeId: { value: string | null };
    updateShape: (id: string, updates: Partial<IShapeAnnotation>) => void;
    getSelectedShape: () => IShapeAnnotation | null;
    applyStampImage: (file: File) => void;
    invalidatePages: (pages: number[]) => void;
}

export interface IWorkspaceOrchestrationDeps {
    isActive: Ref<boolean>;
    emit: {
        (e: 'update-tab', updates: TTabUpdate): void;
        (e: 'open-in-new-tab', result: TOpenFileResult): void;
        (e: 'request-close-tab'): void;
        (e: 'open-settings'): void;
    };
}

export const useWorkspaceOrchestration = (deps: IWorkspaceOrchestrationDeps) => {
    const {
        isActive,
        emit,
    } = deps;
    const { t } = useTypedI18n();

    const {
        pdfSrc,
        pdfData,
        workingCopyPath,
        originalPath,
        fileName,
        isDirty,
        error: pdfError,
        isElectron,
        pendingDjvu,
        openBatchProgress,
        pickFileToOpen,
        openFile,
        openFileDirect,
        openFileDirectBatch,
        loadPdfFromPath,
        loadPdfFromData,
        closeFile,
        saveFile,
        saveWorkingCopy,
        saveWorkingCopyAs,
        markDirty,
        canUndo: canUndoFile,
        canRedo: canRedoFile,
        undo,
        redo,
    } = usePdfFile();

    const {
        isDjvuMode,
        djvuSourcePath,
        conversionState,
        isLoadingPages: djvuIsLoadingPages,
        loadingProgress: djvuLoadingProgress,
        showBanner: djvuShowBanner,
        showConvertDialog,
        viewingError: djvuError,
        openDjvuFile,
        convertToPdf: djvuConvertToPdf,
        cancelActiveJobs: cancelDjvuJobs,
        cleanupDjvuTemp,
        exitDjvuMode,
        openConvertDialog,
        dismissBanner: djvuDismissBanner,
    } = useDjvu();

    const {
        recentFiles,
        loadRecentFiles,
        removeRecentFile,
        clearRecentFiles,
    } = useRecentFiles();

    const pdfViewerRef = ref<IPdfViewerExpose | null>(null);
    const zoomDropdownOpen = ref(false);
    const pageDropdownOpen = ref(false);
    const ocrPopupOpen = ref(false);
    const overflowMenuOpen = ref(false);
    const selectedThumbnailPages = ref<number[]>([]);
    const thumbnailInvalidationRequest = ref<{
        id: number;
        pages: number[];
    } | null>(null);
    let thumbnailInvalidationRequestId = 0;

    function setSelectedThumbnailPages(pages: number[]) {
        selectedThumbnailPages.value = [...pages];
    }

    function requestThumbnailInvalidation(pages: number[]) {
        thumbnailInvalidationRequestId += 1;
        thumbnailInvalidationRequest.value = {
            id: thumbnailInvalidationRequestId,
            pages: [...pages],
        };
    }

    const {
        closeAllDropdowns,
        closeOtherDropdowns,
        handleDropdownOpenChange,
        openDropdown,
    } = useDropdownManager({
        zoomOpen: zoomDropdownOpen,
        pageOpen: pageDropdownOpen,
        ocrOpen: ocrPopupOpen,
        overflowOpen: overflowMenuOpen,
    });

    const zoom = ref(1);
    const fitMode = ref<TFitMode>('width');
    const viewMode = ref<TPdfViewMode>('single');
    const currentPage = ref(1);
    const totalPages = ref(0);
    const pdfDocument = shallowRef<PDFDocumentProxy | null>(null);

    const {
        pageLabels,
        pageLabelRanges,
        pageLabelsDirty,
        markPageLabelsSaved,
        handlePageLabelRangesUpdate,
    } = usePageLabelState({
        pdfDocument,
        totalPages,
        markDirty,
    });

    const {
        bookmarkItems,
        bookmarksDirty,
        bookmarkEditMode,
        markBookmarksSaved,
        handleBookmarksChange,
    } = useBookmarkState({ markDirty });

    const isLoading = ref(false);
    const dragMode = ref(true);
    const continuousScroll = ref(true);
    const { settings: appSettings } = useSettings();
    const showSidebar = ref(false);
    const showSettings = ref(false);
    const sidebarTab = ref<TPdfSidebarTab>('thumbnails');
    const isSaving = ref(false);
    const isSavingAs = ref(false);
    const isHistoryBusy = ref(false);
    const {
        isExportInProgress,
        exportScopeDialogOpen,
        exportScopeDialogMode,
        exportScopeDialogSelectedPages,
        handleExportScopeDialogSubmit,
        handleExportScopeDialogOpenChange,
        handleExportImages,
        handleExportMultiPageTiff,
    } = useWorkspaceExport({
        workingCopyPath,
        totalPages,
    });

    const {
        annotationContextMenu,
        annotationContextMenuStyle,
        annotationContextMenuCanCopy,
        annotationContextMenuCanCreateFree,
        contextMenuAnnotationLabel,
        contextMenuDeleteActionLabel,
        closeAnnotationContextMenu,
        showAnnotationContextMenu,
    } = useAnnotationContextMenu({ t });

    const {
        pageContextMenu,
        pageContextMenuStyle,
        showPageContextMenu,
        closePageContextMenu,
    } = usePageContextMenu();

    const {
        annotationTool,
        annotationKeepActive,
        annotationPlacingPageNote,
        annotationSettings,
        annotationComments,
        annotationActiveCommentStableKey,
        annotationEditorState,
        annotationDirty,
        handleAnnotationToolChange,
        handleAnnotationToolAutoReset,
        handleAnnotationToolCancel,
        handleAnnotationSettingChange,
        handleAnnotationState,
        handleAnnotationModified,
        markAnnotationDirty,
        markAnnotationSaved,
        resetAnnotationTracking,
    } = usePageAnnotationTools({
        pdfViewerRef,
        dragMode,
        markDirty,
        closeAnnotationContextMenu,
        hasAnnotationChanges: () => detectAnnotationChanges({
            pdfViewerRef,
            pdfDocument, 
        }),
    });

    const annotationKeepActiveStorage = useStorage<string>(
        STORAGE_KEYS.ANNOTATION_KEEP_ACTIVE,
        '0',
        undefined,
        { initOnMounted: true },
    );
    syncRef(annotationKeepActive, annotationKeepActiveStorage, {transform: {
        ltr: value => (value ? '1' : '0'),
        rtl: stored => stored === '1',
    }});

    const {
        searchQuery,
        results,
        pageMatches,
        currentResultIndex,
        currentResult,
        isSearching,
        totalMatches,
        search,
        goToResult,
        setResultIndex,
        clearSearch,
        searchProgress,
        resetSearchCache,
        isTruncated,
        minQueryLength,
    } = usePdfSearch();

    const { clearCache: clearOcrCache } = useOcrTextContent();
    const {
        isExportingDocx: isDocxExporting,
        docxExportError,
        exportDocx,
        clearDocxExportError,
    } = useDocxExport();

    const {
        openSearch,
        openAnnotations,
        closeSearch,
        handleSearch,
        handleSearchNext,
        handleSearchPrevious,
        handleGoToResult,
    } = usePageSearch({
        showSidebar,
        sidebarTab,
        dragMode,
        workingCopyPath,
        totalPages,
        searchQuery,
        search,
        goToResult,
        setResultIndex,
        clearSearch,
    });

    const {
        handleSave,
        handleSaveAs,
        handleExportDocx,
        handleOcrComplete,
        isAnySaving,
        isExportingDocx,
        canSave,
        updateEmbeddedByRef,
        deleteEmbeddedByRef,
    } = usePageSaveOrchestration({
        pdfData,
        pdfDocument,
        pdfViewerRef,
        requestDocxExport: (selectedLanguages?: string[]) => exportDocx({
            workingCopyPath: workingCopyPath.value,
            pdfDocument: pdfDocument.value,
            selectedLanguages,
        }),
        openOcrPopup: () => openDropdown('ocr'),
        isExportingDocx: isDocxExporting,
        workingCopyPath,
        annotationComments,
        totalPages,
        pageLabelsDirty,
        pageLabelRanges,
        bookmarksDirty,
        bookmarkItems,
        isSaving,
        isSavingAs,
        annotationDirty,
        annotationNoteWindowsCount: computed(() => annotationNoteWindows.value.length),
        hasAnnotationChanges,
        markAnnotationSaved,
        markPageLabelsSaved,
        markBookmarksSaved,
        isDirty,
        saveFile,
        saveWorkingCopy,
        saveWorkingCopyAs,
        persistAllAnnotationNotes: (force: boolean) => persistAllAnnotationNotes(force),
        loadRecentFiles,
        clearOcrCache: (path: string) => clearOcrCache(path),
        loadPdfFromData,
        currentPage,
        waitForPdfReload: (page: number) => waitForPdfReload(page),
    });

    const {
        isFitWidthActive,
        isFitHeightActive,
        isAnnotationUndoContext,
        annotationCursorMode,
        canUndo,
        canRedo,
        handleFitMode,
        enableDragMode,
        handleGoToPage,
    } = useWorkspaceViewState({
        fitMode,
        zoom,
        dragMode,
        showSidebar,
        sidebarTab,
        annotationTool,
        annotationPlacingPageNote,
        annotationEditorState,
        canUndoFile,
        canRedoFile,
        pdfViewerRef,
    });

    const {
        waitForPdfReload,
        handleUndo,
        handleRedo,
    } = usePdfHistory({
        pdfDocument,
        pdfViewerRef,
        currentPage,
        isAnySaving,
        isHistoryBusy,
        canUndo,
        canRedo,
        isAnnotationUndoContext,
        workingCopyPath,
        resetSearchCache,
        clearOcrCache: (path: string) => clearOcrCache(path),
        undo,
        redo,
    });

    const serializeCurrentPdfForEmbeddedFallback = createSerializeCurrentPdfForEmbeddedFallback({
        pdfViewerRef,
        currentPage,
        workingCopyPath,
        waitForPdfReload,
        loadPdfFromData,
    });

    const {
        annotationNoteWindows,
        annotationNotePositions,
        sortedAnnotationNoteWindows,
        isAnyAnnotationNoteSaving,
        updateAnnotationNoteText,
        updateAnnotationNotePosition,
        persistAllAnnotationNotes,
        closeAnnotationNote,
        closeAllAnnotationNotes,
        handleOpenAnnotationNote: openAnnotationNoteWindow,
        removeAnnotationNoteWindow,
        setAnnotationNoteWindowError,
        bringAnnotationNoteToFront,
        isSameAnnotationComment,
    } = useAnnotationNoteWindows({
        annotationComments,
        markAnnotationDirty,
        updateAnnotationCommentInViewer: (comment, text) => pdfViewerRef.value?.updateAnnotationComment(comment, text) ?? false,
        updateEmbeddedAnnotationByRef: updateEmbeddedByRef,
        serializeCurrentPdfForEmbeddedFallback,
        loadPdfFromData,
        workingCopyPath,
        currentPage,
        waitForPdfReload,
    });

    function hasAnnotationChanges() {
        return detectAnnotationChanges({
            pdfViewerRef,
            pdfDocument,
        });
    }

    const {
        shapePropertiesPopover,
        selectedShapeForProperties,
        handleCommentSelection,
        handleStartPlaceNote,
        handleAnnotationFocusComment,
        handleAnnotationCommentClick,
        handleOpenAnnotationNote,
        closeShapeProperties,
        handleShapePropertyUpdate,
        handleShapeContextMenu,
        handleViewerAnnotationContextMenu,
        openContextMenuNote,
        copyContextMenuNoteText,
        deleteContextMenuComment,
        createContextMenuFreeNote,
        createContextMenuSelectionNote,
        createContextMenuMarkup,
        handleCopyAnnotationComment,
        handleDeleteAnnotationComment,
    } = usePageAnnotationActions({
        pdfViewerRef,
        annotationTool,
        annotationKeepActive,
        annotationPlacingPageNote,
        annotationSettings,
        annotationActiveCommentStableKey,
        annotationContextMenu,
        showSidebar,
        sidebarTab,
        dragMode,
        currentPage,
        workingCopyPath,
        closeAnnotationContextMenu,
        showAnnotationContextMenu,
        handleAnnotationToolChange,
        openAnnotationNoteWindow,
        removeAnnotationNoteWindow,
        setAnnotationNoteWindowError,
        isSameAnnotationComment,
        annotationNoteWindows,
        deleteEmbeddedByRef,
        loadPdfFromData,
        waitForPdfReload,
    });

    const {
        statusFilePath,
        statusFileSizeLabel,
        statusZoomLabel,
        statusCanShowInFolder,
        statusShowInFolderTooltip,
        statusShowInFolderAriaLabel,
        statusSaveDotClass,
        statusSaveDotCanSave,
        statusSaveDotTooltip,
        statusSaveDotAriaLabel,
        handleStatusSaveClick,
        handleStatusShowInFolderClick,
    } = usePageStatusBar({
        t,
        pdfSrc,
        pdfData,
        originalPath,
        workingCopyPath,
        zoom,
        canSave,
        isAnySaving,
        isHistoryBusy,
        handleSave,
    });

    const {
        isPageOperationInProgress,
        pageOpsDelete,
        pageOpsExtract,
        pageOpsInsert,
        pageOpsReorder,
        handlePageContextMenuDelete,
        handlePageContextMenuExtract,
        handlePageContextMenuExport,
        handlePageRotate,
        handlePageContextMenuRotateCw,
        handlePageContextMenuRotateCcw,
        handlePageContextMenuInsertBefore,
        handlePageContextMenuInsertAfter,
        handlePageFileDrop,
        handlePageContextMenuSelectAll,
        handlePageContextMenuInvertSelection,
    } = usePageOpsHandlers({
        workingCopyPath,
        totalPages,
        selectedThumbnailPages,
        setSelectedThumbnailPages,
        invalidateThumbnailPages: requestThumbnailInvalidation,
        pdfViewerRef,
        pageContextMenu,
        closePageContextMenu,
        onExportPages: (pages: number[]) => {
            void handleExportImages(pages);
        },
        loadPdfFromData,
        clearOcrCache: (path: string) => clearOcrCache(path),
        resetSearchCache,
    });

    const {
        pickFileToOpenWithDjvuCleanup,
        openFileWithDjvuCleanup,
        openFileDirectWithDjvuCleanup,
        openFileDirectBatchWithDjvuCleanup,
        closeFileWithDjvuCleanup,
    } = useWorkspaceFileSwitch({
        workingCopyPath,
        isDjvuMode,
        cleanupDjvuTemp,
        exitDjvuMode,
        pickFileToOpen,
        openFile,
        openFileDirect,
        openFileDirectBatch,
        closeFile,
    });

    const {
        handleOpenFileFromUi,
        handleOpenFileDirectWithPersist,
        handleOpenFileDirectBatchWithPersist,
        handleOpenFileWithResult,
        handleCloseFileFromUi,
        openRecentFile,
    } = usePageFileOperations({
        pdfSrc,
        isAnySaving,
        isHistoryBusy,
        isExportingDocx,
        isAnyAnnotationNoteSaving,
        annotationNoteWindows,
        annotationDirty,
        isDirty,
        pageLabelsDirty,
        bookmarksDirty,
        hasAnnotationChanges,
        persistAllAnnotationNotes,
        handleSave,
        pickFileToOpen: pickFileToOpenWithDjvuCleanup,
        openFile: openFileWithDjvuCleanup,
        openFileDirect: openFileDirectWithDjvuCleanup,
        openFileDirectBatch: openFileDirectBatchWithDjvuCleanup,
        closeFile: closeFileWithDjvuCleanup,
        closeAllDropdowns,
        emitOpenInNewTab: (result: TOpenFileResult) => emit('open-in-new-tab', result),
    });

    const {
        setupShortcuts,
        cleanupShortcuts,
    } = usePageShortcuts({
        isActive,
        pdfSrc,
        showSettings,
        annotationPlacingPageNote,
        pdfViewerRef,
        shapePropertiesPopoverVisible: computed(() => shapePropertiesPopover.value.visible),
        annotationContextMenuVisible: computed(() => annotationContextMenu.value.visible),
        pageContextMenuVisible: computed(() => pageContextMenu.value.visible),
        closeAnnotationContextMenu,
        closePageContextMenu,
        closeShapeProperties,
        openSearch,
        openAnnotations,
        handleAnnotationToolChange,
    });

    const {
        sidebarWidth,
        sidebarWrapperStyle,
        isResizingSidebar,
        startSidebarResize,
        cleanupSidebarResizeListeners,
    } = useSidebarResize({ showSidebar });

    setupWorkspaceUiSyncWatchers({
        pendingDjvu,
        openDjvuFile,
        loadPdfFromPath,
        currentPage,
        pdfViewerRef,
        originalPath,
        isActive,
        fileName,
        isDirty,
        isDjvuMode,
        djvuSourcePath,
        openBatchProgress,
        showSettings,
        t,
        emitUpdateTab: (updates) => emit('update-tab', updates),
        emitOpenSettings: () => emit('open-settings'),
    });

    useDocumentTransitions({
        pdfSrc,
        workingCopyPath,
        pdfError,
        dragMode,
        showSidebar,
        sidebarTab,
        annotationTool,
        annotationComments,
        annotationActiveCommentStableKey,
        annotationEditorState,
        annotationPlacingPageNote,
        bookmarkItems,
        bookmarksDirty,
        bookmarkEditMode,
        pageLabels,
        pageLabelRanges,
        pageLabelsDirty,
        pdfViewerRef,
        resetAnnotationTracking,
        resetSearchCache,
        closeSearch,
        closeAnnotationContextMenu,
        closePageContextMenu,
        closeAllAnnotationNotes,
        loadRecentFiles,
    });

    // --- Helper functions ---

    function handleDjvuConvert(subsample: number, preserveBookmarks: boolean) {
        return djvuConvertToPdf(subsample, preserveBookmarks, loadPdfFromPath);
    }

    function handleDjvuCancel() {
        if (djvuSourcePath.value) {
            void cancelDjvuJobs();
        }
    }

    const isCapturingRegion = computed(() => pdfViewerRef.value?.isCapturingRegion.value ?? false);

    function handleCaptureRegion() {
        if (!pdfViewerRef.value) {
            return;
        }
        void pdfViewerRef.value.captureRegionToClipboard();
    }

    function initFromStorage() {
        if (import.meta.dev) {
            BrowserLogger.debug('workspace', 'Electron API available', isElectron.value);
        }
        if (hasElectronAPI()) {
            loadRecentFiles();
        }
    }

    const hasPdf = computed(() => !!pdfSrc.value);

    function handleDropdownOpen(
        dropdown: 'zoom' | 'page' | 'ocr' | 'overflow',
        isOpen: boolean,
    ) {
        handleDropdownOpenChange(dropdown, isOpen);
        if (isOpen && dropdown === 'ocr') {
            clearDocxExportError();
        }
    }

    function handleSelectedThumbnailPagesUpdate(pages: number[]) {
        setSelectedThumbnailPages(pages);
    }

    async function captureSplitPayload(): Promise<TSplitPayload> {
        if (!pdfSrc.value) {
            return { kind: 'empty' };
        }

        if (isDjvuMode.value && djvuSourcePath.value) {
            return {
                kind: 'djvu',
                sourcePath: djvuSourcePath.value,
            };
        }

        let snapshot = await pdfViewerRef.value?.saveDocument?.() ?? null;
        if (!snapshot && pdfData.value) {
            snapshot = pdfData.value.slice();
        }

        if (!snapshot && workingCopyPath.value && hasElectronAPI()) {
            try {
                snapshot = await getElectronAPI().readFile(workingCopyPath.value);
            } catch (error) {
                BrowserLogger.warn('workspace', 'Failed to read working copy for split payload', {
                    path: workingCopyPath.value,
                    error,
                });
            }
        }

        if (!snapshot) {
            return { kind: 'empty' };
        }

        return {
            kind: 'pdfSnapshot',
            fileName: fileName.value ?? 'document.pdf',
            originalPath: originalPath.value,
            data: snapshot.slice(),
            isDirty: (
                annotationDirty.value
                || isDirty.value
                || hasAnnotationChanges()
                || pageLabelsDirty.value
                || bookmarksDirty.value
            ),
        };
    }

    async function restoreSplitPayload(payload: TSplitPayload): Promise<void> {
        if (payload.kind === 'empty') {
            return;
        }

        if (payload.kind === 'djvu') {
            await openFileWithDjvuCleanup({
                kind: 'djvu',
                workingPath: '',
                originalPath: payload.sourcePath,
            });
            return;
        }

        if (!hasElectronAPI()) {
            await loadPdfFromData(payload.data.slice(), {
                pushHistory: true,
                persistWorkingCopy: false,
            });
            originalPath.value = payload.originalPath;
            if (payload.isDirty) {
                markDirty();
            }
            return;
        }

        const workingPath = await getElectronAPI().createWorkingCopyFromData(
            payload.fileName,
            payload.data,
            payload.originalPath ?? undefined,
        );
        await loadPdfFromPath(workingPath, { markDirty: payload.isDirty });
        originalPath.value = payload.originalPath;
    }

    return {
        pdfSrc,
        pdfData,
        workingCopyPath,
        originalPath,
        fileName,
        isDirty,
        pdfError,
        isElectron,
        openBatchProgress,
        loadPdfFromData,

        isDjvuMode,
        djvuSourcePath,
        conversionState,
        djvuIsLoadingPages,
        djvuLoadingProgress,
        djvuShowBanner,
        djvuError,
        showConvertDialog,
        openConvertDialog,
        djvuDismissBanner,
        handleDjvuConvert,
        handleDjvuCancel,

        recentFiles,
        removeRecentFile,
        clearRecentFiles,

        pdfViewerRef,
        zoomDropdownOpen,
        pageDropdownOpen,
        ocrPopupOpen,
        overflowMenuOpen,
        selectedThumbnailPages,
        thumbnailInvalidationRequest,
        handleSelectedThumbnailPagesUpdate,
        handleDropdownOpen,
        closeAllDropdowns,
        closeOtherDropdowns,

        zoom,
        fitMode,
        viewMode,
        currentPage,
        totalPages,
        pdfDocument,
        isLoading,
        dragMode,
        continuousScroll,
        appSettings,
        showSidebar,
        sidebarTab,
        isSaving,
        isSavingAs,
        isHistoryBusy,
        isExportInProgress,
        exportScopeDialogOpen,
        exportScopeDialogMode,
        exportScopeDialogSelectedPages,

        pageLabels,
        pageLabelRanges,
        handlePageLabelRangesUpdate,
        bookmarkEditMode,
        handleBookmarksChange,

        annotationContextMenu,
        annotationContextMenuStyle,
        annotationContextMenuCanCopy,
        annotationContextMenuCanCreateFree,
        contextMenuAnnotationLabel,
        contextMenuDeleteActionLabel,

        pageContextMenu,
        pageContextMenuStyle,
        showPageContextMenu,

        annotationTool,
        annotationKeepActive,
        annotationPlacingPageNote,
        annotationSettings,
        annotationComments,
        annotationActiveCommentStableKey,
        handleAnnotationToolChange,
        handleAnnotationToolAutoReset,
        handleAnnotationToolCancel,
        handleAnnotationSettingChange,
        handleAnnotationState,
        handleAnnotationModified,

        searchQuery,
        results,
        pageMatches,
        currentResultIndex,
        currentResult,
        isSearching,
        totalMatches,
        searchProgress,
        isTruncated,
        minQueryLength,
        handleSearch,
        handleSearchNext,
        handleSearchPrevious,
        handleGoToResult,

        handleSave,
        handleSaveAs,
        handleExportDocx,
        handleExportImages,
        handleExportMultiPageTiff,
        handleExportScopeDialogSubmit,
        handleExportScopeDialogOpenChange,
        handleOcrComplete,
        docxExportError,
        isAnySaving,
        isExportingDocx,
        canSave,

        isFitWidthActive,
        isFitHeightActive,
        annotationCursorMode,
        canUndo,
        canRedo,
        handleUndo,
        handleRedo,
        handleCaptureRegion,
        isCapturingRegion,

        annotationNotePositions,
        sortedAnnotationNoteWindows,
        updateAnnotationNoteText,
        updateAnnotationNotePosition,
        closeAnnotationNote,
        bringAnnotationNoteToFront,

        shapePropertiesPopover,
        selectedShapeForProperties,
        handleCommentSelection,
        handleStartPlaceNote,
        handleAnnotationFocusComment,
        handleAnnotationCommentClick,
        handleOpenAnnotationNote,
        closeShapeProperties,
        handleShapePropertyUpdate,
        handleShapeContextMenu,
        handleViewerAnnotationContextMenu,
        openContextMenuNote,
        copyContextMenuNoteText,
        deleteContextMenuComment,
        createContextMenuFreeNote,
        createContextMenuSelectionNote,
        createContextMenuMarkup,
        handleCopyAnnotationComment,
        handleDeleteAnnotationComment,

        statusFilePath,
        statusFileSizeLabel,
        statusZoomLabel,
        statusCanShowInFolder,
        statusShowInFolderTooltip,
        statusShowInFolderAriaLabel,
        statusSaveDotClass,
        statusSaveDotCanSave,
        statusSaveDotTooltip,
        statusSaveDotAriaLabel,
        handleStatusSaveClick,
        handleStatusShowInFolderClick,

        isPageOperationInProgress,
        pageOpsDelete,
        pageOpsExtract,
        pageOpsInsert,
        pageOpsReorder,
        handlePageContextMenuDelete,
        handlePageContextMenuExtract,
        handlePageContextMenuExport,
        handlePageRotate,
        handlePageContextMenuRotateCw,
        handlePageContextMenuRotateCcw,
        handlePageContextMenuInsertBefore,
        handlePageContextMenuInsertAfter,
        handlePageFileDrop,
        handlePageContextMenuSelectAll,
        handlePageContextMenuInvertSelection,

        handleOpenFileFromUi,
        handleOpenFileDirectWithPersist,
        handleOpenFileDirectBatchWithPersist,
        handleOpenFileWithResult,
        handleCloseFileFromUi,
        openRecentFile,
        captureSplitPayload,
        restoreSplitPayload,

        setupShortcuts,
        cleanupShortcuts,

        sidebarWidth,
        sidebarWrapperStyle,
        isResizingSidebar,
        startSidebarResize,
        cleanupSidebarResizeListeners,

        handleFitMode,
        enableDragMode,
        handleGoToPage,
        initFromStorage,
        hasPdf,
    };
};
