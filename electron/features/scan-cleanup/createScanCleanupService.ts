import {rm} from 'fs/promises';
import {
    dirname,
    isAbsolute,
    normalize,
    resolve,
} from 'path';
import type { WebContents } from 'electron';
import type {
    IScanCleanupStartRequest,
    IScanCleanupOwnerContext,
    TScanCleanupProgress,
    TScanCleanupSummary,
    TScanCleanupStartResult,
    TScanCleanupErrorCode,
    TScanCleanupJobState,
} from '@contracts/electronApiScanCleanup';
import type {IHostResourceProfileSnapshot} from '@contracts/hostResourceProfile';
import type {FailureReceipt} from '@contracts/diagnostics/failureReceipt';
import type { IScanCleanupRuntimePolicy } from '@contracts/resourcePolicies';
import {
    createStableJobBrokerOwnerId,
    mainJobBroker,
} from '@electron/resources/jobBroker';
import { getHostResourceProfileSnapshot } from '@electron/resources/hostResourceProfile';
import { getPdfNativeToolPaths } from '@electron/pdf/nativeToolPaths';
import { resolveNativePdfImageCombinePath } from '@electron/image/tryCreatePdfWithNativeImageCombiner';
import { getAppTempDir } from '@electron/utils/appTempDir';
import { getErrorMessage } from '@electron/utils/error';
import {createLogger} from '@electron/utils/createLogger';
import {getWorkerTaskFailureReceipt} from '@electron/utils/workerTask';
import { SCAN_CLEANUP_PLATFORM_FEATURE } from '@contracts/scanCleanupPlatformFeature';
import { runScanCleanupWorkerTask } from '@electron/features/scan-cleanup/runScanCleanupWorkerTask';
import {
    createScanCleanupGeneratedOutputPath,
    pruneScanCleanupGeneratedOutputs,
} from '@electron/features/scan-cleanup/public/generatedOutputs';
import {
    allowOpenPath,
    MAX_ALLOWED_OPEN_PATHS,
    OPEN_PATH_CAPABILITY_TTL_MS,
} from '@electron/file-access/openPathCapabilities';
import {
    isNativePageOpsDisabled,
    resolveNativePageOpsPath,
} from '@electron/features/page-ops/public';
import {
    createMainJobRegistry,
    type IMainJobErrorEnvelope,
    type IMainJobRegistry,
    type TMainJobSnapshot,
} from '@electron/operation-lifecycle/createMainJobRegistry';
import {
    getWorkingCopyBackingEntry,
    isWorkingCopyOriginalPathRegistered,
} from '@electron/file-access/workingCopyStore';
import {ensureWorkingCopyMaterialized} from '@electron/file-access/workingCopyMaterialization';
import {quarantineWorkingCopy} from '@electron/file-access/workingCopyQuarantine';
import {getUnprovenNativeTerminationDetail} from '@electron/utils/nativeTerminationProof';
import {
    SCAN_CLEANUP_INK_ANCHOR_CAPACITY_MESSAGE,
    ScanCleanupNativeToolUnavailableError,
} from '@evb/scan-cleanup/core/errors';
import {
    classifyScanCleanupPreviewError as classifyPreviewError,
    resolveScanCleanupPreviewPath as resolvePreviewPath,
    resolveScanCleanupPreviewRasterAdmissionPolicy as resolvePreviewRasterAdmissionPolicy,
    SCAN_CLEANUP_PREVIEW_RASTER_SLOT_RESIDENT_BYTES as PREVIEW_RASTER_SLOT_RESIDENT_BYTES,
} from '@electron/features/scan-cleanup/scanCleanupPreviewPolicy';
import {SCAN_CLEANUP_INPUT_MAX_PAGE_ENTRIES} from '@contracts/scan-cleanup/inputLimits';
import {createEpochMs} from '@contracts/timestamps';
import {
    createJobId,
    type TJobId,
} from '@contracts/shared';
import {
    attachScanCleanupPageOverrideDefaults,
    getScanCleanupPageOverride,
    usesScanCleanupInkAlignment,
} from '@contracts/scanCleanupPageOverrides';
import {claimScanCleanupDetectionResultStore} from '@electron/features/scan-cleanup/detectionResultStoreRegistry';
import {
    persistScanCleanupDetectionResultStore,
    removeScanCleanupDetectionResultStoreDescriptor,
    type IScanCleanupDetectionResultStoreDescriptor,
} from '@electron/features/scan-cleanup/detectionResultStoreDescriptor';
import {createScanCleanupDetectionSignature} from '@contracts/scan-cleanup/createScanCleanupDetectionSignature';
import {
    isScanCleanupOutputMode,
    isScanCleanupOutputModeRecommendationReason,
} from '@contracts/scan-cleanup/outputModeGuards';
import {requirePageNumber} from '@contracts/pageNumbers';

