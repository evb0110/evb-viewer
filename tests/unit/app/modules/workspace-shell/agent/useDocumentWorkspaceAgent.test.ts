import { ref } from 'vue';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { TDocumentRef } from '@contracts/documentRef';
import type { IDocumentRevisionInfo } from '@contracts/documentRevision';
import type { IPdfPageLabelRange } from '@contracts/pdfPageLabels';
import type { TPdfViewMode } from '@contracts/shared';
import { createRangePageSelection } from '@contracts/pageNumbers';
import { AGENT_CAPABILITY_TEMPLATES } from '@electron/features/agent/mcp/agentCapabilityTemplates';
import { validateJsonObjectAgainstSchema } from '@electron/features/agent/mcp/mcpToolDefinitions';
import type {
    IAnnotationCommentSummary,
    IAnnotationInventoryCompleteness,
    TAnnotationCommentsStatus,
    TAnnotationTool,
} from '@app/types/annotations';
import type { IPdfBookmarkEntry } from '@app/types/pdfContracts';
import type { IAnnotationNoteWindowViewModel } from '@app/types/annotationNoteWindow';
import type { IWorkspacePdfViewerAgentPort } from '@app/modules/workspace-shell/types/workspaceOrchestration.types';
import {
    DOCUMENT_WORKSPACE_AGENT_ACTION_IDS,
    DOCUMENT_WORKSPACE_AGENT_ALIAS_ACTION_IDS,
    DOCUMENT_WORKSPACE_AGENT_PRIMARY_ACTION_IDS,
    useDocumentWorkspaceAgent,
} from '@app/modules/workspace-shell/agent/useDocumentWorkspaceAgent';
import type {
    IUseDocumentWorkspaceAgentOptions,
    TWorkspaceAgentFitMode,
} from '@app/modules/workspace-shell/agent/documentWorkspaceAgentTypes';
import { createDefaultWorkspaceViewerCapabilities } from '@app/types/workspaceExpose';
import { createPageLabelModel } from '@app/utils/document-viewer/pageLabels';
import { cast } from '@tests/helpers/cast';
import {
    requireDocumentInstanceId,
    requireDocumentRevisionToken,
} from '@contracts';

const COMMAND_ONLY_CAPABILITY_IDS = new Set([
    'workspace.snapshot',
    'document.open_documents',
    'document.readiness',
    'document.inspect_text',
    'document.search',
    'document.read_pages',
    'annotation.list',
    'annotation.list_notes',
    'view.activate_tab',
    'view.go_to_page',
]);

function sortIds(ids: readonly string[]) {
    return [...ids].sort((left, right) => left.localeCompare(right));
}

function createBookmark(title: string, items: IPdfBookmarkEntry[] = []): IPdfBookmarkEntry {
    return {
        title,
        pageIndex: null,
        namedDest: null,
        bold: false,
        italic: false,
        color: null,
        items,
    };
}

function createAnnotationComment(
    overrides: Partial<IAnnotationCommentSummary> = {},
): IAnnotationCommentSummary {
    return {
        id: 'annotation-1',
        stableKey: 'ann:0:annotation-stable-1',
        pageIndex: 0,
        pageNumber: 1,
        text: '',
        kindLabel: 'Highlight',
        subtype: 'Highlight',
        author: null,
        modifiedAt: null,
        color: '#ffff00',
        uid: null,
        annotationId: 'annotation-1',
        source: 'pdf',
        hasNote: false,
        ...overrides,
    };
}

