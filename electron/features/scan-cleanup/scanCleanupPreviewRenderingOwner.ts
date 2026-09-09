import type {
    IScanCleanupOwnerContext,
    IScanCleanupPreviewCancelRequest,
    IScanCleanupPreviewRequest,
    TScanCleanupPreviewWireResult,
} from '@contracts/electronApiScanCleanup';
import {SCAN_CLEANUP_PLATFORM_FEATURE} from '@contracts/scanCleanupPlatformFeature';
import {classifyScanCleanupPreviewError as classifyScanCleanupError} from '@electron/features/scan-cleanup/scanCleanupPreviewPolicy';
import { createStableJobBrokerOwnerId } from '@electron/resources/jobBroker';
import { getErrorMessage } from '@electron/utils/error';
import {encodeSerializableErrorEnvelope} from '@contracts/serializableError';
import {createJobId} from '@contracts/shared';
import {
    createMainJobRegistry,
    type IMainJobErrorEnvelope,
} from '@electron/operation-lifecycle/createMainJobRegistry';

import type {
    IBasePreviewAnalysis,
    IPreviewAdmission,
    IPreviewEntry,
    IScanCleanupDetectionSubscriber,
    IScanCleanupRenderingDependencies,
    IScanCleanupPreviewOwnerRetention,
} from '@electron/features/scan-cleanup/scanCleanupPreviewShared';
import {
    PREVIEW_PREFETCH_LEASE_TIMEOUT_MS,
    PREVIEW_ADMISSION_REISSUED,
    isPreviewCancellation,
} from '@electron/features/scan-cleanup/scanCleanupPreviewShared';
import {scanCleanupPreviewRenderer} from '@electron/features/scan-cleanup/scanCleanupPreviewRenderer';
import {previewIdentityKey} from '@electron/features/scan-cleanup/scanCleanupPreviewSupport';
import {removeBaseAnalysisArtifacts} from '@electron/features/scan-cleanup/scanCleanupPreviewRenderingPipeline';
export interface IScanCleanupPreviewRenderingOwner {
    preview: (
        sender: IScanCleanupDetectionSubscriber,
        request: IScanCleanupPreviewRequest,
    ) => Promise<TScanCleanupPreviewWireResult>;
    cancel: (
        sender: IScanCleanupDetectionSubscriber,
        request: IScanCleanupPreviewCancelRequest,
    ) => boolean;
    dispose: () => Promise<void>;
}

interface IScanCleanupPreviewProgress {
    stage: 'previewing';
    completedUnits: number;
    totalUnits: number;
    percent: number;
}

interface IScanCleanupPreviewError extends IMainJobErrorEnvelope {code: string;}

