import {randomUUID} from 'node:crypto';
import {
    lstat,
    mkdtemp,
    readdir,
    rm,
} from 'node:fs/promises';
import {join} from 'node:path';
import {
    PDF_ANNOTATION_LINE_END_STYLES,
    PDF_ANNOTATION_SHAPE_PDF_SUBTYPES,
    PDF_ANNOTATION_SHAPE_TYPES,
} from '@contracts/annotations';
import type {
    IPdfEmbeddedShapeIndexChunk,
    IPdfEmbeddedShapeIndexChunkOptions,
    IPdfEmbeddedShapeIndexEntry,
    IPdfEmbeddedShapeIndexOptions,
    IPdfEmbeddedShapeIndexPoint,
    IPdfEmbeddedShapeIndexSession,
} from '@contracts/electronApiDocuments';
import {
    PDF_EMBEDDED_SHAPE_INDEX_MAX_CHUNK_BYTES,
    PDF_EMBEDDED_SHAPE_INDEX_MAX_LINE_BYTES,
} from '@contracts/electronApiDocuments';
import {createStaleRevisionError} from '@contracts/documentMutationErrors';
import {
    parseDocumentRevisionToken,
    type TDocumentRevisionToken,
} from '@contracts/documentRevision';
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
import {
    isOneOf,
    isRecord,
} from '@contracts/runtimeGuards';
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

const SHAPE_INDEX_DIRECTORY_PREFIX = 'pdf-embedded-shape-index-';
const SHAPE_INDEX_FILE_NAME = 'index.jsonl';
const SHAPE_INDEX_FORMAT = 'evb-pdf-embedded-shape-index';
const SHAPE_INDEX_SCHEMA_VERSION = 1;
const SHAPE_INDEX_DEFAULT_TTL_MS = 10 * 60 * 1_000;
const SHAPE_INDEX_SWEEP_MAX_ENTRIES = 200;
const SHAPE_INDEX_NATIVE_TIMEOUT_MS = 30 * 60 * 1_000;
const SHAPE_INDEX_NATIVE_STDOUT_BYTES = 64 * 1_024;
const SHAPE_INDEX_NATIVE_STDERR_BYTES = 512 * 1_024;
const MAX_SHAPE_POINTS = 40_000;
const MAX_SHAPE_STROKES = 4_096;
const logger = createLogger('pdf-embedded-shape-index');

interface IShapeIndexSessionState {
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

const sessions = new Map<string, IShapeIndexSessionState>();

function getOwnerId(context: IDocumentsSenderIdContext) {
    return context.senderId ?? -1;
}

function decodeHeader(value: unknown) {
    if (!isRecord(value)) {
        throw new Error('Embedded shape index sidecar is missing its JSONL header');
    }
    if (
        value.format !== SHAPE_INDEX_FORMAT
        || value.schemaVersion !== SHAPE_INDEX_SCHEMA_VERSION
        || typeof value.pageCount !== 'number'
        || !Number.isSafeInteger(value.pageCount)
        || value.pageCount < 0
    ) {
        throw new Error('Embedded shape index sidecar has an unsupported header');
    }
    if (value.chunkBytes !== undefined && (
        typeof value.chunkBytes !== 'number'
        || !Number.isSafeInteger(value.chunkBytes)
        || value.chunkBytes < 1
        || value.chunkBytes > PDF_EMBEDDED_SHAPE_INDEX_MAX_LINE_BYTES
    )) {
        throw new Error('Embedded shape index sidecar header has an invalid chunk size');
    }
    return value.pageCount;
}

function decodeSafeInteger(value: unknown, fieldName: string, min = 0) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
        throw new Error(`${fieldName} must be a safe integer >= ${min}`);
    }
    return value;
}

function decodeFiniteNumber(value: unknown, fieldName: string, min?: number) {
    if (typeof value !== 'number' || !Number.isFinite(value) || (min !== undefined && value < min)) {
        throw new Error(`${fieldName} must be a finite number`);
    }
    return value;
}

function decodeOptionalFiniteNumber(value: unknown, fieldName: string) {
    return value === undefined || value === null
        ? null
        : decodeFiniteNumber(value, fieldName);
}

function decodeOptionalString(value: unknown, fieldName: string) {
    if (value === undefined || value === null) {
        return null;
    }
    if (typeof value !== 'string' || value.length === 0) {
        throw new Error(`${fieldName} must be a non-empty string or null`);
    }
    return value;
}

