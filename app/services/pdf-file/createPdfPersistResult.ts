import type { TPdfSaveMode } from '@app/types/pdfContracts';
import type {
    IPdfPersistFailure,
    IPdfPersistResult,
} from '@app/types/pdfUi';
import type { TDocumentRef } from '@contracts/documentRef';

export function createPdfPersistResult(
    success: boolean,
    saveMode: TPdfSaveMode,
    didSaveAs: boolean,
    outPath: TDocumentRef | null,
    abortReason?: IPdfPersistResult['abortReason'],
    failure?: IPdfPersistFailure,
): IPdfPersistResult {
    return {
        success,
        outPath,
        saveMode,
        didSaveAs,
        ...(abortReason ? {abortReason} : {}),
        ...(failure === undefined ? {} : {failure}),
    };
}
