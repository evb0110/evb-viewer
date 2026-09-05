import type {
    ComputedRef,
    Ref,
} from 'vue';
import { usePageStatusBar } from '@app/modules/workspace-shell/composables/usePageStatusBar';
import { usePageOpsHandlers } from '@app/modules/workspace-shell/composables/usePageOpsHandlers';
import type { IPageOpsHandlersDeps } from '@app/modules/workspace-shell/composables/usePageOpsHandlers';
import { usePageFileOperations } from '@app/modules/workspace-shell/composables/usePageFileOperations';
import type { IPageFileOperationsDeps } from '@app/modules/workspace-shell/composables/usePageFileOperations';
import type { IWorkspacePdfViewerDocumentControlsPort } from '@app/modules/workspace-shell/types/workspaceOrchestration.types';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TOpenFileResult } from '@contracts/electronApiDocuments';
import type { TDocumentOpenOutcome } from '@app/types/documentOpenOutcome';
import type { TPageSelection } from '@contracts/pageNumbers';

type TReadableRef<T> = ComputedRef<T> | Ref<T>;

interface IWorkspaceDocumentControlsOptions extends Omit<IPageFileOperationsDeps,
    'closeFile'
    | 'openFile'
    | 'openFileDirect'
    | 'openFileDirectBatch'
    | 'pickFileToOpen'
>, Omit<IPageOpsHandlersDeps,
    'invalidateThumbnailPages'
    | 'onExportPages'
    | 'onExtractedDocument'
    | 'pdfViewerRef'
    > {
    hasDocument: Ref<boolean>;
    pdfData: Ref<Uint8Array | null>;
    originalPath: TReadableRef<TDocumentRef | null>;
    effectiveZoom: Ref<number>;
    knownFileSizeBytes?: TReadableRef<number | null> | undefined;
    isDocumentVisualPending?: Ref<boolean>;
    canSave: Ref<boolean>;
    hasSaveFailure: TReadableRef<boolean>;
    handleSave: () => Promise<unknown>;
    requestThumbnailInvalidation: (pages: number[]) => void;
    pdfViewerRef: Ref<IWorkspacePdfViewerDocumentControlsPort | null>;
    canMutatePages: Ref<boolean>;
    handleExportImages: (pages: number[] | TPageSelection) => Promise<void>;
    pickFileToOpen: () => Promise<TOpenFileResult | null>;
    openFileWithViewerLifecycle: (preSelected?: TOpenFileResult) => Promise<TDocumentOpenOutcome>;
    openFileDirectWithViewerLifecycle: (path: TDocumentRef) => Promise<TDocumentOpenOutcome>;
    openFileDirectBatchWithViewerLifecycle: (paths: TDocumentRef[]) => Promise<TDocumentOpenOutcome>;
    closeFileWithViewerLifecycle: () => Promise<void>;
}

