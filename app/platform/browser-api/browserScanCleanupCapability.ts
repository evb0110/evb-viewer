import type {
    IScanCleanupCapability,
    IScanCleanupPreviewRequest,
    IScanCleanupRawPreviewEvent,
    TScanCleanupPreviewWireResult,
} from '@contracts/scan-cleanup/electronApiScanCleanup';
import type {IScanCleanupSupport} from '@contracts/scan-cleanup/scanCleanupPlatformFeature';
import {
    createJobId,
    type TRequestId,
} from '@contracts/shared';
import {
    createDefaultScanCleanupSettingsFile,
    isScanCleanupSourceSha256,
    type IScanCleanupGlobalPreferences,
    type IScanCleanupSettingsFile,
    type IScanCleanupSettingsReadRequest,
} from '@contracts/scan-cleanup/scanCleanupSettings';
import {canUseBrowserScanCleanupWorker} from '@app/platform/browser-api/browserScanCleanupWorkerClient';
import {
    awaitScanCleanupSource,
    borrowBrowserScanCleanupSource,
    scanCleanupSourceKey,
    type TBrowserScanCleanupSourceBorrow,
} from '@app/platform/browser-api/browserScanCleanupSources';
import {createBrowserScanCleanupDetectionOwner} from '@app/platform/browser-api/createBrowserScanCleanupDetectionOwner';
import {onBrowserWorkingCopyClose} from '@app/platform/browser-api/browserWorkingCopyClose';
import {
    adoptScanCleanupDocumentKey,
    loadScanCleanupDocumentEntry,
    loadScanCleanupPreferences,
    saveScanCleanupDocumentPreferences,
    saveScanCleanupPreferences,
    saveScanCleanupPreferencesPatch,
} from '@app/utils/browserScanCleanupPreferences';
import type {
    IBrowserScanCleanupPreviewBase,
    IBrowserScanCleanupPreviewRendering,
} from '@app/platform/browser-api/browserScanCleanupJob';

const BROWSER_SCAN_CLEANUP_OPERATION_UNAVAILABLE = 'This Scan Cleanup operation is not available in the browser yet; use the desktop app.';

/**
 * What the browser can run: the operations whose methods are implemented
 * here, on a runtime that can host the cleanup engine in a worker.
 */
export function getBrowserScanCleanupSupport(): IScanCleanupSupport {
    const engine = canUseBrowserScanCleanupWorker();
    return {
        preview: engine,
        detection: engine,
        calibration: engine,
        conversion: false,
    };
}

type TPreviewResult = Extract<TScanCleanupPreviewWireResult, {pageMetadata: unknown}>;

/** One piece of preview work this capability owns, and how to retire it. */
interface IPreviewWork {
    identity: string;
    ownerId: string;
    ref: string;
    controller: AbortController;
    promise: Promise<IBrowserScanCleanupPreviewRendering>;
}

interface IRetainedBase {
    identity: string;
    ownerId: string;
    ref: string;
    pageNumber: number;
    value: IBrowserScanCleanupPreviewBase;
}

const previewRawListeners = new Set<(event: IScanCleanupRawPreviewEvent) => void>();
const settingsListeners = new Set<Parameters<IScanCleanupCapability['onSettingsChanged']>[0]>();

// The capability is the one owner of preview work in this window: one base
// render, one detail render over it, and the last base a detail can refine.
let base: IPreviewWork | null = null;
let detail: IPreviewWork | null = null;
let retainedBase: IRetainedBase | null = null;
// The source revision previews read, kept between pages until another
// revision is previewed or the preview releases it.
let previewSource: TBrowserScanCleanupSourceBorrow | null = null;

// Preview requests and cancellations claim the preview slot in the order
// they arrive, even when a request first reads its page plan from detection.
// The chain covers only the claim, never the render.
let previewAdmission: Promise<unknown> = Promise.resolve();
function admitPreview<T>(claim: () => Promise<T> | T): Promise<T> {
    const claimed = previewAdmission.then(claim);
    previewAdmission = claimed.then(() => undefined, () => undefined);
    return claimed;
}

const detection = createBrowserScanCleanupDetectionOwner();
// A closed document ends its detection and releases what its previews hold:
// their work, the base a detail would refine, and its source snapshot.
onBrowserWorkingCopyClose(async ref => {
    detection.closeSource(ref);
    const retiring = await admitPreview(() => {
        const claimed = [
            base,
            detail,
        ].filter(work => work !== null && work.ref === ref);
        if (base?.ref === ref) base = null;
        if (detail?.ref === ref) detail = null;
        if (retainedBase?.ref === ref) retainedBase = null;
        if (previewSource?.ref === ref) {
            previewSource.release();
            previewSource = null;
        }
        return claimed;
    });
    await Promise.all(retiring.map(retire));
});

/** What makes two base previews the same picture; a detail adds only its viewport. */
function baseIdentity(request: IScanCleanupPreviewRequest) {
    const {
        requestId: _requestId,
        visible: _visible,
        detail: _detail,
        ...identity
    } = request;
    return JSON.stringify(identity);
}

