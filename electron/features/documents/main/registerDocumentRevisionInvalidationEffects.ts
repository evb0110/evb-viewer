import type {IDocumentRevisionChangedEvent} from '@contracts/documentRevision';
import {revisionTextIdentity} from '@document-store/documentDirectory';
import {cancelOcrJobsForWorkingCopy} from '@electron/features/ocr/public/index';
import {searchService} from '@electron/features/search/public';
import {getOpenDocument, onDocumentRevisionChanged} from '@electron/file-access/documentStore';

let unsubscribeRevisionInvalidationEffects: (() => void) | null = null;

/**
 * Returns true only when the document's current and previous revisions both carry
 * the exact same valid versioned text-identity token (`ti1:...`), proving extracted
 * text and geometry did not change across this revision transition.
 */
export function hasPreservedDocumentTextIdentity(event: IDocumentRevisionChangedEvent): boolean {
    if (event.previousToken === undefined) {
        return false;
    }
    const openDoc = getOpenDocument(event.documentRef);
    if (!openDoc || openDoc.session.token() !== event.token) {
        return false;
    }
    const currentIdentity = openDoc.doc.state().textIdentity;
    if (currentIdentity === null) {
        return false;
    }
    const previousId = openDoc.session.parseRevisionId(event.previousToken);
    if (previousId < 1) {
        return false;
    }
    const previousIdentity = revisionTextIdentity(openDoc.doc.snapshot(), previousId);
    return previousIdentity !== null && previousIdentity === currentIdentity;
}

export function registerDocumentRevisionInvalidationEffects(): () => void {
    if (unsubscribeRevisionInvalidationEffects) {
        return unsubscribeRevisionInvalidationEffects;
    }

    unsubscribeRevisionInvalidationEffects = onDocumentRevisionChanged((event: IDocumentRevisionChangedEvent) => {
        const reason = `Document revision changed: ${event.reason}`;
        cancelOcrJobsForWorkingCopy(event.documentRef, reason);
        if (!hasPreservedDocumentTextIdentity(event)) {
            searchService.cancelRequestsForPdfPath(event.documentRef, reason);
        }
    });
    return unsubscribeRevisionInvalidationEffects;
}
