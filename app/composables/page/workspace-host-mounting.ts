import type { ITab } from '@app/types/tabs';

interface IWorkspaceHostSignals {
    hasQueuedSplitRestore: boolean;
    hasDocumentHint: boolean;
}

export function hasDocumentMountHint(tab: Pick<ITab, 'fileName' | 'originalPath' | 'isDjvu'>) {
    return Boolean(tab.fileName || tab.originalPath || tab.isDjvu);
}

export function shouldAutoRequestWorkspace(signals: IWorkspaceHostSignals) {
    return signals.hasQueuedSplitRestore || signals.hasDocumentHint;
}

export function resolveWorkspaceRequestedState(
    currentRequested: boolean,
    signals: IWorkspaceHostSignals,
) {
    if (currentRequested) {
        return true;
    }

    return shouldAutoRequestWorkspace(signals);
}
