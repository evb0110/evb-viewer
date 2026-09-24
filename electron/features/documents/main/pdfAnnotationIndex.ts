import type {
    IPdfAnnotationIndexChunk,
    IPdfAnnotationIndexChunkOptions,
    IPdfAnnotationIndexEntry,
    IPdfAnnotationIndexObjectRef,
    IPdfAnnotationIndexOptions,
    IPdfAnnotationIndexSession,
} from '@contracts/electronApiDocuments';
import {
    parseDocumentRef,
    type TDocumentRef,
} from '@contracts/documentRef';
import {createSessionId} from '@contracts/shared';
import {createStaleRevisionError} from '@contracts/documentMutationErrors';
import {
    parseDocumentRevisionToken,
    type TDocumentRevisionToken,
} from '@contracts/documentRevision';
import {PDF_ANNOTATION_INDEX_MAX_CHUNK_BYTES} from '@contracts/electronApiDocuments';
import type {IDocumentsSenderIdContext} from '@electron/features/documents/documentsService';
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

const ANNOTATION_INDEX_DIRECTORY_PREFIX = 'pdf-annotation-index-';
const ANNOTATION_INDEX_FILE_NAME = 'index.jsonl';
const ANNOTATION_INDEX_FORMATS = new Set([
    'evb-pdf-annotation-index',
    'evb-pdf-annotation-name-index',
]);
const ANNOTATION_INDEX_SCHEMA_VERSION = 1;
const ANNOTATION_INDEX_LINE_MAX_BYTES = PDF_ANNOTATION_INDEX_MAX_CHUNK_BYTES;
const ANNOTATION_INDEX_DEFAULT_TTL_MS = 10 * 60 * 1_000;
const ANNOTATION_INDEX_SWEEP_MAX_ENTRIES = 200;
const ANNOTATION_INDEX_NATIVE_TIMEOUT_MS = 30 * 60 * 1_000;
const ANNOTATION_INDEX_NATIVE_STDOUT_BYTES = 64 * 1_024;
const ANNOTATION_INDEX_NATIVE_STDERR_BYTES = 512 * 1_024;
const logger = createLogger('pdf-annotation-index');

interface IAnnotationIndexSessionState {
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
    cleanupPromise?: Promise<void>;
}

function requireDocumentRef(value: unknown): TDocumentRef {
    const documentRef = parseDocumentRef(value);
    if (documentRef === null) {
        throw new Error('Expected an absolute document ref');
    }
    return documentRef;
}

const sessions = new Map<string, IAnnotationIndexSessionState>();
let annotationIndexTtlTimer: ReturnType<typeof setInterval> | null = null;

function getOwnerId(context: IDocumentsSenderIdContext) {
    return context.senderId ?? -1;
}

function decodeHeader(value: unknown) {
    if (!isRecord(value)) {
        throw new Error('PDF annotation index sidecar is missing its JSONL header');
    }
    const format = typeof value.format === 'string' ? value.format : '';
    const schemaVersion = value.schemaVersion;
    if (
        !ANNOTATION_INDEX_FORMATS.has(format)
        || !Number.isSafeInteger(schemaVersion)
        || schemaVersion !== ANNOTATION_INDEX_SCHEMA_VERSION
    ) {
        throw new Error('PDF annotation index sidecar has an unsupported header');
    }
    const pageCount = value.pageCount;
    if (typeof pageCount !== 'number' || !Number.isSafeInteger(pageCount) || pageCount < 0) {
        throw new Error('PDF annotation index sidecar header has an invalid page count');
    }
    if (value.chunkBytes !== undefined && (
        typeof value.chunkBytes !== 'number'
        || !Number.isSafeInteger(value.chunkBytes)
        || value.chunkBytes < 1
        || value.chunkBytes > ANNOTATION_INDEX_LINE_MAX_BYTES
    )) {
        throw new Error('PDF annotation index sidecar header has an invalid chunk size');
    }
    return {pageCount};
}

