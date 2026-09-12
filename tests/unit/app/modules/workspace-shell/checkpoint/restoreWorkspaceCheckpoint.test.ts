import { ref } from 'vue';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { requireDocumentRef } from '@contracts/documentRef';
import { requireDocumentInstanceId } from '@contracts/documentInstanceId';
import { requireDocumentRevisionToken } from '@contracts/documentRevision';
import { requireEpochMs } from '@contracts/timestamps';
import { requirePaneId } from '@contracts/editorPanes';
import { requireTabId } from '@contracts/windowTabs';
import type { ITab } from '@app/types/tabs';
import {
    createDefaultWorkspaceToolbarSnapshot,
    createDefaultWorkspaceViewerCapabilities,
    type IWorkspaceExpose,
} from '@app/types/workspaceExpose';
import {
    restoreWorkspaceCheckpoint,
    getRegisteredPdfOpenKind,
} from '@app/modules/workspace-shell/checkpoint/restoreWorkspaceCheckpoint';
import {getWorkspaceViewerAdapter} from '@app/modules/workspace-shell/viewers/workspaceViewerAdapters';
import {
    createWorkspaceAutomationStateSnapshot,
    createWorkspaceExposeFixture,
} from '@tests/unit/app/modules/workspace-shell/workspaceTestFixtures';

