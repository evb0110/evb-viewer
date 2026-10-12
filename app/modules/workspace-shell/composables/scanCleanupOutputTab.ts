import type {ComputedRef} from 'vue';
import {
    getDocumentWorkspace,
    type IWorkspaceDocumentController,
} from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
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
    )) : undefined;
    const warnClosed = () => {
        toast.add({
            color: 'warning',
            title: t('scanCleanup.outputClosedBeforeSaveAs'),
        });
    };
    return async () => {
        const output = findOutput();
        if (!output) {
            warnClosed();
            return false;
        }
        activateTab(output[0]);
        await nextTick();
        // Activation can open or close a document. Resolve again before the
        // owner supplies a mounted view for this document-wide command.
        const current = findOutput();
        if (!current) {
            warnClosed();
            return false;
        }
        return getDocumentWorkspace(current[1])?.handleSaveAs() ?? false;
    };
}
