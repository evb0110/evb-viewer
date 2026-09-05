import {randomUUID} from 'node:crypto';
import {
    lstat,
    mkdtemp,
    readdir,
    rm,
} from 'node:fs/promises';
import {join} from 'node:path';
import type {
    IPdfAnnotationForeignEntry,
    IPdfAnnotationParseChunk,
    IPdfAnnotationParseEntry,
    IPdfAnnotationParseOptions,
    IPdfAnnotationParseResult,
    IPdfAnnotationParseSession,
    TPdfAnnotationParseEntity,
} from '@contracts/pdfAnnotationParseTypes';
import {
    PDF_ANNOTATION_PARSE_MAX_ENTRIES,
    PDF_ANNOTATION_PARSE_MAX_LINE_BYTES,
} from '@contracts/pdfAnnotationParseTypes';
import {createStaleRevisionError} from '@contracts/documentMutationErrors';
import {
    parseDocumentRevisionToken,
    type TDocumentRevisionToken,
} from '@contracts/documentRevision';
import {decodePdfAnnotationParseEntry} from '@contracts/pdfAnnotationParseSchemas';
import type {IDocumentsSenderIdContext} from '@electron/features/documents/documentsService';
import {resolveExistingReadablePdfPath} from '@electron/features/documents/main/documentFilePathResolution';
import {
    assertWorkingCopyRevisionCurrent,
    getWorkingCopyRevision,
} from '@electron/file-access/documentRevisionStore';
import {runWithWorkingCopyReadBacking} from '@electron/file-access/runWithWorkingCopyReadBacking';
import {
    isNativePageOpsDisabled,
    resolveNativePageOpsPath,
} from '@electron/features/page-ops/public/nativePageOpsPath';
import {getPdfNativeToolPaths} from '@electron/pdf/nativeToolPaths';
import {runNativeToolCommand} from '@electron/native-tools/runNativeToolCommand';
import {cancelNativeCommandGroup} from '@electron/native-tools/runNativeCommand';
import {registerMainOperation} from '@electron/operation-lifecycle/mainOperationLifecycle';
import {registerNativePdfSenderCleanup} from '@electron/features/documents/main/nativePdfPreview';
import {getAppTempDir} from '@electron/utils/appTempDir';
import {createLogger} from '@electron/utils/createLogger';
import {abortErrorFromSignal} from '@electron/utils/abort';
import {isRecord} from '@contracts/runtimeGuards';
import {
    addSafePdfSidecarOffset,
    assertPdfSidecarFitsSafeOffsetRange,
    assertSafePdfSidecarOffset,
    findPdfSidecarLineIndex,
    parsePdfSidecarJsonLine,
    readPdfSidecarLine,
    scanPdfSidecarLines,
    type IScannedPdfSidecar,
} from '@electron/features/documents/main/pdfSidecarLineIndex';

const PARSE_DIRECTORY_PREFIX = 'pdf-annotation-parse-';
const PARSE_FILE_NAME = 'annotations.jsonl';
const PARSE_NATIVE_TIMEOUT_MS = 30 * 60 * 1_000;
const PARSE_NATIVE_STDOUT_BYTES = 64 * 1_024;
const PARSE_NATIVE_STDERR_BYTES = 512 * 1_024;
const PARSE_DEFAULT_TTL_MS = 10 * 60 * 1_000;
const PARSE_SWEEP_MAX_ENTRIES = 200;
const PARSE_FORMAT = 'evb-pdf-annotation-parse';
const PARSE_SCHEMA_VERSION = 1;
const PARSE_MODIFIED_AT = 'D:19700101000000Z';
const logger = createLogger('pdf-annotation-parse');

interface IParseSessionState {
    sessionId: string;
    ownerId: number;
    documentRef: string;
    resolvedPath: string;
    expectedRevisionToken: TDocumentRevisionToken;
    sidecarDirectory: string;
    sidecarPath: string;
    index: IScannedPdfSidecar;
    abortController: AbortController;
    cancelGroup: string;
    operationPromise: Promise<void>;
    lastTouchedAt: number;
    canceled: boolean;
    released: boolean;
    unregisterSenderCleanup?: () => void;
    cleanupPromise?: Promise<void>;
}

const sessions = new Map<string, IParseSessionState>();

function getOwnerId(context: IDocumentsSenderIdContext) {
    return context.senderId ?? -1;
}

