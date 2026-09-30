import type { Ref } from 'vue';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TOpenFileResult } from '@contracts/electronApiDocuments';
import { parseDocumentInstanceId } from '@contracts/documentInstanceId';
import type {
    IWorkspaceCheckpoint,
    IWorkspaceCheckpointTab,
} from '@contracts/workspaceCheckpoint';
import type {
    IWorkspaceExpose,
    IWorkspaceToolbarSnapshot,
} from '@app/types/workspaceExpose';
import type { IWorkspaceDocumentViewSeed } from '@app/modules/workspace-shell/document-sessions/createWorkspaceDocumentView';
import { createTabViewSessionState } from '@app/modules/workspace-shell/tabs/createTabViewSessionState';
import type { IWorkspaceDocumentController } from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import type { TWorkspaceDocumentSessions } from '@app/modules/workspace-shell/document-sessions/useWorkspaceDocumentSessions';
import {getWorkspaceViewerAdapterForDocumentType} from '@app/modules/workspace-shell/viewers/workspaceViewerAdapters';
import type {
    TWorkspaceViewerDocumentType,
    IWorkspaceViewerAdapter,
} from '@app/modules/workspace-shell/viewers/workspaceViewerAdapterTypes';

interface IRestoreWorkspaceCheckpointOptions {
    activeTabId: Readonly<Ref<string | null>>;
    documentSessions: Pick<TWorkspaceDocumentSessions, 'assignDocument' | 'getSession' | 'getView' | 'linkView'>;
    restoreGraph: (checkpoint: IWorkspaceCheckpoint) => void;
    activateTab: (tabId: string) => void;
}

const PDF_DOCUMENT_TYPE: TWorkspaceViewerDocumentType = 'pdf';

export function getRegisteredPdfOpenKind(
    adapter: Pick<IWorkspaceViewerAdapter, 'documentTypes' | 'capabilities'> = getWorkspaceViewerAdapterForDocumentType('pdf'),
) {
    const kind = adapter.documentTypes.find((documentType): documentType is 'pdf' => documentType === PDF_DOCUMENT_TYPE);
    return adapter.capabilities.pdfDocument ? kind ?? null : null;
}

// Unsaved work reopens from its working copy. A hard restart loses the main
// process's working-copy registry, so the open re-registers it.
function getRecoveryTarget(tab: IWorkspaceCheckpointTab): TOpenFileResult | null {
    const pdfKind = getRegisteredPdfOpenKind();
    return tab.isDirty && tab.workingCopyRef && tab.sourceRef && pdfKind
        ? {
            kind: pdfKind,
            workingPath: tab.workingCopyRef,
            originalPath: tab.sourceRef,
            recoveryDirtyBaseline: true,
            ...(tab.requiresSaveAsOnFirstSave ? {isGenerated: true} : {}),
        }
        : null;
}

// Recovery carries annotations that were never written to the file, so it may
// only be replayed onto the exact bytes it was captured from. A working copy
// that moved, was rewritten, or belongs to a different document instance makes
// the payload unattributable rather than merely stale.
function applyAnnotationRecovery(
    checkpointTab: IWorkspaceCheckpointTab,
    workspace: IWorkspaceExpose,
    session: IWorkspaceDocumentController,
) {
    const recovery = checkpointTab.annotationRecovery;
    if (!recovery) {
        return true;
    }
    const state = workspace.getAutomationStateSnapshot();
    if (
        state.workingCopyPath !== recovery.workingCopyRef
        || state.documentIdentity?.token !== recovery.workingByteRevision
        || session.snapshot.value.identity.documentInstanceId !== recovery.documentInstanceId
    ) {
        return false;
    }
    if (recovery.payload !== undefined) {
        workspace.restoreCanonicalAnnotationRecovery?.(recovery.payload);
    }
    return true;
}

function applyViewState(checkpointTab: IWorkspaceCheckpointTab, workspace: IWorkspaceExpose) {
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
}

async function restoreTab(
    checkpointTab: IWorkspaceCheckpointTab,
    session: IWorkspaceDocumentController,
    shown: boolean,
) {
    const recoveryTarget = getRecoveryTarget(checkpointTab);
    // A tab that is not shown opens its document when it is. Shown tabs and
    // tabs with unsaved work (kept mounted) open now.
    if (!shown && !recoveryTarget) {
        return true;
    }
    const workspace = await session.getView(checkpointTab.tabId)?.whenMounted() ?? null;
    if (!workspace) {
        return false;
    }
    if (recoveryTarget && !await workspace.handleOpenFileWithResult(recoveryTarget)) {
        return false;
    }
    await workspace.waitForDocumentOpenSettled();
    if (session.snapshot.value.phase !== 'presented') {
        return false;
    }
    const recoveryApplied = applyAnnotationRecovery(checkpointTab, workspace, session);
    applyViewState(checkpointTab, workspace);
    // The tab itself opened and keeps its view. Only an unattributable
    // recovery is withheld; reporting it keeps the checkpoint as evidence.
    return recoveryApplied;
}

