import type { TPdfSaveMode } from '@app/types/pdfContracts';
import type { IPdfPersistFailure } from '@app/types/pdfUi';
import { createPdfPersistResult } from '@app/services/pdf-file/createPdfPersistResult';

export function createFailedPdfPersistResult(
    saveMode: TPdfSaveMode,
    didSaveAs: boolean,
    failure?: IPdfPersistFailure,
) {
    return createPdfPersistResult(false, saveMode, didSaveAs, null, undefined, failure);
}