function rejectUnknownFields(value: Record<string, unknown>, label: string, allowed: readonly string[]) {
    const unknown = Object.keys(value).find(key => !allowed.includes(key));
    if (unknown !== undefined) {
        throw new Error(`${label} contains unsupported field ${unknown}`);
    }
}

function decodeHeader(value: unknown) {
    if (!isRecord(value)) {
        throw new Error('PDF annotation parse sidecar is missing its JSONL header');
    }
    rejectUnknownFields(value, 'PDF annotation parse sidecar header', [
        'format',
        'schemaVersion',
        'pageCount',
        'chunkBytes',
    ]);
    if (
        value.format !== PARSE_FORMAT
        || value.schemaVersion !== PARSE_SCHEMA_VERSION
        || typeof value.pageCount !== 'number'
        || !Number.isSafeInteger(value.pageCount)
        || value.pageCount < 0
    ) {
        throw new Error('PDF annotation parse sidecar has an unsupported header');
    }
    if (
        typeof value.chunkBytes !== 'number'
        || !Number.isSafeInteger(value.chunkBytes)
        || value.chunkBytes < 64
        || value.chunkBytes > PDF_ANNOTATION_PARSE_MAX_LINE_BYTES
    ) {
        throw new Error('PDF annotation parse sidecar header has an invalid chunk size');
    }
    return value.pageCount;
}

function decodeDataLine(value: unknown): IPdfAnnotationParseEntry[] {
    if (!isRecord(value) || !Array.isArray(value.entries)) {
        throw new Error('PDF annotation parse sidecar line must contain entries');
    }
    rejectUnknownFields(value, 'PDF annotation parse sidecar chunk', [
        'chunkIndex',
        'entries',
    ]);
    if (
        typeof value.chunkIndex !== 'number'
        || !Number.isSafeInteger(value.chunkIndex)
        || value.chunkIndex < 0
    ) {
        throw new Error('PDF annotation parse sidecar line has an invalid chunk index');
    }
    return value.entries.map(decodePdfAnnotationParseEntry);
}

function parseChunkOptions(options: {chunkBytes?: number} | undefined) {
    const chunkBytes = options?.chunkBytes ?? PDF_ANNOTATION_PARSE_MAX_LINE_BYTES;
    if (
        !Number.isSafeInteger(chunkBytes)
        || chunkBytes < 1
        || chunkBytes > PDF_ANNOTATION_PARSE_MAX_LINE_BYTES
    ) {
        throw new RangeError(
            `PDF annotation parse chunkBytes must be between 1 and ${PDF_ANNOTATION_PARSE_MAX_LINE_BYTES}`,
        );
    }
    return chunkBytes;
}

function assertSessionOwner(session: IParseSessionState, context: IDocumentsSenderIdContext) {
    if (session.ownerId !== getOwnerId(context)) {
        throw new Error('PDF annotation parse session belongs to another sender');
    }
}

function cancelSession(session: IParseSessionState, reason: string) {
    session.canceled = true;
    if (!session.abortController.signal.aborted) {
        session.abortController.abort(new Error(reason));
    }
    cancelNativeCommandGroup(session.cancelGroup);
}

function cleanupWhenOperationSettles(session: IParseSessionState) {
    void session.operationPromise
        .catch(() => undefined)
        .then(() => cleanupSession(session));
}

async function cleanupSession(session: IParseSessionState) {
    if (session.cleanupPromise) {
        return session.cleanupPromise;
    }
    sessions.delete(session.sessionId);
    session.unregisterSenderCleanup?.();
    delete session.unregisterSenderCleanup;
    session.cleanupPromise = rm(session.sidecarDirectory, {
        force: true,
        recursive: true,
    }).catch((error: unknown) => {
        logger.warn(`Failed to remove PDF annotation parse sidecar: ${String(error)}`);
    });
    return session.cleanupPromise;
}

function buildParseCommandArgs(inputPath: string, outputPath: string, qpdfPath: string) {
    return [
        'parse-annotations',
        '--input',
        inputPath,
        '--output',
        outputPath,
        '--qpdf',
        qpdfPath,
        '--modified-at',
        PARSE_MODIFIED_AT,
    ];
}

