import {
    app,
    BrowserWindow,
    type WebContents,
} from 'electron';
import { randomUUID } from 'node:crypto';
import type { Worker } from 'worker_threads';
import { uniq } from 'es-toolkit/array';
import {
    mkdtemp,
    open,
    rm,
    stat,
    statfs,
} from 'fs/promises';
import {
    basename,
    dirname,
    join,
    parse,
} from 'path';
import type { IPdfBookmarkEntry } from '@contracts/pdfBookmarkEntry';
import {syncFileHandleForDurability} from '@electron/utils/syncFileHandleForDurability';
import type {
    IDjvuConvertOptions,
    IDjvuConvertResult,
    IDjvuOpenResult,
    IDjvuPrintOptions,
    IDjvuPrintResult,
    IDjvuProgress,
    TDocumentOutputJobState,
    TDocumentOutputOperation,
} from '@contracts/electronApiDjvu';
import {
    parseDocumentRef,
    type TDocumentRef,
} from '@contracts/documentRef';
import {
    decodeFailureReceipt,
    isExpectedOutcome,
    type ExpectedOutcome,
    type ExpectedOutcomeCode,
    type FailureReceipt,
} from '@contracts/diagnostics/failureReceipt';
import { DJVU_PLATFORM_FEATURE } from '@contracts/djvuPlatformFeature';
import type { IPlatformMainSenderContext } from '@contracts/platformFeature';
import {
    cancelConversion,
    convertDjvuToPdfFile,
    withDjvuNativeResourceLease,
} from '@electron/features/djvu/main/ddjvuConversion';
import { buildCompactDjvuAwarePdfFromDjvu } from '@electron/features/djvu/main/buildCompactDjvuAwarePdfFromDjvu';
import {
    getDjvuOutline,
    getDjvuPageCount,
    getDjvuResolution,
} from '@electron/features/djvu/main/metadata';
import { parseDjvuOutline } from '@electron/features/djvu/main/parseDjvuOutline';
import {
    evaluateDjvuPdfConversionPolicy,
    resolveDjvuCompactFidelityPreset,
    resolveDjvuPdfExportStrategy,
    type IDjvuConversionPageMetrics,
    type IDjvuPdfConversionPolicyDecision,
    type TDjvuPdfExportStrategy,
} from '@contracts/djvuConversionPolicy';
import {isPdfCombineOutputTooLargeError} from '@contracts/pdfCombineOutputPolicy';
import { createLogger } from '@electron/utils/createLogger';
import { measureElectronPerfAsync } from '@electron/utils/measureElectronPerfAsync';
import { safeSendToWindow } from '@electron/features/djvu/main/safeSendToWindow';
import { embedBookmarksIntoPdfFile } from '@electron/features/djvu/main/embedBookmarksIntoPdfFile';
import { consumeAllowedDjvuWritePath } from '@electron/features/djvu/main/exportPaths';
import { allowOpenPath } from '@electron/file-access/openPathCapabilities';
import type { TOpenPath } from '@electron/file-access/openPathCapabilities';
import {
    atomicReplace,
    makeSiblingTempPath,
} from '@electron/utils/atomicReplace';
import {
    createDjvuPdfBookmarkTask,
    DjvuPdfWorkerStartupError,
} from '@electron/features/djvu/main/pdfWorkerClient';
import {getWorkerTaskFailureReceipt} from '@electron/utils/workerTask';
import {PdfCombineCapabilityError} from '@electron/image/pdfCombineErrors';
import { getErrorMessage } from '@electron/utils/error';
import {
    abortErrorFromSignal,
    createAbortError,
} from '@electron/utils/abort';
import { optimizeGeneratedPdfForInteraction } from '@electron/features/documents/public/pdfSaveAsOptimization';
import {
    PRINT_DJVU_TEMP_PREFIX,
    printManagedTempPdfPath,
} from '@electron/utils/printHandoff';
import { getAppTempDir } from '@electron/utils/appTempDir';
import {
    DJVU_PAGE_SIZE_ARRAY_MAX_PAGES,
    getDjvuPageSizesForViewing,
} from '@electron/features/djvu/main/pagePreview';
import {
    normalizePrintPageNumbers,
} from '@pdf-core';
import { buildPrintablePdfPath } from '@electron/features/documents/main/buildPrintablePdfPath';
import { normalizeOptionalIpcRequestId } from '@electron/utils/ipcLimits';
import {
    createMainJobRegistry,
    type IMainJobErrorEnvelope,
    type IMainJobRunContext,
    type TMainJobSnapshot,
} from '@electron/operation-lifecycle/createMainJobRegistry';
import { mainJobBroker } from '@electron/resources/jobBroker';
import {adoptDjvuViewingPath} from '@electron/features/djvu/main/viewing';
import {
    parseRequestId,
    requireJobId,
    type TJobId,
} from '@contracts/shared';
import {requireEpochMs} from '@contracts/timestamps';

const logger = createLogger('djvu-pdfExport');
interface IDjvuOperationContext extends IPlatformMainSenderContext<WebContents> {}
const activePdfWorkerByJobId = new Map<TJobId, Worker>();
const activeNativeJobCancels = new Map<TJobId, (reason: string) => boolean>();
const activeDjvuJobSettled = new Map<TJobId, Promise<void>>();
const DJVU_TERMINAL_RECORD_RETENTION_MS = 60 * 60 * 1_000;
const DJVU_MAX_TERMINAL_RECORDS = 64;
const djvuProgressReplay = DJVU_PLATFORM_FEATURE.events.onProgress.subscription.replay;
const DJVU_SUBSAMPLE_MAX = (() => {
    const parsed = Number.parseInt(process.env.EVB_DJVU_SUBSAMPLE_MAX ?? '16', 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
        return 16;
    }
    return Math.min(parsed, 64);
})();
const DJVU_CONVERT_PROGRESS_CAP = 94;
const DJVU_BOOKMARK_PROGRESS_PERCENT = 95;
const DJVU_OPTIMIZE_PROGRESS_PERCENT = 98;

function scaleDjvuConversionProgress(percent: number) {
    if (!Number.isFinite(percent)) {
        return 0;
    }
    return Math.max(0, Math.min(
        DJVU_CONVERT_PROGRESS_CAP,
        Math.round((percent / 100) * DJVU_CONVERT_PROGRESS_CAP),
    ));
}

