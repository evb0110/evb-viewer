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
    parseDocumentRef,
    type TDocumentRef,
} from '@contracts/documentRef';
import {createSessionId} from '@contracts/shared';
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
import type {IDocumentsSenderIdContext} from '@electron/features/documents/documentsContexts';
import {resolveExistingReadablePdfPath} from '@electron/features/documents/main/documentFilePathResolution';
import {
    assertWorkingCopyRevisionCurrent,
    getWorkingCopyRevision,
} from '@electron/file-access/documentRevisionStore';
import {runWithWorkingCopyReadBacking} from '@electron/file-access/runWithWorkingCopyReadBacking';
import {resolveNativePageOpsPath} from '@electron/features/page-ops/public/nativePageOpsPath';
import {getPdfNativeToolPaths} from '@electron/pdf/nativeToolPaths';
import {runNativeToolCommand} from '@electron/native-tools/runNativeToolCommand';
import {registerNativePdfSenderCleanup} from '@electron/features/documents/main/nativePdfMetadata';
import {getAppTempDir} from '@electron/utils/appTempDir';
import {createLogger} from '@electron/utils/createLogger';
import {abortErrorFromSignal} from '@electron/utils/abort';
import {isRecord} from '@contracts/runtimeGuards';
import {
    cancelPdfSidecarSession,
    cleanupPdfSidecarSession,
    cleanupPdfSidecarSessionWhenOperationSettles,
    createPdfSidecarMainOperation,
    expireStalePdfSidecarSessions,
    readPdfSidecarChunk,
    runPdfSidecarOperation,
    scanPdfSidecarIntoSession,
    scanPdfSidecarLines,
    assertSafePdfSidecarOffset,
    sweepStalePdfSidecarArtifacts,
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

function requireDocumentRef(value: unknown): TDocumentRef {
    const documentRef = parseDocumentRef(value);
    if (documentRef === null) {
        throw new Error('Expected an absolute document ref');
    }
    return documentRef;
}

const sessions = new Map<string, IParseSessionState>();
let parseTtlTimer: ReturnType<typeof setInterval> | null = null;

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

function cleanupWhenOperationSettles(session: IParseSessionState) {
    cleanupPdfSidecarSessionWhenOperationSettles(session, cleanupSession);
}

function cleanupSession(session: IParseSessionState) {
    return cleanupPdfSidecarSession(sessions, session, (error: unknown) => {
        logger.warn(`Failed to remove PDF annotation parse sidecar: ${String(error)}`);
    }).finally(clearParseTtlTimerIfIdle);
}

function clearParseTtlTimerIfIdle() {
    if (sessions.size === 0 && parseTtlTimer) {
        clearInterval(parseTtlTimer);
        parseTtlTimer = null;
    }
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
            documentRef: requireDocumentRef(resolvedPath),
            expectedRevision: expectedRevisionToken,
            actualRevision: revision.token,
        });
    }
    await assertWorkingCopyRevisionCurrent(resolvedPath, expectedRevisionToken);

    const sessionId = createSessionId('pdf-annotation-parse');
    const {
        session,
        mainOperation,
        cancel,
    } = await createPdfSidecarMainOperation({
        sessionId,
        ownerId: getOwnerId(context),
        documentRef: filePath,
        resolvedPath,
        expectedRevisionToken,
        tempDir: getAppTempDir(),
        directoryPrefix: PARSE_DIRECTORY_PREFIX,
        fileName: PARSE_FILE_NAME,
        cancelGroup: `pdf-annotation-parse:${sessionId}`,
        sessions,
        ownerWebContentsId: context.senderId,
        workingCopyPath: resolvedPath,
        cleanup: cleanupSession,
        cancelGroupForOperation: operationId => `pdf-annotation-parse:${operationId}`,
        registerSenderCleanup: operationCancel => registerNativePdfSenderCleanup(
            context.sender,
            operationCancel,
            'Renderer navigation canceled PDF annotation parsing',
        ),
    });
    ensureParseTtlTimer();
    const {abortController} = session;
    const {sidecarPath} = session;
    const handleMainAbort = () => cancel('PDF annotation parsing canceled');
    mainOperation.signal.addEventListener('abort', handleMainAbort, {once: true});

    await runPdfSidecarOperation(
        session,
        mainOperation,
        handleMainAbort,
        cleanupSession,
        async () => {
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
            await scanPdfSidecarIntoSession(
                session,
                sidecarPath,
                abortController.signal,
                'PDF annotation parse',
                () => assertWorkingCopyRevisionCurrent(resolvedPath, expectedRevisionToken),
                signal => {
                    let expectedChunkIndex = 0;
                    return scanPdfSidecarLines(sidecarPath, {
                        maxLineBytes: PDF_ANNOTATION_PARSE_MAX_LINE_BYTES,
                        label: 'PDF annotation parse',
                        signal,
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
                },
            );
        },
    );
    return {
        sessionId,
        documentRef: requireDocumentRef(filePath),
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
    const requestedOffset = assertSafePdfSidecarOffset(offset, 'offset');
    const chunkBytes = parseChunkOptions(options);
    const result = await readPdfSidecarChunk({
        sidecarPath: session.sidecarPath,
        index: session.index,
        offset: requestedOffset,
        chunkBytes,
        label: 'PDF annotation parse',
        decodeDataLine,
        beforeRead: () => assertWorkingCopyRevisionCurrent(
            session.resolvedPath,
            session.expectedRevisionToken,
        ),
        afterRead: () => assertWorkingCopyRevisionCurrent(
            session.resolvedPath,
            session.expectedRevisionToken,
        ),
    });
    session.lastTouchedAt = Date.now();
    return result;
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
        cancelPdfSidecarSession(session, 'PDF annotation parse released');
    }
    await session.operationPromise.catch(() => undefined);
    await cleanupSession(session);
    return true;
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
    return sweepStalePdfSidecarArtifacts({
        tempDir: getAppTempDir(),
        directoryPrefix: PARSE_DIRECTORY_PREFIX,
        activeDirectories: new Set([...sessions.values()].map(session => session.sidecarDirectory)),
        maxAgeMs,
        maxEntries,
        onError: (directoryPath, error) => {
            logger.warn(`Failed to sweep stale PDF annotation parse artifact "${directoryPath}": ${String(error)}`);
        },
    });
}

function ensureParseTtlTimer() {
    parseTtlTimer ??= setInterval(() => {
        const cutoff = Date.now() - PARSE_DEFAULT_TTL_MS;
        expireStalePdfSidecarSessions(sessions.values(), cutoff, session => {
            session.released = true;
            cancelPdfSidecarSession(session, 'PDF annotation parse session expired');
            cleanupWhenOperationSettles(session);
        });
        void sweepStalePdfAnnotationParseArtifacts().catch((error: unknown) => {
            logger.debug(`PDF annotation parse TTL sweep failed: ${String(error)}`);
        });
    }, 30_000);
    parseTtlTimer.unref?.();
}