async function runParseNative(
    inputPath: string,
    outputPath: string,
    signal: AbortSignal,
    cancelGroup: string,
) {
    if (isNativePageOpsDisabled()) {
        throw new Error('Cannot parse PDF annotations while native page operations are disabled');
    }
    const nativePath = resolveNativePageOpsPath();
    if (!nativePath) {
        throw new Error('Cannot parse PDF annotations because the native page tool is unavailable');
    }
    await runNativeToolCommand(
        nativePath,
        buildParseCommandArgs(inputPath, outputPath, getPdfNativeToolPaths().qpdf),
        {
            timeoutMs: PARSE_NATIVE_TIMEOUT_MS,
            maxStdoutBytes: PARSE_NATIVE_STDOUT_BYTES,
            maxStderrBytes: PARSE_NATIVE_STDERR_BYTES,
            rejectOnStdoutTruncation: true,
            commandLabel: 'evb-pdf-page-ops(parse-annotations)',
            signal,
            cancelGroup,
        },
    );
}

export async function beginPdfAnnotationParse(
    context: IDocumentsSenderIdContext,
    filePath: string,
    options: IPdfAnnotationParseOptions,
): Promise<IPdfAnnotationParseSession> {
    const expectedRevisionToken = parseDocumentRevisionToken(
        options?.expectedDocumentRevisionToken,
    );
    if (expectedRevisionToken === null) {
        throw new Error('Document revision token is required to parse PDF annotations');
    }
    const resolvedPath = await resolveExistingReadablePdfPath(filePath, context.senderId);
    const revision = await getWorkingCopyRevision(resolvedPath, context.senderId);
    if (revision.token !== expectedRevisionToken) {
        throw createStaleRevisionError({
            documentRef: resolvedPath,
            expectedRevision: expectedRevisionToken,
            actualRevision: revision.token,
        });
    }
    await assertWorkingCopyRevisionCurrent(resolvedPath, expectedRevisionToken);

    const sessionId = randomUUID();
    const sidecarDirectory = await mkdtemp(join(getAppTempDir(), PARSE_DIRECTORY_PREFIX));
    const sidecarPath = join(sidecarDirectory, PARSE_FILE_NAME);
    const abortController = new AbortController();
    const session: IParseSessionState = {
        sessionId,
        ownerId: getOwnerId(context),
        documentRef: filePath,
        resolvedPath,
        expectedRevisionToken,
        sidecarDirectory,
        sidecarPath,
        index: {
            dataStartOffset: 0,
            dataBytes: 0,
            pageCount: 0,
            entryCount: 0,
            lines: [],
        },
        abortController,
        cancelGroup: `pdf-annotation-parse:${sessionId}`,
        operationPromise: Promise.resolve(),
        lastTouchedAt: Date.now(),
        canceled: false,
        released: false,
    };
    sessions.set(sessionId, session);

    const cancel = (reason: string) => cancelSession(session, reason);
    let mainOperation: ReturnType<typeof registerMainOperation>;
    try {
        mainOperation = registerMainOperation({
            kind: 'abortable-work',
            ownerWebContentsId: context.senderId,
            workingCopyPath: resolvedPath,
            cancel,
        });
    } catch (error) {
        await cleanupSession(session);
        throw error;
    }
    session.cancelGroup = `pdf-annotation-parse:${mainOperation.id}`;
    session.unregisterSenderCleanup = registerNativePdfSenderCleanup(
        context.sender,
        cancel,
        'Renderer navigation canceled PDF annotation parsing',
    );
    const handleMainAbort = () => cancel('PDF annotation parsing canceled');
    mainOperation.signal.addEventListener('abort', handleMainAbort, {once: true});

    session.operationPromise = (async () => {
        try {
            await runWithWorkingCopyReadBacking(
                resolvedPath,
                physicalPath => runParseNative(
                    physicalPath,
                    sidecarPath,
                    abortController.signal,
                    session.cancelGroup,
                ),
                context.senderId === undefined ? {} : {ownerWebContentsId: context.senderId},
            );
            if (abortController.signal.aborted) {
                throw abortErrorFromSignal(abortController.signal);
            }
            await assertWorkingCopyRevisionCurrent(resolvedPath, expectedRevisionToken);
            const sidecarSize = await assertPdfSidecarFitsSafeOffsetRange(
                sidecarPath,
                'PDF annotation parse',
            );
            let expectedChunkIndex = 0;
            session.index = await scanPdfSidecarLines(sidecarPath, {
                maxLineBytes: PDF_ANNOTATION_PARSE_MAX_LINE_BYTES,
                label: 'PDF annotation parse',
                signal: abortController.signal,
                decodeHeader,
                decodeDataLine: (value) => {
                    const entries = decodeDataLine(value);
                    const chunkIndex = (value as Record<string, unknown>).chunkIndex;
                    if (chunkIndex !== expectedChunkIndex) {
                        throw new Error('PDF annotation parse sidecar chunks are out of order');
                    }
                    expectedChunkIndex += 1;
                    return entries;
                },
            });
            if (session.index.dataBytes !== sidecarSize - session.index.dataStartOffset) {
                throw new Error('PDF annotation parse sidecar changed while it was being indexed');
            }
            session.lastTouchedAt = Date.now();
        } catch (error) {
            session.canceled = session.canceled || abortController.signal.aborted;
            throw error;
        } finally {
            mainOperation.signal.removeEventListener('abort', handleMainAbort);
            mainOperation.complete();
            if (session.canceled || session.released) {
                await cleanupSession(session);
            }
        }
    })();

    try {
        await session.operationPromise;
    } catch (error) {
        await cleanupSession(session);
        throw error;
    }
    return {
        sessionId,
        documentRef: filePath,
        documentRevisionToken: expectedRevisionToken,
        pageCount: session.index.pageCount,
        entryCount: session.index.entryCount,
        totalBytes: session.index.dataBytes,
    };
}

