import type {IDjvuCapability} from '@contracts/djvuPlatformFeature';
import type {IOcrCapability} from '@contracts/ocrPlatformFeature';
import type {IPlatformApi} from '@contracts/platformApi';
import {inspectAllowedExternalUrl} from '@contracts/externalUrl';
import type {SHELL_PLATFORM_FEATURE} from '@contracts/shellPlatformFeature';
import type {TFeatureBrowserBindings, TFeatureSyncBindings} from '@contracts/platformFeature';
import type {IScanCleanupCapability, IScanCleanupSupport} from '@contracts/scan-cleanup/scanCleanupPlatformFeature';
import type {ISearchCapability} from '@contracts/searchPlatformFeature';
import type {SYSTEM_PLATFORM_FEATURE} from '@contracts/systemPlatformFeature';
import {browserWindowTabsCapability} from '@app/platform/browserWindowTabs';
import {browserAgentCapability} from '@app/platform/browser-api/browserAgentCapability';
import {browserHostCapability} from '@app/platform/browser-api/browserHostCapability';
import {browserSettingsCapability} from '@app/platform/browser-api/browserSettingsCapability';
import {createBrowserDocumentsCapability} from '@app/platform/browser-api/createBrowserDocumentsCapability';
import type {IBrowserExtensionPrefetchedLaunch} from '@app/platform/browser-api/openBrowserExtensionDocument';
export type {IBrowserExtensionPrefetchedLaunch};
import {BrowserLogger} from '@app/utils/browserLogger';

interface IBufferedSubscription<TCapability> {
    attach: (capability: TCapability) => () => void;
    unsubscribe: (() => void) | null;
}

function createLazyCapabilityLoader<TCapability>(load: () => Promise<TCapability>) {
    let loaded: TCapability | null = null;
    let pending: Promise<TCapability> | null = null;
    const subscriptions = new Set<IBufferedSubscription<TCapability>>();

    function getLoaded() {
        return loaded;
    }

    function isPending() {
        return pending !== null;
    }

    function ensureLoaded(): Promise<TCapability> {
        if (loaded !== null) {
            return Promise.resolve(loaded);
        }
        pending ??= load().then(
            (capability) => {
                loaded = capability;
                for (const subscription of subscriptions) {
                    subscription.unsubscribe = subscription.attach(capability);
                }
                return capability;
            },
            (error: unknown) => {
                pending = null;
                throw error;
            },
        );
        return pending;
    }

    function subscribe(attach: (capability: TCapability) => () => void): () => void {
        if (loaded !== null) {
            return attach(loaded);
        }
        const entry: IBufferedSubscription<TCapability> = {
            attach,
            unsubscribe: null,
        };
        subscriptions.add(entry);
        return () => {
            subscriptions.delete(entry);
            entry.unsubscribe?.();
            entry.unsubscribe = null;
        };
    }

    return {
        getLoaded,
        isPending,
        ensureLoaded,
        subscribe,
    };
}

function getBrowserScanCleanupSupportSync(): IScanCleanupSupport {
    const engine =
        typeof WebAssembly !== 'undefined' &&
        typeof window !== 'undefined' &&
        typeof Worker !== 'undefined' &&
        typeof OffscreenCanvas !== 'undefined' &&
        typeof createImageBitmap === 'function';
    return {
        preview: engine,
        detection: engine,
        calibration: engine,
        conversion: engine,
    };
}

const ocrLoader = createLazyCapabilityLoader<IOcrCapability>(async () => {
    const module = await import('@app/platform/browser-api/browserOcrCapability');
    return module.browserOcrCapability;
});

const lazyBrowserOcrCapability: IOcrCapability = {
    cancel: (requestId) => {
        const loaded = ocrLoader.getLoaded();
        if (loaded) {
            return loaded.cancel(requestId);
        }
        return ocrLoader.isPending()
            ? ocrLoader.ensureLoaded().then((capability) => capability.cancel(requestId))
            : Promise.resolve({canceled: false, reason: 'not-found'});
    },
    getLanguages: () => ocrLoader.ensureLoaded().then((capability) => capability.getLanguages()),
    resolveDocumentTextCatalog: (...args) => ocrLoader.ensureLoaded().then((capability) => capability.resolveDocumentTextCatalog(...args)),
    resolveDocumentTextCatalogWindow: (...args) =>
        ocrLoader.ensureLoaded().then((capability) => capability.resolveDocumentTextCatalogWindow(...args)),
    acknowledgeResultFile: (...args) => {
        const loaded = ocrLoader.getLoaded();
        if (loaded) {
            return loaded.acknowledgeResultFile(...args);
        }
        return ocrLoader.isPending()
            ? ocrLoader.ensureLoaded().then((capability) => capability.acknowledgeResultFile(...args))
            : Promise.resolve({cleaned: false});
    },
    createSearchablePdf: (...args) => ocrLoader.ensureLoaded().then((capability) => capability.createSearchablePdf(...args)),
    onProgress: (listener) => ocrLoader.subscribe((capability) => capability.onProgress(listener)),
    onComplete: (listener) => ocrLoader.subscribe((capability) => capability.onComplete(listener)),
};

