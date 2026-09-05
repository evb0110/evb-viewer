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
import { requirePageIndex } from '@contracts/pageNumbers';
import { PDF_NATIVE_MUTATION_LIMITS } from '@contracts/nativePdfMutations';
import { MAX_DOCUMENT_ALLOCATION_BYTES } from '@contracts/electronApiDocuments';
import {requireDocumentRevisionToken} from '@contracts';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import {PDF_DECRYPT_PASSWORD_MAX_BYTES} from '@contracts/pdfDecryptSchemas';

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

interface INativeBookmarkTestItem {
    title: string;
    pageIndex: number | null;
    namedDest: string | null;
    bold: boolean;
    italic: boolean;
    color: string | null;
    items: INativeBookmarkTestItem[];
}

function createNativeBookmark(title = 'Chapter'): INativeBookmarkTestItem {
    return {
        title,
        pageIndex: 0,
        namedDest: null,
        bold: false,
        italic: false,
        color: null,
        items: [],
    };
}

function createDeepNativeBookmarkItems(depth: number) {
    const root = createNativeBookmark('Root');
    let current = root;
    for (let index = 0; index < depth; index += 1) {
        const child = createNativeBookmark(`Child ${index}`);
        current.items = [child];
        current = child;
    }
    return [root];
}

function createNativeShape() {
    return {
        type: 'rectangle' as const,
        pageIndex: requirePageIndex(0),
        x: 0.1,
        y: 0.2,
        width: 0.3,
        height: 0.2,
        color: '#336699',
        opacity: 0.5,
        strokeWidth: 3,
    };
}

