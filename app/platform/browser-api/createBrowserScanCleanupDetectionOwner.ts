import type {
    IScanCleanupCapability,
    IScanCleanupDetectionRequest,
    IScanCleanupOwnerContext,
    IScanCleanupPreviewRequest,
    TScanCleanupDetectionJobState,
    TScanCleanupDetectionStartResult,
    TScanCleanupErrorCode,
} from '@contracts/scan-cleanup/electronApiScanCleanup';
import {SCAN_CLEANUP_ERROR_CODES} from '@contracts/scan-cleanup/ipc';
import {SCAN_CLEANUP_STREAMING_BATCH_PAGES} from '@contracts/scan-cleanup/inputLimits';
import {projectScanCleanupDetectionStateForRenderer} from '@contracts/scan-cleanup/projectScanCleanupDetectionStateForRenderer';
import {attachScanCleanupPageOverrideDefaults} from '@contracts/scan-cleanup/scanCleanupPageOverrides';
import {createScanCleanupDetectionSignature} from '@contracts/scan-cleanup/createScanCleanupDetectionSignature';
import {createJobId} from '@contracts/shared';
import {createEpochMs} from '@contracts/timestamps';
import type {TDocumentRef} from '@contracts/documentRef';
import type {IScanCleanupDetectionResultStore} from '@evb/scan-cleanup/core/types';
import {createMemoryScanCleanupDetectionResultStore} from '@evb/scan-cleanup/core/createMemoryScanCleanupDetectionResultStore';
import {createScanCleanupPlacementAnchorCalibrations} from '@evb/scan-cleanup/core/createScanCleanupPlacementAnchorCalibrations';
import {
    completeScanCleanupDetectionJobState,
    queuedScanCleanupDetectionJobState,
    runningScanCleanupDetectionJobState,
    selectUndeliveredScanCleanupDetectionResults,
    type IScanCleanupDetectionJobResult,
} from '@evb/scan-cleanup/core/scanCleanupDetectionJobState';
import {getErrorMessage} from '@app/utils/error';
import {createBrowserScanCleanupJobRegistry} from '@app/platform/browser-api/createBrowserScanCleanupJobRegistry';
import {createIndexedDbScanCleanupDetectionResultStore} from '@app/platform/browser-api/createIndexedDbScanCleanupDetectionResultStore';
import {runBrowserScanCleanupDetection} from '@app/platform/browser-api/runBrowserScanCleanupDetection';
import {
    awaitScanCleanupSource,
    borrowBrowserScanCleanupSource,
} from '@app/platform/browser-api/browserScanCleanupSources';

type TDetectionListener = Parameters<IScanCleanupCapability['onDetectionJobState']>[0];

/** What a detection store holds evidence about; a reader must match it exactly. */
interface IStoreIdentity {
    ownerId: string;
    sourceRef: string;
    documentRevision: string;
    detectionSignature: string;
}

interface IStoreEntry {
    store: IScanCleanupDetectionResultStore;
    identity: IStoreIdentity;
    leases: number;
    retired: boolean;
}

interface IActiveDetection {
    jobId: string;
    request: IScanCleanupDetectionRequest;
    signature: string;
}

function classifyBrowserScanCleanupError(error: unknown): TScanCleanupErrorCode {
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
    return typeof code === 'string' && (SCAN_CLEANUP_ERROR_CODES as readonly string[]).includes(code)
        ? code as TScanCleanupErrorCode
        : 'internal';
}

const isLiveStatus = (status: TScanCleanupDetectionJobState['status']) => status === 'queued'
    || status === 'running'
    || status === 'canceling';

/**
 * The window's Scan Cleanup detection, as desktop's detection owner runs it:
 * one live job per document owner, joined by an identical request and
 * superseded by another; its states delivered to listeners, a small run's
 * results once each; the store of a long document's results kept after the
 * job for placement calibration and previews, until the owner detects again
 * or closes the document.
 */
