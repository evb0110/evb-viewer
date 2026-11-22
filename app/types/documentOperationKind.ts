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
    | 'tab-transfer'
    | 'close';

/** The live operation owner lends its lease to work that is part of that operation. */
export interface IDocumentOperationOwnership {assertCurrent: () => void;}
/** Runs work as the next turn of the document's lease, or inside the turn its holder already owns. */
export type TRunWithDocumentOperationLease = <T>(kind: TDocumentOperationKind, operation: (ownership: IDocumentOperationOwnership) => Promise<T>, holder?: IDocumentOperationOwnership) => Promise<T>;
