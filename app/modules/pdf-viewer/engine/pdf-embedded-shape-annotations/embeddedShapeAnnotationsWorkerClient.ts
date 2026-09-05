import type { IShapeAnnotation } from '@app/types/annotations';
import type { TDocumentRef } from '@contracts/documentRef';
import type {
    IPdfEmbeddedShapeIndexChunk,
    IPdfEmbeddedShapeIndexEntry,
    IPdfEmbeddedShapeIndexSession,
} from '@contracts/electronApiDocuments';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import { importEmbeddedShapeAnnotations } from '@app/modules/pdf-viewer/engine/pdf-embedded-shape-annotations/importEmbeddedShapeAnnotations';
import {
    assertEmbeddedShapeImportSize,
    EMBEDDED_SHAPE_IMPORT_MAX_INPUT_BYTES,
} from '@app/modules/pdf-viewer/engine/pdf-embedded-shape-annotations/embeddedShapeImportLimit';
import { readDocumentBytes } from '@app/utils/documentBytes';
import { getDocumentFilesCapability } from '@app/utils/platformDocuments';
import { isNativeDocumentRef } from '@app/utils/documentRef';
import { formatPdfJsAnnotationRef } from '@app/utils/pdfAnnotationRefs';
import {
    PDF_ANNOTATION_LINE_END_STYLES,
    PDF_ANNOTATION_SHAPE_PDF_SUBTYPES,
    PDF_ANNOTATION_SHAPE_TYPES,
} from '@contracts/annotations';
import type {FailureReceipt} from '@contracts/diagnostics/failureReceipt';
import {
    detectRendererDiagnosticsHost,
    getRendererFailureReporter,
    initializeRendererFailureReporter,
} from '@app/utils/failureReporter';

const EMBEDDED_SHAPE_IMPORT_TIMEOUT_MS = 90_000;
const EMBEDDED_SHAPE_IMPORT_PATH_CHUNK_BYTES = 4 * 1024 * 1024;
const EMBEDDED_SHAPE_INDEX_CHUNK_BYTES = 512 * 1024;

export type TEmbeddedShapeImportCapabilityReason =
    | 'native-index-capability-unavailable'
    | 'native-index-failed';

/**
 * A path-backed desktop document must report this state to the caller instead
 * of falling through to a whole-document renderer read. The reason is kept on
 * the error so the managed-shape runtime can leave its baseline incomplete
 * without treating the PDF as malformed.
 */
export class EmbeddedShapeImportCapabilityError extends Error {
    readonly reason: TEmbeddedShapeImportCapabilityReason;

    constructor(reason: TEmbeddedShapeImportCapabilityReason, message: string) {
        super(message);
        this.name = 'EmbeddedShapeImportCapabilityError';
        this.reason = reason;
    }
}

export type TEmbeddedShapeNativeImportResult =
    | {
        status: 'complete';
        shapes: IShapeAnnotation[];
    }
    | {
        status: 'incomplete';
        reason: TEmbeddedShapeImportCapabilityReason;
    };

interface IEmbeddedShapeIndexFiles {
    beginPdfEmbeddedShapeIndex?: (
        path: TDocumentRef,
        options: {expectedDocumentRevisionToken: TDocumentRevisionToken},
    ) => Promise<IPdfEmbeddedShapeIndexSession>;
    readPdfEmbeddedShapeIndexChunk?: (
        sessionId: string,
        offset: number,
        options?: {chunkBytes?: number},
    ) => Promise<IPdfEmbeddedShapeIndexChunk>;
    releasePdfEmbeddedShapeIndex?: (sessionId: string) => Promise<boolean>;
    cancelPdfEmbeddedShapeIndex?: (sessionId: string) => Promise<{canceled: boolean}>;
    getDocumentRevision?: (path: TDocumentRef) => Promise<{token: TDocumentRevisionToken}>;
}

interface IEmbeddedShapeImportWorkerResponse {
    ok: boolean;
    shapes?: IShapeAnnotation[];
    error?: string;
}

interface IEmbeddedShapeImportWorkerFailure extends Error {failure?: FailureReceipt;}

