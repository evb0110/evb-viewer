import {ref} from 'vue';
import {vi} from 'vitest';
import type {TDocumentRef} from '@contracts/documentRef';
import type {IDocumentRevisionInfo} from '@contracts/documentRevision';
import type {TPdfViewMode} from '@contracts/shared';
import type {
    IUseDocumentWorkspaceAgentOptions, TWorkspaceAgentFitMode,
} from '@app/modules/workspace-shell/agent/documentWorkspaceAgentTypes';
import type {IPdfBookmarkEntry} from '@app/types/pdfContracts';
import type {
    IAnnotationCommentSummary, IAnnotationInventoryCompleteness, TAnnotationCommentsStatus, TAnnotationTool,
} from '@app/types/annotations';
import type {IAnnotationNoteWindowViewModel} from '@app/types/annotationNoteWindow';
import type {IWorkspacePdfViewerAgentPort} from '@app/modules/workspace-shell/types/workspaceOrchestration.types';
import {createDefaultWorkspaceViewerCapabilities} from '@app/types/workspaceExpose';

export function createAgentOptions(
    overrides: Partial<IUseDocumentWorkspaceAgentOptions> = {},
): IUseDocumentWorkspaceAgentOptions {
    const bookmarkItems = ref<IPdfBookmarkEntry[]>([]);
    const pageLabelRanges = ref([{
        startPage: 1,
        style: 'D' as const,
        prefix: '',
        startNumber: 1,
    }]);
    const showSidebar = ref(false);
    const sidebarTab = ref<'annotations' | 'bookmarks' | 'thumbnails' | 'search'>('annotations');

    return {
        annotationComments: ref<IAnnotationCommentSummary[]>([]),
        annotationCommentsStatus: ref<TAnnotationCommentsStatus>('ready'),
        annotationInventory: ref<IAnnotationInventoryCompleteness | null>(null),
        annotationDirty: ref(false),
        annotationTool: ref<TAnnotationTool>('none'),
        bookmarkItems,
        bookmarksDirty: ref(false),
        canSave: ref(false),
        canUndo: ref(false),
        canRedo: ref(false),
        closeAllDropdowns: vi.fn(),
        continuousScroll: ref(false),
        currentPage: ref(1),
        documentIdentity: ref<IDocumentRevisionInfo | null>(null),
        fitMode: ref<TWorkspaceAgentFitMode>('width'),
        handleActualSize: vi.fn(),
        handleAnnotationFocusComment: vi.fn(async () => undefined),
        handleAnnotationToolChange: vi.fn(),
        handleBookmarksChange: vi.fn(({bookmarks}) => {
            bookmarkItems.value = bookmarks;
        }),
        getBookmarksRevision: () => 0,
        updateTextMarkupColorWithHistory: vi.fn(() => true),
        handleDeleteAnnotationComment: vi.fn(async () => undefined),
        handleDropdownOpen: vi.fn(),
        handleExportDocx: vi.fn(async () => undefined),
        handleExportImages: vi.fn(async () => undefined),
        handleExportMultiPageTiff: vi.fn(async () => undefined),
        handleFitMode: vi.fn(),
        handleGoToPage: vi.fn(),
        handleOpenAnnotationNote: vi.fn(),
        handleOpenFileFromUi: vi.fn(async () => undefined),
        handleRepairSave: vi.fn(async () => true),
        handleOptimizePdfForInteraction: vi.fn(async () => true),
        handleUndo: vi.fn(async () => undefined),
        handleRedo: vi.fn(async () => undefined),
        handlePageLabelRangesUpdate: vi.fn((ranges) => {
            pageLabelRanges.value = ranges;
        }),
        handlePageRotate: vi.fn(async () => true),
        handlePrint: vi.fn(),
        handlePrintCurrentPage: vi.fn(async () => undefined),
        handleQuickNoteAction: vi.fn(async () => undefined),
        handleSave: vi.fn(async () => true),
        handleSaveAs: vi.fn(async () => true),
        handleZoomIn: vi.fn(),
        handleZoomOut: vi.fn(),
        hasPdf: ref(true),
        isAnySaving: ref(false),
        isDjvuMode: ref(false),
        isSameAnnotationComment: (left, right) => left.stableKey === right.stableKey,
        markAnnotationDirty: vi.fn(),
        ocrPopupOpen: ref(false),
        ocr: {
            runOcrForAgent: vi.fn(async () => ({ok: true})),
            cancelOcrForAgent: vi.fn(async () => ({ok: true})),
            getAgentOcrSnapshot: vi.fn(() => ({})),
        },
        openConvertDialog: vi.fn(),
        originalPath: ref<TDocumentRef | null>(null),
        pageLabelRanges,
        pageLabels: ref<string[] | null>(null),
        pageLabelsDirty: ref(false),
        pageOpsDelete: vi.fn(async () => true),
        pageOpsExtract: vi.fn(async () => true),
        pageOpsInsert: vi.fn(async () => true),
        handleCropPages: vi.fn(async () => true),
        handleRemoveCrop: vi.fn(async () => true),
        pdfViewerRef: ref<IWorkspacePdfViewerAgentPort | null>(null),
        selectedThumbnailPages: ref([]),
        showConvertDialog: ref(false),
        showSidebar,
        sidebarTab,
        sortedAnnotationNoteWindows: ref<IAnnotationNoteWindowViewModel[]>([]),
        t: () => 'Untitled',
        tabId: 'tab-1',
        totalPages: ref(3),
        updateAnnotationNoteText: vi.fn(),
        viewMode: ref<TPdfViewMode>('single'),
        viewerCapabilities: ref(createDefaultWorkspaceViewerCapabilities()),
        waitForDocumentOpenSettled: vi.fn(async () => undefined),
        whenDraftsCommitted: vi.fn(async () => undefined),
        workingCopyPath: ref<TDocumentRef | null>(null),
        zoom: ref(1),
        ...overrides,
    };
}
