import type {IPdfTextContent} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import type { IPdfPageMatches } from '@app/types/pdfUi';
export interface IPageHighlightSignatureState {
    signatureByPage: Map<number, string>;
    pendingRoot: HTMLElement | null;
    rafId: number;
    continuationRafId: number;
    refreshVersion: number;
}

export type TTextLayerTextContentSource = IPdfTextContent | ReadableStream;
export type TPageMatchEntry = IPdfPageMatches['matches'][number];
