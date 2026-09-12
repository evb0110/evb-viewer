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
import {getWorkspaceViewerAdapter} from '@app/modules/workspace-shell/viewers/workspaceViewerAdapters';
import type {
    TWorkspaceViewerDocumentType,
    IWorkspaceViewerAdapter,
} from '@app/modules/workspace-shell/viewers/workspaceViewerAdapterTypes';

interface IRestoreWorkspaceCheckpointOptions {
    tabs: Ref<ITab[]>;
    workspaceRefs: Ref<Map<string, IWorkspaceExpose>>;
    restoreGraph: (checkpoint: IWorkspaceCheckpoint) => void;
    openPathInReservedTab: (tabId: string, target: TDocumentRef | TOpenFileResult) => Promise<boolean>;
    activateTab: (tabId: string) => void;
    restoreSurfaceMode?: ((tabId: string, mode: TWorkspaceCheckpointSurfaceMode) => void) | undefined;
}

const WORKSPACE_RESTORE_CONCURRENCY = 2;
const PDF_DOCUMENT_TYPE: TWorkspaceViewerDocumentType = 'pdf';

export function getRegisteredPdfOpenKind(
    adapter: Pick<IWorkspaceViewerAdapter, 'documentTypes' | 'capabilities'> = getWorkspaceViewerAdapter('pdf'),
) {
    const kind = adapter.documentTypes.find((documentType): documentType is 'pdf' => documentType === PDF_DOCUMENT_TYPE);
    return adapter.capabilities.pdfDocument ? kind ?? null : null;
}

function getRestoreTarget(tab: IWorkspaceCheckpointTab): TDocumentRef | TOpenFileResult | null {
    // A hard Electron restart loses the main-process working-copy registry.
    // Clean tabs already have their durable state in sourceRef, so reopen them
    // through the normal open path to recreate the registration and witness.
    if (!tab.isDirty && tab.sourceRef) {
        return tab.sourceRef;
    }
    if (tab.workingCopyRef && tab.sourceRef) {
        const pdfKind = getRegisteredPdfOpenKind();
        if (!pdfKind) {
            return null;
        }
        return {
            kind: pdfKind,
            workingPath: tab.workingCopyRef,
            originalPath: tab.sourceRef,
            recoveryDirtyBaseline: true,
            ...(tab.requiresSaveAsOnFirstSave ? {isGenerated: true} : {}),
        };
    }
    return tab.sourceRef;
}

