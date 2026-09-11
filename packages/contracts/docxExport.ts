import type { TDocumentRef } from '@contracts/documentRef';
import type {TSessionId} from '@contracts/shared';

/** Binary chunks accepted by the desktop DOCX output sink. */
export type TDocxExportChunkSource = Iterable<Uint8Array> | AsyncIterable<Uint8Array>;

/** Optional file capability kept separate from the legacy all-at-once API. */
export interface IDocxExportFileCapability {
    beginDocxFileStream: (path: TDocumentRef) => Promise<IDocxExportStreamBeginResult>;
    writeDocxFileStreamChunk: (sessionId: TSessionId, chunk: Uint8Array) => Promise<boolean>;
    commitDocxFileStream: (sessionId: TSessionId) => Promise<boolean>;
    cancelDocxFileStream: (sessionId: TSessionId) => Promise<boolean>;
    /** Kept for direct preload clients and existing unit fixtures, never exposed through contextBridge. */
    writeDocxFileChunks?: (
        path: TDocumentRef,
        chunks: TDocxExportChunkSource,
        signal?: AbortSignal,
    ) => Promise<boolean>;
}

export const DOCX_EXPORT_STREAM_CHANNELS = {
    begin: 'file:writeDocx:stream:begin',
    writeChunk: 'file:writeDocx:stream:chunk',
    commit: 'file:writeDocx:stream:commit',
    cancel: 'file:writeDocx:stream:cancel',
} as const;

export const DOCX_EXPORT_STREAM_MAX_CHUNK_BYTES = 4 * 1024 * 1024;
export const DOCX_EXPORT_STREAM_SESSION_TIMEOUT_MS = 10 * 60 * 1000;

export interface IDocxExportStreamBeginResult {readonly sessionId: TSessionId;}

/** Invoke contract for the validated Electron IPC boundary. */
export interface IDocxExportInvokeMap {
    [DOCX_EXPORT_STREAM_CHANNELS.begin]: {
        args: [filePath: string];
        result: IDocxExportStreamBeginResult;
    };
    [DOCX_EXPORT_STREAM_CHANNELS.writeChunk]: {
        args: [sessionId: TSessionId, chunk: Uint8Array];
        result: boolean;
    };
    [DOCX_EXPORT_STREAM_CHANNELS.commit]: {
        args: [sessionId: TSessionId];
        result: boolean;
    };
    [DOCX_EXPORT_STREAM_CHANNELS.cancel]: {
        args: [sessionId: TSessionId];
        result: boolean;
    };
}
