import type {
    IPdfDocument,
    IPdfPage,
    TPdfDocumentPageLeaseRetention,
} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import { clamp } from 'es-toolkit/math';
import type { ComputedRef } from 'vue';
import type { TaggedUnion } from 'type-fest';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type { TDocumentRef } from '@contracts/documentRef';
import type { FailureReceipt } from '@contracts/diagnostics/failureReceipt';
import type {
    IPdfPageMetric,
    TPdfSource,
} from '@app/types/pdfUi';
import { BrowserLogger } from '@app/utils/browserLogger';
import { runGuardedTask } from '@app/utils/asyncGuard';
import type { IDocumentViewerChassisAuthority } from '@app/utils/document-viewer/chassis/documentViewerChassisAuthority';
import {
    createDocumentTransitionChannel,
    type IDocumentTransition,
} from '@app/utils/document-viewer/lifecycle/createDocumentTransitionChannel';
import { buildTrustedPdfGeometrySeed } from '@app/modules/pdf-viewer/runtime/lifecycle/buildTrustedPdfGeometrySeed';
import { usePdfTrustedOpenGeometryLifecycle } from '@app/modules/pdf-viewer/runtime/lifecycle/usePdfTrustedOpenGeometryLifecycle';
import { renderPdfDocumentPageSource } from '@app/modules/pdf-viewer/runtime/renderPdfDocumentPageSource';
import { createPdfPageSource } from '@app/utils/document-viewer/source/createPdfPageSource';
import { pdfjsDocumentTeardownCoordinator } from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfjsDocumentTeardownCoordinator';
import {
    createPdfjsDocumentSourceLoader,
    createPdfDocumentPageCache,
    createStalePdfDocumentError,
    registerPdfDocumentPageLeaseOwner,
} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import {
    disposePdfPageRasterScheduler,
    ensurePdfPageRasterScheduler,
    type IPdfPageRasterScheduler,
} from '@app/modules/pdf-viewer/engine/pdf-page-raster-scheduler/pdfPageRasterScheduler';
import {
    resolvePdfViewerResidencyDecision,
    resolvePostReclaimResidencyState,
    type TViewerResidencyState,
} from '@app/modules/pdf-viewer/runtime/memory/resolvePdfViewerResidencyDecision';
import {
    cloneSparsePageMetrics,
    forEachKnownPageMetric,
} from '@app/modules/pdf-viewer/engine/pdf-page-layout/normalizePageMetrics';

type TPdfDocumentLoadState = TaggedUnion<'status', {
    idle: { version: number };
    loading: {
        version: number;
        document: IPdfDocument | null;
        source: TPdfSource | null;
    };
    ready: {
        version: number;
        document: IPdfDocument;
        source: TPdfSource;
    };
    failed: {
        version: number;
        error: unknown;
    };
}>;

/** Currentness coordinates every downstream session captures and revalidates. */
export interface IPdfDocumentFence {
    readonly loadToken: number;
    readonly documentVersion: number;
    readonly documentRevision: string | null;
    readonly openSurfaceGeneration: number;
}

/** What the document owner decided about this load before any presentation ran. */
export interface IPdfDocumentLoadPlan {
    readonly isReload: boolean;
    readonly isSelectiveReload: boolean;
    readonly pagesToInvalidate: readonly number[] | null;
    readonly preserveVisibleContent: boolean;
    readonly preservePageStructure: boolean;
}

export type TPdfDocumentPhase =
    | 'loading'
    | 'ready'
    | 'settled'
    | 'invalidated'
    | 'restore';

export interface IPdfDocumentTransition extends IDocumentTransition<IPdfDocumentFence> {
    readonly phase: TPdfDocumentPhase;
    readonly plan: IPdfDocumentLoadPlan;
    readonly reason: string;
}

/**
 * A transition subscriber's returned promise is part of document lifecycle
 * settlement. In particular, an `invalidated` subscriber must return its
 * render/task cancellation promise rather than detach it: document cleanup
 * and PDF.js destruction start only after every subscriber has settled.
 */
type TPdfDocumentTransitionSubscriber = (
    transition: IPdfDocumentTransition,
) => void | Promise<void>;

export interface ICreatePdfDocumentSessionOptions {
    chassisAuthority?: IDocumentViewerChassisAuthority | null | undefined;
    openSurfaceDocumentId?: (() => string) | undefined;
    emitInitialVisualPending?: (() => void) | undefined;
    src?: ComputedRef<TPdfSource | null> | undefined;
    reloadSrc?: ComputedRef<TPdfSource | null> | undefined;
    documentLifecycleKey?: ComputedRef<string | null> | undefined;
    documentRevisionToken?: ComputedRef<TDocumentRevisionToken | null> | undefined;
    originalDocumentId?: ComputedRef<string | null> | undefined;
    currentPage?: ComputedRef<number> | undefined;
    pageSourceDocumentRef?: ComputedRef<TDocumentRef | null> | undefined;
    isActive?: ComputedRef<boolean> | undefined;
    isAnySaving?: ComputedRef<boolean> | undefined;
    emitDocument?: ((document: IPdfDocument | null) => void) | undefined;
    emitTotalPages?: ((total: number) => void) | undefined;
    emitLoading?: ((loading: boolean) => void) | undefined;
    emitLoadError?: ((error: unknown) => void) | undefined;
    emitRasterScheduler?: ((scheduler: IPdfPageRasterScheduler | null) => void) | undefined;
}

