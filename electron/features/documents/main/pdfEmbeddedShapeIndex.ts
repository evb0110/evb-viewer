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
    parseDocumentRef,
    type TDocumentRef,
} from '@contracts/documentRef';
import {createSessionId} from '@contracts/shared';
import {parseEpochMs} from '@contracts/timestamps';
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
import {registerNativePdfSenderCleanup} from '@electron/features/documents/main/nativePdfMetadata';
import {getAppTempDir} from '@electron/utils/appTempDir';
import {createLogger} from '@electron/utils/createLogger';
import {abortErrorFromSignal} from '@electron/utils/abort';
import {
    isOneOf,
    isRecord,
} from '@contracts/runtimeGuards';
import {
    assertSafePdfSidecarOffset,
    cancelPdfSidecarSession,
    cleanupPdfSidecarSession,
    cleanupPdfSidecarSessionWhenOperationSettles,
    createPdfSidecarMainOperation,
    expireStalePdfSidecarSessions,
    readPdfSidecarChunk,
    runPdfSidecarOperation,
    scanPdfSidecarIntoSession,
    scanPdfSidecarLines,
    sweepStalePdfSidecarArtifacts,
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
let shapeIndexTtlTimer: ReturnType<typeof setInterval> | null = null;

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
    const timestamp = parseEpochMs(value);
    if (timestamp === null) {
        throw new Error(`${fieldName} must be an epoch millisecond timestamp`);
    }
    return timestamp;
}

function requireDocumentRef(value: unknown): TDocumentRef {
    const documentRef = parseDocumentRef(value);
    if (documentRef === null) {
        throw new Error('Expected an absolute document ref');
    }
    return documentRef;
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

function cleanupWhenOperationSettles(session: IShapeIndexSessionState) {
    cleanupPdfSidecarSessionWhenOperationSettles(session, cleanupSession);
}

function cleanupSession(session: IShapeIndexSessionState) {
    return cleanupPdfSidecarSession(sessions, session, (error: unknown) => {
        logger.warn(`Failed to remove embedded shape index sidecar: ${String(error)}`);
    }).finally(clearShapeIndexTtlTimerIfIdle);
}

function clearShapeIndexTtlTimerIfIdle() {
    if (sessions.size === 0 && shapeIndexTtlTimer) {
        clearInterval(shapeIndexTtlTimer);
        shapeIndexTtlTimer = null;
    }
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
            documentRef: requireDocumentRef(resolvedPath),
            expectedRevision: expectedRevisionToken,
            actualRevision: revision.token,
        });
    }
    await assertWorkingCopyRevisionCurrent(resolvedPath, expectedRevisionToken);

    const sessionId = createSessionId('pdf-embedded-shape-index');
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
        directoryPrefix: SHAPE_INDEX_DIRECTORY_PREFIX,
        fileName: SHAPE_INDEX_FILE_NAME,
        cancelGroup: `pdf-embedded-shape-index:${sessionId}`,
        sessions,
        ownerWebContentsId: context.senderId,
        workingCopyPath: resolvedPath,
        cleanup: cleanupSession,
        cancelGroupForOperation: operationId => `pdf-embedded-shape-index:${operationId}`,
        registerSenderCleanup: operationCancel => registerNativePdfSenderCleanup(
            context.sender,
            operationCancel,
            'Renderer navigation canceled embedded shape indexing',
        ),
    });
    ensureShapeIndexTtlTimer();
    const {abortController} = session;
    const {sidecarPath} = session;
    const handleMainAbort = () => cancel('Embedded shape indexing canceled');
    mainOperation.signal.addEventListener('abort', handleMainAbort, {once: true});

    await runPdfSidecarOperation(
        session,
        mainOperation,
        handleMainAbort,
        cleanupSession,
        async () => {
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
            await scanPdfSidecarIntoSession(
                session,
                sidecarPath,
                abortController.signal,
                'Embedded shape index',
                () => assertWorkingCopyRevisionCurrent(resolvedPath, expectedRevisionToken),
                signal => scanPdfSidecarLines(sidecarPath, {
                    maxLineBytes: PDF_EMBEDDED_SHAPE_INDEX_MAX_LINE_BYTES,
                    label: 'Embedded shape index',
                    signal,
                    decodeHeader,
                    decodeDataLine,
                }),
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
    const result = await readPdfSidecarChunk({
        sidecarPath: session.sidecarPath,
        index: session.index,
        offset: requestedOffset,
        chunkBytes,
        label: 'Embedded shape index',
        decodeDataLine,
    });
    session.lastTouchedAt = Date.now();
    return result;
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
        cancelPdfSidecarSession(session, 'Embedded shape index released');
    }
    await session.operationPromise.catch(() => undefined);
    await cleanupSession(session);
    return true;
}


export async function sweepStalePdfEmbeddedShapeIndexArtifacts(
    maxAgeMs = SHAPE_INDEX_DEFAULT_TTL_MS,
    maxEntries = SHAPE_INDEX_SWEEP_MAX_ENTRIES,
) {
    return sweepStalePdfSidecarArtifacts({
        tempDir: getAppTempDir(),
        directoryPrefix: SHAPE_INDEX_DIRECTORY_PREFIX,
        activeDirectories: new Set([...sessions.values()].map(session => session.sidecarDirectory)),
        maxAgeMs,
        maxEntries,
        onError: (directoryPath, error) => {
            logger.warn(`Failed to sweep stale embedded shape index artifact "${directoryPath}": ${String(error)}`);
        },
    });
}

function ensureShapeIndexTtlTimer() {
    shapeIndexTtlTimer ??= setInterval(() => {
        const cutoff = Date.now() - SHAPE_INDEX_DEFAULT_TTL_MS;
        expireStalePdfSidecarSessions(sessions.values(), cutoff, session => {
            session.released = true;
            cancelPdfSidecarSession(session, 'Embedded shape index session expired');
            cleanupWhenOperationSettles(session);
        });
        void sweepStalePdfEmbeddedShapeIndexArtifacts().catch((error: unknown) => {
            logger.debug(`Embedded shape index TTL sweep failed: ${String(error)}`);
        });
    }, 30_000);
    shapeIndexTtlTimer.unref?.();
}