const scanCleanupLoader = createLazyCapabilityLoader<IScanCleanupCapability>(async () => {
    const module = await import('@app/platform/browser-api/browserScanCleanupCapability');
    return module.browserScanCleanupCapability;
});

const lazyBrowserScanCleanupCapability: IScanCleanupCapability = {
    getSupport: getBrowserScanCleanupSupportSync,
    preview: (request) => scanCleanupLoader.ensureLoaded().then((capability) => capability.preview(request)),
    resolvePlacementAnchorCalibration: (request) =>
        scanCleanupLoader.ensureLoaded().then((capability) => capability.resolvePlacementAnchorCalibration!(request)),
    cancelPreview: (request) => {
        const loaded = scanCleanupLoader.getLoaded();
        if (loaded) {
            return loaded.cancelPreview(request);
        }
        return scanCleanupLoader.isPending()
            ? scanCleanupLoader.ensureLoaded().then((capability) => capability.cancelPreview(request))
            : Promise.resolve(false);
    },
    detectAll: (request) => scanCleanupLoader.ensureLoaded().then((capability) => capability.detectAll(request)),
    cancelDetection: (jobId, owner) => {
        const loaded = scanCleanupLoader.getLoaded();
        if (loaded) {
            return loaded.cancelDetection(jobId, owner);
        }
        return scanCleanupLoader.isPending()
            ? scanCleanupLoader.ensureLoaded().then((capability) => capability.cancelDetection(jobId, owner))
            : Promise.resolve(false);
    },
    getDetectionJobState: (jobId, owner) => {
        const loaded = scanCleanupLoader.getLoaded();
        if (loaded) {
            return loaded.getDetectionJobState(jobId, owner);
        }
        return scanCleanupLoader.isPending()
            ? scanCleanupLoader.ensureLoaded().then((capability) => capability.getDetectionJobState(jobId, owner))
            : Promise.resolve(null);
    },
    subscribeDetectionJob: (jobId, owner) =>
        scanCleanupLoader.ensureLoaded().then((capability) => capability.subscribeDetectionJob(jobId, owner)),
    start: (request) => scanCleanupLoader.ensureLoaded().then((capability) => capability.start(request)),
    cancel: (jobId, owner) => {
        const loaded = scanCleanupLoader.getLoaded();
        if (loaded) {
            return loaded.cancel(jobId, owner);
        }
        return scanCleanupLoader.isPending()
            ? scanCleanupLoader.ensureLoaded().then((capability) => capability.cancel(jobId, owner))
            : Promise.resolve(false);
    },
    getJobState: (jobId, owner) => {
        const loaded = scanCleanupLoader.getLoaded();
        if (loaded) {
            return loaded.getJobState(jobId, owner);
        }
        return scanCleanupLoader.isPending()
            ? scanCleanupLoader.ensureLoaded().then((capability) => capability.getJobState(jobId, owner))
            : Promise.resolve(null);
    },
    subscribeJob: (jobId, owner) => scanCleanupLoader.ensureLoaded().then((capability) => capability.subscribeJob(jobId, owner)),
    reconnectJob: (jobId, owner) => scanCleanupLoader.ensureLoaded().then((capability) => capability.reconnectJob(jobId, owner)),
    pruneGeneratedOutputs: () => Promise.resolve(0),
    getPendingCompletedOutputs: () => Promise.resolve([]),
    acknowledgeCompletedOutputs: () => Promise.resolve(undefined),
    getSettings: (request) => scanCleanupLoader.ensureLoaded().then((capability) => capability.getSettings!(request)),
    updateSettings: (request) => scanCleanupLoader.ensureLoaded().then((capability) => capability.updateSettings!(request)),
    onPreviewRaw: (listener) => scanCleanupLoader.subscribe((capability) => capability.onPreviewRaw(listener)),
    onJobState: (listener) => scanCleanupLoader.subscribe((capability) => capability.onJobState(listener)),
    onDetectionJobState: (listener) => scanCleanupLoader.subscribe((capability) => capability.onDetectionJobState(listener)),
    onSettingsChanged: (listener) => scanCleanupLoader.subscribe((capability) => capability.onSettingsChanged(listener)),
};