interface IScanCleanupJobResult {
    completedPageNumbers: number[];
    completedPageNumbersTruncated?: boolean;
    outputPdfPath: string;
    partial: boolean;
    summary: TScanCleanupSummary;
}

type TScanCleanupJobError = IMainJobErrorEnvelope<TScanCleanupErrorCode> & {failure?: FailureReceipt};
type TScanCleanupJobRegistry = IMainJobRegistry<TScanCleanupJobState, IScanCleanupJobResult, TScanCleanupJobError>;
const scanCleanupJobLogger = createLogger('scan-cleanup-job');

const SCAN_CLEANUP_RASTER_SLOT_RESIDENT_BYTES = PREVIEW_RASTER_SLOT_RESIDENT_BYTES;

export function grantScanCleanupOutputAccess(
    outputPdfPath: string,
    subscribers: Iterable<WebContents>,
) {
    for (const subscriber of subscribers) {
        registerScanCleanupOutputAccess(outputPdfPath, subscriber);
    }
}

interface IScanCleanupOutputAccessRegistration {
    handleDestroyed: () => void;
    handleNavigation: (_event: unknown, _url: string, isInPlace: boolean, isMainFrame: boolean) => void;
    handleRenderProcessGone: () => void;
    paths: Map<string, number>;
    sender: WebContents;
}

interface IScanCleanupProgressSubscription {unsubscribe: (() => void) | null;}

const outputAccessRegistrations = new Map<number, IScanCleanupOutputAccessRegistration>();

