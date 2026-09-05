import type {
    TPdfAnnotationLineEndStyle,
    TPdfAnnotationMarkupSubtype,
    TPdfAnnotationShapePdfSubtype,
    TPdfAnnotationShapeType,
} from '@contracts/annotations';
import type {TDocumentRevisionToken} from '@contracts/documentRevision';
import type {TDocumentRef} from '@contracts/documentRef';
import type {IMarkerRect} from '@contracts/geometry';
import type {TPageIndex} from '@contracts/pageNumbers';

export const PDF_ANNOTATION_PARSE_MAX_CHUNK_BYTES = 512 * 1024;
export const PDF_ANNOTATION_PARSE_MAX_LINE_BYTES = 4 * 1024 * 1024;
export const PDF_ANNOTATION_PARSE_MAX_ENTRIES = 100_000;

export interface IPdfSidecarChunkOptions {chunkBytes?: number;}

interface IPdfAnnotationParseIdentityFields {
    pageIndex: TPageIndex;
    objectNumber: number;
    generationNumber: number;
    name: string;
    author: string | null;
    createdAt: number | null;
    modifiedAt: number | null;
}

export interface IPdfAnnotationTextBoxEntry extends IPdfAnnotationParseIdentityFields {
    kind: 'text-box';
    text: string;
    rect: IMarkerRect;
    rotation: 0 | 90 | 180 | 270;
    fontSize: number;
    color: string;
}

export interface IPdfAnnotationNoteReply {
    objectNumber: number;
    generationNumber: number;
    contents: string;
    author: string | null;
    createdAt: number | null;
    modifiedAt: number | null;
}

export interface IPdfAnnotationNoteEntry extends IPdfAnnotationParseIdentityFields {
    kind: 'note';
    position: IMarkerRect;
    contents: string;
    color: string | null;
    open: boolean;
    replies: IPdfAnnotationNoteReply[];
}

export interface IPdfAnnotationHighlightEntry extends IPdfAnnotationParseIdentityFields {
    kind: 'highlight';
    subtype: TPdfAnnotationMarkupSubtype;
    quadPoints: IMarkerRect[];
    color: string;
    opacity: number;
    contents: string;
}

export interface IPdfAnnotationStampImageReference {
    objectNumber: number;
    generationNumber: number;
    byteLength: number;
    sha256: string;
}

export interface IPdfAnnotationStampEntry extends IPdfAnnotationParseIdentityFields {
    kind: 'stamp';
    rect: IMarkerRect;
    rotation: 0 | 90 | 180 | 270;
    image: IPdfAnnotationStampImageReference;
}

export interface IPdfAnnotationParsePoint {
    x: number;
    y: number;
}

export interface IPdfAnnotationShapeEntry extends IPdfAnnotationParseIdentityFields {
    kind: 'shape';
    stableKey: string | null;
    pdfSubtype: TPdfAnnotationShapePdfSubtype;
    type: TPdfAnnotationShapeType;
    x: number;
    y: number;
    width: number;
    height: number;
    x2: number | null;
    y2: number | null;
    color: string;
    fillColor: string | null;
    opacity: number;
    strokeWidth: number;
    points: IPdfAnnotationParsePoint[] | null;
    strokes: IPdfAnnotationParsePoint[][] | null;
    lineStartStyle: TPdfAnnotationLineEndStyle | null;
    lineEndStyle: TPdfAnnotationLineEndStyle | null;
}

export interface IPdfAnnotationForeignEntry {
    kind: 'foreign';
    pageIndex: TPageIndex;
    objectNumber: number;
    generationNumber: number;
    name: string;
    subtype: string;
    reason: string;
}

export type IPdfAnnotationParseEntry =
    | IPdfAnnotationTextBoxEntry
    | IPdfAnnotationNoteEntry
    | IPdfAnnotationHighlightEntry
    | IPdfAnnotationStampEntry
    | IPdfAnnotationShapeEntry
    | IPdfAnnotationForeignEntry;

export type TPdfAnnotationParseEntity = Exclude<IPdfAnnotationParseEntry, IPdfAnnotationForeignEntry>;

/**
 * The public, one-shot parse result. The streamed session types below remain
 * an implementation detail of the hosts, while callers receive the same wire
 * entries split into editable entities and inert foreign records.
 */
export interface IPdfAnnotationParseResult {
    documentRevisionToken: TDocumentRevisionToken;
    pageCount: number;
    entities: TPdfAnnotationParseEntity[];
    foreign: IPdfAnnotationForeignEntry[];
}

export interface IPdfAnnotationParseOptions {
    expectedDocumentRevisionToken: TDocumentRevisionToken;
    /** Renderer-only cancellation; IPC validators strip this before crossing into Electron. */
    signal?: AbortSignal;
}

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
