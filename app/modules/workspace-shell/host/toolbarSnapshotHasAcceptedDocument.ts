import type { IWorkspaceToolbarSnapshot } from '@app/types/workspaceExpose';
import { hasWorkspaceViewerDocumentCapabilities } from '@app/modules/workspace-shell/viewers/workspaceViewerAdapters';

/**
 * The workspace has loaded a document with pages, even if its first page has
 * not painted yet. Generated PDFs settle their open transaction here.
 */
export function toolbarSnapshotHasAcceptedDocument(toolbarSnapshot: IWorkspaceToolbarSnapshot | null | undefined) {
    return Boolean(toolbarSnapshot?.hasPdf
        && toolbarSnapshot.totalPages > 0
        && !toolbarSnapshot.hasOpenError
        && hasWorkspaceViewerDocumentCapabilities(toolbarSnapshot.viewerCapabilities));
}
