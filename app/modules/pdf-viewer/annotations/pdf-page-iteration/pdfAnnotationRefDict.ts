import type {
    PDFDict,
    PDFRef,
} from 'pdf-lib';

export interface IPdfAnnotationRefDict {
    dict: PDFDict;
    ref: PDFRef;
}
