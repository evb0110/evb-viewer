import {isAbsolute} from 'path';
import type {
    IScanCleanupDetectionRequest,
    IScanCleanupDetectionResult,
    IScanCleanupOwnerContext,
    TScanCleanupDetectionJobState,
    TScanCleanupDetectionStartResult,
} from '@contracts/electronApiScanCleanup';
import type {TJobId} from '@contracts/shared';
import {projectScanCleanupDetectionStateForRenderer} from '@contracts/scan-cleanup/ipcResultCodecs';
import {attachScanCleanupPageOverrideDefaults} from '@contracts/scanCleanupPageOverrides';
import {
    runScanCleanupDetection,
    SCAN_CLEANUP_RESULT_ARRAY_COMPATIBILITY_MAX_PAGES,
    type IScanCleanupDetectionDependencies,
    type IScanCleanupDetectionRetention,
    completedPageProgress,
} from '@evb/scan-cleanup/core/detection';
import {
    classifyScanCleanupPreviewError as classifyScanCleanupError,
    scanCleanupScratchShortfall,
} from '@electron/features/scan-cleanup/scanCleanupPreviewPolicy';
import {SCAN_CLEANUP_PLATFORM_FEATURE} from '@contracts/scanCleanupPlatformFeature';
import {getErrorMessage} from '@electron/utils/error';
import {createStableJobBrokerOwnerId} from '@electron/resources/jobBroker';
import {
    registerScanCleanupDetectionResultStore,
    releaseScanCleanupDetectionResultStores,
} from '@electron/features/scan-cleanup/detectionResultStoreRegistry';
import {createMainJobRegistry} from '@electron/operation-lifecycle/createMainJobRegistry';
import {createJobId} from '@contracts/shared';
import {createEpochMs} from '@contracts/timestamps';
import type {
    IRetainedDocument,
    IScanCleanupDetectionSubscriber,
    IScanCleanupDetectionOwnerDependencies,
    IScanCleanupDetectionRetentionView,
    IDetectionResult,
    TDetectionError,
    TDetectionSnapshot,
} from '@electron/features/scan-cleanup/scanCleanupPreviewShared';
import type {IScanCleanupDetectionResultStore} from '@evb/scan-cleanup/core/types';
import {normalizeDetectionProgress} from '@electron/features/scan-cleanup/scanCleanupPreviewShared';
import {createLogger} from '@electron/utils/createLogger';

const logger = createLogger('scan-cleanup-detection');
function logScanCleanupMessage(level: 'debug' | 'error' | 'info' | 'warn', message: string) {
    if (level === 'error') {
        logger.error(message, {
            code: 'MAIN_SCAN_CLEANUP_FAILED',
            context: {},
        });
        return;
    }
    logger[level](message);
}

export interface IScanCleanupActiveDetectionJob {
    readonly jobId: TJobId;
    readonly request: IScanCleanupDetectionRequest;
    readonly signature: string;
}

/**
 * Owns detection results after the detection job has handed them off. The job
 * registry owns job state. This owner owns the file-backed result stores and
 * the renderer delivery cursors that must outlive one progress callback.
 */
export interface IScanCleanupDetectionLifecycle {
    resetDelivery(deliveryKey: string): void;
    selectUndelivered(
        deliveryKey: string,
        results: readonly IScanCleanupDetectionResult[],
    ): IScanCleanupDetectionResult[];
    ownResultStore(jobId: string, store: IScanCleanupDetectionResultStore): void;
    registerResultStore(storeId: string): void;
    releaseJob(jobId: string): Promise<void>;
    activeJob(ownerId: string): IScanCleanupActiveDetectionJob | undefined;
    setActiveJob(ownerId: string, job: IScanCleanupActiveDetectionJob): void;
    clearActiveJob(ownerId: string, jobId: string): void;
    dispose(): Promise<void>;
}

