import type { ISerializedPdfPersistenceLimits } from '@contracts/documentPersistenceFrames';

export {
    PDF_PERSISTENCE_DEFAULT_ACK_TIMEOUT_MS,
    PDF_PERSISTENCE_DEFAULT_CHUNK_BYTES,
    PDF_PERSISTENCE_DEFAULT_MAX_IN_FLIGHT_CHUNKS,
    PDF_PERSISTENCE_DEFAULT_PROGRESS_TIMEOUT_MS,
    PDF_PERSISTENCE_DEFAULT_RESULT_TIMEOUT_MS,
    SERIALIZED_PDF_PERSISTENCE_PROTOCOL_VERSION,
    createPdfPersistenceAckFrame,
    createPdfPersistenceErrorFrame,
    createPdfPersistenceReadyFrame,
    createPdfPersistenceResultFrame,
    createPdfPersistenceStagedFrame,
    describePdfPersistenceMessage,
    getPdfPersistenceChunkBytes,
    isPdfPersistencePreloadToMainPayload,
    normalizePdfPersistencePreloadToMainPayload,
} from '@contracts/documentPersistenceFrames';

export type {
    ISerializedPdfPersistenceLimits,
    TPdfPersistenceErrorPhase,
} from '@contracts/documentPersistenceFrames';

export interface IBeginSerializedPdfPersistenceResult extends ISerializedPdfPersistenceLimits {sessionId: string;}

export interface IBeginSerializedPdfSaveAsResult extends Partial<ISerializedPdfPersistenceLimits> {
    sessionId: string | null;
    path: string | null;
}
