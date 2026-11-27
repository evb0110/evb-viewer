import {createReadStream} from 'node:fs';
import {
    lstat,
    mkdtemp,
    open,
    readdir,
    rm,
    stat,
} from 'node:fs/promises';
import {join} from 'node:path';
import {createAbortError} from '@contracts/isAbortError';
import {
    getCurrentMainOperationCancellationSignal,
    registerMainOperation,
} from '@electron/operation-lifecycle/mainOperationLifecycle';
import {cancelNativeCommandGroup} from '@electron/native-tools/runNativeCommand';

export interface IPdfSidecarLine {
    offset: number;
    byteLength: number;
}

export interface IScannedPdfSidecar {
    dataStartOffset: number;
    dataBytes: number;
    pageCount: number;
    entryCount: number;
    lines: IPdfSidecarLine[];
}

export interface IPdfSidecarSessionLifecycleState {
    sessionId: string;
    sidecarDirectory: string;
    operationPromise: Promise<unknown>;
    lastTouchedAt: number;
    unregisterSenderCleanup?: () => void;
    cleanupPromise?: Promise<void>;
}

export interface IPdfSidecarSessionStateBase extends IPdfSidecarSessionLifecycleState {
    ownerId: number;
    abortController: AbortController;
    cancelGroup: string;
    index: IScannedPdfSidecar;
    canceled: boolean;
    released: boolean;
}

export type TPdfSidecarSessionState<TRevision> = IPdfSidecarSessionStateBase & {
    documentRef: string;
    resolvedPath: string;
    expectedRevisionToken: TRevision;
    sidecarPath: string;
};

interface ICreatePdfSidecarSessionStateOptions<TRevision> {
    sessionId: string;
    ownerId: number;
    documentRef: string;
    resolvedPath: string;
    expectedRevisionToken: TRevision;
    sidecarDirectory: string;
    sidecarPath: string;
    index?: IScannedPdfSidecar;
    cancelGroup: string;
}

export interface IPdfSidecarMainOperation {
    signal: AbortSignal;
    complete: () => void;
}

export interface ISweepStalePdfSidecarArtifactsOptions {
    tempDir: string;
    directoryPrefix: string;
    activeDirectories: ReadonlySet<string>;
    maxAgeMs: number;
    maxEntries: number;
    onError: (directoryPath: string, error: unknown) => void;
}

export interface IReadPdfSidecarChunkOptions<TEntry> {
    sidecarPath: string;
    index: IScannedPdfSidecar;
    offset: number;
    chunkBytes: number;
    label: string;
    decodeDataLine: (value: unknown) => TEntry[];
    beforeRead?: () => Promise<void>;
    afterRead?: () => Promise<void>;
}

function createPdfSidecarSessionState<TRevision>({
    sessionId,
    ownerId,
    documentRef,
    resolvedPath,
    expectedRevisionToken,
    sidecarDirectory,
    sidecarPath,
    index,
    cancelGroup,
}: ICreatePdfSidecarSessionStateOptions<TRevision>) {
    return {
        sessionId,
        ownerId,
        documentRef,
        resolvedPath,
        expectedRevisionToken,
        sidecarDirectory,
        sidecarPath,
        index: index ?? {
            dataStartOffset: 0,
            dataBytes: 0,
            pageCount: 0,
            entryCount: 0,
            lines: [],
        },
        abortController: new AbortController(),
        cancelGroup,
        operationPromise: Promise.resolve(),
        lastTouchedAt: Date.now(),
        canceled: false,
        released: false,
    };
}

async function registerPdfSidecarMainOperation(
    options: Parameters<typeof registerMainOperation>[0],
    onRegistrationError: (error: unknown) => Promise<void>,
): Promise<ReturnType<typeof registerMainOperation>> {
    try {
        return registerMainOperation(options);
    } catch (error) {
        await onRegistrationError(error);
        throw error;
    }
}

export function cancelPdfSidecarSession(
    session: IPdfSidecarSessionStateBase,
    reason: string,
    abortReason: Error = createAbortError(reason),
) {
    session.canceled = true;
    if (!session.abortController.signal.aborted) {
        session.abortController.abort(abortReason);
    }
    cancelNativeCommandGroup(session.cancelGroup);
}

