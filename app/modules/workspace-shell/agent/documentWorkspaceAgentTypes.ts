import type { Ref } from 'vue';
import type { TDocumentRef } from '@contracts/documentRef';
import type { IDocumentRevisionInfo } from '@contracts/documentRevision';
import type { TPdfViewMode } from '@contracts/shared';
import type { TPageSelection } from '@contracts/pageNumbers';
import type { ICropMargins } from '@app/types/crop';
import type {
    IPdfBookmarkEntry,
    IPdfPageLabelRange,
} from '@app/types/pdfContracts';
import type { IPdfBookmarkChangePayload } from '@app/types/pdfUi';
import type {
    IAnnotationCommentSummary,
    IAnnotationInventoryCompleteness,
    TAnnotationCommentsStatus,
    TAnnotationTool,
} from '@app/types/annotations';
import type { IAnnotationNoteWindowViewModel } from '@app/types/annotationNoteWindow';
import type { IOcrPopupAgentExpose } from '@app/types/ocrPopupAgentExpose';
import type { IWorkspacePdfViewerAgentPort } from '@app/modules/workspace-shell/types/workspaceOrchestration.types';
import type { IWorkspaceViewerCapabilities } from '@app/types/workspaceExpose';
import type { IDocumentPageLabelModel } from '@app/modules/document-viewer/public';

export type {IAgentOcrRunOptions} from '@contracts/agentOcr';
export type {IOcrPopupAgentExpose} from '@app/types/ocrPopupAgentExpose';

export type TWorkspaceAgentSidebarTab = 'annotations' | 'bookmarks' | 'thumbnails' | 'search';
export type TWorkspaceAgentFitMode = 'width' | 'height';
export type TWorkspaceAgentRotateAngle = 90 | 180 | 270;
export type TWorkspaceAgentTranslate = (key: 'bookmarks.untitled') => string;

export interface IUseDocumentWorkspaceAgentOptions {
    annotationComments: Ref<IAnnotationCommentSummary[]>;
    annotationCommentsStatus: Ref<TAnnotationCommentsStatus>;
    annotationInventory: Ref<IAnnotationInventoryCompleteness | null>;
    annotationDirty: Ref<boolean>;
    annotationTool: Ref<TAnnotationTool>;
    bookmarkItems: Ref<IPdfBookmarkEntry[]>;
    bookmarksDirty: Ref<boolean>;
    getBookmarksRevision: () => number;
    canSave: Ref<boolean>;
    canUndo: Ref<boolean>;
    canRedo: Ref<boolean>;
    closeAllDropdowns: () => void;
    continuousScroll: Ref<boolean>;
    currentPage: Ref<number>;
    documentIdentity: Ref<IDocumentRevisionInfo | null>;
    fitMode: Ref<TWorkspaceAgentFitMode>;
    handleActualSize: () => void;
    handleAnnotationFocusComment: (comment: IAnnotationCommentSummary) => Promise<void>;
    handleAnnotationToolChange: (tool: TAnnotationTool) => boolean | Promise<boolean>;
    handleBookmarksChange: (payload: IPdfBookmarkChangePayload) => void;
    updateTextMarkupColorWithHistory: (comment: IAnnotationCommentSummary, color: string) => boolean;
    handleDeleteAnnotationComment: (comment: IAnnotationCommentSummary) => Promise<void>;
    handleDropdownOpen: (dropdown: 'ocr', open: boolean) => void;
    handleExportDocx: () => Promise<unknown>;
    handleExportImages: () => Promise<unknown>;
    handleExportMultiPageTiff: () => Promise<unknown>;
    handleFitMode: (mode: TWorkspaceAgentFitMode) => void;
    handleGoToPage: (page: number) => void;
    handleOpenAnnotationNote: (comment: IAnnotationCommentSummary) => void;
    handleOpenFileFromUi: () => Promise<unknown>;
    handleRepairSave: () => Promise<boolean>;
    handleOptimizePdfForInteraction: () => Promise<boolean>;
    handleUndo: () => Promise<unknown> | unknown;
    handleRedo: () => Promise<unknown> | unknown;
    handlePageLabelRangesUpdate: (ranges: IPdfPageLabelRange[]) => void;
    handlePageRotate: (pages: number[] | TPageSelection, degrees: TWorkspaceAgentRotateAngle) => Promise<boolean>;
    handlePrint: () => void;
    handlePrintCurrentPage: () => Promise<unknown>;
    handleQuickNoteAction: () => Promise<unknown>;
    handleSave: () => Promise<boolean>;
    handleSaveAs: () => Promise<boolean>;
    handleZoomIn: () => void;
    handleZoomOut: () => void;
    hasPdf: Ref<boolean>;
    isAnySaving: Ref<boolean>;
    isDjvuMode: Ref<boolean>;
    isSameAnnotationComment: (left: IAnnotationCommentSummary, right: IAnnotationCommentSummary) => boolean;
    markAnnotationDirty: () => void;
    ocrPopupOpen: Ref<boolean>;
    ocr: IOcrPopupAgentExpose;
    openConvertDialog: () => void;
    originalPath: Ref<TDocumentRef | null>;
    pageLabelRanges: Ref<IPdfPageLabelRange[]>;
    pageLabels: Ref<string[] | null>;
    pageLabelModel?: Ref<IDocumentPageLabelModel | null> | undefined;
    pageLabelsResolved?: Ref<boolean> | undefined;
    pageLabelsDirty: Ref<boolean>;
    pageOpsDelete: (pages: number[] | TPageSelection, totalPages: number) => Promise<boolean>;
    pageOpsExtract: (pages: number[] | TPageSelection) => Promise<boolean>;
    pageOpsInsert: (totalPages: number, afterPage: number) => Promise<boolean>;
    handleCropPages: (pages: number[], margins: ICropMargins) => Promise<boolean>;
    handleRemoveCrop: (pages: number[]) => Promise<boolean>;
    pdfViewerRef: Ref<IWorkspacePdfViewerAgentPort | null>;
    selectedThumbnailPages: Ref<number[]>;
    selectedPageSelection?: Ref<TPageSelection | null>;
    showConvertDialog: Ref<boolean>;
    showSidebar: Ref<boolean>;
    sidebarTab: Ref<TWorkspaceAgentSidebarTab>;
    sortedAnnotationNoteWindows: Ref<IAnnotationNoteWindowViewModel[]>;
    t: TWorkspaceAgentTranslate;
    tabId: string;
    totalPages: Ref<number>;
    updateAnnotationNoteText: (stableKey: string, text: string) => void;
    viewMode: Ref<TPdfViewMode>;
    viewerCapabilities: Ref<IWorkspaceViewerCapabilities>;
    waitForDocumentOpenSettled: () => Promise<void>;
    workingCopyPath: Ref<TDocumentRef | null>;
    zoom: Ref<number>;
}
