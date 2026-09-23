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
    | 'split-capture';