function resolveSubsample(rawSubsample: number | undefined) {
    if (rawSubsample === undefined) {
        return 1;
    }
    if (!Number.isFinite(rawSubsample)) {
        throw new Error('Invalid DjVu subsample value');
    }
    const subsample = Math.floor(rawSubsample);
    if (subsample < 1 || subsample > DJVU_SUBSAMPLE_MAX) {
        throw new Error(`Invalid DjVu subsample value (expected 1-${DJVU_SUBSAMPLE_MAX})`);
    }
    return subsample;
}

function throwIfCanceled(signal: AbortSignal) {
    if (signal.aborted) throw abortErrorFromSignal(signal);
}

async function runDjvuConversionJobWithSlot<T>(
    jobId: TJobId,
    signal: AbortSignal,
    run: () => Promise<T>,
): Promise<T> {
    throwIfCanceled(signal);
    const lease = await mainJobBroker.acquire({
        ownerId: jobId,
        kind: 'djvu-output',
        priority: 'user',
        perOwnerLimit: 1,
        resources: {
            cpuTokens: 0,
            estimatedResidentBytes: 0,
            nativeProcesses: 0,
            ioWeight: 0,
        },
        signal,
    });
    try {
        throwIfCanceled(signal);
        return await run();
    } finally {
        lease.release();
    }
}

function runDjvuMetadataWithSlot<T>(jobId: TJobId, signal: AbortSignal, run: () => Promise<T>) {
    return withDjvuNativeResourceLease({
        jobId,
        kind: 'metadata',
        signal,
        task: run,
    });
}

async function requestDjvuNativeCancel(jobId: TJobId) {
    mainJobBroker.cancelOwner(jobId, 'DjVu conversion canceled');
    await cancelConversion(jobId);
}

function setActivePdfWorker(jobId: TJobId, worker: Worker) {
    activePdfWorkerByJobId.set(jobId, worker);
}

function clearActivePdfWorker(jobId: TJobId, worker: Worker) {
    if (activePdfWorkerByJobId.get(jobId) === worker) {
        activePdfWorkerByJobId.delete(jobId);
    }
}

function formatEffectivePixels(pixels: number) {
    if (pixels >= 1_000_000_000) {
        return `${(pixels / 1_000_000_000).toFixed(1)}B`;
    }
    if (pixels >= 1_000_000) {
        return `${Math.round(pixels / 1_000_000)}M`;
    }
    return String(Math.max(0, Math.round(pixels)));
}

function describeRecommendedSubsample(subsample: number) {
    if (subsample <= 1) {
        return 'Full Quality';
    }
    if (subsample === 2) {
        return 'Good Quality';
    }
    if (subsample === 4) {
        return 'Compact';
    }
    return `subsample ${subsample}`;
}

function createDjvuConversionPolicyError(decision: IDjvuPdfConversionPolicyDecision) {
    return `Selected DjVu PDF quality is blocked because direct conversion would preserve about ${
        formatEffectivePixels(decision.effectivePixels)
    } effective pixels. Choose ${describeRecommendedSubsample(decision.recommendedSubsample)} or higher.`;
}

function resolveDjvuPrintPdfExportStrategy(strategy: TDjvuPdfExportStrategy | undefined) {
    return strategy === 'direct' ? 'direct' : 'compact-djvu-aware';
}

function resolveDjvuPrintJobId(requestId: unknown): TJobId {
    const normalizedRequestId = normalizeOptionalIpcRequestId(requestId);
    return requireJobId(`djvu-print-${normalizedRequestId ?? randomUUID()}`);
}

function resolveDjvuPrintPages(pageNumbers: number[] | undefined, pageCount: number) {
    if (!pageNumbers || pageNumbers.length === 0) {
        return undefined;
    }
    return normalizePrintPageNumbers(pageNumbers, pageCount);
}

function formatDjvuPageSelection(pages: number[]) {
    const ranges: string[] = [];
    let rangeStart: number | null = null;
    let previousPage: number | null = null;

    for (const page of pages) {
        if (rangeStart === null || previousPage === null) {
            rangeStart = page;
            previousPage = page;
            continue;
        }

        if (page === previousPage + 1) {
            previousPage = page;
            continue;
        }

        ranges.push(rangeStart === previousPage ? String(rangeStart) : `${rangeStart}-${previousPage}`);
        rangeStart = page;
        previousPage = page;
    }

    if (rangeStart !== null && previousPage !== null) {
        ranges.push(rangeStart === previousPage ? String(rangeStart) : `${rangeStart}-${previousPage}`);
    }

    return ranges.join(',');
}

function resolveDjvuPrintDocumentTitle(
    djvuPath: string,
    fileName: string | undefined,
    selectedPages: number[] | undefined,
) {
    const rawName = typeof fileName === 'string' && fileName.trim()
        ? fileName.trim()
        : djvuPath;
    const baseName = basename(rawName) || 'document';
    const title = parse(baseName).name || baseName || 'document';
    if (!selectedPages || selectedPages.length === 0) {
        return title;
    }

    return `${title} p${formatDjvuPageSelection(selectedPages)}`;
}

async function getDjvuConversionPageSizes(
    jobId: TJobId,
    djvuPath: string,
    pageCount: number,
    signal: AbortSignal,
) {
    if (pageCount > DJVU_PAGE_SIZE_ARRAY_MAX_PAGES) {
        logger.debug(
            `[${jobId}] Skipping dense DjVu page-size metadata for ${pageCount} pages; conversion policy will use bounded fallback metrics`,
        );
        return null;
    }

    try {
        const pageSizes: IDjvuConversionPageMetrics[] = await getDjvuPageSizesForViewing(djvuPath, pageCount, { signal });
        return pageSizes;
    } catch (error) {
        if (signal.aborted) {
            throw signal.reason instanceof Error
                ? signal.reason
                : createAbortError('DjVu conversion canceled');
        }
        logger.debug(`[${jobId}] Failed to read DjVu page sizes before conversion policy check: ${getErrorMessage(error)}`);
        return null;
    }
}

async function assertDjvuExportDiskSpace(sourcePath: string, targetPath: string) {
    const [
        source,
        fileSystem,
    ] = await Promise.all([
        stat(sourcePath),
        statfs(dirname(targetPath)),
    ]);
    const availableBytes = fileSystem.bavail * fileSystem.bsize;
    const requiredBytes = Math.max(128 * 1024 * 1024, source.size * 4);
    if (availableBytes < requiredBytes) {
        throw new Error(
            `Not enough disk space for DjVu export: ${requiredBytes} bytes required, ${availableBytes} available`,
        );
    }
}

