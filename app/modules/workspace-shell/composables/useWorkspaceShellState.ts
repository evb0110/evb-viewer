import type {
    ComputedRef,
    Ref,
} from 'vue';
import type { ITab } from '@app/types/tabs';
import {
    snapshotOccupiesTab,
    type IWorkspaceDocumentController,
} from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';

export interface IWorkspaceShellState {
    activeWorkspaceHasDocument: ComputedRef<boolean>;
    activeWorkspaceCanPrint: ComputedRef<boolean>;
    activeWorkspaceCanSave: ComputedRef<boolean>;
    activeWorkspaceCanSaveAs: ComputedRef<boolean>;
    activeWorkspaceCanRepairSave: ComputedRef<boolean>;
    activeWorkspaceCanOptimizePdf: ComputedRef<boolean>;
    activeWorkspaceInteractive: ComputedRef<boolean>;
    hasDocument: ComputedRef<boolean>;
    tabCount: ComputedRef<number>;
}

export interface IUseWorkspaceShellStateOptions {
    activeDocumentSession: Readonly<Ref<IWorkspaceDocumentController | null>>;
    tabs: Ref<ITab[]>;
}

export const useWorkspaceShellState = (options: IUseWorkspaceShellStateOptions): IWorkspaceShellState => {
    const activeToolbarSnapshot = computed(() => options.activeDocumentSession.value?.toolbarSnapshot.value ?? null);
    const activeWorkspaceHasDocument = computed(() => (
        activeToolbarSnapshot.value?.hasPdf === true
        || activeToolbarSnapshot.value?.isDjvuMode === true
    ));
    const activeWorkspaceCanPrint = computed(() => (
        activeWorkspaceHasDocument.value
        && activeToolbarSnapshot.value?.viewerCapabilities.print === true
    ));
    const activeWorkspaceCanSave = computed(() => activeToolbarSnapshot.value?.canSave === true);
    const activeWorkspaceCanSaveAs = computed(() => (
        activeWorkspaceHasDocument.value
        && activeToolbarSnapshot.value?.viewerCapabilities.saveAs === true
    ));
    const activeWorkspaceCanRepairSave = computed(() => activeToolbarSnapshot.value?.canRepairSave === true);
    const activeWorkspaceCanOptimizePdf = computed(() => activeToolbarSnapshot.value?.canOptimizePdf === true);
    const activeWorkspaceInteractive = computed(() => (
        activeWorkspaceHasDocument.value
        && options.activeDocumentSession.value?.snapshot.value.phase === 'presented'
        && activeToolbarSnapshot.value?.isOpeningDocument !== true
        && (activeToolbarSnapshot.value?.totalPages ?? 0) > 0
    ));
    const hasDocument = computed(() => {
        const session = options.activeDocumentSession.value;
        return activeWorkspaceHasDocument.value || (session !== null && snapshotOccupiesTab(session.snapshot.value));
    });
    const tabCount = computed(() => options.tabs.value.length);

    return {
        activeWorkspaceHasDocument,
        activeWorkspaceCanPrint,
        activeWorkspaceCanSave,
        activeWorkspaceCanSaveAs,
        activeWorkspaceCanRepairSave,
        activeWorkspaceCanOptimizePdf,
        activeWorkspaceInteractive,
        hasDocument,
        tabCount,
    };
};