describe('restoreWorkspaceCheckpoint', () => {
    it('selects the registered PDF type independently of descriptor order', () => {
        const pdfAdapter = getWorkspaceViewerAdapter('pdf');

        expect(getRegisteredPdfOpenKind({
            documentTypes: [
                'image',
                'pdf',
            ],
            capabilities: pdfAdapter.capabilities,
        })).toBe('pdf');
    });

    it('reopens a working copy and restores the active page and zoom', async () => {
        const workspace = createWorkspaceExposeFixture({
            waitForDocumentOpenSettled: vi.fn().mockResolvedValue(undefined),
            restoreCanonicalAnnotationRecovery: vi.fn(),
            handleGoToPage: vi.fn(),
            setCustomZoomFromDisplay: vi.fn(),
            handleFitWidth: vi.fn(),
            handleFitHeight: vi.fn(),
            handleToggleContinuousScroll: vi.fn(),
            handleViewModeFacing: vi.fn(),
            setViewRotation: vi.fn(),
            getToolbarSnapshot: () => ({
                ...createDefaultWorkspaceToolbarSnapshot(),
                continuousScroll: true,
                viewerCapabilities: {
                    ...createDefaultWorkspaceViewerCapabilities(),
                    continuousScroll: true,
                    viewMode: true,
                    viewRotation: true,
                },
            }),
            getAutomationStateSnapshot: () => createWorkspaceAutomationStateSnapshot({
                originalPath: requireDocumentRef('/documents/draft.pdf'),
                workingCopyPath: requireDocumentRef('/tmp/working/draft.pdf'),
                documentIdentity: {
                    version: 1,
                    token: requireDocumentRevisionToken('revision-1'),
                    documentRef: requireDocumentRef('/tmp/working/draft.pdf'),
                    authority: 'electron-working-copy',
                    contentRevision: 1,
                    mintedAt: requireEpochMs(123),
                },
            }),
        });
        const tabs = ref<ITab[]>([{
            id: 'restored-tab',
            fileName: 'draft.pdf',
            originalPath: requireDocumentRef('/documents/draft.pdf'),
            documentInstanceId: requireDocumentInstanceId('document-1'),
            isDirty: true,
            isDjvu: false,
        }]);
        const workspaceRefs = ref(new Map([[
            'restored-tab',
            workspace,
        ]]));
        const restoreGraph = vi.fn();
        const restoreSurfaceMode = vi.fn();
        const order: string[] = [];
        restoreGraph.mockImplementation(() => order.push('graph'));
        restoreSurfaceMode.mockImplementation(() => order.push('surface'));
        const openPathInReservedTab = vi.fn(async () => {
            order.push('open');
            return true;
        });
        const activateTab = vi.fn();

        await restoreWorkspaceCheckpoint({
            version: 1,
            capturedAt: requireEpochMs(123),
            activePaneId: requirePaneId('pane-1'),
            activeTabId: requireTabId('old-tab'),
            layout: {
                type: 'leaf',
                paneId: requirePaneId('pane-1'),
            },
            panes: [{
                paneId: requirePaneId('pane-1'),
                tabIds: [requireTabId('old-tab')],
                activeTabId: requireTabId('old-tab'),
            }],
            tabs: [{
                tabId: requireTabId('old-tab'),
                paneId: requirePaneId('pane-1'),
                fileName: 'draft.pdf',
                sourceRef: requireDocumentRef('/documents/draft.pdf'),
                workingCopyRef: requireDocumentRef('/tmp/working/draft.pdf'),
                isDirty: true,
                isDjvu: false,
                currentPage: 9,
                zoom: 1.4,
                zoomMode: 'custom',
                continuousScroll: false,
                viewMode: 'facing',
                viewRotation: 90,
                surfaceMode: 'scan-cleanup',
                annotationRecovery: {
                    artifactId: 'recovery-1',
                    documentInstanceId: 'document-1',
                    workingCopyRef: requireDocumentRef('/tmp/working/draft.pdf'),
                    workingByteRevision: 'revision-1',
                    annotationMutationGeneration: 4,
                    payload: {version: 1},
                },
            }],
        }, {
            tabs,
            workspaceRefs,
            restoreGraph,
            openPathInReservedTab,
            activateTab,
            restoreSurfaceMode,
        });

        expect(restoreGraph).toHaveBeenCalledOnce();
        expect(restoreSurfaceMode).toHaveBeenCalledWith('old-tab', 'scan-cleanup');
        expect(order).toEqual([
            'graph',
            'surface',
            'open',
        ]);
        expect(openPathInReservedTab).toHaveBeenCalledWith('old-tab', {
            kind: 'pdf',
            originalPath: '/documents/draft.pdf',
            recoveryDirtyBaseline: true,
            workingPath: '/tmp/working/draft.pdf',
        });
        expect(workspace.handleGoToPage).toHaveBeenCalledWith(9);
        expect(workspace.setCustomZoomFromDisplay).toHaveBeenCalledWith(1.4);
        expect(workspace.handleToggleContinuousScroll).toHaveBeenCalledOnce();
        expect(workspace.handleViewModeFacing).toHaveBeenCalledOnce();
        expect(workspace.setViewRotation).toHaveBeenCalledWith(90);
        expect(activateTab).toHaveBeenCalledWith('restored-tab');
        expect(workspace.restoreCanonicalAnnotationRecovery).toHaveBeenCalledWith({version: 1});
    });

    it('does not apply recovery when the reopened working copy revision changed', async () => {
        const restoreCanonicalAnnotationRecovery = vi.fn();
        const mismatchedSnapshot = {
            ...createWorkspaceAutomationStateSnapshot({
                originalPath: requireDocumentRef('/documents/draft.pdf'),
                workingCopyPath: requireDocumentRef('/tmp/working/draft.pdf'),
            }),
            documentIdentity: {
                version: 1 as const,
                token: requireDocumentRevisionToken('revision-2'),
                documentRef: requireDocumentRef('/tmp/working/draft.pdf'),
                authority: 'electron-working-copy' as const,
                contentRevision: 2,
                mintedAt: requireEpochMs(123),
            },
        };
        const workspace = createWorkspaceExposeFixture({
            waitForDocumentOpenSettled: vi.fn().mockResolvedValue(undefined),
            restoreCanonicalAnnotationRecovery,
            getAutomationStateSnapshot: () => mismatchedSnapshot,
        });
        const sourcePath = requireDocumentRef('/documents/draft.pdf');
        const workingCopyPath = requireDocumentRef('/tmp/working/draft.pdf');
        const failedPaths = await restoreWorkspaceCheckpoint({
            version: 1,
            capturedAt: requireEpochMs(123),
            activePaneId: requirePaneId('pane-1'),
            activeTabId: requireTabId('tab-1'),
            layout: {
                type: 'leaf',
                paneId: requirePaneId('pane-1'),
            },
            panes: [{
                paneId: requirePaneId('pane-1'),
                tabIds: [requireTabId('tab-1')],
                activeTabId: requireTabId('tab-1'),
            }],
            tabs: [{
                tabId: requireTabId('tab-1'),
                paneId: requirePaneId('pane-1'),
                fileName: 'draft.pdf',
                sourceRef: sourcePath,
                workingCopyRef: workingCopyPath,
                isDirty: true,
                isDjvu: false,
                currentPage: null,
                zoom: null,
                zoomMode: null,
                annotationRecovery: {
                    artifactId: 'recovery-1',
                    documentInstanceId: 'document-1',
                    workingCopyRef: workingCopyPath,
                    workingByteRevision: 'revision-1',
                    annotationMutationGeneration: 4,
                    payload: {version: 1},
                },
            }],
        }, {
            tabs: ref<ITab[]>([{
                id: requireTabId('tab-1'),
                fileName: 'draft.pdf',
                originalPath: sourcePath,
                documentInstanceId: requireDocumentInstanceId('document-1'),
                isDirty: true,
                isDjvu: false,
            }]),
            workspaceRefs: ref(new Map([[
                requireTabId('tab-1'),
                workspace,
            ]])),
            restoreGraph: vi.fn(),
            openPathInReservedTab: vi.fn().mockResolvedValue(true),
            activateTab: vi.fn(),
        });

        expect(failedPaths).toEqual([sourcePath]);
        expect(restoreCanonicalAnnotationRecovery).not.toHaveBeenCalled();
    });

    it('reopens a clean checkpoint through the source path to restore its process registration', async () => {
        const openPathInReservedTab = vi.fn().mockResolvedValue(true);

        await restoreWorkspaceCheckpoint({
            version: 1,
            capturedAt: requireEpochMs(123),
            activePaneId: requirePaneId('pane-1'),
            activeTabId: requireTabId('tab-1'),
            layout: {
                type: 'leaf',
                paneId: requirePaneId('pane-1'),
            },
            panes: [{
                paneId: requirePaneId('pane-1'),
                tabIds: [requireTabId('tab-1')],
                activeTabId: requireTabId('tab-1'),
            }],
            tabs: [{
                tabId: requireTabId('tab-1'),
                paneId: requirePaneId('pane-1'),
                fileName: 'saved.pdf',
                sourceRef: requireDocumentRef('/documents/saved.pdf'),
                workingCopyRef: requireDocumentRef('/tmp/working/saved.pdf'),
                isDirty: false,
                isDjvu: false,
                currentPage: null,
                zoom: null,
                zoomMode: null,
            }],
        }, {
            tabs: ref([{
                id: requireTabId('tab-1'),
                fileName: 'saved.pdf',
                originalPath: requireDocumentRef('/documents/saved.pdf'),
                isDirty: false,
                isDjvu: false,
            }]),
            workspaceRefs: ref(new Map()),
            restoreGraph: vi.fn(),
            openPathInReservedTab,
            activateTab: vi.fn(),
        });

        expect(openPathInReservedTab).toHaveBeenCalledWith('tab-1', '/documents/saved.pdf');
    });

    it('does not apply a dirty checkpoint to a source-only workspace after recovery fails', async () => {
        const waitForDocumentOpenSettled = vi.fn().mockResolvedValue(undefined);
        const workspace = createWorkspaceExposeFixture({waitForDocumentOpenSettled});
        const activateTab = vi.fn();
        const sourcePath = requireDocumentRef('/documents/failed-draft.pdf');
        const workingCopyPath = requireDocumentRef('/tmp/working/failed-draft.pdf');

        const failedPaths = await restoreWorkspaceCheckpoint({
            version: 1,
            capturedAt: requireEpochMs(123),
            activePaneId: requirePaneId('pane-1'),
            activeTabId: requireTabId('tab-1'),
            layout: {
                type: 'leaf',
                paneId: requirePaneId('pane-1'),
            },
            panes: [{
                paneId: requirePaneId('pane-1'),
                tabIds: [requireTabId('tab-1')],
                activeTabId: requireTabId('tab-1'),
            }],
            tabs: [{
                tabId: requireTabId('tab-1'),
                paneId: requirePaneId('pane-1'),
                fileName: 'failed-draft.pdf',
                sourceRef: sourcePath,
                workingCopyRef: workingCopyPath,
                isDirty: true,
                isDjvu: false,
                currentPage: 4,
                zoom: 1.2,
                zoomMode: 'custom',
            }],
        }, {
            tabs: ref([{
                id: requireTabId('tab-1'),
                fileName: 'failed-draft.pdf',
                originalPath: sourcePath,
                isDirty: true,
                isDjvu: false,
            }]),
            workspaceRefs: ref(new Map([[
                requireTabId('tab-1'),
                workspace,
            ]])),
            restoreGraph: vi.fn(),
            openPathInReservedTab: vi.fn().mockResolvedValue(false),
            activateTab,
        });

        expect(failedPaths).toEqual([sourcePath]);
        expect(waitForDocumentOpenSettled).not.toHaveBeenCalled();
        expect(activateTab).not.toHaveBeenCalled();
    });

    it('restores an unsaved generated PDF from its working copy without losing Save As semantics', async () => {
        const workspace = createWorkspaceExposeFixture({
            waitForDocumentOpenSettled: vi.fn().mockResolvedValue(undefined),
            handleGoToPage: vi.fn(),
            setCustomZoomFromDisplay: vi.fn(),
            handleFitWidth: vi.fn(),
            handleFitHeight: vi.fn(),
            handleToggleContinuousScroll: vi.fn(),
            handleViewModeSingle: vi.fn(),
            handleViewModeFacing: vi.fn(),
            handleViewModeFacingFirstSingle: vi.fn(),
            getToolbarSnapshot: () => ({
                ...createDefaultWorkspaceToolbarSnapshot(),
                continuousScroll: true,
                viewerCapabilities: {
                    ...createDefaultWorkspaceViewerCapabilities(),
                    continuousScroll: true,
                    viewMode: true,
                },
            }),
            getAutomationStateSnapshot: () => createWorkspaceAutomationStateSnapshot({
                originalPath: requireDocumentRef('/documents/Combined.pdf'),
                workingCopyPath: requireDocumentRef('/tmp/working/Combined.pdf'),
            }),
        });
        const openPathInReservedTab = vi.fn().mockResolvedValue(true);

        await restoreWorkspaceCheckpoint({
            version: 1,
            capturedAt: requireEpochMs(123),
            activePaneId: requirePaneId('pane-1'),
            activeTabId: requireTabId('tab-1'),
            layout: {
                type: 'leaf',
                paneId: requirePaneId('pane-1'),
            },
            panes: [{
                paneId: requirePaneId('pane-1'),
                tabIds: [requireTabId('tab-1')],
                activeTabId: requireTabId('tab-1'),
            }],
            tabs: [{
                tabId: requireTabId('tab-1'),
                paneId: requirePaneId('pane-1'),
                fileName: 'Combined.pdf',
                sourceRef: requireDocumentRef('/documents/Combined.pdf'),
                workingCopyRef: requireDocumentRef('/tmp/working/Combined.pdf'),
                requiresSaveAsOnFirstSave: true,
                isDirty: true,
                isDjvu: false,
                currentPage: null,
                zoom: null,
                zoomMode: null,
            }],
        }, {
            tabs: ref<ITab[]>([{
                id: 'tab-1',
                fileName: 'Combined.pdf',
                originalPath: requireDocumentRef('/documents/Combined.pdf'),
                isDirty: true,
                isDjvu: false,
            }]),
            workspaceRefs: ref(new Map<string, IWorkspaceExpose>().set('tab-1', workspace)),
            restoreGraph: vi.fn(),
            openPathInReservedTab,
            activateTab: vi.fn(),
        });

        expect(openPathInReservedTab).toHaveBeenCalledWith('tab-1', {
            kind: 'pdf',
            workingPath: '/tmp/working/Combined.pdf',
            originalPath: '/documents/Combined.pdf',
            recoveryDirtyBaseline: true,
            isGenerated: true,
        });
    });

    it('restores a dirty DjVu recovery snapshot as a generated PDF working copy', async () => {
        const openPathInReservedTab = vi.fn().mockResolvedValue(true);
        await restoreWorkspaceCheckpoint({
            version: 1,
            capturedAt: requireEpochMs(123),
            activePaneId: requirePaneId('pane-1'),
            activeTabId: requireTabId('tab-1'),
            layout: {
                type: 'leaf',
                paneId: requirePaneId('pane-1'),
            },
            panes: [{
                paneId: requirePaneId('pane-1'),
                tabIds: [requireTabId('tab-1')],
                activeTabId: requireTabId('tab-1'),
            }],
            tabs: [{
                tabId: requireTabId('tab-1'),
                paneId: requirePaneId('pane-1'),
                fileName: 'scan.djvu',
                sourceRef: requireDocumentRef('browser://documents/scan.djvu'),
                workingCopyRef: requireDocumentRef('browser://documents/scan-recovery.pdf'),
                requiresSaveAsOnFirstSave: true,
                isDirty: true,
                isDjvu: true,
                currentPage: null,
                zoom: null,
                zoomMode: null,
            }],
        }, {
            tabs: ref([]),
            workspaceRefs: ref(new Map()),
            restoreGraph: vi.fn(),
            openPathInReservedTab,
            activateTab: vi.fn(),
        });

        expect(openPathInReservedTab).toHaveBeenCalledWith('tab-1', {
            kind: 'pdf',
            workingPath: 'browser://documents/scan-recovery.pdf',
            originalPath: 'browser://documents/scan.djvu',
            recoveryDirtyBaseline: true,
            isGenerated: true,
        });
    });

    it('restores a blank tab without waiting for document visual readiness', async () => {
        const waitForDocumentOpenSettled = vi.fn().mockResolvedValue(undefined);
        const workspace = createWorkspaceExposeFixture({waitForDocumentOpenSettled});
        const activateTab = vi.fn();

        await restoreWorkspaceCheckpoint({
            version: 1,
            capturedAt: requireEpochMs(123),
            activePaneId: requirePaneId('pane-1'),
            activeTabId: requireTabId('tab-1'),
            layout: {
                type: 'leaf',
                paneId: requirePaneId('pane-1'),
            },
            panes: [{
                paneId: requirePaneId('pane-1'),
                tabIds: [requireTabId('tab-1')],
                activeTabId: requireTabId('tab-1'),
            }],
            tabs: [{
                tabId: requireTabId('tab-1'),
                paneId: requirePaneId('pane-1'),
                fileName: null,
                sourceRef: null,
                workingCopyRef: null,
                isDirty: false,
                isDjvu: false,
                currentPage: null,
                zoom: null,
                zoomMode: null,
            }],
        }, {
            tabs: ref([{
                id: 'tab-1',
                fileName: null,
                originalPath: null,
                isDirty: false,
                isDjvu: false,
            }]),
            workspaceRefs: ref(new Map<string, IWorkspaceExpose>().set('tab-1', workspace)),
            restoreGraph: vi.fn(),
            openPathInReservedTab: vi.fn(),
            activateTab,
        });

        expect(waitForDocumentOpenSettled).not.toHaveBeenCalled();
        expect(activateTab).toHaveBeenCalledWith('tab-1');
    });
});