async function copyFileCancellable(sourcePath: string, targetPath: string, signal: AbortSignal) {
    const source = await open(sourcePath, 'r');
    const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
    let position = 0;
    let target: Awaited<ReturnType<typeof open>> | null = null;
    try {
        target = await open(targetPath, 'wx');
        for (;;) {
            if (signal.aborted) throw abortErrorFromSignal(signal);
            const {bytesRead} = await source.read(buffer, 0, buffer.byteLength, position);
            if (bytesRead === 0) break;
            let bytesWritten = 0;
            while (bytesWritten < bytesRead) {
                if (signal.aborted) throw abortErrorFromSignal(signal);
                const writeResult = await target.write(
                    buffer,
                    bytesWritten,
                    bytesRead - bytesWritten,
                    position + bytesWritten,
                );
                if (!Number.isInteger(writeResult.bytesWritten)
                    || writeResult.bytesWritten <= 0
                    || writeResult.bytesWritten > bytesRead - bytesWritten) {
                    throw new Error(`DjVu export write made invalid progress: ${writeResult.bytesWritten}`);
                }
                bytesWritten += writeResult.bytesWritten;
            }
            position += bytesRead;
        }
        await syncFileHandleForDurability(target);
    } finally {
        await Promise.allSettled([
            source.close(),
            target?.close(),
        ]);
    }
}

async function replaceFileAtomically(sourcePath: string, targetPath: string, signal: AbortSignal) {
    const stagedPath = makeSiblingTempPath(targetPath);
    let replaced = false;
    try {
        await copyFileCancellable(sourcePath, stagedPath, signal);
        if (signal.aborted) throw abortErrorFromSignal(signal);
        await atomicReplace(stagedPath, targetPath);
        replaced = true;
    } finally {
        if (!replaced) {
            await rm(stagedPath, { force: true }).catch(() => undefined);
        }
    }
}

type TDjvuProgressScope = Pick<IDjvuProgress, 'documentRef' | 'requestId'>;
type TDjvuPublicJobResult = IDjvuConvertResult | IDjvuOpenResult | IDjvuPrintResult;
type TDjvuJobError = IMainJobErrorEnvelope<'canceled' | 'failed' | 'duplicate-job-id' | 'not-found-or-unauthorized'> & {
    failure?: FailureReceipt;
    expected?: ExpectedOutcome;
};
type TDjvuJobSnapshot = TMainJobSnapshot<IDjvuProgress, TDjvuPublicJobResult, TDjvuJobError>;
type TDjvuRegistryContext = IMainJobRunContext<IDjvuProgress, TDjvuPublicJobResult, TDjvuJobError>;
interface IDjvuJobRunContext {
    signal: AbortSignal;
    publish: TDjvuRegistryContext['publish'];
    handoff: (artifactPath: TDocumentRef, progress?: IDjvuProgress) => void;
}

function isDjvuCancellationError(error: unknown) {
    return getErrorMessage(error).trim().toLowerCase() === 'djvu conversion canceled';
}

function createDjvuExpectedOutcome(code: ExpectedOutcomeCode): ExpectedOutcome {
    return {
        kind: 'expected',
        code,
    };
}

function getDjvuFailureReceipt(value: unknown) {
    if (value instanceof Error) {
        const workerFailure = getWorkerTaskFailureReceipt(value);
        if (workerFailure !== undefined) {
            return workerFailure;
        }
    }
    if (typeof value !== 'object' || value === null || !('failure' in value)) {
        return undefined;
    }
    return decodeFailureReceipt(value.failure) ?? undefined;
}

function getDjvuExpectedOutcome(value: unknown) {
    if (typeof value !== 'object' || value === null || !('expected' in value)) {
        return undefined;
    }
    return isExpectedOutcome(value.expected) ? value.expected : undefined;
}

function classifyDjvuConversionExpectedOutcome(error: unknown): ExpectedOutcome | undefined {
    if (isDjvuCancellationError(error)) {
        return createDjvuExpectedOutcome('canceled');
    }

    if (error instanceof PdfCombineCapabilityError && error.code === 'native-unavailable') {
        return createDjvuExpectedOutcome('temporarily-unavailable');
    }

    if (isPdfCombineOutputTooLargeError(error)) {
        return createDjvuExpectedOutcome('validation-rejected');
    }
    return undefined;
}

function getOptionalResultError(value: unknown) {
    if (typeof value !== 'object' || value === null || !('error' in value)) {
        return undefined;
    }
    const errorValue = (value as { error?: unknown }).error;
    return typeof errorValue === 'string' ? errorValue : undefined;
}

function createDjvuProgressScope(requestId: unknown, documentRef: unknown): TDjvuProgressScope {
    const normalizedRequestId = parseRequestId(normalizeOptionalIpcRequestId(requestId));
    const normalizedDocumentRef = parseDocumentRef(documentRef);
    return {
        ...(normalizedRequestId ? { requestId: normalizedRequestId } : {}),
        ...(normalizedDocumentRef
            ? { documentRef: normalizedDocumentRef }
            : {}),
    };
}

function requireDocumentRef(value: unknown): TDocumentRef {
    const documentRef = parseDocumentRef(value);
    if (documentRef === null) {
        throw new Error('Expected an absolute path or browser document ref');
    }
    return documentRef;
}

function getDjvuOperation(jobId: TJobId): TDocumentOutputOperation {
    if (jobId.startsWith('djvu-print-')) {
        return 'djvu-print';
    }
    if (jobId.startsWith('djvu-open-')) {
        return 'djvu-open';
    }
    return 'djvu-convert';
}

