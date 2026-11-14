import type { TDocumentRef } from '@contracts/documentRef';
import type {TSessionId} from '@contracts/shared';

/** Serial file capability kept separate from the legacy all-at-once API. */
export interface IDocxExportFileCapability {
    beginDocxFileStream: (path: TDocumentRef) => Promise<IDocxExportStreamBeginResult>;
    writeDocxFileStreamChunk: (sessionId: TSessionId, chunk: Uint8Array) => Promise<boolean>;
    commitDocxFileStream: (sessionId: TSessionId) => Promise<boolean>;
    cancelDocxFileStream: (sessionId: TSessionId) => Promise<boolean>;
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
