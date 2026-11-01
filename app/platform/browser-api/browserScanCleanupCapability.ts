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
import {parseDocumentRevisionToken} from '@contracts/documentRevision';
import {
    createDefaultScanCleanupSettingsFile,
    isScanCleanupSourceSha256,
    type IScanCleanupGlobalPreferences,
    type IScanCleanupSettingsFile,
    type IScanCleanupSettingsReadRequest,
} from '@contracts/scan-cleanup/scanCleanupSettings';
import {BROWSER_PAGE_OPS_MAX_REQUEST_BYTES} from '@contracts/browserPageOpsLimits';
import {isBrowserPageOpsWasmFailure} from '@contracts/browserPageOpsWorker';
import {decodePdfPageSizeRecord} from '@evb/scan-cleanup/core/policy/scanCleanupRasterPolicy';
import {browserDocumentStore} from '@app/platform/browserDocumentStore';
import {loadBrowserPdfjsDocument} from '@app/platform/browser-api/loadBrowserPdfjsDocument';
import {runBrowserPageOpsWorkerRequest} from '@app/platform/browser-api/browserPageOpsWorkerClient';
import {canUseBrowserScanCleanupWorker} from '@app/platform/browser-api/browserScanCleanupWorkerClient';
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
    IBrowserScanCleanupSource,
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
        detection: false,
        calibration: false,
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

interface ISourceSnapshot {
    key: string;
    promise: Promise<IBrowserScanCleanupSource>;
}

const previewRawListeners = new Set<(event: IScanCleanupRawPreviewEvent) => void>();
const settingsListeners = new Set<Parameters<IScanCleanupCapability['onSettingsChanged']>[0]>();

// The capability is the one owner of preview work in this window: one base
// render, one detail render over it, and the last base a detail can refine.
let base: IPreviewWork | null = null;
let detail: IPreviewWork | null = null;
let retainedBase: IRetainedBase | null = null;
let source: ISourceSnapshot | null = null;

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

function releaseSource(snapshot: ISourceSnapshot | null) {
    if (snapshot === null) return;
    void snapshot.promise.then(opened => opened.pdf.loadingTask.destroy()).catch(() => undefined);
}

/**
 * Opens one revision of a source: its page records, read once by the same
 * Rust reader desktop's page-size sidecar runs, and its PDF.js document. A
 * request for another revision replaces the snapshot.
 */
function openSource(ref: string, revision: string, signal: AbortSignal): Promise<IBrowserScanCleanupSource> {
    const key = `${ref}\u0000${revision}`;
    if (source?.key === key) return source.promise;
    const previous = source;
    const promise = (async () => {
        const token = parseDocumentRevisionToken(revision);
        await browserDocumentStore.assertDocumentRevisionCurrent(ref, token);
        const data = await browserDocumentStore.read(ref, {maxBytes: BROWSER_PAGE_OPS_MAX_REQUEST_BYTES});
        // The request that opens the source can cancel it; a failed open is not kept.
        const inspected = await runBrowserPageOpsWorkerRequest('inspectScanCleanupPdf', {
            data,
            pages: [],
        }, {
            dedicated: true,
            signal,
        });
        if (isBrowserPageOpsWasmFailure(inspected)) {
            throw new Error(`Scan cleanup could not read the page geometry: ${inspected.error.message}`);
        }
        const pageSizes = inspected.pages.map((page, index) => decodePdfPageSizeRecord(page, inspected.pageCount, `page ${String(index + 1)}`));
        if (pageSizes.length !== inspected.pageCount || pageSizes.some((page, index) => page.pageNumber !== index + 1)) {
            throw new Error('Scan cleanup page geometry does not cover the document in page order');
        }
        signal.throwIfAborted();
        const pdf = await loadBrowserPdfjsDocument(ref);
        try {
            signal.throwIfAborted();
            await browserDocumentStore.assertDocumentRevisionCurrent(ref, token);
        } catch (error) {
            await pdf.loadingTask.destroy();
            throw error;
        }
        return {
            ref,
            revision,
            pageSizes,
            pdf,
        };
    })();
    source = {
        key,
        promise,
    };
    // A failed open is not kept: the next request tries again.
    promise.catch(() => {
        if (source?.promise === promise) source = null;
    });
    releaseSource(previous);
    return promise;
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
    let opened: IBrowserScanCleanupSource;
    try {
        opened = await openSource(request.sourcePdfPath, request.documentRevision, signal);
    } catch (error) {
        // The request that opened this shared source was canceled, not this one;
        // its failed open is no longer kept, so this one opens it again.
        if (!isAbort(error) || signal.aborted) throw error;
        opened = await openSource(request.sourcePdfPath, request.documentRevision, signal);
    }
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
        const identity = baseIdentity(request);
        return request.detail === undefined
            ? previewBase(request, identity)
            : previewDetail(request, identity);
    },
    resolvePlacementAnchorCalibration() {
        return Promise.reject(new Error(BROWSER_SCAN_CLEANUP_OPERATION_UNAVAILABLE));
    },
    async cancelPreview(request) {
        const owned = (work: IPreviewWork | null) => work !== null
            && work.ownerId === request.ownerId
            && work.ref === request.sourcePdfPath;
        const retiring = [
            base,
            detail,
        ].filter(owned);
        if (owned(base)) base = null;
        if (owned(detail)) detail = null;
        if (retainedBase !== null && retainedBase.ownerId === request.ownerId && retainedBase.ref === request.sourcePdfPath
            && (request.invalidateRawCache === true || !(request.retainPages ?? []).some(page => page === retainedBase?.pageNumber))) {
            retainedBase = null;
        }
        await Promise.all(retiring.map(retire));
        if (request.invalidateRawCache === true && base === null && detail === null) {
            releaseSource(source);
            source = null;
        }
        return retiring.length > 0;
    },
    detectAll: unavailableStart,
    cancelDetection() {
        return Promise.resolve(false);
    },
    getDetectionJobState() {
        return Promise.resolve(null);
    },
    subscribeDetectionJob() {
        return Promise.resolve(null);
    },
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
    onDetectionJobState() {
        return () => undefined;
    },
    onSettingsChanged(listener) {
        settingsListeners.add(listener);
        return () => {
            settingsListeners.delete(listener);
        };
    },
};