const searchLoader = createLazyCapabilityLoader<{
    capability: ISearchCapability;
    clearSearchCaches: (pdfPath?: string) => Promise<void>;
}>(async () => {
    const module = await import('@app/platform/browser-api/createBrowserSearchCapability');
    return module.createBrowserSearchCapability();
});

const lazyBrowserSearchCapability: ISearchCapability = {
    run: (pdfPath, query, options) => searchLoader.ensureLoaded().then(({capability}) => capability.run(pdfPath, query, options)),
    warmIndex: (pdfPath, options) => searchLoader.ensureLoaded().then(({capability}) => capability.warmIndex(pdfPath, options)),
    cancel: (requestId) => {
        const loaded = searchLoader.getLoaded();
        if (loaded) {
            return loaded.capability.cancel(requestId);
        }
        return searchLoader.isPending()
            ? searchLoader.ensureLoaded().then(({capability}) => capability.cancel(requestId))
            : Promise.resolve({canceled: false});
    },
    resetCache: () => searchLoader.ensureLoaded().then(({capability}) => capability.resetCache()),
    onProgress: (listener) => searchLoader.subscribe(({capability}) => capability.onProgress(listener)),
};

const djvuLoader = createLazyCapabilityLoader<IDjvuCapability>(async () => {
    const module = await import('@app/platform/browser-api/browserDjvuCapability');
    return module.browserDjvuCapability;
});

const lazyBrowserDjvuCapability: IDjvuCapability = {
    startOpenForViewing: (djvuPath, requestId) =>
        djvuLoader.ensureLoaded().then((capability) => capability.startOpenForViewing(djvuPath, requestId)),
    releaseViewingPath: (djvuPath) => {
        const loaded = djvuLoader.getLoaded();
        if (loaded) {
            return loaded.releaseViewingPath(djvuPath);
        }
        return djvuLoader.isPending()
            ? djvuLoader.ensureLoaded().then((capability) => capability.releaseViewingPath(djvuPath))
            : Promise.resolve(undefined);
    },
    startConvertToPdf: (djvuPath, outputPath, options) =>
        djvuLoader.ensureLoaded().then((capability) => capability.startConvertToPdf(djvuPath, outputPath, options)),
    printDjvuPath: (djvuPath, options) => djvuLoader.ensureLoaded().then((capability) => capability.printDjvuPath(djvuPath, options)),
    cancel: (jobId) => {
        const loaded = djvuLoader.getLoaded();
        if (loaded) {
            return loaded.cancel(jobId);
        }
        return djvuLoader.isPending()
            ? djvuLoader.ensureLoaded().then((capability) => capability.cancel(jobId))
            : Promise.resolve({canceled: false});
    },
    getJobState: (jobId) => {
        const loaded = djvuLoader.getLoaded();
        if (loaded) {
            return loaded.getJobState(jobId);
        }
        return djvuLoader.isPending()
            ? djvuLoader.ensureLoaded().then((capability) => capability.getJobState(jobId))
            : Promise.resolve(null);
    },
    cancelPagePreview: (requestId) => {
        const loaded = djvuLoader.getLoaded();
        if (loaded) {
            return loaded.cancelPagePreview(requestId);
        }
        return djvuLoader.isPending()
            ? djvuLoader.ensureLoaded().then((capability) => capability.cancelPagePreview(requestId))
            : Promise.resolve({canceled: false});
    },
    searchText: (djvuPath, query, options) =>
        djvuLoader.ensureLoaded().then((capability) => capability.searchText(djvuPath, query, options)),
    cancelTextSearch: (requestId) => {
        const loaded = djvuLoader.getLoaded();
        if (loaded) {
            return loaded.cancelTextSearch(requestId);
        }
        return djvuLoader.isPending()
            ? djvuLoader.ensureLoaded().then((capability) => capability.cancelTextSearch(requestId))
            : Promise.resolve({canceled: false});
    },
    getInfo: (djvuPath) => djvuLoader.ensureLoaded().then((capability) => capability.getInfo(djvuPath)),
    getPageSourceInfo: (djvuPath, pageNumber) =>
        djvuLoader.ensureLoaded().then((capability) => capability.getPageSourceInfo(djvuPath, pageNumber)),
    getPageSizes: (djvuPath) => djvuLoader.ensureLoaded().then((capability) => capability.getPageSizes(djvuPath)),
    renderPagePreview: (djvuPath, pageNumber, options) =>
        djvuLoader.ensureLoaded().then((capability) => capability.renderPagePreview(djvuPath, pageNumber, options)),
    estimateSizes: (djvuPath) => djvuLoader.ensureLoaded().then((capability) => capability.estimateSizes(djvuPath)),
    cleanupTemp: (tempPdfPath) => djvuLoader.ensureLoaded().then((capability) => capability.cleanupTemp(tempPdfPath)),
    onProgress: (listener) => djvuLoader.subscribe((capability) => capability.onProgress(listener)),
    onConvertComplete: (listener) => djvuLoader.subscribe((capability) => capability.onConvertComplete(listener)),
    onOpenComplete: (listener) => djvuLoader.subscribe((capability) => capability.onOpenComplete(listener)),
    onTextSearchProgress: (listener) => djvuLoader.subscribe((capability) => capability.onTextSearchProgress(listener)),
    onMenuConvertToPdf: () => () => {},
};