async function beginPdfSidecarMainOperation<TSession extends IPdfSidecarSessionStateBase>({
    session,
    sessions,
    ownerWebContentsId,
    workingCopyPath,
    cleanup,
    cancelGroupForOperation,
    registerSenderCleanup,
}: {
    session: TSession;
    sessions: Map<string, TSession>;
    ownerWebContentsId: number | undefined;
    workingCopyPath: string;
    cleanup: (session: TSession) => Promise<void>;
    cancelGroupForOperation: (operationId: string) => string;
    registerSenderCleanup?: ((cancel: (reason: string) => void) => () => void) | undefined;
}) {
    sessions.set(session.sessionId, session);
    const invokeCancellationSignal = getCurrentMainOperationCancellationSignal();
    const cancel = (reason: string) => cancelPdfSidecarSession(
        session,
        reason,
        invokeCancellationSignal?.aborted && invokeCancellationSignal.reason instanceof Error
            ? invokeCancellationSignal.reason
            : createAbortError(reason),
    );
    const mainOperation = await registerPdfSidecarMainOperation({
        kind: 'abortable-work',
        ownerWebContentsId,
        workingCopyPath,
        cancel,
    }, () => cleanup(session));
    session.cancelGroup = cancelGroupForOperation(mainOperation.id);
    const unregisterSenderCleanup = registerSenderCleanup?.(cancel);
    if (unregisterSenderCleanup) {
        session.unregisterSenderCleanup = unregisterSenderCleanup;
    }
    const detachSenderCleanup = () => {
        session.unregisterSenderCleanup?.();
        delete session.unregisterSenderCleanup;
    };
    return {
        mainOperation,
        cancel,
        detachSenderCleanup,
    };
}

export async function createPdfSidecarMainOperation<
    TRevision,
    TSession extends TPdfSidecarSessionState<TRevision>,
>({
    sessionId,
    ownerId,
    documentRef,
    resolvedPath,
    expectedRevisionToken,
    tempDir,
    directoryPrefix,
    fileName,
    cancelGroup,
    sessions,
    ownerWebContentsId,
    workingCopyPath,
    cleanup,
    cancelGroupForOperation,
    registerSenderCleanup,
}: {
    sessionId: string;
    ownerId: number;
    documentRef: string;
    resolvedPath: string;
    expectedRevisionToken: TRevision;
    tempDir: string;
    directoryPrefix: string;
    fileName: string;
    cancelGroup: string;
    sessions: Map<string, TSession>;
    ownerWebContentsId: number | undefined;
    workingCopyPath: string;
    cleanup: (session: TSession) => Promise<void>;
    cancelGroupForOperation: (operationId: string) => string;
    registerSenderCleanup?: ((cancel: (reason: string) => void) => () => void) | undefined;
}) {
    const sidecarDirectory = await mkdtemp(join(tempDir, directoryPrefix));
    const session = createPdfSidecarSessionState({
        sessionId,
        ownerId,
        documentRef,
        resolvedPath,
        expectedRevisionToken,
        sidecarDirectory,
        sidecarPath: join(sidecarDirectory, fileName),
        cancelGroup,
    }) as TSession;
    return {
        session,
        ...await beginPdfSidecarMainOperation({
            session,
            sessions,
            ownerWebContentsId,
            workingCopyPath,
            cleanup,
            cancelGroupForOperation,
            registerSenderCleanup,
        }),
    };
}

async function completePdfSidecarMainOperation<TSession extends IPdfSidecarSessionStateBase>(
    session: TSession,
    mainOperation: IPdfSidecarMainOperation,
    handleMainAbort: () => void,
    cleanup: (session: TSession) => Promise<void>,
    beforeComplete?: () => void,
) {
    mainOperation.signal.removeEventListener('abort', handleMainAbort);
    beforeComplete?.();
    mainOperation.complete();
    if (session.canceled || session.released) {
        await cleanup(session);
    }
}

async function awaitPdfSidecarOperation<TSession extends IPdfSidecarSessionLifecycleState>(
    session: TSession,
    cleanup: (session: TSession) => Promise<void>,
) {
    try {
        await session.operationPromise;
    } catch (error) {
        await cleanup(session);
        throw error;
    }
}

