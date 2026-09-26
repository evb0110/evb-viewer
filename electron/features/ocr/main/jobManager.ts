import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { WebContents } from 'electron';
import { prepareLanguageModelsForJob } from '@electron/features/ocr/main/prepareLanguageModelsForJob.modelPrep';
import {
    createOcrQueueFailure,
    type IOcrQueueStartResult,
} from '@electron/features/ocr/main/createOcrQueueFailure';
import type {
    TOcrPdfPageSelection,
    TWorkerLog,
} from '@electron/features/ocr/pipeline/types';
import { runOcrJob } from '@electron/features/ocr/pipeline/runOcrJob';
import { resolveOcrPipelinePaths } from '@electron/features/ocr/main/paths';
import {
    getJobWindow,
    safeSendToWindow,
} from '@electron/features/ocr/main/ocrProgressDispatch';
import type {
    IOcrCancelResult,
    IOcrCompleteResult,
    IOcrErrorEnvelope,
    IOcrJobProjectionState,
    IOcrProgress,
    IOcrSearchablePdfOptions,
    TOcrErrorCode,
    TOcrJobProjectionPhase,
    TOcrTextSupersessionPolicy,
} from '@contracts/electronApiOcr';
import {
    OCR_COMPLETE_EVENT_CHANNEL,
    OCR_ERROR_CODES,
    OCR_PROGRESS_EVENT_CHANNEL,
} from '@contracts/electronApiOcr';
import {
    parseRequestId,
    requireJobId,
    requireRequestId,
    type TRequestId,
} from '@contracts/shared';
import {
    parseDocumentRef,
    type TDocumentRef,
} from '@contracts/documentRef';
import {
    parseDocumentRevisionToken,
    type TDocumentRevisionToken,
} from '@contracts/documentRevision';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';
import { runDetached } from '@electron/utils/runDetached';
import { getWorkingCopyRevision } from '@electron/file-access/documentRevisionStore';
import {
    getWorkingCopyBackingEntry,
    normalizePathForLookup,
} from '@electron/file-access/workingCopyStore';
import { removeOcrResultArtifacts } from '@electron/features/ocr/main/removeOcrResultArtifacts';
import {
    createMainJobRegistry,
    type TMainJobErrorKind,
    type TMainJobSnapshot,
    type TMainJobTerminalSnapshot,
} from '@electron/operation-lifecycle/createMainJobRegistry';
import {
    buildOcrErrorEnvelope,
    getOcrPageSelectionCount,
} from '@electron/features/ocr/contracts';

const log = createLogger('ocr-ipc');
const pipelineLog: TWorkerLog = (level, message, data) => {
    if (level === 'error') {
        log.error(message, {code: 'MAIN_OCR_OPERATION_FAILED'}, data);
    } else {
        log[level](message, data);
    }
};
const OCR_TERMINAL_EVENT_RETENTION_MS = 30_000;
const OCR_MODEL_PREP_TIMEOUT_MS = 2 * 60 * 1000;
/** A finished result waits this long to be applied; then its files go. */
const OCR_TERMINAL_RECORD_RETENTION_MS = 60 * 60 * 1_000;

interface IOcrRegistryProgress extends IOcrProgress {projection: {
    supersessionPolicy: TOcrTextSupersessionPolicy;
    replaceAllAcknowledged: boolean;
};}

/** Everything the renderer needs to hear about a job that ended without a PDF. */
interface IOcrJobError extends Omit<IOcrErrorEnvelope, 'details'> {
    details?: string;
    errors: string[];
    diagnostics?: IOcrCompleteResult['diagnostics'];
}

interface IOcrJobOutcome {
    result: IOcrCompleteResult;
    /** Canonical document spelling, so a later apply or discard matches by content. */
    documentKey: string;
    /** The searchable PDF waiting to replace the working copy. */
    staged: {
        pdfPath: string;
        pathKey: string;
        resultSha256: string;
        sourceDocumentRevisionToken: TDocumentRevisionToken;
    } | null;
}

type TOcrJobSnapshot = TMainJobSnapshot<IOcrRegistryProgress, IOcrJobOutcome, IOcrJobError>;
type TOcrTerminalSnapshot = TMainJobTerminalSnapshot<IOcrRegistryProgress, IOcrJobOutcome, IOcrJobError>;
type TOcrCompletedSnapshot = Extract<TOcrJobSnapshot, {status: 'completed'}>;