function decodeOptionalTimestamp(value: unknown, fieldName: string) {
    if (value === undefined || value === null) {
        return null;
    }
    return decodeSafeInteger(value, fieldName, Number.MIN_SAFE_INTEGER);
}

function decodeOptionalEnum<T extends string>(
    value: unknown,
    values: readonly T[],
    fieldName: string,
) {
    if (value === undefined || value === null) {
        return null;
    }
    if (!isOneOf(values, value)) {
        throw new Error(`${fieldName} is unsupported`);
    }
    return value;
}

function decodePoint(value: unknown, fieldName: string): IPdfEmbeddedShapeIndexPoint {
    if (!isRecord(value)) {
        throw new Error(`${fieldName} must be an object`);
    }
    return {
        x: decodeFiniteNumber(value.x, `${fieldName}.x`),
        y: decodeFiniteNumber(value.y, `${fieldName}.y`),
    };
}

function decodePoints(value: unknown, fieldName: string): IPdfEmbeddedShapeIndexPoint[] | null {
    if (value === undefined || value === null) {
        return null;
    }
    if (!Array.isArray(value) || value.length > MAX_SHAPE_POINTS) {
        throw new Error(`${fieldName} contains too many points`);
    }
    return value.map((point, index) => decodePoint(point, `${fieldName}[${index}]`));
}

function decodeStrokes(value: unknown): IPdfEmbeddedShapeIndexPoint[][] | null {
    if (value === undefined || value === null) {
        return null;
    }
    if (!Array.isArray(value) || value.length > MAX_SHAPE_STROKES) {
        throw new Error('Embedded shape index strokes contain too many strokes');
    }
    return value.map((stroke, index) => decodePoints(
        stroke,
        `embedded shape index strokes[${index}]`,
    ) ?? []);
}

function decodeShapeEntry(value: unknown): IPdfEmbeddedShapeIndexEntry {
    if (!isRecord(value)) {
        throw new Error('Embedded shape index entry must be an object');
    }
    const pdfSubtype = decodeOptionalEnum(
        value.pdfSubtype,
        PDF_ANNOTATION_SHAPE_PDF_SUBTYPES,
        'Embedded shape index entry pdfSubtype',
    );
    if (pdfSubtype === null) {
        throw new Error('Embedded shape index entry has an unsupported PDF subtype');
    }
    const type = decodeOptionalEnum(
        value.type,
        PDF_ANNOTATION_SHAPE_TYPES,
        'Embedded shape index entry type',
    );
    if (type === null) {
        throw new Error('Embedded shape index entry has an unsupported shape type');
    }
    const lineStartStyle = decodeOptionalEnum(
        value.lineStartStyle,
        PDF_ANNOTATION_LINE_END_STYLES,
        'Embedded shape index entry lineStartStyle',
    );
    const lineEndStyle = decodeOptionalEnum(
        value.lineEndStyle,
        PDF_ANNOTATION_LINE_END_STYLES,
        'Embedded shape index entry lineEndStyle',
    );
    return {
        pageIndex: decodeSafeInteger(value.pageIndex, 'Embedded shape index entry pageIndex') as IPdfEmbeddedShapeIndexEntry['pageIndex'],
        objectNumber: decodeSafeInteger(value.objectNumber, 'Embedded shape index entry objectNumber', 1),
        generationNumber: decodeSafeInteger(value.generationNumber, 'Embedded shape index entry generationNumber'),
        stableKey: decodeOptionalString(value.stableKey, 'Embedded shape index entry stableKey'),
        pdfSubtype,
        type,
        x: decodeFiniteNumber(value.x, 'Embedded shape index entry x'),
        y: decodeFiniteNumber(value.y, 'Embedded shape index entry y'),
        width: decodeFiniteNumber(value.width, 'Embedded shape index entry width', 0),
        height: decodeFiniteNumber(value.height, 'Embedded shape index entry height', 0),
        x2: decodeOptionalFiniteNumber(value.x2, 'Embedded shape index entry x2'),
        y2: decodeOptionalFiniteNumber(value.y2, 'Embedded shape index entry y2'),
        color: typeof value.color === 'string' ? value.color : (() => { throw new Error('Embedded shape index entry color must be a string'); })(),
        fillColor: decodeOptionalString(value.fillColor, 'Embedded shape index entry fillColor'),
        opacity: decodeFiniteNumber(value.opacity, 'Embedded shape index entry opacity', 0),
        strokeWidth: decodeFiniteNumber(value.strokeWidth, 'Embedded shape index entry strokeWidth', 0),
        points: decodePoints(value.points, 'Embedded shape index entry points'),
        strokes: decodeStrokes(value.strokes),
        lineStartStyle,
        lineEndStyle,
        createdAt: decodeOptionalTimestamp(value.createdAt, 'Embedded shape index entry createdAt'),
        modifiedAt: decodeOptionalTimestamp(value.modifiedAt, 'Embedded shape index entry modifiedAt'),
    };
}

