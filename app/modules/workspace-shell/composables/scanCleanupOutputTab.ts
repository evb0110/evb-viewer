import type {ComputedRef} from 'vue';
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
 * Capture once after opening the output. Only that instance in this window
 * may be saved, even when its former path belongs to another document now.
 */
export function createScanCleanupOutputSaveAs(
    outputPath: string,
    documentSessionsByTabId: ComputedRef<Readonly<Record<string, IWorkspaceDocumentController>>>,
    activateTab: (tabId: string) => void,
    toast: IFailureToastTarget,
    t: TTranslateFn,
): () => Promise<boolean> {
    const outputTabId = findDocumentTabId(outputPath, documentSessionsByTabId.value);
    const instanceId = outputTabId
        ? documentSessionsByTabId.value[outputTabId]?.snapshot.value.identity.documentInstanceId
        : null;
    const findOutput = () => instanceId ? Object.entries(documentSessionsByTabId.value).find(([
        , session,
    ]) => (
        session.snapshot.value.identity.documentInstanceId === instanceId
        && session.snapshot.value.identity.originalPath === outputPath
    )) : undefined;
    return async () => {
        const output = findOutput();
        const view = output?.[1].getView(output[0]);
        if (output) {activateTab(output[0]);}
        // The output tab's own view saves it. A view that failed or was
        // removed answers null; activation can also open or close a
        // document, so the output is resolved again once it has mounted.
        const workspace = await view?.whenMounted() ?? null;
        const saved = workspace && findOutput()?.[1] === output?.[1]
            ? await workspace.handleSaveAs()
            : false;
        if (!saved && !findOutput()) {toast.add({
            color: 'warning',
            title: t('scanCleanup.outputClosedBeforeSaveAs'),
        });}
        return saved;
    };
}