function decodeObjectRef(value: unknown, fieldName: string): IPdfAnnotationIndexObjectRef | null {
    if (value === undefined || value === null) {
        return null;
    }
    if (typeof value === 'string') {
        const match = /^(\d+)\s+(\d+)\s+R$/u.exec(value.trim());
        if (!match) {
            throw new Error(`${fieldName} must be a PDF object reference`);
        }
        const objectNumber = Number(match[1]);
        const generationNumber = Number(match[2]);
        if (!Number.isSafeInteger(objectNumber) || objectNumber < 1 || !Number.isSafeInteger(generationNumber)) {
            throw new Error(`${fieldName} contains an unsafe PDF object reference`);
        }
        return {
            objectNumber,
            generationNumber,
        };
    }
    if (!isRecord(value)) {
        throw new Error(`${fieldName} must be an object or null`);
    }
    const objectNumber = value.objectNumber;
    const generationNumber = value.generationNumber;
    if (
        typeof objectNumber !== 'number'
        || !Number.isSafeInteger(objectNumber)
        || objectNumber < 1
        || typeof generationNumber !== 'number'
        || !Number.isSafeInteger(generationNumber)
        || generationNumber < 0
    ) {
        throw new Error(`${fieldName} contains an unsafe PDF object reference`);
    }
    return {
        objectNumber,
        generationNumber,
    };
}

function decodeEntry(value: unknown, linePageIndex?: number): IPdfAnnotationIndexEntry {
    if (!isRecord(value)) {
        throw new Error('PDF annotation index entry must be an object');
    }
    const rawPageIndex = value.pageIndex ?? linePageIndex;
    if (typeof rawPageIndex !== 'number' || !Number.isSafeInteger(rawPageIndex) || rawPageIndex < 0) {
        throw new Error('PDF annotation index entry has an invalid page index');
    }
    if (
        linePageIndex !== undefined
        && rawPageIndex !== linePageIndex
    ) {
        throw new Error('PDF annotation index entry page does not match its chunk');
    }
    const objectNumber = value.objectNumber;
    const generationNumber = value.generationNumber;
    const subtype = value.subtype;
    if (
        typeof objectNumber !== 'number'
        || !Number.isSafeInteger(objectNumber)
        || objectNumber < 0
        || typeof generationNumber !== 'number'
        || !Number.isSafeInteger(generationNumber)
        || generationNumber < 0
        || typeof subtype !== 'string'
        || subtype.length === 0
    ) {
        throw new Error('PDF annotation index entry has invalid object or subtype fields');
    }
    const name = value.name;
    if (name !== null && typeof name !== 'string') {
        throw new Error('PDF annotation index entry name must be a string or null');
    }
    const popupRef = decodeObjectRef(value.popupRef ?? value.popup, 'PDF annotation index popupRef');
    const parentRef = decodeObjectRef(value.parentRef ?? value.parent, 'PDF annotation index parentRef');
    return {
        pageIndex: rawPageIndex as IPdfAnnotationIndexEntry['pageIndex'],
        objectNumber,
        generationNumber,
        subtype,
        name,
        popupRef,
        parentRef,
    };
}

function decodeDataLine(value: unknown): IPdfAnnotationIndexEntry[] {
    if (!isRecord(value)) {
        throw new Error('PDF annotation index sidecar line must be an object');
    }
    const rawPageIndex = value.pageIndex;
    const pageIndex = rawPageIndex === undefined
        ? undefined
        : typeof rawPageIndex === 'number' && Number.isSafeInteger(rawPageIndex) && rawPageIndex >= 0
            ? rawPageIndex
            : null;
    if (pageIndex === null) {
        throw new Error('PDF annotation index sidecar line has an invalid page index');
    }
    const rawEntries = Array.isArray(value.entries)
        ? value.entries
        : Array.isArray(value.annotations)
            ? value.annotations
            : value.objectNumber !== undefined
                ? [value]
                : null;
    if (rawEntries === null) {
        throw new Error('PDF annotation index sidecar line has no entries');
    }
    return rawEntries.map(item => decodeEntry(item, pageIndex));
}