function getWorkerFailureReceipt(error: unknown) {
    if (!(error instanceof Error)) {
        return undefined;
    }
    return (error as IEmbeddedShapeImportWorkerFailure).failure;
}

function attachWorkerFailureReceipt<T>(error: T, receipt: FailureReceipt | undefined) {
    if (!(error instanceof Error) || !receipt || getWorkerFailureReceipt(error)) {
        return error;
    }
    Object.defineProperty(error, 'failure', {
        configurable: true,
        value: receipt,
    });
    return error;
}

function reportWorkerFailure(error: Error) {
    const existingReceipt = getWorkerFailureReceipt(error);
    if (existingReceipt) {
        return error;
    }

    const reporter = getRendererFailureReporter() ?? initializeRendererFailureReporter({host: detectRendererDiagnosticsHost()});
    const receipt = reporter.capture({
        code: 'RENDERER_ANNOTATION_OPERATION_FAILED',
        context: {},
        local: {
            source: 'embedded-shape-annotations-worker-parent',
            message: error.message,
            cause: error,
        },
    }, {runtime: 'browser-worker-parent'});
    return attachWorkerFailureReceipt(error, receipt);
}

function postWorkerMessage(worker: Worker, message: unknown, transfer?: Transferable[]) {
    try {
        if (transfer) {
            worker.postMessage(message, transfer);
        } else {
            worker.postMessage(message);
        }
    } catch (error) {
        throw reportWorkerFailure(error instanceof Error ? error : new Error(String(error)));
    }
}

function canUseEmbeddedShapeImportWorker() {
    return typeof window !== 'undefined' && typeof Worker !== 'undefined';
}

function createTransferableView(data: Uint8Array, transferOwnership: boolean) {
    if (
        transferOwnership
        && data.byteOffset === 0
        && data.byteLength === data.buffer.byteLength
    ) {
        return data;
    }
    return data.slice();
}

function isNativeEmbeddedShapeIndexSource(path: TDocumentRef | null | undefined) {
    // The document ref, rather than the current platform guess, identifies a
    // native source. If the preload bridge is missing, the native index path
    // reports its typed capability error instead of silently reading the PDF
    // through the browser importer.
    return Boolean(path) && isNativeDocumentRef(path);
}

function hasValue<T extends string>(values: readonly T[], value: unknown): value is T {
    return typeof value === 'string' && values.includes(value as T);
}

function assertFiniteValue(value: unknown, fieldName: string) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`Native embedded shape index ${fieldName} must be finite`);
    }
    return value;
}

function assertNonNegativeFiniteValue(value: unknown, fieldName: string) {
    const finiteValue = assertFiniteValue(value, fieldName);
    if (finiteValue < 0) {
        throw new Error(`Native embedded shape index ${fieldName} must be non-negative`);
    }
    return finiteValue;
}

function assertSafeIndex(value: unknown, fieldName: string, minimum = 0) {
    if (
        typeof value !== 'number'
        || !Number.isSafeInteger(value)
        || value < minimum
    ) {
        throw new Error(`Native embedded shape index ${fieldName} must be a safe integer >= ${minimum}`);
    }
    return value;
}

function copyNativeShapePoints(
    points: IPdfEmbeddedShapeIndexEntry['points'],
    fieldName: string,
) {
    if (points === null) {
        return undefined;
    }
    if (!Array.isArray(points)) {
        throw new Error(`Native embedded shape index ${fieldName} must be an array or null`);
    }
    return points.map((point, index) => ({
        x: assertFiniteValue(point?.x, `${fieldName}[${index}].x`),
        y: assertFiniteValue(point?.y, `${fieldName}[${index}].y`),
    }));
}

function copyNativeShapeStrokes(strokes: IPdfEmbeddedShapeIndexEntry['strokes']) {
    if (strokes === null) {
        return undefined;
    }
    if (!Array.isArray(strokes)) {
        throw new Error('Native embedded shape index strokes must be an array or null');
    }
    return strokes.map((stroke, index) => copyNativeShapePoints(
        stroke,
        `strokes[${index}]`,
    ) ?? []);
}