export async function runPdfSidecarOperation<TSession extends IPdfSidecarSessionStateBase>(
    session: TSession,
    mainOperation: IPdfSidecarMainOperation,
    handleMainAbort: () => void,
    cleanup: (session: TSession) => Promise<void>,
    operation: () => Promise<void>,
    beforeComplete?: () => void,
) {
    session.operationPromise = (async () => {
        try {
            await operation();
            session.lastTouchedAt = Date.now();
        } catch (error) {
            session.canceled = session.canceled || session.abortController.signal.aborted;
            throw error;
        } finally {
            await completePdfSidecarMainOperation(
                session,
                mainOperation,
                handleMainAbort,
                cleanup,
                beforeComplete,
            );
        }
    })();
    await awaitPdfSidecarOperation(session, cleanup);
}

export interface IScanPdfSidecarOptions<TData> {
    maxLineBytes: number;
    label: string;
    decodeHeader: (value: unknown) => number;
    decodeDataLine: (value: unknown) => TData[];
    signal?: AbortSignal;
}

const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

function addSafePdfSidecarOffset(left: number, right: number, fieldName: string) {
    const result = left + right;
    if (!Number.isSafeInteger(result) || result < 0) {
        throw new RangeError(`${fieldName} exceeds the safe integer range`);
    }
    return result;
}

export function assertSafePdfSidecarOffset(value: number, fieldName: string) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError(`${fieldName} must be a non-negative safe integer`);
    }
    return value;
}

function parsePdfSidecarJsonLine(bytes: Buffer, label: string) {
    const withoutNewline = bytes[bytes.length - 1] === 0x0a
        ? bytes.subarray(0, bytes.length - 1)
        : bytes;
    const jsonBytes = withoutNewline[withoutNewline.length - 1] === 0x0d
        ? withoutNewline.subarray(0, withoutNewline.length - 1)
        : withoutNewline;
    if (jsonBytes.length === 0) {
        throw new Error(`PDF sidecar contains an empty ${label} line`);
    }
    try {
        return JSON.parse(jsonBytes.toString('utf8')) as unknown;
    } catch (error) {
        throw new Error(`PDF sidecar contains invalid JSON in its ${label} line`, {cause: error});
    }
}

/**
 * Scan a bounded JSONL sidecar once and retain only line offsets. The native
 * hosts use different decoders, but all three sidecars share this byte-level
 * framing. Keeping the scanner here prevents a new format from acquiring a
 * subtly different offset or oversized-line policy.
 */
