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
import type {
    IWorkspaceViewerCapabilities,
    TDocumentCommitReceipt,
} from '@app/types/workspaceExpose';
import type { IDocumentPageLabelModel } from '@app/modules/document-viewer/public';

export type {IAgentOcrRunOptions} from '@contracts/agentOcr';
export type {IOcrPopupAgentExpose} from '@app/types/ocrPopupAgentExpose';

export type TWorkspaceAgentSidebarTab = 'annotations' | 'bookmarks' | 'thumbnails' | 'search';
export type TWorkspaceAgentFitMode = 'width' | 'height';
export type TWorkspaceAgentRotateAngle = 90 | 180 | 270;
export type TWorkspaceAgentTranslate = (key: 'bookmarks.untitled') => string;

type TDocumentMutation<TArgs extends unknown[] = [], TResult = Promise<boolean>> = (...args: [...TArgs, onCommitted?: TDocumentCommitReceipt]) => TResult;
export interface IUseDocumentWorkspaceAgentOptions extends Record<
    | 'canSave' | 'canUndo' | 'canRedo'
    | 'annotationDirty' | 'bookmarksDirty' | 'continuousScroll' | 'hasPdf'
    | 'isAnySaving' | 'isDjvuMode' | 'ocrPopupOpen' | 'pageLabelsDirty'
    | 'showConvertDialog' | 'showSidebar', Ref<boolean>> {
    annotationComments: Ref<IAnnotationCommentSummary[]>;
    annotationCommentsStatus: Ref<TAnnotationCommentsStatus>;
    annotationInventory: Ref<IAnnotationInventoryCompleteness | null>;
    annotationTool: Ref<TAnnotationTool>;
    bookmarkItems: Ref<IPdfBookmarkEntry[]>;
    getBookmarksRevision: () => number;
    closeAllDropdowns: () => void;
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
    handleRepairSave: TDocumentMutation;
    handleOptimizePdfForInteraction: TDocumentMutation;
    handleUndo: TDocumentMutation<[], unknown>;
    handleRedo: TDocumentMutation<[], unknown>;
    handlePageLabelRangesUpdate: (ranges: IPdfPageLabelRange[]) => void;
    handlePageRotate: TDocumentMutation<[pages: number[] | TPageSelection, degrees: TWorkspaceAgentRotateAngle]>;
    handlePrint: () => void;
    handlePrintCurrentPage: () => Promise<unknown>;
    handleQuickNoteAction: () => Promise<unknown>;
    handleSave: TDocumentMutation;
    handleSaveAs: () => Promise<boolean>;
    handleZoomIn: () => void;
    handleZoomOut: () => void;
    isSameAnnotationComment: (left: IAnnotationCommentSummary, right: IAnnotationCommentSummary) => boolean;
    markAnnotationDirty: () => void;
    ocr: IOcrPopupAgentExpose;
    openConvertDialog: () => void;
    originalPath: Ref<TDocumentRef | null>;
    pageLabelRanges: Ref<IPdfPageLabelRange[]>;
    pageLabels: Ref<string[] | null>;
    pageLabelModel?: Ref<IDocumentPageLabelModel | null> | undefined;
    pageLabelsResolved?: Ref<boolean> | undefined;
    pageOpsDelete: TDocumentMutation<[pages: number[] | TPageSelection, totalPages: number]>;
    pageOpsExtract: (pages: number[] | TPageSelection) => Promise<boolean>;
    pageOpsInsert: TDocumentMutation<[totalPages: number, afterPage: number]>;
    handleCropPages: TDocumentMutation<[pages: number[], margins: ICropMargins]>;
    handleRemoveCrop: TDocumentMutation<[pages: number[]]>;
    pdfViewerRef: Ref<IWorkspacePdfViewerAgentPort | null>;
    selectedThumbnailPages: Ref<number[]>;
    selectedPageSelection?: Ref<TPageSelection | null>;
    sidebarTab: Ref<TWorkspaceAgentSidebarTab>;
    sortedAnnotationNoteWindows: Ref<IAnnotationNoteWindowViewModel[]>;
    t: TWorkspaceAgentTranslate;
    tabId: string;
    totalPages: Ref<number>;
    updateAnnotationNoteText: (stableKey: string, text: string) => void;
    viewMode: Ref<TPdfViewMode>;
    viewerCapabilities: Ref<IWorkspaceViewerCapabilities>;
    waitForDocumentOpenSettled: () => Promise<void>;
    /** Resolves once the drafts commits that accepted edits started are done. */
    whenDraftsCommitted: () => Promise<void>;
    workingCopyPath: Ref<TDocumentRef | null>;
    zoom: Ref<number>;
}