function shapeIdForNativeEntry(entry: IPdfEmbeddedShapeIndexEntry, annotationId: string) {
    const identity = entry.stableKey?.trim() ?? annotationId;
    return `embedded-shape:${entry.pageIndex}:${identity}`;
}

/** Convert one native marker-space entry without loading the source PDF. */
function mapPdfEmbeddedShapeIndexEntry(entry: IPdfEmbeddedShapeIndexEntry): IShapeAnnotation {
    if (!entry || typeof entry !== 'object') {
        throw new Error('Native embedded shape index entry must be an object');
    }
    const pageIndex = assertSafeIndex(entry.pageIndex, 'pageIndex');
    const objectNumber = assertSafeIndex(entry.objectNumber, 'objectNumber', 1);
    const generationNumber = assertSafeIndex(entry.generationNumber, 'generationNumber');
    if (!hasValue(PDF_ANNOTATION_SHAPE_PDF_SUBTYPES, entry.pdfSubtype)) {
        throw new Error(`Native embedded shape index pdfSubtype is unsupported: ${String(entry.pdfSubtype)}`);
    }
    if (!hasValue(PDF_ANNOTATION_SHAPE_TYPES, entry.type)) {
        throw new Error(`Native embedded shape index type is unsupported: ${String(entry.type)}`);
    }
    if (
        entry.lineStartStyle !== null
        && !hasValue(PDF_ANNOTATION_LINE_END_STYLES, entry.lineStartStyle)
    ) {
        throw new Error(`Native embedded shape index lineStartStyle is unsupported: ${String(entry.lineStartStyle)}`);
    }
    if (
        entry.lineEndStyle !== null
        && !hasValue(PDF_ANNOTATION_LINE_END_STYLES, entry.lineEndStyle)
    ) {
        throw new Error(`Native embedded shape index lineEndStyle is unsupported: ${String(entry.lineEndStyle)}`);
    }
    const annotationId = formatPdfJsAnnotationRef({
        objectNumber,
        generationNumber,
    });
    const fillColor = entry.fillColor ?? undefined;
    if (fillColor !== undefined && (typeof fillColor !== 'string' || fillColor.length === 0)) {
        throw new Error('Native embedded shape index fillColor must be a non-empty string or null');
    }
    if (typeof entry.color !== 'string' || entry.color.length === 0) {
        throw new Error('Native embedded shape index color must be a non-empty string');
    }
    const opacity = assertNonNegativeFiniteValue(entry.opacity, 'opacity');
    if (opacity > 1) {
        throw new Error('Native embedded shape index opacity must be at most one');
    }
    const strokeWidth = assertNonNegativeFiniteValue(entry.strokeWidth, 'strokeWidth');
    const width = assertNonNegativeFiniteValue(entry.width, 'width');
    const height = assertNonNegativeFiniteValue(entry.height, 'height');
    const x = assertFiniteValue(entry.x, 'x');
    const y = assertFiniteValue(entry.y, 'y');
    const x2 = entry.x2 === null ? undefined : assertFiniteValue(entry.x2, 'x2');
    const y2 = entry.y2 === null ? undefined : assertFiniteValue(entry.y2, 'y2');
    const points = copyNativeShapePoints(entry.points, 'points');
    const strokes = copyNativeShapeStrokes(entry.strokes);

    return {
        id: shapeIdForNativeEntry(entry, annotationId),
        type: entry.type,
        pageIndex,
        x,
        y,
        width,
        height,
        ...(x2 === undefined ? {} : {x2}),
        ...(y2 === undefined ? {} : {y2}),
        color: entry.color,
        ...(fillColor === undefined ? {} : {fillColor}),
        opacity,
        strokeWidth,
        ...(points === undefined ? {} : {points}),
        ...(strokes === undefined ? {} : {strokes}),
        source: 'embedded',
        annotationId,
        stableKey: entry.stableKey,
        pdfSubtype: entry.pdfSubtype,
        ...(entry.lineStartStyle === null ? {} : {lineStartStyle: entry.lineStartStyle}),
        ...(entry.lineEndStyle === null ? {} : {lineEndStyle: entry.lineEndStyle}),
        createdAt: entry.createdAt,
        modifiedAt: entry.modifiedAt,
    };
}