export function scanPdfSidecarLines<TData>(
    sidecarPath: string,
    options: IScanPdfSidecarOptions<TData>,
): Promise<IScannedPdfSidecar> {
    return new Promise((resolveScan, rejectScan) => {
        const lines: IPdfSidecarLine[] = [];
        let stream: ReturnType<typeof createReadStream> | null = null;
        let pending = Buffer.alloc(0) as Buffer;
        let pendingStartOffset = 0;
        let dataStartOffset = 0;
        let totalBytes = 0;
        let headerPageCount: number | null = null;
        let entryCount = 0;
        let headerSeen = false;
        let settled = false;
        let removeAbortListener: () => void = () => undefined;

        const rejectOnce = (error: unknown) => {
            if (settled) {
                return;
            }
            settled = true;
            removeAbortListener();
            stream?.destroy();
            rejectScan(error);
        };
        const processLine = (line: Buffer, offset: number) => {
            if (line.length === 0 || line.length > options.maxLineBytes) {
                throw new Error(`${options.label} sidecar line exceeds ${options.maxLineBytes} bytes`);
            }
            const lineValue = parsePdfSidecarJsonLine(line, headerSeen ? 'data' : 'header');
            if (!headerSeen) {
                headerPageCount = options.decodeHeader(lineValue);
                dataStartOffset = addSafePdfSidecarOffset(
                    offset,
                    line.length,
                    `${options.label} offset`,
                );
                headerSeen = true;
                return;
            }
            const entries = options.decodeDataLine(lineValue);
            entryCount = addSafePdfSidecarOffset(
                entryCount,
                entries.length,
                `${options.label} entry count`,
            );
            lines.push({
                offset: addSafePdfSidecarOffset(
                    offset,
                    -dataStartOffset,
                    `${options.label} offset`,
                ),
                byteLength: line.length,
            });
        };
        const consume = (chunk: Buffer) => {
            totalBytes = addSafePdfSidecarOffset(totalBytes, chunk.length, `${options.label} sidecar size`);
            pending = pending.length === 0 ? chunk : Buffer.concat([
                pending,
                chunk,
            ]);
            if (pending.length > options.maxLineBytes && pending.indexOf(0x0a) < 0) {
                throw new Error(`${options.label} sidecar line exceeds ${options.maxLineBytes} bytes`);
            }
            let newlineIndex = pending.indexOf(0x0a);
            while (newlineIndex >= 0) {
                const lineLength = newlineIndex + 1;
                processLine(pending.subarray(0, lineLength), pendingStartOffset);
                pendingStartOffset = addSafePdfSidecarOffset(
                    pendingStartOffset,
                    lineLength,
                    `${options.label} offset`,
                );
                pending = pending.subarray(lineLength);
                newlineIndex = pending.indexOf(0x0a);
            }
            if (pending.length > options.maxLineBytes) {
                throw new Error(`${options.label} sidecar line exceeds ${options.maxLineBytes} bytes`);
            }
        };

        if (options.signal?.aborted) {
            rejectOnce(options.signal.reason ?? createAbortError(`${options.label} sidecar scan was aborted`));
            return;
        }
        const handleAbort = () => rejectOnce(
            options.signal?.reason ?? createAbortError(`${options.label} sidecar scan was aborted`),
        );
        options.signal?.addEventListener('abort', handleAbort, {once: true});
        removeAbortListener = () => options.signal?.removeEventListener('abort', handleAbort);
        stream = createReadStream(sidecarPath, {
            highWaterMark: 64 * 1_024,
            signal: options.signal,
        });
        stream.on('data', (chunk: Buffer | string) => {
            try {
                consume(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
            } catch (error) {
                rejectOnce(error);
            }
        });
        stream.once('error', rejectOnce);
        stream.once('end', () => {
            if (settled) {
                return;
            }
            try {
                if (pending.length > 0) {
                    processLine(pending, pendingStartOffset);
                    pendingStartOffset = addSafePdfSidecarOffset(
                        pendingStartOffset,
                        pending.length,
                        `${options.label} offset`,
                    );
                }
                if (headerPageCount === null) {
                    throw new Error(`${options.label} sidecar is empty`);
                }
                if (pendingStartOffset !== totalBytes) {
                    throw new Error(`${options.label} sidecar offset accounting failed`);
                }
                settled = true;
                removeAbortListener();
                resolveScan({
                    dataStartOffset,
                    dataBytes: addSafePdfSidecarOffset(
                        totalBytes,
                        -dataStartOffset,
                        `${options.label} bytes`,
                    ),
                    pageCount: headerPageCount,
                    entryCount,
                    lines,
                });
            } catch (error) {
                rejectOnce(error);
            }
        });
    });
}

function findPdfSidecarLineIndex(lines: readonly IPdfSidecarLine[], offset: number) {
    let low = 0;
    let high = lines.length - 1;
    while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const line = lines[middle]!;
        if (line.offset === offset) {
            return middle;
        }
        if (line.offset < offset) {low = middle + 1;}
        else {high = middle - 1;}
    }
    return -1;
}

async function readPdfSidecarLine(
    sidecarPath: string,
    dataStartOffset: number,
    line: IPdfSidecarLine,
    label: string,
) {
    const absoluteOffset = addSafePdfSidecarOffset(dataStartOffset, line.offset, `${label} offset`);
    const lineBytes = Buffer.allocUnsafe(line.byteLength);
    const sidecarHandle = await open(sidecarPath, 'r');
    try {
        let bytesRead = 0;
        while (bytesRead < line.byteLength) {
            const readResult = await sidecarHandle.read(
                lineBytes,
                bytesRead,
                line.byteLength - bytesRead,
                absoluteOffset + bytesRead,
            );
            if (readResult.bytesRead === 0) {
                throw new Error(`${label} sidecar ended before the requested chunk`);
            }
            bytesRead += readResult.bytesRead;
        }
    } finally {
        await sidecarHandle.close();
    }
    return lineBytes;
}

async function assertPdfSidecarFitsSafeOffsetRange(sidecarPath: string, label: string) {
    const sidecarStat = await stat(sidecarPath, {bigint: true});
    if (sidecarStat.size > MAX_SAFE_INTEGER_BIGINT) {
        throw new Error(`${label} sidecar exceeds the safe offset range`);
    }
    return Number(sidecarStat.size);
}