const IDLE_PLAN: IPdfDocumentLoadPlan = {
    isReload: false,
    isSelectiveReload: false,
    pagesToInvalidate: null,
    preserveVisibleContent: false,
    preservePageStructure: false,
};

function normalizePdfDocumentLifecycleKey(value: string | null | undefined, fallback: string) {
    const normalized = value?.trim();
    if (normalized === undefined || normalized.length === 0) {
        return fallback;
    }
    return normalized;
}

/**
 * Sole owner of PDF document truth: the PDF.js proxy, page geometry, the
 * load-token/render-version fence pair, the per-document raster scheduler and
 * the reverse disposal order of the session tree built on top of it.
 *
 * Downstream sessions never receive an "on settled" callback into the loading
 * path; they subscribe to typed transitions and revalidate the carried fence.
 */
export const createPdfDocumentSession = (options: ICreatePdfDocumentSessionOptions = {}) => {
    const fallbackLifecycleKey = `pdf-viewer:${crypto.randomUUID()}`;
    const loadState = shallowRef<TPdfDocumentLoadState>({
        status: 'idle',
        version: 0,
    });
    const pdfDocument = computed(() => {
        const state = loadState.value;
        return state.status === 'loading' || state.status === 'ready'
            ? state.document
            : null;
    });
    const acceptedSource = computed<TPdfSource | null>(() => {
        const state = loadState.value;
        return (state.status === 'loading' || state.status === 'ready')
            && state.document
            ? state.source
            : null;
    });
    const numPages = ref(0);
    const isLoading = computed(() => loadState.value.status === 'loading');
    const basePageWidth = ref<number | null>(null);
    const basePageHeight = ref<number | null>(null);
    const pageMetrics = ref<IPdfPageMetric[]>([]);
    const pageMetricsVersion = ref(0);
    const loadError = computed(() => loadState.value.status === 'failed'
        ? loadState.value.error
        : null);

    const pageMetricLoads = new Map<number, Promise<IPdfPageMetric | null>>();
    let activeLifecycleKey = fallbackLifecycleKey;
    let teardownWaitAbortController: AbortController | null = null;
    let trustedGeometrySeedPending = false;
    let trustedGeometrySeedPageNumber: number | null = null;
    let activeRasterScheduler: IPdfPageRasterScheduler | null = null;

    let documentLoadToken = 0;
    let scheduledLoadToken = 0;
    let activeOpenSurfaceGeneration = options.chassisAuthority?.openSurface.snapshot.value.generation ?? 0;
    let activeDocumentRevision = options.chassisAuthority?.openSurface.snapshot.value.identity?.documentRevision
        ?? (options.documentRevisionToken?.value == null ? null : String(options.documentRevisionToken.value));
    let activePlan: IPdfDocumentLoadPlan = IDLE_PLAN;
    let pendingPreserveVisibleContent = false;
    let pendingPagesToInvalidate: number[] | null = null;
    let isLoadFromSourceActive = false;
    let viewerResidencyState: TViewerResidencyState = options.isActive?.value === false ? 'warm' : 'active';
    let pendingRangeReadFailure: {
        version: number;
        receipt: FailureReceipt;
    } | null = null;

    const disposables: Array<() => void | Promise<void>> = [];
    let disposed = false;
    let lifecycleBarrier: Promise<void> = Promise.resolve();

    let loadSettleResolve: (() => void) | null = null;
    let loadSettlePromise: Promise<void> = Promise.resolve();

    function getRenderVersion() {
        return loadState.value.version;
    }

    const pageCache = createPdfDocumentPageCache({
        getDocument: () => pdfDocument.value,
        getRenderVersion,
    });

    const sourceLoader = createPdfjsDocumentSourceLoader({
        getRenderVersion,
        onRangeReadFailure: (error, version) => {
            if (version !== getRenderVersion() || pendingRangeReadFailure?.version === version) {
                return;
            }
            const receipt = BrowserLogger.error(
                'pdf-document',
                'Failed to read PDF range chunk',
                error,
                {
                    code: 'RENDERER_PDF_RANGE_READ_FAILED',
                    context: {},
                },
            );
            if (!pdfDocument.value) {
                pendingRangeReadFailure = {
                    version,
                    receipt,
                };
            }
            invalidateDocumentAfterRangeReadFailure(error, version);
        },
    });

    function captureFence(): IPdfDocumentFence {
        return {
            loadToken: documentLoadToken,
            documentVersion: getRenderVersion(),
            documentRevision: activeDocumentRevision,
            openSurfaceGeneration: activeOpenSurfaceGeneration,
        };
    }

    function isFenceCurrent(fence: IPdfDocumentFence) {
        const surfaceSnapshot = options.chassisAuthority?.openSurface.snapshot.value;
        return fence.loadToken === documentLoadToken
            && fence.documentVersion === getRenderVersion()
            && fence.documentRevision === activeDocumentRevision
            && fence.openSurfaceGeneration === activeOpenSurfaceGeneration
            && (surfaceSnapshot === undefined
                || (
                    fence.openSurfaceGeneration === surfaceSnapshot.generation
                    && fence.documentRevision === (surfaceSnapshot.identity?.documentRevision ?? null)
                ));
    }

    function isCurrent(fence: IPdfDocumentFence) {
        return isFenceCurrent(fence) && pdfDocument.value !== null;
    }

    const transitions = createDocumentTransitionChannel<
        IPdfDocumentFence,
        IPdfDocumentTransition
    >(isFenceCurrent);

    function subscribe(subscriber: TPdfDocumentTransitionSubscriber) {
        return transitions.subscribe(subscriber);
    }

    async function emitTransition(
        phase: TPdfDocumentPhase,
        reason: string,
        fence = captureFence(),
    ) {
        return transitions.publish({
            phase,
            fence,
            plan: activePlan,
            reason,
        });
    }

    function registerDisposable(dispose: () => void | Promise<void>) {
        disposables.push(dispose);
    }

    function enqueueLifecycleOperation(operation: () => void | Promise<void>) {
        const queued = lifecycleBarrier.then(async () => {
            if (!disposed) {
                await operation();
            }
        });
        lifecycleBarrier = queued.catch(() => {});
        return queued;
    }

    function destroyPdfDocument(
        document: IPdfDocument,
        message: string,
        lifecycleKey = activeLifecycleKey,
    ) {
        pdfjsDocumentTeardownCoordinator.track(lifecycleKey, {
            message,
            run: async () => {
                await disposePdfPageRasterScheduler(document);
                await document.destroy();
            },
        });
    }

    function isValidPageMetric(
        metric: IPdfPageMetric | null | undefined,
    ): metric is IPdfPageMetric {
        return typeof metric?.width === 'number'
            && Number.isFinite(metric.width)
            && metric.width > 0
            && typeof metric?.height === 'number'
            && Number.isFinite(metric.height)
            && metric.height > 0;
    }

    function incrementRenderVersion() {
        pageMetricLoads.clear();
        const version = loadState.value.version + 1;
        loadState.value = {
            ...loadState.value,
            version,
        };
        return version;
    }

    function bumpPageMetricsVersion() {
        pageMetricsVersion.value += 1;
    }

    function seedTrustedPageGeometry(input: {
        pageNumber: number;
        pageCount: number;
        width: number;
        height: number;
        rotation?: number;
    }) {
        const seed = buildTrustedPdfGeometrySeed(input);
        if (!seed) {
            return false;
        }
        numPages.value = seed.numPages;
        basePageWidth.value = seed.basePageWidth;
        basePageHeight.value = seed.basePageHeight;
        pageMetrics.value = seed.pageMetrics;
        trustedGeometrySeedPending = true;
        trustedGeometrySeedPageNumber = input.pageNumber;
        bumpPageMetricsVersion();
        return true;
    }

    function hasExactPageGeometry(pageNumber: number) {
        return isValidPageMetric(pageMetrics.value[pageNumber - 1])
            || trustedGeometrySeedPageNumber === pageNumber;
    }

    function updateBaseMetrics(metric: IPdfPageMetric) {
        basePageWidth.value = Math.max(basePageWidth.value ?? 0, metric.width);
        basePageHeight.value = Math.max(basePageHeight.value ?? 0, metric.height);
    }

    function replaceTrustedBaseMetrics() {
        let width = 0;
        let height = 0;
        forEachKnownPageMetric(pageMetrics.value, (metric) => {
            width = Math.max(width, metric.width);
            height = Math.max(height, metric.height);
        });
        basePageWidth.value = width > 0 ? width : null;
        basePageHeight.value = height > 0 ? height : null;
        trustedGeometrySeedPageNumber = null;
    }

    async function loadPageMetric(
        document: IPdfDocument,
        pageNumber: number,
        version: number,
    ): Promise<IPdfPageMetric | null> {
        if (pageNumber < 1 || pageNumber > document.numPages) {
            return null;
        }

        const cachedMetric = pageMetrics.value[pageNumber - 1];
        if (isValidPageMetric(cachedMetric)) {
            return cachedMetric;
        }

        const inFlight = pageMetricLoads.get(pageNumber);
        if (inFlight) {
            return inFlight;
        }

        let loadPromise: Promise<IPdfPageMetric | null> | null = null;
        loadPromise = (async () => {
            /**
             * Keep metric-loaded page proxies in the bounded render cache.
             *
             * PDF.js may return the same `IPdfPage` for a later render.
             * Calling `cleanup()` after a metrics-only `getViewport()` looked
             * harmless, but on the scanned Girgas last page it left the
             * following canvas render waiting forever on PDF.js internals. The
             * cache already evicts old proxies, so ownership should stay there.
             */
            const page = await pageCache.getPage(pageNumber);
            if (version !== getRenderVersion() || document !== pdfDocument.value) {
                return null;
            }

            const viewport = page.getViewport({ scale: 1 });
            const metric = {
                width: viewport.width,
                height: viewport.height,
                rotation: viewport.rotation,
                userUnit: viewport.userUnit,
            } satisfies IPdfPageMetric;
            if (!isValidPageMetric(metric)) {
                return null;
            }

            pageMetrics.value[pageNumber - 1] = metric;
            if (trustedGeometrySeedPageNumber === pageNumber) {
                // Native opening geometry is a shell seed, not a permanent
                // document maximum. Once PDF.js measures that exact page,
                // rebuild the fallback baseline from authoritative metrics so
                // a larger provisional box cannot remain sticky.
                replaceTrustedBaseMetrics();
            } else {
                updateBaseMetrics(metric);
            }
            bumpPageMetricsVersion();
            return metric;
        })().finally(() => {
            if (loadPromise && pageMetricLoads.get(pageNumber) === loadPromise) {
                pageMetricLoads.delete(pageNumber);
            }
        });

        pageMetricLoads.set(pageNumber, loadPromise);
        return loadPromise;
    }

    async function ensurePageMetricsInRange(startPage: number, endPage: number) {
        const document = pdfDocument.value;
        const totalPages = numPages.value;
        if (!document || totalPages <= 0) {
            return false;
        }

        const rangeStart = clamp(Math.min(startPage, endPage), 1, totalPages);
        const rangeEnd = clamp(Math.max(startPage, endPage), 1, totalPages);
        const missingPageCount = rangeEnd - rangeStart + 1;
        let hasMissingPage = false;
        for (let pageNumber = rangeStart; pageNumber <= rangeEnd; pageNumber += 1) {
            if (!isValidPageMetric(pageMetrics.value[pageNumber - 1])) {
                hasMissingPage = true;
                break;
            }
        }

        if (!hasMissingPage) {
            return false;
        }

        const version = getRenderVersion();
        const concurrency = Math.min(4, missingPageCount);
        let nextPageNumber = rangeStart;

        await Promise.all(Array.from({ length: concurrency }, async () => {
            while (nextPageNumber <= rangeEnd) {
                const pageNumber = nextPageNumber;
                nextPageNumber += 1;
                if (version !== getRenderVersion()) {
                    return;
                }
                if (isValidPageMetric(pageMetrics.value[pageNumber - 1])) {
                    continue;
                }
                await loadPageMetric(document, pageNumber, version);
            }
        }));

        return version === getRenderVersion() && document === pdfDocument.value;
    }

    function resetLoadMetadata() {
        basePageWidth.value = null;
        basePageHeight.value = null;
        pageMetrics.value = [];
        trustedGeometrySeedPageNumber = null;
        bumpPageMetricsVersion();
    }

    async function primeInitialPageMetrics(document: IPdfDocument, version: number) {
        if (document.numPages <= 0) {
            resetLoadMetadata();
            return;
        }

        await loadPageMetric(document, 1, version);
        if (version !== getRenderVersion() || document !== pdfDocument.value) {
            return;
        }

        if (!isValidPageMetric(pageMetrics.value[0])) {
            resetLoadMetadata();
        }
    }

    function leaseOwnedPage(
        document: IPdfDocument,
        pageNumber: number,
        retention: TPdfDocumentPageLeaseRetention = 'render-cache',
    ) {
        if (pdfDocument.value !== document) {
            throw createStalePdfDocumentError(
                'Rendering cancelled: PDF page lease owner became stale',
            );
        }
        return retention === 'transient-background'
            ? pageCache.leaseTransientBackgroundPage(pageNumber)
            : pageCache.leasePage(pageNumber);
    }

    async function acceptLoadedDocument(
        document: IPdfDocument,
        version: number,
        lifecycleKey: string,
        source: TPdfSource,
    ) {
        // Discard stale result if a newer load was started
        if (version !== getRenderVersion()) {
            destroyPdfDocument(document, 'Failed to destroy stale PDF document', lifecycleKey);
            return null;
        }
        if (
            !Number.isSafeInteger(document.numPages)
            || document.numPages < 1
        ) {
            destroyPdfDocument(document, 'Failed to destroy PDF document after page-count rejection', lifecycleKey);
            throw new RangeError('PDF.js returned an invalid page count');
        }

        activeLifecycleKey = lifecycleKey;
        loadState.value = {
            status: 'loading',
            version,
            document,
            source,
        };
        const leasePage = (
            pageNumber: number,
            retention: TPdfDocumentPageLeaseRetention = 'render-cache',
        ) => leaseOwnedPage(document, pageNumber, retention);
        registerPdfDocumentPageLeaseOwner(document, leasePage);
        activeRasterScheduler = ensurePdfPageRasterScheduler(document, {
            documentFence: captureFence(),
            leasePage,
        });
        numPages.value = document.numPages;
        await primeInitialPageMetrics(document, version);
        if (version !== getRenderVersion() || document !== pdfDocument.value) {
            return null;
        }

        loadState.value = {
            status: 'ready',
            version,
            document,
            source,
        };

        return {
            version,
            document,
        };
    }

    function preserveLoadState(shouldPreserve: boolean) {
        return {
            numPages: shouldPreserve ? numPages.value : 0,
            basePageWidth: shouldPreserve ? basePageWidth.value : null,
            basePageHeight: shouldPreserve ? basePageHeight.value : null,
            pageMetrics: shouldPreserve
                ? cloneSparsePageMetrics(pageMetrics.value)
                : [],
            trustedGeometrySeedPageNumber: shouldPreserve
                ? trustedGeometrySeedPageNumber
                : null,
        };
    }

    function restorePreservedLoadState(state: ReturnType<typeof preserveLoadState>) {
        numPages.value = state.numPages;
        basePageWidth.value = state.basePageWidth;
        basePageHeight.value = state.basePageHeight;
        pageMetrics.value = state.pageMetrics;
        trustedGeometrySeedPageNumber = state.trustedGeometrySeedPageNumber;
        bumpPageMetricsVersion();
    }

    function startLoad(preservePageStructure: boolean) {
        const shouldPreservePageStructure = preservePageStructure || trustedGeometrySeedPending;
        const savedState = preserveLoadState(shouldPreservePageStructure);
        trustedGeometrySeedPending = false;
        pendingRangeReadFailure = null;

        // Cancel any in-progress load - latest wins
        cleanup();

        if (shouldPreservePageStructure) {
            restorePreservedLoadState(savedState);
        }

        const version = incrementRenderVersion();
        loadState.value = {
            status: 'loading',
            version,
            document: null,
            source: null,
        };
        if (!shouldPreservePageStructure) {
            resetLoadMetadata();
        }

        return version;
    }

    function finishLoad(version: number) {
        // Only clear loading state if this is still the current load
        if (version === getRenderVersion() && loadState.value.status === 'loading') {
            loadState.value = {
                status: 'idle',
                version,
            };
        }
    }

    function handleLoadError(error: unknown, version: number) {
        // Ignore cancellation errors from destroyed loading tasks
        if (version !== getRenderVersion()) {
            return null;
        }
        const rangeReadFailure = pendingRangeReadFailure?.version === version
            ? pendingRangeReadFailure
            : null;
        pendingRangeReadFailure = null;
        if (rangeReadFailure) {
            BrowserLogger.error('pdf-document', 'Failed to load PDF', error, rangeReadFailure.receipt);
        } else {
            BrowserLogger.error('pdf-document', 'Failed to load PDF', error, {
                code: 'RENDERER_PDF_DOCUMENT_LOAD_FAILED',
                context: {},
            });
        }
        loadState.value = {
            status: 'failed',
            version,
            error,
        };
        return null;
    }

    function clearAcceptedDocumentState() {
        if (activeRasterScheduler) {
            activeRasterScheduler = null;
            options.emitRasterScheduler?.(null);
        }
        pageCache.cleanupAll();
        pageMetricLoads.clear();
        const document = pdfDocument.value;
        if (document) {
            destroyPdfDocument(document, 'Failed to destroy PDF document after load failure');
        }
        const state = loadState.value;
        if (state.status === 'loading') {
            loadState.value = {
                ...state,
                document: null,
            };
        } else if (state.status === 'ready') {
            loadState.value = {
                status: 'idle',
                version: state.version,
            };
        }
        numPages.value = 0;
        resetLoadMetadata();
    }

    function cleanupFailedLoadAttempt(version: number) {
        if (version !== getRenderVersion()) {
            return;
        }
        sourceLoader.abortTransport('Failed to abort PDF range transport after load failure');
        sourceLoader.destroyLoadingTask(
            'PDF loading task destroy rejected after load failure',
            'Failed to destroy PDF loading task after load failure',
        );
        sourceLoader.revokeObjectUrl();
        clearAcceptedDocumentState();
    }

    function invalidateDocumentAfterRangeReadFailure(error: unknown, version: number) {
        if (version !== getRenderVersion()) {
            return;
        }

        if (!pdfDocument.value) {
            sourceLoader.abortTransport('Failed to abort PDF range transport after range read failure');
            sourceLoader.destroyLoadingTask(
                'PDF loading task destroy rejected after range read failure',
                'Failed to destroy PDF loading task after range read failure',
            );
            return;
        }

        const failedVersion = incrementRenderVersion();
        sourceLoader.abortTransport('Failed to abort PDF range transport after range read failure');
        sourceLoader.destroyLoadingTask(
            'PDF loading task destroy rejected after range read failure',
            'Failed to destroy PDF loading task after range read failure',
        );
        sourceLoader.revokeObjectUrl();
        clearAcceptedDocumentState();
        loadState.value = {
            status: 'failed',
            version: failedVersion,
            error,
        };
    }

    async function loadPdf(
        src: TPdfSource,
        loadOptions?: {
            lifecycleKey?: string;
            preservePageStructure?: boolean;
        },
    ) {
        const version = startLoad(loadOptions?.preservePageStructure === true);
        const lifecycleKey = normalizePdfDocumentLifecycleKey(
            loadOptions?.lifecycleKey,
            fallbackLifecycleKey,
        );
        const waitAbortController = new AbortController();
        teardownWaitAbortController = waitAbortController;

        try {
            await pdfjsDocumentTeardownCoordinator.waitForIdle(
                lifecycleKey,
                waitAbortController.signal,
            );
            if (version !== getRenderVersion()) {
                return null;
            }
            sourceLoader.setLifecycleKey(lifecycleKey);
            const document = await sourceLoader.open(src, version);
            if (!document) {
                return null;
            }
            return await acceptLoadedDocument(document, version, lifecycleKey, src);
        } catch (error) {
            cleanupFailedLoadAttempt(version);
            return handleLoadError(error, version);
        } finally {
            if (teardownWaitAbortController === waitAbortController) {
                teardownWaitAbortController = null;
            }
            finishLoad(version);
        }
    }

    function cleanup() {
        teardownWaitAbortController?.abort();
        teardownWaitAbortController = null;
        pendingRangeReadFailure = null;
        const version = incrementRenderVersion();
        const document = pdfDocument.value;
        if (activeRasterScheduler) {
            activeRasterScheduler = null;
            options.emitRasterScheduler?.(null);
        }
        pageCache.cleanupAll();
        pageMetricLoads.clear();
        sourceLoader.abortTransport('Failed to abort PDF range transport');

        if (document) {
            sourceLoader.clearLoadingTaskHandle();
            destroyPdfDocument(document, 'Failed to destroy PDF document');
        } else {
            sourceLoader.destroyLoadingTask(
                'PDF loading task destroy rejected',
                'Failed to destroy PDF loading task',
                'warn',
            );
        }

        sourceLoader.revokeObjectUrl();

        numPages.value = 0;
        basePageWidth.value = null;
        basePageHeight.value = null;
        pageMetrics.value = [];
        trustedGeometrySeedPageNumber = null;
        bumpPageMetricsVersion();
        loadState.value = {
            status: 'idle',
            version,
        };
    }

    function beginLoadSettle() {
        loadSettleResolve?.();
        loadSettlePromise = new Promise<void>((resolve) => {
            loadSettleResolve = resolve;
        });
    }

    function resolveLoadSettle() {
        loadSettleResolve?.();
        loadSettleResolve = null;
    }

    function computeLoadPlan(isReload: boolean): IPdfDocumentLoadPlan {
        const pagesToInvalidate = pendingPagesToInvalidate;
        pendingPagesToInvalidate = null;
        const isSelectiveReload = isReload && pagesToInvalidate !== null;
        const preserveVisibleContent = isReload
            && !isSelectiveReload
            && pendingPreserveVisibleContent;
        pendingPreserveVisibleContent = false;
        return {
            isReload,
            isSelectiveReload,
            pagesToInvalidate,
            preserveVisibleContent,
            preservePageStructure: isSelectiveReload || preserveVisibleContent,
        };
    }

    async function invalidate(reason: string) {
        scheduledLoadToken += 1;
        const wasActive = isLoadFromSourceActive;
        documentLoadToken += 1;
        isLoadFromSourceActive = false;
        await emitTransition('invalidated', reason);
        if (wasActive) {
            resolveLoadSettle();
        }
    }

    /**
     * The shared open surface belongs to document identity, so the generation
     * that fences every downstream visual commit is claimed here, before any
     * presentation owner reacts to the `loading` transition.
     */
    function claimOpenSurfaceGeneration(loadToken: number) {
        const surface = options.chassisAuthority?.openSurface;
        if (!surface) {
            activeOpenSurfaceGeneration = 0;
            activeDocumentRevision = options.documentRevisionToken?.value == null
                ? null
                : String(options.documentRevisionToken.value);
            return activeOpenSurfaceGeneration;
        }
        const documentRevision = String(options.documentRevisionToken?.value ?? `load:${String(loadToken)}`);
        activeOpenSurfaceGeneration = surface.claim({
            // The host's provisional identity is the stable logical document
            // id. Paths inside the feature pack may already point at a managed
            // working copy and must only refine the revision, never replace the
            // opening generation.
            documentId: surface.snapshot.value.identity?.documentId
                ?? options.openSurfaceDocumentId?.()
                ?? `pdf-open-${String(loadToken)}`,
            documentRevision,
        });
        activeDocumentRevision = surface.snapshot.value.identity?.documentRevision ?? documentRevision;
        return activeOpenSurfaceGeneration;
    }

    async function load(isReload = false) {
        const src = isReload
            ? options.reloadSrc?.value ?? options.src?.value ?? null
            : options.src?.value ?? null;
        if (!options.src?.value) {
            activePlan = IDLE_PLAN;
            await invalidate('empty-source');
            return;
        }

        const activeLoadToken = ++documentLoadToken;
        isLoadFromSourceActive = true;
        activePlan = computeLoadPlan(isReload);
        beginLoadSettle();
        claimOpenSurfaceGeneration(activeLoadToken);
        options.emitInitialVisualPending?.();
        const loadingFence = captureFence();
        await emitTransition('loading', isReload ? 'reload' : 'open', loadingFence);
        if (activeLoadToken !== documentLoadToken) {
            return;
        }
        if (!activePlan.preserveVisibleContent) {
            options.emitDocument?.(null);
        }
        if (!isReload) {
            options.emitTotalPages?.(0);
        }

        let loaded: Awaited<ReturnType<typeof loadPdf>> = null;
        let thrownLoadError: unknown = null;
        try {
            loaded = await loadPdf(src as TPdfSource, {
                ...(options.documentLifecycleKey?.value
                    ? {lifecycleKey: options.documentLifecycleKey.value}
                    : {}),
                ...(activePlan.preservePageStructure ? {preservePageStructure: true} : {}),
            });
        } catch (error) {
            thrownLoadError = error;
        }

        if (activeLoadToken !== documentLoadToken) {
            return;
        }
        if (!loaded) {
            const error = thrownLoadError ?? loadError.value;
            if (error) {
                options.emitLoadError?.(error);
            }
            isLoadFromSourceActive = false;
            await emitTransition('invalidated', 'load-aborted');
            resolveLoadSettle();
            return;
        }

        options.emitRasterScheduler?.(activeRasterScheduler);
        options.emitDocument?.(pdfDocument.value);
        options.emitTotalPages?.(numPages.value);

        const readyFence = captureFence();
        await emitTransition('ready', isReload ? 'reload' : 'open', readyFence);
        if (activeLoadToken !== documentLoadToken || readyFence.documentVersion !== getRenderVersion()) {
            return;
        }
        isLoadFromSourceActive = false;
        await emitTransition('settled', isReload ? 'reload' : 'open', readyFence);
        resolveLoadSettle();
    }

    function scheduleLoad(isReload = false) {
        const activeScheduledLoadToken = scheduledLoadToken;
        runGuardedTask(() => enqueueLifecycleOperation(async () => {
            if (activeScheduledLoadToken !== scheduledLoadToken) {
                return;
            }
            await load(isReload);
        }), {
            category: 'user-visible-operation',
            scope: 'pdf-viewer',
            message: 'Failed to load PDF source',
        });
    }

    function invalidateAndCleanup(reason: string) {
        runGuardedTask(() => enqueueLifecycleOperation(async () => {
            await invalidate(reason);
            cleanup();
            options.emitDocument?.(null);
        }), {
            category: 'user-visible-operation',
            scope: 'pdf-viewer',
            message: 'Failed to invalidate PDF document session',
        });
    }

    function cleanupInactiveDocumentCaches() {
        const document = pdfDocument.value;
        const decision = resolvePdfViewerResidencyDecision({
            isActive: false,
            isAnySaving: options.isAnySaving?.value === true,
            hasReclaimableDocumentCaches: Boolean(document && typeof document.cleanup === 'function'),
            previousState: viewerResidencyState,
        });
        viewerResidencyState = decision.state;

        if (!decision.shouldCleanupDocumentCaches || !document || typeof document.cleanup !== 'function') {
            return;
        }
        void Promise.resolve(document.cleanup())
            .then(() => {
                if (options.isActive?.value === false) {
                    viewerResidencyState = resolvePostReclaimResidencyState(viewerResidencyState);
                }
            })
            .catch(() => {});
    }

    async function dispose() {
        if (disposed) {
            return;
        }
        disposed = true;
        // Reverse creation order: annotation detaches before rendering, which
        // detaches before viewport, which releases before the document engine.
        for (const disposeSession of [...disposables].reverse()) {
            await disposeSession();
        }
        disposables.length = 0;
        transitions.dispose();
        resolveLoadSettle();
        cleanup();
    }

    if (options.originalDocumentId && options.currentPage && options.src) {
        usePdfTrustedOpenGeometryLifecycle({
            acceptedSource,
            chassisAuthority: options.chassisAuthority ?? null,
            currentPage: options.currentPage,
            documentId: options.originalDocumentId,
            numPages,
            pageMetrics,
            pageMetricsVersion,
            seedTrustedPageGeometry,
            src: options.src,
        });
    }

    watch(
        [
            pdfDocument,
            () => options.src?.value ?? null,
            () => options.pageSourceDocumentRef?.value ?? null,
        ],
        ([
            document,
            source,
            documentRef,
        ], _previous, onCleanup) => {
            const authority = options.chassisAuthority;
            if (!authority || !document) {
                if (authority?.source.value?.kind === 'pdf') {
                    authority.bindSource(null);
                }
                return;
            }
            const pageSource = createPdfPageSource({
                documentRef: documentRef ?? (typeof source === 'string' ? source : 'memory://pdf'),
                pdfDocument: document,
                getPage: pageNumber => pageCache.getPage(pageNumber),
                renderPage: request => renderPdfDocumentPageSource({
                    document,
                    request,
                    surfaceBudget: authority.surfaceBudget,
                    scopeId: `pdf-page-source:${String(documentRef ?? source ?? 'memory')}`,
                }),
            });
            authority.bindSource(pageSource);
            onCleanup(() => {
                pageSource.dispose();
                if (authority.source.value === pageSource) {
                    authority.bindSource(null);
                }
            });
        },
        {immediate: true},
    );

    const isEffectivelyLoading = computed(() => Boolean(options.src?.value) && isLoading.value);
    watch(isEffectivelyLoading, value => options.emitLoading?.(value), { immediate: true });

    watch(() => options.src?.value ?? null, (newSrc, oldSrc) => {
        if (newSrc === oldSrc) {
            return;
        }
        scheduledLoadToken += 1;
        if (!newSrc) {
            invalidateAndCleanup('source-cleared');
            return;
        }
        scheduleLoad(Boolean(oldSrc));
    });

    watch(() => options.isActive?.value ?? true, (active) => {
        if (!active) {
            viewerResidencyState = 'warm';
            runGuardedTask(() => enqueueLifecycleOperation(() => invalidate('deactivated')), {
                category: 'user-visible-operation',
                scope: 'pdf-viewer',
                message: 'Failed to deactivate PDF document session',
            });
            cleanupInactiveDocumentCaches();
            return;
        }
        viewerResidencyState = 'active';
        if (options.src?.value && !pdfDocument.value && !isLoading.value) {
            scheduleLoad();
            return;
        }
        if (pdfDocument.value && !isLoading.value) {
            runGuardedTask(() => enqueueLifecycleOperation(
                () => emitTransition('restore', 'activation').then(() => undefined),
            ), {
                category: 'user-visible-operation',
                scope: 'pdf-viewer',
                message: 'Failed to restore PDF document session',
            });
        }
    });

    if (getCurrentInstance()) {
        onMounted(() => {
            scheduleLoad();
        });
        onUnmounted(() => {
            void dispose();
        });
    }

    return {
        loadState,
        document: pdfDocument,
        pdfDocument,
        acceptedSource,
        numPages,
        pageCount: numPages,
        isLoading,
        basePageWidth,
        basePageHeight,
        pageMetrics,
        pageMetricsVersion,
        hasExactPageGeometry,
        loadError,
        error: loadError,
        getRenderVersion,
        incrementRenderVersion,
        get rasterScheduler(): IPdfPageRasterScheduler | null {
            return activeRasterScheduler;
        },
        get openSurfaceGeneration() {
            return activeOpenSurfaceGeneration;
        },
        get openSurfaceRevision() {
            return activeDocumentRevision ?? '';
        },
        captureFence,
        isCurrent,
        subscribe,
        registerDisposable,
        getPage: (pageNumber: number): Promise<IPdfPage> => pageCache.getPage(pageNumber),
        leasePage: (pageNumber: number, retention: TPdfDocumentPageLeaseRetention = 'render-cache') => (
            retention === 'transient-background'
                ? pageCache.leaseTransientBackgroundPage(pageNumber)
                : pageCache.leasePage(pageNumber)
        ),
        evictPage: pageCache.evictPage,
        cleanupPageCache: pageCache.cleanupAll,
        ensurePageMetricsInRange,
        seedTrustedPageGeometry,
        loadPdf,
        load,
        scheduleLoad,
        invalidate,
        dispose,
        cleanup,
        waitForLoadSettled: () => loadSettlePromise,
        preserveNextReloadVisibleContent(shouldPreserve: boolean) {
            pendingPreserveVisibleContent = shouldPreserve;
        },
        invalidatePagesOnNextReload(pages: readonly number[]) {
            pendingPagesToInvalidate = [...pages];
        },
        get activeLoadPlan() {
            return activePlan;
        },
    };
};

export type TPdfDocumentSession = ReturnType<typeof createPdfDocumentSession>;
