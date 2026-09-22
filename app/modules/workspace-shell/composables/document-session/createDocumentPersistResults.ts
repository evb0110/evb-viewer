// The four shapes a persistence attempt can end in. They are kept together so
// that "nothing was written" always carries why, and callers never have to
// guess whether a refused result was an error, a cancellation, or a document
// that moved on.
import type { TPdfSaveMode } from '@app/types/pdfContracts';
import type {
    IPdfPersistFailure,
    IPdfPersistResult,
} from '@app/types/pdfUi';
import type { TDocumentRef } from '@contracts/documentRef';
import { createFailedPdfPersistResult } from '@app/services/pdf-file/createFailedPdfPersistResult';
import { createPdfPersistResult } from '@app/services/pdf-file/createPdfPersistResult';

export function createDocumentPersistResults(getOriginalPath: () => TDocumentRef | null) {
    function createPersistResult(
        success: boolean,
        saveMode: TPdfSaveMode,
        didSaveAs: boolean,
        outPath: TDocumentRef | null = success && !didSaveAs ? getOriginalPath() : null,
        abortReason?: IPdfPersistResult['abortReason'],
        failure?: IPdfPersistFailure,
    ): IPdfPersistResult {
        return createPdfPersistResult(success, saveMode, didSaveAs, outPath, abortReason, failure);
    }

    /**
     * The document was replaced before the write completed. Nothing was
     * written, but nothing went wrong either, so callers must not report it as
     * a refused write against the document the user is looking at now.
     */
    function createStalePersistResult(
        saveMode: TPdfSaveMode,
        didSaveAs: boolean,
    ): IPdfPersistResult {
        return createPersistResult(false, saveMode, didSaveAs, null, 'stale');
    }

    /**
     * The Save As dialog produced no target path, which is how a dismissed
     * dialog arrives here. Reporting it as a failure would toast an error at a
     * user who just pressed Cancel.
     */
    function createCancelledPersistResult(saveMode: TPdfSaveMode): IPdfPersistResult {
        return createPersistResult(false, saveMode, true, null, 'cancelled');
    }

    return {
        createPersistResult,
        createFailedPersistResult: createFailedPdfPersistResult,
        createStalePersistResult,
        createCancelledPersistResult,
    };
}