const djvuJobs = createMainJobRegistry<IDjvuProgress, TDjvuPublicJobResult, TDjvuJobError>({
    retention: {
        eventReplayTtlMs: djvuProgressReplay.terminalRetentionMs,
        terminalRecordTtlMs: DJVU_TERMINAL_RECORD_RETENTION_MS,
        maxTerminalRecords: DJVU_MAX_TERMINAL_RECORDS,
    },
    progress: {
        channel: DJVU_PLATFORM_FEATURE.eventChannels.onProgress,
        intervalMs: djvuProgressReplay.intervalMs,
        getEventKey: djvuProgressReplay.key,
        send: (sender, _channel, progress) => {
            safeSendToWindow(
                BrowserWindow.fromWebContents(sender),
                DJVU_PLATFORM_FEATURE.eventChannels.onProgress,
                progress,
            );
        },
    },
    toError: (cause, kind) => {
        const expected = kind === 'canceled'
            ? createDjvuExpectedOutcome('canceled')
            : getDjvuExpectedOutcome(cause);
        const failure = kind === 'canceled' || expected !== undefined
            ? undefined
            : getDjvuFailureReceipt(cause);
        return {
            code: kind === 'canceled' ? 'canceled' : kind,
            message: cause instanceof Error ? getErrorMessage(cause) : getOptionalResultError(cause) ?? 'DjVu operation failed',
            ...(failure === undefined ? {} : {failure}),
            ...(expected === undefined ? {} : {expected}),
        };
    },
    terminalProgress: {
        completed: (latest, result) => result.success
            ? {
                ...latest,
                percent: 100,
                status: 'success',
            }
            : getDjvuExpectedOutcome(result)?.code === 'canceled'
                ? {
                    ...latest,
                    percent: 100,
                    status: 'canceled',
                    error: result.error ?? 'DjVu operation canceled',
                }
                : {
                    ...latest,
                    percent: 100,
                    status: 'failed',
                    error: result.error ?? 'DjVu operation failed',
                },
        canceled: (latest, error) => ({
            ...latest,
            percent: 100,
            status: 'canceled',
            error: error.message,
        }),
        failed: (latest, error) => ({
            ...latest,
            percent: 100,
            status: 'failed',
            error: error.message,
        }),
    },
});

function projectDjvuJob(snapshot: TDjvuJobSnapshot): TDocumentOutputJobState {
    const jobId = requireJobId(snapshot.jobId);
    const base = {
        jobId,
        operation: getDjvuOperation(jobId),
        progress: snapshot.progress,
        updatedAtMs: requireEpochMs(snapshot.updatedAtMs),
    };
    const handoffPath = snapshot.status === 'handoff' || snapshot.status === 'completed'
        ? snapshot.handoffResult && 'pdfPath' in snapshot.handoffResult
            ? snapshot.handoffResult.pdfPath
            : undefined
        : undefined;
    if (snapshot.status === 'handoff' && handoffPath) {
        return {
            ...base,
            status: 'handoff',
            artifactPath: handoffPath,
        };
    }
    if (snapshot.progress.status === 'canceled' || snapshot.status === 'canceled') {
        const resultFailure = snapshot.status === 'completed'
            ? getDjvuFailureReceipt(snapshot.result)
            : undefined;
        const resultExpected = snapshot.status === 'completed'
            ? getDjvuExpectedOutcome(snapshot.result)
            : undefined;
        const expected = snapshot.status === 'canceled'
            ? snapshot.error.expected
            : resultExpected;
        const failure = expected !== undefined
            ? undefined
            : snapshot.status === 'canceled'
                ? snapshot.error.failure
                : resultFailure;
        return {
            ...base,
            status: 'canceled',
            ...(snapshot.progress.error ? {error: snapshot.progress.error} : {}),
            ...(failure === undefined ? {} : {failure}),
            ...(expected === undefined ? {} : {expected}),
        };
    }
    if (snapshot.progress.status === 'failed' || snapshot.status === 'failed') {
        const resultFailure = snapshot.status === 'completed'
            ? getDjvuFailureReceipt(snapshot.result)
            : undefined;
        const resultExpected = snapshot.status === 'completed'
            ? getDjvuExpectedOutcome(snapshot.result)
            : undefined;
        const expected = snapshot.status === 'failed'
            ? snapshot.error.expected
            : resultExpected;
        const failure = expected !== undefined
            ? undefined
            : snapshot.status === 'failed'
                ? snapshot.error.failure
                : resultFailure;
        return {
            ...base,
            status: 'failed',
            ...(snapshot.progress.error ? {error: snapshot.progress.error} : {}),
            ...(failure === undefined ? {} : {failure}),
            ...(expected === undefined ? {} : {expected}),
        };
    }
    if (snapshot.progress.status === 'success' || snapshot.status === 'completed') {
        return {
            ...base,
            status: 'completed',
            ...(handoffPath ? {artifactPath: handoffPath} : {}),
        };
    }
    return {
        ...base,
        status: snapshot.status === 'queued' ? 'queued' : 'running',
    };
}

function startDjvuJob(
    context: IDjvuOperationContext,
    options: {
        jobId: TJobId;
        workingCopyPath: string;
        initialProgress: IDjvuProgress;
        durable?: boolean;
        nativeCancellation?: boolean;
        run: (job: IDjvuJobRunContext) => Promise<TDjvuPublicJobResult>;
    },
) {
    const handle = djvuJobs.start({
        jobId: options.jobId,
        owner: {sender: context.sender},
        operation: {
            kind: 'abortable-work',
            workingCopyPath: options.workingCopyPath,
        },
        initialProgress: options.initialProgress,
        duplicate: options.durable ? 'join' : 'reject',
        ownerLifecycle: options.durable
            ? {
                destroyed: 'detach',
                renderProcessGone: 'detach',
                mainFrameNavigation: 'detach',
            }
            : {
                destroyed: 'cancel',
                renderProcessGone: 'cancel',
                mainFrameNavigation: 'cancel',
            },
        ...(options.nativeCancellation ? {onCancel: () => requestDjvuNativeCancel(options.jobId)} : {}),
        run: job => options.run({
            signal: job.signal,
            publish: job.publish,
            handoff: (path, progress) => job.handoff({
                success: true,
                jobId: options.jobId,
                pdfPath: requireDocumentRef(path),
            }, progress),
        }),
    });
    if (options.nativeCancellation) {
        activeNativeJobCancels.set(options.jobId, reason => handle.cancel(reason));
        void handle.settled.finally(() => {
            activeNativeJobCancels.delete(options.jobId);
        });
    }
    activeDjvuJobSettled.set(options.jobId, handle.settled);
    void handle.settled.finally(() => {
        activeDjvuJobSettled.delete(options.jobId);
    });
    return handle;
}