function decodeDataLine(value: unknown) {
    if (!isRecord(value) || !Array.isArray(value.entries)) {
        throw new Error('Embedded shape index sidecar line must contain entries');
    }
    return value.entries.map(decodeShapeEntry);
}

function parseChunkOptions(options: IPdfEmbeddedShapeIndexChunkOptions | undefined) {
    const chunkBytes = options?.chunkBytes ?? PDF_EMBEDDED_SHAPE_INDEX_MAX_CHUNK_BYTES;
    if (
        !Number.isSafeInteger(chunkBytes)
        || chunkBytes < 1
        || chunkBytes > PDF_EMBEDDED_SHAPE_INDEX_MAX_CHUNK_BYTES
    ) {
        throw new RangeError(`Embedded shape index chunkBytes must be between 1 and ${PDF_EMBEDDED_SHAPE_INDEX_MAX_CHUNK_BYTES}`);
    }
    return chunkBytes;
}

function assertSessionOwner(session: IShapeIndexSessionState, context: IDocumentsSenderIdContext) {
    if (session.ownerId !== getOwnerId(context)) {
        throw new Error('Embedded shape index session belongs to another sender');
    }
}

function cancelSession(session: IShapeIndexSessionState, reason: string) {
    session.canceled = true;
    if (!session.abortController.signal.aborted) {
        session.abortController.abort(new Error(reason));
    }
    cancelNativeCommandGroup(session.cancelGroup);
}

function cleanupWhenOperationSettles(session: IShapeIndexSessionState) {
    void session.operationPromise
        .catch(() => undefined)
        .then(() => cleanupSession(session));
}

async function cleanupSession(session: IShapeIndexSessionState) {
    if (session.cleanupPromise) {
        return session.cleanupPromise;
    }
    sessions.delete(session.sessionId);
    session.unregisterSenderCleanup?.();
    delete session.unregisterSenderCleanup;
    session.cleanupPromise = rm(session.sidecarDirectory, {
        force: true,
        recursive: true,
    })
        .catch((error: unknown) => {
            logger.warn(`Failed to remove embedded shape index sidecar: ${String(error)}`);
        });
    return session.cleanupPromise;
}

/** Keep the native verb and argument order in one helper for CLI alignment. */
function buildPdfEmbeddedShapeIndexCommandArgs(inputPath: string, outputPath: string, qpdfPath: string) {
    return [
        'embedded-shape-index',
        '--input',
        inputPath,
        '--output',
        outputPath,
        '--qpdf',
        qpdfPath,
    ];
}

async function runEmbeddedShapeIndexNative(
    inputPath: string,
    outputPath: string,
    signal: AbortSignal,
    cancelGroup: string,
) {
    if (isNativePageOpsDisabled()) {
        throw new Error('Cannot build an embedded shape index while native page operations are disabled');
    }
    const nativePath = resolveNativePageOpsPath();
    if (!nativePath) {
        throw new Error('Cannot build an embedded shape index because the native page tool is unavailable');
    }
    await runNativeToolCommand(
        nativePath,
        buildPdfEmbeddedShapeIndexCommandArgs(inputPath, outputPath, getPdfNativeToolPaths().qpdf),
        {
            timeoutMs: SHAPE_INDEX_NATIVE_TIMEOUT_MS,
            maxStdoutBytes: SHAPE_INDEX_NATIVE_STDOUT_BYTES,
            maxStderrBytes: SHAPE_INDEX_NATIVE_STDERR_BYTES,
            rejectOnStdoutTruncation: true,
            commandLabel: 'evb-pdf-page-ops(embedded-shape-index)',
            signal,
            cancelGroup,
        },
    );
}

