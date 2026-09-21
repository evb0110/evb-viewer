export type TDocumentOperationKind =
    | 'save'
    | 'save-as'
    | 'repair-save'
    | 'optimize-pdf'
    | 'page-operation'
    | 'docx-export'
    | 'print-materialize'
    | 'ocr-apply'
    | 'raster-export'
    | 'recovery-snapshot'
    | 'split-capture';