async function awaitDjvuJob(
    context: IDjvuOperationContext,
    jobId: TJobId,
    kind: 'convert' | 'open',
) {
    let terminal;
    try {
        terminal = await djvuJobs.await(jobId, {sender: context.sender});
    } catch {
        throw new Error(`Unknown or expired DjVu ${kind === 'open' ? 'open' : 'conversion'} job: ${jobId}`);
    }
    if (terminal.status === 'completed') {
        return terminal.result;
    }
    const baseResult = {
        success: false,
        jobId,
        ...(terminal.progress.requestId ? {requestId: terminal.progress.requestId} : {}),
        ...(terminal.progress.documentRef ? {documentRef: terminal.progress.documentRef} : {}),
        error: terminal.error.message,
    };
    if (kind === 'convert') {
        return {
            ...baseResult,
            ...(terminal.error.failure === undefined ? {} : {failure: terminal.error.failure}),
            ...(terminal.error.expected === undefined ? {} : {expected: terminal.error.expected}),
        } satisfies IDjvuConvertResult;
    }
    return baseResult satisfies IDjvuOpenResult;
}

export function subscribeDjvuProgress(context: IDjvuOperationContext) {
    djvuJobs.subscribeOwner({sender: context.sender});
}

export function getDjvuOutputJobState(context: IDjvuOperationContext, jobId: TJobId) {
    const snapshot = djvuJobs.get(jobId, {sender: context.sender});
    return snapshot ? projectDjvuJob(snapshot) : null;
}

export function subscribeDjvuOutputJob(context: IDjvuOperationContext, jobId: TJobId) {
    const unsubscribe = djvuJobs.subscribe(jobId, {sender: context.sender}, (snapshot) => {
        safeSendToWindow(
            BrowserWindow.fromWebContents(context.sender),
            DJVU_PLATFORM_FEATURE.eventChannels.onProgress,
            snapshot.progress,
        );
    });
    return unsubscribe
        ? getDjvuOutputJobState(context, jobId)
        : null;
}

async function embedPdfBookmarks(
    jobId: TJobId,
    inputPdfPath: string,
    outputPdfPath: string,
    bookmarks: IPdfBookmarkEntry[],
    signal: AbortSignal,
) {
    if (bookmarks.length === 0) {
        return;
    }

    return measureElectronPerfAsync('djvu:embed-bookmarks', async () => {
        try {
            const task = createDjvuPdfBookmarkTask(inputPdfPath, outputPdfPath, bookmarks, { signal });
            setActivePdfWorker(jobId, task.worker);
            try {
                await task.promise;
                return;
            } catch (error) {
                if (signal.aborted) throw abortErrorFromSignal(signal);
                throw error;
            } finally {
                clearActivePdfWorker(jobId, task.worker);
            }
        } catch (error) {
            if (!(error instanceof DjvuPdfWorkerStartupError)) {
                throw error;
            }
            if (signal.aborted) {
                throw signal.reason instanceof Error
                    ? signal.reason
                    : createAbortError('DjVu conversion canceled');
            }

            logger.warn(`[${jobId}] DjVu PDF worker unavailable, using path-backed native bookmark embedding: ${error.message}`);
            await embedBookmarksIntoPdfFile(inputPdfPath, outputPdfPath, bookmarks, signal);
        }
    }, {
        thresholdMs: 25,
        details: {
            jobId,
            bookmarkCount: bookmarks.length,
        },
    });
}