export async function beginPdfEmbeddedShapeIndex(
    context: IDocumentsSenderIdContext,
    filePath: string,
    options: IPdfEmbeddedShapeIndexOptions,
): Promise<IPdfEmbeddedShapeIndexSession> {
    const expectedRevisionToken = parseDocumentRevisionToken(options?.expectedDocumentRevisionToken);
    if (expectedRevisionToken === null) {
        throw new Error('Document revision token is required to build an embedded shape index');
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
    const sidecarDirectory = await mkdtemp(join(getAppTempDir(), SHAPE_INDEX_DIRECTORY_PREFIX));
    const sidecarPath = join(sidecarDirectory, SHAPE_INDEX_FILE_NAME);
    const abortController = new AbortController();
    const session: IShapeIndexSessionState = {
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
        cancelGroup: `pdf-embedded-shape-index:${sessionId}`,
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
    session.cancelGroup = `pdf-embedded-shape-index:${mainOperation.id}`;
    session.unregisterSenderCleanup = registerNativePdfSenderCleanup(
        context.sender,
        cancel,
        'Renderer navigation canceled embedded shape indexing',
    );
    const handleMainAbort = () => cancel('Embedded shape indexing canceled');
    mainOperation.signal.addEventListener('abort', handleMainAbort, {once: true});

    session.operationPromise = (async () => {
        try {
            await runWithWorkingCopyReadBacking(
                resolvedPath,
                physicalPath => runEmbeddedShapeIndexNative(
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
                'Embedded shape index',
            );
            session.index = await scanPdfSidecarLines(sidecarPath, {
                maxLineBytes: PDF_EMBEDDED_SHAPE_INDEX_MAX_LINE_BYTES,
                label: 'Embedded shape index',
                signal: abortController.signal,
                decodeHeader,
                decodeDataLine,
            });
            if (session.index.dataBytes !== sidecarSize - session.index.dataStartOffset) {
                throw new Error('Embedded shape index sidecar changed while it was being indexed');
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

export async function readPdfEmbeddedShapeIndexChunk(
    context: IDocumentsSenderIdContext,
    sessionId: string,
    offset: number,
    options?: IPdfEmbeddedShapeIndexChunkOptions,
): Promise<IPdfEmbeddedShapeIndexChunk> {
    const session = sessions.get(sessionId);
    if (!session) {
        throw new Error('Embedded shape index session is not available');
    }
    assertSessionOwner(session, context);
    if (session.canceled || session.released) {
        throw new Error('Embedded shape index session is canceled');
    }
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
        throw new RangeError('Embedded shape index offset must point to the beginning of a chunk line');
    }
    const line = session.index.lines[lineIndex]!;
    if (line.byteLength > chunkBytes) {
        throw new RangeError(`Embedded shape index line requires a chunk of at least ${line.byteLength} bytes`);
    }
    const lineBytes = await readPdfSidecarLine(
        session.sidecarPath,
        session.index.dataStartOffset,
        line,
        'Embedded shape index',
    );
    const entries = decodeDataLine(parsePdfSidecarJsonLine(lineBytes, 'data'));
    const nextOffset = lineIndex + 1 < session.index.lines.length
        ? addSafePdfSidecarOffset(line.offset, line.byteLength, 'Embedded shape index offset')
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

export async function releasePdfEmbeddedShapeIndex(
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
        cancelSession(session, 'Embedded shape index released');
    }
    await session.operationPromise.catch(() => undefined);
    await cleanupSession(session);
    return true;
}

export function cancelPdfEmbeddedShapeIndex(
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
    cancelSession(session, 'Embedded shape index canceled');
    cleanupWhenOperationSettles(session);
    return Promise.resolve({canceled: true});
}

export async function sweepStalePdfEmbeddedShapeIndexArtifacts(
    maxAgeMs = SHAPE_INDEX_DEFAULT_TTL_MS,
    maxEntries = SHAPE_INDEX_SWEEP_MAX_ENTRIES,
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
        .filter(name => name.startsWith(SHAPE_INDEX_DIRECTORY_PREFIX))
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
            logger.warn(`Failed to sweep stale embedded shape index artifact "${directoryPath}": ${String(error)}`);
        }
    }
    return deletedCount;
}

const shapeIndexTtlTimer = setInterval(() => {
    const cutoff = Date.now() - SHAPE_INDEX_DEFAULT_TTL_MS;
    for (const session of sessions.values()) {
        if (session.lastTouchedAt >= cutoff) continue;
        session.released = true;
        cancelSession(session, 'Embedded shape index session expired');
        cleanupWhenOperationSettles(session);
    }
    void sweepStalePdfEmbeddedShapeIndexArtifacts().catch((error: unknown) => {
        logger.debug(`Embedded shape index TTL sweep failed: ${String(error)}`);
    });
}, 30_000);
shapeIndexTtlTimer.unref?.();
