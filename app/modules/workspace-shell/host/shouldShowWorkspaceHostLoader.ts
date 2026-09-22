import { shouldShowWorkspacePlaceholder } from '@app/modules/workspace-shell/host/shouldShowWorkspacePlaceholder';

interface IWorkspaceHostLoaderSignals {
    hasQueuedSplitRestore: boolean;
    hasPendingDocumentHint: boolean;
    hasVisibleDocument: boolean;
    isDocumentOpenInFlight: boolean;
    hasHostError: boolean;
    isStartupOpenClaimPending: boolean;
}

export function shouldShowWorkspaceHostLoader(signals: IWorkspaceHostLoaderSignals) {
    return (
        !signals.hasHostError
        && signals.isStartupOpenClaimPending
        && !shouldShowWorkspacePlaceholder(signals)
    );
}
