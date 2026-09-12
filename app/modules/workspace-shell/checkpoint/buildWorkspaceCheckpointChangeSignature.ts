import type { Ref } from 'vue';
import type {
    IEditorPaneState,
    TEditorLayoutNode,
} from '@contracts/editorPanes';
import type { ITab } from '@app/types/tabs';
import type { IWorkspaceExpose } from '@app/types/workspaceExpose';
import type { IWorkspaceDocumentRecord } from '@app/modules/workspace-shell/state/workspaceDocumentRecord';

interface IBuildWorkspaceCheckpointSignatureOptions {
    panes: Ref<IEditorPaneState[]>;
    tabs: Ref<ITab[]>;
    layout: Ref<TEditorLayoutNode | null>;
    activePaneId: Ref<string | null>;
    activeTabId: Ref<string | null>;
    workspaceRefs: Ref<Map<string, IWorkspaceExpose>>;
    documentRecordsByTabId: Ref<Record<string, IWorkspaceDocumentRecord>>;
    getPaneByTabId(tabId: string): IEditorPaneState | null;
}

export interface IWorkspaceCheckpointChangeSignature {
    workspace: string;
    tabSignatures: Map<string, string>;
}

function buildTabSignature(
    tab: ITab,
    paneId: string | null,
    workspace: IWorkspaceExpose | null,
    record: IWorkspaceDocumentRecord | undefined,
) {
    const toolbar = record?.toolbarSnapshot ?? null;
    const identity = record?.documentIdentity ?? null;
    let workspaceDocumentRefs: readonly [unknown, unknown, boolean] = [
        null,
        null,
        false,
    ];
    try {
        const state = workspace?.getAutomationStateSnapshot();
        workspaceDocumentRefs = [
            state?.originalPath ?? null,
            state?.workingCopyPath ?? null,
            state?.requiresSaveAsOnFirstSave ?? false,
        ];
    } catch {
        // A deferred workspace can be mounted before its real expose is ready.
    }
    let annotationRecoverySignature: readonly unknown[] = [];
    try {
        const recovery = workspace?.captureCanonicalAnnotationRecovery?.();
        annotationRecoverySignature = recovery
            ? [
                recovery.annotationMutationGeneration,
                ...recovery.drafts.map(draft => [
                    draft.annotationId,
                    draft.generation,
                    draft.text,
                ]),
            ]
            : [];
    } catch {
        // A recovery capture failure is reported by the checkpoint builder.
    }
    return JSON.stringify([
        tab.id,
        paneId,
        tab.fileName,
        tab.originalPath,
        tab.documentInstanceId ?? null,
        tab.isDirty,
        tab.isDjvu,
        workspace !== null,
        ...workspaceDocumentRefs,
        record?.tab.fileName ?? null,
        record?.tab.originalPath ?? null,
        identity?.token ?? null,
        identity?.documentRef ?? null,
        identity?.contentRevision ?? null,
        identity?.authority ?? null,
        toolbar?.hasPdf ?? null,
        toolbar?.currentPage ?? null,
        toolbar?.zoom ?? null,
        toolbar?.zoomMode ?? null,
        toolbar?.continuousScroll ?? null,
        toolbar?.viewMode ?? null,
        toolbar?.viewRotation ?? null,
        record?.viewState.surfaceMode ?? null,
        annotationRecoverySignature,
    ]);
}

// Distills every field the persisted checkpoint depends on into a cheap string
// (the document revision identity stands in for the automation-owned
// source/working-copy refs it derives from), so checkpoint watchers can detect
// changes without rebuilding and serializing the full checkpoint per reactive
// tick. The field lists here must track buildWorkspaceCheckpoint's inputs: a
// checkpoint-relevant field missing from the signature delays re-persistence
// until any other watched field changes.
export function buildWorkspaceCheckpointChangeSignature(
    options: IBuildWorkspaceCheckpointSignatureOptions,
): IWorkspaceCheckpointChangeSignature {
    const records = options.documentRecordsByTabId.value;
    const mountedWorkspaces = options.workspaceRefs.value;
    const tabSignatures = new Map(options.tabs.value.map(tab => [
        tab.id,
        buildTabSignature(
            tab,
            options.getPaneByTabId(tab.id)?.paneId ?? null,
            mountedWorkspaces.get(tab.id) ?? null,
            records[tab.id],
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
