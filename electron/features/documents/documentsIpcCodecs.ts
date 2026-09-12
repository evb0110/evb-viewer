import { decodeTypedStagedArtifact } from '@contracts/stagedArtifacts';
import {
    PDF_PERSISTENCE_DEFAULT_ACK_TIMEOUT_MS,
    PDF_PERSISTENCE_DEFAULT_CHUNK_BYTES,
    PDF_PERSISTENCE_DEFAULT_MAX_IN_FLIGHT_CHUNKS,
    PDF_PERSISTENCE_DEFAULT_PROGRESS_TIMEOUT_MS,
    PDF_PERSISTENCE_DEFAULT_RESULT_TIMEOUT_MS,
    SERIALIZED_PDF_PERSISTENCE_PROTOCOL_VERSION,
    type ISerializedPdfPersistenceLimits,
} from '@contracts/documentPersistenceFrames';
import { isPdfValidationResult } from '@contracts/pdfConformance';
import {
    appendOptionalDocumentArg as appendOptional,
    decodePdfPathValidationResult as decodePathValidationResult,
    decodePdfRevisionOptions as decodeRevisionOptions,
    decodePdfSaveAsOptions as decodeSaveAsOptions,
    decodePdfValidation,
    decodeRequiredDocumentObject as decodeRequiredObject,
    decodeSaveAsWarning,
} from '@contracts/documentsPersistenceSchemas';
import {
    DOCUMENT_FILES_PLATFORM_FEATURE,
    DOCUMENT_OPEN_PLATFORM_FEATURE,
    DOCUMENT_PDF_PLATFORM_FEATURE,
    DOCUMENT_WORKING_COPY_PLATFORM_FEATURE,
} from '@contracts/documentsPlatformFeature';
import {
    DOCX_EXPORT_STREAM_CHANNELS,
    DOCX_EXPORT_STREAM_MAX_CHUNK_BYTES,
    type IDocxExportStreamBeginResult,
} from '@contracts/docxExport';
import type { TIpcCodecMap } from '@contracts/ipcMain';
import {
    parseDocumentRef,
    type TDocumentRef,
} from '@contracts/documentRef';
import { isRecord } from '@contracts/runtimeGuards';
import {
    requireSessionId,
    type TSessionId,
} from '@contracts/shared';
import {
    DOCUMENTS_CHANNELS,
    type IDocumentsInvokeMap,
} from '@electron/features/documents/contract';
import type {
    IBeginSerializedPdfPersistenceResult,
    IBeginSerializedPdfSaveAsResult,
} from '@electron/features/documents/serializedPdfPersistenceContract';
import {
    decodeBoundedArray,
    decodeSafeIntegerArg,
    decodeStringArg,
    decodeStringArrayArg,
    decodeUint8ArrayArg,
} from '@electron/platform-ipc/ipcArgumentValidation';
import {
    decodeBooleanResult,
    requireDecoded,
} from '@electron/platform-ipc/ipcCodecValidation';

function decodeRendererFileOpenRequest(value: unknown, fieldName: string) {
    const decoded = decodeRequiredObject(value, fieldName);
    const {
        filePath,
        token,
    } = decoded;
    if (typeof filePath !== 'string' || typeof token !== 'string') {
        throw new Error(`${fieldName} must carry string filePath and token`);
    }
    return {
        filePath,
        token,
    };
}

function decodeDocumentRef(value: unknown, fieldName: string) {
    const documentRef = parseDocumentRef(value);
    if (documentRef === null) {
        throw new Error(`${fieldName} must be an absolute document ref`);
    }
    return documentRef;
}

function decodeCommittedPathValidationResult(value: unknown) {
    if (!isRecord(value) || (value.path !== null && typeof value.path !== 'string')) {
        throw new Error('invalid committed PDF persistence result');
    }
    const warning = decodeSaveAsWarning(value.warning);
    return {
        path: value.path === null ? null : decodeDocumentRef(value.path, 'committed result.path'),
        validation: decodePdfValidation(value.validation),
        ...(warning === undefined ? {} : {warning}),
    };
}

