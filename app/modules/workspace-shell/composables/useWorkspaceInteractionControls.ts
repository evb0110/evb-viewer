import type {
    ComputedRef,
    Ref,
} from 'vue';
import { ZOOM } from '@app/constants/pdfLayout';
import { usePageShortcuts } from '@app/modules/workspace-shell/composables/usePageShortcuts';
import { useWorkspaceCrop } from '@app/modules/workspace-shell/composables/useWorkspaceCrop';
import { useWorkspaceSplitPayload } from '@app/modules/workspace-shell/composables/useWorkspaceSplitPayload';
import { useWorkspaceViewerDefaults } from '@app/modules/workspace-shell/composables/useWorkspaceViewerDefaults';
import type {
    IWorkspaceDocumentViewerSplitPort,
    IWorkspacePdfViewerInteractionPort,
} from '@app/modules/workspace-shell/types/workspaceOrchestration.types';
import type { IScrollToPageOptions } from '@app/modules/pdf-viewer/public';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type { TOpenFileResult } from '@contracts/electronApiDocuments';
import type { TDocumentOpenOutcome } from '@app/types/documentOpenOutcome';
import type { ISettingsData } from '@contracts/shared';
import type { TDocumentOperationKind } from '@app/types/documentOperationKind';
import type {
    IAnnotationSettings,
    TAnnotationTool,
} from '@app/types/annotations';
import type {
    TFitMode,
    TPdfViewMode,
    TZoomMode,
} from '@app/types/pdfContracts';
import type { TPdfSource } from '@app/types/pdfUi';
import { runDetached } from '@app/utils/asyncGuard';
import type { INativePdfSaveTransactionOptions } from '@app/modules/workspace-shell/composables/nativePdfMutationArtifact';

interface IWorkspaceInteractionControlsOptions {
    isActive: Ref<boolean>;
    appSettings: Ref<ISettingsData>;
    annotationSettings: Ref<IAnnotationSettings>;
    viewMode: Ref<TPdfViewMode>;
    continuousScroll: Ref<boolean>;
    fitMode: Ref<TFitMode>;
    zoom: Ref<number>;
    effectiveZoom: Ref<number>;
    zoomMode: Ref<TZoomMode>;
    pdfSrc: Ref<TPdfSource | null>;
    canPrint: Ref<boolean>;
    canSave: Ref<boolean>;
    showSettings: Ref<boolean>;
    annotationTool: Ref<TAnnotationTool>;
    pdfViewerRef: Ref<IWorkspacePdfViewerInteractionPort | null>;
    documentViewerRef: Ref<IWorkspaceDocumentViewerSplitPort | null>;
    shapePropertiesPopoverVisible: ComputedRef<boolean>;
    annotationContextMenuVisible: ComputedRef<boolean>;
    pageContextMenuVisible: ComputedRef<boolean>;
    closeAnnotationContextMenu: () => void;
    closePageContextMenu: () => void;
    closeShapeProperties: () => void;
    openSearch: () => void;
    openAnnotations: () => void;
    handleAnnotationToolChange: (tool: TAnnotationTool) => void;
    handleFitMode: (mode: TFitMode) => void;
    handleGoToPage: (page: number, options?: IScrollToPageOptions) => void;
    handleSave: () => Promise<unknown>;
    handlePrint: () => void | Promise<void>;
    handleToggleSidebar: () => void;
    handleDropdownOpenChange: (
        dropdown: 'zoom' | 'page' | 'ocr' | 'overflow' | 'appMenu',
        isOpen: boolean,
    ) => void;
    clearDocxExportError: () => void;
    workingCopyPath: Ref<TDocumentRef | null>;
    isDjvuMode: Ref<boolean>;
    djvuSourcePath: Ref<TDocumentRef | null>;
    currentPage: Ref<number>;
    navigationPage: Ref<number>;
    totalPages: Ref<number>;
    fileName: Ref<string | null>;
    originalPath: Ref<TDocumentRef | null>;
    hasPendingTabChanges: ComputedRef<boolean>;
    pdfData: Ref<Uint8Array | null>;
    openFileWithViewerLifecycle: (result: TOpenFileResult) => Promise<TDocumentOpenOutcome>;
    waitForPdfReload: (page: number) => Promise<void>;
    loadPdfFromPath: (path: TDocumentRef, options?: { markDirty?: boolean }) => Promise<void>;
    documentRevisionToken: Ref<TDocumentRevisionToken | null>;
    getNativeSaveTransactionOptions?: () => INativePdfSaveTransactionOptions;
    runWithDocumentOperationLease?: <T>(
        kind: TDocumentOperationKind,
        operation: () => Promise<T>,
    ) => Promise<T>;
    preserveInitialStateForFirstSource?: boolean | undefined;
}