function findRestoredWorkspace(
    checkpointTab: IWorkspaceCheckpointTab,
    options: IRestoreWorkspaceCheckpointOptions,
) {
    const requiresWorkingCopy = checkpointTab.isDirty && checkpointTab.workingCopyRef;
    for (const [
        tabId,
        workspace,
    ] of options.workspaceRefs.value) {
        const tab = options.tabs.value.find(candidate => candidate.id === tabId);
        try {
            const state = workspace.getAutomationStateSnapshot();
            if (
                requiresWorkingCopy
                    ? state.workingCopyPath === checkpointTab.workingCopyRef
                    : (checkpointTab.sourceRef && state.originalPath === checkpointTab.sourceRef)
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

// Recovery carries annotations that were never written to the file, so it may
// only be replayed onto the exact bytes it was captured from. A working copy
// that moved, was rewritten, or belongs to a different document instance makes
// the payload unattributable rather than merely stale.
function applyAnnotationRecovery(
    checkpointTab: IWorkspaceCheckpointTab,
    workspace: IWorkspaceExpose,
    restoredTab: ITab | undefined,
) {
    const recovery = checkpointTab.annotationRecovery;
    if (!recovery) {
        return true;
    }
    const state = workspace.getAutomationStateSnapshot();
    if (
        state.workingCopyPath !== recovery.workingCopyRef
        || state.documentIdentity?.token !== recovery.workingByteRevision
        || restoredTab?.documentInstanceId !== recovery.documentInstanceId
    ) {
        return false;
    }
    if (recovery.payload !== undefined) {
        workspace.restoreCanonicalAnnotationRecovery?.(recovery.payload);
    }
    return true;
}

async function applyViewState(
    checkpointTab: IWorkspaceCheckpointTab,
    workspace: IWorkspaceExpose,
    restoredTab: ITab | undefined,
) {
    await workspace.waitForDocumentOpenSettled();
    const recoveryApplied = applyAnnotationRecovery(checkpointTab, workspace, restoredTab);
    const toolbar = workspace.getToolbarSnapshot();
    if (
        checkpointTab.continuousScroll != null
        && toolbar.viewerCapabilities.continuousScroll
        && toolbar.continuousScroll !== checkpointTab.continuousScroll
    ) {
        workspace.handleToggleContinuousScroll();
    }
    if (checkpointTab.viewMode != null && toolbar.viewerCapabilities.viewMode) {
        if (checkpointTab.viewMode === 'single') {
            workspace.handleViewModeSingle();
        } else if (checkpointTab.viewMode === 'facing') {
            workspace.handleViewModeFacing();
        } else {
            workspace.handleViewModeFacingFirstSingle();
        }
    }
    if (checkpointTab.viewRotation != null && toolbar.viewerCapabilities.viewRotation) {
        workspace.setViewRotation(checkpointTab.viewRotation);
    }
    if (checkpointTab.currentPage !== null) {
        workspace.handleGoToPage(checkpointTab.currentPage);
    }
    if (checkpointTab.zoomMode === 'fit-width') {
        workspace.handleFitWidth();
    } else if (checkpointTab.zoomMode === 'fit-height') {
        workspace.handleFitHeight();
    } else if (checkpointTab.zoom !== null) {
        workspace.setCustomZoomFromDisplay(checkpointTab.zoom);
    }
    return recoveryApplied;
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
    const restoredTabIds = new Set<string>();
    let nextTabIndex = 0;
    const restoreWorkers = Array.from(
        {length: Math.min(WORKSPACE_RESTORE_CONCURRENCY, checkpoint.tabs.length)},
        async () => {
            while (nextTabIndex < checkpoint.tabs.length) {
                const tab = checkpoint.tabs[nextTabIndex++];
                if (!tab) {
                    continue;
                }
                const restoreTarget = getRestoreTarget(tab);
                if (!restoreTarget) {
                    const failedPath = tab.sourceRef ?? tab.workingCopyRef;
                    if (failedPath) {
                        failedPaths.push(failedPath);
                    }
                    continue;
                }
                try {
                    const opened = await options.openPathInReservedTab(tab.tabId, restoreTarget);
                    if (opened) {
                        restoredTabIds.add(tab.tabId);
                    } else {
                        const failedPath = tab.sourceRef ?? tab.workingCopyRef;
                        if (failedPath) {
                            failedPaths.push(failedPath);
                        }
                    }
                } catch {
                    const failedPath = tab.sourceRef ?? tab.workingCopyRef;
                    if (failedPath) {
                        failedPaths.push(failedPath);
                    }
                }
            }
        },
    );
    await Promise.all(restoreWorkers);
    await nextTick();
    const activeCheckpointTab = checkpoint.tabs.find(tab => tab.tabId === checkpoint.activeTabId) ?? null;
    let restoredActiveTabId: string | null = null;
    for (const checkpointTab of checkpoint.tabs) {
        const restoreTarget = getRestoreTarget(checkpointTab);
        if (restoreTarget && !restoredTabIds.has(checkpointTab.tabId)) {
            continue;
        }
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
        if (restoreTarget) {
            const restoredTab = options.tabs.value.find(tab => tab.id === restored.tabId);
            const recoveryApplied = await applyViewState(checkpointTab, restored.workspace, restoredTab);
            if (!recoveryApplied) {
                // The tab itself opened, so keep its view state and let it
                // activate. Only the unattributable recovery is withheld, and
                // reporting the path keeps the checkpoint unacknowledged so the
                // evidence survives for the next attempt.
                const failedPath = checkpointTab.sourceRef ?? checkpointTab.workingCopyRef;
                if (failedPath) {
                    failedPaths.push(failedPath);
                }
            }
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
