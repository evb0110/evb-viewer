import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    ref,
    shallowRef,
} from 'vue';
import { useShellWorkspaceToolbar } from '@app/modules/workspace-shell/composables/useShellWorkspaceToolbar';
import { createDefaultWorkspaceToolbarSnapshot } from '@app/types/workspaceExpose';
import type { IWorkspaceToolbarSnapshot } from '@app/types/workspaceExpose';
import { requireDocumentRef } from '@contracts/documentRef';
import {
    requireDocumentRevisionToken, type IDocumentRevisionInfo,
} from '@contracts/documentRevision';
import { requireEpochMs } from '@contracts/timestamps';
import {
    createWorkspaceDocumentController,
    type IWorkspaceDocumentController,
} from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';

function createSnapshot(overrides: Partial<IWorkspaceToolbarSnapshot> = {}): IWorkspaceToolbarSnapshot {
    return {
        ...createDefaultWorkspaceToolbarSnapshot(),
        ...overrides,
    };
}

function createSession(
    snapshot: Partial<IWorkspaceToolbarSnapshot> = {},
    revisionInfo: IDocumentRevisionInfo | null = null,
) {
    const session = createWorkspaceDocumentController({tabId: 'tab-1'});
    session.commitDocument({
        fileName: 'paper.pdf',
        originalPath: requireDocumentRef('/docs/paper.pdf'),
        isDjvu: false,
        revisionInfo,
    });
    session.publishToolbarSnapshot(createSnapshot(snapshot));
    return session;
}

function createToolbarOptions(overrides: Partial<Parameters<typeof useShellWorkspaceToolbar>[0]> = {}) {
    return {
        activeDocumentSession: shallowRef<IWorkspaceDocumentController | null>(null),
        hasWorkspaceToolbarContent: ref(false),
        ...overrides,
    };
}

describe('useShellWorkspaceToolbar', () => {
    it('reads toolbar state from the active tab controller', () => {
        const activeDocumentSession = shallowRef<IWorkspaceDocumentController | null>(createSession({
            hasPdf: true,
            canSave: true,
            currentPage: 12,
            totalPages: 80,
            zoom: 1.5,
            effectiveZoom: 1.5,
        }));

        const toolbar = useShellWorkspaceToolbar(createToolbarOptions({ activeDocumentSession }));

        expect(toolbar.shellToolbarSnapshot.value).toMatchObject({
            hasPdf: true,
            canSave: true,
            currentPage: 12,
            totalPages: 80,
            zoom: 1.5,
            effectiveZoom: 1.5,
        });
        expect(toolbar.shellToolbarHasPdf.value).toBe(true);
    });

    it('publishes the active working copy identity for the fallback OCR toolbar', () => {
        const documentIdentity: IDocumentRevisionInfo = {
            version: 1,
            documentRef: requireDocumentRef('/tmp/working-copy.pdf'),
            authority: 'electron-working-copy',
            contentRevision: 4,
            mintedAt: requireEpochMs(1),
            token: requireDocumentRevisionToken('revision-4'),
        };
        const activeDocumentSession = shallowRef<IWorkspaceDocumentController | null>(createSession({hasPdf: true}, documentIdentity));

        const toolbar = useShellWorkspaceToolbar(createToolbarOptions({ activeDocumentSession }));

        expect(toolbar.shellToolbarOcrWorkingCopyPath.value).toBe('/tmp/working-copy.pdf');
        expect(toolbar.shellToolbarOcrDocumentRevision.value).toBe('revision-4');
    });

    it('updates when the active tab changes', () => {
        const activeDocumentSession = shallowRef<IWorkspaceDocumentController | null>(createSession({
            hasPdf: true,
            canSave: false,
        }));
        const toolbar = useShellWorkspaceToolbar(createToolbarOptions({ activeDocumentSession }));

        activeDocumentSession.value = createSession({
            hasPdf: true,
            canSave: true,
        });

        expect(toolbar.shellToolbarSnapshot.value.canSave).toBe(true);
    });

    it('uses the default snapshot without an active tab', () => {
        const toolbar = useShellWorkspaceToolbar(createToolbarOptions());

        expect(toolbar.shellToolbarSnapshot.value).toEqual(createDefaultWorkspaceToolbarSnapshot());
        expect(toolbar.shellToolbarHasPdf.value).toBe(false);
    });

    it('keeps the shell toolbar visible until workspace toolbar content can take over', () => {
        const activeDocumentSession = shallowRef<IWorkspaceDocumentController | null>(null);
        const hasWorkspaceToolbarContent = ref(false);
        const toolbar = useShellWorkspaceToolbar(createToolbarOptions({
            activeDocumentSession,
            hasWorkspaceToolbarContent,
        }));

        expect(toolbar.showShellToolbar.value).toBe(true);

        activeDocumentSession.value = createSession({
            hasPdf: true,
            currentPage: 1,
            totalPages: 3,
        });
        expect(toolbar.showShellToolbar.value).toBe(true);

        hasWorkspaceToolbarContent.value = true;
        expect(toolbar.showShellToolbar.value).toBe(false);

        hasWorkspaceToolbarContent.value = false;
        expect(toolbar.showShellToolbar.value).toBe(true);
    });

    it('keeps field models as read-only mirrors', () => {
        const activeDocumentSession = shallowRef<IWorkspaceDocumentController | null>(createSession({
            hasPdf: true,
            zoom: 1.25,
            currentPage: 5,
            totalPages: 10,
        }));
        const toolbar = useShellWorkspaceToolbar(createToolbarOptions({ activeDocumentSession }));

        toolbar.shellToolbarZoom.value = 3;

        expect(toolbar.shellToolbarZoom.value).toBe(1.25);
        expect(activeDocumentSession.value?.toolbarSnapshot.value.zoom).toBe(1.25);
    });

    it('runs overflow view mode commands through registry command names', () => {
        const runCommand = vi.fn();
        const toolbar = useShellWorkspaceToolbar(createToolbarOptions());

        toolbar.handleShellToolbarOverflowSetViewMode('facing', runCommand);

        expect(runCommand).toHaveBeenCalledWith('handleViewModeFacing');
    });
});