async function runDjvuPrintPath(
    context: IDjvuOperationContext,
    djvuPath: TOpenPath,
    options: IDjvuPrintOptions,
    jobId: TJobId,
    progressScope: TDjvuProgressScope,
    job: IDjvuJobRunContext,
): Promise<IDjvuPrintResult> {
    const tempDir = await mkdtemp(join(getAppTempDir(), 'djvu-print-work-'));
    const finalPdfPath = join(getAppTempDir(), `${PRINT_DJVU_TEMP_PREFIX}${jobId}.pdf`);
    const composedPdfPath = join(getAppTempDir(), `${PRINT_DJVU_TEMP_PREFIX}${jobId}-layout.pdf`);
    let finalPdfHandedToPrint = false as boolean;
    const requiresPrintLayout = options.viewMode !== 'single' || options.orientation !== 'auto';

    logger.info(`[${jobId}] Preparing DjVu for print: ${djvuPath}`);
    const sendProgress = (progress: IDjvuProgress) => {
        const scopedProgress = {
            ...progress,
            ...progressScope,
        };
        job.publish(scopedProgress);
    };
    sendProgress({
        jobId,
        phase: 'converting' as const,
        percent: 0,
    });

    try {
        const result = await runDjvuConversionJobWithSlot(jobId, job.signal, async () => {
            const [
                pageCount,
                sourceDpi,
            ] = await Promise.all([
                runDjvuMetadataWithSlot(jobId, job.signal, () => getDjvuPageCount(djvuPath, { signal: job.signal })),
                runDjvuMetadataWithSlot(jobId, job.signal, () => getDjvuResolution(djvuPath, { signal: job.signal })),
            ]);
            throwIfCanceled(job.signal);

            const selectedPages = resolveDjvuPrintPages(options.pageNumbers, pageCount);
            if (selectedPages && selectedPages.length === 0) {
                return {
                    success: false,
                    jobId,
                    error: 'No printable DjVu pages selected',
                };
            }

            // A selected print job only needs metadata for the selected output
            // pages. The compact builder resolves those pages directly, and
            // the legacy converter falls back to bounded page-count metrics.
            // Do not scan a full document into a dense page-size array first.
            const pageSizes = selectedPages
                ? null
                : await runDjvuMetadataWithSlot(jobId, job.signal, () => getDjvuConversionPageSizes(jobId, djvuPath, pageCount, job.signal));
            throwIfCanceled(job.signal);

            const convertedPdfPath = finalPdfPath;
            const strategy = resolveDjvuPrintPdfExportStrategy(options.pdfStrategy);
            const convertResult = strategy === 'compact-djvu-aware'
                ? await buildCompactDjvuAwarePdfFromDjvu({
                    jobId,
                    djvuPath,
                    outputPath: convertedPdfPath,
                    tempDir,
                    pageCount,
                    sourceDpi,
                    pageSizes,
                    qualityPreset: resolveDjvuCompactFidelityPreset(options.subsample),
                    signal: job.signal,
                    ...(selectedPages ? { pages: selectedPages } : {}),
                    onProgress: (percent: number) => {
                        sendProgress({
                            jobId,
                            phase: 'converting' as const,
                            percent,
                        });
                    },
                })
                : await (async () => {
                    const subsample = resolveSubsample(options.subsample);
                    const policy = evaluateDjvuPdfConversionPolicy({
                        pageCount: selectedPages?.length ?? pageCount,
                        sourceDpi,
                        pageSizes,
                    }, subsample);
                    if (!policy.isAllowed) {
                        return {
                            success: false as const,
                            outputPath: convertedPdfPath,
                            fileSize: 0,
                            error: createDjvuConversionPolicyError(policy),
                        };
                    }

                    return convertDjvuToPdfFile(djvuPath, convertedPdfPath, jobId, {
                        ...(subsample > 1 ? { subsample } : {}),
                        ...(selectedPages ? { pages: formatDjvuPageSelection(selectedPages) } : {}),
                        pageCount,
                        signal: job.signal,
                        onProgress: (percent: number) => {
                            sendProgress({
                                jobId,
                                phase: 'converting' as const,
                                percent: scaleDjvuConversionProgress(percent),
                            });
                        },
                    });
                })();

            if (!convertResult.success) {
                return {
                    success: false,
                    jobId,
                    error: convertResult.error ?? 'DjVu print preparation failed',
                };
            }
            throwIfCanceled(job.signal);

            sendProgress({
                jobId,
                phase: 'optimizing' as const,
                percent: DJVU_OPTIMIZE_PROGRESS_PERCENT,
            });
            await optimizeGeneratedPdfForInteraction(convertedPdfPath, { signal: job.signal });
            throwIfCanceled(job.signal);
            const printablePdfPath = requiresPrintLayout
                ? composedPdfPath
                : convertedPdfPath;
            if (requiresPrintLayout) {
                await buildPrintablePdfPath({
                    inputPath: convertedPdfPath,
                    outputPath: composedPdfPath,
                    printOptions: {
                        viewMode: options.viewMode,
                        orientation: options.orientation,
                    },
                    signal: job.signal,
                });
                throwIfCanceled(job.signal);
            }
            sendProgress({
                jobId,
                phase: 'printing' as const,
                percent: 100,
            });
            const printResult = await printManagedTempPdfPath(
                {window: BrowserWindow.fromWebContents(context.sender)},
                printablePdfPath,
                resolveDjvuPrintDocumentTitle(djvuPath, options.fileName, selectedPages),
                {
                    signal: job.signal,
                },
            );
            if (job.signal.aborted) {
                return {
                    success: false,
                    canceled: true,
                    jobId,
                    error: 'DjVu print preparation canceled',
                };
            }
            finalPdfHandedToPrint = printResult.success;
            logger.info(`[${jobId}] DjVu print handoff complete: success=${printResult.success} canceled=${printResult.canceled === true}`);
            if (printResult.success) {
                job.handoff(requireDocumentRef(printablePdfPath), {
                    jobId,
                    ...progressScope,
                    phase: 'printing',
                    percent: 100,
                    status: 'running',
                });
            }
            return {
                ...printResult,
                jobId,
            };
        });
        if (!result.success) {
            const canceled = result.canceled === true
                || job.signal.aborted
                || isDjvuCancellationError(result.error);
            if (canceled) {
                throw job.signal.reason ?? createAbortError('DjVu print preparation canceled');
            }
        }
        return result;
    } catch (error) {
        const errorMessage = getErrorMessage(error);
        const canceled = job.signal.aborted
            || isDjvuCancellationError(error)
            || errorMessage.includes('DjVu conversion canceled')
            || errorMessage.includes('Print handoff canceled');
        if (canceled) {
            logger.info(`[${jobId}] DjVu print preparation canceled`);
        } else {
            logger.error(`[${jobId}] DjVu print preparation failed: ${errorMessage}`, {
                code: 'MAIN_DJVU_EXPORT_FAILED',
                context: {},
            });
        }
        const result = {
            success: false,
            ...(canceled ? { canceled: true } : {}),
            jobId,
            error: canceled ? 'DjVu print preparation canceled' : errorMessage,
        };
        return result;
    } finally {
        activePdfWorkerByJobId.delete(jobId);
        await rm(tempDir, {
            force: true,
            recursive: true,
        }).catch(() => undefined);
        if (requiresPrintLayout || !finalPdfHandedToPrint) {
            await rm(finalPdfPath, { force: true }).catch(() => undefined);
        }
        if (!finalPdfHandedToPrint) {
            await rm(composedPdfPath, { force: true }).catch(() => undefined);
        }
    }
}

export async function handleDjvuPrintPath(
    context: IDjvuOperationContext,
    djvuPath: TOpenPath,
    options: IDjvuPrintOptions,
): Promise<IDjvuPrintResult> {
    const progressScope = createDjvuProgressScope(options.requestId, djvuPath);
    const jobId = resolveDjvuPrintJobId(progressScope.requestId);
    const handle = startDjvuJob(context, {
        jobId,
        workingCopyPath: djvuPath,
        initialProgress: {
            jobId,
            ...progressScope,
            phase: 'converting',
            percent: 0,
        },
        nativeCancellation: true,
        run: job => runDjvuPrintPath(context, djvuPath, options, jobId, progressScope, job),
    });
    const terminal = await handle.terminal;
    await handle.settled;
    return terminal.status === 'completed'
        ? terminal.result
        : {
            success: false,
            canceled: terminal.status === 'canceled',
            jobId,
            error: terminal.status === 'canceled'
                ? 'DjVu print preparation canceled'
                : terminal.error.message,
        };
}