export async function scanPdfSidecarIntoSession<TSession extends IPdfSidecarSessionStateBase>(
    session: TSession,
    sidecarPath: string,
    signal: AbortSignal,
    label: string,
    assertRevisionCurrent: () => Promise<void>,
    scan: (signal: AbortSignal) => Promise<IScannedPdfSidecar>,
) {
    await assertRevisionCurrent();
    const sidecarSize = await assertPdfSidecarFitsSafeOffsetRange(sidecarPath, label);
    session.index = await scan(signal);
    if (session.index.dataBytes !== sidecarSize - session.index.dataStartOffset) {
        throw new Error(`${label} sidecar changed while it was being indexed`);
    }
}

export async function cleanupPdfSidecarSession<TSession extends IPdfSidecarSessionLifecycleState>(
    sessions: Map<string, TSession>,
    session: TSession,
    onError: (error: unknown) => void,
) {
    if (session.cleanupPromise) {
        return session.cleanupPromise;
    }
    sessions.delete(session.sessionId);
    session.unregisterSenderCleanup?.();
    delete session.unregisterSenderCleanup;
    session.cleanupPromise = rm(session.sidecarDirectory, {
        force: true,
        recursive: true,
    }).catch(error => {
        onError(error);
    });
    return session.cleanupPromise;
}

export function cleanupPdfSidecarSessionWhenOperationSettles<TSession extends IPdfSidecarSessionLifecycleState>(
    session: TSession,
    cleanup: (session: TSession) => Promise<void>,
) {
    void session.operationPromise
        .catch(() => undefined)
        .then(() => cleanup(session));
}

export function expireStalePdfSidecarSessions<TSession extends IPdfSidecarSessionLifecycleState>(
    sessions: Iterable<TSession>,
    cutoff: number,
    onExpire: (session: TSession) => void,
) {
    for (const session of sessions) {
        if (session.lastTouchedAt < cutoff) {
            onExpire(session);
        }
    }
}

export async function sweepStalePdfSidecarArtifacts({
    tempDir,
    directoryPrefix,
    activeDirectories,
    maxAgeMs,
    maxEntries,
    onError,
}: ISweepStalePdfSidecarArtifactsOptions) {
    const now = Date.now();
    let entries: string[];
    try {
        entries = await readdir(tempDir);
    } catch {
        return 0;
    }
    let deletedCount = 0;
    for (const entry of entries
        .filter(name => name.startsWith(directoryPrefix))
        .slice(0, maxEntries)) {
        const directoryPath = join(tempDir, entry);
        if (activeDirectories.has(directoryPath)) {continue;}
        try {
            const directoryStat = await lstat(directoryPath);
            if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {continue;}
            if (now - Math.floor(Math.max(directoryStat.mtimeMs, directoryStat.ctimeMs)) < maxAgeMs) {continue;}
            await rm(directoryPath, {
                force: true,
                recursive: true,
            });
            deletedCount += 1;
        } catch (error) {
            onError(directoryPath, error);
        }
    }
    return deletedCount;
}

export async function readPdfSidecarChunk<TEntry>({
    sidecarPath,
    index,
    offset,
    chunkBytes,
    label,
    decodeDataLine,
    beforeRead,
    afterRead,
}: IReadPdfSidecarChunkOptions<TEntry>) {
    await beforeRead?.();
    if (offset === index.dataBytes) {
        return {
            offset,
            nextOffset: null,
            byteLength: 0,
            done: true,
            entries: [] as TEntry[],
        };
    }
    const lineIndex = findPdfSidecarLineIndex(index.lines, offset);
    if (lineIndex < 0) {
        throw new RangeError(`${label} offset must point to the beginning of a chunk line`);
    }
    const line = index.lines[lineIndex]!;
    if (line.byteLength > chunkBytes) {
        throw new RangeError(`${label} line requires a chunk of at least ${line.byteLength} bytes`);
    }
    const lineBytes = await readPdfSidecarLine(
        sidecarPath,
        index.dataStartOffset,
        line,
        label,
    );
    await afterRead?.();
    const entries = decodeDataLine(parsePdfSidecarJsonLine(lineBytes, 'data'));
    const nextOffset = lineIndex + 1 < index.lines.length
        ? addSafePdfSidecarOffset(line.offset, line.byteLength, `${label} offset`)
        : null;
    return {
        offset,
        nextOffset,
        byteLength: line.byteLength,
        done: nextOffset === null,
        entries,
    };
}
