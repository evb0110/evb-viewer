import {decodeTypedStagedArtifact} from '@contracts/stagedArtifacts';
import {IPC_INVOKE_REQUEST_ID_FIELD} from '@electron/platform-ipc/coreContract';
import type { IpcRenderer } from 'electron';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    DOCUMENTS_CHANNELS,
    DOCUMENTS_EVENT_CHANNELS,
} from '@electron/features/documents/contract';
import {
    DOCX_EXPORT_STREAM_CHANNELS,
    DOCX_EXPORT_STREAM_MAX_CHUNK_BYTES,
} from '@contracts/docxExport';
import { createDocumentsPreloadFileClient } from '@electron/features/documents/createDocumentsPreloadFileClient';
import {requireDocumentRef} from '@contracts/documentRef';
import type {TDocumentRef} from '@contracts/documentRef';
import {
    requirePageIndex,
    requirePageNumber,
} from '@contracts/pageNumbers';
import type {TPageNumber} from '@contracts/pageNumbers';
import {normalizePdfNativeModifiedAt} from '@contracts/nativePdfMutations';
import { MAX_DOCUMENT_ALLOCATION_BYTES } from '@contracts/electronApiDocuments';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';
import {
    requireLeaseId,
    requireRequestId,
} from '@contracts/shared';
import type {TRequestId} from '@contracts/shared';
import {requireEpochMs} from '@contracts/timestamps';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import {PDF_DECRYPT_PASSWORD_MAX_BYTES} from '@contracts/pdfDecryptSchemas';
import {waitForCondition} from '@tests/unit/electron/waitForCondition';

// These values deliberately violate their brands so the preload runtime guards are tested.
const invalidDocumentRef = 'relative.pdf' as TDocumentRef;
const invalidPageNumber = 0 as TPageNumber;
const invalidEmptyRequestId = '' as TRequestId;
const invalidWhitespaceRequestId = '   ' as TRequestId;

class FakeMessagePort {
    readonly close = vi.fn();
    readonly start = vi.fn();
    readonly listeners = new Set<(event: MessageEvent) => void>();
    readonly postedMessages: unknown[] = [];
    readonly postedTransfers: Transferable[][] = [];
    shouldThrowOnChunk = false;
    onPostMessage?: (message: {type?: unknown}) => void;

    addEventListener(_type: 'message', listener: (event: MessageEvent) => void) {
        this.listeners.add(listener);
    }

    removeEventListener(_type: 'message', listener: (event: MessageEvent) => void) {
        this.listeners.delete(listener);
    }

    postMessage(message: {type?: unknown}, transfer?: Transferable[]) {
        if (this.shouldThrowOnChunk && message.type === 'chunk') {
            throw new Error('chunk post failed');
        }
        this.postedMessages.push(message);
        this.postedTransfers.push(transfer ?? []);
        this.onPostMessage?.(message);
    }

    emit(data: unknown) {
        for (const listener of this.listeners) {
            listener({data} as MessageEvent);
        }
    }
}

interface INativeMutationInvokePayload {placedImages: Array<{source: unknown}>}






function createNativePlacedImage() {
    return {
        pageIndex: requirePageIndex(0),
        x: 0.1,
        y: 0.2,
        width: 0.3,
        height: 0.2,
        rotationDegrees: 0,
        mimeType: 'image/jpeg' as const,
        source: {
            path: requireDocumentRef('/tmp/image.jpg'),
            size: 3,
            sha256: 'a'.repeat(64),
            leaseId: requireLeaseId('image-lease'),
            revision: null,
        },
    };
}

function createStagedPdfArtifact() {
    const validation = {
        isValid: true,
        tool: 'qpdf' as const,
        errors: [],
        warnings: [],
    };
    return {
        validation,
        artifact: {
            receiptVersion: 1 as const,
            artifactKind: 'pdf' as const,
            path: '/tmp/staged.pdf',
            size: 5,
            sha256: 'a'.repeat(64),
            fileIdentity: {
                platform: 'posix' as const,
                deviceId: '1',
                inode: '2',
            },
            validations: {
                qpdfCheck: true,
                tailCheck: true,
                semanticCheck: false,
                fsynced: true,
                qpdfResult: validation,
            },
            leaseId: 'staged-lease',
            revision: null,
        },
    };
}