function isAbort(error: unknown) {
    return error instanceof DOMException && error.name === 'AbortError'
        || (error instanceof Error && error.name === 'AbortError');
}

async function retire(work: IPreviewWork | null) {
    if (work === null) return;
    work.controller.abort(new DOMException('Scan cleanup preview was superseded.', 'AbortError'));
    await work.promise.catch(() => undefined);
}

function startWork(request: IScanCleanupPreviewRequest, identity: string, run: (signal: AbortSignal) => Promise<IBrowserScanCleanupPreviewRendering>): IPreviewWork {
    const controller = new AbortController();
    return {
        identity,
        ownerId: request.ownerId,
        ref: request.sourcePdfPath,
        controller,
        promise: run(controller.signal),
    };
}

async function renderPreview(
    request: IScanCleanupPreviewRequest,
    signal: AbortSignal,
    detailBase: IBrowserScanCleanupPreviewBase | null,
) {
    const {renderBrowserScanCleanupWorkspacePreview} = await import('@app/platform/browser-api/browserScanCleanupJob');
    signal.throwIfAborted();
    const {
        sourcePdfPath: ref, documentRevision: revision,
    } = request;
    // The window keeps the revision open; each render borrows it as well.
    if (previewSource?.key !== scanCleanupSourceKey(ref, revision) || previewSource.stale) {
        previewSource?.release();
        previewSource = borrowBrowserScanCleanupSource(ref, revision);
    }
    const borrow = borrowBrowserScanCleanupSource(ref, revision);
    return awaitScanCleanupSource(borrow.opened, signal).then(opened => {
        signal.throwIfAborted();
        return renderBrowserScanCleanupWorkspacePreview({
            request,
            source: opened,
            signal,
            base: detailBase,
            emitRaw: event => {
                if (signal.aborted) return;
                for (const listener of [...previewRawListeners]) listener(event);
            },
        });
    }).finally(() => borrow.release());
}

function settled(work: IPreviewWork, requestId: TRequestId): Promise<TScanCleanupPreviewWireResult> {
    return work.promise.then(
        rendering => ({
            ...rendering.result as TPreviewResult,
            requestId,
        }),
        (error: unknown) => {
            if (work.controller.signal.aborted || isAbort(error)) return {canceled: true as const};
            throw error;
        },
    );
}

async function previewBase(request: IScanCleanupPreviewRequest, identity: string): Promise<TScanCleanupPreviewWireResult> {
    if (base?.identity === identity && !base.controller.signal.aborted) {
        // The same picture is already being rendered; both callers share it.
        return settled(base, request.requestId);
    }
    // The newest request owns the slot from the moment it arrives, so a later
    // request or a cancel retires it even while it waits for older work to end.
    const previousBase = base;
    const previousDetail = detail;
    const work = startWork(request, identity, async (signal) => {
        await Promise.all([
            retire(previousBase),
            retire(previousDetail),
        ]);
        signal.throwIfAborted();
        return renderPreview(request, signal, null);
    });
    base = work;
    detail = null;
    void work.promise.then(rendering => {
        if (base !== work || rendering.base === null) return;
        retainedBase = {
            identity,
            ownerId: request.ownerId,
            ref: request.sourcePdfPath,
            pageNumber: request.pageNumber,
            value: rendering.base,
        };
    }, () => undefined).finally(() => {
        if (base === work) base = null;
    });
    return settled(work, request.requestId);
}

async function previewDetail(request: IScanCleanupPreviewRequest, identity: string): Promise<TScanCleanupPreviewWireResult> {
    // The base this detail refines may still be rendering under this owner.
    const running = base?.identity === identity ? base : null;
    const previousDetail = detail;
    const work = startWork(request, identity, async (signal) => {
        if (running && !await running.promise.then(() => true, () => false)) {
            throw new DOMException('The base preview did not finish', 'AbortError');
        }
        await retire(previousDetail);
        signal.throwIfAborted();
        if (retainedBase?.identity !== identity) {
            throw new Error('Scan cleanup detail geometry is unavailable; rebuild the base preview');
        }
        return renderPreview(request, signal, retainedBase.value);
    });
    detail = work;
    void work.promise.finally(() => {
        if (detail === work) detail = null;
    }).catch(() => undefined);
    return settled(work, request.requestId);
}

function readSettings(request: IScanCleanupSettingsReadRequest = {}): IScanCleanupSettingsFile {
    const file = createDefaultScanCleanupSettingsFile();
    file.settings = loadScanCleanupPreferences();
    const documentKey = adoptScanCleanupDocumentKey(request.sourceSha256, request.legacyDocumentKey);
    const entry = documentKey === null ? undefined : loadScanCleanupDocumentEntry(documentKey);
    if (entry !== undefined && isScanCleanupSourceSha256(request.sourceSha256)) {
        file.documentOverrides[request.sourceSha256.toLowerCase()] = entry;
    }
    return file;
}

