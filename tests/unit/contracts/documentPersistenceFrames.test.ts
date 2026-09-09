import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    PDF_PERSISTENCE_DEFAULT_ACK_TIMEOUT_MS,
    PDF_PERSISTENCE_DEFAULT_CHUNK_BYTES,
    PDF_PERSISTENCE_DEFAULT_MAX_IN_FLIGHT_CHUNKS,
    PDF_PERSISTENCE_DEFAULT_PROGRESS_TIMEOUT_MS,
    PDF_PERSISTENCE_DEFAULT_RESULT_TIMEOUT_MS,
    SERIALIZED_PDF_PERSISTENCE_PROTOCOL_VERSION,
    createPdfPersistenceAckFrame,
    createPdfPersistenceCancelFrame,
    createPdfPersistenceChunkFrame,
    createPdfPersistenceCompleteFrame,
    createPdfPersistenceErrorFrame,
    createPdfPersistenceReadyFrame,
    createPdfPersistenceResultFrame,
    createPdfPersistenceStagedFrame,
    getPdfPersistenceChunkBytes,
    isPdfPersistencePreloadToMainPayload,
    isSerializedPdfPersistenceLimits,
    normalizePdfPersistencePreloadToMainPayload,
    parsePdfPersistenceMainToPreloadFrame,
} from '@contracts/documentPersistenceFrames';
import {requireDocumentRef} from '@contracts/documentRef';
import {
    requireLeaseId,
    requireSessionId,
} from '@contracts/shared';

const validValidation = {
    isValid: true,
    tool: 'qpdf' as const,
    errors: [],
    warnings: [],
};
const validStagedOutput = {
    receiptVersion: 1 as const,
    artifactKind: 'pdf' as const,
    path: requireDocumentRef('/tmp/staged.pdf'),
    size: 512,
    sha256: 'a'.repeat(64),
    fileIdentity: {
        platform: 'posix' as const,
        deviceId: '1',
        inode: '2',
    },
    validations: {
        qpdfCheck: true,
        qpdfResult: validValidation,
        tailCheck: true,
        semanticCheck: false,
        fsynced: true,
    },
    leaseId: requireLeaseId('lease-1'),
    revision: null,
};

function wrapMessageEventPayload(payload: unknown, depth: number) {
    let currentPayload = payload;
    for (let index = 0; index < depth; index += 1) {
        currentPayload = {
            data: currentPayload,
            ports: [],
        };
    }
    return currentPayload;
}

