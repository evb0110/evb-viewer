import type { IWorkspaceToolbarSnapshot } from '@app/types/workspaceExpose';
import { hasWorkspaceViewerDocumentCapabilities } from '@app/modules/workspace-shell/viewers/workspaceViewerAdapters';

interface IWorkspaceHostPlaceholderSignals {
    hasAcceptedDocument: boolean;
    hasQueuedSplitRestore: boolean;
    hasPendingDocumentHint: boolean;
    hasVisibleDocument: boolean;
    isDocumentOpenInFlight: boolean;
}

export function shouldShowWorkspacePlaceholder(signals: IWorkspaceHostPlaceholderSignals) {
    // A title-only pending hint is still startup metadata, so it should keep
    // the lightweight Recent Files surface. Once an open transaction exists,
    // the workspace owns the surface even before page geometry is available;
    // its document skeleton is the progress state the user should see. A
    // generated combine settles its transaction once the PDF is accepted,
    // before the first page is presented; the accepted document keeps that
    // ownership so Start does not flash back until the page arrives.
    const hasOpeningSurfaceOwner = signals.hasVisibleDocument
        || signals.isDocumentOpenInFlight
        || signals.hasAcceptedDocument;
    return (
        !signals.hasQueuedSplitRestore
        && !hasOpeningSurfaceOwner
    );
}

export function shouldKeepWorkspacePendingDocumentHint(signals: {
    hasDocumentHint: boolean;
    isClosingDocument: boolean;
    mountedSnapshot: IWorkspaceToolbarSnapshot | null;
}) {
    return signals.hasDocumentHint
        && !signals.isClosingDocument
        && signals.mountedSnapshot?.hasOpenError !== true
        && !(
            signals.mountedSnapshot?.initialVisualReady
            && hasWorkspaceViewerDocumentCapabilities(signals.mountedSnapshot.viewerCapabilities)
        );
}
