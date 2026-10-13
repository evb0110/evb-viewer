import type {ComputedRef} from 'vue';
import type { IWorkspaceExpose } from '@app/types/workspaceExpose';
import type { IWorkspaceDocumentController } from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import type { IFailureToastTarget } from '@app/composables/useFailureToast';
import type { TTranslateFn } from '@i18n-app';

export function findDocumentTabId(
    documentRef: string,
    documentSessionsByTabId: Readonly<Record<string, IWorkspaceDocumentController>>,
) {
    return Object.entries(documentSessionsByTabId).find(([
        ,
        session,
    ]) => {
        const identity = session.snapshot.value.identity;
        return identity.documentRef === documentRef
            || identity.workingCopyPath === documentRef
            || identity.originalPath === documentRef;
    })?.[0] ?? null;
}

/**
 * The completion toast's Save As saves the cleanup output it was raised for,
 * not whichever document is active when it is clicked. The output's tab is made
 * active first, because the workspace Save As acts on the active document.
 * When the output has no open tab, nothing is saved and the user is told so.
 */
export async function saveScanCleanupOutputAs(
    outputPath: string,
    activeWorkspace: ComputedRef<IWorkspaceExpose | null>,
    documentSessionsByTabId: ComputedRef<Readonly<Record<string, IWorkspaceDocumentController>>>,
    activateTab: (tabId: string) => void,
    toast: IFailureToastTarget,
    t: TTranslateFn,
): Promise<boolean> {
    const tabId = findDocumentTabId(outputPath, documentSessionsByTabId.value);
    if (tabId === null) {
        toast.add({
            color: 'warning',
            title: t('scanCleanup.outputClosedBeforeSaveAs'),
        });
        return false;
    }
    activateTab(tabId);
    await nextTick();
    return activeWorkspace.value?.handleSaveAs() ?? false;
}