// A second view of a restored document starts from its own checkpointed
// place, so a view that is hidden now opens there when it is first shown.
function createLinkedViewSeed(
    checkpointTab: IWorkspaceCheckpointTab,
    documentToolbar: IWorkspaceToolbarSnapshot,
): IWorkspaceDocumentViewSeed {
    const toolbarSnapshot: IWorkspaceToolbarSnapshot = {
        ...documentToolbar,
        ...(checkpointTab.currentPage !== null ? {currentPage: checkpointTab.currentPage} : {}),
        ...(checkpointTab.zoomMode !== null ? {zoomMode: checkpointTab.zoomMode} : {}),
        ...(checkpointTab.zoom !== null
            ? {
                zoom: checkpointTab.zoom,
                effectiveZoom: checkpointTab.zoom,
            }
            : {}),
        ...(checkpointTab.continuousScroll != null ? {continuousScroll: checkpointTab.continuousScroll} : {}),
        ...(checkpointTab.viewMode != null ? {viewMode: checkpointTab.viewMode} : {}),
        ...(checkpointTab.viewRotation != null ? {viewRotation: checkpointTab.viewRotation} : {}),
    };
    return {
        toolbarSnapshot,
        viewState: createTabViewSessionState(toolbarSnapshot),
    };
}

// A second view of a restored document takes its own place once it shows.
async function restoreLinkedTab(
    checkpointTab: IWorkspaceCheckpointTab,
    options: Pick<IRestoreWorkspaceCheckpointOptions, 'documentSessions'>,
    shown: boolean,
) {
    if (!shown) {
        return true;
    }
    const workspace = await options.documentSessions.getView(checkpointTab.tabId)?.whenMounted() ?? null;
    if (!workspace) {
        return false;
    }
    await workspace.waitForDocumentOpenSettled();
    applyViewState(checkpointTab, workspace);
    return true;
}

/**
 * Rebuilds the saved tabs and panes. Every tab gets its document at once, so
 * titles and dirty dots show before anything loads; unsaved work reopens from
 * its working copy, and the others open when their tab is shown. Returns the
 * paths whose state could not be restored.
 */
export async function restoreWorkspaceCheckpoint(
    checkpoint: IWorkspaceCheckpoint,
    options: IRestoreWorkspaceCheckpointOptions,
) {
    options.restoreGraph(checkpoint);
    // Tabs that viewed one PDF share its working copy, which no other
    // document uses; they come back as views of one document again. Only
    // the first of them restores the document.
    const linkedToTabId = new Map<string, string>();
    const firstTabByWorkingCopy = new Map<TDocumentRef, string>();
    for (const tab of checkpoint.tabs) {
        const firstTabId = tab.workingCopyRef && !tab.isDjvu ? firstTabByWorkingCopy.get(tab.workingCopyRef) : undefined;
        if (firstTabId) {
            linkedToTabId.set(tab.tabId, firstTabId);
            continue;
        }
        if (tab.workingCopyRef && !tab.isDjvu) {
            firstTabByWorkingCopy.set(tab.workingCopyRef, tab.tabId);
        }
        options.documentSessions.assignDocument(tab.tabId, {
            fileName: tab.fileName,
            originalPath: tab.sourceRef,
            isDjvu: tab.isDjvu,
            isDirty: tab.isDirty,
            documentInstanceId: parseDocumentInstanceId(tab.annotationRecovery?.documentInstanceId),
            recoveryWorkingCopyPath: tab.isDirty ? tab.workingCopyRef : null,
        });
    }
    await nextTick();
    const graphActiveTabId = options.activeTabId.value;
    const restoredByTabId = new Map<string, Promise<boolean>>();
    const results = await Promise.all(checkpoint.tabs.map(async (tab) => {
        const shown = checkpoint.panes.some(pane => pane.activeTabId === tab.tabId);
        const firstTabId = linkedToTabId.get(tab.tabId);
        const restored = (async () => {
            if (firstTabId) {
                const documentToolbar = await restoredByTabId.get(firstTabId) === true
                    ? options.documentSessions.getView(firstTabId)?.toolbarSnapshot.value
                    : undefined;
                return documentToolbar !== undefined
                    && options.documentSessions.linkView(firstTabId, tab.tabId, createLinkedViewSeed(tab, documentToolbar))
                    && await restoreLinkedTab(tab, options, shown);
            }
            const session = options.documentSessions.getSession(tab.tabId);
            return session !== null && await restoreTab(tab, session, shown);
        })().catch(() => false);
        restoredByTabId.set(tab.tabId, restored);
        return restored;
    }));
    const failedPaths = checkpoint.tabs.flatMap((tab, index): TDocumentRef[] => {
        const failedPath = tab.sourceRef ?? tab.workingCopyRef;
        return !results[index] && failedPath ? [failedPath] : [];
    });
    // Tabs are clickable while their documents reopen. A tab the user chose in
    // that window outranks the checkpoint's choice.
    if (checkpoint.activeTabId && options.activeTabId.value === graphActiveTabId) {
        options.activateTab(checkpoint.activeTabId);
    }
    return failedPaths;
}