describe('createDefaultWorkspaceToolbarSnapshot', () => {
    it('returns the documented default shape', () => {
        expect(createDefaultWorkspaceToolbarSnapshot()).toEqual({
            hasPdf: false,
            initialVisualReady: false,
            isOpeningDocument: false,
            hasOpenError: false,
            isPreparingPrint: false,
            isPreparingCurrentPagePrint: false,
            canSave: false,
            canRepairSave: false,
            canOptimizePdf: false,
            canUndo: false,
            canRedo: false,
            canExportDocx: false,
            isSaving: false,
            isSavingAs: false,
            isAnySaving: false,
            isHistoryBusy: false,
            isExportingDocx: false,
            isFitWidthActive: false,
            isFitHeightActive: false,
            showSidebar: false,
            sidebarTab: 'thumbnails',
            sidebarWidth: 272,
            dragMode: false,
            continuousScroll: true,
            isDjvuMode: false,
            isCapturingRegion: false,
            isCropSelecting: false,
            isPlacingPageNote: false,
            zoom: 1,
            effectiveZoom: 1,
            zoomMode: 'custom',
            fitMode: 'width',
            viewMode: 'single',
            viewRotation: 0,
            currentPage: 1,
            totalPages: 0,
            selectedPageCount: 0,
            isPageOperationInProgress: false,
            viewerCapabilities: {
                closeableDocument: false,
                continuousScroll: false,
                conversionBanner: false,
                conversionDialog: false,
                crop: false,
                optimizePdf: false,
                pdfDocument: false,
                pdfMutationActions: false,
                print: false,
                regionCapture: false,
                repairSave: false,
                save: false,
                saveAs: false,
                sidebar: false,
                viewMode: false,
                viewRotation: false,
            },
        });
    });

    it('returns a fresh object each call without aliasing', () => {
        const first = createDefaultWorkspaceToolbarSnapshot();
        const second = createDefaultWorkspaceToolbarSnapshot();

        expect(first).not.toBe(second);

        first.hasPdf = true;
        first.zoom = 2;

        expect(second.hasPdf).toBe(false);
        expect(second.zoom).toBe(1);
    });
});