function decodePositiveSafeInteger(value: unknown, fieldName: string): number {
    if (!Number.isSafeInteger(value) || typeof value !== 'number' || value < 1) {
        throw new Error(`${fieldName} must be a positive safe integer`);
    }
    return value;
}

function decodePersistenceLimits(value: Record<PropertyKey, unknown>): ISerializedPdfPersistenceLimits {
    if (value.protocolVersion !== SERIALIZED_PDF_PERSISTENCE_PROTOCOL_VERSION) {
        throw new Error('invalid PDF persistence protocol version');
    }
    return {
        protocolVersion: SERIALIZED_PDF_PERSISTENCE_PROTOCOL_VERSION,
        maxChunkBytes: decodePositiveSafeInteger(value.maxChunkBytes, 'maxChunkBytes'),
        maxInFlightChunks: decodePositiveSafeInteger(value.maxInFlightChunks, 'maxInFlightChunks'),
        maxTotalBytes: decodePositiveSafeInteger(value.maxTotalBytes, 'maxTotalBytes'),
        ackTimeoutMs: decodePositiveSafeInteger(value.ackTimeoutMs, 'ackTimeoutMs'),
        progressTimeoutMs: decodePositiveSafeInteger(value.progressTimeoutMs, 'progressTimeoutMs'),
        resultTimeoutMs: decodePositiveSafeInteger(value.resultTimeoutMs, 'resultTimeoutMs'),
    };
}

function decodePersistenceBeginResult(value: unknown): IBeginSerializedPdfPersistenceResult {
    if (!isRecord(value) || typeof value.sessionId !== 'string') {
        throw new Error('invalid serialized persistence begin result');
    }
    if (value.protocolVersion === undefined) {
        return {
            sessionId: requireSessionId(value.sessionId),
            protocolVersion: SERIALIZED_PDF_PERSISTENCE_PROTOCOL_VERSION,
            maxChunkBytes: PDF_PERSISTENCE_DEFAULT_CHUNK_BYTES,
            maxInFlightChunks: PDF_PERSISTENCE_DEFAULT_MAX_IN_FLIGHT_CHUNKS,
            maxTotalBytes: Number.MAX_SAFE_INTEGER,
            ackTimeoutMs: PDF_PERSISTENCE_DEFAULT_ACK_TIMEOUT_MS,
            progressTimeoutMs: PDF_PERSISTENCE_DEFAULT_PROGRESS_TIMEOUT_MS,
            resultTimeoutMs: PDF_PERSISTENCE_DEFAULT_RESULT_TIMEOUT_MS,
        };
    }
    return {
        sessionId: value.sessionId,
        ...decodePersistenceLimits(value),
    };
}

function decodeOptionalPositiveSafeInteger(value: unknown, fieldName: string): number | undefined {
    return value === undefined ? undefined : decodePositiveSafeInteger(value, fieldName);
}

