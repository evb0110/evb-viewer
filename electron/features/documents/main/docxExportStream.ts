import type { WebContents } from 'electron';
import {
    open,
    unlink,
} from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
    DOCX_EXPORT_STREAM_MAX_CHUNK_BYTES,
    DOCX_EXPORT_STREAM_SESSION_TIMEOUT_MS,
    type IDocxExportStreamBeginResult,
} from '@contracts/docxExport';
import { consumeAllowedDocxWritePath } from '@electron/file-access/docxExportPaths';
import {assertNoSymlinkPathSegments} from '@electron/file-access/assertNoSymlinkPathSegments';
import { normalizeNonEmptyPath } from '@electron/features/documents/main/documentFilePathResolution';
import {
    atomicReplace,
    makeSiblingTempPath,
} from '@electron/utils/atomicReplace';
import { syncFileHandleForDurability } from '@electron/utils/syncFileHandleForDurability';
import { onSenderLifetimeEnd } from '@electron/utils/onSenderLifetimeEnd';
import type { IDocumentsSenderIdContext } from '@electron/features/documents/documentsService';
import {
    createSessionId,
    requireSessionId,
    type TSessionId,
} from '@contracts/shared';

interface IDocxExportStreamSession {
    id: TSessionId;
    senderId: number;
    sender: WebContents;
    targetPath: string;
    tempPath: string;
    handle: FileHandle;
    receivedBytes: number;
    committing: boolean;
    cancelRequested: boolean;
    replacementStarted: boolean;
    committed: boolean;
    commitPromise: Promise<boolean> | null;
    queue: Promise<void>;
    timeout: NodeJS.Timeout;
    unregisterSenderCleanup: () => void;
}

const sessions = new Map<TSessionId, IDocxExportStreamSession>();

function requireSenderId(context: IDocumentsSenderIdContext) {
    if (typeof context.senderId !== 'number') {
        throw new Error('Missing sender identity');
    }
    return context.senderId;
}

function requireSender(context: IDocumentsSenderIdContext) {
    if (!context.sender) {
        throw new Error('Missing sender');
    }
    return context.sender;
}

function normalizeSessionId(value: unknown) {
    return requireSessionId(value);
}

function normalizeChunk(value: unknown) {
    if (!(value instanceof Uint8Array)) {
        throw new Error('DOCX stream chunks must be Uint8Array values');
    }
    if (value.byteLength === 0) {
        throw new Error('DOCX stream chunks must not be empty');
    }
    if (value.byteLength > DOCX_EXPORT_STREAM_MAX_CHUNK_BYTES) {
        throw new Error(
            `DOCX stream chunks exceed the maximum size (${DOCX_EXPORT_STREAM_MAX_CHUNK_BYTES} bytes)`,
        );
    }
    return value;
}

function clearSessionTimeout(session: IDocxExportStreamSession) {
    clearTimeout(session.timeout);
}

// Read through a call so the compiler does not narrow the flag to `false` across
// the awaits in commitDocxExportStream; cancel can flip it between any two of them.
function isDocxExportStreamCancellationRequested(session: IDocxExportStreamSession) {
    return session.cancelRequested;
}

function refreshSessionTimeout(session: IDocxExportStreamSession) {
    clearSessionTimeout(session);
    session.timeout = setTimeout(() => {
        if (sessions.get(session.id) === session) {
            void abortSession(session);
        }
    }, DOCX_EXPORT_STREAM_SESSION_TIMEOUT_MS);
    session.timeout.unref();
}

function unregisterSessionSenderCleanup(session: IDocxExportStreamSession) {
    session.unregisterSenderCleanup();
    session.unregisterSenderCleanup = () => undefined;
}

function registerSessionSenderCleanup(session: IDocxExportStreamSession) {
    const cleanup = () => {
        if (sessions.get(session.id) === session) {
            void abortSession(session);
        }
    };
    return onSenderLifetimeEnd(session.sender, cleanup, {navigation: true});
}

async function closeAndRemoveTemp(session: IDocxExportStreamSession) {
    await session.handle.close().catch(() => undefined);
    await unlink(session.tempPath).catch(() => undefined);
}

async function abortSession(session: IDocxExportStreamSession) {
    if (sessions.get(session.id) !== session) {
        return;
    }
    if (session.committing) {
        session.cancelRequested = true;
        return;
    }
    sessions.delete(session.id);
    clearSessionTimeout(session);
    unregisterSessionSenderCleanup(session);
    await session.queue.catch(() => undefined);
    await closeAndRemoveTemp(session);
}

function getSession(context: IDocumentsSenderIdContext, rawSessionId: unknown) {
    const senderId = requireSenderId(context);
    const sessionId = normalizeSessionId(rawSessionId);
    const session = sessions.get(sessionId);
    if (!session || session.senderId !== senderId || session.committing) {
        throw new Error('Invalid DOCX stream session');
    }
    refreshSessionTimeout(session);
    return session;
}