const browserDocumentCapabilities = createBrowserDocumentsCapability({
    clearSearchCaches(pdfPath) {
        // Memory invalidation runs synchronously when search is loaded; optional
        // persisted maintenance must not determine whether a document operation succeeds.
        void searchLoader
            .ensureLoaded()
            .then(({clearSearchCaches}) => clearSearchCaches(pdfPath))
            .catch((error: unknown) => {
                BrowserLogger.warn('search', 'Optional search-cache invalidation failed', {
                    pdfPath,
                    error,
                });
            });
    },
});

const browserSystemSyncBindings = {getMemoryInfo: () => null} satisfies TFeatureSyncBindings<typeof SYSTEM_PLATFORM_FEATURE>;
const browserSystemApi: IPlatformApi['system'] = {
    ...browserSystemSyncBindings,
    onShutdownSaveFlushRequest: () => () => {},
    onWindowCloseRequest: () => () => {},
};
const browserShellApi: IPlatformApi['shell'] = {
    openExternal(url: string) {
        if (typeof window === 'undefined') {
            return Promise.resolve(undefined);
        }

        const decision = inspectAllowedExternalUrl(url);
        if (!decision.ok) {
            BrowserLogger.warn('shell', 'Blocked external URL', {
                protocol: decision.protocol ?? null,
                reason: decision.reason,
                url,
            });
            return Promise.resolve(undefined);
        }

        window.open(decision.normalizedUrl, '_blank', 'noopener,noreferrer');

        return Promise.resolve(undefined);
    },
} satisfies TFeatureBrowserBindings<typeof SHELL_PLATFORM_FEATURE>;

/**
 * Opens the document the Chrome extension launched this page with without
 * pulling the entire browser-api barrel into the extension startup graph.
 */
export async function openBrowserExtensionLaunchDocument(prefetched?: IBrowserExtensionPrefetchedLaunch) {
    const launch = await import('@app/platform/browser-api/openBrowserExtensionDocument');
    return launch.openBrowserExtensionDocument(prefetched);
}

export const browserPlatformApi = {
    documentPicker: browserDocumentCapabilities.documentPicker,
    documentOpen: browserDocumentCapabilities.documentOpen,
    documentWorkingCopy: browserDocumentCapabilities.documentWorkingCopy,
    documentFiles: browserDocumentCapabilities.documentFiles,
    documentPdf: browserDocumentCapabilities.documentPdf,
    documentRecentFiles: browserDocumentCapabilities.documentRecentFiles,
    documentWindow: browserDocumentCapabilities.documentWindow,
    documentMenu: browserDocumentCapabilities.documentMenu,
    pageOps: browserDocumentCapabilities.pageOps,
    imageExport: browserDocumentCapabilities.imageExport,
    ocr: lazyBrowserOcrCapability,
    scanCleanup: lazyBrowserScanCleanupCapability,
    search: lazyBrowserSearchCapability,
    djvu: lazyBrowserDjvuCapability,
    settings: browserSettingsCapability,
    system: browserSystemApi,
    windowTabs: browserWindowTabsCapability,
    shell: browserShellApi,
    host: browserHostCapability,
    agent: browserAgentCapability,
} satisfies IPlatformApi;