function createScanCleanupDetectionLifecycle(): IScanCleanupDetectionLifecycle {
    const deliveredResults = new Map<string, Map<number, number | string>>();
    const ownedResultStores = new Map<string, IScanCleanupDetectionResultStore>();
    const registeredStoreIds = new Set<string>();
    const activeJobs = new Map<string, IScanCleanupActiveDetectionJob>();
    const deliveredSignature = (result: IScanCleanupDetectionResult) => result.revision ?? JSON.stringify([
        result.classification,
        result.confidence,
        result.cutterXPx,
        result.tier1Verdict,
        result.reconciled,
        result.clusterAgreement,
        result.documentPrior,
        result.textAxis,
        result.recommendedOutputMode,
        result.recommendedOutputModeConfidence,
        result.recommendedOutputModeReason,
        result.softAlphaForegroundRecommendation,
        result.pagePlanEvidence,
    ]);
    return {
        resetDelivery(deliveryKey) {
            deliveredResults.delete(deliveryKey);
        },
        selectUndelivered(deliveryKey, results) {
            const delivered = deliveredResults.get(deliveryKey) ?? new Map<number, number | string>();
            const changed = results.filter(result => {
                const signature = deliveredSignature(result);
                if (delivered.get(result.pageNumber) === signature) {
                    return false;
                }
                delivered.set(result.pageNumber, signature);
                return true;
            });
            deliveredResults.set(deliveryKey, delivered);
            return changed;
        },
        ownResultStore(jobId, store) {
            ownedResultStores.set(jobId, store);
        },
        registerResultStore(storeId) {
            registeredStoreIds.add(storeId);
        },
        releaseJob(jobId) {
            const store = ownedResultStores.get(jobId);
            ownedResultStores.delete(jobId);
            return store?.close().catch(() => undefined) ?? Promise.resolve();
        },
        activeJob(ownerId) {
            return activeJobs.get(ownerId);
        },
        setActiveJob(ownerId, job) {
            activeJobs.set(ownerId, job);
        },
        clearActiveJob(ownerId, jobId) {
            if (activeJobs.get(ownerId)?.jobId === jobId) activeJobs.delete(ownerId);
        },
        async dispose() {
            const stores = [...ownedResultStores.values()];
            ownedResultStores.clear();
            await Promise.allSettled(stores.map(store => store.close()));
            const storeIds = [...registeredStoreIds];
            registeredStoreIds.clear();
            await releaseScanCleanupDetectionResultStores(storeIds);
            deliveredResults.clear();
            activeJobs.clear();
        },
    };
}


export interface IScanCleanupDetectionOwner extends IScanCleanupDetectionLifecycle {
    detectAll: (
        sender: IScanCleanupDetectionSubscriber,
        request: IScanCleanupDetectionRequest,
    ) => Promise<TScanCleanupDetectionStartResult>;
    cancelDetection: (
        sender: IScanCleanupDetectionSubscriber,
        jobId: string,
        owner: IScanCleanupOwnerContext,
    ) => boolean;
    getDetectionJobState: (
        sender: IScanCleanupDetectionSubscriber,
        jobId: string,
        owner: IScanCleanupOwnerContext,
    ) => TScanCleanupDetectionJobState | null;
    subscribeDetectionJob: (
        sender: IScanCleanupDetectionSubscriber,
        jobId: string,
        owner: IScanCleanupOwnerContext,
    ) => TScanCleanupDetectionJobState | null;
}