export async function beginDocxExportStream(
    context: IDocumentsSenderIdContext,
    filePath: unknown,
): Promise<IDocxExportStreamBeginResult> {
    const senderId = requireSenderId(context);
    const sender = requireSender(context);
    const normalizedPath = normalizeNonEmptyPath(filePath);
    if (!consumeAllowedDocxWritePath(normalizedPath, senderId)) {
        throw new Error('Invalid file path: DOCX writes must use a path from Save dialog');
    }

    const targetPath = resolve(normalizedPath);
    assertNoSymlinkPathSegments(targetPath);
    const tempPath = makeSiblingTempPath(targetPath);
    const handle = await open(tempPath, 'wx');
    const id = createSessionId('docx-export');
    const timeout = setTimeout(() => undefined, DOCX_EXPORT_STREAM_SESSION_TIMEOUT_MS);
    timeout.unref();
    const session: IDocxExportStreamSession = {
        id,
        senderId,
        sender,
        targetPath,
        tempPath,
        handle,
        receivedBytes: 0,
        committing: false,
        cancelRequested: false,
        replacementStarted: false,
        committed: false,
        commitPromise: null,
        queue: Promise.resolve(),
        timeout,
        unregisterSenderCleanup: () => undefined,
    };
    session.unregisterSenderCleanup = registerSessionSenderCleanup(session);
    refreshSessionTimeout(session);
    sessions.set(id, session);
    return {sessionId: id};
}

async function writeChunkToHandle(handle: FileHandle, chunk: Uint8Array) {
    let offset = 0;
    while (offset < chunk.byteLength) {
        const result = await handle.write(chunk, offset, chunk.byteLength - offset);
        if (result.bytesWritten < 1) {
            throw new Error('DOCX stream write made no progress');
        }
        offset += result.bytesWritten;
    }
}

export function nextDocxExportStreamByteCount(receivedBytes: number, chunkBytes: number) {
    const nextReceivedBytes = receivedBytes + chunkBytes;
    if (!Number.isSafeInteger(nextReceivedBytes)) {
        throw new RangeError('DOCX stream byte count exceeds the safe integer limit');
    }
    return nextReceivedBytes;
}

export async function writeDocxExportStreamChunk(
    context: IDocumentsSenderIdContext,
    rawSessionId: unknown,
    rawChunk: unknown,
) {
    const session = getSession(context, rawSessionId);
    const chunk = normalizeChunk(rawChunk);
    const write = session.queue.then(async () => {
        const nextReceivedBytes = nextDocxExportStreamByteCount(session.receivedBytes, chunk.byteLength);
        await writeChunkToHandle(session.handle, chunk);
        session.receivedBytes = nextReceivedBytes;
    });
    session.queue = write;
    try {
        await write;
    } catch (error) {
        await abortSession(session);
        throw error;
    }
    refreshSessionTimeout(session);
    return true;
}

export async function commitDocxExportStream(
    context: IDocumentsSenderIdContext,
    rawSessionId: unknown,
) {
    const session = getSession(context, rawSessionId);
    session.committing = true;
    clearSessionTimeout(session);
    unregisterSessionSenderCleanup(session);
    const commitPromise = (async () => {
        try {
            await session.queue;
            if (isDocxExportStreamCancellationRequested(session)) {
                await closeAndRemoveTemp(session);
                return false;
            }
            await syncFileHandleForDurability(session.handle);
            if (isDocxExportStreamCancellationRequested(session)) {
                await closeAndRemoveTemp(session);
                return false;
            }
            await session.handle.close();
            if (isDocxExportStreamCancellationRequested(session)) {
                await closeAndRemoveTemp(session);
                return false;
            }
            assertNoSymlinkPathSegments(session.targetPath);
            if (isDocxExportStreamCancellationRequested(session)) {
                await closeAndRemoveTemp(session);
                return false;
            }
            session.replacementStarted = true;
            await atomicReplace(session.tempPath, session.targetPath);
            session.committed = true;
            return true;
        } catch (error) {
            await closeAndRemoveTemp(session);
            throw error;
        } finally {
            if (sessions.get(session.id) === session) {
                sessions.delete(session.id);
            }
        }
    })();
    session.commitPromise = commitPromise;
    return commitPromise;
}

export async function cancelDocxExportStream(
    context: IDocumentsSenderIdContext,
    rawSessionId: unknown,
) {
    const senderId = requireSenderId(context);
    const sessionId = normalizeSessionId(rawSessionId);
    const session = sessions.get(sessionId);
    if (!session || session.senderId !== senderId) {
        return false;
    }
    if (session.committing) {
        if (session.replacementStarted || session.committed) {
            return false;
        }
        session.cancelRequested = true;
        return true;
    }
    await abortSession(session);
    return true;
}
