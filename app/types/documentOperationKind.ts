export type TDocumentOperationKind =
    | 'save'
    | 'save-as'
    | 'repair-save'
    | 'optimize-pdf'
    | 'page-operation'
    | 'history'
    | 'docx-export'
    | 'print-materialize'
    | 'ocr-apply'
    | 'raster-export'
    | 'recovery-snapshot'
    | 'split-capture'
    | 'tab-transfer';

/** The live operation owner lends its lease to work that is part of that operation. */
export interface IDocumentOperationOwnership {assertCurrent: () => void;}
