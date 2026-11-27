import {
    createMissingRevisionError,
    createStaleRevisionError,
    encodeDocumentMutationError,
    getDocumentMutationErrorPayload,
} from '@contracts/documentMutationErrors';
import {
    createMainOperationShuttingDownError,
    encodeMainOperationErrorEnvelope,
    getMainOperationErrorEnvelope,
} from '@contracts/mainOperationErrors';
import {requireDocumentRef} from '@contracts/documentRef';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';
import {SERIALIZABLE_ERROR_PREFIX} from '@contracts/serializableError';
import {parseWorkerTaskErrorFrame} from '@contracts/workerTaskErrorFrame';
import {describe, expect, it} from 'vitest';

describe('worker task error frame contract', () => {
    it('accepts frames extending the serializable error envelope with worker fields', () => {
        expect(
            parseWorkerTaskErrorFrame({
                message: 'worker failed',
                code: 'insufficient-scratch',
                name: 'ScanCleanupInsufficientScratchError',
                canceled: false,
                retryable: true,
                source: 'scan-cleanup',
                terminationUnproven: 'child pid 42 still alive',
                details: {
                    scratchShortfall: {
                        availableBytes: 512,
                        requiredBytes: 1024,
                    },
                },
            }),
        ).toEqual({
            message: 'worker failed',
            code: 'insufficient-scratch',
            name: 'ScanCleanupInsufficientScratchError',
            canceled: false,
            retryable: true,
            source: 'scan-cleanup',
            terminationUnproven: 'child pid 42 still alive',
            details: {
                scratchShortfall: {
                    availableBytes: 512,
                    requiredBytes: 1024,
                },
            },
        });

        expect(
            parseWorkerTaskErrorFrame({
                message: 'canceled',
                canceled: true,
            }),
        ).toEqual({
            message: 'canceled',
            canceled: true,
        });
    });

    it('rejects malformed frames, array frames, and strips unknown properties', () => {
        expect(parseWorkerTaskErrorFrame({message: 123})).toBeNull();
        expect(
            parseWorkerTaskErrorFrame(
                Object.assign([], {
                    message: 'failed',
                    canceled: true,
                }),
            ),
        ).toBeNull();
        expect(
            parseWorkerTaskErrorFrame({
                message: 'failed',
                code: '',
            }),
        ).toBeNull();
        expect(
            parseWorkerTaskErrorFrame({
                message: 'failed',
                terminationUnproven: {detail: 'not a string'},
            }),
        ).toBeNull();
        expect(
            parseWorkerTaskErrorFrame({
                message: 'failed',
                canceled: 'yes',
            }),
        ).toBeNull();
        expect(
            parseWorkerTaskErrorFrame({
                message: 'failed',
                extraUnknownField: 42,
            }),
        ).toEqual({message: 'failed'});
    });
});

describe('consolidated serializable IPC error prefixes', () => {
    it('encodes document mutation errors with SERIALIZABLE_ERROR_PREFIX and round-trips through IPC messages', () => {
        const ref = requireDocumentRef('/tmp/doc.pdf');
        const expected = requireDocumentRevisionToken('rev-1');
        const actual = requireDocumentRevisionToken('rev-2');
        const error = createStaleRevisionError({
            documentRef: ref,
            expectedRevision: expected,
            actualRevision: actual,
        });

        expect(error.message.startsWith(SERIALIZABLE_ERROR_PREFIX)).toBe(true);
        expect(
            encodeDocumentMutationError({
                code: 'MISSING_REVISION',
                message: 'missing',
            }).startsWith(SERIALIZABLE_ERROR_PREFIX),
        ).toBe(true);

        const ipcWrapped = new Error(`Error invoking remote method 'documents:save': Error: ${error.message}`);
        expect(getDocumentMutationErrorPayload(ipcWrapped)).toEqual({
            code: 'STALE_REVISION',
            message: 'Document changed while this edit was being prepared',
            details: {
                documentRef: ref,
                expectedRevision: expected,
                actualRevision: actual,
            },
        });

        const missing = createMissingRevisionError({documentRef: ref});
        expect(getDocumentMutationErrorPayload(new Error(missing.message))).toEqual({
            code: 'MISSING_REVISION',
            message: 'Document revision token is required',
            details: {documentRef: ref},
        });
        expect(getMainOperationErrorEnvelope(ipcWrapped)).toBeNull();
    });

    it('encodes main operation errors with SERIALIZABLE_ERROR_PREFIX and round-trips through IPC messages', () => {
        const error = createMainOperationShuttingDownError('closing now');

        expect(error.message.startsWith(SERIALIZABLE_ERROR_PREFIX)).toBe(true);
        expect(
            encodeMainOperationErrorEnvelope({
                code: 'shutting-down',
                message: 'closing now',
            }).startsWith(SERIALIZABLE_ERROR_PREFIX),
        ).toBe(true);

        const ipcWrapped = new Error(`Error invoking remote method 'ocr:run': Error: ${error.message}`);
        expect(getMainOperationErrorEnvelope(ipcWrapped)).toEqual({
            code: 'shutting-down',
            message: 'closing now',
        });
        expect(getMainOperationErrorEnvelope(new Error(`${SERIALIZABLE_ERROR_PREFIX}{"code":"shutting-down","message":""}`))).toEqual({
            code: 'shutting-down',
            message: 'Main process is shutting down',
        });
        expect(getDocumentMutationErrorPayload(ipcWrapped)).toBeNull();
    });

    it('terminates cyclic cause chains without throwing', () => {
        const cyclic: {cause?: unknown} = {};
        cyclic.cause = cyclic;
        expect(getDocumentMutationErrorPayload(cyclic)).toBeNull();
        expect(getMainOperationErrorEnvelope(cyclic)).toBeNull();
    });

    it('unwraps SuppressedError chains for serializable error envelopes cycle-safely', () => {
        const primary = createMainOperationShuttingDownError('primary shutdown');
        const disposer = createMainOperationShuttingDownError('disposer shutdown');
        const plain = new Error('cleanup failed');

        expect(getMainOperationErrorEnvelope(new SuppressedError(plain, primary))).toEqual({
            code: 'shutting-down',
            message: 'primary shutdown',
        });
        expect(getMainOperationErrorEnvelope(new SuppressedError(disposer, plain))).toEqual({
            code: 'shutting-down',
            message: 'disposer shutdown',
        });
        expect(getMainOperationErrorEnvelope(new SuppressedError(disposer, primary))).toEqual({
            code: 'shutting-down',
            message: 'primary shutdown',
        });
        expect(getMainOperationErrorEnvelope(new Error('wrapped', {cause: new SuppressedError(plain, primary)}))).toEqual({
            code: 'shutting-down',
            message: 'primary shutdown',
        });

        const cyclicSuppressed = new SuppressedError(plain, plain);
        cyclicSuppressed.suppressed = cyclicSuppressed;
        cyclicSuppressed.error = cyclicSuppressed;
        expect(getMainOperationErrorEnvelope(cyclicSuppressed)).toBeNull();
    });
});