function createDocumentIdentity(
    token = 'revision-1',
    contentRevision = 1,
): IDocumentRevisionInfo {
    return {
        version: 1,
        token: requireDocumentRevisionToken(token),
        documentRef: '/tmp/document.pdf',
        authority: 'browser-document-store',
        contentRevision,
        mintedAt: contentRevision,
    };
}

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
        closeShapeProperties: vi.fn(),
        closeTextMarkupProperties: vi.fn(),
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
    it('keeps primary renderer action handlers aligned with advertised capabilities', () => {
        const advertisedRendererActionIds = AGENT_CAPABILITY_TEMPLATES
            .map(template => template.id)
            .filter(id => !COMMAND_ONLY_CAPABILITY_IDS.has(id));

        expect(sortIds(DOCUMENT_WORKSPACE_AGENT_PRIMARY_ACTION_IDS)).toEqual(
            sortIds(advertisedRendererActionIds),
        );
    });

    it('keeps compatibility aliases separate from public primary capability ids', () => {
        const primaryIds = new Set<string>(DOCUMENT_WORKSPACE_AGENT_PRIMARY_ACTION_IDS);

        expect(new Set(DOCUMENT_WORKSPACE_AGENT_ACTION_IDS).size).toBe(DOCUMENT_WORKSPACE_AGENT_ACTION_IDS.length);
        expect(DOCUMENT_WORKSPACE_AGENT_ALIAS_ACTION_IDS.every(id => !primaryIds.has(id))).toBe(true);
    });

    it('validates action id and required input before reporting a dry-run would run', async () => {
        const showSidebar = ref(false);
        const sidebarTab = ref<'annotations' | 'bookmarks' | 'thumbnails' | 'search'>('annotations');
        const agent = useDocumentWorkspaceAgent(createAgentOptions({
            showSidebar,
            sidebarTab,
        }));

        await expect(agent.runAgentAction('missing.action', {}, {dryRun: true}))
            .rejects.toThrow('Unsupported EVB agent action: missing.action');
        await expect(agent.runAgentAction('ui.open_sidebar_tab', {tab: 'layers'}, {dryRun: true}))
            .rejects.toThrow('ui.open_sidebar_tab requires input.tab');
        await expect(agent.runAgentAction('view.set_mode', {mode: 'scroll'}, {dryRun: true}))
            .rejects.toThrow('view.set_mode requires input.mode');
        await expect(agent.runAgentAction('annotation.create_note_at_point', {}, {dryRun: true}))
            .rejects.toThrow('annotation.create_note_at_point requires input.pageX and input.pageY');
        await expect(agent.runAgentAction('page_labels.apply_range', {}, {dryRun: true}))
            .rejects.toThrow('page_labels.apply_range requires a valid one-based page number');
        await expect(agent.runAgentAction('bookmarks.add_batch', {}, {dryRun: true}))
            .rejects.toThrow('bookmarks.add_batch requires input.bookmarks or input.items');
        await expect(agent.runAgentAction('bookmarks.delete_batch', {}, {dryRun: true}))
            .rejects.toThrow('bookmarks.delete_batch requires input.paths, input.items with path, or input.path');

        await expect(agent.runAgentAction('ui.open_sidebar_tab', {tab: 'bookmarks'}, {dryRun: true}))
            .resolves.toMatchObject({
                ok: true,
                actionId: 'ui.open_sidebar_tab',
                dryRun: true,
                wouldRun: true,
            });
        expect(showSidebar.value).toBe(false);
        expect(sidebarTab.value).toBe('annotations');
    });

    it('does not create phantom view state when the active viewer lacks a capability', async () => {
        const continuousScroll = ref(false);
        const viewMode = ref<TPdfViewMode>('single');
        const agent = useDocumentWorkspaceAgent(createAgentOptions({
            continuousScroll,
            viewMode,
            viewerCapabilities: ref(createDefaultWorkspaceViewerCapabilities()),
        }));

        await expect(agent.runAgentAction('view.toggle_continuous_scroll')).resolves.toMatchObject({
            ok: false,
            unsupported: true,
            capability: 'continuousScroll',
        });
        await expect(agent.runAgentAction('view.set_mode', {mode: 'facing'})).resolves.toMatchObject({
            ok: false,
            unsupported: true,
            capability: 'viewMode',
        });
        expect(continuousScroll.value).toBe(false);
        expect(viewMode.value).toBe('single');
    });

    it('aborts action execution when the command signal is already aborted', async () => {
        const abortController = new AbortController();
        abortController.abort();
        const assertCurrentDocument = vi.fn();
        const agent = useDocumentWorkspaceAgent(createAgentOptions());

        await expect(agent.runAgentAction('ui.open_sidebar_tab', {tab: 'bookmarks'}, {}, {
            signal: abortController.signal,
            documentIdentity: null,
            documentInstanceId: null,
            assertCurrentDocument,
        })).rejects.toThrow('Agent command was aborted.');
        expect(assertCurrentDocument).not.toHaveBeenCalled();
    });

    it('aborts mutating bookmark actions when document identity changes after awaited settling', async () => {
        const firstIdentity = createDocumentIdentity('revision-1', 1);
        const documentIdentity = ref<IDocumentRevisionInfo | null>(firstIdentity);
        const handleBookmarksChange = vi.fn();
        const waitForDocumentOpenSettled = vi.fn(async () => {
            documentIdentity.value = createDocumentIdentity('revision-2', 2);
        });
        const agent = useDocumentWorkspaceAgent(createAgentOptions({
            documentIdentity,
            handleBookmarksChange,
            waitForDocumentOpenSettled,
        }));

        await expect(agent.runAgentAction('bookmarks.apply_plan', {entries: [{
            level: 1,
            title: 'Chapter',
            page: 1,
        }]}, {}, {
            signal: new AbortController().signal,
            documentIdentity: firstIdentity,
            documentInstanceId: requireDocumentInstanceId('instance-a'),
            assertCurrentDocument: vi.fn(),
        })).rejects.toThrow('Agent command target document changed.');
        expect(waitForDocumentOpenSettled).toHaveBeenCalledOnce();
        expect(handleBookmarksChange).not.toHaveBeenCalled();
    });

    it('preserves execution semantics for a representative handler', async () => {
        const showSidebar = ref(false);
        const sidebarTab = ref<'annotations' | 'bookmarks' | 'thumbnails' | 'search'>('annotations');
        const agent = useDocumentWorkspaceAgent(createAgentOptions({
            showSidebar,
            sidebarTab,
        }));

        await expect(agent.runAgentAction('ui.open_sidebar_tab', {sidebarTab: 'bookmarks'}))
            .resolves.toMatchObject({
                ok: true,
                actionId: 'ui.open_sidebar_tab',
                tabId: 'tab-1',
                currentPage: 1,
                totalPages: 3,
                showSidebar: true,
                sidebarTab: 'bookmarks',
            });
        expect(showSidebar.value).toBe(true);
        expect(sidebarTab.value).toBe('bookmarks');
    });

    it('returns structured-cloneable page-label mutation results', async () => {
        const agent = useDocumentWorkspaceAgent(createAgentOptions());

        const result = await agent.runAgentAction('page_labels.apply_plan', {ranges: [{
            startPage: 1,
            style: 'D',
            prefix: '',
            startNumber: 3,
        }]});

        expect(() => structuredClone(result)).not.toThrow();
        expect(result).toMatchObject({
            ok: true,
            actionId: 'page_labels.apply_plan',
            summary: {
                firstLabel: '3',
                lastLabel: '5',
            },
        });
    });

    it('reports when page-label metadata is missing from the viewer controls', async () => {
        const agent = useDocumentWorkspaceAgent(createAgentOptions({
            pageLabelRanges: ref([
                {
                    startPage: 1,
                    style: null,
                    prefix: 'Cover',
                    startNumber: 1,
                },
                {
                    startPage: 2,
                    style: 'D',
                    prefix: '',
                    startNumber: 1,
                },
            ]),
            pageLabels: ref(null),
        }));

        await expect(agent.runAgentAction('page_labels.read', {})).resolves.toMatchObject({
            viewerState: {
                displayMode: 'physical-pages',
                expectedDisplayMode: 'pdf-labels',
                labelsMaterialized: false,
                matchesMetadata: false,
            },
            issues: expect.arrayContaining([expect.objectContaining({code: 'viewer_page_labels_out_of_sync'})]),
        });
    });

    it('reports the compact page-label lookup used by the viewer controls', async () => {
        const ranges: IPdfPageLabelRange[] = [
            {
                startPage: 1,
                style: null,
                prefix: 'Cover',
                startNumber: 1,
            },
            {
                startPage: 2,
                style: 'D',
                prefix: '',
                startNumber: 1,
            },
            {
                startPage: 273,
                style: null,
                prefix: 'Back Cover',
                startNumber: 1,
            },
        ];
        const agent = useDocumentWorkspaceAgent(createAgentOptions({
            pageLabelRanges: ref(ranges),
            pageLabelModel: ref(createPageLabelModel(273, ranges)),
            pageLabels: ref(null),
            totalPages: ref(273),
        }));

        await expect(agent.runAgentAction('page_labels.read', {})).resolves.toMatchObject({
            viewerState: {
                displayMode: 'pdf-labels',
                expectedDisplayMode: 'pdf-labels',
                labelsMaterialized: false,
                matchesMetadata: true,
                lookup: 'range-model',
                resolved: true,
            },
            samples: expect.arrayContaining([
                {
                    page: 1,
                    label: 'Cover',
                },
                {
                    page: 272,
                    label: '271',
                },
                {
                    page: 273,
                    label: 'Back Cover',
                },
            ]),
            issues: expect.not.arrayContaining([expect.objectContaining({code: 'viewer_page_labels_out_of_sync'})]),
        });
    });

    it('reports a stale compact viewer lookup when metadata changes without changing page count', async () => {
        const oldRanges: IPdfPageLabelRange[] = [{
            startPage: 1,
            style: 'D',
            prefix: '',
            startNumber: 1,
        }];
        const currentRanges: IPdfPageLabelRange[] = [
            {
                startPage: 1,
                style: null,
                prefix: 'Cover',
                startNumber: 1,
            },
            {
                startPage: 2,
                style: 'D',
                prefix: '',
                startNumber: 1,
            },
        ];
        const agent = useDocumentWorkspaceAgent(createAgentOptions({
            pageLabelRanges: ref(currentRanges),
            pageLabelModel: ref(createPageLabelModel(273, oldRanges)),
            pageLabels: ref(null),
            totalPages: ref(273),
        }));

        await expect(agent.runAgentAction('page_labels.read', {})).resolves.toMatchObject({
            viewerState: {
                displayMode: 'pdf-labels',
                expectedDisplayMode: 'pdf-labels',
                matchesMetadata: false,
                lookup: 'range-model',
                resolved: true,
            },
            samples: expect.arrayContaining([
                {
                    page: 1,
                    label: 'Cover',
                },
                {
                    page: 273,
                    label: '272',
                },
            ]),
            issues: expect.arrayContaining([expect.objectContaining({code: 'viewer_page_labels_out_of_sync'})]),
        });
    });

    it('includes the current viewer lookup state in a page-label preview', async () => {
        const ranges: IPdfPageLabelRange[] = [
            {
                startPage: 1,
                style: null,
                prefix: 'Cover',
                startNumber: 1,
            },
            {
                startPage: 2,
                style: 'D',
                prefix: '',
                startNumber: 1,
            },
        ];
        const agent = useDocumentWorkspaceAgent(createAgentOptions({
            pageLabelRanges: ref(ranges),
            pageLabelModel: ref(createPageLabelModel(3, ranges)),
            pageLabels: ref(null),
        }));

        await expect(agent.runAgentAction('page_labels.preview', {ranges})).resolves.toMatchObject({currentViewerState: {
            displayMode: 'pdf-labels',
            matchesMetadata: true,
            lookup: 'range-model',
            resolved: true,
        }});
    });

    it('waits for document open to settle before validating bookmark plan page numbers', async () => {
        const totalPages = ref(0);
        const waitForDocumentOpenSettled = vi.fn(async () => {
            totalPages.value = 3;
        });
        const handleBookmarksChange = vi.fn(({bookmarks}) => {
            bookmarkItems.value = bookmarks;
        });
        const bookmarkItems = ref<IPdfBookmarkEntry[]>([]);
        const agent = useDocumentWorkspaceAgent(createAgentOptions({
            bookmarkItems,
            handleBookmarksChange,
            totalPages,
            waitForDocumentOpenSettled,
        }));

        await expect(agent.runAgentAction('bookmarks.apply_plan', {entries: [{
            level: 1,
            title: 'Chapter',
            page: 3,
        }]})).resolves.toMatchObject({
            ok: true,
            actionId: 'bookmarks.apply_plan',
            bookmarks: [expect.objectContaining({title: 'Chapter'})],
        });
        expect(waitForDocumentOpenSettled).toHaveBeenCalledOnce();
        expect(handleBookmarksChange).toHaveBeenCalledOnce();
        expect(handleBookmarksChange).toHaveBeenCalledWith(expect.objectContaining({
            dirty: true,
            history: 'record',
        }));
    });

    it('adds nested bookmarks with children aliases and pageYRatio anchors', async () => {
        const bookmarkItems = ref<IPdfBookmarkEntry[]>([createBookmark('Lesson 5')]);
        const handleBookmarksChange = vi.fn(({bookmarks}) => {
            bookmarkItems.value = bookmarks;
        });
        const agent = useDocumentWorkspaceAgent(createAgentOptions({
            bookmarkItems,
            handleBookmarksChange,
            totalPages: ref(20),
        }));

        await expect(agent.runAgentAction('bookmarks.add', {
            parentPath: [0],
            title: '10 Adjectival Pattern',
            page: 12,
            pageYRatio: 0.4,
            children: [{
                title: '10a Note',
                page: 12,
                pageYRatio: 0.7,
            }],
        })).resolves.toMatchObject({
            ok: true,
            actionId: 'bookmarks.add',
        });

        expect(bookmarkItems.value[0]?.items[0]).toMatchObject({
            title: '10 Adjectival Pattern',
            pageIndex: 11,
            pageYRatio: 0.4,
            items: [expect.objectContaining({
                title: '10a Note',
                pageIndex: 11,
                pageYRatio: 0.7,
            })],
        });
    });

    it('adds child bookmarks on the parent page when pageYRatio anchors distinguish them', async () => {
        const bookmarkItems = ref<IPdfBookmarkEntry[]>([{
            ...createBookmark('Lesson 5'),
            pageIndex: 9,
        }]);
        const handleBookmarksChange = vi.fn(({bookmarks}) => {
            bookmarkItems.value = bookmarks;
        });
        const agent = useDocumentWorkspaceAgent(createAgentOptions({
            bookmarkItems,
            handleBookmarksChange,
            totalPages: ref(20),
        }));

        await expect(agent.runAgentAction('bookmarks.add_batch', {
            parentPath: [0],
            bookmarks: [
                {
                    title: '10 Paragraph',
                    page: 10,
                    pageYRatio: 0.2,
                },
                {
                    title: '11 Paragraph',
                    page: 10,
                    pageYRatio: 0.6,
                },
            ],
        })).resolves.toMatchObject({
            ok: true,
            actionId: 'bookmarks.add_batch',
        });

        expect(bookmarkItems.value[0]?.items).toEqual([
            expect.objectContaining({
                title: '10 Paragraph',
                pageIndex: 9,
                pageYRatio: 0.2,
            }),
            expect.objectContaining({
                title: '11 Paragraph',
                pageIndex: 9,
                pageYRatio: 0.6,
            }),
        ]);
    });

    it('refuses newly unsafe child bookmarks that all reuse the parent destination', async () => {
        const bookmarkItems = ref<IPdfBookmarkEntry[]>([{
            ...createBookmark('Lesson 5'),
            pageIndex: 9,
        }]);
        const handleBookmarksChange = vi.fn(({bookmarks}) => {
            bookmarkItems.value = bookmarks;
        });
        const agent = useDocumentWorkspaceAgent(createAgentOptions({
            bookmarkItems,
            handleBookmarksChange,
            totalPages: ref(20),
        }));

        await expect(agent.runAgentAction('bookmarks.add_batch', {
            parentPath: [0],
            allowSamePageChildDestinations: true,
            bookmarks: [
                {
                    title: '10 Paragraph',
                    page: 10,
                },
                {
                    title: '11 Paragraph',
                    page: 10,
                },
            ],
        })).rejects.toThrow('refused to apply unsafe bookmark destinations');

        expect(handleBookmarksChange).not.toHaveBeenCalled();
    });

    it('deletes multiple bookmarks through the batch agent action', async () => {
        const bookmarkItems = ref<IPdfBookmarkEntry[]>([
            createBookmark('Chapter 1', [createBookmark('Section 1.1')]),
            createBookmark('Chapter 2'),
            createBookmark('Chapter 3'),
        ]);
        const handleBookmarksChange = vi.fn(({bookmarks}) => {
            bookmarkItems.value = bookmarks;
        });
        const agent = useDocumentWorkspaceAgent(createAgentOptions({
            bookmarkItems,
            handleBookmarksChange,
        }));

        await expect(agent.runAgentAction('bookmarks.delete_batch', {paths: [
            [0],
            [
                0,
                0,
            ],
            [2],
        ]})).resolves.toMatchObject({
            ok: true,
            actionId: 'bookmarks.delete_batch',
            bookmarks: [expect.objectContaining({title: 'Chapter 2'})],
        });

        expect(bookmarkItems.value).toEqual([createBookmark('Chapter 2')]);
        expect(handleBookmarksChange).toHaveBeenCalledOnce();
        expect(handleBookmarksChange).toHaveBeenCalledWith(expect.objectContaining({
            dirty: true,
            history: 'record',
        }));
    });

    it('styles explicit bookmarks with bold and color while leaving other fields untouched', async () => {
        const bookmarkItems = ref<IPdfBookmarkEntry[]>([
            createBookmark('Chapter 1'),
            createBookmark('Chapter 2'),
            createBookmark('Chapter 3'),
        ]);
        const handleBookmarksChange = vi.fn(({bookmarks}) => {
            bookmarkItems.value = bookmarks;
        });
        const agent = useDocumentWorkspaceAgent(createAgentOptions({
            bookmarkItems,
            handleBookmarksChange,
        }));

        await expect(agent.runAgentAction('bookmarks.set_style', {
            paths: [
                [0],
                [2],
            ],
            bold: true,
            color: '#336699',
        })).resolves.toMatchObject({
            ok: true,
            actionId: 'bookmarks.set_style',
            targetCount: 2,
            changedCount: 2,
            targetPaths: [
                [0],
                [2],
            ],
            targetPathsTruncated: false,
        });

        expect(bookmarkItems.value[0]).toMatchObject({
            title: 'Chapter 1',
            bold: true,
            italic: false,
            color: '#336699',
        });
        expect(bookmarkItems.value[2]).toMatchObject({
            title: 'Chapter 3',
            bold: true,
            color: '#336699',
        });
        expect(handleBookmarksChange).toHaveBeenCalledOnce();
        expect(handleBookmarksChange).toHaveBeenCalledWith(expect.objectContaining({
            dirty: true,
            history: 'record',
        }));
    });

    it('styles an inclusive sibling range regardless of endpoint order', async () => {
        const bookmarkItems = ref<IPdfBookmarkEntry[]>([
            createBookmark('Chapter 1', [createBookmark('Section 1.1')]),
            createBookmark('Chapter 2'),
            createBookmark('Chapter 3'),
        ]);
        const handleBookmarksChange = vi.fn(({bookmarks}) => {
            bookmarkItems.value = bookmarks;
        });
        const agent = useDocumentWorkspaceAgent(createAgentOptions({
            bookmarkItems,
            handleBookmarksChange,
        }));

        await expect(agent.runAgentAction('bookmarks.set_style', {
            range: {
                from: [2],
                to: [0],
            },
            italic: true,
        })).resolves.toMatchObject({
            ok: true,
            actionId: 'bookmarks.set_style',
            targetCount: 3,
            changedCount: 3,
        });

        expect(bookmarkItems.value.map(bookmark => bookmark.italic)).toEqual([
            true,
            true,
            true,
        ]);
        expect(bookmarkItems.value[0]?.items.every(child => !child.italic)).toBe(true);
    });

    it('styles depth-selected bookmarks under a parent scope and levels across roots', async () => {
        const bookmarkItems = ref<IPdfBookmarkEntry[]>([
            createBookmark('Chapter 1', [
                createBookmark('Section 1.1'),
                createBookmark('Section 1.2'),
            ]),
            createBookmark('Chapter 2'),
        ]);
        const handleBookmarksChange = vi.fn(({bookmarks}) => {
            bookmarkItems.value = bookmarks;
        });
        const agent = useDocumentWorkspaceAgent(createAgentOptions({
            bookmarkItems,
            handleBookmarksChange,
        }));

        await expect(agent.runAgentAction('bookmarks.set_style', {
            depth: 1,
            parentPath: [0],
            italic: true,
        })).resolves.toMatchObject({
            ok: true,
            actionId: 'bookmarks.set_style',
            targetCount: 2,
            changedCount: 2,
            targetPaths: [
                [
                    0,
                    0,
                ],
                [
                    0,
                    1,
                ],
            ],
        });
        expect(bookmarkItems.value[0]?.items.map(child => child.italic)).toEqual([
            true,
            true,
        ]);
        expect(bookmarkItems.value.map(bookmark => bookmark.italic)).toEqual([
            false,
            false,
        ]);

        await expect(agent.runAgentAction('bookmarks.set_style', {
            level: 1,
            bold: true,
        })).resolves.toMatchObject({
            ok: true,
            actionId: 'bookmarks.set_style',
            targetCount: 2,
            changedCount: 2,
        });
        expect(bookmarkItems.value.map(bookmark => bookmark.bold)).toEqual([
            true,
            true,
        ]);
        expect(bookmarkItems.value[0]?.items.every(child => !child.bold)).toBe(true);
    });

    it('extends styling to descendants when includeDescendants is requested', async () => {
        const bookmarkItems = ref<IPdfBookmarkEntry[]>([
            createBookmark('Chapter 1', [createBookmark('Section 1.1', [createBookmark('Subsection 1.1.1')])]),
            createBookmark('Chapter 2'),
        ]);
        const handleBookmarksChange = vi.fn(({bookmarks}) => {
            bookmarkItems.value = bookmarks;
        });
        const agent = useDocumentWorkspaceAgent(createAgentOptions({
            bookmarkItems,
            handleBookmarksChange,
        }));

        await expect(agent.runAgentAction('bookmarks.set_style', {
            path: [0],
            includeDescendants: true,
            color: '#336699',
        })).resolves.toMatchObject({
            ok: true,
            actionId: 'bookmarks.set_style',
            targetCount: 3,
            changedCount: 3,
            targetPaths: [
                [0],
                [
                    0,
                    0,
                ],
                [
                    0,
                    0,
                    0,
                ],
            ],
        });

        expect(bookmarkItems.value[0]?.color).toBe('#336699');
        expect(bookmarkItems.value[0]?.items[0]?.color).toBe('#336699');
        expect(bookmarkItems.value[0]?.items[0]?.items[0]?.color).toBe('#336699');
        expect(bookmarkItems.value[1]?.color).toBeNull();
    });

    it('skips the undo entry when styling would not change any bookmark', async () => {
        const bookmarkItems = ref<IPdfBookmarkEntry[]>([{
            ...createBookmark('Chapter 1'),
            bold: true,
        }]);
        const handleBookmarksChange = vi.fn(({bookmarks}) => {
            bookmarkItems.value = bookmarks;
        });
        const agent = useDocumentWorkspaceAgent(createAgentOptions({
            bookmarkItems,
            handleBookmarksChange,
        }));

        await expect(agent.runAgentAction('bookmarks.set_style', {
            path: [0],
            bold: true,
        })).resolves.toMatchObject({
            ok: true,
            actionId: 'bookmarks.set_style',
            targetCount: 1,
            changedCount: 0,
        });

        expect(handleBookmarksChange).not.toHaveBeenCalled();
    });

    it('rejects invalid bookmarks.set_style inputs before touching bookmarks', async () => {
        const bookmarkItems = ref<IPdfBookmarkEntry[]>([
            createBookmark('Chapter 1', [createBookmark('Section 1.1')]),
            createBookmark('Chapter 2'),
        ]);
        const handleBookmarksChange = vi.fn(({bookmarks}) => {
            bookmarkItems.value = bookmarks;
        });
        const agent = useDocumentWorkspaceAgent(createAgentOptions({
            bookmarkItems,
            handleBookmarksChange,
        }));

        const initialBookmarks = JSON.parse(JSON.stringify(bookmarkItems.value)) as IPdfBookmarkEntry[];

        await expect(agent.runAgentAction('bookmarks.set_style', {bold: true}))
            .rejects.toThrow('bookmarks.set_style requires input.paths, input.path, input.items, input.range, input.depth, or input.level.');
        await expect(agent.runAgentAction('bookmarks.set_style', {
            path: [0],
            bold: 'yes',
        })).rejects.toThrow('bookmarks.set_style bold must be a boolean.');
        await expect(agent.runAgentAction('bookmarks.set_style', {
            path: [99],
            includeDescendants: true,
            bold: true,
        })).rejects.toThrow('bookmarks.set_style bookmark path was not found.');
        await expect(agent.runAgentAction('bookmarks.set_style', {paths: [[0]]}))
            .rejects.toThrow('bookmarks.set_style requires at least one of input.bold, input.italic, or input.color.');
        await expect(agent.runAgentAction('bookmarks.set_style', {
            range: {
                from: [0],
                to: [
                    0,
                    0,
                ],
            },
            bold: true,
        })).rejects.toThrow('bookmarks.set_style range endpoints must be siblings under the same parent.');
        await expect(agent.runAgentAction('bookmarks.set_style', {
            range: [0],
            bold: true,
        })).rejects.toThrow('bookmarks.set_style range requires from and to bookmark paths.');
        await expect(agent.runAgentAction('bookmarks.set_style', {
            range: {
                from: [
                    0,
                    0,
                ],
                to: [
                    0,
                    9,
                ],
            },
            bold: true,
        })).rejects.toThrow('bookmarks.set_style range endpoint [0,9] is outside its parent.');
        await expect(agent.runAgentAction('bookmarks.set_style', {
            depth: 4,
            bold: true,
        })).rejects.toThrow('bookmarks.set_style did not match any bookmarks.');
        await expect(agent.runAgentAction('bookmarks.set_style', {
            path: [7],
            bold: true,
        })).rejects.toThrow('bookmarks.set_style bookmark path was not found.');
        await expect(agent.runAgentAction('bookmarks.set_style', {
            path: [0],
            color: 'red',
        })).rejects.toThrow('bookmarks.set_style color must be a hex color such as #336699 or null.');
        await expect(agent.runAgentAction('bookmarks.set_style', {
            path: [0],
            color: 336699,
        })).rejects.toThrow('bookmarks.set_style color must be a hex color such as #336699 or null.');

        expect(bookmarkItems.value).toEqual(initialBookmarks);
        expect(handleBookmarksChange).not.toHaveBeenCalled();
    });

    it('restyles bookmarks through the toc.set_style compatibility alias', async () => {
        const bookmarkItems = ref<IPdfBookmarkEntry[]>([createBookmark('Chapter 1')]);
        const handleBookmarksChange = vi.fn(({bookmarks}) => {
            bookmarkItems.value = bookmarks;
        });
        const agent = useDocumentWorkspaceAgent(createAgentOptions({
            bookmarkItems,
            handleBookmarksChange,
        }));

        await expect(agent.runAgentAction('toc.set_style', {
            path: [0],
            italic: true,
        })).resolves.toMatchObject({
            ok: true,
            actionId: 'toc.set_style',
            targetCount: 1,
            changedCount: 1,
        });
        expect(bookmarkItems.value[0]?.italic).toBe(true);
    });

    it('enforces the advertised bookmarks.set_style schema on capability input', () => {
        const template = AGENT_CAPABILITY_TEMPLATES.find(candidate => candidate.id === 'bookmarks.set_style');

        expect(template).toBeDefined();
        expect(() => validateJsonObjectAgainstSchema(
            'bookmarks.set_style',
            {paths: [[0]]},
            template?.inputSchema ?? {},
        )).toThrow(/did not match its advertised schema/u);
        expect(() => validateJsonObjectAgainstSchema(
            'bookmarks.set_style',
            {
                depth: 0,
                bold: true,
            },
            template?.inputSchema ?? {},
        )).not.toThrow();
        expect(() => validateJsonObjectAgainstSchema(
            'bookmarks.set_style',
            {
                paths: [[-1]],
                bold: true,
            },
            template?.inputSchema ?? {},
        )).toThrow(/did not match its advertised schema/u);
        expect(() => validateJsonObjectAgainstSchema(
            'bookmarks.set_style',
            {
                path: [0.5],
                bold: true,
            },
            template?.inputSchema ?? {},
        )).toThrow(/did not match its advertised schema/u);
    });

    it('lets file.save observe save readiness after an immediate bookmark action', async () => {
        const bookmarkItems = ref<IPdfBookmarkEntry[]>([]);
        const bookmarksDirty = ref(false);
        const canSave = ref(false);
        const handleBookmarksChange = vi.fn(({
            bookmarks,
            dirty,
        }) => {
            bookmarkItems.value = bookmarks;
            bookmarksDirty.value = dirty;
            canSave.value = dirty;
        });
        const handleSave = vi.fn(async () => {
            expect(canSave.value).toBe(true);
            canSave.value = false;
            return true;
        });
        const agent = useDocumentWorkspaceAgent(createAgentOptions({
            bookmarkItems,
            bookmarksDirty,
            canSave,
            handleBookmarksChange,
            handleSave,
        }));

        await agent.runAgentAction('bookmarks.apply_plan', {entries: [{
            level: 1,
            title: 'Chapter',
            page: 1,
        }]});

        await expect(agent.runAgentAction('file.save')).resolves.toMatchObject({
            ok: true,
            actionId: 'file.save',
            saved: true,
            canSave: false,
        });
        expect(handleSave).toHaveBeenCalledOnce();
    });

    it('does not serialize the document when file.save has no pending changes', async () => {
        const handleSave = vi.fn(async () => true);
        const agent = useDocumentWorkspaceAgent(createAgentOptions({
            canSave: ref(false),
            handleSave,
            workingCopyPath: ref('/tmp/working.pdf'),
            originalPath: ref('/tmp/original.pdf'),
        }));

        await expect(agent.runAgentAction('file.save')).resolves.toMatchObject({
            ok: true,
            actionId: 'file.save',
            saved: false,
            canSave: false,
            workingCopyPath: '/tmp/working.pdf',
            originalPath: '/tmp/original.pdf',
        });
        expect(handleSave).not.toHaveBeenCalled();
    });

    it('reports new pending changes without treating an earlier successful save as failed', async () => {
        const canSave = ref(true);
        const handleSave = vi.fn(async () => true);
        const agent = useDocumentWorkspaceAgent(createAgentOptions({
            canSave,
            handleSave,
        }));

        await expect(agent.runAgentAction('file.save')).resolves.toMatchObject({
            ok: true,
            actionId: 'file.save',
            saved: true,
            canSave: true,
            pendingChangesAfterSave: true,
        });
        expect(handleSave).toHaveBeenCalledOnce();
    });

    it('runs repair-save and optimize-for-interaction through semantic file actions', async () => {
        const handleRepairSave = vi.fn(async () => true);
        const handleOptimizePdfForInteraction = vi.fn(async () => true);
        const agent = useDocumentWorkspaceAgent(createAgentOptions({
            handleRepairSave,
            handleOptimizePdfForInteraction,
            workingCopyPath: ref('/tmp/working.pdf'),
            originalPath: ref('/tmp/original.pdf'),
        }));

        await expect(agent.runAgentAction('file.repair_save')).resolves.toMatchObject({
            ok: true,
            actionId: 'file.repair_save',
            repaired: true,
            workingCopyPath: '/tmp/working.pdf',
            originalPath: '/tmp/original.pdf',
        });
        await expect(agent.runAgentAction('file.optimize_for_interaction')).resolves.toMatchObject({
            ok: true,
            actionId: 'file.optimize_for_interaction',
            optimized: true,
        });
        expect(handleRepairSave).toHaveBeenCalledOnce();
        expect(handleOptimizePdfForInteraction).toHaveBeenCalledOnce();
    });

    it('runs structured crop and remove-crop page operations', async () => {
        const handleCropPages = vi.fn(async () => true);
        const handleRemoveCrop = vi.fn(async () => true);
        const agent = useDocumentWorkspaceAgent(createAgentOptions({
            handleCropPages,
            handleRemoveCrop,
            totalPages: ref(4),
        }));

        await expect(agent.runAgentAction('page_ops.crop', {
            pages: [
                2,
                2,
                4,
            ],
            margins: {
                top: 12,
                right: 6,
                bottom: 8,
                left: 6,
            },
        })).resolves.toMatchObject({
            ok: true,
            actionId: 'page_ops.crop',
            pages: [
                2,
                4,
            ],
            margins: {
                top: 12,
                right: 6,
                bottom: 8,
                left: 6,
            },
            cropped: true,
        });
        await expect(agent.runAgentAction('page_ops.remove_crop', {pages: [4]})).resolves.toMatchObject({
            ok: true,
            actionId: 'page_ops.remove_crop',
            pages: [4],
            cropRemoved: true,
        });
        expect(handleCropPages).toHaveBeenCalledWith([
            2,
            4,
        ], {
            top: 12,
            right: 6,
            bottom: 8,
            left: 6,
        });
        expect(handleRemoveCrop).toHaveBeenCalledWith([4]);
    });

    it('guards history actions by undo and redo availability', async () => {
        const canUndo = ref(false);
        const canRedo = ref(true);
        const handleUndo = vi.fn(async () => undefined);
        const handleRedo = vi.fn(async () => {
            canUndo.value = true;
            canRedo.value = false;
        });
        const agent = useDocumentWorkspaceAgent(createAgentOptions({
            canUndo,
            canRedo,
            handleUndo,
            handleRedo,
        }));

        await expect(agent.runAgentAction('history.undo')).rejects.toThrow('Undo is not currently available.');
        await expect(agent.runAgentAction('history.redo')).resolves.toMatchObject({
            ok: true,
            actionId: 'history.redo',
            canUndo: true,
            canRedo: false,
        });
        expect(handleUndo).not.toHaveBeenCalled();
        expect(handleRedo).toHaveBeenCalledOnce();
    });

    it('routes assistant text-markup color edits through the undo-aware color updater', async () => {
        const comment = createAnnotationComment();
        const updateTextMarkupColorWithHistory = vi.fn(() => true);
        const rawViewerColorUpdate = vi.fn(() => true);
        const agent = useDocumentWorkspaceAgent(createAgentOptions({
            annotationComments: ref([comment]),
            updateTextMarkupColorWithHistory,
            pdfViewerRef: ref(cast<IWorkspacePdfViewerAgentPort>({updateTextMarkupAnnotationColor: rawViewerColorUpdate})),
        }));

        await expect(agent.runAgentAction('annotation.update_text_markup_color', {
            stableKey: comment.stableKey,
            color: '#00ff00',
        })).resolves.toMatchObject({
            ok: true,
            actionId: 'annotation.update_text_markup_color',
            updated: true,
            comment: expect.objectContaining({
                stableKey: comment.stableKey,
                color: '#00ff00',
                hasNote: false,
            }),
        });

        expect(updateTextMarkupColorWithHistory).toHaveBeenCalledWith(comment, '#00ff00');
        expect(rawViewerColorUpdate).not.toHaveBeenCalled();
    });

    it('propagates a failed text-markup creation with its typed reason', async () => {
        const createTextMarkupFromText = vi.fn(async () => ({
            created: false,
            pageNumber: 2,
            requestedText: 'chapter one',
            matchedText: 'chapter one',
            occurrence: 1,
            subtype: 'Highlight' as const,
            reason: 'The PDF viewer could not switch into the annotation editing mode.',
            failureReason: 'mode-switch-failed' as const,
            // The canonical annotation is already in the document; only its
            // editor is missing. The agent has to see that, or a caller
            // retrying on `created: false` mints a duplicate.
            pendingEditor: true,
        }));
        const agent = useDocumentWorkspaceAgent(createAgentOptions({pdfViewerRef: ref(
            cast<IWorkspacePdfViewerAgentPort>({createTextMarkupFromText}),
        )}));

        await expect(agent.runAgentAction('annotation.create_text_markup', {
            pageNumber: 2,
            text: 'chapter one',
        })).resolves.toMatchObject({
            ok: true,
            actionId: 'annotation.create_text_markup',
            created: false,
            failureReason: 'mode-switch-failed',
            pendingEditor: true,
        });
    });

    it('registers annotation history for assistant note text edits', async () => {
        const comment = createAnnotationComment({
            text: 'Original note',
            hasNote: true,
            kindLabel: 'Note',
            subtype: 'Text',
        });
        const historyCommands: Array<{
            cmd: () => void;
            undo: () => void;
        }> = [];
        const updateAnnotationComment = vi.fn(() => true);
        const registerAnnotationHistoryCommand = vi.fn((command: {
            cmd: () => void;
            undo: () => void;
        }) => {
            historyCommands.push(command);
        });
        const agent = useDocumentWorkspaceAgent(createAgentOptions({
            annotationComments: ref([comment]),
            pdfViewerRef: ref(cast<IWorkspacePdfViewerAgentPort>({
                updateAnnotationComment,
                registerAnnotationHistoryCommand,
            })),
        }));

        await expect(agent.runAgentAction('annotation.update_note', {
            stableKey: comment.stableKey,
            text: 'Updated note',
        })).resolves.toMatchObject({
            ok: true,
            actionId: 'annotation.update_note',
            updated: true,
            comment: expect.objectContaining({
                stableKey: comment.stableKey,
                text: 'Updated note',
                hasNote: true,
            }),
        });

        expect(updateAnnotationComment).toHaveBeenCalledWith(comment, 'Updated note');
        expect(registerAnnotationHistoryCommand).toHaveBeenCalledOnce();

        const command = historyCommands[0];
        if (!command) {
            throw new Error('Expected annotation history command to be registered');
        }

        command.undo();
        expect(updateAnnotationComment).toHaveBeenLastCalledWith(comment, 'Original note');

        command.cmd();
        expect(updateAnnotationComment).toHaveBeenLastCalledWith(expect.objectContaining({
            stableKey: comment.stableKey,
            text: 'Updated note',
        }), 'Updated note');
    });

    it('passes an exact compact selection to page-operation actions', async () => {
        const selection = createRangePageSelection(1_000_000, 2, 100_002);
        const pageOpsDelete = vi.fn(async () => undefined);
        const agent = useDocumentWorkspaceAgent(createAgentOptions({
            totalPages: ref(1_000_000),
            selectedThumbnailPages: ref([]),
            selectedPageSelection: ref(selection),
            pageOpsDelete,
        }));

        await expect(agent.runAgentAction('page_ops.delete_selected', {})).resolves.toMatchObject({
            selectedPageCount: 100_001,
            selectedPageSelection: selection,
        });
        expect(pageOpsDelete).toHaveBeenCalledWith(selection, 1_000_000);
    });

    it('blocks PDF page-operation actions in DjVu mode while keeping convert-to-PDF available', async () => {
        const selectedThumbnailPages = ref([
            1,
            2,
        ]);
        const showConvertDialog = ref(false);
        const pageOpsDelete = vi.fn(async () => undefined);
        const pageOpsExtract = vi.fn(async () => undefined);
        const pageOpsInsert = vi.fn(async () => undefined);
        const handlePageRotate = vi.fn(async () => undefined);
        const openConvertDialog = vi.fn(() => {
            showConvertDialog.value = true;
        });
        const agent = useDocumentWorkspaceAgent(createAgentOptions({
            handlePageRotate,
            isDjvuMode: ref(true),
            openConvertDialog,
            pageOpsDelete,
            pageOpsExtract,
            pageOpsInsert,
            selectedThumbnailPages,
            showConvertDialog,
        }));

        const blockedActions: Array<[string, Record<string, unknown>]> = [
            [
                'page_ops.delete_selected',
                {},
            ],
            [
                'page_ops.extract_selected',
                {},
            ],
            [
                'page_ops.rotate_cw_selected',
                {},
            ],
            [
                'page_ops.rotate_ccw_selected',
                {},
            ],
            [
                'page_ops.insert_pages',
                { afterPage: 2 },
            ],
            [
                'page_ops.crop',
                {
                    pages: [1],
                    margins: {
                        top: 1,
                        right: 1,
                        bottom: 1,
                        left: 1,
                    },
                },
            ],
            [
                'page_ops.remove_crop',
                { pages: [1] },
            ],
        ];

        for (const [
            actionId,
            input,
        ] of blockedActions) {
            await expect(agent.runAgentAction(actionId, input)).resolves.toMatchObject({
                ok: false,
                actionId,
                blocked: true,
                reason: 'djvu-page-operations-disabled',
                requiredAction: 'page_ops.convert_to_pdf',
            });
        }

        expect(pageOpsDelete).not.toHaveBeenCalled();
        expect(pageOpsExtract).not.toHaveBeenCalled();
        expect(pageOpsInsert).not.toHaveBeenCalled();
        expect(handlePageRotate).not.toHaveBeenCalled();

        await expect(agent.runAgentAction('page_ops.convert_to_pdf', {})).resolves.toMatchObject({
            ok: true,
            actionId: 'page_ops.convert_to_pdf',
            showConvertDialog: true,
        });
        expect(openConvertDialog).toHaveBeenCalledOnce();
    });

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
