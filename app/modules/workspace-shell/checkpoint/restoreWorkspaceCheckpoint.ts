import type { Ref } from 'vue';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TOpenFileResult } from '@contracts/electronApiDocuments';
import type {
    IWorkspaceCheckpoint,
    IWorkspaceCheckpointTab,
    TWorkspaceCheckpointSurfaceMode,
} from '@contracts/workspaceCheckpoint';
import type { ITab } from '@app/types/tabs';
import type { IWorkspaceExpose } from '@app/types/workspaceExpose';

interface IRestoreWorkspaceCheckpointOptions {
    tabs: Ref<ITab[]>;
    workspaceRefs: Ref<Map<string, IWorkspaceExpose>>;
    restoreGraph: (checkpoint: IWorkspaceCheckpoint) => void;
    openPathInReservedTab: (tabId: string, target: TDocumentRef | TOpenFileResult) => Promise<boolean>;
    activateTab: (tabId: string) => void;
    restoreSurfaceMode?: ((tabId: string, mode: TWorkspaceCheckpointSurfaceMode) => void) | undefined;
}

const WORKSPACE_RESTORE_CONCURRENCY = 2;

function getRestoreTarget(tab: IWorkspaceCheckpointTab): TDocumentRef | TOpenFileResult | null {
    // A hard Electron restart loses the main-process working-copy registry.
    // Clean tabs already have their durable state in sourceRef, so reopen them
    // through the normal open path to recreate the registration and witness.
    if (!tab.isDirty && tab.sourceRef) {
        return tab.sourceRef;
    }
    if (tab.workingCopyRef && tab.sourceRef) {
        return {
            kind: 'pdf',
            workingPath: tab.workingCopyRef,
            originalPath: tab.sourceRef,
            ...(tab.requiresSaveAsOnFirstSave ? {isGenerated: true} : {}),
        };
    }
    return tab.sourceRef;
}

function findRestoredWorkspace(
    checkpointTab: IWorkspaceCheckpointTab,
    options: IRestoreWorkspaceCheckpointOptions,
) {
    for (const [
        tabId,
        workspace,
    ] of options.workspaceRefs.value) {
        const tab = options.tabs.value.find(candidate => candidate.id === tabId);
        try {
            const state = workspace.getAutomationStateSnapshot();
            if (
                (checkpointTab.workingCopyRef && state.workingCopyPath === checkpointTab.workingCopyRef)
                || (checkpointTab.sourceRef && state.originalPath === checkpointTab.sourceRef)
                || (checkpointTab.sourceRef && tab?.originalPath === checkpointTab.sourceRef)
            ) {
                return {
                    tabId,
                    workspace,
                };
            }
        } catch {
            // A deferred workspace may not have attached its real expose yet.
        }
    }
    return null;
}

async function applyViewState(tab: IWorkspaceCheckpointTab, workspace: IWorkspaceExpose) {
    await workspace.waitForDocumentOpenSettled();
    const toolbar = workspace.getToolbarSnapshot();
    if (
        tab.continuousScroll != null
        && toolbar.viewerCapabilities.continuousScroll
        && toolbar.continuousScroll !== tab.continuousScroll
    ) {
        workspace.handleToggleContinuousScroll();
    }
    if (tab.viewMode != null && toolbar.viewerCapabilities.viewMode) {
        if (tab.viewMode === 'single') {
            workspace.handleViewModeSingle();
        } else if (tab.viewMode === 'facing') {
            workspace.handleViewModeFacing();
        } else {
            workspace.handleViewModeFacingFirstSingle();
        }
    }
    if (tab.viewRotation != null && toolbar.viewerCapabilities.viewRotation) {
        workspace.setViewRotation(tab.viewRotation);
    }
    if (tab.currentPage !== null) {
        workspace.handleGoToPage(tab.currentPage);
    }
    if (tab.zoomMode === 'fit-width') {
        workspace.handleFitWidth();
    } else if (tab.zoomMode === 'fit-height') {
        workspace.handleFitHeight();
    } else if (tab.zoom !== null) {
        workspace.setCustomZoomFromDisplay(tab.zoom);
    }
}

export async function restoreWorkspaceCheckpoint(
    checkpoint: IWorkspaceCheckpoint,
    options: IRestoreWorkspaceCheckpointOptions,
) {
    options.restoreGraph(checkpoint);
    // Apply this before the document open transaction. Otherwise a crash in
    // Scan Cleanup re-enters the reader and constructs the whole PDF viewer
    // before the shell can switch back to the persisted cleanup surface.
    for (const tab of checkpoint.tabs) {
        if (tab.surfaceMode !== undefined) {
            options.restoreSurfaceMode?.(tab.tabId, tab.surfaceMode);
        }
    }
    await nextTick();
    const failedPaths: TDocumentRef[] = [];
    let nextTabIndex = 0;
    const restoreWorkers = Array.from(
        {length: Math.min(WORKSPACE_RESTORE_CONCURRENCY, checkpoint.tabs.length)},
        async () => {
            while (nextTabIndex < checkpoint.tabs.length) {
                const tab = checkpoint.tabs[nextTabIndex++]!;
                const restoreTarget = getRestoreTarget(tab);
                if (!restoreTarget) {
                    continue;
                }
                try {
                    if (!await options.openPathInReservedTab(tab.tabId, restoreTarget)) {
                        failedPaths.push(tab.sourceRef ?? tab.workingCopyRef!);
                    }
                } catch {
                    failedPaths.push(tab.sourceRef ?? tab.workingCopyRef!);
                }
            }
        },
    );
    await Promise.all(restoreWorkers);
    await nextTick();
    const activeCheckpointTab = checkpoint.tabs.find(tab => tab.tabId === checkpoint.activeTabId) ?? null;
    let restoredActiveTabId: string | null = null;
    for (const checkpointTab of checkpoint.tabs) {
        const workspace = options.workspaceRefs.value.get(checkpointTab.tabId) ?? null;
        const restored = workspace
            ? {
                tabId: checkpointTab.tabId,
                workspace,
            }
            : findRestoredWorkspace(checkpointTab, options);
        if (!restored) {
            continue;
        }
        if (getRestoreTarget(checkpointTab)) {
            await applyViewState(checkpointTab, restored.workspace);
        }
        if (checkpointTab === activeCheckpointTab) {
            restoredActiveTabId = restored.tabId;
        }
    }
    if (restoredActiveTabId) {
        options.activateTab(restoredActiveTabId);
    }
    return failedPaths;
}