function announceSettings(settings: IScanCleanupGlobalPreferences, requestId: TRequestId | undefined) {
    for (const listener of [...settingsListeners]) {
        listener({
            settings,
            ...(requestId === undefined ? {} : {requestId}),
        });
    }
}

function unavailableStart() {
    return Promise.resolve({
        started: false as const,
        jobId: createJobId('browser-scan-cleanup-unavailable'),
        error: BROWSER_SCAN_CLEANUP_OPERATION_UNAVAILABLE,
        errorCode: 'tools-unavailable' as const,
    });
}

export const browserScanCleanupCapability: IScanCleanupCapability = {
    getSupport: getBrowserScanCleanupSupport,
    preview(request) {
        // The browser declines speculative neighbour previews: they would
        // occupy the one engine the visible page needs. A visible base or a
        // detail over it is the only work admitted.
        if (request.visible !== true && request.detail === undefined) {
            return Promise.resolve({canceled: true});
        }
        return admitPreview(async () => {
            const planned = await detection.resolvePreviewPagePlan(request);
            const identity = baseIdentity(planned);
            return {settled: planned.detail === undefined
                ? previewBase(planned, identity)
                : previewDetail(planned, identity)};
        }).then(({settled}) => settled);
    },
    resolvePlacementAnchorCalibration: request => detection.resolvePlacementAnchorCalibration(request),
    async cancelPreview(request) {
        const retiring = await admitPreview(() => {
            const owned = (work: IPreviewWork | null) => work !== null
                && work.ownerId === request.ownerId
                && work.ref === request.sourcePdfPath;
            const claimed = [
                base,
                detail,
            ].filter(owned);
            if (owned(base)) base = null;
            if (owned(detail)) detail = null;
            if (retainedBase !== null && retainedBase.ownerId === request.ownerId && retainedBase.ref === request.sourcePdfPath
                && (request.invalidateRawCache === true || !(request.retainPages ?? []).some(page => page === retainedBase?.pageNumber))) {
                retainedBase = null;
            }
            return claimed;
        });
        await Promise.all(retiring.map(retire));
        if (request.invalidateRawCache === true && base === null && detail === null) {
            previewSource?.release();
            previewSource = null;
        }
        return retiring.length > 0;
    },
    detectAll: request => detection.detectAll(request),
    cancelDetection: (jobId, owner) => detection.cancelDetection(jobId, owner),
    getDetectionJobState: (jobId, owner) => detection.getDetectionJobState(jobId, owner),
    subscribeDetectionJob: (jobId, owner) => detection.subscribeDetectionJob(jobId, owner),
    start: unavailableStart,
    cancel() {
        return Promise.resolve(false);
    },
    getJobState() {
        return Promise.resolve(null);
    },
    subscribeJob() {
        return Promise.resolve(null);
    },
    reconnectJob() {
        return Promise.resolve(null);
    },
    pruneGeneratedOutputs() {
        return Promise.resolve(0);
    },
    getPendingCompletedOutputs() {
        return Promise.resolve([]);
    },
    acknowledgeCompletedOutputs() {
        return Promise.resolve();
    },
    getSettings(request) {
        try {
            return Promise.resolve(readSettings(request));
        } catch (error) {
            return Promise.reject(error);
        }
    },
    updateSettings(request) {
        try {
            if (request.settings !== undefined && request.settingsPatch !== undefined) {
                throw new Error('Scan-cleanup settings and settingsPatch cannot be supplied together');
            }
            // Each write throws when storage refuses it, so nothing is
            // announced that was not saved.
            let settings: IScanCleanupGlobalPreferences | null = null;
            if (request.settings !== undefined) {
                saveScanCleanupPreferences(request.settings);
                settings = loadScanCleanupPreferences();
            }
            if (request.settingsPatch !== undefined) {
                settings = saveScanCleanupPreferencesPatch(request.settingsPatch);
            }
            if (request.document !== undefined) {
                saveScanCleanupDocumentPreferences(
                    adoptScanCleanupDocumentKey(request.document.sourceSha256, request.document.legacyDocumentKey),
                    request.document.patch,
                );
            }
            if (settings !== null) announceSettings(settings, request.requestId);
            return Promise.resolve(readSettings(request.document === undefined
                ? {}
                : {
                    sourceSha256: request.document.sourceSha256,
                    ...(request.document.legacyDocumentKey === undefined ? {} : {legacyDocumentKey: request.document.legacyDocumentKey}),
                }));
        } catch (error) {
            return Promise.reject(error);
        }
    },
    onPreviewRaw(listener) {
        previewRawListeners.add(listener);
        return () => {
            previewRawListeners.delete(listener);
        };
    },
    onJobState() {
        return () => undefined;
    },
    onDetectionJobState: listener => detection.onDetectionJobState(listener),
    onSettingsChanged(listener) {
        settingsListeners.add(listener);
        return () => {
            settingsListeners.delete(listener);
        };
    },
};
