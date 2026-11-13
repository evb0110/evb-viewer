import type { Ref } from 'vue';
import type {TTabId} from '@contracts/windowTabs';
import type {
    IEditorPaneState,
    TEditorLayoutNode,
} from '@contracts/editorPanes';
import type {IWorkspaceCheckpoint} from '@contracts/workspaceCheckpoint';
import { createEpochMs } from '@contracts/timestamps';
import type { ITab } from '@app/types/tabs';
import type { IWorkspaceExpose } from '@app/types/workspaceExpose';
import type { IWorkspaceDocumentController } from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import { buildAgentWorkspaceSnapshot } from '@app/modules/workspace-shell/agent/buildAgentWorkspaceSnapshot';

interface IBuildWorkspaceCheckpointOptions {
    panes: Ref<IEditorPaneState[]>;
    tabs: Ref<ITab[]>;
    layout: Ref<TEditorLayoutNode | null>;
    activePaneId: Ref<string | null>;
    activeTabId: Ref<string | null>;
    documentSessionsByTabId: Ref<Record<string, IWorkspaceDocumentController>>;
    getPaneByTabId(tabId: string): IEditorPaneState | null;
}

export class WorkspaceCheckpointCaptureError extends Error {
    public readonly code = 'WORKSPACE_CHECKPOINT_CAPTURE_FAILED' as const;
    public readonly tabId: string;
    public override readonly cause: unknown;

    public constructor(tabId: string, cause: unknown) {
        super(`Workspace checkpoint could not capture document state for tab ${tabId}`);
        this.name = 'WorkspaceCheckpointCaptureError';
        this.tabId = tabId;
        this.cause = cause;
    }
}

function readWorkspaceDocumentRefs(
    workspace: IWorkspaceExpose | null,
    tabId: string,
) {
    try {
        const snapshot = workspace?.getAutomationStateSnapshot();
        return {
            sourceRef: snapshot?.originalPath ?? null,
            workingCopyRef: snapshot?.workingCopyPath ?? null,
            requiresSaveAsOnFirstSave: snapshot?.requiresSaveAsOnFirstSave ?? false,
        };
    } catch (error) {
        throw new WorkspaceCheckpointCaptureError(tabId, error);
    }
}

// The views of a document share one context, so any view with a mounted
// workspace speaks for the document; this tab's own view comes first.
function findDocumentWorkspace(session: IWorkspaceDocumentController, tabId: string) {
    const ownWorkspace = session.getView(tabId)?.mountedWorkspace.value ?? null;
    if (ownWorkspace) {
        return ownWorkspace;
    }
    for (const view of session.views.value.values()) {
        if (view.mountedWorkspace.value) {
            return view.mountedWorkspace.value;
        }
    }
    return null;
}

/** The window's tabs, panes and views. A document's unsaved work is its drafts, which its own edits commit. */
export function buildWorkspaceCheckpoint(options: IBuildWorkspaceCheckpointOptions) {
    const workspaceSnapshot = buildAgentWorkspaceSnapshot(options);
    const firstTabByDocument = new Map<IWorkspaceDocumentController, TTabId>();

    return {
        version: 1,
        capturedAt: createEpochMs(),
        activePaneId: workspaceSnapshot.activePaneId,
        activeTabId: workspaceSnapshot.activeTabId,
        layout: workspaceSnapshot.layout,
        panes: workspaceSnapshot.panes.map(pane => ({
            paneId: pane.paneId,
            tabIds: [...pane.tabIds],
            activeTabId: pane.activeTabId,
        })),
        tabs: workspaceSnapshot.tabs.map((snapshot) => {
            const session = options.documentSessionsByTabId.value[snapshot.tabId];
            const view = session?.getView(snapshot.tabId) ?? null;
            const workspace = session ? findDocumentWorkspace(session, snapshot.tabId) : null;
            const documentRefs = workspace || !session
                ? readWorkspaceDocumentRefs(workspace, snapshot.tabId)
                : {
                    sourceRef: session.snapshot.value.identity.originalPath,
                    workingCopyRef: session.snapshot.value.identity.workingCopyPath,
                    requiresSaveAsOnFirstSave: false,
                };
            // The first tab of a document opens it at restore; the later ones link to it.
            const linkedToTabId = session && firstTabByDocument.get(session);
            if (session && !linkedToTabId) {
                firstTabByDocument.set(session, snapshot.tabId);
            }
            const toolbar = view?.toolbarSnapshot.value ?? null;
            const reader = toolbar && (toolbar.hasPdf || view?.restored) ? toolbar : null;
            return {
                tabId: snapshot.tabId,
                paneId: snapshot.paneId,
                fileName: snapshot.fileName,
                sourceRef: documentRefs.sourceRef ?? snapshot.originalPath ?? null,
                workingCopyRef: documentRefs.workingCopyRef,
                ...(linkedToTabId ? {linkedToTabId} : {}),
                requiresSaveAsOnFirstSave: documentRefs.requiresSaveAsOnFirstSave,
                isDirty: snapshot.isDirty,
                isDjvu: snapshot.isDjvu,
                currentPage: reader?.currentPage ?? null,
                zoom: reader?.zoom ?? null,
                zoomMode: reader?.zoomMode ?? null,
                continuousScroll: reader?.continuousScroll ?? null,
                viewMode: reader?.viewMode ?? null,
                viewRotation: reader?.viewRotation ?? null,
                // A cleanup surface is not restorable without its file-backed
                // page mapping. Keep the checkpoint on the reader surface;
                // completed outputs are recovered through the main journal.
            };
        }),
    } satisfies IWorkspaceCheckpoint;
}