function decodeSaveAsBeginResult(value: unknown): IBeginSerializedPdfSaveAsResult {
    if (
        !isRecord(value)
        || (value.sessionId !== null && typeof value.sessionId !== 'string')
        || (value.path !== null && typeof value.path !== 'string')
        || (
            value.protocolVersion !== undefined
            && value.protocolVersion !== SERIALIZED_PDF_PERSISTENCE_PROTOCOL_VERSION
        )
    ) {
        throw new Error('invalid serialized save-as begin result');
    }
    const maxChunkBytes = decodeOptionalPositiveSafeInteger(value.maxChunkBytes, 'maxChunkBytes');
    const maxInFlightChunks = decodeOptionalPositiveSafeInteger(value.maxInFlightChunks, 'maxInFlightChunks');
    const maxTotalBytes = decodeOptionalPositiveSafeInteger(value.maxTotalBytes, 'maxTotalBytes');
    const ackTimeoutMs = decodeOptionalPositiveSafeInteger(value.ackTimeoutMs, 'ackTimeoutMs');
    const progressTimeoutMs = decodeOptionalPositiveSafeInteger(value.progressTimeoutMs, 'progressTimeoutMs');
    const resultTimeoutMs = decodeOptionalPositiveSafeInteger(value.resultTimeoutMs, 'resultTimeoutMs');
    return {
        sessionId: value.sessionId === null ? null : requireSessionId(value.sessionId),
        path: value.path === null ? null : decodeDocumentRef(value.path, 'save-as result.path'),
        ...(value.protocolVersion === undefined
            ? {}
            : {protocolVersion: SERIALIZED_PDF_PERSISTENCE_PROTOCOL_VERSION}),
        ...(maxChunkBytes === undefined ? {} : {maxChunkBytes}),
        ...(maxInFlightChunks === undefined ? {} : {maxInFlightChunks}),
        ...(maxTotalBytes === undefined ? {} : {maxTotalBytes}),
        ...(ackTimeoutMs === undefined ? {} : {ackTimeoutMs}),
        ...(progressTimeoutMs === undefined ? {} : {progressTimeoutMs}),
        ...(resultTimeoutMs === undefined ? {} : {resultTimeoutMs}),
    };
}

const decodeValidationResult = (value: unknown) => requireDecoded(
    value,
    candidate => isPdfValidationResult(candidate) ? decodePdfValidation(candidate) : null,
    'PDF validation',
);

function decodeDocxStreamBeginResult(value: unknown): IDocxExportStreamBeginResult {
    if (!isRecord(value) || typeof value.sessionId !== 'string' || value.sessionId.trim().length === 0) {
        throw new Error('invalid DOCX stream begin result');
    }
    return {sessionId: requireSessionId(value.sessionId)};
}

function decodeDocxStreamChunkArgs(args: readonly unknown[]) {
    const sessionId = requireSessionId(decodeStringArg(args, 0, 'sessionId'));
    const chunk = decodeUint8ArrayArg(
        args,
        1,
        'chunk',
        DOCX_EXPORT_STREAM_MAX_CHUNK_BYTES,
    );
    if (chunk.byteLength === 0) {
        throw new Error('chunk must not be empty');
    }
    const decoded: [TSessionId, Uint8Array] = [
        sessionId,
        chunk,
    ];
    return decoded;
}

