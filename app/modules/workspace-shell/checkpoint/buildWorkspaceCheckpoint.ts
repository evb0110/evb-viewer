import type { Ref } from 'vue';
import type {
    IEditorPaneState,
    TEditorLayoutNode,
} from '@contracts/editorPanes';
import type {
    IWorkspaceCheckpoint,
    IWorkspaceCheckpointAnnotationRecovery,
} from '@contracts/workspaceCheckpoint';
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

export function buildWorkspaceCheckpoint(
    options: IBuildWorkspaceCheckpointOptions,
): IWorkspaceCheckpoint {
    const workspaceSnapshot = buildAgentWorkspaceSnapshot(options);

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
            const workspace = session?.mountedWorkspace.value ?? null;
            const documentRefs = readWorkspaceDocumentRefs(workspace, snapshot.tabId);
            const workingByteRevision = session?.snapshot.value.identity.revisionInfo?.token ?? null;
            const capturedAnnotationRecovery = workspace?.captureCanonicalAnnotationRecovery?.() ?? null;
            const annotationRecovery = capturedAnnotationRecovery && workingByteRevision
                ? capturedAnnotationRecovery
                : null;
            const toolbar = session?.toolbarSnapshot.value ?? null;
            return {
                tabId: snapshot.tabId,
                paneId: snapshot.paneId,
                fileName: snapshot.fileName,
                sourceRef: documentRefs.sourceRef ?? snapshot.originalPath ?? null,
                workingCopyRef: documentRefs.workingCopyRef,
                requiresSaveAsOnFirstSave: documentRefs.requiresSaveAsOnFirstSave,
                isDirty: snapshot.isDirty,
                isDjvu: snapshot.isDjvu,
                currentPage: toolbar?.hasPdf ? toolbar.currentPage : null,
                zoom: toolbar?.hasPdf ? toolbar.zoom : null,
                zoomMode: toolbar?.hasPdf ? toolbar.zoomMode : null,
                continuousScroll: toolbar?.hasPdf ? toolbar.continuousScroll : null,
                viewMode: toolbar?.hasPdf ? toolbar.viewMode : null,
                viewRotation: toolbar?.hasPdf ? toolbar.viewRotation : null,
                // A cleanup surface is not restorable without its file-backed
                // page mapping. Keep the checkpoint on the reader surface;
                // completed outputs are recovered through the main journal.
                ...(annotationRecovery
                    ? {annotationRecovery: {
                        artifactId: `capture-${snapshot.tabId}`,
                        documentInstanceId: session?.snapshot.value.identity.documentInstanceId ?? snapshot.tabId,
                        workingCopyRef: documentRefs.workingCopyRef,
                        workingByteRevision: workingByteRevision ?? '',
                        annotationMutationGeneration: annotationRecovery.annotationMutationGeneration,
                        payload: annotationRecovery,
                    } satisfies IWorkspaceCheckpointAnnotationRecovery}
                    : {}),
            };
        }),
    };
}
