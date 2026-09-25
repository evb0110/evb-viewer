import type { IpcRenderer } from 'electron';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { DOCUMENTS_CHANNELS } from '@electron/features/documents/contract';
import {
    DOCX_EXPORT_STREAM_CHANNELS,
    DOCX_EXPORT_STREAM_MAX_CHUNK_BYTES,
} from '@contracts/docxExport';
import { createDocumentsPreloadStreams } from '@electron/features/documents/createDocumentsPreloadStreams';
import {requireDocumentRef} from '@contracts/documentRef';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';
import {waitForCondition} from '@tests/unit/electron/waitForCondition';

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

describe('createDocumentsPreloadStreams', () => {
    const revisionOptions = { expectedDocumentRevisionToken: requireDocumentRevisionToken('revision-before-save') };

    afterEach(() => {
        vi.unstubAllGlobals();
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
        const client = createDocumentsPreloadStreams(ipcRenderer);

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
        const client = createDocumentsPreloadStreams(ipcRenderer);

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
        const client = createDocumentsPreloadStreams(ipcRenderer);
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
        const client = createDocumentsPreloadStreams(ipcRenderer);

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
        const client = createDocumentsPreloadStreams(ipcRenderer);
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
            const client = createDocumentsPreloadStreams(ipcRenderer);
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