describe('document persistence frame contracts', () => {
    it('validates negotiated serialized PDF persistence limits', () => {
        const limits = {
            protocolVersion: SERIALIZED_PDF_PERSISTENCE_PROTOCOL_VERSION,
            maxChunkBytes: PDF_PERSISTENCE_DEFAULT_CHUNK_BYTES,
            maxInFlightChunks: PDF_PERSISTENCE_DEFAULT_MAX_IN_FLIGHT_CHUNKS,
            maxTotalBytes: 1024,
            ackTimeoutMs: PDF_PERSISTENCE_DEFAULT_ACK_TIMEOUT_MS,
            progressTimeoutMs: PDF_PERSISTENCE_DEFAULT_PROGRESS_TIMEOUT_MS,
            resultTimeoutMs: PDF_PERSISTENCE_DEFAULT_RESULT_TIMEOUT_MS,
        };

        expect(isSerializedPdfPersistenceLimits(limits)).toBe(true);
        expect(isSerializedPdfPersistenceLimits({
            ...limits,
            protocolVersion: SERIALIZED_PDF_PERSISTENCE_PROTOCOL_VERSION + 1,
        })).toBe(false);
        expect(isSerializedPdfPersistenceLimits({
            ...limits,
            maxChunkBytes: 0,
        })).toBe(false);
        expect(isSerializedPdfPersistenceLimits({
            ...limits,
            progressTimeoutMs: undefined,
        })).toBe(false);
    });

    it('encodes and parses main-to-preload frames', () => {
        expect(parsePdfPersistenceMainToPreloadFrame(createPdfPersistenceReadyFrame())).toEqual({type: 'ready'});
        expect(parsePdfPersistenceMainToPreloadFrame(createPdfPersistenceAckFrame(2, 512))).toEqual({
            type: 'ack',
            seq: 2,
            receivedBytes: 512,
        });
        expect(parsePdfPersistenceMainToPreloadFrame(createPdfPersistenceResultFrame(requireDocumentRef('/tmp/out.pdf'), validValidation)))
            .toEqual({
                type: 'result',
                path: '/tmp/out.pdf',
                validation: validValidation,
            });
        expect(parsePdfPersistenceMainToPreloadFrame(createPdfPersistenceStagedFrame(
            requireSessionId('session-1'),
            validStagedOutput,
            validValidation,
        ))).toEqual({
            type: 'staged',
            sessionId: 'session-1',
            stagedOutput: validStagedOutput,
            validation: validValidation,
        });
        expect(parsePdfPersistenceMainToPreloadFrame(createPdfPersistenceErrorFrame(new Error('stream failed'), {
            phase: 'streaming',
            seq: 3,
        }))).toEqual({
            type: 'error',
            code: 'PROTOCOL_ERROR',
            phase: 'streaming',
            retryable: false,
            expected: false,
            error: 'stream failed',
            seq: 3,
        });
    });

    it('normalizes malformed error frames without accepting unknown codes or phases', () => {
        expect(parsePdfPersistenceMainToPreloadFrame({
            type: 'error',
            code: 'FUTURE_CODE',
            phase: 'future-phase',
            retryable: true,
            expected: true,
            error: 'future failed',
            seq: 4,
        })).toEqual({
            type: 'error',
            code: 'UNKNOWN',
            phase: 'streaming',
            retryable: true,
            expected: true,
            error: 'future failed',
            seq: 4,
        });

        expect(parsePdfPersistenceMainToPreloadFrame({
            type: 'ack',
            seq: 1.5,
        })).toBeNull();
        expect(parsePdfPersistenceMainToPreloadFrame({
            type: 'staged',
            sessionId: 'session-1',
            stagedOutput: {
                ...validStagedOutput,
                leaseId: '',
            },
            validation: validValidation,
        })).toBeNull();
    });

    it('encodes preload-to-main frames and coerces accepted chunk byte payloads', () => {
        const bytes = new Uint8Array([
            1,
            2,
            3,
        ]);
        const chunkFrame = createPdfPersistenceChunkFrame(0, bytes);

        expect(chunkFrame).toEqual({
            type: 'chunk',
            seq: 0,
            bytes,
        });
        expect(createPdfPersistenceCompleteFrame()).toEqual({type: 'complete'});
        expect(createPdfPersistenceCancelFrame()).toEqual({type: 'cancel'});
        expect(getPdfPersistenceChunkBytes(bytes)).toBe(bytes);
        expect(Array.from(getPdfPersistenceChunkBytes(bytes.buffer))).toEqual([
            1,
            2,
            3,
        ]);
        expect(() => getPdfPersistenceChunkBytes({})).toThrow('Invalid PDF persistence chunk');
    });

    it('validates preload-to-main payloads per frame type', () => {
        expect(isPdfPersistencePreloadToMainPayload(createPdfPersistenceCompleteFrame())).toBe(true);
        expect(isPdfPersistencePreloadToMainPayload(createPdfPersistenceCancelFrame())).toBe(true);
        expect(isPdfPersistencePreloadToMainPayload(createPdfPersistenceChunkFrame(0, new Uint8Array([1])))).toBe(true);
        expect(isPdfPersistencePreloadToMainPayload({
            type: 'chunk',
            seq: 0,
        })).toBe(false);
        expect(isPdfPersistencePreloadToMainPayload({
            type: 'chunk',
            seq: '0',
            bytes: new Uint8Array([1]),
        })).toBe(false);
        expect(isPdfPersistencePreloadToMainPayload({type: 'future'})).toBe(false);
    });

    it('unwraps Electron MessagePort event wrappers without recursing through cycles', () => {
        expect(normalizePdfPersistencePreloadToMainPayload(
            wrapMessageEventPayload({type: 'complete'}, 8),
        )).toEqual({type: 'complete'});

        const cyclicMessage: {
            data: unknown;
            ports: unknown[];
        } = {
            data: null,
            ports: [],
        };
        cyclicMessage.data = cyclicMessage;

        expect(normalizePdfPersistencePreloadToMainPayload(cyclicMessage)).toBe(cyclicMessage);
    });
});