function parseChunkOptions(options: IPdfAnnotationIndexChunkOptions | undefined) {
    const chunkBytes = options?.chunkBytes ?? ANNOTATION_INDEX_LINE_MAX_BYTES;
    if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > ANNOTATION_INDEX_LINE_MAX_BYTES) {
        throw new RangeError(`Annotation index chunkBytes must be between 1 and ${ANNOTATION_INDEX_LINE_MAX_BYTES}`);
    }
    return chunkBytes;
}

function assertSessionOwner(session: IAnnotationIndexSessionState, context: IDocumentsSenderIdContext) {
    if (session.ownerId !== getOwnerId(context)) {
        throw new Error('PDF annotation index session belongs to another sender');
    }
}

function cleanupWhenOperationSettles(session: IAnnotationIndexSessionState) {
    cleanupPdfSidecarSessionWhenOperationSettles(session, cleanupSession);
}

function cleanupSession(session: IAnnotationIndexSessionState) {
    return cleanupPdfSidecarSession(sessions, session, (error: unknown) => {
        logger.warn(`Failed to remove PDF annotation index sidecar: ${String(error)}`);
    }).finally(clearAnnotationIndexTtlTimerIfIdle);
}

function clearAnnotationIndexTtlTimerIfIdle() {
    if (sessions.size === 0 && annotationIndexTtlTimer) {
        clearInterval(annotationIndexTtlTimer);
        annotationIndexTtlTimer = null;
    }
}

/** Build the native command in one place so the native operation can rename its verb. */
function buildPdfAnnotationIndexCommandArgs(inputPath: string, outputPath: string, qpdfPath: string) {
    return [
        'annotation-index',
        '--input',
        inputPath,
        '--output',
        outputPath,
        '--qpdf',
        qpdfPath,
    ];
}

async function runPdfAnnotationIndexNative(
    inputPath: string,
    outputPath: string,
    signal: AbortSignal,
    cancelGroup: string,
) {
    const nativePath = resolveNativePageOpsPath();
    if (!nativePath) {
        throw new Error('Cannot build a PDF annotation index because the native page tool is unavailable');
    }
    await runNativeToolCommand(
        nativePath,
        buildPdfAnnotationIndexCommandArgs(inputPath, outputPath, getPdfNativeToolPaths().qpdf),
        {
            timeoutMs: ANNOTATION_INDEX_NATIVE_TIMEOUT_MS,
            maxStdoutBytes: ANNOTATION_INDEX_NATIVE_STDOUT_BYTES,
            maxStderrBytes: ANNOTATION_INDEX_NATIVE_STDERR_BYTES,
            rejectOnStdoutTruncation: true,
            commandLabel: 'evb-pdf-page-ops(annotation-index)',
            signal,
            cancelGroup,
        },
    );
}