function nativeShapeIndexCapabilityError(message: string) {
    return new EmbeddedShapeImportCapabilityError(
        'native-index-capability-unavailable',
        message,
    );
}

function nativeShapeIndexFailure(error: unknown) {
    if (error instanceof EmbeddedShapeImportCapabilityError) {
        return error;
    }
    return new EmbeddedShapeImportCapabilityError(
        'native-index-failed',
        `Native embedded shape index failed: ${error instanceof Error ? error.message : String(error)}`,
    );
}

function getNativeEmbeddedShapeIndexFiles(path: TDocumentRef, expectedRevision: TDocumentRevisionToken | null) {
    if (!isNativeEmbeddedShapeIndexSource(path)) {
        throw nativeShapeIndexCapabilityError(
            'Native embedded shape index requires an absolute desktop document path',
        );
    }

    let files: IEmbeddedShapeIndexFiles;
    try {
        files = getDocumentFilesCapability();
    } catch (error) {
        throw nativeShapeIndexCapabilityError(
            `Native embedded shape index capability is unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
    if (
        !files.beginPdfEmbeddedShapeIndex
        || !files.readPdfEmbeddedShapeIndexChunk
        || !files.releasePdfEmbeddedShapeIndex
        || !files.cancelPdfEmbeddedShapeIndex
        || (!expectedRevision && !files.getDocumentRevision)
    ) {
        throw nativeShapeIndexCapabilityError(
            'Native embedded shape index capability is unavailable on this desktop path',
        );
    }
    return files as Required<Pick<
        IEmbeddedShapeIndexFiles,
        | 'beginPdfEmbeddedShapeIndex'
        | 'readPdfEmbeddedShapeIndexChunk'
        | 'releasePdfEmbeddedShapeIndex'
        | 'cancelPdfEmbeddedShapeIndex'
    >> & Pick<IEmbeddedShapeIndexFiles, 'getDocumentRevision'>;
}

async function readNativeEmbeddedShapeIndexChunks(
    path: TDocumentRef,
    expectedRevision: TDocumentRevisionToken | null,
    signal?: AbortSignal,
) {
    signal?.throwIfAborted();
    const files = getNativeEmbeddedShapeIndexFiles(path, expectedRevision);
    let session: IPdfEmbeddedShapeIndexSession | null = null;
    let primaryError: unknown = null;
    let operationFailed = false;
    let importedShapes: IShapeAnnotation[] | null = null;
    let releaseError: unknown = null;
    try {
        let revision = expectedRevision;
        if (!revision) {
            const getDocumentRevision = files.getDocumentRevision;
            if (!getDocumentRevision) {
                throw nativeShapeIndexCapabilityError(
                    'Native embedded shape index revision capability is unavailable on this desktop path',
                );
            }
            revision = (await getDocumentRevision(path)).token;
        }
        signal?.throwIfAborted();
        session = await files.beginPdfEmbeddedShapeIndex(
            path,
            {expectedDocumentRevisionToken: revision},
        );
        if (session.documentRef !== path || session.documentRevisionToken !== revision) {
            throw new Error('Native embedded shape index session identity does not match the requested document');
        }

        importedShapes = [];
        let offset = 0;
        let done = false;
        while (!done) {
            signal?.throwIfAborted();
            const requestedOffset = offset;
            const chunk = await files.readPdfEmbeddedShapeIndexChunk(
                session.sessionId,
                requestedOffset,
                {chunkBytes: EMBEDDED_SHAPE_INDEX_CHUNK_BYTES},
            );
            if (chunk.offset !== requestedOffset) {
                throw new Error(
                    `Native embedded shape index returned offset ${chunk.offset} for requested offset ${requestedOffset}`,
                );
            }
            const nextOffset = chunk.nextOffset ?? requestedOffset + chunk.byteLength;
            if (
                !Number.isSafeInteger(chunk.byteLength)
                || chunk.byteLength < 0
                || chunk.byteLength > EMBEDDED_SHAPE_INDEX_CHUNK_BYTES
                || !Number.isSafeInteger(nextOffset)
                || nextOffset < requestedOffset
                || (chunk.done && chunk.nextOffset !== null)
                || (!chunk.done && chunk.nextOffset === null)
                || (!chunk.done && nextOffset <= requestedOffset)
            ) {
                throw new Error('Native embedded shape index returned a non-advancing chunk offset');
            }
            importedShapes.push(...chunk.entries.map(mapPdfEmbeddedShapeIndexEntry));
            offset = nextOffset;
            done = chunk.done;
        }
        signal?.throwIfAborted();
    } catch (error) {
        primaryError = error;
        operationFailed = true;
    } finally {
        if (session) {
            if (operationFailed || signal?.aborted) {
                try {
                    await files.cancelPdfEmbeddedShapeIndex(session.sessionId);
                } catch {
                    // Preserve the source/index error. Release below still
                    // owns the host session even when cancellation races it.
                }
            }
            try {
                await files.releasePdfEmbeddedShapeIndex(session.sessionId);
            } catch (caughtReleaseError) {
                releaseError = caughtReleaseError;
            }
        }
    }

    if (operationFailed) {
        if (signal?.aborted) {
            throw primaryError;
        }
        throw nativeShapeIndexFailure(primaryError);
    }
    if (releaseError !== null) {
        throw nativeShapeIndexFailure(releaseError);
    }
    return importedShapes ?? [];
}

export async function importEmbeddedShapeAnnotationsFromNativePath(
    path: TDocumentRef,
    options: {
        signal?: AbortSignal;
        expectedDocumentRevisionToken?: TDocumentRevisionToken | null;
    } = {},
): Promise<IShapeAnnotation[]> {
    return readNativeEmbeddedShapeIndexChunks(
        path,
        options.expectedDocumentRevisionToken ?? null,
        options.signal,
    );
}

export async function importEmbeddedShapeAnnotationsFromNativePathResult(
    path: TDocumentRef,
    options: {
        signal?: AbortSignal;
        expectedDocumentRevisionToken?: TDocumentRevisionToken | null;
    } = {},
): Promise<TEmbeddedShapeNativeImportResult> {
    try {
        return {
            status: 'complete',
            shapes: await importEmbeddedShapeAnnotationsFromNativePath(path, options),
        };
    } catch (error) {
        if (error instanceof EmbeddedShapeImportCapabilityError) {
            return {
                status: 'incomplete',
                reason: error.reason,
            };
        }
        throw error;
    }
}

function createEmbeddedShapeImportWorker(
    signal: AbortSignal | undefined,
    dispatch: (worker: Worker, operationSignal: AbortSignal) => void | Promise<void>,
) {
    let worker: Worker;
    try {
        worker = new Worker(
            new URL('./importEmbeddedShapeAnnotations.worker.ts', import.meta.url),
            { type: 'module' },
        );
    } catch (error) {
        throw reportWorkerFailure(error instanceof Error ? error : new Error(String(error)));
    }

    return new Promise<IShapeAnnotation[]>((resolve, reject) => {
        const timeoutError = new Error('Embedded PDF shape import worker timed out');
        const operationController = new AbortController();
        let settled = false;
        const abortFromCaller = () => {
            operationController.abort(signal?.reason instanceof Error
                ? signal.reason
                : new DOMException('Embedded PDF shape import aborted', 'AbortError'));
        };
        const timeout = setTimeout(() => {
            reportWorkerFailure(timeoutError);
            operationController.abort(timeoutError);
        }, EMBEDDED_SHAPE_IMPORT_TIMEOUT_MS);
        const settle = (callback: () => void) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timeout);
            operationController.signal.removeEventListener('abort', abort);
            signal?.removeEventListener('abort', abortFromCaller);
            worker.terminate();
            callback();
        };
        const abort = () => {
            settle(() => reject(operationController.signal.reason instanceof Error
                ? operationController.signal.reason
                : new DOMException('Embedded PDF shape import aborted', 'AbortError')));
        };

        worker.onmessage = (event: MessageEvent<IEmbeddedShapeImportWorkerResponse>) => {
            const response = event.data;
            if (response.ok && Array.isArray(response.shapes)) {
                settle(() => resolve(response.shapes!));
                return;
            }
            settle(() => reject(reportWorkerFailure(new Error(response.error ?? 'Embedded PDF shape import worker failed'))));
        };
        worker.onerror = event => {
            settle(() => reject(reportWorkerFailure(new Error(event.message || 'Embedded PDF shape import worker failed'))));
        };
        operationController.signal.addEventListener('abort', abort, { once: true });
        signal?.addEventListener('abort', abortFromCaller, { once: true });
        if (signal?.aborted) {
            abortFromCaller();
            return;
        }
        Promise.resolve()
            .then(() => {
                operationController.signal.throwIfAborted();
                return dispatch(worker, operationController.signal);
            })
            .catch(error => settle(() => reject(error)));
    });
}

export async function importEmbeddedShapeAnnotationsUsingWorker(
    data: Uint8Array,
    options: {
        signal?: AbortSignal;
        transferOwnership?: boolean;
    } = {},
): Promise<IShapeAnnotation[]> {
    options.signal?.throwIfAborted();
    assertEmbeddedShapeImportSize(data.byteLength);
    if (!canUseEmbeddedShapeImportWorker()) {
        return importEmbeddedShapeAnnotations(data);
    }

    // Path-backed imports pass a disposable read buffer and can transfer it
    // directly. Byte-backed sessions retain canonical renderer state, so the
    // default remains an owned copy that does not detach the caller.
    const transferableData = createTransferableView(data, options.transferOwnership === true);

    return createEmbeddedShapeImportWorker(options.signal, worker => {
        postWorkerMessage(worker, {
            type: 'bytes',
            data: transferableData,
        }, [transferableData.buffer]);
    });
}

export async function importEmbeddedShapeAnnotationsFromPathInWorker(
    path: TDocumentRef,
    options: {signal?: AbortSignal} = {},
): Promise<IShapeAnnotation[]> {
    options.signal?.throwIfAborted();
    if (isNativeEmbeddedShapeIndexSource(path)) {
        return importEmbeddedShapeAnnotationsFromNativePath(path, options);
    }
    if (!canUseEmbeddedShapeImportWorker()) {
        const bytes = options.signal
            ? await readDocumentBytes(path, {
                signal: options.signal,
                maxBytes: EMBEDDED_SHAPE_IMPORT_MAX_INPUT_BYTES,
            })
            : await readDocumentBytes(path, {maxBytes: EMBEDDED_SHAPE_IMPORT_MAX_INPUT_BYTES});
        return importEmbeddedShapeAnnotations(bytes);
    }

    const files = getDocumentFilesCapability();
    const {size} = await files.statFile(path);
    assertEmbeddedShapeImportSize(size);
    options.signal?.throwIfAborted();
    return createEmbeddedShapeImportWorker(options.signal, async (worker, operationSignal) => {
        postWorkerMessage(worker, {
            type: 'path-start',
            size,
        });
        for (let offset = 0; offset < size; offset += EMBEDDED_SHAPE_IMPORT_PATH_CHUNK_BYTES) {
            operationSignal.throwIfAborted();
            const length = Math.min(EMBEDDED_SHAPE_IMPORT_PATH_CHUNK_BYTES, size - offset);
            const chunk = await files.readFileRange(path, offset, length);
            operationSignal.throwIfAborted();
            if (chunk.byteLength !== length) {
                throw new Error(`Document changed while importing embedded shapes: expected ${length} bytes, read ${chunk.byteLength} bytes`);
            }
            const transferableChunk = createTransferableView(chunk, true);
            postWorkerMessage(worker, {
                type: 'path-chunk',
                offset,
                data: transferableChunk,
            }, [transferableChunk.buffer]);
        }
        operationSignal.throwIfAborted();
        postWorkerMessage(worker, {type: 'path-finish'});
    });
}