class OcrJobFailure extends Error {
    readonly failure: IOcrJobError;

    constructor(failure: IOcrJobError) {
        super(failure.message);
        this.name = 'OcrJobFailure';
        this.failure = failure;
    }
}

interface IOcrManagerContext {
    sender: Pick<WebContents, 'id' | 'isDestroyed' | 'once' | 'on' | 'removeListener'>;
    senderId: number;
}

function toOcrActor(context: IOcrManagerContext) {
    return {sender: context.sender as WebContents};
}

function canonicalPathKey(path: string) {
    const resolved = resolve(path.trim());
    try {
        return realpathSync(resolved);
    } catch {
        return resolved;
    }
}

function isOcrErrorEnvelope(cause: unknown): cause is IOcrErrorEnvelope {
    return typeof cause === 'object'
        && cause !== null
        && 'code' in cause
        && OCR_ERROR_CODES.includes(cause.code as TOcrErrorCode)
        && 'message' in cause
        && typeof cause.message === 'string'
        && 'retryable' in cause
        && typeof cause.retryable === 'boolean'
        && 'timestamp' in cause
        && typeof cause.timestamp === 'number';
}

function createOcrJobError(
    envelope: IOcrErrorEnvelope,
    errors: string[],
    diagnostics?: IOcrCompleteResult['diagnostics'],
): IOcrJobError {
    const {
        details, ...fields
    } = envelope;
    return {
        ...fields,
        ...(details === undefined ? {} : {details}),
        errors,
        ...(diagnostics === undefined ? {} : {diagnostics}),
    };
}

function toOcrJobError(cause: unknown, kind: TMainJobErrorKind): IOcrJobError {
    if (cause instanceof OcrJobFailure) {
        return cause.failure;
    }
    if (kind === 'canceled') {
        const message = 'OCR job was cancelled';
        return createOcrJobError(
            buildOcrErrorEnvelope('OCR_INTERNAL_ERROR', message, {details: getErrorMessage(cause)}),
            [message],
        );
    }
    const envelope = isOcrErrorEnvelope(cause)
        ? cause
        : buildOcrErrorEnvelope(
            kind === 'duplicate-job-id' ? 'OCR_QUEUE_BACKPRESSURE' : 'OCR_INTERNAL_ERROR',
            getErrorMessage(cause) || 'OCR job failed',
            {retryable: kind === 'duplicate-job-id'},
        );
    return createOcrJobError(envelope, [envelope.message]);
}

function toPublicOcrProgress(progress: IOcrRegistryProgress): IOcrProgress {
    const {
        projection: _projection,
        ...publicProgress
    } = progress;
    return publicProgress;
}

function toCompleteResult(snapshot: TOcrTerminalSnapshot): IOcrCompleteResult {
    if (snapshot.status === 'completed') {
        return snapshot.result.result;
    }
    const {
        errors,
        diagnostics,
        ...errorEnvelope
    } = snapshot.error;
    return {
        requestId: requireRequestId(snapshot.jobId),
        success: false,
        errors,
        ...(diagnostics === undefined ? {} : {diagnostics}),
        errorEnvelope,
    };
}

function removeResultFiles(snapshot: TOcrJobSnapshot) {
    if (snapshot.status !== 'completed' || !snapshot.result.staged) {
        return Promise.resolve(true);
    }
    return removeOcrResultArtifacts(snapshot.result.staged.pdfPath, log);
}

const ocrJobs = createMainJobRegistry<IOcrRegistryProgress, IOcrJobOutcome, IOcrJobError>({
    retention: {
        eventReplayTtlMs: OCR_TERMINAL_EVENT_RETENTION_MS,
        terminalRecordTtlMs: OCR_TERMINAL_RECORD_RETENTION_MS,
    },
    progress: {
        channel: OCR_PROGRESS_EVENT_CHANNEL,
        getEventKey: progress => progress.requestId,
        send: (sender, _channel, progress) => {
            safeSendToWindow(
                getJobWindow(sender.id),
                OCR_PROGRESS_EVENT_CHANNEL,
                toPublicOcrProgress(progress),
            );
        },
    },
    toError: toOcrJobError,
    terminalProgress: {
        completed: latest => ({
            ...latest,
            processedCount: latest.totalPages,
            phaseProgress: 100,
            status: 'success',
        }),
        canceled: (latest, error) => ({
            ...latest,
            status: 'canceled',
            error: error.message,
        }),
        failed: (latest, error) => ({
            ...latest,
            status: 'failed',
            error: error.message,
        }),
    },
    onEvict: snapshot => runDetached(() => removeResultFiles(snapshot), {
        label: `remove unapplied OCR result ${snapshot.jobId}`,
        logger: log,
    }),
});