function createNativeFreeTextEditor() {
    return {
        pageIndex: requirePageIndex(0),
        stableKey: 'pdfjs_internal_editor_0',
        text: 'Editor text',
        rect: [
            0.1,
            0.2,
            0.4,
            0.3,
        ] as [number, number, number, number],
        rotation: 0 as const,
        fontSize: 12,
        color: [
            17,
            24,
            39,
        ] as [number, number, number],
    };
}

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
            path: '/tmp/image.jpg',
            size: 3,
            sha256: 'a'.repeat(64),
            leaseId: 'image-lease',
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

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('rejects invalid working-copy passwords before invoking IPC', () => {
        const ipcRenderer = {
            invoke: vi.fn(),
            postMessage: vi.fn(),
        } satisfies Pick<IpcRenderer, 'invoke' | 'postMessage'>;
        const client = createDocumentsPreloadFileClient(ipcRenderer);
        const oversizedPassword = 'x'.repeat(PDF_DECRYPT_PASSWORD_MAX_BYTES + 1);

        expect(() => client.createWorkingCopyFromData(
            'protected.pdf',
            Uint8Array.of(1),
            undefined,
            oversizedPassword,
        )).toThrow(`PDF password exceeds the ${PDF_DECRYPT_PASSWORD_MAX_BYTES}-byte limit`);
        expect(() => client.createWorkingCopyFromPath(
            '/tmp/protected.pdf',
            undefined,
            null as never,
        )).toThrow(`PDF password exceeds the ${PDF_DECRYPT_PASSWORD_MAX_BYTES}-byte limit`);
        expect(ipcRenderer.invoke).not.toHaveBeenCalled();
    });

    it('validates and forwards native path print layout options', async () => {
        const ipcRenderer = {
            invoke: vi.fn(async () => ({success: true})),
            postMessage: vi.fn(),
        } satisfies Pick<IpcRenderer, 'invoke' | 'postMessage'>;
        const client = createDocumentsPreloadFileClient(ipcRenderer);
        const options = {
            pageNumbers: [
                2,
                5,
            ],
            viewMode: 'facing' as const,
            orientation: 'landscape' as const,
            requestId: 'print-request-1',
        };

        await expect(client.printPdfPath('/tmp/document.pdf', undefined, options))
            .resolves.toEqual({success: true});
        expect(ipcRenderer.invoke).toHaveBeenCalledWith(
            DOCUMENTS_CHANNELS.pdfPrintPath,
            '/tmp/document.pdf',
            undefined,
            options,
        );
        expect(() => client.printPdfPath('/tmp/document.pdf', undefined, {
            ...options,
            pageNumbers: [0],
        })).toThrow('printPdfPath.options.pageNumbers[0] must be a positive safe integer');
        expect(ipcRenderer.invoke).toHaveBeenCalledOnce();
    });

    it('validates and forwards native data print handoff options', async () => {
        const ipcRenderer = {
            invoke: vi.fn(async (channel: string) => channel === DOCUMENTS_CHANNELS.pdfPrintCancel
                ? {canceled: true}
                : {success: true}),
            postMessage: vi.fn(),
        } satisfies Pick<IpcRenderer, 'invoke' | 'postMessage'>;
        const client = createDocumentsPreloadFileClient(ipcRenderer);
        const data = Uint8Array.of(1, 2, 3);
        const options = {requestId: 'print-data-request-1'};

        await expect(client.printPdfData(data, 'document.pdf', options))
            .resolves.toEqual({success: true});
        await expect(client.cancelPdfPrint?.(' print-data-request-1 '))
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
        expect(() => client.printPdfData(data, 'document.pdf', {requestId: ''}))
            .toThrow('printPdfData.options.requestId must be a non-empty bounded string');
        expect(() => client.cancelPdfPrint?.(''))
            .toThrow('cancelPdfPrint.requestId must not be empty');
        expect(ipcRenderer.invoke).toHaveBeenCalledTimes(2);
    });

    it('drops malformed native print-dialog events and removes the subscribed listener', () => {
        const listeners = new Map<string, (_event: unknown, payload: unknown) => void>();
        const ipcRenderer = {
            invoke: vi.fn(),
            postMessage: vi.fn(),
            on: vi.fn((channel: string, handler: (_event: unknown, payload: unknown) => void) => {
                listeners.set(channel, handler);
                return undefined as never;
            }),
            removeListener: vi.fn(),
        } satisfies Pick<IpcRenderer, 'invoke' | 'postMessage' | 'on' | 'removeListener'>;
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

    it('closes the PDF persistence port when posting a streamed chunk fails', async () => {
        const port1 = new FakeMessagePort();
        const port2 = new FakeMessagePort();
        port1.shouldThrowOnChunk = true;
        vi.stubGlobal('MessageChannel', class {
            readonly port1 = port1;
            readonly port2 = port2;
        });
        const ipcRenderer = {
            invoke: vi.fn(async (channel: string) => {
                if (channel === DOCUMENTS_CHANNELS.savePdfDataAsBegin) {
                    return {
                        sessionId: 'session-1',
                        path: '/tmp/saved.pdf',
                    };
                }
                throw new Error(`Unexpected invoke: ${channel}`);
            }),
            postMessage: vi.fn((channel: string) => {
                expect(channel).toBe(DOCUMENTS_CHANNELS.fileSavePdfDataPort);
                queueMicrotask(() => {
                    port1.emit({type: 'ready'});
                });
            }),
        } satisfies Pick<IpcRenderer, 'invoke' | 'postMessage'>;
        const client = createDocumentsPreloadFileClient(ipcRenderer);

        await expect(client.savePdfDataAs('/tmp/working.pdf', new Uint8Array([
            1,
            2,
            3,
        ]), undefined, revisionOptions)).rejects.toThrow(
            'chunk post failed',
        );

        expect(port1.close).toHaveBeenCalledTimes(1);
        expect(port1.postedMessages).toContainEqual({type: 'cancel'});
        expect(port1.listeners.size).toBe(0);
    });

    it('writes DOCX chunks through the dedicated stream channels', async () => {
        const ipcRenderer = {
            invoke: vi.fn(async (channel: string) => {
                if (channel === DOCX_EXPORT_STREAM_CHANNELS.begin) {
                    return {sessionId: 'docx-session'};
                }
                return true;
            }),
            postMessage: vi.fn(),
        } satisfies Pick<IpcRenderer, 'invoke' | 'postMessage'>;
        const client = createDocumentsPreloadFileClient(ipcRenderer);

        await expect(client.writeDocxFileChunks('/tmp/export.docx', [
            Uint8Array.of(1, 2),
            Uint8Array.of(3, 4),
        ])).resolves.toBe(true);

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
            postMessage: vi.fn(),
        } satisfies Pick<IpcRenderer, 'invoke' | 'postMessage'>;
        const client = createDocumentsPreloadFileClient(ipcRenderer);

        await expect(client.writeDocxFileChunks('/tmp/export.docx', [new Uint8Array(DOCX_EXPORT_STREAM_MAX_CHUNK_BYTES + 1)])).rejects.toThrow('writeDocxFileChunks chunk exceeds maximum size');
        expect(ipcRenderer.invoke).toHaveBeenLastCalledWith(
            DOCX_EXPORT_STREAM_CHANNELS.cancel,
            'docx-session',
        );
    });

    it('cancels exactly once when the renderer aborts during a DOCX chunk write', async () => {
        const controller = new AbortController();
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
            postMessage: vi.fn(),
        } satisfies Pick<IpcRenderer, 'invoke' | 'postMessage'>;
        const client = createDocumentsPreloadFileClient(ipcRenderer);
        const writePromise = client.writeDocxFileChunks(
            '/tmp/export.docx',
            [Uint8Array.of(1, 2)],
            controller.signal,
        );

        await writeStarted;
        controller.abort(new DOMException('DOCX export was canceled.', 'AbortError'));
        await cancelStarted;
        resolveWrite?.();

        await expect(writePromise).rejects.toMatchObject({name: 'AbortError'});
        expect(ipcRenderer.invoke.mock.calls.filter(([channel]) => (
            channel === DOCX_EXPORT_STREAM_CHANNELS.cancel
        ))).toHaveLength(1);
        expect(ipcRenderer.invoke).not.toHaveBeenCalledWith(
            DOCX_EXPORT_STREAM_CHANNELS.commit,
            'docx-session',
        );
    });

    it('passes lossless optimization options when starting streamed Save As persistence', async () => {
        const port1 = new FakeMessagePort();
        const port2 = new FakeMessagePort();
        vi.stubGlobal('MessageChannel', class {
            readonly port1 = port1;
            readonly port2 = port2;
        });
        const ipcRenderer = {
            invoke: vi.fn(async (channel: string) => {
                if (channel === DOCUMENTS_CHANNELS.savePdfDataAsBegin) {
                    return {
                        sessionId: 'session-1',
                        path: '/tmp/saved.pdf',
                    };
                }
                throw new Error(`Unexpected invoke: ${channel}`);
            }),
            postMessage: vi.fn(() => {
                queueMicrotask(() => {
                    port1.emit({type: 'ready'});
                });
            }),
        } satisfies Pick<IpcRenderer, 'invoke' | 'postMessage'>;
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

        await expect(client.savePdfDataAs(
            '/tmp/working.pdf',
            new Uint8Array([
                1,
                2,
                3,
            ]),
            { optimizeLossless: true },
            revisionOptions,
        )).resolves.toMatchObject({
            path: '/tmp/saved.pdf',
            validation: { isValid: true },
        });

        expect(ipcRenderer.invoke).toHaveBeenCalledWith(
            DOCUMENTS_CHANNELS.savePdfDataAsBegin,
            '/tmp/working.pdf',
            3,
            { optimizeLossless: true },
            revisionOptions,
        );
    });

    it('rejects structured save calls without revision options before invoking IPC', () => {
        const ipcRenderer = {
            invoke: vi.fn(),
            postMessage: vi.fn(),
        } satisfies Pick<IpcRenderer, 'invoke' | 'postMessage'>;
        const client = createDocumentsPreloadFileClient(ipcRenderer);

        expect(() => client.saveFileStructured('/tmp/working.pdf'))
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
            postMessage: vi.fn(),
        } satisfies Pick<IpcRenderer, 'invoke' | 'postMessage'>;
        const client = createDocumentsPreloadFileClient(ipcRenderer);

        await expect(client.parsePdfAnnotations('/tmp/working.pdf', {expectedDocumentRevisionToken: revision})).resolves.toEqual(parsed);
        expect(ipcRenderer.invoke).toHaveBeenCalledWith(
            DOCUMENTS_CHANNELS.parsePdfAnnotations,
            '/tmp/working.pdf',
            {expectedDocumentRevisionToken: revision},
        );
    });

    it('rejects invalid optimize-as-copy options before invoking IPC', async () => {
        const ipcRenderer = {
            invoke: vi.fn(),
            postMessage: vi.fn(),
        } satisfies Pick<IpcRenderer, 'invoke' | 'postMessage'>;
        const client = createDocumentsPreloadFileClient(ipcRenderer);

        expect(() => client.optimizePdfAsCopy?.(
            '/tmp/working.pdf',
            { preset: 'ultra' } as never,
        )).toThrow('optimizePdfAsCopy.options.preset is invalid');

        expect(ipcRenderer.invoke).not.toHaveBeenCalled();
    });

    it('rejects invalid optimize-as-copy revision options before invoking IPC', async () => {
        const ipcRenderer = {
            invoke: vi.fn(),
            postMessage: vi.fn(),
        } satisfies Pick<IpcRenderer, 'invoke' | 'postMessage'>;
        const client = createDocumentsPreloadFileClient(ipcRenderer);

        expect(() => client.optimizePdfAsCopy?.(
            '/tmp/working.pdf',
            { preset: 'lossless' },
            'request-1',
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
            postMessage: vi.fn(),
        } satisfies Pick<IpcRenderer, 'invoke' | 'postMessage'>;
        const client = createDocumentsPreloadFileClient(ipcRenderer);
        const chunks: Array<{
            offset: number;
            bytes: number[];
        }> = [];

        await expect(client.readFileChunks('/tmp/working.pdf', {chunkBytes: 2}, (chunk, offset) => {
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
            postMessage: vi.fn(),
        } satisfies Pick<IpcRenderer, 'invoke' | 'postMessage'>;
        const client = createDocumentsPreloadFileClient(ipcRenderer);

        for (result of [
            {size: -1},
            {size: 1.5},
            {size: Number.MAX_SAFE_INTEGER + 1},
            {size: '100'},
        ]) {
            await expect(client.statFile('/tmp/working.pdf')).rejects.toThrow(
                'invalid file stat',
            );
        }

        result = {size: MAX_DOCUMENT_ALLOCATION_BYTES + 1};
        await expect(client.statFile('/tmp/working.pdf')).resolves.toEqual({size: MAX_DOCUMENT_ALLOCATION_BYTES + 1});
    });

    it('drops malformed revision events and removes the exact subscribed listener', () => {
        const listeners = new Map<string, (_event: unknown, payload: unknown) => void>();
        const ipcRenderer = {
            invoke: vi.fn(),
            postMessage: vi.fn(),
            on: vi.fn((channel: string, handler: (_event: unknown, payload: unknown) => void) => {
                listeners.set(channel, handler);
                return undefined as never;
            }),
            removeListener: vi.fn(),
        } satisfies Pick<IpcRenderer, 'invoke' | 'postMessage' | 'on' | 'removeListener'>;
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
            postMessage: vi.fn(),
            on: vi.fn((channel: string, handler: (_event: unknown, payload: unknown) => void) => {
                listeners.set(channel, handler);
                return undefined as never;
            }),
            removeListener: vi.fn(),
        } satisfies Pick<IpcRenderer, 'invoke' | 'postMessage' | 'on' | 'removeListener'>;
        const client = createDocumentsPreloadFileClient(ipcRenderer);

        await expect(client.getWorkingCopyBackingStatus?.('/tmp/working.pdf')).resolves.toEqual({
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
            postMessage: vi.fn(),
        } satisfies Pick<IpcRenderer, 'invoke' | 'postMessage'>;
        const client = createDocumentsPreloadFileClient(ipcRenderer);

        await expect(client.getPdfOpeningGeometry?.('/tmp/huge.pdf')).resolves.toStrictEqual(openingGeometry);
        await expect(client.getPdfNativePageSizes?.('/tmp/huge.pdf')).resolves.toStrictEqual(pageSizes);
        await expect(client.cancelPdfNativePagePreview?.(' preview-1 ')).resolves.toEqual(cancelResult);
        await expect(client.renderPdfNativePagePreview?.(
            '/tmp/huge.pdf',
            3,
            {
                targetWidthPx: 900.8,
                previewRequestId: ' preview-2 ',
            },
        )).resolves.toStrictEqual(preview);

        expect(ipcRenderer.invoke).toHaveBeenCalledWith(
            DOCUMENTS_CHANNELS.pdfOpeningGeometry,
            '/tmp/huge.pdf',
        );
        expect(ipcRenderer.invoke).toHaveBeenCalledWith(
            DOCUMENTS_CHANNELS.pdfNativePageSizes,
            '/tmp/huge.pdf',
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
        );
    });

    it('rejects invalid native PDF preview requests before invoking IPC', () => {
        const ipcRenderer = {
            invoke: vi.fn(),
            postMessage: vi.fn(),
        } satisfies Pick<IpcRenderer, 'invoke' | 'postMessage'>;
        const client = createDocumentsPreloadFileClient(ipcRenderer);

        expect(() => client.getPdfOpeningGeometry?.('relative.pdf'))
            .toThrow('getPdfOpeningGeometry.path must be an absolute path');
        expect(() => client.getPdfNativePageSizes?.('relative.pdf'))
            .toThrow('getPdfNativePageSizes.path must be an absolute path');
        expect(() => client.renderPdfNativePagePreview?.('/tmp/huge.pdf', 0))
            .toThrow('renderPdfNativePagePreview.pageNumber must be a positive integer');
        expect(() => client.renderPdfNativePagePreview?.(
            '/tmp/huge.pdf',
            1,
            { targetWidthPx: Number.POSITIVE_INFINITY },
        )).toThrow('renderPdfNativePagePreview.options.targetWidthPx must be a positive finite number');
        expect(() => client.renderPdfNativePagePreview?.(
            '/tmp/huge.pdf',
            1,
            { previewRequestId: '   ' },
        )).toThrow('renderPdfNativePagePreview.options.previewRequestId must be a non-empty string');
        expect(() => client.cancelPdfNativePagePreview?.(''))
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
            postMessage: vi.fn((channel: string) => {
                expect(channel).toBe(DOCUMENTS_CHANNELS.fileSavePdfDataPort);
                queueMicrotask(() => {
                    port1.emit({type: 'ready'});
                });
            }),
        } satisfies Pick<IpcRenderer, 'invoke' | 'postMessage'>;
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

        await expect(client.savePdfData('/tmp/working.pdf', sourceBytes, revisionOptions))
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
            postMessage: vi.fn(() => {
                queueMicrotask(() => {
                    port1.emit({type: 'ready'});
                });
            }),
        } satisfies Pick<IpcRenderer, 'invoke' | 'postMessage'>;
        const client = createDocumentsPreloadFileClient(ipcRenderer);
        const sourceBytes = new Uint8Array((8 * 1024 * 1024) + 1);

        const savePromise = client.savePdfData('/tmp/working.pdf', sourceBytes, revisionOptions);
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

    it('streams caller-provided PDF chunks through the persistence port', async () => {
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
            postMessage: vi.fn(() => {
                queueMicrotask(() => {
                    port1.emit({type: 'ready'});
                });
            }),
        } satisfies Pick<IpcRenderer, 'invoke' | 'postMessage'>;
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
                        path: null,
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

        await expect(client.savePdfDataChunks('/tmp/working.pdf', 5, [
            new Uint8Array([
                1,
                2,
            ]),
            new Uint8Array([
                3,
                4,
                5,
            ]),
        ], revisionOptions)).resolves.toMatchObject({isValid: true});

        const chunks = port1.postedMessages.filter(isChunkMessage);
        expect(chunks).toHaveLength(2);
        expect(chunks.map(chunk => [...chunk.bytes])).toEqual([
            [
                1,
                2,
            ],
            [
                3,
                4,
                5,
            ],
        ]);
        expect(ipcRenderer.invoke).toHaveBeenCalledWith(
            DOCUMENTS_CHANNELS.fileSavePdfDataBegin,
            '/tmp/working.pdf',
            5,
            revisionOptions,
        );
    });

    it('verifies the staged path and frontier before committing streamed PDF bytes', async () => {
        const port1 = new FakeMessagePort();
        const port2 = new FakeMessagePort();
        const staged = createStagedPdfArtifact();
        const order: string[] = [];
        vi.stubGlobal('MessageChannel', class {
            readonly port1 = port1;
            readonly port2 = port2;
        });
        const ipcRenderer = {
            invoke: vi.fn(async (channel: string) => {
                if (channel === DOCUMENTS_CHANNELS.fileSavePdfDataBegin) {
                    return {sessionId: 'session-1'};
                }
                if (channel === DOCUMENTS_CHANNELS.fileCommitStagedSerializedPdf) {
                    order.push('commit');
                    return {
                        path: null,
                        validation: staged.validation,
                    };
                }
                throw new Error(`Unexpected invoke: ${channel}`);
            }),
            postMessage: vi.fn(() => {
                queueMicrotask(() => {
                    port1.emit({type: 'ready'});
                });
            }),
        } satisfies Pick<IpcRenderer, 'invoke' | 'postMessage'>;
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
                        type: 'staged',
                        sessionId: 'session-1',
                        stagedOutput: staged.artifact,
                        validation: staged.validation,
                    });
                });
            }
        };
        const client = createDocumentsPreloadFileClient(ipcRenderer);

        await expect(client.savePdfDataChunks('/tmp/working.pdf', 5, [new Uint8Array([
            1,
            2,
            3,
            4,
            5,
        ])], revisionOptions, {
            verifyPathBeforeCommit: async (path, knownSize) => {
                expect(path).toBe('/tmp/staged.pdf');
                expect(knownSize).toBe(5);
                order.push('verify-path');
            },
            assertBeforeCommit: () => {
                order.push('assert-frontier');
            },
        })).resolves.toMatchObject({isValid: true});

        expect(order).toEqual([
            'verify-path',
            'assert-frontier',
            'commit',
        ]);
        expect(ipcRenderer.invoke).toHaveBeenCalledWith(
            DOCUMENTS_CHANNELS.fileCommitStagedSerializedPdf,
            'session-1',
            staged.artifact,
        );
    });

    it('cancels a staged PDF when renderer verification rejects it', async () => {
        const port1 = new FakeMessagePort();
        const port2 = new FakeMessagePort();
        const staged = createStagedPdfArtifact();
        vi.stubGlobal('MessageChannel', class {
            readonly port1 = port1;
            readonly port2 = port2;
        });
        const ipcRenderer = {
            invoke: vi.fn(async (channel: string) => {
                if (channel === DOCUMENTS_CHANNELS.fileSavePdfDataBegin) {
                    return {sessionId: 'session-1'};
                }
                if (channel === DOCUMENTS_CHANNELS.fileCancelStagedSerializedPdf) {
                    return true;
                }
                throw new Error(`Unexpected invoke: ${channel}`);
            }),
            postMessage: vi.fn(() => {
                queueMicrotask(() => {
                    port1.emit({type: 'ready'});
                });
            }),
        } satisfies Pick<IpcRenderer, 'invoke' | 'postMessage'>;
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
                        type: 'staged',
                        sessionId: 'session-1',
                        stagedOutput: staged.artifact,
                        validation: staged.validation,
                    });
                });
            }
        };
        const client = createDocumentsPreloadFileClient(ipcRenderer);
        const verifyPathBeforeCommit = async () => {
            throw new Error('renderer verification failed');
        };

        await expect(client.savePdfDataChunks('/tmp/working.pdf', 5, [new Uint8Array([
            1,
            2,
            3,
            4,
            5,
        ])], revisionOptions, {verifyPathBeforeCommit}))
            .rejects.toThrow('renderer verification failed');

        expect(ipcRenderer.invoke).toHaveBeenCalledWith(
            DOCUMENTS_CHANNELS.fileCancelStagedSerializedPdf,
            'session-1',
            staged.artifact,
        );
        expect(ipcRenderer.invoke).not.toHaveBeenCalledWith(
            DOCUMENTS_CHANNELS.fileCommitStagedSerializedPdf,
            expect.anything(),
            expect.anything(),
        );
    });

    it('rejects invalid native note text update requests before IPC', async () => {
        const ipcRenderer = {
            invoke: vi.fn(),
            postMessage: vi.fn(),
        } satisfies Pick<IpcRenderer, 'invoke' | 'postMessage'>;
        const client = createDocumentsPreloadFileClient(ipcRenderer);

        expect(() => client.savePdfNoteTextUpdates!('/tmp/working.pdf', [], 'D:20260609133855+03\'00\''))
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
            postMessage: vi.fn(),
        } satisfies Pick<IpcRenderer, 'invoke' | 'postMessage'>;
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
            createdAt: 1781009077000,
        }];

        await expect(client.savePdfNoteChanges!(
            '/tmp/working.pdf',
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
                        createdAt: 1781009077000,
                    },
                ],
            },
            'D:20260609133855+03\'00\'',
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
                        pageIndex: 0,
                        objectNumber: 3856,
                        generationNumber: 0,
                    },
                    {
                        pageIndex: 0,
                        stableKey: 'uid:0:pdfjs_internal_editor_0',
                        createdAt: 1781009077000,
                    },
                ],
            },
            'D:20260609133855+03\'00\'',
            revisionOptions,
        );
    });

    it('validates native PDF metadata mutation requests before IPC', async () => {
        const ipcRenderer = {
            invoke: vi.fn(async () => ({
                applied: true,
                validation: {
                    isValid: true,
                    tool: 'native' as const,
                    errors: [],
                    warnings: [],
                },
            })),
            postMessage: vi.fn(),
        } satisfies Pick<IpcRenderer, 'invoke' | 'postMessage'>;
        const client = createDocumentsPreloadFileClient(ipcRenderer);

        await expect(client.savePdfNativeMutations!(
            '/tmp/working.pdf',
            {
                pageLabels: {
                    totalPages: 3,
                    ranges: [{
                        startPage: 1,
                        style: 'r',
                        prefix: 'intro-',
                        startNumber: 2,
                    }],
                },
                bookmarks: {
                    totalPages: 3,
                    untitledLabel: 'Untitled',
                    items: [{
                        title: 'Chapter 1',
                        pageIndex: 0,
                        pageYRatio: null,
                        namedDest: null,
                        bold: true,
                        italic: false,
                        color: '#336699',
                        items: [],
                    }],
                },
                shapes: {
                    totalPages: 3,
                    rewriteShapeState: true,
                    shapes: [{
                        id: 'shape-1',
                        type: 'rectangle',
                        pageIndex: requirePageIndex(0),
                        x: 0.1,
                        y: 0.2,
                        width: 0.3,
                        height: 0.2,
                        color: '#336699',
                        fillColor: '#abcdef',
                        opacity: 0.5,
                        strokeWidth: 3,
                        stableKey: 'evb-shape:shape-1',
                        createdAt: 1781009077000,
                        modifiedAt: 1781009087000,
                    }],
                    deletedAnnotationIds: ['44R'],
                    deletedStableKeys: ['evb-shape:deleted'],
                },
                markup: {
                    overrides: [[
                        '44R',
                        'Squiggly',
                    ]],
                    hints: [{
                        subtype: 'Squiggly',
                        pageIndex: requirePageIndex(0),
                        markerRect: {
                            left: 0.1,
                            top: 0.2,
                            width: 0.3,
                            height: 0.2,
                        },
                        annotationId: '44R',
                        color: '#22c55e',
                        id: 'markup-1',
                        pageMarkupIndex: 0,
                        source: 'editor-live',
                    }],
                },
            },
            'D:20260609133855+03\'00\'',
            revisionOptions,
        )).resolves.toMatchObject({applied: true});

        expect(ipcRenderer.invoke).toHaveBeenCalledWith(
            DOCUMENTS_CHANNELS.fileSavePdfNativeMutations,
            '/tmp/working.pdf',
            {
                pageLabels: {
                    totalPages: 3,
                    ranges: [{
                        startPage: 1,
                        style: 'r',
                        prefix: 'intro-',
                        startNumber: 2,
                    }],
                },
                bookmarks: {
                    totalPages: 3,
                    untitledLabel: 'Untitled',
                    items: [{
                        title: 'Chapter 1',
                        pageIndex: 0,
                        pageYRatio: null,
                        namedDest: null,
                        bold: true,
                        italic: false,
                        color: '#336699',
                        items: [],
                    }],
                },
                shapes: {
                    totalPages: 3,
                    rewriteShapeState: true,
                    shapes: [expect.objectContaining({
                        id: 'shape-1',
                        type: 'rectangle',
                        stableKey: 'evb-shape:shape-1',
                    })],
                    deletedAnnotationIds: ['44R'],
                    deletedStableKeys: ['evb-shape:deleted'],
                },
                markup: {
                    overrides: [[
                        '44R',
                        'Squiggly',
                    ]],
                    hints: [expect.objectContaining({
                        subtype: 'Squiggly',
                        annotationId: '44R',
                        color: '#22c55e',
                    })],
                },
            },
            'D:20260609133855+03\'00\'',
            revisionOptions,
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
            postMessage: vi.fn(),
        } satisfies Pick<IpcRenderer, 'invoke' | 'postMessage'>;
        const client = createDocumentsPreloadFileClient(ipcRenderer);
        const imageSource = createNativePlacedImage().source;

        await expect(client.applyPdfNativeMutationsToWorkingCopy!(
            '/tmp/working.pdf',
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
            'D:20260609133855+03\'00\'',
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
            'D:20260609133855+03\'00\'',
            revisionOptions,
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

    it('admits every cap-plus-one mutation family in one normalized preload request', async () => {
        const invoke = vi.fn<(
            channel: string,
            ...args: unknown[]
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
            postMessage: vi.fn(),
        } satisfies Pick<IpcRenderer, 'invoke' | 'postMessage'>;
        const client = createDocumentsPreloadFileClient(ipcRenderer);
        const cap = PDF_NATIVE_MUTATION_LIMITS;
        const imageSource = createNativePlacedImage().source;

        await expect(client.savePdfNativeMutations!(
            '/tmp/working.pdf',
            {
                updates: Array.from({length: cap.noteTextUpdates + 1}, (_, index) => ({
                    objectNumber: index + 1,
                    generationNumber: 0,
                    text: `Updated note ${index}`,
                })),
                geometryUpdates: Array.from({length: cap.noteGeometryUpdates + 1}, (_, index) => ({
                    objectNumber: index + 1,
                    generationNumber: 0,
                    pageIndex: requirePageIndex(0),
                    markerRect: {
                        left: 0.1,
                        top: 0.2,
                        width: 0.3,
                        height: 0.2,
                    },
                })),
                freeTextNotes: Array.from({length: cap.noteChanges + 1}, (_, index) => ({
                    pageIndex: requirePageIndex(0),
                    stableKey: `note-${index}`,
                    text: `Editor note ${index}`,
                    markerRect: {
                        left: 0.1,
                        top: 0.2,
                        width: 0.0016,
                        height: 0.0016,
                    },
                })),
                // Keep an old renderer payload here to prove the preload
                // normalizes the compatibility key to textBoxes.
                freeTextEditors: Array.from({length: cap.textBoxes + 1}, (_, index) => ({
                    ...createNativeFreeTextEditor(),
                    stableKey: `editor-${index}`,
                })),
                deletes: Array.from({length: cap.noteChanges + 1}, (_, index) => ({
                    pageIndex: requirePageIndex(0),
                    objectNumber: index + 1,
                    generationNumber: 0,
                })),
                pageLabels: {
                    totalPages: cap.pageLabelRanges + 1,
                    ranges: Array.from({length: cap.pageLabelRanges + 1}, (_, index) => ({
                        startPage: index + 1,
                        style: 'D' as const,
                        prefix: `${index}-`,
                        startNumber: 1,
                    })),
                },
                bookmarks: {
                    totalPages: 3,
                    untitledLabel: 'Untitled',
                    items: Array.from(
                        {length: cap.bookmarkItems + 1},
                        (_, index) => createNativeBookmark(`Chapter ${index}`),
                    ),
                },
                shapes: {
                    totalPages: 3,
                    rewriteShapeState: true,
                    shapes: Array.from({length: cap.shapes + 1}, (_, index) => ({
                        ...createNativeShape(),
                        id: `shape-${index}`,
                    })),
                    deletedAnnotationIds: [],
                    deletedStableKeys: [],
                },
                markup: {
                    overrides: Array.from({length: cap.markupItems + 1}, (_, index) => [
                        `${index + 1}R`,
                        'Highlight',
                    ] as const),
                    hints: [],
                },
                placedImages: Array.from({length: cap.placedImages + 1}, (_, index) => ({
                    ...createNativePlacedImage(),
                    stableKey: `image-${index}`,
                    source: imageSource,
                })),
            },
            'D:20260609133855+03\'00\'',
            revisionOptions,
        )).resolves.toMatchObject({applied: true});

        expect(ipcRenderer.invoke).toHaveBeenCalledOnce();
        const payload = ipcRenderer.invoke.mock.calls[0]?.[2];
        expect(payload).toBeDefined();
        const normalizedPayload = payload as {
            updates: unknown[];
            geometryUpdates: unknown[];
            freeTextNotes: unknown[];
            textBoxes: unknown[];
            deletes: unknown[];
            pageLabels: {ranges: unknown[]};
            bookmarks: {items: unknown[]};
            shapes: {shapes: unknown[]};
            markup: {overrides: unknown[]};
            placedImages: unknown[];
        };
        expect(normalizedPayload.updates).toHaveLength(cap.noteTextUpdates + 1);
        expect(normalizedPayload.geometryUpdates).toHaveLength(cap.noteGeometryUpdates + 1);
        expect(normalizedPayload.freeTextNotes).toHaveLength(cap.noteChanges + 1);
        expect(normalizedPayload.textBoxes).toHaveLength(cap.textBoxes + 1);
        expect(normalizedPayload.deletes).toHaveLength(cap.noteChanges + 1);
        expect(normalizedPayload.pageLabels.ranges).toHaveLength(cap.pageLabelRanges + 1);
        expect(normalizedPayload.bookmarks.items).toHaveLength(cap.bookmarkItems + 1);
        expect(normalizedPayload.shapes.shapes).toHaveLength(cap.shapes + 1);
        expect(normalizedPayload.markup.overrides).toHaveLength(cap.markupItems + 1);
        expect(normalizedPayload.placedImages).toHaveLength(cap.placedImages + 1);
        expect(normalizedPayload.updates.at(-1)).toMatchObject({
            objectNumber: cap.noteTextUpdates + 1,
            text: `Updated note ${cap.noteTextUpdates}`,
        });
        expect(normalizedPayload.geometryUpdates.at(-1)).toMatchObject({objectNumber: cap.noteGeometryUpdates + 1});
        expect(normalizedPayload.freeTextNotes.at(-1)).toMatchObject({
            stableKey: `note-${cap.noteChanges}`,
            text: `Editor note ${cap.noteChanges}`,
        });
        expect(normalizedPayload.textBoxes.at(-1)).toMatchObject({stableKey: `editor-${cap.textBoxes}`});
        expect(normalizedPayload.deletes.at(-1)).toMatchObject({objectNumber: cap.noteChanges + 1});
        expect(normalizedPayload.pageLabels.ranges.at(-1)).toMatchObject({
            startPage: cap.pageLabelRanges + 1,
            prefix: `${cap.pageLabelRanges}-`,
        });
        expect(normalizedPayload.bookmarks.items.at(-1)).toMatchObject({title: `Chapter ${cap.bookmarkItems}`});
        expect(normalizedPayload.shapes.shapes.at(-1)).toMatchObject({id: `shape-${cap.shapes}`});
        expect(normalizedPayload.markup.overrides.at(-1)).toEqual([
            `${cap.markupItems + 1}R`,
            'Highlight',
        ]);
        expect(normalizedPayload.placedImages.at(-1)).toMatchObject({
            stableKey: `image-${cap.placedImages}`,
            source: imageSource,
        });
    });

    it('rejects shared native mutation limit violations before IPC', () => {
        const ipcRenderer = {
            invoke: vi.fn(),
            postMessage: vi.fn(),
        } satisfies Pick<IpcRenderer, 'invoke' | 'postMessage'>;
        const client = createDocumentsPreloadFileClient(ipcRenderer);
        const modifiedAt = 'D:20260609133855+03\'00\'';
        const tooManyCollectionItems = () => Array.from(
            {length: PDF_NATIVE_MUTATION_LIMITS.collectionItems + 1},
            () => undefined as never,
        );

        expect(() => client.savePdfNoteChanges!(
            '/tmp/working.pdf',
            {freeTextNotes: tooManyCollectionItems()},
            modifiedAt,
            revisionOptions,
        )).toThrow(`at most ${PDF_NATIVE_MUTATION_LIMITS.collectionItems} notes`);

        expect(() => client.savePdfNativeMutations!(
            '/tmp/working.pdf',
            {pageLabels: {
                totalPages: 3,
                ranges: tooManyCollectionItems(),
            }},
            modifiedAt,
            revisionOptions,
        )).toThrow(`at most ${PDF_NATIVE_MUTATION_LIMITS.collectionItems} ranges`);

        expect(() => client.savePdfNativeMutations!(
            '/tmp/working.pdf',
            {bookmarks: {
                totalPages: 3,
                untitledLabel: 'Untitled',
                items: createDeepNativeBookmarkItems(PDF_NATIVE_MUTATION_LIMITS.bookmarkDepth + 1),
            }},
            modifiedAt,
            revisionOptions,
        )).toThrow('maximum bookmark depth');

        expect(() => client.savePdfNativeMutations!(
            '/tmp/working.pdf',
            {shapes: {
                totalPages: 3,
                rewriteShapeState: true,
                shapes: [{
                    ...createNativeShape(),
                    points: Array.from({length: PDF_NATIVE_MUTATION_LIMITS.shapePoints + 1}, () => ({
                        x: 0.1,
                        y: 0.2,
                    })),
                }],
                deletedAnnotationIds: [],
                deletedStableKeys: [],
            }},
            modifiedAt,
            revisionOptions,
        )).toThrow(`at most ${PDF_NATIVE_MUTATION_LIMITS.shapePoints} points`);

        expect(() => client.savePdfNativeMutations!(
            '/tmp/working.pdf',
            {markup: {
                overrides: tooManyCollectionItems(),
                hints: [],
            }},
            modifiedAt,
            revisionOptions,
        )).toThrow(`at most ${PDF_NATIVE_MUTATION_LIMITS.collectionItems} items`);

        expect(() => client.applyPdfNativeMutationsToWorkingCopy!(
            '/tmp/working.pdf',
            {placedImages: tooManyCollectionItems()},
            modifiedAt,
            revisionOptions,
        )).toThrow(`at most ${PDF_NATIVE_MUTATION_LIMITS.collectionItems} images`);

        expect(() => client.applyPdfNativeMutationsToWorkingCopy!(
            '/tmp/working.pdf',
            {placedImages: [createNativePlacedImage()]},
            modifiedAt,
            undefined as never,
        )).toThrow('applyPdfNativeMutationsToWorkingCopy.options.expectedDocumentRevisionToken');

        expect(ipcRenderer.invoke).not.toHaveBeenCalled();
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

async function waitForCondition(assertion: () => void) {
    let lastError: unknown;
    for (let attempt = 0; attempt < 20; attempt += 1) {
        try {
            assertion();
            return;
        } catch (error) {
            lastError = error;
            await new Promise<void>(resolve => setImmediate(resolve));
        }
    }
    throw lastError;
}
