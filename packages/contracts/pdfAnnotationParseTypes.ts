import type {TDocumentRevisionToken} from '@contracts/documentRevision';
import type {TDocumentRef} from '@contracts/documentRef';
import type {
    IPdfAnnotationForeignEntry,
    IPdfAnnotationHighlightEntry,
    IPdfAnnotationNoteEntry,
    IPdfAnnotationNoteReply,
    IPdfAnnotationParseEntry,
    IPdfAnnotationParseOptionsWire,
    IPdfAnnotationParsePoint,
    IPdfAnnotationParseResult,
    IPdfAnnotationShapeEntry,
    IPdfAnnotationStampEntry,
    IPdfAnnotationStampImageReference,
    IPdfAnnotationTextBoxEntry,
    TPdfAnnotationParseEntity,
} from '@contracts/pdfAnnotationParseSchemas';

export const PDF_ANNOTATION_PARSE_MAX_CHUNK_BYTES = 512 * 1024;
export const PDF_ANNOTATION_PARSE_MAX_LINE_BYTES = 4 * 1024 * 1024;
export const PDF_ANNOTATION_PARSE_MAX_ENTRIES = 100_000;

export type {
    IPdfAnnotationForeignEntry,
    IPdfAnnotationHighlightEntry,
    IPdfAnnotationNoteEntry,
    IPdfAnnotationNoteReply,
    IPdfAnnotationParseEntry,
    IPdfAnnotationParsePoint,
    IPdfAnnotationParseResult,
    IPdfAnnotationShapeEntry,
    IPdfAnnotationStampEntry,
    IPdfAnnotationStampImageReference,
    IPdfAnnotationTextBoxEntry,
    TPdfAnnotationParseEntity,
};

export interface IPdfSidecarChunkOptions {chunkBytes?: number;}
export type IPdfAnnotationParseOptions = IPdfAnnotationParseOptionsWire & {signal?: AbortSignal;};
export interface IPdfAnnotationParseChunkOptions extends IPdfSidecarChunkOptions {}

export interface IPdfAnnotationParseSession {
    sessionId: string;
    documentRef: TDocumentRef;
    documentRevisionToken: TDocumentRevisionToken;
    pageCount: number;
    entryCount: number;
    totalBytes: number;
}

export interface IPdfAnnotationParseChunk {
    offset: number;
    nextOffset: number | null;
    byteLength: number;
    done: boolean;
    entries: IPdfAnnotationParseEntry[];
}

export type TPdfAnnotationParseBegin = (
    path: TDocumentRef,
    options: IPdfAnnotationParseOptions,
) => Promise<IPdfAnnotationParseSession>;
export type TPdfAnnotationParseReadChunk = (
    sessionId: string,
    offset: number,
    options?: IPdfAnnotationParseChunkOptions,
) => Promise<IPdfAnnotationParseChunk>;
export type TPdfAnnotationParseRelease = (sessionId: string) => Promise<boolean>;
export type TPdfAnnotationParseCancel = (sessionId: string) => Promise<{canceled: boolean}>;
export type TPdfAnnotationParse = (
    path: TDocumentRef,
    options: IPdfAnnotationParseOptions,
) => Promise<IPdfAnnotationParseResult>;