function getFirstRequestedPage(pages: TOcrPdfPageSelection) {
    if (Array.isArray(pages)) {
        return pages[0]?.pageNumber ?? 0;
    }
    switch (pages.kind) {
        case 'all':
            return 1;
        case 'range':
            return pages.firstPage;
        case 'ranges':
            return pages.ranges[0]?.firstPage ?? 0;
        case 'pages':
            return pages.pages[0]?.pageNumber ?? 0;
    }
}

export async function handleOcrCreateSearchablePdfAsync(
    context: IOcrManagerContext,
    sourcePdfPath: string,
    pages: TOcrPdfPageSelection,
    requestId: TRequestId,
    options: IOcrSearchablePdfOptions = {},
): Promise<IOcrQueueStartResult> {
    log.debug(`OCR requested: sourcePdfPath=${sourcePdfPath}, pages=${getOcrPageSelectionCount(pages)}, reqId=${requestId}, dpi=${options.renderDpi ?? 'default'}, profile=${options.qualityProfile ?? 'balanced'}, preprocessing=${options.preprocessingMode ?? 'off'}`);
    if (context.sender.isDestroyed()) {
        return createOcrQueueFailure(requestId, 'Renderer disconnected before OCR request could be queued');
    }
    try {
        const documentRevision = await getWorkingCopyRevision(sourcePdfPath, context.senderId);
        const projection = {
            supersessionPolicy: options.supersessionPolicy ?? 'missing-only',
            replaceAllAcknowledged: options.replaceAllAcknowledged === true,
        };
        // The renderer learns that the job started once its language models
        // are ready. A job that never gets there reports through this result
        // rather than through a completion event.
        const started = Promise.withResolvers<IOcrQueueStartResult>();
        const handle = ocrJobs.start({
            jobId: requestId,
            owner: toOcrActor(context),
            operation: {
                kind: 'abortable-work',
                workingCopyPath: sourcePdfPath,
            },
            ownerLifecycle: {
                destroyed: 'detach',
                renderProcessGone: 'detach',
                mainFrameNavigation: 'detach',
            },
            initialProgress: {
                requestId,
                currentPage: getFirstRequestedPage(pages),
                processedCount: 0,
                totalPages: getOcrPageSelectionCount(pages),
                phase: 'model-prep',
                projection,
            },
            run: async (registry) => {
                try {
                    await prepareLanguageModelsForJob(pages, registry.signal, OCR_MODEL_PREP_TIMEOUT_MS);
                } catch (error) {
                    started.resolve(createOcrQueueFailure(
                        requestId,
                        registry.signal.aborted ? 'OCR job was cancelled before it started' : getErrorMessage(error),
                    ));
                    throw error;
                }
                started.resolve({
                    started: true,
                    jobId: requireJobId(requestId),
                });
                const result = await runOcrJob({
                    jobId: requestId,
                    sourcePdfPath,
                    documentRevision,
                    pages,
                    options,
                    paths: await resolveOcrPipelinePaths(),
                    signal: registry.signal,
                    log: pipelineLog,
                    publish: progress => registry.publish({
                        requestId,
                        ...progress,
                        projection,
                    }),
                });
                if (!result.success && result.outcome === undefined) {
                    throw new OcrJobFailure(createOcrJobError(
                        result.errorEnvelope ?? buildOcrErrorEnvelope(
                            'OCR_INTERNAL_ERROR',
                            result.errors[0] ?? 'OCR failed without an error message',
                        ),
                        result.errors,
                        result.diagnostics,
                    ));
                }
                return {
                    result: result.success
                        ? {
                            ...result,
                            requestId,
                            pdfPath: result.pdfPath as TDocumentRef,
                        }
                        : {
                            ...result,
                            requestId,
                        },
                    documentKey: canonicalPathKey(documentRevision.documentRef),
                    staged: result.success
                        ? {
                            pdfPath: result.pdfPath,
                            pathKey: canonicalPathKey(result.pdfPath),
                            resultSha256: result.resultSha256,
                            sourceDocumentRevisionToken: result.sourceDocumentRevisionToken,
                        }
                        : null,
                };
            },
        });
        void handle.terminal.then(async (snapshot) => {
            started.resolve(createOcrQueueFailure(requestId, 'OCR job was cancelled before it started'));
            if ((await started.promise).started) {
                safeSendToWindow(getJobWindow(context.senderId), OCR_COMPLETE_EVENT_CHANNEL, toCompleteResult(snapshot));
            }
        });
        return await started.promise;
    } catch (error) {
        const message = getErrorMessage(error);
        log.error(`Failed to start OCR job: ${message}`, {
            code: 'MAIN_OCR_OPERATION_FAILED',
            cause: error,
        });
        return createOcrQueueFailure(
            requestId,
            message,
            isOcrErrorEnvelope(error) ? error.code : 'OCR_INTERNAL_ERROR',
        );
    }
}

