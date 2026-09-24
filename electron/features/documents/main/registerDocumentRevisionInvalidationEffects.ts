import type { IDocumentRevisionChangedEvent } from '@contracts/documentRevision';
import { cancelOcrJobsForWorkingCopy } from '@electron/features/ocr/public/index';
import { searchService } from '@electron/features/search/public';
import { onWorkingCopyRevisionChanged } from '@electron/file-access/documentRevisionStore';

let unsubscribeRevisionInvalidationEffects: (() => void) | null = null;

export function registerDocumentRevisionInvalidationEffects(): () => void {
    if (unsubscribeRevisionInvalidationEffects) {
        return unsubscribeRevisionInvalidationEffects;
    }

    unsubscribeRevisionInvalidationEffects = onWorkingCopyRevisionChanged((event: IDocumentRevisionChangedEvent) => {
        const reason = `Document revision changed: ${event.reason}`;
        cancelOcrJobsForWorkingCopy(event.documentRef, reason);
        searchService.cancelRequestsForPdfPath(event.documentRef, reason);
    });
    return unsubscribeRevisionInvalidationEffects;
}
