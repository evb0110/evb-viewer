import {
    ref,
    shallowRef,
    computed,
    watch,
    watchEffect,
    type Ref,
} from 'vue';
import { useStorage } from '@vueuse/core';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { TFitMode } from '@app/types/shared';
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
import type { TTabUpdate } from '@app/types/tabs';
import { hasElectronAPI } from '@app/utils/electron';
import { useWorkspaceViewState } from '@app/composables/page/workspace-view-state';

type TPdfSidebarTab = 'annotations' | 'thumbnails' | 'bookmarks' | 'search';

export interface IPdfViewerExpose {
    scrollToPage: (page: number) => void;
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

export interface IOcrPopupExpose {
    close: () => void;
    open: () => void;
    exportDocx: () => Promise<boolean>;
    isExporting: { value: boolean };
}

export interface IWorkspaceOrchestrationDeps {
    isActive: Ref<boolean>;
    emit: {
        (e: 'update-tab', updates: TTabUpdate): void;
        (e: 'open-in-new-tab', path: string): void;
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
    const zoomDropdownRef = ref<{ close: () => void } | null>(null);
    const pageDropdownRef = ref<{ close: () => void } | null>(null);
    const ocrPopupRef = ref<IOcrPopupExpose | null>(null);
    const overflowMenuRef = ref<{ close: () => void } | null>(null);
    const sidebarRef = ref<{
        focusSearch: () => void | Promise<void>;
        selectAllPages: () => void;
        invertPageSelection: () => void;
        invalidateThumbnailPages: (pages: number[]) => void;
        selectedThumbnailPages: number[];
    } | null>(null);
    const pdfToolbarRef = ref<{ toolbarRef: HTMLElement | null } | null>(null);

    const {
        toolbarRef,
        collapseTier,
        hasOverflowItems,
        isCollapsed,
    } = useToolbarOverflow();

    watchEffect(() => {
        toolbarRef.value = pdfToolbarRef.value?.toolbarRef ?? null;
    });

    const {
        closeAllDropdowns,
        closeOtherDropdowns,
    } = useDropdownManager({
        zoomDropdownRef,
        pageDropdownRef,
        ocrPopupRef,
        overflowMenuRef,
    });

    const zoom = ref(1);
    const fitMode = ref<TFitMode>('width');
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
    });

    const annotationKeepActiveStorage = useStorage<string>(
        STORAGE_KEYS.ANNOTATION_KEEP_ACTIVE,
        '0',
        undefined,
        { initOnMounted: true },
    );

    watch(annotationKeepActiveStorage, (stored) => {
        const resolved = stored === '1';
        if (annotationKeepActive.value !== resolved) {
            annotationKeepActive.value = resolved;
        }
    }, { immediate: true });

    watch(annotationKeepActive, (value) => {
        const next = value ? '1' : '0';
        if (annotationKeepActiveStorage.value !== next) {
            annotationKeepActiveStorage.value = next;
        }
    });

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
        ocrPopupRef,
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
        statusSaveDotClass,
        statusSaveDotCanSave,
        statusSaveDotTooltip,
        statusSaveDotAriaLabel,
        handleStatusSaveClick,
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
        sidebarRef,
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
        openFileWithDjvuCleanup,
        openFileDirectWithDjvuCleanup,
        openFileDirectBatchWithDjvuCleanup,
        closeFileWithDjvuCleanup,
    } = useWorkspaceFileSwitch({
        workingCopyPath,
        isDjvuMode,
        cleanupDjvuTemp,
        exitDjvuMode,
        openFile,
        openFileDirect,
        openFileDirectBatch,
        closeFile,
    });

    const {
        handleOpenFileFromUi,
        handleOpenFileDirectWithPersist,
        handleOpenFileDirectBatchWithPersist,
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
        openFile: openFileWithDjvuCleanup,
        openFileDirect: openFileDirectWithDjvuCleanup,
        openFileDirectBatch: openFileDirectBatchWithDjvuCleanup,
        closeFile: closeFileWithDjvuCleanup,
        closeAllDropdowns,
    });

    const {
        setupShortcuts,
        cleanupShortcuts,
    } = usePageShortcuts({
        pdfSrc,
        showSettings,
        annotationPlacingPageNote,
        pdfViewerRef,
        sidebarRef,
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

    function initFromStorage() {
        if (import.meta.dev) {
            BrowserLogger.debug('workspace', 'Electron API available', isElectron.value);
        }
        if (hasElectronAPI()) {
            loadRecentFiles();
        }
    }

    const hasPdf = computed(() => !!pdfSrc.value);

    return {
        pdfSrc,
        pdfData,
        workingCopyPath,
        originalPath,
        fileName,
        isDirty,
        pdfError,
        isElectron,
        loadPdfFromData,

        isDjvuMode,
        djvuSourcePath,
        conversionState,
        djvuIsLoadingPages,
        djvuLoadingProgress,
        djvuShowBanner,
        showConvertDialog,
        openConvertDialog,
        djvuDismissBanner,
        handleDjvuConvert,
        handleDjvuCancel,

        recentFiles,
        removeRecentFile,
        clearRecentFiles,

        pdfViewerRef,
        zoomDropdownRef,
        pageDropdownRef,
        ocrPopupRef,
        overflowMenuRef,
        sidebarRef,
        pdfToolbarRef,

        collapseTier,
        hasOverflowItems,
        isCollapsed,
        closeAllDropdowns,
        closeOtherDropdowns,

        zoom,
        fitMode,
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
        statusSaveDotClass,
        statusSaveDotCanSave,
        statusSaveDotTooltip,
        statusSaveDotAriaLabel,
        handleStatusSaveClick,

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
        handleCloseFileFromUi,
        openRecentFile,

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