export async function beginPdfAnnotationIndex(
    context: IDocumentsSenderIdContext,
    filePath: string,
    options: IPdfAnnotationIndexOptions,
): Promise<IPdfAnnotationIndexSession> {
    const expectedRevisionToken = parseDocumentRevisionToken(
        options?.expectedDocumentRevisionToken,
    );
    if (expectedRevisionToken === null) {
        throw new Error('Document revision token is required to build a PDF annotation index');
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

    const sessionId = createSessionId('pdf-annotation-index');
    const {
        session,
        mainOperation,
        cancel,
        detachSenderCleanup,
    } = await createPdfSidecarMainOperation({
        sessionId,
        ownerId: getOwnerId(context),
        documentRef: filePath,
        resolvedPath,
        expectedRevisionToken,
        tempDir: getAppTempDir(),
        directoryPrefix: ANNOTATION_INDEX_DIRECTORY_PREFIX,
        fileName: ANNOTATION_INDEX_FILE_NAME,
        cancelGroup: `pdf-annotation-index:${sessionId}`,
        sessions,
        ownerWebContentsId: context.senderId,
        workingCopyPath: resolvedPath,
        cleanup: cleanupSession,
        cancelGroupForOperation: operationId => `pdf-annotation-index:${operationId}`,
        registerSenderCleanup: operationCancel => registerNativePdfSenderCleanup(
            context.sender,
            operationCancel,
            'Renderer navigation canceled PDF annotation indexing',
        ),
    });
    ensureAnnotationIndexTtlTimer();
    const {abortController} = session;
    const {sidecarPath} = session;
    const handleMainAbort = () => cancel('PDF annotation indexing canceled');
    mainOperation.signal.addEventListener('abort', handleMainAbort, {once: true});

    await runPdfSidecarOperation(
        session,
        mainOperation,
        handleMainAbort,
        cleanupSession,
        async () => {
            await runWithWorkingCopyReadBacking(
                resolvedPath,
                physicalPath => runPdfAnnotationIndexNative(
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
                'PDF annotation index',
                () => assertWorkingCopyRevisionCurrent(resolvedPath, expectedRevisionToken),
                signal => scanPdfSidecarLines(sidecarPath, {
                    maxLineBytes: ANNOTATION_INDEX_LINE_MAX_BYTES,
                    label: 'PDF annotation index',
                    signal,
                    decodeHeader: value => decodeHeader(value).pageCount,
                    decodeDataLine,
                }),
            );
        },
        detachSenderCleanup,
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

export async function readPdfAnnotationIndexChunk(
    context: IDocumentsSenderIdContext,
    sessionId: string,
    offset: number,
    options?: IPdfAnnotationIndexChunkOptions,
): Promise<IPdfAnnotationIndexChunk> {
    const session = sessions.get(sessionId);
    if (!session) {
        throw new Error('PDF annotation index session is not available');
    }
    assertSessionOwner(session, context);
    if (session.canceled || session.released) {
        throw new Error('PDF annotation index session is canceled');
    }
    const requestedOffset = assertSafePdfSidecarOffset(offset, 'offset');
    const chunkBytes = parseChunkOptions(options);
    const result = await readPdfSidecarChunk({
        sidecarPath: session.sidecarPath,
        index: session.index,
        offset: requestedOffset,
        chunkBytes,
        label: 'PDF annotation index',
        decodeDataLine,
    });
    session.lastTouchedAt = Date.now();
    return result;
}

export async function releasePdfAnnotationIndex(
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
        cancelPdfSidecarSession(session, 'PDF annotation index released');
    }
    await session.operationPromise.catch(() => undefined);
    await cleanupSession(session);
    return true;
}


export async function sweepStalePdfAnnotationIndexArtifacts(
    maxAgeMs = ANNOTATION_INDEX_DEFAULT_TTL_MS,
    maxEntries = ANNOTATION_INDEX_SWEEP_MAX_ENTRIES,
) {
    return sweepStalePdfSidecarArtifacts({
        tempDir: getAppTempDir(),
        directoryPrefix: ANNOTATION_INDEX_DIRECTORY_PREFIX,
        activeDirectories: new Set([...sessions.values()].map(session => session.sidecarDirectory)),
        maxAgeMs,
        maxEntries,
        onError: (directoryPath, error) => {
            logger.warn(`Failed to sweep stale PDF annotation index artifact "${directoryPath}": ${String(error)}`);
        },
    });
}

function ensureAnnotationIndexTtlTimer() {
    annotationIndexTtlTimer ??= setInterval(() => {
        const cutoff = Date.now() - ANNOTATION_INDEX_DEFAULT_TTL_MS;
        expireStalePdfSidecarSessions(sessions.values(), cutoff, session => {
            session.released = true;
            cancelPdfSidecarSession(session, 'PDF annotation index session expired');
            cleanupWhenOperationSettles(session);
        });
        void sweepStalePdfAnnotationIndexArtifacts().catch((error: unknown) => {
            logger.debug(`PDF annotation index TTL sweep failed: ${String(error)}`);
        });
    }, 30_000);
    annotationIndexTtlTimer.unref?.();
}
