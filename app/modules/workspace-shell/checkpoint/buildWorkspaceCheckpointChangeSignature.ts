import type { Ref } from 'vue';
import type {
    IEditorPaneState,
    TEditorLayoutNode,
} from '@contracts/editorPanes';
import type { ITab } from '@app/types/tabs';
import {
    describeTabDocument,
    type IWorkspaceDocumentController,
} from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';

interface IBuildWorkspaceCheckpointSignatureOptions {
    panes: Ref<IEditorPaneState[]>;
    tabs: Ref<ITab[]>;
    layout: Ref<TEditorLayoutNode | null>;
    activePaneId: Ref<string | null>;
    activeTabId: Ref<string | null>;
    documentSessionsByTabId: Ref<Record<string, IWorkspaceDocumentController>>;
    getPaneByTabId(tabId: string): IEditorPaneState | null;
}

export interface IWorkspaceCheckpointChangeSignature {
    workspace: string;
    tabSignatures: Map<string, string>;
}

function buildTabSignature(
    tab: ITab,
    paneId: string | null,
    session: IWorkspaceDocumentController | undefined,
) {
    const view = session?.getView(tab.id) ?? null;
    const workspace = view?.mountedWorkspace.value ?? null;
    const toolbar = view?.toolbarSnapshot.value ?? null;
    const identity = session?.snapshot.value.identity ?? null;
    let recoverySignature: readonly unknown[] = [];
    try {
        recoverySignature = workspace?.getWorkspaceDocumentRecoveryChangeSignature?.() ?? [];
    } catch {
        // A capture failure is reported by the checkpoint builder.
    }
    return JSON.stringify([
        tab.id,
        paneId,
        session ? describeTabDocument(session.snapshot.value) : null,
        workspace !== null,
        identity?.revisionInfo?.token ?? null,
        identity?.revisionInfo?.documentRef ?? null,
        identity?.revisionInfo?.contentRevision ?? null,
        identity?.revisionInfo?.authority ?? null,
        toolbar?.hasPdf ?? null,
        toolbar?.currentPage ?? null,
        toolbar?.zoom ?? null,
        toolbar?.zoomMode ?? null,
        toolbar?.continuousScroll ?? null,
        toolbar?.viewMode ?? null,
        toolbar?.viewRotation ?? null,
        recoverySignature,
    ]);
}

// Distills every field the persisted checkpoint depends on into a cheap string
// and the mounted document owners, so checkpoint watchers can detect
// changes without rebuilding and serializing the full checkpoint per reactive
// tick. The field lists here must track buildWorkspaceCheckpoint's inputs: a
// checkpoint-relevant field missing from the signature delays re-persistence
// until any other watched field changes.
export function buildWorkspaceCheckpointChangeSignature(
    options: IBuildWorkspaceCheckpointSignatureOptions,
): IWorkspaceCheckpointChangeSignature {
    const tabSignatures = new Map(options.tabs.value.map(tab => [
        tab.id,
        buildTabSignature(
            tab,
            options.getPaneByTabId(tab.id)?.paneId ?? null,
            options.documentSessionsByTabId.value[tab.id],
        ),
    ]));
    const workspace = JSON.stringify([
        options.activePaneId.value,
        options.activeTabId.value,
        options.layout.value,
        options.panes.value.map(pane => [
            pane.paneId,
            pane.activeTabId,
            ...pane.tabIds,
        ]),
        [...tabSignatures.values()],
    ]);
    return {
        workspace,
        tabSignatures,
    };
}