export function scanCleanupDetectionOwner(
    dependencies: IScanCleanupDetectionOwnerDependencies,
    rawRasterRetention: IScanCleanupDetectionRetentionView,
): IScanCleanupDetectionOwner {
    const detectionLifecycle = createScanCleanupDetectionLifecycle();
    const rendererDetectionState = (state: TScanCleanupDetectionJobState | null) => (
        state === null ? null : projectScanCleanupDetectionStateForRenderer(state)
    );
    const detectionDeliveryKey = (senderId: number, jobId: string) => `${senderId}\u0000${jobId}`;
    const detectionJobs = createMainJobRegistry<
        TScanCleanupDetectionJobState,
        IDetectionResult,
        TDetectionError,
        IScanCleanupDetectionSubscriber
    >({
        retention: {
            eventReplayTtlMs: 60_000,
            terminalRecordTtlMs: 60_000,
        },
        unbindOnSettlement: true,
        progress: {
            channel: SCAN_CLEANUP_PLATFORM_FEATURE.eventChannels.onDetectionJobState,
            getEventKey: state => state.jobId,
            send: (subscriber, channel, state) => {
                const deliveryKey = detectionDeliveryKey(subscriber.id, state.jobId);
                if (state.status === 'queued' || state.status === 'running' || state.status === 'canceling') {
                    if (state.progress.totalUnits > SCAN_CLEANUP_RESULT_ARRAY_COMPATIBILITY_MAX_PAGES) {
                        // Large runs already publish a bounded batch from core.
                        // The renderer needs only the newest classifications it
                        // can display. Full page plans remain in the file-backed
                        // result store for persistence and final cleanup.
                        detectionLifecycle.resetDelivery(deliveryKey);
                        subscriber.send(channel, rendererDetectionState(state));
                        return;
                    }
                    const changed = detectionLifecycle.selectUndelivered(deliveryKey, state.results);
                    subscriber.send(channel, {
                        ...state,
                        results: changed,
                    });
                    return;
                }
                detectionLifecycle.resetDelivery(deliveryKey);
                // Terminal states can be reconstructed from the file-backed
                // result store after a restart. Project them through the same
                // bounded window as live xlarge progress before they cross
                // into the renderer.
                subscriber.send(channel, rendererDetectionState(state));
            },
        },
        toError: (cause, kind) => ({
            code: classifyScanCleanupError(cause, kind === 'canceled'),
            message: getErrorMessage(cause),
            ...scanCleanupScratchShortfall(cause),
        }),
        terminalProgress: {
            completed: (latest, result) => {
                const resultCount = result.resultStore.resultCount;
                const pageCount = result.resultStore.pageCount;
                const results = resultCount <= SCAN_CLEANUP_RESULT_ARRAY_COMPATIBILITY_MAX_PAGES
                    ? result.results
                    : [];
                return {
                    jobId: latest.jobId,
                    status: 'completed',
                    documentCanvasSignature: latest.documentCanvasSignature ?? '',
                    progress: {
                        stage: 'detecting',
                        completedUnits: resultCount,
                        totalUnits: pageCount,
                        percent: pageCount === 0 ? 100 : resultCount / pageCount * 100,
                        ...completedPageProgress(new Set(results.map(item => item.pageNumber)), resultCount),
                    },
                    resultCount,
                    ...(result.resultStoreId === undefined
                        ? {}
                        : {detectionResultStoreId: result.resultStoreId}),
                    ...(result.placementAnchorSummary === undefined
                        ? {}
                        : {placementAnchorSummary: result.placementAnchorSummary}),
                    results,
                    updatedAtMs: createEpochMs(),
                };
            },
            canceled: latest => ({
                ...latest,
                status: 'canceled',
                updatedAtMs: createEpochMs(),
            }),
            failed: (latest, error) => ({
                ...latest,
                status: 'failed',
                error: error.message,
                errorCode: error.code,
                // The renderer states this refusal in the user's language, so
                // the figures behind it travel typed rather than in the
                // English message.
                ...(error.scratchShortfall === undefined
                    ? {}
                    : {scratchShortfall: error.scratchShortfall}),
                updatedAtMs: createEpochMs(),
            }),
        },
    });
    const detectionActor = (sender: IScanCleanupDetectionSubscriber, owner: IScanCleanupOwnerContext) => ({
        sender,
        ownerId: owner.ownerId,
        documentRevision: owner.documentRevision,
    });
    const publicDetectionState = (snapshot: TDetectionSnapshot | null) => snapshot?.progress ?? null;
    const subscribeDetection = (
        sender: IScanCleanupDetectionSubscriber,
        jobId: string,
        owner: IScanCleanupOwnerContext,
    ) => {
        // The registry pumps every state change to the job owner, so subscribing
        // only has to authorize the sender and restart its result cursor: the
        // caller is handed the whole state and must be able to rebuild from it.
        if (!detectionJobs.get(jobId, detectionActor(sender, owner))) {
            return false;
        }
        detectionLifecycle.resetDelivery(detectionDeliveryKey(sender.id, jobId));
        return true;
    };

    const brokerOwnerId = (
        sender: IScanCleanupDetectionSubscriber,
        owner: IScanCleanupOwnerContext,
    ) => createStableJobBrokerOwnerId('scan-cleanup', sender.id, owner.ownerId);
    const ownerMethods: Pick<
        IScanCleanupDetectionOwner,
        'detectAll' | 'cancelDetection' | 'getDetectionJobState' | 'subscribeDetectionJob'
    > = {
        detectAll(sender, request) {
            const jobId = createJobId('scan-cleanup-detect');
            if (!isAbsolute(request.sourcePdfPath)) {
                return Promise.resolve({
                    started: false,
                    jobId,
                    error: 'Source must be an absolute path',
                    errorCode: 'invalid-request',
                });
            }
            const ownerId = brokerOwnerId(sender, request);
            const signature = JSON.stringify(request);
            const previous = detectionLifecycle.activeJob(ownerId);
            if (previous) {
                const previousState = publicDetectionState(detectionJobs.get(
                    previous.jobId,
                    detectionActor(sender, previous.request),
                ));
                if (previousState && (
                    previousState.status === 'queued'
                    || previousState.status === 'running'
                    || previousState.status === 'canceling'
                )) {
                    if (
                        previous.signature === signature
                        && previousState.status !== 'canceling'
                    ) {
                        subscribeDetection(sender, previous.jobId, request);
                        return Promise.resolve({
                            started: true,
                            jobId: previous.jobId,
                        });
                    }
                    if (previous.signature !== signature) {
                        detectionJobs.cancel(
                            previous.jobId,
                            detectionActor(sender, previous.request),
                            'Superseded scan cleanup detection request',
                        );
                    }
                }
            }
            const handle = detectionJobs.start({
                jobId,
                owner: detectionActor(sender, request),
                operation: {
                    kind: 'abortable-work',
                    workingCopyPath: request.sourcePdfPath,
                },
                initialProgress: {
                    jobId,
                    status: 'queued',
                    documentCanvasSignature: '',
                    progress: {
                        stage: 'queued',
                        completedUnits: 0,
                        totalUnits: 0,
                        percent: 0,
                        completedPageNumbers: [],
                    },
                    resultCount: 0,
                    results: [],
                    updatedAtMs: createEpochMs(),
                },
                ownerLifecycle: {
                    destroyed: 'cancel',
                    renderProcessGone: 'cancel',
                    mainFrameNavigation: 'cancel',
                },
                run: async job => {
                    let lease: {release: () => boolean} | null = null;
                    try {
                        const acquire = dependencies.acquireDetectionLease;
                        if (!acquire) throw new Error('Scan cleanup detection requires injected admission capability');
                        const rasterPolicy = dependencies.resolveRasterAdmissionPolicy(
                            process.platform !== 'win32'
                                && dependencies.createRasterPipes !== undefined,
                        );
                        lease = await acquire(brokerOwnerId(sender, request), job.signal, rasterPolicy);
                        const materializedRequest = await dependencies.materializeRequest(
                            request,
                            sender.id,
                            job.signal,
                            dependencies,
                        );
                        attachScanCleanupPageOverrideDefaults(
                            materializedRequest.options.pageOverrides,
                            materializedRequest.options.pageOverrideDefaults,
                            materializedRequest.options.marginsMm,
                        );
                        const fileSystem = dependencies.fileSystem;
                        if (fileSystem === undefined) {
                            throw new Error('Scan cleanup detection requires injected filesystem capabilities');
                        }
                        const detectionDependencies: IScanCleanupDetectionDependencies = {
                            fileSystem,
                            ...(dependencies.getAvailableScratchBytes === undefined
                                ? {}
                                : {getAvailableScratchBytes: dependencies.getAvailableScratchBytes}),
                            getTempDir: dependencies.getTempDir,
                            getPdftoppmBinary: dependencies.getPdftoppmBinary,
                            resolveBinary: dependencies.resolveBinary,
                            renderPage: dependencies.renderPage,
                            renderPagePpm: dependencies.renderPagePpm,
                            ...(dependencies.renderPageBatch === undefined
                                ? {}
                                : {renderPageBatch: dependencies.renderPageBatch}),
                            ...(!rasterPolicy.rasterStreaming || dependencies.createRasterPipes === undefined
                                ? {}
                                : {createRasterPipes: dependencies.createRasterPipes}),
                            runSidecar: dependencies.runSidecar,
                        };
                        // Keep production detection on bounded stores. The
                        // preview-only aggregate readers remain on the raw
                        // retention object for compatibility with the preview
                        // pipeline and focused tests, but never cross this
                        // boundary into document-scale detection.
                        const detectionRetention: IScanCleanupDetectionRetention<IRetainedDocument> = {
                            openDocument: request => rawRasterRetention.openDocument(request, ownerId),
                            pageCount: rawRasterRetention.pageCount,
                            pageSizeStore: rawRasterRetention.pageSizeStore,
                            rasterPages: rawRasterRetention.rasterPageSource,
                            retainedPaths: rawRasterRetention.retainedPaths,
                            claimRaster: (document, pageNumber, dpi) => rawRasterRetention.claimRaster(
                                document,
                                pageNumber,
                                dpi,
                                ownerId,
                            ),
                            rasterScratchPath: rawRasterRetention.rasterScratchPath,
                            stagedRasterPath: rawRasterRetention.stagedRasterPath,
                            retain: (rendered, claimId = ownerId) => rawRasterRetention.retain(rendered, claimId),
                            releaseRaster: (document, pageNumber, dpi) => rawRasterRetention.releaseRaster(
                                document,
                                pageNumber,
                                dpi,
                                ownerId,
                            ),
                            release: document => rawRasterRetention.release(document, ownerId),
                        };
                        const detection = await runScanCleanupDetection(
                            materializedRequest,
                            job.signal,
                            detectionRetention,
                            detectionDependencies,
                            {rasterConcurrency: rasterPolicy.rasterConcurrency},
                            (nextResults, progress, documentCanvasSignature) => {
                                const normalizedProgress = normalizeDetectionProgress(progress);
                                job.publish({
                                    jobId,
                                    status: 'running',
                                    documentCanvasSignature,
                                    progress: normalizedProgress,
                                    resultCount: normalizedProgress.completedUnits,
                                    results: nextResults,
                                    updatedAtMs: createEpochMs(),
                                });
                            },
                            logScanCleanupMessage,
                        );
                        if (detection.resultStore.pageCount > SCAN_CLEANUP_RESULT_ARRAY_COMPATIBILITY_MAX_PAGES) {
                            const resultStoreId = registerScanCleanupDetectionResultStore({
                                documentRevision: request.documentRevision,
                                ownerId: request.ownerId,
                                resultStore: detection.resultStore,
                                sourcePdfPath: request.sourcePdfPath,
                            });
                            detectionLifecycle.registerResultStore(resultStoreId);
                            return {
                                ...detection,
                                resultStoreId,
                            };
                        }
                        detectionLifecycle.ownResultStore(jobId, detection.resultStore);
                        return detection;
                    } finally {
                        lease?.release();
                    }
                },
            });
            subscribeDetection(sender, jobId, request);
            const activeEntry = {
                jobId,
                request,
                signature,
            };
            detectionLifecycle.setActiveJob(ownerId, activeEntry);
            void handle.settled.finally(async () => {
                // A destroyed sender makes the progress pump drop the
                // terminal frame before the delivery callback can clear its
                // per-job result cursor. Release it at job settlement as the
                // lifecycle owner, while keeping terminal delivery idempotent.
                detectionLifecycle.resetDelivery(detectionDeliveryKey(sender.id, jobId));
                await detectionLifecycle.releaseJob(jobId);
                detectionLifecycle.clearActiveJob(ownerId, jobId);
            }).catch(() => undefined);
            return Promise.resolve({
                started: true,
                jobId,
            });
        },
        cancelDetection(sender, jobId, owner) {
            const actor = detectionActor(sender, owner);
            const state = publicDetectionState(detectionJobs.get(jobId, actor));
            if (!state || [
                'completed',
                'failed',
                'canceled',
            ].includes(state.status)) {
                return false;
            }
            const canceled = detectionJobs.cancel(jobId, actor, 'Scan cleanup detection canceled');
            if (canceled) {
                const ownerId = brokerOwnerId(sender, owner);
                if (detectionLifecycle.activeJob(ownerId)?.jobId === jobId) {
                    // The registry exposes canceling on its envelope while the
                    // detection progress payload still carries its last
                    // queued/running status. Remove the join candidate at the
                    // same boundary that acknowledges cancellation, so a new
                    // identical request cannot inherit the retiring job.
                    detectionLifecycle.clearActiveJob(ownerId, jobId);
                }
            }
            return canceled;
        },
        getDetectionJobState(sender, jobId, owner) {
            return rendererDetectionState(publicDetectionState(
                detectionJobs.get(jobId, detectionActor(sender, owner)),
            ));
        },
        subscribeDetectionJob(sender, jobId, owner) {
            return subscribeDetection(sender, jobId, owner)
                ? rendererDetectionState(publicDetectionState(
                    detectionJobs.get(jobId, detectionActor(sender, owner)),
                ))
                : null;
        },
    };
    return {
        ...detectionLifecycle,
        ...ownerMethods,
        async dispose() {
            await detectionJobs.clearForTests();
            await detectionLifecycle.dispose();
        },
    };
}