type TStagedOcrResult = NonNullable<IOcrJobOutcome['staged']>;

function findStagedResults(predicate: (staged: TStagedOcrResult, snapshot: TOcrCompletedSnapshot) => boolean) {
    return ocrJobs.list().filter((snapshot): snapshot is TOcrCompletedSnapshot => (
        snapshot.status === 'completed'
        && snapshot.result.staged !== null
        && predicate(snapshot.result.staged, snapshot)
    ));
}

/**
 * The completed OCR job whose staged PDF may replace this working copy at
 * this revision. Any owner of the document may apply it: its tab can have
 * moved to another window since the job started.
 */
export function findOcrResultForDocument(
    pdfPath: string,
    documentRef: TDocumentRef,
    sourceDocumentRevisionToken: TDocumentRevisionToken,
) {
    const pathKey = canonicalPathKey(pdfPath);
    const documentKey = canonicalPathKey(documentRef);
    const [snapshot] = findStagedResults((staged, candidate) => (
        staged.pathKey === pathKey
        && candidate.result.documentKey === documentKey
        && staged.sourceDocumentRevisionToken === sourceDocumentRevisionToken
    ));
    return snapshot?.result.staged
        ? {
            requestId: requireRequestId(snapshot.jobId),
            resultSha256: snapshot.result.staged.resultSha256,
        }
        : null;
}

export async function discardOcrResultsForDocument(documentRef: TDocumentRef) {
    const documentKey = canonicalPathKey(documentRef);
    await Promise.all(findStagedResults((_staged, snapshot) => snapshot.result.documentKey === documentKey).map(removeResultFiles));
}

export async function handleOcrAcknowledgeResultFile(
    context: IOcrManagerContext,
    requestIdPayload: unknown,
    pdfPathPayload?: unknown,
    documentRefPayload?: unknown,
    sourceDocumentRevisionTokenPayload?: unknown,
): Promise<{
    cleaned: boolean;
    error?: string
}> {
    const requestId = typeof requestIdPayload === 'string'
        ? parseRequestId(requestIdPayload)
        : null;
    if (requestId === null) {
        return {
            cleaned: false,
            error: 'requestId must be a non-empty string',
        };
    }
    const documentRef = documentRefPayload === undefined ? undefined : parseDocumentRef(documentRefPayload);
    const sourceDocumentRevisionToken = sourceDocumentRevisionTokenPayload === undefined
        ? undefined
        : parseDocumentRevisionToken(sourceDocumentRevisionTokenPayload);
    if (documentRefPayload !== undefined && documentRef === null) {
        return {
            cleaned: false,
            error: 'documentRef must be an absolute document path',
        };
    }
    if (sourceDocumentRevisionTokenPayload !== undefined && sourceDocumentRevisionToken === null) {
        return {
            cleaned: false,
            error: 'sourceDocumentRevisionToken must be a non-empty string',
        };
    }
    if (documentRef && sourceDocumentRevisionToken && !getWorkingCopyBackingEntry(documentRef, context.senderId)) {
        return {
            cleaned: false,
            error: 'Document owner is not authorized to discard this OCR result',
        };
    }
    // The job's own renderer, or the current owner of its document.
    const owned = ocrJobs.get(requestId, toOcrActor(context));
    const snapshot = owned?.status === 'completed' && owned.result.staged
        ? owned
        : documentRef && sourceDocumentRevisionToken
            ? findStagedResults((staged, candidate) => (
                candidate.jobId === requestId
                && candidate.result.documentKey === canonicalPathKey(documentRef)
                && staged.sourceDocumentRevisionToken === sourceDocumentRevisionToken
            ))[0]
            : undefined;
    if (!snapshot?.result.staged) {
        return {
            cleaned: false,
            error: `No pending OCR result file for requestId "${requestId}"`,
        };
    }
    if (
        typeof pdfPathPayload === 'string'
        && pdfPathPayload.trim().length > 0
        && canonicalPathKey(pdfPathPayload) !== snapshot.result.staged.pathKey
    ) {
        return {
            cleaned: false,
            error: 'Acknowledged OCR result path does not match pending result path',
        };
    }
    if (!await removeResultFiles(snapshot)) {
        return {
            cleaned: false,
            error: 'Failed to delete pending OCR result file',
        };
    }
    return {cleaned: true};
}

