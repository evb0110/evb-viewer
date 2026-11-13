export {
    assertNonEmptyPdfOutput,
    getPdfPageCount,
    QPDF_OUTPUT_SUCCESS_EXIT_CODES,
    QPDF_TIMEOUT_MS,
    runQpdfCommand,
} from '@electron/features/page-ops/main/qpdf';
export {extractPages} from '@electron/features/page-ops/main/pageStructure';
export {resolveNativePageOpsPath} from '@electron/features/page-ops/main/resolveNativePageOpsPath';
export {
    isPdfPageOpsCapabilityError,
    PdfPageOpsCapabilityError,
} from '@electron/features/page-ops/main/pageOpsErrors';
export type { TPdfPageOpsCapabilityErrorCode } from '@electron/features/page-ops/main/pageOpsErrors';
export { pageOpsMainBindings } from '@electron/features/page-ops/main/pageOpsMainBindings';
export {applyPageMetadataRemap} from '@electron/features/page-ops/main/pageMetadataRemap';