export async function readPdfAnnotationParseChunk(
    context: IDocumentsSenderIdContext,
    sessionId: string,
    offset: number,
    options?: {chunkBytes?: number},
): Promise<IPdfAnnotationParseChunk> {
    const session = sessions.get(sessionId);
    if (!session) {
        throw new Error('PDF annotation parse session is not available');
    }
    assertSessionOwner(session, context);
    if (session.canceled || session.released) {
        throw new Error('PDF annotation parse session is canceled');
    }
    await assertWorkingCopyRevisionCurrent(session.resolvedPath, session.expectedRevisionToken);
    const requestedOffset = assertSafePdfSidecarOffset(offset, 'offset');
    const chunkBytes = parseChunkOptions(options);
    if (requestedOffset === session.index.dataBytes) {
        session.lastTouchedAt = Date.now();
        return {
            offset: requestedOffset,
            nextOffset: null,
            byteLength: 0,
            done: true,
            entries: [],
        };
    }
    const lineIndex = findPdfSidecarLineIndex(session.index.lines, requestedOffset);
    if (lineIndex < 0) {
        throw new RangeError('PDF annotation parse offset must point to the beginning of a chunk line');
    }
    const line = session.index.lines[lineIndex]!;
    if (line.byteLength > chunkBytes) {
        throw new RangeError(`PDF annotation parse line requires a chunk of at least ${line.byteLength} bytes`);
    }
    const lineBytes = await readPdfSidecarLine(
        session.sidecarPath,
        session.index.dataStartOffset,
        line,
        'PDF annotation parse',
    );
    await assertWorkingCopyRevisionCurrent(session.resolvedPath, session.expectedRevisionToken);
    const entries = decodeDataLine(parsePdfSidecarJsonLine(lineBytes, 'data'));
    const nextOffset = lineIndex + 1 < session.index.lines.length
        ? addSafePdfSidecarOffset(line.offset, line.byteLength, 'PDF annotation parse offset')
        : null;
    session.lastTouchedAt = Date.now();
    return {
        offset: requestedOffset,
        nextOffset,
        byteLength: line.byteLength,
        done: nextOffset === null,
        entries,
    };
}

export async function releasePdfAnnotationParse(
    context: IDocumentsSenderIdContext,
    sessionId: string,
) {
    const session = sessions.get(sessionId);
    if (!session) {
        return false;
    }
    assertSessionOwner(session, context);
    session.released = true;
    if (!session.abortController.signal.aborted) {
        cancelSession(session, 'PDF annotation parse released');
    }
    await session.operationPromise.catch(() => undefined);
    await cleanupSession(session);
    return true;
}