function normalizedOutputAccessPath(outputPath: string) {
    const normalized = normalize(resolve(outputPath));
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function removeOutputAccessRegistration(senderId: number, expected?: IScanCleanupOutputAccessRegistration) {
    const registration = outputAccessRegistrations.get(senderId);
    if (!registration || (expected && registration !== expected)) {
        return;
    }
    registration.sender.removeListener('destroyed', registration.handleDestroyed);
    registration.sender.removeListener('render-process-gone', registration.handleRenderProcessGone);
    registration.sender.removeListener('did-start-navigation', registration.handleNavigation);
    outputAccessRegistrations.delete(senderId);
}

function createOutputAccessRegistration(sender: WebContents) {
    const registration: IScanCleanupOutputAccessRegistration = {
        handleDestroyed: () => removeOutputAccessRegistration(sender.id, registration),
        handleRenderProcessGone: () => removeOutputAccessRegistration(sender.id, registration),
        handleNavigation: (_event, _url, isInPlace, isMainFrame) => {
            if (isMainFrame && !isInPlace) {
                removeOutputAccessRegistration(sender.id, registration);
            }
        },
        paths: new Map(),
        sender,
    };
    outputAccessRegistrations.set(sender.id, registration);
    sender.once('destroyed', registration.handleDestroyed);
    sender.once('render-process-gone', registration.handleRenderProcessGone);
    sender.on('did-start-navigation', registration.handleNavigation);
    return registration;
}

function registerScanCleanupOutputAccess(outputPath: string, sender: WebContents) {
    if (sender.isDestroyed()) {
        removeOutputAccessRegistration(sender.id);
        return;
    }
    let registration = outputAccessRegistrations.get(sender.id);
    if (registration?.sender !== sender) {
        removeOutputAccessRegistration(sender.id, registration);
        registration = undefined;
    }
    registration ??= createOutputAccessRegistration(sender);
    const now = Date.now();
    for (const [
        path,
        expiresAtMs,
    ] of registration.paths) {
        if (expiresAtMs <= now) {
            registration.paths.delete(path);
        }
    }
    const normalizedPath = normalizedOutputAccessPath(outputPath);
    if (registration.paths.has(normalizedPath)) {
        return;
    }
    if (allowOpenPath(outputPath, sender)) {
        registration.paths.set(normalizedPath, now + OPEN_PATH_CAPABILITY_TTL_MS);
        while (registration.paths.size > MAX_ALLOWED_OPEN_PATHS) {
            const oldestPath = registration.paths.keys().next().value;
            if (oldestPath === undefined) {
                break;
            }
            registration.paths.delete(oldestPath);
        }
    }
}

function sendScanCleanupState(sender: WebContents, state: TScanCleanupJobState) {
    if (sender.isDestroyed()) {
        return;
    }
    if (state.status === 'completed') grantScanCleanupOutputAccess(state.outputPdfPath, [sender]);
    sender.send(SCAN_CLEANUP_PLATFORM_FEATURE.eventChannels.onJobState, state);
}

function publicState(
    snapshot: TMainJobSnapshot<TScanCleanupJobState, IScanCleanupJobResult, TScanCleanupJobError> | null,
) {
    return snapshot?.progress ?? null;
}

function ownerActor(sender: WebContents, owner: IScanCleanupOwnerContext) {
    return {
        sender,
        ownerId: owner.ownerId,
        documentRevision: owner.documentRevision,
    };
}

function omitStageMetadata(progress: TScanCleanupProgress): TScanCleanupProgress {
    const {
        stageIndex: _stageIndex,
        stageCount: _stageCount,
        ...rest
    } = progress;
    return rest;
}

function omitCompletedPageMetadata(progress: TScanCleanupProgress): TScanCleanupProgress {
    const {
        completedPageNumbers: _completedPageNumbers,
        completedPageNumbersTruncated: _completedPageNumbersTruncated,
        ...rest
    } = progress;
    return rest;
}

function resolveCompletedPageMetadata(
    request: IScanCleanupStartRequest,
    inputPages: number,
) {
    if (request.sourcePageNumbers !== undefined) {
        return {completedPageNumbers: [...request.sourcePageNumbers]};
    }
    const firstPageNumber = request.sourcePageRange?.startPageNumber ?? 1;
    const completedPageNumbers = [] as number[];
    const retainedCount = Math.min(inputPages, SCAN_CLEANUP_INPUT_MAX_PAGE_ENTRIES);
    for (let index = 0; index < retainedCount; index += 1) {
        completedPageNumbers.push(firstPageNumber + index);
    }
    return {
        completedPageNumbers,
        ...(inputPages > retainedCount ? {completedPageNumbersTruncated: true} : {}),
    };
}

function scanCleanupStorePageNumbers(request: IScanCleanupStartRequest) {
    if (request.sourcePageNumbers !== undefined) {
        return request.sourcePageNumbers;
    }
    if (request.sourcePageRange !== undefined) {
        return request.sourcePageRange;
    }
    return null;
}

function validateScanCleanupDetectionRecord(
    result: unknown,
    expectedPageNumber: number,
) {
    if (
        typeof result !== 'object'
        || result === null
        || (result as {pageNumber?: unknown}).pageNumber !== expectedPageNumber
    ) {
        throw new Error(`Scan cleanup detection store is missing page ${String(expectedPageNumber)}`);
    }
    const record = result as {
        recommendedOutputMode?: unknown;
        recommendedOutputModeConfidence?: unknown;
        recommendedOutputModeReason?: unknown;
        softAlphaForegroundRecommendation?: unknown;
    };
    if (record.recommendedOutputMode !== undefined && !isScanCleanupOutputMode(record.recommendedOutputMode)) {
        throw new Error(`Scan cleanup detection store has an invalid recommendation for page ${String(expectedPageNumber)}`);
    }
    if (record.recommendedOutputModeConfidence !== undefined && (
        typeof record.recommendedOutputModeConfidence !== 'number'
        || !Number.isFinite(record.recommendedOutputModeConfidence)
        || record.recommendedOutputModeConfidence < 0
        || record.recommendedOutputModeConfidence > 1
    )) {
        throw new Error(`Scan cleanup detection store has an invalid recommendation confidence for page ${String(expectedPageNumber)}`);
    }
    if (record.recommendedOutputModeReason !== undefined
        && !isScanCleanupOutputModeRecommendationReason(record.recommendedOutputModeReason)) {
        throw new Error(`Scan cleanup detection store has an invalid recommendation reason for page ${String(expectedPageNumber)}`);
    }
    if (record.softAlphaForegroundRecommendation !== undefined
        && typeof record.softAlphaForegroundRecommendation !== 'boolean') {
        throw new Error(`Scan cleanup detection store has an invalid foreground recommendation for page ${String(expectedPageNumber)}`);
    }
    if (record.recommendedOutputMode === undefined && (
        record.recommendedOutputModeConfidence !== undefined
        || record.recommendedOutputModeReason !== undefined
    )) {
        throw new Error(`Scan cleanup detection store has incomplete recommendation data for page ${String(expectedPageNumber)}`);
    }
    return record;
}

async function admitScanCleanupDetectionStore(
    request: IScanCleanupStartRequest,
    store: NonNullable<ReturnType<typeof claimScanCleanupDetectionResultStore>>['resultStore'],
) {
    if (
        !Number.isSafeInteger(store.pageCount)
        || store.pageCount < 1
        || store.resultCount !== store.pageCount
    ) {
        throw new Error('Scan cleanup detection store is incomplete');
    }
    const selectedPages = scanCleanupStorePageNumbers(request);
    if (selectedPages !== null && (
        Array.isArray(selectedPages)
            ? selectedPages.some(page => page < 1 || page > store.pageCount)
            : selectedPages.startPageNumber < 1 || selectedPages.endPageNumber > store.pageCount
    )) {
        throw new Error('Scan cleanup source page is outside the detected document');
    }
    const pageOverride = (pageNumber: number) => getScanCleanupPageOverride(
        request.options.pageOverrides,
        requirePageNumber(pageNumber),
    );
    const validate = async (pageNumber: number) => {
        const record = validateScanCleanupDetectionRecord(
            await store.getPage(pageNumber),
            pageNumber,
        );
        const override = pageOverride(pageNumber);
        const automatic = request.options.preserveOriginalQuality !== true
            && !override.excluded
            && (override.outputModeOverride ?? request.options.outputMode) === 'auto';
        if (automatic && record.recommendedOutputMode === undefined) {
            throw new Error(`Scan cleanup detection store has no automatic recommendation for page ${String(pageNumber)}`);
        }
    };
    if (selectedPages !== null) {
        if (Array.isArray(selectedPages)) {
            for (const pageNumber of selectedPages) await validate(pageNumber);
        } else {
            for (let pageNumber = selectedPages.startPageNumber; pageNumber <= selectedPages.endPageNumber; pageNumber += 1) {
                await validate(pageNumber);
            }
        }
        return;
    }
    let expectedPageNumber = 1;
    await store.forEachChunk(results => {
        for (const result of results) {
            validateScanCleanupDetectionRecord(result, expectedPageNumber);
            const override = pageOverride(expectedPageNumber);
            const automatic = request.options.preserveOriginalQuality !== true
                && !override.excluded
                && (override.outputModeOverride ?? request.options.outputMode) === 'auto';
            if (automatic
                && (result as {recommendedOutputMode?: unknown}).recommendedOutputMode === undefined) {
                throw new Error(`Scan cleanup detection store has no automatic recommendation for page ${String(expectedPageNumber)}`);
            }
            expectedPageNumber += 1;
        }
    });
    if (expectedPageNumber !== store.pageCount + 1) {
        throw new Error('Scan cleanup detection store is incomplete');
    }
}

function completedProgress(
    latest: TScanCleanupJobState,
    result: IScanCleanupJobResult,
): TScanCleanupJobState {
    const completedPageMetadata = result.completedPageNumbersTruncated === true
        ? {
            completedPageNumbers: result.completedPageNumbers,
            completedPageNumbersTruncated: true as const,
        }
        : {completedPageNumbers: result.completedPageNumbers};
    return {
        jobId: latest.jobId,
        status: 'completed',
        outputPdfPath: result.outputPdfPath,
        summary: result.summary,
        partial: result.partial,
        progress: {
            ...omitCompletedPageMetadata(omitStageMetadata(latest.progress)),
            stage: 'handoff',
            completedUnits: result.summary.inputPages,
            totalUnits: result.summary.inputPages,
            percent: 100,
            ...(latest.progress.stageCount === undefined ? {} : {
                stageIndex: latest.progress.stageCount,
                stageCount: latest.progress.stageCount,
            }),
            ...completedPageMetadata,
        },
        updatedAtMs: createEpochMs(),
    };
}

function terminalProgress(
    latest: TScanCleanupJobState,
    status: 'canceled' | 'failed',
    error: TScanCleanupJobError,
): TScanCleanupJobState {
    const base = {
        jobId: latest.jobId,
        progress: latest.progress,
        updatedAtMs: createEpochMs(),
    };
    return status === 'canceled'
        ? {
            ...base,
            status,
        }
        : {
            ...base,
            status,
            error: error.message,
            errorCode: error.code,
            ...(error.failure === undefined ? {} : {failure: error.failure}),
        };
}

function createScanCleanupJobRegistry(): TScanCleanupJobRegistry {
    return createMainJobRegistry({
        retention: {
            eventReplayTtlMs: 60_000,
            terminalRecordTtlMs: 60_000,
        },
        toError: (cause, kind) => {
            const message = getErrorMessage(cause);
            if (kind === 'canceled') {
                return {
                    code: classifyPreviewError(cause, true),
                    message,
                };
            }
            const existingFailure = getWorkerTaskFailureReceipt(cause);
            const failure = existingFailure ?? scanCleanupJobLogger.error(
                `Scan cleanup job failed: ${message}`,
                {
                    code: 'MAIN_SCAN_CLEANUP_FAILED',
                    context: {},
                    cause,
                },
            );
            return {
                code: classifyPreviewError(cause, false),
                message,
                ...(failure === undefined ? {} : {failure}),
            };
        },
        terminalProgress: {
            completed: completedProgress,
            canceled: (latest, error) => terminalProgress(latest, 'canceled', error),
            failed: (latest, error) => terminalProgress(latest, 'failed', error),
        },
    });
}

export async function materializeScanCleanupSourcePath(
    sourcePdfPath: string,
    senderWebContentsId: number,
    signal?: AbortSignal,
) {
    if (!getWorkingCopyBackingEntry(sourcePdfPath, senderWebContentsId)) {
        throw new Error('Scan cleanup source is not a managed working copy');
    }
    const materialized = await ensureWorkingCopyMaterialized(sourcePdfPath, {
        ownerWebContentsId: senderWebContentsId,
        reason: 'scan-cleanup',
        ...(signal ? {signal} : {}),
    });
    return materialized.physicalWorkingCopyPath;
}

export interface IScanCleanupService {
    start: (sender: WebContents, request: IScanCleanupStartRequest) => Promise<TScanCleanupStartResult>;
    cancel: (sender: WebContents, jobId: string, owner: IScanCleanupOwnerContext) => boolean;
    getState: (sender: WebContents, jobId: string, owner: IScanCleanupOwnerContext) => TScanCleanupJobState | null;
    subscribe: (sender: WebContents, jobId: string, owner: IScanCleanupOwnerContext) => TScanCleanupJobState | null;
    pruneGeneratedOutputs: () => Promise<number>;
}

function resolveScanCleanupRuntimePolicy(
    profile: IHostResourceProfileSnapshot,
): IScanCleanupRuntimePolicy {
    const rasterPolicy = resolvePreviewRasterAdmissionPolicy();
    return {
        ...rasterPolicy,
        logicalCpus: profile.logicalCpus,
        totalRamBytes: profile.totalRamBytes,
    };
}

export function createScanCleanupService(
    jobs: TScanCleanupJobRegistry = createScanCleanupJobRegistry(),
): IScanCleanupService {
    const activeJobsByBrokerOwner = new Map<string, {
        jobId: TJobId;
        outputPdfPath: string;
        request: IScanCleanupStartRequest;
        signature: string;
    }>();
    const startReservationsByBrokerOwner = new Map<string, Promise<void>>();
    const progressSubscriptions = new Map<number, Map<string, IScanCleanupProgressSubscription>>();
    function forgetProgressSubscription(
        senderId: number,
        jobId: string,
        expected: IScanCleanupProgressSubscription,
    ) {
        const subscriptions = progressSubscriptions.get(senderId);
        if (subscriptions?.get(jobId) !== expected) {
            return;
        }
        subscriptions.delete(jobId);
        if (subscriptions.size === 0) {
            progressSubscriptions.delete(senderId);
        }
    }
    function releaseProgressSubscription(
        senderId: number,
        jobId: string,
        subscription: IScanCleanupProgressSubscription,
    ) {
        forgetProgressSubscription(senderId, jobId, subscription);
        subscription.unsubscribe?.();
    }
    return {
        async start(sender, request) {
            const jobId = createJobId('scan-cleanup');
            const brokerOwnerId = createStableJobBrokerOwnerId(
                'scan-cleanup',
                sender.id,
                request.ownerId,
            );
            if (!isAbsolute(request.sourcePdfPath)) {
                return {
                    started: false,
                    jobId,
                    error: 'Source must be an absolute path',
                    errorCode: 'invalid-request',
                };
            }
            const signature = JSON.stringify(request);
            const pendingStart = startReservationsByBrokerOwner.get(brokerOwnerId);
            if (pendingStart) {
                await pendingStart;
                return this.start(sender, request);
            }
            let releaseStartReservation!: () => void;
            const reservation = new Promise<void>(resolve => {
                releaseStartReservation = resolve;
            });
            startReservationsByBrokerOwner.set(brokerOwnerId, reservation);
            const releaseReservation = () => {
                releaseStartReservation();
                if (startReservationsByBrokerOwner.get(brokerOwnerId) === reservation) {
                    startReservationsByBrokerOwner.delete(brokerOwnerId);
                }
            };
            let startedHandle: ReturnType<TScanCleanupJobRegistry['start']> | null = null;
            let detectionResultStoreLease: ReturnType<typeof claimScanCleanupDetectionResultStore> = null;
            try {
                const previous = activeJobsByBrokerOwner.get(brokerOwnerId);
                if (previous) {
                    const previousState = publicState(jobs.get(
                        previous.jobId,
                        ownerActor(sender, previous.request),
                    ));
                    if (previousState && ![
                        'completed',
                        'failed',
                        'canceled',
                    ].includes(previousState.status)) {
                        if (previous.signature === signature) {
                            return {
                                started: true,
                                jobId: previous.jobId,
                                outputPdfPath: previous.outputPdfPath,
                            };
                        }
                        jobs.cancel(
                            previous.jobId,
                            ownerActor(sender, previous.request),
                            'Superseded scan cleanup request',
                        );
                    }
                }
                const partial = request.sourcePageNumbers !== undefined
                                || request.sourcePageRange !== undefined;
                attachScanCleanupPageOverrideDefaults(
                    request.options.pageOverrides,
                    request.options.pageOverrideDefaults,
                    request.options.marginsMm,
                );
                detectionResultStoreLease = request.detectionResultStoreId === undefined
                    ? null
                    : claimScanCleanupDetectionResultStore(
                        request.detectionResultStoreId,
                        {
                            detectionSignature: createScanCleanupDetectionSignature(request.options),
                            documentRevision: request.documentRevision,
                            ownerId: request.ownerId,
                            sourcePdfPath: request.sourcePdfPath,
                        },
                    );
                if (request.detectionResultStoreId !== undefined && detectionResultStoreLease === null) {
                    return {
                        started: false,
                        jobId,
                        error: 'Detection results are no longer available for this document',
                        errorCode: 'invalid-request',
                    };
                }
                if (
                    detectionResultStoreLease !== null
                    && detectionResultStoreLease.resultStore.pageCount > SCAN_CLEANUP_INPUT_MAX_PAGE_ENTRIES
                    && usesScanCleanupInkAlignment(request.options)
                    && request.placementAnchorSummary === undefined
                ) {
                    // The renderer keeps only a bounded result window. A
                    // completed detection must carry the document-wide
                    // bounded calibration before an xlarge ink run starts.
                    await detectionResultStoreLease.resultStore.close().catch(() => undefined);
                    detectionResultStoreLease = null;
                    return {
                        started: false,
                        jobId,
                        error: SCAN_CLEANUP_INK_ANCHOR_CAPACITY_MESSAGE,
                        errorCode: 'too-large',
                    };
                }
                if (detectionResultStoreLease !== null) {
                    try {
                        await admitScanCleanupDetectionStore(request, detectionResultStoreLease.resultStore);
                    } catch (error) {
                        await detectionResultStoreLease.resultStore.close().catch(() => undefined);
                        detectionResultStoreLease = null;
                        return {
                            started: false,
                            jobId,
                            error: error instanceof Error ? error.message : 'Detection results are incomplete',
                            errorCode: 'invalid-request',
                        };
                    }
                }
                const outputPdfPath = await createScanCleanupGeneratedOutputPath(request.sourcePdfPath, partial);
                const {
                    detectionResultStoreId: _detectionResultStoreId,
                    ...requestWithoutDetectionStoreId
                } = request;
                const workerRequest = {
                    ...requestWithoutDetectionStoreId,
                    outputPdfPath,
                };
                const runtimePolicy = resolveScanCleanupRuntimePolicy(
                    getHostResourceProfileSnapshot(),
                );
                const progress: TScanCleanupProgress = {
                    stage: 'queued' as const,
                    completedUnits: 0,
                    totalUnits: 0,
                    percent: 0,
                    completedPageNumbers: [],
                };
                const handle = jobs.start({
                    jobId,
                    owner: ownerActor(sender, request),
                    operation: {
                        // The worker may have atomically published its generated
                        // PDF immediately before its result reaches main. Main is
                        // the terminal-state authority: cancellation that arrived
                        // first removes that publication, while a result handled
                        // first enters a non-cancelable commit state.
                        kind: 'critical-write',
                        workingCopyPath: request.sourcePdfPath,
                        // Before that commit boundary the job is reading the
                        // source working copy, so closing the document tab is a
                        // cancellation request the close path must be able to
                        // make and then wait on.
                        cancelOnWorkingCopyClose: true,
                    },
                    initialProgress: {
                        jobId,
                        status: 'queued',
                        progress,
                        updatedAtMs: createEpochMs(),
                    },
                    ownerLifecycle: {
                        // A destroyed or crashed renderer can never present this
                        // job again: authorization is bound to the original
                        // WebContents and a replacement renderer cannot adopt it,
                        // so the work would run to completion for nobody. Only a
                        // same-WebContents navigation can reconnect (getJobState/
                        // reconnectJob), so only it detaches.
                        destroyed: 'cancel',
                        renderProcessGone: 'cancel',
                        mainFrameNavigation: 'detach',
                    },
                    run: async job => {
                        let lease: Awaited<ReturnType<typeof mainJobBroker.acquire>> | null = null;
                        let detectionResultStoreDescriptor: IScanCleanupDetectionResultStoreDescriptor | null = null;
                        try {
                            lease = await mainJobBroker.acquire({
                                ownerId: brokerOwnerId,
                                kind: 'scan-cleanup',
                                priority: 'user',
                                resources: {
                                    cpuTokens: runtimePolicy.rasterConcurrency,
                                    estimatedResidentBytes: runtimePolicy.rasterConcurrency * SCAN_CLEANUP_RASTER_SLOT_RESIDENT_BYTES,
                                    nativeProcesses: runtimePolicy.rasterConcurrency
                                        + Number(runtimePolicy.rasterStreaming),
                                    ioWeight: 4,
                                },
                                perOwnerLimit: 1,
                                signal: job.signal,
                            });
                            const pdfPaths = getPdfNativeToolPaths();
                            const scanCleanupBinary = resolvePreviewPath();
                            const pdfImageCombineBinary = resolveNativePdfImageCombinePath();
                            // Page geometry is what matched page size is measured
                            // from, so the raster path asks for this tool too — and
                            // takes Poppler's answer when it is missing, rather than
                            // dropping matching without telling anyone. Only the
                            // lossless assembler needs the tool itself.
                            // Auto can retain an existing compact MRC/JPX page when
                            // its resolved Color result only needs page geometry.
                            // Page-ops applies that geometry without decoding or
                            // recompressing the source image objects.
                            const requiresPageOps = request.options.preserveOriginalQuality === true
                                || request.options.matchPageSize
                                || request.options.outputMode === 'auto';
                            const pdfPageOpsBinary = requiresPageOps && !isNativePageOpsDisabled()
                                ? resolveNativePageOpsPath()
                                : null;
                            const missingTools = [
                                scanCleanupBinary ? null : 'evb-scan-cleanup',
                                pdfImageCombineBinary ? null : 'evb-pdf-image-combine',
                                request.options.preserveOriginalQuality === true && !pdfPageOpsBinary
                                    ? 'evb-pdf-page-ops'
                                    : null,
                            ].filter((name): name is string => name !== null);
                            if (missingTools.length > 0 || !scanCleanupBinary || !pdfImageCombineBinary) {
                                throw new ScanCleanupNativeToolUnavailableError(
                                    missingTools[0] ?? 'unknown scan-cleanup native tool',
                                );
                            }
                            if (detectionResultStoreLease !== null) {
                                detectionResultStoreDescriptor = await persistScanCleanupDetectionResultStore(
                                    detectionResultStoreLease.resultStore,
                                    getAppTempDir(),
                                );
                            }
                            const summary = await runScanCleanupWorkerTask(
                                {
                                    ...workerRequest,
                                    ...(detectionResultStoreDescriptor === null
                                        ? {}
                                        : {detectionResultStoreDescriptor}),
                                    sourcePdfPath: await materializeScanCleanupSourcePath(
                                        request.sourcePdfPath,
                                        sender.id,
                                        job.signal,
                                    ),
                                },
                                {
                                    qpdfBinary: pdfPaths.qpdf,
                                    pdftoppmBinary: pdfPaths.pdftoppm,
                                    ...(pdfPaths.pdfimages ? {pdfimagesBinary: pdfPaths.pdfimages} : {}),
                                    pdfinfoBinary: pdfPaths.pdfinfo,
                                    scanCleanupBinary,
                                    pdfImageCombineBinary,
                                    ...(pdfPageOpsBinary ? {pdfPageOpsBinary} : {}),
                                    tempDir: getAppTempDir(),
                                },
                                runtimePolicy,
                                job.signal,
                                nextProgress => {
                                    job.publish({
                                        jobId,
                                        status: nextProgress.stage === 'handoff' ? 'handoff' : 'running',
                                        progress: nextProgress,
                                        updatedAtMs: createEpochMs(),
                                    });
                                },
                            );
                            // Resolve the cancel-vs-publish race in the same main
                            // process that owns the job state. If cancel won while
                            // the worker was publishing, the catch path removes the
                            // generated-output directory. Otherwise later cancel
                            // requests are rejected as soon as commit begins.
                            job.signal.throwIfAborted();
                            job.markCommitStarted();
                            const completedPageMetadata = resolveCompletedPageMetadata(request, summary.inputPages);
                            return {
                                outputPdfPath,
                                summary,
                                partial,
                                ...completedPageMetadata,
                            };
                        } catch (error) {
                            // The run stopped, but its native tree may not have.
                            // Whoever closes this document next must not delete
                            // the source bytes a surviving Poppler child could
                            // still be reading, so the unprovable stop is
                            // recorded against the path rather than dropped with
                            // the rejection.
                            const unprovenTermination = getUnprovenNativeTerminationDetail(error);
                            if (unprovenTermination !== undefined) {
                                quarantineWorkingCopy(request.sourcePdfPath, unprovenTermination);
                            }
                            await rm(dirname(outputPdfPath), {
                                recursive: true,
                                force: true,
                            }).catch(() => undefined);
                            throw error;
                        } finally {
                            lease?.release();
                            await detectionResultStoreLease?.resultStore.close().catch(() => undefined);
                            if (detectionResultStoreDescriptor !== null) {
                                await removeScanCleanupDetectionResultStoreDescriptor(
                                    detectionResultStoreDescriptor,
                                ).catch(() => undefined);
                            }
                        }
                    },
                });
                startedHandle = handle;
                const activeEntry = {
                    jobId,
                    outputPdfPath,
                    request,
                    signature,
                };
                activeJobsByBrokerOwner.set(brokerOwnerId, activeEntry);
                void handle.settled.finally(() => {
                    if (activeJobsByBrokerOwner.get(brokerOwnerId) === activeEntry) {
                        activeJobsByBrokerOwner.delete(brokerOwnerId);
                    }
                }).catch(() => undefined);
                return {
                    started: true,
                    jobId,
                    outputPdfPath,
                };
            } catch (error) {
                if (startedHandle === null) {
                    await detectionResultStoreLease?.resultStore.close().catch(() => undefined);
                }
                throw error;
            } finally {
                releaseReservation();
            }
        },
        cancel(sender, jobId, owner) {
            const actor = ownerActor(sender, owner);
            const state = publicState(jobs.get(jobId, actor));
            if (!state) {
                return false;
            }
            if ([
                'completed',
                'failed',
                'canceled',
            ].includes(state.status)) {
                return true;
            }
            return jobs.cancel(jobId, actor, 'Scan cleanup canceled');
        },
        getState(sender, jobId, owner) {
            return publicState(jobs.get(jobId, ownerActor(sender, owner)));
        },
        subscribe(sender, jobId, owner) {
            const actor = ownerActor(sender, owner);
            const subscriptions = progressSubscriptions.get(sender.id)
                ?? new Map<string, IScanCleanupProgressSubscription>();
            const previous = subscriptions.get(jobId);
            if (previous) {
                releaseProgressSubscription(sender.id, jobId, previous);
            }
            progressSubscriptions.set(sender.id, subscriptions);
            const subscription: IScanCleanupProgressSubscription = {unsubscribe: null};
            subscriptions.set(jobId, subscription);
            const unsubscribe = jobs.subscribe(jobId, actor, state => {
                sendScanCleanupState(sender, state.progress);
            }, () => {
                forgetProgressSubscription(sender.id, jobId, subscription);
            });
            subscription.unsubscribe = unsubscribe;
            const state = publicState(jobs.get(jobId, actor));
            if (!unsubscribe || !state) {
                releaseProgressSubscription(sender.id, jobId, subscription);
                return null;
            }
            return state;
        },
        pruneGeneratedOutputs() {
            return pruneScanCleanupGeneratedOutputs({isOutputLive: isWorkingCopyOriginalPathRegistered});
        },
    };
}