export function scanCleanupPreviewRenderingOwner(
    dependencies: IScanCleanupRenderingDependencies,
    rawRasterRetention: IScanCleanupPreviewOwnerRetention,
): IScanCleanupPreviewRenderingOwner {
    const active = new Map<string, IPreviewEntry>();
    const baseAnalysisCache = new Map<string, IBasePreviewAnalysis>();
    const baseAnalysisPins = new Map<string, number>();
    const pendingBaseAnalysisRemovals = new Map<string, IBasePreviewAnalysis[]>();
    const deferredBaseAnalysisInvalidations = new Set<string>();
    const baseAnalysisCleanupPromises = new Set<Promise<void>>();
    const scheduleBaseAnalysisRemoval = (analysis: IBasePreviewAnalysis, analysisKey?: string) => {
        if (analysisKey !== undefined && (baseAnalysisPins.get(analysisKey) ?? 0) > 0) {
            const pending = pendingBaseAnalysisRemovals.get(analysisKey) ?? [];
            pending.push(analysis);
            pendingBaseAnalysisRemovals.set(analysisKey, pending);
            return Promise.resolve();
        }
        const cleanup = removeBaseAnalysisArtifacts(analysis, dependencies);
        baseAnalysisCleanupPromises.add(cleanup);
        void cleanup.finally(() => baseAnalysisCleanupPromises.delete(cleanup)).catch(() => undefined);
        return cleanup;
    };
    const releaseBaseAnalysisPin = (analysisKey: string) => {
        const pins = baseAnalysisPins.get(analysisKey) ?? 0;
        if (pins <= 1) {
            baseAnalysisPins.delete(analysisKey);
            const pending = pendingBaseAnalysisRemovals.get(analysisKey);
            if (pending) {
                pendingBaseAnalysisRemovals.delete(analysisKey);
                pending.forEach(analysis => {
                    void scheduleBaseAnalysisRemoval(analysis);
                });
            }
        } else {
            baseAnalysisPins.set(analysisKey, pins - 1);
        }
    };
    const previewJobs = createMainJobRegistry<
        IScanCleanupPreviewProgress,
        TScanCleanupPreviewWireResult,
        IScanCleanupPreviewError,
        IScanCleanupDetectionSubscriber
    >({
        retention: {
            eventReplayTtlMs: 60_000,
            terminalRecordTtlMs: 60_000,
        },
        unbindOnSettlement: true,
        ...(dependencies.mainJobScratch === undefined ? {} : {scratch: dependencies.mainJobScratch}),
        toError: (cause, kind) => ({
            code: classifyScanCleanupError(cause, kind === 'canceled'),
            message: getErrorMessage(cause) || 'Scan cleanup preview failed',
            ...(kind === 'canceled' ? {name: 'AbortError'} : {}),
        }),
        terminalProgress: {
            completed: latest => ({
                ...latest,
                completedUnits: 1,
                totalUnits: 1,
                percent: 100,
            }),
            canceled: latest => latest,
            failed: latest => latest,
        },
    });
    const disposeBaseAnalysisCache = async () => {
        const analyses = [...baseAnalysisCache.values()];
        baseAnalysisCache.clear();
        analyses.forEach(analysis => scheduleBaseAnalysisRemoval(analysis));
        pendingBaseAnalysisRemovals.forEach(analyses => {
            analyses.forEach(analysis => scheduleBaseAnalysisRemoval(analysis));
        });
        pendingBaseAnalysisRemovals.clear();
        await Promise.all([...baseAnalysisCleanupPromises]);
    };
    const baseAnalysisDocumentKey = (sourcePdfPath: string, documentRevision: string) =>
        `${documentRevision}\u0000${sourcePdfPath}`;
    const removeBaseAnalysisForDocument = (sourcePdfPath: string, documentRevision: string) => {
        for (const [
            key,
            analysis,
        ] of baseAnalysisCache) {
            if (
                analysis.sourcePdfPath === sourcePdfPath
                && analysis.documentRevision === documentRevision
            ) {
                baseAnalysisCache.delete(key);
                if ((baseAnalysisPins.get(key) ?? 0) > 0) {
                    const pending = pendingBaseAnalysisRemovals.get(key) ?? [];
                    pending.push(analysis);
                    pendingBaseAnalysisRemovals.set(key, pending);
                }
                else void scheduleBaseAnalysisRemoval(analysis);
            }
        }
    };
    const previewOwnerPrefix = (
        sender: IScanCleanupDetectionSubscriber,
        owner: IScanCleanupOwnerContext,
    ) => `${sender.id}\u0000${owner.ownerId}\u0000`;
    const brokerOwnerId = (
        sender: IScanCleanupDetectionSubscriber,
        owner: IScanCleanupOwnerContext,
    ) => createStableJobBrokerOwnerId('scan-cleanup', sender.id, owner.ownerId);
    const previewDocumentPrefix = (
        sender: IScanCleanupDetectionSubscriber,
        request: IScanCleanupOwnerContext & {sourcePdfPath: string},
    ) => `${previewOwnerPrefix(sender, request)}${request.documentRevision}\u0000${request.sourcePdfPath}\u0000`;
    // The page the user navigated onto, named by the request that streams its
    // raw raster back, so the adjacent prefetches that do not are admitted
    // behind it. One entry per document an owner is working on, dropped when
    // that owner moves on or cancels the document.
    const visiblePages = new Map<string, number>();
    const abortStalePreviewRequests = (
        sender: IScanCleanupDetectionSubscriber,
        request: IScanCleanupOwnerContext & {sourcePdfPath: string},
    ) => {
        const ownerPrefix = previewOwnerPrefix(sender, request);
        const documentPrefix = previewDocumentPrefix(sender, request);
        for (const [
            key,
            entry,
        ] of active) {
            if (key.startsWith(ownerPrefix) && !key.startsWith(documentPrefix)) {
                entry.cancel('Stale scan cleanup preview document');
            }
        }
        // The owner moved to another document or revision, so the page it was
        // looking at in the old one is not a visible page any more. Without
        // this the map keeps one entry per document a session ever opened.
        for (const key of visiblePages.keys()) {
            if (key.startsWith(ownerPrefix) && key !== documentPrefix) visiblePages.delete(key);
        }
        return documentPrefix;
    };
    const previewLanePrefix = (
        documentPrefix: string,
        request: IScanCleanupPreviewRequest,
    ) => `${documentPrefix}${request.detail === undefined ? 'base' : 'detail'}\u0000`;
    const withPreviewLease = async <T>(
        documentPrefix: string,
        admission: IPreviewAdmission,
        signal: AbortSignal,
        run: () => Promise<T>,
    ) => {
        signal.throwIfAborted();
        const acquire = dependencies.acquirePreviewLease;
        if (!acquire) throw new Error('Scan cleanup preview requires injected admission capability');
        let lease: {release: () => boolean};
        for (;;) {
            const attempt = new AbortController();
            const abortAttempt = () => attempt.abort(signal.reason);
            signal.addEventListener('abort', abortAttempt, {once: true});
            admission.reissue = () => attempt.abort(PREVIEW_ADMISSION_REISSUED);
            try {
                lease = await acquire(documentPrefix, admission.visibility, attempt.signal);
                admission.granted = true;
                break;
            } catch (error) {
                signal.throwIfAborted();
                // Anything but a readmission is the request's own failure.
                if (attempt.signal.reason !== PREVIEW_ADMISSION_REISSUED) throw error;
            } finally {
                signal.removeEventListener('abort', abortAttempt);
                admission.reissue = null;
            }
        }
        try {
            return await run();
        } finally {
            lease.release();
        }
    };
    // Request identity is the page and the content that would be rendered, not
    // just the document and the lane. Two requests that would produce the same
    // result now share one run instead of the second aborting the first.
    const previewRequestKey = (documentPrefix: string, request: IScanCleanupPreviewRequest) => {
        const {
            detail,
            ...base
        } = request;
        return `${previewLanePrefix(documentPrefix, request)}${previewIdentityKey(base)}\u0000${
            detail === undefined ? '' : JSON.stringify(detail)
        }`;
    };
    const cancelPreviewRequest = (
        sender: IScanCleanupDetectionSubscriber,
        request: IScanCleanupPreviewCancelRequest,
        reason: string,
    ) => {
        const documentPrefix = previewDocumentPrefix(sender, request);
        // A navigation names the pages it is moving into; only work for
        // pages outside that window is discarded. Without a window the
        // caller means the whole document: a settings change, a new
        // revision, a session shutting down, or a renderer that is gone.
        const documentToken = `\u0000${request.documentRevision}\u0000${request.sourcePdfPath}\u0000`;
        const retained = new Set(request.retainPages ?? []);
        const canceledEntries: IPreviewEntry[] = [];
        const otherOwnerHasWork = [...active.entries()].some(([
            key,
            entry,
        ]) => (
            key.includes(documentToken)
            && (!key.startsWith(previewOwnerPrefix(sender, request)) || retained.has(entry.pageNumber))
        ));
        let canceled = false;
        for (const [
            key,
            entry,
        ] of active) {
            if (key.startsWith(documentPrefix) && !retained.has(entry.pageNumber)) {
                if (request.invalidateRawCache === false) entry.canceledAsResult = true;
                canceledEntries.push(entry);
                entry.cancel(reason);
                canceled = true;
            }
        }
        // A windowed cancellation is always issued for a navigation that
        // still wants the visible page, so only a whole-document
        // cancellation forgets which page that is.
        if (request.retainPages === undefined) visiblePages.delete(documentPrefix);
        if (request.invalidateRawCache !== false) {
            const claimIds = canceledEntries.map(entry => entry.claimId);
            if (claimIds.length === 0 && !otherOwnerHasWork) {
                rawRasterRetention.invalidate(request.sourcePdfPath, request.documentRevision);
            } else {
                for (const claimId of claimIds) {
                    rawRasterRetention.invalidate(
                        request.sourcePdfPath,
                        request.documentRevision,
                        claimId,
                    );
                }
            }
            const documentKey = baseAnalysisDocumentKey(request.sourcePdfPath, request.documentRevision);
            if (otherOwnerHasWork) {
                deferredBaseAnalysisInvalidations.add(documentKey);
            } else {
                removeBaseAnalysisForDocument(request.sourcePdfPath, request.documentRevision);
            }
        }
        return canceled;
    };
    return {
        async dispose() {
            for (const entry of active.values()) {
                entry.cancel('Scan cleanup preview service disposed');
            }
            await Promise.allSettled([...active.values()].map(entry => entry.tail));
            active.clear();
            visiblePages.clear();
            deferredBaseAnalysisInvalidations.clear();
            baseAnalysisPins.clear();
            await previewJobs.clearForTests();
            await disposeBaseAnalysisCache();
        },
        preview(sender, request) {
            if (sender.isDestroyed()) {
                return Promise.resolve({canceled: true} as const);
            }
            const documentPrefix = abortStalePreviewRequests(sender, request);
            // The renderer names the page the user is looking at on the request
            // that will display it; everything else is an adjacent prefetch.
            if (request.visible === true) visiblePages.set(documentPrefix, request.pageNumber);
            const activeKey = previewRequestKey(documentPrefix, request);
            // Navigating onto a page whose prefetch is still running adopts that
            // run: no second raster, no second sidecar, and the caller inherits
            // the progress already made rather than restarting it. A run that
            // has already been aborted has nothing to inherit and is left to
            // retire; this request starts its own.
            const adopted = active.get(activeKey);
            if (adopted && !adopted.signal.aborted) {
                // The adopted run was admitted as background work. It is now the
                // page the user is waiting on, so it is readmitted as one rather
                // than holding its place in a queue behind detection.
                if (request.visible === true && adopted.admission.visibility === 'prefetch') {
                    adopted.admission.visibility = 'visible';
                    adopted.admission.reissue?.();
                }
                return adopted.tail;
            }
            // A base request only supersedes work for its own page: a stale
            // options generation for the page being rendered. Adjacent prefetches
            // for other pages are the renderer's to retire, through `cancel`.
            // A detail tile is the one visible viewport, so it supersedes the
            // whole detail lane and still never touches the base lane.
            const lanePrefix = previewLanePrefix(documentPrefix, request);
            const superseded: IPreviewEntry[] = [];
            for (const [
                key,
                entry,
            ] of active) {
                if (
                    key.startsWith(lanePrefix)
                    && (request.detail !== undefined || entry.pageNumber === request.pageNumber)
                ) {
                    superseded.push(entry);
                    entry.cancel('Superseded scan cleanup preview');
                }
            }
            // The generation counts replacements of *this* key. Taking it from
            // whichever superseded entry the lane happened to iterate first
            // could hand a live entry the generation an older one is still
            // carrying, and that entry's late tail would then delete the
            // replacement out of the index.
            const generation = (active.get(activeKey)?.generation ?? 0) + 1;
            const priorTail = Promise.all(superseded.map(entry => entry.tail.catch(() => undefined)));
            // A detail tile is the viewport the user is looking at. The renderer
            // names normal visible pages explicitly; page one is the safe
            // startup fallback for older callers that have not done so yet.
            // Every other unnamed page is an adjacent prefetch.
            const visiblePage = visiblePages.get(documentPrefix);
            const admission: IPreviewAdmission = {
                granted: false,
                reissue: null,
                visibility: request.detail !== undefined
                    ? 'detail'
                    : request.visible === true
                    || (visiblePage === undefined && request.pageNumber === 1)
                    || visiblePage === request.pageNumber
                        ? 'visible'
                        : 'prefetch',
            };
            const entryStateRef: {current?: IPreviewEntry} = {};
            const handle = previewJobs.start({
                jobId: createJobId('scan-cleanup-preview'),
                owner: {
                    sender,
                    ownerId: request.ownerId,
                    documentRevision: request.documentRevision,
                },
                operation: {
                    kind: 'abortable-work',
                    workingCopyPath: request.sourcePdfPath,
                    cancelOnWorkingCopyClose: true,
                },
                initialProgress: {
                    stage: 'previewing',
                    completedUnits: 0,
                    totalUnits: 1,
                    percent: 0,
                },
                ownerLifecycle: {
                    destroyed: 'cancel',
                    renderProcessGone: 'cancel',
                    mainFrameNavigation: 'cancel',
                },
                run: async context => priorTail.then(async () => context.scratch.using<TScanCleanupPreviewWireResult>('pdfExport-', async scratchPath => {
                    let materialized;
                    try {
                        materialized = await dependencies.materializeRequest(
                            request,
                            sender.id,
                            context.signal,
                            dependencies,
                        );
                    } catch (error) {
                        if (getErrorMessage(error) === 'Scan cleanup source is no longer available') {
                            return {canceled: true} as const;
                        }
                        throw error;
                    }
                    return withPreviewLease(brokerOwnerId(sender, request), admission, context.signal, async () => {
                        const result = await scanCleanupPreviewRenderer(
                            materialized,
                            context.signal,
                            rawRasterRetention,
                            baseAnalysisCache,
                            dependencies,
                            raw => sender.send(SCAN_CLEANUP_PLATFORM_FEATURE.eventChannels.onPreviewRaw, raw),
                            scratchPath,
                            baseAnalysisPins,
                            scheduleBaseAnalysisRemoval,
                            handle.jobId,
                            releaseBaseAnalysisPin,
                        );
                        if (context.signal.aborted) throw context.signal.reason;
                        return result.canceled === true
                            ? result
                            : {
                                ...result,
                                requestId: materialized.requestId,
                            };
                    });
                })).catch(error => {
                    if (isPreviewCancellation(error)) {
                        throw error;
                    }
                    throw new Error(encodeSerializableErrorEnvelope({
                        code: classifyScanCleanupError(error, false),
                        message: getErrorMessage(error) || 'Scan cleanup preview failed',
                    }));
                }),
            });
            const tail: Promise<TScanCleanupPreviewWireResult> = handle.terminal.then(snapshot => {
                if (snapshot.status === 'completed') {
                    return snapshot.result;
                }
                if (snapshot.status === 'canceled') {
                    if (entryStateRef.current?.canceledAsResult === true || snapshot.error.message.startsWith('Dropped scan cleanup preview')) {
                        return {canceled: true} as const;
                    }
                    throw Object.assign(new Error(snapshot.error.message), snapshot.error);
                }
                const serialized = snapshot.error.message.match(/^EVB_SERIALIZABLE_ERROR:(.*)$/s)?.[1];
                if (serialized !== undefined) {
                    const error = JSON.parse(serialized) as {
                        code: string;
                        message: string
                    };
                    throw new Error(encodeSerializableErrorEnvelope(error));
                }
                throw new Error(encodeSerializableErrorEnvelope(snapshot.error));
            });
            const settledTail = tail.then(
                async result => {
                    await handle.settled;
                    return result;
                },
                async error => {
                    await handle.settled;
                    throw error;
                },
            );
            const cancel = (reason?: string) => {
                if (!admission.granted) entryStateRef.current!.canceledAsResult = true;
                return handle.cancel(reason);
            };
            const entryState: IPreviewEntry = {
                admission,
                canceledAsResult: false,
                signal: handle.signal,
                cancel,
                generation,
                pageNumber: request.pageNumber,
                claimId: handle.jobId,
                tail: settledTail,
            };
            entryStateRef.current = entryState;
            active.set(activeKey, entryState);
            if (admission.visibility === 'prefetch') {
                const drop = setTimeout(() => {
                    if (admission.granted || admission.visibility !== 'prefetch') {
                        return;
                    }
                    cancel('Dropped scan cleanup preview prefetch');
                }, dependencies.prefetchLeaseTimeoutMs ?? PREVIEW_PREFETCH_LEASE_TIMEOUT_MS);
                void tail.catch(() => undefined).finally(() => clearTimeout(drop));
            }
            void settledTail.finally(() => {
                if (active.get(activeKey)?.generation === generation) active.delete(activeKey);
                const documentKey = baseAnalysisDocumentKey(request.sourcePdfPath, request.documentRevision);
                const documentStillActive = [...active.keys()].some(key => key.includes(
                    `\u0000${request.documentRevision}\u0000${request.sourcePdfPath}\u0000`,
                ));
                if (!documentStillActive && deferredBaseAnalysisInvalidations.delete(documentKey)) {
                    removeBaseAnalysisForDocument(request.sourcePdfPath, request.documentRevision);
                }
            }).catch(() => undefined);
            return settledTail;
        },
        cancel(sender, request) {
            return cancelPreviewRequest(sender, request, 'Canceled scan cleanup preview');
        },
    };
}