export function cancelPdfAnnotationParse(
    context: IDocumentsSenderIdContext,
    sessionId: string,
) {
    const session = sessions.get(sessionId);
    if (!session) {
        return Promise.resolve({canceled: false});
    }
    assertSessionOwner(session, context);
    if (session.canceled || session.released) {
        return Promise.resolve({canceled: false});
    }
    cancelSession(session, 'PDF annotation parse canceled');
    cleanupWhenOperationSettles(session);
    return Promise.resolve({canceled: true});
}

export async function parsePdfAnnotations(
    context: IDocumentsSenderIdContext,
    filePath: string,
    options: IPdfAnnotationParseOptions,
): Promise<IPdfAnnotationParseResult> {
    const resolvedPath = await resolveExistingReadablePdfPath(filePath, context.senderId);
    const session = await beginPdfAnnotationParse(context, filePath, options);
    const entities: TPdfAnnotationParseEntity[] = [];
    const foreign: IPdfAnnotationForeignEntry[] = [];
    let offset = 0;
    try {
        if (session.entryCount > PDF_ANNOTATION_PARSE_MAX_ENTRIES) {
            throw new RangeError(
                `PDF annotation parse contains more than ${PDF_ANNOTATION_PARSE_MAX_ENTRIES} entries; use the chunked session API`,
            );
        }
        for (;;) {
            const chunk = await readPdfAnnotationParseChunk(context, session.sessionId, offset);
            if (chunk.offset !== offset) {
                throw new Error('PDF annotation parse returned a chunk for an unexpected offset');
            }
            for (const entry of chunk.entries) {
                if (entry.kind === 'foreign') {
                    foreign.push(entry);
                } else {
                    entities.push(entry);
                }
            }
            if (chunk.done) {
                if (chunk.nextOffset !== null) {
                    throw new Error('PDF annotation parse marked its final chunk with a next offset');
                }
                break;
            }
            if (chunk.nextOffset === null || chunk.nextOffset <= offset) {
                throw new Error('PDF annotation parse returned a non-advancing chunk offset');
            }
            offset = chunk.nextOffset;
        }
        if (entities.length + foreign.length !== session.entryCount) {
            throw new Error('PDF annotation parse entry count does not match its session');
        }
        await assertWorkingCopyRevisionCurrent(resolvedPath, session.documentRevisionToken);
        return {
            documentRevisionToken: session.documentRevisionToken,
            pageCount: session.pageCount,
            entities,
            foreign,
        };
    } finally {
        await releasePdfAnnotationParse(context, session.sessionId).catch(() => undefined);
    }
}

export async function sweepStalePdfAnnotationParseArtifacts(
    maxAgeMs = PARSE_DEFAULT_TTL_MS,
    maxEntries = PARSE_SWEEP_MAX_ENTRIES,
) {
    const tempDir = getAppTempDir();
    const now = Date.now();
    const activeDirectories = new Set([...sessions.values()].map(session => session.sidecarDirectory));
    let entries: string[];
    try {
        entries = await readdir(tempDir);
    } catch {
        return 0;
    }
    let deletedCount = 0;
    for (const entry of entries
        .filter(name => name.startsWith(PARSE_DIRECTORY_PREFIX))
        .slice(0, maxEntries)) {
        const directoryPath = join(tempDir, entry);
        if (activeDirectories.has(directoryPath)) continue;
        try {
            const directoryStat = await lstat(directoryPath);
            if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) continue;
            if (now - Math.floor(Math.max(directoryStat.mtimeMs, directoryStat.ctimeMs)) < maxAgeMs) continue;
            await rm(directoryPath, {
                force: true,
                recursive: true,
            });
            deletedCount += 1;
        } catch (error) {
            logger.warn(`Failed to sweep stale PDF annotation parse artifact "${directoryPath}": ${String(error)}`);
        }
    }
    return deletedCount;
}

const parseTtlTimer = setInterval(() => {
    const cutoff = Date.now() - PARSE_DEFAULT_TTL_MS;
    for (const session of sessions.values()) {
        if (session.lastTouchedAt >= cutoff) continue;
        session.released = true;
        cancelSession(session, 'PDF annotation parse session expired');
        cleanupWhenOperationSettles(session);
    }
    void sweepStalePdfAnnotationParseArtifacts().catch((error: unknown) => {
        logger.debug(`PDF annotation parse TTL sweep failed: ${String(error)}`);
    });
}, 30_000);
parseTtlTimer.unref?.();
