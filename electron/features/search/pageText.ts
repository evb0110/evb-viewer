import type { IDocumentTextPageLayout } from '@contracts/documentTextCatalog';

export interface IPageText {
    pageNumber: number;
    text: string;
    /** How the page sets its text, where an EVB OCR layer records it. */
    layout?: IDocumentTextPageLayout;
}