async function runDjvuConvertToPdf(
    context: IDjvuOperationContext,
    djvuPath: TOpenPath,
    normalizedOutputPath: string,
    options: IDjvuConvertOptions,
    conversionId: string,
    jobId: TJobId,
    progressScope: TDjvuProgressScope,
    job: IDjvuJobRunContext,
): Promise<IDjvuConvertResult> {
    logger.info(`[${jobId}] Converting DjVu to PDF: ${djvuPath} -> ${normalizedOutputPath}`);
    const sendProgress = (progress: IDjvuProgress) => {
        const scopedProgress = {
            ...progress,
            ...progressScope,
        };
        job.publish(scopedProgress);
    };
    sendProgress({
        jobId,
        phase: 'converting' as const,
        percent: 0,
    });

    let tempDir: string | null = null;
    try {
        const exportTempDir = await mkdtemp(join(app.getPath('temp'), 'djvu-export-'));
        tempDir = exportTempDir;
        const tempPdfPath = join(exportTempDir, `${conversionId}.convert.pdf`);
        const tempBookmarkedPdfPath = join(exportTempDir, `${conversionId}.bookmarks.pdf`);
        await assertDjvuExportDiskSpace(djvuPath, normalizedOutputPath);
        const result = await runDjvuConversionJobWithSlot(jobId, job.signal, async () => {
            const strategy = resolveDjvuPdfExportStrategy(options.pdfStrategy);
            const [
                pageCount,
                sourceDpi,
            ] = await Promise.all([
                runDjvuMetadataWithSlot(jobId, job.signal, () => getDjvuPageCount(djvuPath, { signal: job.signal })),
                runDjvuMetadataWithSlot(jobId, job.signal, () => getDjvuResolution(djvuPath, { signal: job.signal })),
            ]);

            throwIfCanceled(job.signal);
            const pageSizes = await runDjvuMetadataWithSlot(jobId, job.signal, () => getDjvuConversionPageSizes(jobId, djvuPath, pageCount, job.signal));
            throwIfCanceled(job.signal);

            const convertResult = strategy === 'compact-djvu-aware'
                ? await buildCompactDjvuAwarePdfFromDjvu({
                    jobId,
                    djvuPath,
                    outputPath: tempPdfPath,
                    tempDir: exportTempDir,
                    pageCount,
                    sourceDpi,
                    pageSizes,
                    qualityPreset: resolveDjvuCompactFidelityPreset(options.subsample),
                    signal: job.signal,
                    onProgress: (percent) => {
                        sendProgress({
                            jobId,
                            phase: 'converting' as const,
                            percent,
                        });
                    },
                })
                : await (async () => {
                    const subsample = resolveSubsample(options.subsample);
                    const policy = evaluateDjvuPdfConversionPolicy({
                        pageCount,
                        sourceDpi,
                        pageSizes,
                    }, subsample);
                    if (!policy.isAllowed) {
                        return {
                            success: false as const,
                            outputPath: tempPdfPath,
                            fileSize: 0,
                            error: createDjvuConversionPolicyError(policy),
                            expected: createDjvuExpectedOutcome('validation-rejected'),
                        };
                    }

                    return convertDjvuToPdfFile(djvuPath, tempPdfPath, jobId, {
                        ...(subsample > 1 ? { subsample } : {}),
                        pageCount,
                        signal: job.signal,
                        onProgress: (percent) => {
                            sendProgress({
                                jobId,
                                phase: 'converting' as const,
                                percent: scaleDjvuConversionProgress(percent),
                            });
                        },
                    });
                })();

            if (!convertResult.success) {
                const conversionFailure = getDjvuFailureReceipt(convertResult);
                const conversionExpected = getDjvuExpectedOutcome(convertResult);
                return {
                    success: false,
                    jobId,
                    ...progressScope,
                    error: convertResult.error ?? 'DjVu conversion failed',
                    ...(conversionFailure !== undefined && conversionExpected === undefined
                        ? {failure: conversionFailure}
                        : {}),
                    ...(conversionExpected === undefined ? {} : {expected: conversionExpected}),
                };
            }
            throwIfCanceled(job.signal);

            const bookmarks = options.preserveBookmarks !== false
                ? await runDjvuMetadataWithSlot(jobId, job.signal, () => getDjvuOutline(djvuPath, { signal: job.signal }))
                    .then(sexp => parseDjvuOutline(sexp))
                    .catch(() => [] as IPdfBookmarkEntry[])
                : [];
            if (bookmarks.length > 0) {
                throwIfCanceled(job.signal);
                sendProgress({
                    jobId,
                    phase: 'bookmarks' as const,
                    percent: DJVU_BOOKMARK_PROGRESS_PERCENT,
                });
                await embedPdfBookmarks(
                    jobId,
                    tempPdfPath,
                    tempBookmarkedPdfPath,
                    bookmarks,
                    job.signal,
                );
            }

            throwIfCanceled(job.signal);
            const finalTempPdfPath = bookmarks.length > 0 ? tempBookmarkedPdfPath : tempPdfPath;
            sendProgress({
                jobId,
                phase: 'optimizing' as const,
                percent: DJVU_OPTIMIZE_PROGRESS_PERCENT,
            });
            await optimizeGeneratedPdfForInteraction(finalTempPdfPath, { signal: job.signal });
            throwIfCanceled(job.signal);
            await replaceFileAtomically(finalTempPdfPath, normalizedOutputPath, job.signal);

            job.handoff(requireDocumentRef(normalizedOutputPath), {
                jobId,
                ...progressScope,
                phase: 'optimizing',
                percent: 100,
                status: 'running',
            });

            logger.info(`[${jobId}] Conversion to PDF complete: ${normalizedOutputPath}`);
            allowOpenPath(normalizedOutputPath, context.sender);
            return {
                success: true,
                pdfPath: requireDocumentRef(normalizedOutputPath),
                jobId,
                ...progressScope,
            };
        });
        if (!result.success) {
            const error = getOptionalResultError(result);
            const canceled = job.signal.aborted
                || isDjvuCancellationError(error);
            if (canceled) {
                throw job.signal.reason ?? createAbortError('DjVu conversion canceled');
            }

            const expected = getDjvuExpectedOutcome(result);
            if (expected !== undefined) {
                return {
                    success: false,
                    jobId,
                    ...progressScope,
                    error: error ?? 'DjVu conversion failed',
                    expected,
                };
            }
            const failure = getDjvuFailureReceipt(result)
                ?? logger.error(`[${jobId}] Conversion failed: ${error ?? 'DjVu conversion failed'}`, {
                    code: 'MAIN_DJVU_EXPORT_FAILED',
                    context: {},
                });
            return {
                success: false,
                jobId,
                ...progressScope,
                error: error ?? 'DjVu conversion failed',
                ...(failure === undefined ? {} : {failure}),
            };
        }
        return result;
    } catch (error) {
        const canceled = job.signal.aborted || isDjvuCancellationError(error);
        if (canceled) {
            logger.info(`[${jobId}] Conversion canceled`);
            return {
                success: false,
                jobId,
                ...progressScope,
                error: 'DjVu conversion canceled',
                expected: createDjvuExpectedOutcome('canceled'),
            };
        }

        const expected = classifyDjvuConversionExpectedOutcome(error);
        if (expected !== undefined) {
            logger.warn(`[${jobId}] DjVu conversion ended with an expected outcome: ${getErrorMessage(error)}`);
            return {
                success: false,
                jobId,
                ...progressScope,
                error: getErrorMessage(error),
                expected,
            };
        }

        const errorMessage = getErrorMessage(error);
        const failure = getDjvuFailureReceipt(error)
            ?? logger.error(`[${jobId}] Conversion failed: ${errorMessage}`, {
                code: 'MAIN_DJVU_EXPORT_FAILED',
                context: {},
                cause: error,
            });
        const result = {
            success: false,
            jobId,
            ...progressScope,
            error: errorMessage,
            ...(failure === undefined ? {} : {failure}),
        };
        return result;
    } finally {
        activePdfWorkerByJobId.delete(jobId);
        if (tempDir !== null) {
            try {
                await rm(tempDir, {
                    force: true,
                    recursive: true,
                });
            } catch {
                // Ignore cleanup errors
            }
        }
    }
}