export const DOCUMENTS_IPC_CODECS = {
    ...DOCUMENT_OPEN_PLATFORM_FEATURE.ipcCodecs,
    ...DOCUMENT_WORKING_COPY_PLATFORM_FEATURE.ipcCodecs,
    ...DOCUMENT_FILES_PLATFORM_FEATURE.ipcCodecs,
    ...DOCUMENT_PDF_PLATFORM_FEATURE.ipcCodecs,
    [DOCUMENTS_CHANNELS.registerRendererFileOpenToken]: {
        decodeArgs: (args: readonly unknown[]) => [decodeStringArg(args, 0, 'token')],
        decodeResult: decodeBooleanResult,
    },
    [DOCUMENTS_CHANNELS.registerRendererFileOpenTokens]: {
        decodeArgs: (args: readonly unknown[]) => [decodeStringArrayArg(args, 0, 'tokens')],
        decodeResult: decodeBooleanResult,
    },
    [DOCUMENTS_CHANNELS.allowRendererFileOpen]: {
        decodeArgs: (args: readonly unknown[]) => [decodeRendererFileOpenRequest(args[0], 'request')],
        decodeResult: decodeBooleanResult,
    },
    [DOCUMENTS_CHANNELS.allowRendererFileOpenBatch]: {
        decodeArgs: (args: readonly unknown[]) => {
            const requests = decodeBoundedArray(args[0], 'requests', {
                allowEmpty: true,
                maxItems: 4_096,
            });
            return [requests.map(item => decodeRendererFileOpenRequest(item, 'request'))];
        },
        decodeResult: decodeBooleanResult,
    },
    [DOCUMENTS_CHANNELS.savePdfDataAs]: {
        decodeArgs: (args: readonly unknown[]) => {
            const base: [TDocumentRef, Uint8Array] = [
                decodeDocumentRef(decodeStringArg(args, 0, 'workingPath'), 'workingPath'),
                decodeUint8ArrayArg(args, 1, 'data'),
            ];
            const options = decodeSaveAsOptions(args[2]);
            if (options === undefined) {
                return base;
            }
            return appendOptional([
                ...base,
                options,
            ], decodeRevisionOptions(args[3]));
        },
        decodeResult: decodePathValidationResult,
    },
    [DOCUMENTS_CHANNELS.savePdfDataAsBegin]: {
        decodeArgs: (args: readonly unknown[]) => {
            const base: [TDocumentRef, number] = [
                decodeDocumentRef(decodeStringArg(args, 0, 'workingPath'), 'workingPath'),
                decodeSafeIntegerArg(args, 1, 'totalBytes'),
            ];
            const options = decodeSaveAsOptions(args[2]);
            if (options === undefined) {
                return base;
            }
            return appendOptional([
                ...base,
                options,
            ], decodeRevisionOptions(args[3]));
        },
        decodeResult: decodeSaveAsBeginResult,
    },
    [DOCUMENTS_CHANNELS.fileSavePdfData]: {
        decodeArgs: (args: readonly unknown[]) => appendOptional([
            decodeDocumentRef(decodeStringArg(args, 0, 'path'), 'path'),
            decodeUint8ArrayArg(args, 1, 'data'),
        ], decodeRevisionOptions(args[2])),
        decodeResult: decodeValidationResult,
    },
    [DOCUMENTS_CHANNELS.fileSavePdfDataBegin]: {
        decodeArgs: (args: readonly unknown[]) => appendOptional([
            decodeDocumentRef(decodeStringArg(args, 0, 'path'), 'path'),
            decodeSafeIntegerArg(args, 1, 'totalBytes'),
        ], decodeRevisionOptions(args[2])),
        decodeResult: decodePersistenceBeginResult,
    },
    [DOCUMENTS_CHANNELS.fileCommitStagedSerializedPdf]: {
        decodeArgs: (args: readonly unknown[]) => {
            const stagedOutput = decodeTypedStagedArtifact(args[1]);
            if (!stagedOutput) throw new Error('stagedOutput must be a typed staged artifact');
            return [
                requireSessionId(decodeStringArg(args, 0, 'sessionId')),
                stagedOutput,
            ];
        },
        decodeResult: decodeCommittedPathValidationResult,
    },
    [DOCUMENTS_CHANNELS.fileCancelStagedSerializedPdf]: {
        decodeArgs: (args: readonly unknown[]) => {
            const stagedOutput = decodeTypedStagedArtifact(args[1]);
            if (!stagedOutput) throw new Error('stagedOutput must be a typed staged artifact');
            return [
                requireSessionId(decodeStringArg(args, 0, 'sessionId')),
                stagedOutput,
            ];
        },
        decodeResult: decodeBooleanResult,
    },
    [DOCX_EXPORT_STREAM_CHANNELS.begin]: {
        decodeArgs: (args: readonly unknown[]) => [decodeStringArg(args, 0, 'filePath')],
        decodeResult: decodeDocxStreamBeginResult,
    },
    [DOCX_EXPORT_STREAM_CHANNELS.writeChunk]: {
        decodeArgs: decodeDocxStreamChunkArgs,
        decodeResult: decodeBooleanResult,
    },
    [DOCX_EXPORT_STREAM_CHANNELS.commit]: {
        decodeArgs: (args: readonly unknown[]) => [requireSessionId(decodeStringArg(args, 0, 'sessionId'))],
        decodeResult: decodeBooleanResult,
    },
    [DOCX_EXPORT_STREAM_CHANNELS.cancel]: {
        decodeArgs: (args: readonly unknown[]) => [requireSessionId(decodeStringArg(args, 0, 'sessionId'))],
        decodeResult: decodeBooleanResult,
    },
} satisfies TIpcCodecMap<IDocumentsInvokeMap>;
