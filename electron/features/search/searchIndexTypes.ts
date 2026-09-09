import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type { TOcrIndexRotation } from '@contracts/ocrIndex';
import type { IOcrWord } from '@contracts/shared';

export interface IPageIndex {
    pageNumber: number;
    text: string;
    words?: IOcrWord[];
    pageWidth?: number;
    pageHeight?: number;
    rotation?: TOcrIndexRotation;
}

export interface IPdfSearchIndex {
    schemaVersion?: number;
    documentRevision: { token: TDocumentRevisionToken };
    pdfPath: string;
    createdAt: number;
    pages: IPageIndex[];
    pageCount?: number;
    textSource?: {
        kind: string;
        version: number;
    };
}
