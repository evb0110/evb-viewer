import type {ComputedRef} from 'vue';
import type { IWorkspaceExpose } from '@app/types/workspaceExpose';
import type { IWorkspaceDocumentController } from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';

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
 */
export async function saveScanCleanupOutputAs(
    outputPath: string,
    activeWorkspace: ComputedRef<IWorkspaceExpose | null>,
    documentSessionsByTabId: ComputedRef<Readonly<Record<string, IWorkspaceDocumentController>>>,
    activateTab: (tabId: string) => void,
): Promise<boolean> {
    const tabId = findDocumentTabId(outputPath, documentSessionsByTabId.value);
    if (tabId === null) {
        return false;
    }
    activateTab(tabId);
    await nextTick();
    return activeWorkspace.value?.handleSaveAs() ?? false;
}