export function handleOcrCancel(
    context: IOcrManagerContext,
    requestId: TRequestId,
): IOcrCancelResult {
    log.info(`[${requestId}] Cancel requested`);
    if (ocrJobs.cancel(requestId, toOcrActor(context), 'explicit cancel request')) {
        return {canceled: true};
    }
    return {
        canceled: false,
        reason: 'not-found',
    };
}

export function cancelOcrJobsForWorkingCopy(workingCopyPath: string, reason: string) {
    const pathKey = normalizePathForLookup(workingCopyPath) || workingCopyPath;
    return ocrJobs.cancelWhere(snapshot => (
        snapshot.workingCopyPath !== undefined
        && (normalizePathForLookup(snapshot.workingCopyPath) || snapshot.workingCopyPath) === pathKey
    ), reason);
}

/** Stops running jobs after repeated failures; finished results stay applicable. */
export function recoverOcrJobManager() {
    ocrJobs.cancelWhere(() => true, 'OCR job manager recovery');
    return Promise.resolve();
}

export function shutdownOcrJobManager() {
    return ocrJobs.dispose();
}

function toOcrJobPhase(phase: string | undefined): TOcrJobProjectionPhase {
    return phase === 'queued'
        || phase === 'recognizing'
        || phase === 'applying'
        || phase === 'cancel-requested'
        || phase === 'preparing'
        || phase === 'model-prep'
        || phase === 'pdf-prep'
        || phase === 'dpi-inspection'
        || phase === 'page-size-probing'
        || phase === 'processing'
        || phase === 'merging'
        || phase === 'indexing'
        ? phase
        : 'recognizing';
}

function projectOcrJob(snapshot: TOcrJobSnapshot): IOcrJobProjectionState {
    const progress = snapshot.progress;
    const percent = progress.phaseProgress
        ?? (progress.totalPages > 0 ? (progress.processedCount / progress.totalPages) * 100 : 0);
    return {
        jobId: requireJobId(`${snapshot.owner.webContentsId}:${snapshot.jobId}`),
        requestId: requireRequestId(snapshot.jobId),
        status: snapshot.status === 'canceling' || snapshot.status === 'committing'
            ? 'running'
            : snapshot.status,
        phase: snapshot.status === 'canceling'
            ? 'cancel-requested'
            : toOcrJobPhase(progress.phase),
        percent,
        current: progress.processedCount,
        total: progress.totalPages,
        ...(progress.error ? {error: progress.error} : {}),
        updatedAtMs: snapshot.updatedAtMs,
        ...progress.projection,
    };
}

export function getOcrJobProjection(context: IOcrManagerContext, requestId: TRequestId) {
    const snapshot = ocrJobs.get(requestId, toOcrActor(context));
    return snapshot ? projectOcrJob(snapshot) : null;
}

export function subscribeOcrJobProjection(
    context: IOcrManagerContext,
    requestId: TRequestId,
    listener: (state: IOcrJobProjectionState) => void,
) {
    return ocrJobs.subscribe(
        requestId,
        toOcrActor(context),
        snapshot => listener(projectOcrJob(snapshot)),
    ) ?? (() => {});
}

export function subscribeManagedOcrProgress(context: IOcrManagerContext) {
    return ocrJobs.subscribeOwner(toOcrActor(context));
}