export const useWorkspaceInteractionControls = (options: IWorkspaceInteractionControlsOptions) => {
    const {
        isActive,
        appSettings,
        annotationSettings,
        viewMode,
        continuousScroll,
        fitMode,
        zoom,
        effectiveZoom,
        zoomMode,
        pdfSrc,
        showSettings,
        annotationTool,
        pdfViewerRef,
        documentViewerRef,
        shapePropertiesPopoverVisible,
        annotationContextMenuVisible,
        pageContextMenuVisible,
        closeAnnotationContextMenu,
        closePageContextMenu,
        closeShapeProperties,
        openSearch,
        openAnnotations,
        handleAnnotationToolChange,
        handleSave,
        handleDropdownOpenChange,
        clearDocxExportError,
        workingCopyPath,
        isDjvuMode,
        djvuSourcePath,
        currentPage,
        totalPages,
        fileName,
        originalPath,
        hasPendingTabChanges,
        pdfData,
        openFileWithViewerLifecycle,
        waitForPdfReload,
        loadPdfFromPath,
        documentRevisionToken,
        getNativeSaveTransactionOptions,
        runWithDocumentOperationLease,
    } = options;

    const {
        resolveDisplayZoom,
        setCustomZoomFromDisplay,
    } = useWorkspaceViewerDefaults({
        appSettings,
        annotationSettings,
        viewMode,
        continuousScroll,
        fitMode,
        zoom,
        effectiveZoom,
        zoomMode,
        pdfSrc,
        preserveInitialStateForFirstSource: options.preserveInitialStateForFirstSource,
        documentSourceKey: computed(() => {
            if (isDjvuMode.value && djvuSourcePath.value) {
                return `djvu:${djvuSourcePath.value}`;
            }
            if (workingCopyPath.value) {
                return `pdf:${workingCopyPath.value}`;
            }
            return pdfSrc.value;
        }),
    });

    function handleZoomIn() {
        setCustomZoomFromDisplay(resolveDisplayZoom() + ZOOM.STEP);
    }

    function handleZoomOut() {
        const displayZoom = resolveDisplayZoom();
        if (displayZoom <= ZOOM.MIN) {
            return;
        }
        setCustomZoomFromDisplay(displayZoom - ZOOM.STEP);
    }

    usePageShortcuts({
        isActive,
        hasInteractiveDocument: computed(() => Boolean(pdfSrc.value ?? djvuSourcePath.value)),
        pdfSrc,
        canPrint: options.canPrint,
        canSave: options.canSave,
        showSettings,
        annotationTool,
        pdfViewerRef,
        shapePropertiesPopoverVisible,
        annotationContextMenuVisible,
        pageContextMenuVisible,
        closeAnnotationContextMenu,
        closePageContextMenu,
        closeShapeProperties,
        openSearch,
        openAnnotations,
        handleAnnotationToolChange,
        handleZoomIn,
        handleZoomOut,
        handleActualSize: () => {
            setCustomZoomFromDisplay(1);
        },
        handleFitMode: options.handleFitMode,
        navigationPage: options.navigationPage,
        totalPages,
        viewMode,
        handleGoToPage: options.handleGoToPage,
        handleSave: () => {
            void runDetached(handleSave, {
                category: 'user-visible-operation',
                scope: 'workspace',
                message: 'Failed to save document',
            });
        },
        handlePrint: () => {
            void runDetached(async () => options.handlePrint(), {
                category: 'user-visible-operation',
                scope: 'workspace',
                message: 'Failed to print document',
            });
        },
        handleToggleSidebar: options.handleToggleSidebar,
    });

    const isCapturingRegion = computed(() => pdfViewerRef.value?.isCapturingRegion ?? false);

    function handleCaptureRegion() {
        if (!pdfViewerRef.value || isDjvuMode.value) {
            return;
        }
        void runDetached(() => pdfViewerRef.value!.captureRegionToClipboard(), {
            category: 'user-visible-operation',
            scope: 'workspace',
            message: 'Failed to capture PDF region',
        });
    }

    function handleActualSize() {
        setCustomZoomFromDisplay(1);
    }

    const {
        cropDialogOpen,
        cropDialogLoading,
        cropDialogMargins,
        cropDialogMediaBox,
        cropDialogCurrentBox,
        cropDialogPageNumber,
        cropDialogRotation,
        isCropSelecting,
        handleCrop,
    } = useWorkspaceCrop({
        pdfViewerRef,
        workingCopyPath,
    });

    function handleDropdownOpen(
        dropdown: 'zoom' | 'page' | 'ocr' | 'overflow' | 'appMenu',
        isOpen: boolean,
    ) {
        handleDropdownOpenChange(dropdown, isOpen);
        if (isOpen && dropdown === 'ocr') {
            clearDocxExportError();
        }
    }

    const {
        captureSplitPayload,
        restoreSplitPayload,
    } = useWorkspaceSplitPayload({
        pdfSrc,
        isDjvuMode,
        djvuSourcePath,
        currentPage,
        totalPages,
        fileName,
        originalPath,
        workingCopyPath,
        hasPendingTabChanges,
        pdfViewerRef,
        documentViewerRef,
        pdfData,
        openFileWithViewerLifecycle,
        waitForPdfReload,
        loadPdfFromPath,
        documentRevisionToken,
        ...(getNativeSaveTransactionOptions !== undefined ? {getNativeSaveTransactionOptions} : {}),
        ...(runWithDocumentOperationLease !== undefined ? { runWithDocumentOperationLease } : {}),
    });

    return {
        isCapturingRegion,
        handleZoomIn,
        handleZoomOut,
        handleCaptureRegion,
        handleActualSize,
        cropDialogOpen,
        cropDialogLoading,
        cropDialogMargins,
        cropDialogMediaBox,
        cropDialogCurrentBox,
        cropDialogPageNumber,
        cropDialogRotation,
        isCropSelecting,
        handleCrop,
        handleDropdownOpen,
        captureSplitPayload,
        restoreSplitPayload,
    };
};