export function createBrowserScanCleanupDetectionOwner() {
    const listeners = new Set<TDetectionListener>();
    const deliveredByJob = new Map<string, Map<number, number | string>>();
    const deliver = (state: TScanCleanupDetectionJobState) => {
        let delivered: TScanCleanupDetectionJobState;
        if (isLiveStatus(state.status) && state.progress.totalUnits <= SCAN_CLEANUP_STREAMING_BATCH_PAGES) {
            const cursor = deliveredByJob.get(state.jobId) ?? new Map<number, number | string>();
            deliveredByJob.set(state.jobId, cursor);
            delivered = {
                ...state,
                results: selectUndeliveredScanCleanupDetectionResults(cursor, state.results),
            };
        } else {
            // Large runs already publish a bounded batch, and terminal states
            // cross through the same bounded projection.
            deliveredByJob.delete(state.jobId);
            delivered = projectScanCleanupDetectionStateForRenderer(state);
        }
        for (const listener of [...listeners]) listener(delivered);
    };
    const jobs = createBrowserScanCleanupJobRegistry<TScanCleanupDetectionJobState, IScanCleanupDetectionJobResult>({
        terminal: {
            completed: completeScanCleanupDetectionJobState,
            canceled: latest => ({
                ...latest,
                status: 'canceled',
                updatedAtMs: createEpochMs(),
            }),
            failed: (latest, error) => ({
                ...latest,
                status: 'failed',
                error: getErrorMessage(error),
                errorCode: classifyBrowserScanCleanupError(error),
                updatedAtMs: createEpochMs(),
            }),
        },
        onState: deliver,
    });
    const active = new Map<string, IActiveDetection>();
    const calibrations = createScanCleanupPlacementAnchorCalibrations();

    // Every store is leased while read; a retired store closes once its last
    // reader is done. A live job's store answers previews while it runs; a
    // long document's completed store is its owner's current store.
    const stores = new Map<string, IStoreEntry>();
    const liveStoreByJob = new Map<string, string>();
    // A store its job does not keep retires once the job has settled, after
    // its completed state has read the store's counts.
    const unkeptStoreByJob = new Map<string, string>();
    const ownerStore = new Map<string, string>();
    // Every page's detected layout: the renderer keeps only a bounded window
    // of them, and the matched canvas needs all. A running job still appends
    // and reconciles, so only a finished job's kept store is read once.
    const keptLayouts = new WeakMap<IScanCleanupDetectionResultStore, NonNullable<IScanCleanupPreviewRequest['layoutByPage']>>();
    async function readStoreLayouts(store: IScanCleanupDetectionResultStore, finished: boolean) {
        const kept = keptLayouts.get(store);
        if (kept) return kept;
        const layoutByPage: NonNullable<IScanCleanupPreviewRequest['layoutByPage']> = {};
        await store.forEachChunk((results) => {
            for (const result of results) layoutByPage[String(result.pageNumber)] = result.classification;
        });
        if (finished) keptLayouts.set(store, layoutByPage);
        return layoutByPage;
    }
    const closeIfIdle = (entry: IStoreEntry) => {
        if (entry.retired && entry.leases === 0) void entry.store.close().catch(() => undefined);
    };
    const retireStore = (storeId: string) => {
        const entry = stores.get(storeId);
        if (entry === undefined) return;
        stores.delete(storeId);
        entry.retired = true;
        calibrations.retire(storeId);
        closeIfIdle(entry);
    };
    const leaseStore = (storeId: string | undefined, identity?: IStoreIdentity) => {
        const entry = storeId === undefined ? undefined : stores.get(storeId);
        if (entry === undefined || entry.retired) return null;
        if (identity !== undefined && (
            entry.identity.ownerId !== identity.ownerId
            || entry.identity.sourceRef !== identity.sourceRef
            || entry.identity.documentRevision !== identity.documentRevision
            || entry.identity.detectionSignature !== identity.detectionSignature
        )) return null;
        entry.leases += 1;
        let released = false;
        return {
            store: entry.store,
            release() {
                if (released) return;
                released = true;
                entry.leases -= 1;
                closeIfIdle(entry);
            },
        };
    };
    const retireOwnerStore = (ownerId: string) => {
        const storeId = ownerStore.get(ownerId);
        ownerStore.delete(ownerId);
        if (storeId !== undefined) retireStore(storeId);
    };

    const runDetection = async (
        jobId: string,
        request: IScanCleanupDetectionRequest,
        context: Parameters<Parameters<typeof jobs.start>[0]['run']>[0],
    ): Promise<IScanCleanupDetectionJobResult> => {
        const borrow = borrowBrowserScanCleanupSource(request.sourcePdfPath, request.documentRevision);
        try {
            const source = await awaitScanCleanupSource(borrow.opened, context.signal);
            attachScanCleanupPageOverrideDefaults(
                request.options.pageOverrides,
                request.options.pageOverrideDefaults,
                request.options.marginsMm,
            );
            const totalPages = source.pageSizes.length;
            const resultStore = totalPages > SCAN_CLEANUP_STREAMING_BATCH_PAGES
                ? await createIndexedDbScanCleanupDetectionResultStore(totalPages)
                : createMemoryScanCleanupDetectionResultStore(totalPages);
            const storeId = crypto.randomUUID();
            stores.set(storeId, {
                store: resultStore,
                identity: {
                    ownerId: request.ownerId,
                    sourceRef: request.sourcePdfPath,
                    documentRevision: request.documentRevision,
                    detectionSignature: createScanCleanupDetectionSignature(request.options),
                },
                leases: 0,
                retired: false,
            });
            liveStoreByJob.set(jobId, storeId);
            unkeptStoreByJob.set(jobId, storeId);
            try {
                const outcome = await runBrowserScanCleanupDetection({
                    request,
                    source,
                    resultStore,
                    signal: context.signal,
                    publish: (results, progress, documentCanvasSignature) => {
                        context.publish(runningScanCleanupDetectionJobState(context.latest().jobId, results, progress, documentCanvasSignature));
                    },
                });
                // A small document's results travel in its completed state; a
                // long one's stay in its store, kept for its owner unless the
                // job lost its place while it ran.
                if (totalPages <= SCAN_CLEANUP_STREAMING_BATCH_PAGES
                    || context.signal.aborted
                    || active.get(request.ownerId)?.jobId !== jobId) {
                    return outcome;
                }
                retireOwnerStore(request.ownerId);
                ownerStore.set(request.ownerId, storeId);
                unkeptStoreByJob.delete(jobId);
                return {
                    ...outcome,
                    resultStoreId: storeId,
                };
            } finally {
                liveStoreByJob.delete(jobId);
            }
        } finally {
            borrow.release();
        }
    };

    return {
        onDetectionJobState(listener: TDetectionListener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        detectAll(request: IScanCleanupDetectionRequest): Promise<TScanCleanupDetectionStartResult> {
            const signature = JSON.stringify(request);
            const previous = active.get(request.ownerId);
            if (previous !== undefined && jobs.isLive(previous.jobId)) {
                if (previous.signature === signature) {
                    // Joining is subscribing: the caller rebuilds from a full snapshot.
                    deliveredByJob.delete(previous.jobId);
                    return Promise.resolve({
                        started: true,
                        jobId: previous.jobId as ReturnType<typeof createJobId>,
                    });
                }
                jobs.cancel(previous.jobId, previous.request, 'Superseded scan cleanup detection request');
            }
            const jobId = createJobId('scan-cleanup-detect');
            active.set(request.ownerId, {
                jobId,
                request,
                signature,
            });
            retireOwnerStore(request.ownerId);
            const {settled} = jobs.start({
                jobId,
                owner: request,
                initial: queuedScanCleanupDetectionJobState(jobId),
                run: context => runDetection(jobId, request, context),
            });
            void settled.finally(() => {
                const unkept = unkeptStoreByJob.get(jobId);
                unkeptStoreByJob.delete(jobId);
                if (unkept !== undefined) retireStore(unkept);
                deliveredByJob.delete(jobId);
                if (active.get(request.ownerId)?.jobId === jobId) active.delete(request.ownerId);
            });
            return Promise.resolve({
                started: true,
                jobId,
            });
        },
        cancelDetection(jobId: string, owner: IScanCleanupOwnerContext) {
            const state = jobs.get(jobId, owner);
            if (state === null || !isLiveStatus(state.status)) return Promise.resolve(false);
            const canceled = jobs.cancel(jobId, owner, 'Scan cleanup detection canceled') === 'canceled';
            // An identical request after the cancel starts afresh instead of
            // joining the job that is winding down.
            if (canceled && active.get(owner.ownerId)?.jobId === jobId) active.delete(owner.ownerId);
            return Promise.resolve(canceled);
        },
        getDetectionJobState(jobId: string, owner: IScanCleanupOwnerContext) {
            const state = jobs.get(jobId, owner);
            return Promise.resolve(state === null ? null : projectScanCleanupDetectionStateForRenderer(state));
        },
        subscribeDetectionJob(jobId: string, owner: IScanCleanupOwnerContext) {
            const state = jobs.get(jobId, owner);
            if (state === null) return Promise.resolve(null);
            deliveredByJob.delete(jobId);
            return Promise.resolve(projectScanCleanupDetectionStateForRenderer(state));
        },
        async resolvePlacementAnchorCalibration(request: Parameters<NonNullable<IScanCleanupCapability['resolvePlacementAnchorCalibration']>>[0]) {
            attachScanCleanupPageOverrideDefaults(
                request.options.pageOverrides,
                request.options.pageOverrideDefaults,
                request.options.marginsMm,
            );
            const lease = leaseStore(request.detectionResultStoreId, {
                ownerId: request.ownerId,
                sourceRef: request.sourcePdfPath,
                documentRevision: request.documentRevision,
                detectionSignature: createScanCleanupDetectionSignature(request.options),
            });
            if (lease === null) {
                calibrations.retire(request.detectionResultStoreId);
                throw new Error('Detection results are no longer available for this document');
            }
            try {
                return await calibrations.resolve(request.detectionResultStoreId, lease.store, request);
            } finally {
                lease.release();
            }
        },
        /**
         * A preview request with the page plan its detection measured, as
         * desktop previews read it: from the running job's store, or the
         * owner's kept store, when either is evidence about this request.
         */
        async resolvePreviewPagePlan(request: IScanCleanupPreviewRequest): Promise<IScanCleanupPreviewRequest> {
            const detectionSignature = createScanCleanupDetectionSignature(request.options);
            const running = active.get(request.ownerId);
            const identity: IStoreIdentity = {
                ownerId: request.ownerId,
                sourceRef: request.sourcePdfPath,
                documentRevision: request.documentRevision,
                detectionSignature,
            };
            const live = running === undefined ? null : leaseStore(liveStoreByJob.get(running.jobId), identity);
            const lease = live ?? leaseStore(ownerStore.get(request.ownerId), identity);
            if (lease === null) return request;
            try {
                const result = await lease.store.getPage(request.pageNumber);
                const layouts = request.options.matchPageSize
                    ? {layoutByPage: {
                        ...request.layoutByPage,
                        ...await readStoreLayouts(lease.store, live === null),
                    }}
                    : {};
                // The plan travels with the page view it was measured on.
                return result?.pagePlanEvidence === undefined
                    ? {
                        ...request,
                        ...layouts,
                    }
                    : {
                        ...request,
                        ...layouts,
                        pagePlanEvidence: result.pagePlanEvidence,
                        ...(result.sourcePageMetadata?.renderBox === 'mediabox'
                            ? {sourcePageMetadata: result.sourcePageMetadata}
                            : {}),
                    };
            } finally {
                lease.release();
            }
        },
        /** A closed document ends its detection and drops its kept evidence. */
        closeSource(ref: TDocumentRef) {
            for (const [
                ownerId,
                detection,
            ] of active) {
                if (detection.request.sourcePdfPath !== ref) continue;
                jobs.cancel(detection.jobId, detection.request, 'Scan cleanup source closed');
                active.delete(ownerId);
            }
            for (const [
                ownerId,
                storeId,
            ] of ownerStore) {
                if (stores.get(storeId)?.identity.sourceRef === ref) retireOwnerStore(ownerId);
            }
        },
    };
}