function startDjvuConvertJob(
    context: IDjvuOperationContext,
    djvuPath: TOpenPath,
    outputPath: string,
    options: IDjvuConvertOptions,
    durable: boolean,
) {
    const conversionId = randomUUID();
    const jobId = options.jobId ?? requireJobId(`djvu-convert-${conversionId}`);
    const progressScope = createDjvuProgressScope(options.requestId, options.documentRef ?? djvuPath);
    return startDjvuJob(context, {
        jobId,
        workingCopyPath: djvuPath,
        initialProgress: {
            jobId,
            ...progressScope,
            phase: 'converting',
            percent: 0,
        },
        durable,
        nativeCancellation: true,
        run: async (job) => {
            let normalizedOutputPath: string | null = null;
            try {
                normalizedOutputPath = consumeAllowedDjvuWritePath(outputPath, context.senderId);
            } catch {
                return {
                    success: false,
                    jobId,
                    ...progressScope,
                    error: 'Invalid output path',
                    expected: createDjvuExpectedOutcome('validation-rejected'),
                };
            }
            if (!normalizedOutputPath) {
                return {
                    success: false,
                    jobId,
                    ...progressScope,
                    error: 'Invalid output path: please use Save dialog before converting DjVu to PDF',
                    expected: createDjvuExpectedOutcome('validation-rejected'),
                };
            }
            return runDjvuConvertToPdf(
                context,
                djvuPath,
                normalizedOutputPath,
                options,
                conversionId,
                jobId,
                progressScope,
                job,
            );
        },
    });
}

export async function handleDjvuConvertToPdf(
    context: IDjvuOperationContext,
    djvuPath: TOpenPath,
    outputPath: string,
    options: IDjvuConvertOptions,
): Promise<IDjvuConvertResult> {
    const handle = startDjvuConvertJob(context, djvuPath, outputPath, options, false);
    const terminal = await handle.terminal;
    await handle.settled;
    return terminal.status === 'completed'
        ? terminal.result
        : {
            success: false,
            jobId: requireJobId(handle.jobId),
            ...(terminal.progress.requestId ? {requestId: terminal.progress.requestId} : {}),
            ...(terminal.progress.documentRef ? {documentRef: terminal.progress.documentRef} : {}),
            error: terminal.status === 'canceled'
                ? 'DjVu conversion canceled'
                : terminal.error.message,
            ...(terminal.error.failure === undefined
                ? {}
                : {failure: terminal.error.failure}),
            ...(terminal.error.expected === undefined
                ? terminal.status === 'canceled'
                    ? {expected: createDjvuExpectedOutcome('canceled')}
                    : {}
                : {expected: terminal.error.expected}),
        };
}

export function startDurableDjvuConvertJob(
    context: IDjvuOperationContext,
    djvuPath: TOpenPath,
    outputPath: string,
    options: IDjvuConvertOptions,
) {
    return startDjvuConvertJob(context, djvuPath, outputPath, options, true);
}

export async function awaitDurableDjvuConvertJob(context: IDjvuOperationContext, jobId: TJobId) {
    const result = await awaitDjvuJob(context, jobId, 'convert');
    const value = result as IDjvuConvertResult;
    if (value.success && value.pdfPath) {
        allowOpenPath(value.pdfPath, context.sender);
    }
    return value;
}

export function startDurableDjvuOpenJob(
    context: IDjvuOperationContext,
    jobId: TJobId,
    path: TOpenPath,
    run: (signal: AbortSignal) => Promise<IDjvuOpenResult>,
) {
    return startDjvuJob(context, {
        jobId,
        workingCopyPath: path,
        initialProgress: {
            jobId,
            documentRef: requireDocumentRef(path),
            phase: 'loading',
            percent: 0,
        },
        durable: true,
        run: async job => ({
            ...await run(job.signal),
            jobId,
        }),
    });
}

export async function awaitDurableDjvuOpenJob(context: IDjvuOperationContext, jobId: TJobId) {
    const result = await awaitDjvuJob(context, jobId, 'open');
    const value = result as IDjvuOpenResult;
    const snapshot = djvuJobs.get(jobId, {sender: context.sender});
    if (value.success && snapshot?.progress.documentRef) {
        adoptDjvuViewingPath(context, snapshot.progress.documentRef);
    }
    return value;
}

export async function handleDjvuCancel(
    context: IDjvuOperationContext,
    jobId: TJobId,
): Promise<{ canceled: boolean }> {
    logger.info(`[${jobId}] Cancel requested`);
    const canceled = djvuJobs.cancel(
        jobId,
        {sender: context.sender},
        jobId.startsWith('djvu-open-')
            ? 'DjVu operation canceled'
            : 'DjVu conversion canceled',
    );
    if (canceled) {
        await activeDjvuJobSettled.get(jobId);
    }
    logger.info(`[${jobId}] Cancel result: ${canceled}`);
    return {canceled};
}

export async function shutdownDjvuConversions() {
    const jobIds = uniq([
        ...activeNativeJobCancels.keys(),
        ...activePdfWorkerByJobId.keys(),
    ]);

    const workerTerminations: Array<Promise<unknown>> = [];
    if (jobIds.length > 0) {
        logger.info(`Canceling ${jobIds.length} active/queued DjVu conversion job(s) during shutdown`);
        for (const jobId of jobIds) {
            activeNativeJobCancels.get(jobId)?.('DjVu conversion canceled during shutdown');
            await requestDjvuNativeCancel(jobId);
            const activePdfWorker = activePdfWorkerByJobId.get(jobId);
            if (activePdfWorker) {
                activePdfWorkerByJobId.delete(jobId);
                workerTerminations.push(activePdfWorker.terminate().catch(() => undefined));
            }
        }
    }

    activeNativeJobCancels.clear();
    activePdfWorkerByJobId.clear();

    await Promise.allSettled(workerTerminations);
}

export async function clearDjvuJobsForTests() {
    await djvuJobs.clearForTests();
    activeNativeJobCancels.clear();
    activeDjvuJobSettled.clear();
}