describe('createDocumentsPreloadFileClient', () => {
    const revisionOptions = { expectedDocumentRevisionToken: requireDocumentRevisionToken('revision-before-save') };
    const nativeModifiedAt = normalizePdfNativeModifiedAt('D:20260609133855+03\'00\'', 'modifiedAt');

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('preserves the typed staged PDF receipt across the Save As preload boundary', async () => {
        const ipcRenderer = {
            invoke: vi.fn(async () => '/tmp/saved.pdf'),
            send: vi.fn(),
            postMessage: vi.fn(),
        } satisfies Pick<IpcRenderer, 'invoke' | 'postMessage' | 'send'>;
        const client = createDocumentsPreloadFileClient(ipcRenderer);
        const stagedOutput = decodeTypedStagedArtifact(createStagedPdfArtifact().artifact);
        if (!stagedOutput) throw new Error('Invalid staged PDF fixture');
        await client.savePdfAs(requireDocumentRef('/tmp/working.pdf'), {stagedOutput}, revisionOptions);
        expect(ipcRenderer.invoke).toHaveBeenCalledWith(DOCUMENTS_CHANNELS.savePdfAs, '/tmp/working.pdf', {stagedOutput}, revisionOptions);
    });

    it('rejects invalid working-copy passwords before invoking IPC', () => {
        const ipcRenderer = {
            invoke: vi.fn(),
            send: vi.fn(),
            postMessage: vi.fn(),
        } satisfies Pick<IpcRenderer, 'invoke' | 'postMessage' | 'send'>;
        const client = createDocumentsPreloadFileClient(ipcRenderer);
        const oversizedPassword = 'x'.repeat(PDF_DECRYPT_PASSWORD_MAX_BYTES + 1);

        expect(() => client.createWorkingCopyFromData(
            'protected.pdf',
            Uint8Array.of(1),
            undefined,
            oversizedPassword,
        )).toThrow(`PDF password exceeds the ${PDF_DECRYPT_PASSWORD_MAX_BYTES}-byte limit`);
        expect(() => client.createWorkingCopyFromPath(
            requireDocumentRef('/tmp/protected.pdf'),
            undefined,
            null as never,
        )).toThrow(`PDF password exceeds the ${PDF_DECRYPT_PASSWORD_MAX_BYTES}-byte limit`);
        expect(ipcRenderer.invoke).not.toHaveBeenCalled();
    });

    it('validates and forwards native path print layout options', async () => {
        const ipcRenderer = {
            invoke: vi.fn(async () => ({success: true})),
            send: vi.fn(),
            postMessage: vi.fn(),
        } satisfies Pick<IpcRenderer, 'invoke' | 'postMessage' | 'send'>;
        const client = createDocumentsPreloadFileClient(ipcRenderer);
        const options = {
            pageNumbers: [
                requirePageNumber(2),
                requirePageNumber(5),
            ],
            viewMode: 'facing' as const,
            orientation: 'landscape' as const,
            requestId: requireRequestId('print-request-1'),
        };

        await expect(client.printPdfPath(requireDocumentRef('/tmp/document.pdf'), undefined, options))
            .resolves.toEqual({success: true});
        expect(ipcRenderer.invoke).toHaveBeenCalledWith(
            DOCUMENTS_CHANNELS.pdfPrintPath,
            '/tmp/document.pdf',
            undefined,
            options,
        );
        expect(() => client.printPdfPath(requireDocumentRef('/tmp/document.pdf'), undefined, {
            ...options,
            pageNumbers: [invalidPageNumber],
        })).toThrow('printPdfPath.options.pageNumbers[0] must be a positive safe integer');
        expect(ipcRenderer.invoke).toHaveBeenCalledOnce();
    });

    it('validates and forwards native data print handoff options', async () => {
        const ipcRenderer = {
            invoke: vi.fn(async (channel: string) => channel === DOCUMENTS_CHANNELS.pdfPrintCancel
                ? {canceled: true}
                : {success: true}),
            send: vi.fn(),
            postMessage: vi.fn(),
        } satisfies Pick<IpcRenderer, 'invoke' | 'postMessage' | 'send'>;
        const client = createDocumentsPreloadFileClient(ipcRenderer);
        const data = Uint8Array.of(1, 2, 3);
        const options = {requestId: requireRequestId('print-data-request-1')};

        await expect(client.printPdfData(data, 'document.pdf', options))
            .resolves.toEqual({success: true});
        await expect(client.cancelPdfPrint?.(requireRequestId(' print-data-request-1 ')))
            .resolves.toEqual({canceled: true});
        expect(ipcRenderer.invoke).toHaveBeenCalledWith(
            DOCUMENTS_CHANNELS.pdfPrintData,
            data,
            'document.pdf',
            options,
        );
        expect(ipcRenderer.invoke).toHaveBeenCalledWith(
            DOCUMENTS_CHANNELS.pdfPrintCancel,
            'print-data-request-1',
        );
        expect(() => client.printPdfData(data, 'document.pdf', {requestId: invalidEmptyRequestId}))
            .toThrow('printPdfData.options.requestId must be a non-empty bounded string');
        expect(() => client.cancelPdfPrint?.(invalidEmptyRequestId))
            .toThrow('cancelPdfPrint.requestId must not be empty');
        expect(ipcRenderer.invoke).toHaveBeenCalledTimes(2);
    });

    it('drops malformed native print-dialog events and removes the subscribed listener', () => {
        const listeners = new Map<string, (_event: unknown, payload: unknown) => void>();
        const ipcRenderer = {
            invoke: vi.fn(),
            send: vi.fn(),
            postMessage: vi.fn(),
            on: vi.fn((channel: string, handler: (_event: unknown, payload: unknown) => void) => {
                listeners.set(channel, handler);
                return undefined as never;
            }),
            removeListener: vi.fn(),
        } satisfies Pick<IpcRenderer, 'invoke' | 'postMessage' | 'send' | 'on' | 'removeListener'>;
        const client = createDocumentsPreloadFileClient(ipcRenderer);
        const callback = vi.fn();
        const unsubscribe = client.onNativePrintDialogOpened?.(callback);
        const listener = listeners.get(DOCUMENTS_EVENT_CHANNELS.nativePrintDialogOpened);
        if (!listener) {
            throw new Error('Expected native print-dialog listener');
        }

        listener({}, {requestId: ''});
        listener({}, {requestId: 'x'.repeat(129)});
        listener({}, {requestId: 'print-request-1'});
        unsubscribe?.();

        expect(callback).toHaveBeenCalledOnce();
        expect(callback).toHaveBeenCalledWith({requestId: 'print-request-1'});
        expect(ipcRenderer.removeListener).toHaveBeenCalledWith(
            DOCUMENTS_EVENT_CHANNELS.nativePrintDialogOpened,
            listener,
        );
    });

    it('writes DOCX chunks through the dedicated stream channels', async () => {
        const ipcRenderer = {
            invoke: vi.fn(async (channel: string) => {
                if (channel === DOCX_EXPORT_STREAM_CHANNELS.begin) {
                    return {sessionId: 'docx-session'};
                }
                return true;
            }),
            send: vi.fn(),
            postMessage: vi.fn(),
        } satisfies Pick<IpcRenderer, 'invoke' | 'postMessage' | 'send'>;
        const client = createDocumentsPreloadFileClient(ipcRenderer);

        const session = await client.beginDocxFileStream(requireDocumentRef('/tmp/export.docx'));
        await expect(client.writeDocxFileStreamChunk(session.sessionId, Uint8Array.of(1, 2))).resolves.toBe(true);
        await expect(client.writeDocxFileStreamChunk(session.sessionId, Uint8Array.of(3, 4))).resolves.toBe(true);
        await expect(client.commitDocxFileStream(session.sessionId)).resolves.toBe(true);

        expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(
            1,
            DOCX_EXPORT_STREAM_CHANNELS.begin,
            '/tmp/export.docx',
        );
        expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(
            2,
            DOCX_EXPORT_STREAM_CHANNELS.writeChunk,
            'docx-session',
            Uint8Array.of(1, 2),
        );
        expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(
            4,
            DOCX_EXPORT_STREAM_CHANNELS.commit,
            'docx-session',
        );
    });

    it('cancels a DOCX stream when a chunk exceeds its IPC bound', async () => {
        const ipcRenderer = {
            invoke: vi.fn(async (channel: string) => {
                if (channel === DOCX_EXPORT_STREAM_CHANNELS.begin) {
                    return {sessionId: 'docx-session'};
                }
                return true;
            }),
            send: vi.fn(),
            postMessage: vi.fn(),
        } satisfies Pick<IpcRenderer, 'invoke' | 'postMessage' | 'send'>;
        const client = createDocumentsPreloadFileClient(ipcRenderer);

        const session = await client.beginDocxFileStream(requireDocumentRef('/tmp/export.docx'));
        await expect(Promise.resolve().then(() => client.writeDocxFileStreamChunk(session.sessionId, new Uint8Array(DOCX_EXPORT_STREAM_MAX_CHUNK_BYTES + 1)))).rejects.toThrow('writeDocxFileStreamChunk chunk exceeds maximum size');
        await expect(client.cancelDocxFileStream(session.sessionId)).resolves.toBe(true);
    });

    it('cancels exactly once when the renderer aborts during a DOCX chunk write', async () => {
        let resolveWriteStarted: (() => void) | undefined;
        const writeStarted = new Promise<void>(resolve => {
            resolveWriteStarted = resolve;
        });
        let resolveCancelStarted: (() => void) | undefined;
        const cancelStarted = new Promise<void>(resolve => {
            resolveCancelStarted = resolve;
        });
        let resolveWrite: (() => void) | undefined;
        const writeRelease = new Promise<void>(resolve => {
            resolveWrite = resolve;
        });
        const ipcRenderer = {
            invoke: vi.fn(async (channel: string) => {
                if (channel === DOCX_EXPORT_STREAM_CHANNELS.begin) {
                    return {sessionId: 'docx-session'};
                }
                if (channel === DOCX_EXPORT_STREAM_CHANNELS.writeChunk) {
                    resolveWriteStarted?.();
                    await writeRelease;
                    return true;
                }
                if (channel === DOCX_EXPORT_STREAM_CHANNELS.cancel) {
                    resolveCancelStarted?.();
                    return true;
                }
                if (channel === DOCX_EXPORT_STREAM_CHANNELS.commit) {
                    throw new Error('DOCX commit must not be reached after renderer cancellation');
                }
                return true;
            }),
            send: vi.fn(),
            postMessage: vi.fn(),
        } satisfies Pick<IpcRenderer, 'invoke' | 'postMessage' | 'send'>;
        const client = createDocumentsPreloadFileClient(ipcRenderer);
        const session = await client.beginDocxFileStream(requireDocumentRef('/tmp/export.docx'));
        const writePromise = client.writeDocxFileStreamChunk(session.sessionId, Uint8Array.of(1, 2));

        await writeStarted;
        await client.cancelDocxFileStream(session.sessionId);
        await cancelStarted;
        resolveWrite?.();

        await expect(writePromise).resolves.toBe(true);
        expect(ipcRenderer.invoke.mock.calls.filter(([channel]) => (
            channel === DOCX_EXPORT_STREAM_CHANNELS.cancel
        ))).toHaveLength(1);
        expect(ipcRenderer.invoke).not.toHaveBeenCalledWith(DOCX_EXPORT_STREAM_CHANNELS.commit, session.sessionId);
    });

    it('rejects structured save calls without revision options before invoking IPC', () => {
        const ipcRenderer = {
            invoke: vi.fn(),
            send: vi.fn(),
            postMessage: vi.fn(),
        } satisfies Pick<IpcRenderer, 'invoke' | 'postMessage' | 'send'>;
        const client = createDocumentsPreloadFileClient(ipcRenderer);

        expect(() => client.saveFileStructured(requireDocumentRef('/tmp/working.pdf')))
            .toThrow('saveFileStructured.options.expectedDocumentRevisionToken must be a non-empty string');
        expect(ipcRenderer.invoke).not.toHaveBeenCalled();
    });

    it('forwards the one-shot annotation parse through the working-copy channel', async () => {
        const revision = requireDocumentRevisionToken('preload-parse-revision');
        const parsed = {
            documentRevisionToken: revision,
            pageCount: 1,
            entities: [],
            foreign: [],
        };
        const ipcRenderer = {
            invoke: vi.fn(async (channel: string) => {
                expect(channel).toBe(DOCUMENTS_CHANNELS.parsePdfAnnotations);
                return parsed;
            }),
            send: vi.fn(),
            postMessage: vi.fn(),
        } satisfies Pick<IpcRenderer, 'invoke' | 'postMessage' | 'send'>;
        const client = createDocumentsPreloadFileClient(ipcRenderer);

        await expect(client.parsePdfAnnotations(requireDocumentRef('/tmp/working.pdf'), {expectedDocumentRevisionToken: revision})).resolves.toEqual(parsed);
        expect(ipcRenderer.invoke).toHaveBeenCalledWith(
            DOCUMENTS_CHANNELS.parsePdfAnnotations,
            requireDocumentRef('/tmp/working.pdf'),
            {expectedDocumentRevisionToken: revision},
            {[IPC_INVOKE_REQUEST_ID_FIELD]: expect.any(String)},
        );
    });

    it('rejects invalid optimize-as-copy options before invoking IPC', async () => {
        const ipcRenderer = {
            invoke: vi.fn(),
            send: vi.fn(),
            postMessage: vi.fn(),
        } satisfies Pick<IpcRenderer, 'invoke' | 'postMessage' | 'send'>;
        const client = createDocumentsPreloadFileClient(ipcRenderer);

        expect(() => client.optimizePdfAsCopy?.(
            requireDocumentRef('/tmp/working.pdf'),
            { preset: 'ultra' } as never,
        )).toThrow('optimizePdfAsCopy.options.preset is invalid');

        expect(ipcRenderer.invoke).not.toHaveBeenCalled();
    });

    it('rejects invalid optimize-as-copy revision options before invoking IPC', async () => {
        const ipcRenderer = {
            invoke: vi.fn(),
            send: vi.fn(),
            postMessage: vi.fn(),
        } satisfies Pick<IpcRenderer, 'invoke' | 'postMessage' | 'send'>;
        const client = createDocumentsPreloadFileClient(ipcRenderer);

        expect(() => client.optimizePdfAsCopy?.(
            requireDocumentRef('/tmp/working.pdf'),
            { preset: 'lossless' },
            requireRequestId('request-1'),
            { expectedDocumentRevisionToken: '' as TDocumentRevisionToken },
        )).toThrow('optimizePdfAsCopy.revisionOptions.expectedDocumentRevisionToken must be a non-empty string');

        expect(ipcRenderer.invoke).not.toHaveBeenCalled();
    });

    it('reads files through range chunks without hydrating the full file', async () => {
        const ipcRenderer = {
            invoke: vi.fn(async (channel: string, ...args: unknown[]) => {
                if (channel === DOCUMENTS_CHANNELS.fileStat) {
                    return {size: 5};
                }
                if (channel === DOCUMENTS_CHANNELS.fileReadRange) {
                    const offset = args[1] as number;
                    const length = args[2] as number;
                    return new Uint8Array(Array.from({length}, (_, index) => offset + index + 1));
                }
                throw new Error(`Unexpected invoke: ${channel}`);
            }),
            send: vi.fn(),
            postMessage: vi.fn(),
        } satisfies Pick<IpcRenderer, 'invoke' | 'postMessage' | 'send'>;
        const client = createDocumentsPreloadFileClient(ipcRenderer);
        const chunks: Array<{
            offset: number;
            bytes: number[];
        }> = [];

        await expect(client.readFileChunks(requireDocumentRef('/tmp/working.pdf'), {chunkBytes: 2}, (chunk, offset) => {
            chunks.push({
                offset,
                bytes: [...chunk],
            });
        })).resolves.toEqual({
            size: 5,
            bytesRead: 5,
            chunks: 3,
        });

        expect(chunks).toEqual([
            {
                offset: 0,
                bytes: [
                    1,
                    2,
                ],
            },
            {
                offset: 2,
                bytes: [
                    3,
                    4,
                ],
            },
            {
                offset: 4,
                bytes: [5],
            },
        ]);
        expect(ipcRenderer.invoke).toHaveBeenCalledWith(DOCUMENTS_CHANNELS.fileStat, '/tmp/working.pdf');
        expect(ipcRenderer.invoke).toHaveBeenCalledWith(DOCUMENTS_CHANNELS.fileReadRange, '/tmp/working.pdf', 0, 2);
        expect(ipcRenderer.invoke).toHaveBeenCalledWith(DOCUMENTS_CHANNELS.fileReadRange, '/tmp/working.pdf', 2, 2);
        expect(ipcRenderer.invoke).toHaveBeenCalledWith(DOCUMENTS_CHANNELS.fileReadRange, '/tmp/working.pdf', 4, 1);
    });

    it('rejects malformed stat results while preserving safe large-file metadata', async () => {
        let result: unknown = {size: -1};
        const ipcRenderer = {
            invoke: vi.fn(async () => result),
            send: vi.fn(),
            postMessage: vi.fn(),
        } satisfies Pick<IpcRenderer, 'invoke' | 'postMessage' | 'send'>;
        const client = createDocumentsPreloadFileClient(ipcRenderer);

        for (result of [
            {size: -1},
            {size: 1.5},
            {size: Number.MAX_SAFE_INTEGER + 1},
            {size: '100'},
        ]) {
            await expect(client.statFile(requireDocumentRef('/tmp/working.pdf'))).rejects.toThrow(
                'invalid file stat',
            );
        }

        result = {size: MAX_DOCUMENT_ALLOCATION_BYTES + 1};
        await expect(client.statFile(requireDocumentRef('/tmp/working.pdf'))).resolves.toEqual({size: MAX_DOCUMENT_ALLOCATION_BYTES + 1});
    });

    it('drops malformed revision events and removes the exact subscribed listener', () => {
        const listeners = new Map<string, (_event: unknown, payload: unknown) => void>();
        const ipcRenderer = {
            invoke: vi.fn(),
            send: vi.fn(),
            postMessage: vi.fn(),
            on: vi.fn((channel: string, handler: (_event: unknown, payload: unknown) => void) => {
                listeners.set(channel, handler);
                return undefined as never;
            }),
            removeListener: vi.fn(),
        } satisfies Pick<IpcRenderer, 'invoke' | 'postMessage' | 'send' | 'on' | 'removeListener'>;
        const client = createDocumentsPreloadFileClient(ipcRenderer);
        const callback = vi.fn();
        const unsubscribe = client.onDocumentRevisionChanged(callback);
        const listener = listeners.get(DOCUMENTS_EVENT_CHANNELS.documentRevisionChanged);
        if (!listener) {
            throw new Error('Expected document revision listener');
        }
        const valid = {
            version: 1,
            token: requireDocumentRevisionToken('revision-2'),
            previousToken: requireDocumentRevisionToken('revision-1'),
            documentRef: '/tmp/working.pdf',
            authority: 'electron-working-copy',
            contentRevision: 2,
            mintedAt: 123,
            reason: 'write',
        };

        listener({}, {
            ...valid,
            reason: 'future-reason',
        });
        listener({}, {
            ...valid,
            contentRevision: -1,
        });
        listener({}, valid);
        unsubscribe();

        expect(callback).toHaveBeenCalledOnce();
        expect(callback).toHaveBeenCalledWith(valid);
        expect(ipcRenderer.removeListener).toHaveBeenCalledWith(
            DOCUMENTS_EVENT_CHANNELS.documentRevisionChanged,
            listener,
        );
    });

    it('decodes backing status queries and drops malformed backing status events', async () => {
        const listeners = new Map<string, (_event: unknown, payload: unknown) => void>();
        const ipcRenderer = {
            invoke: vi.fn(async () => ({
                documentRef: '/tmp/working.pdf',
                failure: null,
                originalPath: '/private/source.pdf',
                progress: 0.25,
                state: 'materializing',
            })),
            send: vi.fn(),
            postMessage: vi.fn(),
            on: vi.fn((channel: string, handler: (_event: unknown, payload: unknown) => void) => {
                listeners.set(channel, handler);
                return undefined as never;
            }),
            removeListener: vi.fn(),
        } satisfies Pick<IpcRenderer, 'invoke' | 'postMessage' | 'send' | 'on' | 'removeListener'>;
        const client = createDocumentsPreloadFileClient(ipcRenderer);

        await expect(client.getWorkingCopyBackingStatus?.(requireDocumentRef('/tmp/working.pdf'))).resolves.toEqual({
            documentRef: '/tmp/working.pdf',
            failure: null,
            progress: 0.25,
            state: 'materializing',
        });
        expect(ipcRenderer.invoke).toHaveBeenCalledWith(
            DOCUMENTS_CHANNELS.workingCopyBackingStatusGet,
            '/tmp/working.pdf',
        );

        const callback = vi.fn();
        const unsubscribe = client.onWorkingCopyBackingStatusChanged?.(callback);
        const listener = listeners.get(DOCUMENTS_EVENT_CHANNELS.workingCopyBackingStatusChanged);
        if (!listener) {
            throw new Error('Expected working-copy backing status listener');
        }
        listener({}, {
            documentRef: '/tmp/working.pdf',
            failure: null,
            progress: 2,
            state: 'materializing',
        });
        listener({}, {
            documentRef: '/tmp/working.pdf',
            failure: {
                code: 'WORKING_COPY_MATERIALIZATION_NO_SPACE',
                retryable: true,
            },
            progress: 0.75,
            state: 'lazy-original',
        });
        unsubscribe?.();

        expect(callback).toHaveBeenCalledOnce();
        expect(callback).toHaveBeenCalledWith({
            documentRef: '/tmp/working.pdf',
            failure: {
                code: 'WORKING_COPY_MATERIALIZATION_NO_SPACE',
                retryable: true,
            },
            progress: 0.75,
            state: 'lazy-original',
        });
        expect(ipcRenderer.removeListener).toHaveBeenCalledWith(
            DOCUMENTS_EVENT_CHANNELS.workingCopyBackingStatusChanged,
            listener,
        );
    });

    it('invokes native PDF preview metadata, cancel, and render channels with validated inputs', async () => {
        const openingGeometry = {
            pageNumber: 1 as const,
            pageCount: 431,
            width: 612,
            height: 792,
            rotation: 0 as const,
            size: 28_000_000,
            modifiedAt: 1_720_000_000_000,
        };
        const pageSizes = [{
            width: 612,
            height: 792,
        }];
        const cancelResult = { canceled: true };
        const preview = {
            bytes: new Uint8Array([1]),
            width: 900,
            height: 1200,
        };
        const ipcRenderer = {
            invoke: vi.fn(async (channel: string) => {
                if (channel === DOCUMENTS_CHANNELS.pdfOpeningGeometry) {
                    return openingGeometry;
                }
                if (channel === DOCUMENTS_CHANNELS.pdfNativePageSizes) {
                    return pageSizes;
                }
                if (channel === DOCUMENTS_CHANNELS.pdfNativePagePreviewCancel) {
                    return cancelResult;
                }
                if (channel === DOCUMENTS_CHANNELS.pdfNativePagePreview) {
                    return preview;
                }
                throw new Error(`Unexpected invoke: ${channel}`);
            }),
            send: vi.fn(),
            postMessage: vi.fn(),
        } satisfies Pick<IpcRenderer, 'invoke' | 'postMessage' | 'send'>;
        const client = createDocumentsPreloadFileClient(ipcRenderer);

        await expect(client.getPdfOpeningGeometry?.(requireDocumentRef('/tmp/huge.pdf'))).resolves.toStrictEqual(openingGeometry);
        await expect(client.getPdfNativePageSizes?.(requireDocumentRef('/tmp/huge.pdf'))).resolves.toStrictEqual(pageSizes);
        await expect(client.cancelPdfNativePagePreview?.(requireRequestId(' preview-1 '))).resolves.toEqual(cancelResult);
        await expect(client.renderPdfNativePagePreview?.(
            requireDocumentRef('/tmp/huge.pdf'),
            requirePageNumber(3),
            {
                targetWidthPx: 900.8,
                previewRequestId: requireRequestId(' preview-2 '),
            },
        )).resolves.toStrictEqual(preview);

        expect(ipcRenderer.invoke).toHaveBeenCalledWith(
            DOCUMENTS_CHANNELS.pdfOpeningGeometry,
            '/tmp/huge.pdf',
            {[IPC_INVOKE_REQUEST_ID_FIELD]: expect.any(String)},
        );
        expect(ipcRenderer.invoke).toHaveBeenCalledWith(
            DOCUMENTS_CHANNELS.pdfNativePageSizes,
            '/tmp/huge.pdf',
            {[IPC_INVOKE_REQUEST_ID_FIELD]: expect.any(String)},
        );
        expect(ipcRenderer.invoke).toHaveBeenCalledWith(
            DOCUMENTS_CHANNELS.pdfNativePagePreviewCancel,
            'preview-1',
        );
        expect(ipcRenderer.invoke).toHaveBeenCalledWith(
            DOCUMENTS_CHANNELS.pdfNativePagePreview,
            '/tmp/huge.pdf',
            3,
            {
                targetWidthPx: 900,
                previewRequestId: 'preview-2',
            },
            {[IPC_INVOKE_REQUEST_ID_FIELD]: expect.any(String)},
        );
    });

    it('rejects invalid native PDF preview requests before invoking IPC', () => {
        const ipcRenderer = {
            invoke: vi.fn(),
            send: vi.fn(),
            postMessage: vi.fn(),
        } satisfies Pick<IpcRenderer, 'invoke' | 'postMessage' | 'send'>;
        const client = createDocumentsPreloadFileClient(ipcRenderer);

        expect(() => client.getPdfOpeningGeometry?.(invalidDocumentRef))
            .toThrow('getPdfOpeningGeometry.path must be an absolute path');
        expect(() => client.getPdfNativePageSizes?.(invalidDocumentRef))
            .toThrow('getPdfNativePageSizes.path must be an absolute path');
        expect(() => client.renderPdfNativePagePreview?.(requireDocumentRef('/tmp/huge.pdf'), invalidPageNumber))
            .toThrow('renderPdfNativePagePreview.pageNumber must be a positive integer');
        expect(() => client.renderPdfNativePagePreview?.(
            requireDocumentRef('/tmp/huge.pdf'),
            requirePageNumber(1),
            { targetWidthPx: Number.POSITIVE_INFINITY },
        )).toThrow('renderPdfNativePagePreview.options.targetWidthPx must be a positive finite number');
        expect(() => client.renderPdfNativePagePreview?.(
            requireDocumentRef('/tmp/huge.pdf'),
            requirePageNumber(1),
            { previewRequestId: invalidWhitespaceRequestId },
        )).toThrow('renderPdfNativePagePreview.options.previewRequestId must be a non-empty string');
        expect(() => client.cancelPdfNativePagePreview?.(invalidEmptyRequestId))
            .toThrow('cancelPdfNativePagePreview.requestId must not be empty');

        expect(ipcRenderer.invoke).not.toHaveBeenCalled();
    });

    it('streams PDF persistence chunks with tight backing buffers without transferring ArrayBuffers', async () => {
        const port1 = new FakeMessagePort();
        const port2 = new FakeMessagePort();
        vi.stubGlobal('MessageChannel', class {
            readonly port1 = port1;
            readonly port2 = port2;
        });
        const ipcRenderer = {
            invoke: vi.fn(async (channel: string) => {
                if (channel === DOCUMENTS_CHANNELS.fileSavePdfDataBegin) {
                    return {sessionId: 'session-1'};
                }
                throw new Error(`Unexpected invoke: ${channel}`);
            }),
            send: vi.fn(),
            postMessage: vi.fn((channel: string) => {
                expect(channel).toBe(DOCUMENTS_CHANNELS.fileSavePdfDataPort);
                queueMicrotask(() => {
                    port1.emit({type: 'ready'});
                });
            }),
        } satisfies Pick<IpcRenderer, 'invoke' | 'postMessage' | 'send'>;
        const chunkBytes = 8 * 1024 * 1024;
        const sourceBytes = new Uint8Array(chunkBytes + 3);
        sourceBytes[0] = 1;
        sourceBytes[chunkBytes] = 2;
        sourceBytes[sourceBytes.byteLength - 1] = 3;
        port1.onPostMessage = (message) => {
            if (isChunkMessage(message)) {
                queueMicrotask(() => {
                    port1.emit({
                        type: 'ack',
                        seq: message.seq,
                    });
                });
                return;
            }
            if (message.type === 'complete') {
                queueMicrotask(() => {
                    port1.emit({
                        type: 'result',
                        path: '/tmp/saved.pdf',
                        validation: {
                            isValid: true,
                            tool: 'qpdf',
                            errors: [],
                            warnings: [],
                        },
                    });
                });
            }
        };
        const client = createDocumentsPreloadFileClient(ipcRenderer);

        await expect(client.savePdfData(requireDocumentRef('/tmp/working.pdf'), sourceBytes, revisionOptions))
            .resolves
            .toMatchObject({isValid: true});

        const chunks = port1.postedMessages.filter(isChunkMessage);
        expect(chunks).toHaveLength(2);
        expect(chunks[0]?.bytes.buffer).not.toBe(sourceBytes.buffer);
        expect(chunks[0]?.bytes.byteOffset).toBe(0);
        expect(chunks[0]?.bytes.byteLength).toBe(chunkBytes);
        expect(chunks[0]?.bytes[0]).toBe(1);
        expect(port1.postedTransfers[0]).toEqual([]);
        expect(port1.postedTransfers[0]).not.toContain(sourceBytes.buffer);
        expect(chunks[1]?.bytes.buffer).not.toBe(sourceBytes.buffer);
        expect(chunks[1]?.bytes.byteOffset).toBe(0);
        expect(chunks[1]?.bytes.byteLength).toBe(3);
        expect(chunks[1]?.bytes[0]).toBe(2);
        expect(chunks[1]?.bytes[2]).toBe(3);
        expect(port1.postedTransfers[1]).toEqual([]);
        expect(port1.postedTransfers[1]).not.toContain(sourceBytes.buffer);
    });

    it('keeps a bounded pair of PDF persistence chunks in flight', async () => {
        const port1 = new FakeMessagePort();
        const port2 = new FakeMessagePort();
        vi.stubGlobal('MessageChannel', class {
            readonly port1 = port1;
            readonly port2 = port2;
        });
        const ipcRenderer = {
            invoke: vi.fn(async (channel: string) => {
                if (channel === DOCUMENTS_CHANNELS.fileSavePdfDataBegin) {
                    return {sessionId: 'session-1'};
                }
                throw new Error(`Unexpected invoke: ${channel}`);
            }),
            send: vi.fn(),
            postMessage: vi.fn(() => {
                queueMicrotask(() => {
                    port1.emit({type: 'ready'});
                });
            }),
        } satisfies Pick<IpcRenderer, 'invoke' | 'postMessage' | 'send'>;
        const client = createDocumentsPreloadFileClient(ipcRenderer);
        const sourceBytes = new Uint8Array((8 * 1024 * 1024) + 1);

        const savePromise = client.savePdfData(requireDocumentRef('/tmp/working.pdf'), sourceBytes, revisionOptions);
        await waitForPostedChunkCount(port1, 2);

        expect(port1.postedMessages.some(message => isPortMessage(message, 'complete'))).toBe(false);

        port1.emit({
            type: 'ack',
            seq: 0,
        });
        await Promise.resolve();
        expect(port1.postedMessages.some(message => isPortMessage(message, 'complete'))).toBe(false);

        port1.emit({
            type: 'ack',
            seq: 1,
        });
        await waitForPortMessage(port1, 'complete');
        port1.emit({
            type: 'result',
            path: '/tmp/saved.pdf',
            validation: {
                isValid: true,
                tool: 'qpdf',
                errors: [],
                warnings: [],
            },
        });

        await expect(savePromise).resolves.toMatchObject({isValid: true});
    });

    it('starts the negotiated final-result deadline only after complete is sent', async () => {
        vi.useFakeTimers({toFake: [
            'setTimeout',
            'clearTimeout',
        ]});
        try {
            const port1 = new FakeMessagePort();
            const port2 = new FakeMessagePort();
            vi.stubGlobal('MessageChannel', class {
                readonly port1 = port1;
                readonly port2 = port2;
            });
            const ipcRenderer = {
                invoke: vi.fn(async (channel: string) => {
                    if (channel === DOCUMENTS_CHANNELS.fileSavePdfDataBegin) {
                        return {
                            sessionId: 'session-1',
                            protocolVersion: 1,
                            maxChunkBytes: 8 * 1024 * 1024,
                            maxInFlightChunks: 2,
                            maxTotalBytes: Number.MAX_SAFE_INTEGER,
                            ackTimeoutMs: 100,
                            progressTimeoutMs: 100,
                            resultTimeoutMs: 20,
                        };
                    }
                    throw new Error(`Unexpected invoke: ${channel}`);
                }),
                send: vi.fn(),
                postMessage: vi.fn(() => {
                    queueMicrotask(() => port1.emit({type: 'ready'}));
                }),
            } satisfies Pick<IpcRenderer, 'invoke' | 'postMessage' | 'send'>;
            let resolveChunk!: () => void;
            const chunkPosted = new Promise<void>(resolve => {
                resolveChunk = resolve;
            });
            let resolveComplete!: () => void;
            const completePosted = new Promise<void>(resolve => {
                resolveComplete = resolve;
            });
            port1.onPostMessage = message => {
                if (isChunkMessage(message)) {
                    resolveChunk();
                }
                if (message.type === 'complete') {
                    resolveComplete();
                }
            };
            const client = createDocumentsPreloadFileClient(ipcRenderer);
            const savePromise = client.savePdfData(
                requireDocumentRef('/tmp/working.pdf'),
                new Uint8Array([1]),
                revisionOptions,
            );
            await Promise.resolve();
            await Promise.resolve();
            await chunkPosted;
            vi.advanceTimersByTime(25);
            expect(port1.postedMessages.some(message => isPortMessage(message, 'complete'))).toBe(false);
            port1.emit({
                type: 'ack',
                seq: 0,
            });
            await Promise.resolve();
            await completePosted;
            vi.runAllTimers();
            await expect(savePromise).rejects.toThrow('final result');
        } finally {
            vi.useRealTimers();
        }
    });

    it('rejects invalid native note text update requests before IPC', async () => {
        const ipcRenderer = {
            invoke: vi.fn(),
            send: vi.fn(),
            postMessage: vi.fn(),
        } satisfies Pick<IpcRenderer, 'invoke' | 'postMessage' | 'send'>;
        const client = createDocumentsPreloadFileClient(ipcRenderer);

        expect(() => client.savePdfNoteTextUpdates!(requireDocumentRef('/tmp/working.pdf'), [], nativeModifiedAt))
            .toThrow('savePdfNoteTextUpdates.updates must be a non-empty array');

        expect(ipcRenderer.invoke).not.toHaveBeenCalled();
    });

    it('validates native FreeText note change requests before IPC', async () => {
        const ipcRenderer = {
            invoke: vi.fn(async () => ({
                applied: true,
                validation: {
                    isValid: true,
                    tool: 'qpdf' as const,
                    errors: [],
                    warnings: [],
                },
            })),
            send: vi.fn(),
            postMessage: vi.fn(),
        } satisfies Pick<IpcRenderer, 'invoke' | 'postMessage' | 'send'>;
        const client = createDocumentsPreloadFileClient(ipcRenderer);

        const freeTextNotes = [{
            pageIndex: requirePageIndex(0),
            stableKey: 'uid:0:pdfjs_internal_editor_0',
            text: 'Editor note',
            markerRect: {
                left: 0.1,
                top: 0.2,
                width: 0.0016,
                height: 0.0016,
            },
            author: 'Tester',
            color: 'rgba(255, 204, 0, 0.8)',
            createdAt: requireEpochMs(1781009077000),
        }];

        await expect(client.savePdfNoteChanges!(
            requireDocumentRef('/tmp/working.pdf'),
            {
                updates: [],
                freeTextNotes,
                deletes: [
                    {
                        pageIndex: requirePageIndex(0),
                        objectNumber: 3856,
                        generationNumber: 0,
                    },
                    {
                        pageIndex: requirePageIndex(0),
                        stableKey: 'uid:0:pdfjs_internal_editor_0',
                        createdAt: requireEpochMs(1781009077000),
                    },
                ],
            },
            nativeModifiedAt,
            revisionOptions,
        )).resolves.toMatchObject({applied: true});

        expect(ipcRenderer.invoke).toHaveBeenCalledWith(
            DOCUMENTS_CHANNELS.fileSavePdfNoteChanges,
            '/tmp/working.pdf',
            {
                freeTextNotes: [expect.objectContaining({
                    stableKey: 'uid:0:pdfjs_internal_editor_0',
                    text: 'Editor note',
                })],
                deletes: [
                    {
                        pageIndex: requirePageIndex(0),
                        objectNumber: 3856,
                        generationNumber: 0,
                    },
                    {
                        pageIndex: requirePageIndex(0),
                        stableKey: 'uid:0:pdfjs_internal_editor_0',
                        createdAt: requireEpochMs(1781009077000),
                    },
                ],
            },
            nativeModifiedAt,
            revisionOptions,
            {[IPC_INVOKE_REQUEST_ID_FIELD]: expect.any(String)},
        );
    });

    it('validates native working-copy placed image mutations before IPC', async () => {
        const invoke = vi.fn<(
            channel: string,
            path: string,
            mutations: INativeMutationInvokePayload,
            modifiedAt: string,
            options: unknown,
        ) => Promise<unknown>>(async () => ({
            applied: true,
            validation: {
                isValid: true,
                tool: 'native' as const,
                errors: [],
                warnings: [],
            },
        }));
        const ipcRenderer = {
            invoke,
            send: vi.fn(),
            postMessage: vi.fn(),
        } satisfies Pick<IpcRenderer, 'invoke' | 'postMessage' | 'send'>;
        const client = createDocumentsPreloadFileClient(ipcRenderer);
        const imageSource = createNativePlacedImage().source;

        await expect(client.applyPdfNativeMutationsToWorkingCopy!(
            requireDocumentRef('/tmp/working.pdf'),
            {placedImages: [{
                pageIndex: requirePageIndex(0),
                x: 0.1,
                y: 0.2,
                width: 0.3,
                height: 0.2,
                rotationDegrees: 15,
                mimeType: 'image/jpeg',
                source: imageSource,
            }]},
            nativeModifiedAt,
            revisionOptions,
        )).resolves.toMatchObject({applied: true});

        expect(ipcRenderer.invoke).toHaveBeenCalledWith(
            DOCUMENTS_CHANNELS.fileApplyPdfNativeMutationsToWorkingCopy,
            '/tmp/working.pdf',
            {placedImages: [expect.objectContaining({
                pageIndex: 0,
                mimeType: 'image/jpeg',
                source: imageSource,
            })]},
            nativeModifiedAt,
            revisionOptions,
            {[IPC_INVOKE_REQUEST_ID_FIELD]: expect.any(String)},
        );
        const firstCall = invoke.mock.calls[0];
        expect(firstCall).toBeDefined();
        if (!firstCall) {
            throw new Error('Expected native mutation IPC call');
        }
        const mutations = firstCall[2];
        expect(mutations.placedImages[0]).not.toHaveProperty('bytes');
        expect(mutations.placedImages[0]?.source).toEqual(imageSource);
    });
});

function isChunkMessage(message: unknown): message is {
    type: 'chunk';
    seq: number;
    bytes: Uint8Array;
} {
    return Boolean(
        message
        && typeof message === 'object'
        && 'type' in message
        && message.type === 'chunk'
        && 'seq' in message
        && typeof message.seq === 'number'
        && 'bytes' in message
        && message.bytes instanceof Uint8Array,
    );
}

function isPortMessage(message: unknown, type: string) {
    return Boolean(
        message
        && typeof message === 'object'
        && 'type' in message
        && message.type === type,
    );
}

async function waitForPostedChunkCount(port: FakeMessagePort, expectedCount: number) {
    await waitForCondition(() => {
        expect(port.postedMessages.filter(isChunkMessage)).toHaveLength(expectedCount);
    });
}

async function waitForPortMessage(port: FakeMessagePort, type: string) {
    await waitForCondition(() => {
        expect(port.postedMessages.some(message => isPortMessage(message, type))).toBe(true);
    });
}
