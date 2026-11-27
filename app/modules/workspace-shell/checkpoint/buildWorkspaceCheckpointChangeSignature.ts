import type {Ref} from 'vue';
import type {IEditorPaneState, TEditorLayoutNode} from '@contracts/editorPanes';
import type {ITab} from '@app/types/tabs';
import type {IWorkspaceDocumentRefs} from '@app/types/workspaceDocumentRecovery';
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
    /** Which documents the window presents and where: tabs, panes, document identity and dirtiness. Not views or their mounting. */
    structure: string;
    tabSignatures: Map<string, string>;
}

function buildTabSignature(tab: ITab, paneId: string | null, session: IWorkspaceDocumentController | undefined) {
    const view = session?.getView(tab.id) ?? null;
    const workspace = view?.mountedWorkspace.value ?? null;
    const toolbar = view?.toolbarSnapshot.value ?? null;
    const identity = session?.snapshot.value.identity ?? null;
    let refs: IWorkspaceDocumentRefs | null = null;
    try {
        refs = workspace?.getWorkspaceDocumentRefs() ?? null;
    } catch {
        // A capture failure is reported by the checkpoint builder.
    }
    // The document a tab holds, whether or not its view is mounted: a memory policy that unmounts
    // background views must not turn a tab switch into an immediate write.
    const structure = [
        tab.id,
        paneId,
        session ? describeTabDocument(session.snapshot.value) : null,
        identity?.revisionInfo?.documentRef ?? null,
    ];
    return {
        structure: JSON.stringify(structure),
        full: JSON.stringify([
            ...structure,
            workspace !== null,
            refs,
            toolbar?.hasPdf ?? null,
            toolbar?.currentPage ?? null,
            toolbar?.zoom ?? null,
            toolbar?.zoomMode ?? null,
            toolbar?.continuousScroll ?? null,
            toolbar?.viewMode ?? null,
            toolbar?.viewRotation ?? null,
        ]),
    };
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
    const tabs = options.tabs.value.map(
        (tab) =>
            [
                tab.id,
                buildTabSignature(tab, options.getPaneByTabId(tab.id)?.paneId ?? null, options.documentSessionsByTabId.value[tab.id]),
            ] as const,
    );
    const paneMembership = options.panes.value.map((pane) => [pane.paneId, ...pane.tabIds]);
    const workspace = JSON.stringify([
        options.activePaneId.value,
        options.activeTabId.value,
        options.layout.value,
        options.panes.value.map((pane) => [pane.paneId, pane.activeTabId, ...pane.tabIds]),
        tabs.map(([, signature]) => signature.full),
    ]);
    return {
        workspace,
        structure: JSON.stringify([paneMembership, tabs.map(([, signature]) => signature.structure)]),
        tabSignatures: new Map(tabs.map(([tabId, signature]) => [tabId, signature.full])),
    };
}
