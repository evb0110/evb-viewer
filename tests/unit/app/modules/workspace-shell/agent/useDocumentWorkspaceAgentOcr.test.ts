import {ref} from 'vue';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type {TDocumentRef} from '@contracts/documentRef';
import type {IDocumentRevisionInfo} from '@contracts/documentRevision';
import type {TPdfViewMode} from '@contracts/shared';
import type {
    IAnnotationCommentSummary,
    IAnnotationInventoryCompleteness,
    TAnnotationCommentsStatus,
    TAnnotationTool,
} from '@app/types/annotations';
import type {IPdfBookmarkEntry} from '@app/types/pdfContracts';
import type {IAnnotationNoteWindowViewModel} from '@app/types/annotationNoteWindow';
import type {IWorkspacePdfViewerAgentPort} from '@app/modules/workspace-shell/types/workspaceOrchestration.types';
import {useDocumentWorkspaceAgent} from '@app/modules/workspace-shell/agent/useDocumentWorkspaceAgent';
import type {
    IUseDocumentWorkspaceAgentOptions,
    TWorkspaceAgentFitMode,
} from '@app/modules/workspace-shell/agent/documentWorkspaceAgentTypes';
import {createDefaultWorkspaceViewerCapabilities} from '@app/types/workspaceExpose';

function createAgentOptions(
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
        handlePageRotate: vi.fn(async () => undefined),
        handlePrint: vi.fn(),
        handlePrintCurrentPage: vi.fn(async () => undefined),
        handleQuickNoteAction: vi.fn(async () => undefined),
        handleSave: vi.fn(async () => true),
        handleSaveAs: vi.fn(async () => undefined),
        handleZoomIn: vi.fn(),
        handleZoomOut: vi.fn(),
        hasPdf: ref(true),
        isAnySaving: ref(false),
        isDjvuMode: ref(false),
        isSameAnnotationComment: (left, right) => left.stableKey === right.stableKey,
        markAnnotationDirty: vi.fn(),
        ocrPopupOpen: ref(false),
        ocrPopupRef: ref(null),
        openConvertDialog: vi.fn(),
        originalPath: ref<TDocumentRef | null>(null),
        pageLabelRanges,
        pageLabels: ref<string[] | null>(null),
        pageLabelsDirty: ref(false),
        pageOpsDelete: vi.fn(async () => undefined),
        pageOpsExtract: vi.fn(async () => undefined),
        pageOpsInsert: vi.fn(async () => undefined),
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
        workingCopyPath: ref<TDocumentRef | null>(null),
        zoom: ref(1),
        ...overrides,
    };
}

describe('useDocumentWorkspaceAgent', () => {
    it('passes OCR quality profile through the OCR start action', async () => {
        const runOcrForAgent = vi.fn(async () => ({ok: true}));
        const handleDropdownOpen = vi.fn();
        const ocrPopupRef = ref({
            runOcrForAgent,
            cancelOcrForAgent: vi.fn(async () => ({ok: true})),
            getAgentOcrSnapshot: vi.fn(() => ({})),
        });
        const agent = useDocumentWorkspaceAgent(createAgentOptions({
            handleDropdownOpen,
            ocrPopupRef,
        }));

        await expect(agent.runAgentAction('ocr.start', {
            pageRange: 'all',
            languages: [
                'eng',
                'eng',
                'rus',
            ],
            qualityProfile: 'poor-scan',
            preprocessingMode: 'clean',
            pageSegmentationMode: 11,
            supersessionPolicy: 'replace-all',
            replaceAllAcknowledged: true,
        })).resolves.toMatchObject({
            ok: true,
            actionId: 'ocr.start',
            tabId: 'tab-1',
        });

        expect(handleDropdownOpen).toHaveBeenCalledWith('ocr', true);
        expect(runOcrForAgent).toHaveBeenCalledWith({
            pageRange: 'all',
            languages: [
                'eng',
                'rus',
            ],
            qualityProfile: 'poor-scan',
            preprocessingMode: 'clean',
            pageSegmentationMode: 11,
            supersessionPolicy: 'replace-all',
            replaceAllAcknowledged: true,
            open: true,
        });
    });

    it('keeps a contract-requested OCR run in the background', async () => {
        const runOcrForAgent = vi.fn(async () => ({ok: true}));
        const handleDropdownOpen = vi.fn();
        const agent = useDocumentWorkspaceAgent(createAgentOptions({
            handleDropdownOpen,
            ocrPopupRef: ref({
                runOcrForAgent,
                cancelOcrForAgent: vi.fn(async () => ({ok: true})),
                getAgentOcrSnapshot: vi.fn(() => ({})),
            }),
        }));

        await agent.runAgentAction('ocr.start', {
            languages: ['eng'],
            open: false,
        });

        expect(handleDropdownOpen).not.toHaveBeenCalled();
        expect(runOcrForAgent).toHaveBeenCalledWith({
            languages: ['eng'],
            open: false,
        });
    });

    it('drops invalid OCR tuning inputs before invoking the popup', async () => {
        const runOcrForAgent = vi.fn(async () => ({ok: true}));
        const ocrPopupRef = ref({
            runOcrForAgent,
            cancelOcrForAgent: vi.fn(async () => ({ok: true})),
            getAgentOcrSnapshot: vi.fn(() => ({})),
        });
        const agent = useDocumentWorkspaceAgent(createAgentOptions({ocrPopupRef}));

        await agent.runAgentAction('ocr.start', {
            qualityProfile: 'stock',
            preprocessingMode: 'maybe',
            pageSegmentationMode: 42,
            selectedLanguages: ['rus'],
        });

        expect(runOcrForAgent).toHaveBeenCalledWith({open: true});
    });

    it('reports a structured failure when OCR is not mounted', async () => {
        const agent = useDocumentWorkspaceAgent(createAgentOptions());

        await expect(agent.runAgentAction('ocr.start', {languages: ['eng']})).resolves.toMatchObject({
            ok: false,
            error: 'OCR popup is not mounted.',
            actionId: 'ocr.start',
            tabId: 'tab-1',
        });
    });

    it('awaits OCR cancel results from the popup', async () => {
        const cancelOcrForAgent = vi.fn(async () => ({
            ok: false,
            cancel: {
                canceled: false,
                reason: 'not-found',
            },
        }));
        const ocrPopupRef = ref({
            runOcrForAgent: vi.fn(async () => ({ok: true})),
            cancelOcrForAgent,
            getAgentOcrSnapshot: vi.fn(() => ({})),
        });
        const agent = useDocumentWorkspaceAgent(createAgentOptions({ocrPopupRef}));

        await expect(agent.runAgentAction('ocr.cancel', {})).resolves.toMatchObject({
            ok: false,
            cancel: {
                canceled: false,
                reason: 'not-found',
            },
            actionId: 'ocr.cancel',
            tabId: 'tab-1',
        });
        expect(cancelOcrForAgent).toHaveBeenCalledTimes(1);
    });
});