export const useWorkspaceDocumentControls = (options: IWorkspaceDocumentControlsOptions) => {
    const {
        hasDocument,
        pdfSrc,
        pdfData,
        originalPath,
        workingCopyPath,
        documentRevisionToken,
        pageLabels,
        pageLabelRanges,
        pageLabelsResolved,
        bookmarkItems,
        bookmarksResolved,
        currentPage,
        effectiveZoom,
        knownFileSizeBytes,
        isDocumentVisualPending,
        canSave,
        hasSaveFailure,
        isAnySaving,
        isHistoryBusy,
        handleSave,
        totalPages,
        selectedThumbnailPages,
        setSelectedThumbnailPages,
        selectedPageSelection,
        setSelectedPageSelection,
        requestThumbnailInvalidation,
        pdfViewerRef,
        canMutatePages,
        pageContextMenu,
        closePageContextMenu,
        handleExportImages,
        ensureHistoryBaselineForMutation,
        saveAnnotationsForPageMutation,
        reloadWorkingCopyIntoHistory,
        ensureWorkingCopyFreshForRead,
        preparePdfReloadWaiter,
        clearOcrCache,
        resetSearchCache,
        isExportingDocx,
        isAnyAnnotationNoteSaving,
        isDocumentOperationInProgress,
        annotationNoteWindows,
        hasPendingUnsavedChanges,
        annotationDirty,
        isDirty,
        pageLabelsDirty,
        bookmarksDirty,
        persistAllAnnotationNotes,
        pickFileToOpen,
        openFileWithViewerLifecycle,
        openFileDirectWithViewerLifecycle,
        openFileDirectBatchWithViewerLifecycle,
        closeFileWithViewerLifecycle,
        closeAllDropdowns,
        emitOpenInNewTab,
        removeRecentFileIfMissing,
    } = options;

    const pageStatusBar = usePageStatusBar({
        hasDocument,
        pdfSrc,
        pdfData,
        originalPath,
        workingCopyPath,
        ...(documentRevisionToken !== undefined ? { documentRevisionToken } : {}),
        effectiveZoom,
        ...(knownFileSizeBytes ? {knownFileSizeBytes} : {}),
        ...(isDocumentVisualPending ? { isDocumentVisualPending } : {}),
        canSave,
        hasSaveFailure,
        isAnySaving,
        isHistoryBusy,
        handleSave,
    });

    const pageOpsHandlers = usePageOpsHandlers({
        workingCopyPath,
        pageLabels,
        ...(pageLabelRanges !== undefined ? {pageLabelRanges} : {}),
        ...(pageLabelsResolved !== undefined ? {pageLabelsResolved} : {}),
        bookmarkItems,
        ...(bookmarksResolved !== undefined ? {bookmarksResolved} : {}),
        currentPage,
        totalPages,
        selectedThumbnailPages,
        setSelectedThumbnailPages,
        ...(selectedPageSelection !== undefined ? {selectedPageSelection} : {}),
        ...(setSelectedPageSelection !== undefined ? {setSelectedPageSelection} : {}),
        invalidateThumbnailPages: requestThumbnailInvalidation,
        pdfViewerRef,
        pageContextMenu,
        closePageContextMenu,
        onExportPages: (pages) => {
            void handleExportImages(pages);
        },
        canMutatePages,
        onExtractedDocument: (path) => {
            emitOpenInNewTab(path);
        },
        ensureHistoryBaselineForMutation,
        saveAnnotationsForPageMutation,
        reloadWorkingCopyIntoHistory,
        ...(documentRevisionToken !== undefined ? { documentRevisionToken } : {}),
        ...(ensureWorkingCopyFreshForRead !== undefined ? { ensureWorkingCopyFreshForRead } : {}),
        preparePdfReloadWaiter,
        clearOcrCache,
        resetSearchCache,
        ...(options.runWithDocumentOperationLease !== undefined
            ? { runWithDocumentOperationLease: options.runWithDocumentOperationLease }
            : {}),
    });

    const pageFileOperations = usePageFileOperations({
        pdfSrc,
        hasDocument,
        isAnySaving,
        isHistoryBusy,
        isExportingDocx,
        isAnyAnnotationNoteSaving,
        ...(isDocumentOperationInProgress !== undefined ? { isDocumentOperationInProgress } : {}),
        annotationNoteWindows,
        hasPendingUnsavedChanges,
        annotationDirty,
        isDirty,
        pageLabelsDirty,
        bookmarksDirty,
        persistAllAnnotationNotes,
        handleSave,
        pickFileToOpen,
        openFile: openFileWithViewerLifecycle,
        openFileDirect: openFileDirectWithViewerLifecycle,
        openFileDirectBatch: openFileDirectBatchWithViewerLifecycle,
        closeFile: closeFileWithViewerLifecycle,
        closeAllDropdowns,
        emitOpenInNewTab,
        removeRecentFileIfMissing,
    });

    return {
        ...pageStatusBar,
        ...pageOpsHandlers,
        ...pageFileOperations,
    };
};
