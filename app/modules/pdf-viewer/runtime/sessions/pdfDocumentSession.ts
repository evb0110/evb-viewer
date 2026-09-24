import type {
    IPdfDocument,
    IPdfPage,
    TPdfDocumentPageLeaseRetention,
} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import { clamp } from 'es-toolkit/math';
import type { ComputedRef } from 'vue';
import type { TaggedUnion } from 'type-fest';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import {
    createNativeDocumentRefValue,
    parseDocumentRef,
    type TDocumentRef,
} from '@contracts/documentRef';
import { requirePageNumber } from '@contracts/pageNumbers';
import type { TPageNumber } from '@contracts/pageNumbers';
import type { FailureReceipt } from '@contracts/diagnostics/failureReceipt';
import type {
    IPdfPageMetric,
    TPdfSource,
} from '@app/types/pdfUi';
import type { IPdfNativePageGeometry } from '@contracts/electronApiDocuments';
import { getDocumentFilesCapability } from '@app/utils/platformDocuments';
import { BrowserLogger } from '@app/utils/browserLogger';
import { getPerformanceProfile } from '@app/utils/performanceProfile';
import { runGuardedTask } from '@app/utils/asyncGuard';
import {
    createDocumentTransitionChannel,
    type IDocumentTransition,
    type IDocumentViewerRuntime,
} from '@app/modules/document-viewer/public';
import { isPathPdfSource } from '@app/modules/pdf-viewer/engine/pdf-document-source/isPathPdfSource';
import { buildTrustedPdfGeometrySeed } from '@app/modules/pdf-viewer/runtime/lifecycle/buildTrustedPdfGeometrySeed';
import { usePdfOpeningGeometryLifecycle } from '@app/modules/pdf-viewer/runtime/lifecycle/usePdfOpeningGeometryLifecycle';
import { renderPdfDocumentPageSource } from '@app/modules/pdf-viewer/runtime/renderPdfDocumentPageSource';
import { createPdfPageSource } from '@app/modules/document-viewer/public';
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
    PDF_PAGE_METRICS_DENSE_LIMIT,
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
    readonly preservePageMetrics?: boolean;
    readonly rotationDelta?: 90 | 180 | 270;
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
    /**
     * The same document rewritten in place, as a page operation or a save
     * does, rather than a different document opened. The old presentation is
     * still a truthful picture of the new bytes for everything but the edit,
     * so it can stay on screen until the replacement is ready to paint.
     */
    readonly isSameDocumentRewrite: boolean;
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
    chassisAuthority?: IDocumentViewerRuntime | null | undefined;
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

function isRewriteOfSameDocument(previous: TPdfSource | null, next: TPdfSource) {
    return isPathPdfSource(previous)
        && isPathPdfSource(next)
        && previous.path === next.path
        && (previous.revision ?? null) === (next.revision ?? null);
}

const IDLE_PLAN: IPdfDocumentLoadPlan = {
    isReload: false,
    isSelectiveReload: false,
    pagesToInvalidate: null,
    preserveVisibleContent: false,
    preservePageStructure: false,
    preservePageMetrics: false,
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
    const pageMetrics = shallowRef<IPdfPageMetric[]>([]);
    const pageMetricsVersion = ref(0);
    const loadError = computed(() => loadState.value.status === 'failed'
        ? loadState.value.error
        : null);

    const pageMetricLoads = new Map<number, Promise<IPdfPageMetric | null>>();
    const provisionalPageMetrics = new Set<number>();
    // Revision-checked native sizes stay provisional until PDF.js confirms
    // them, but they are exact enough to place a page. Navigation trusts a
    // provisional page only while its metric is still the installed native
    // object; any replacement or explicit refresh ends that trust.
    const nativeGeometryMetrics = new Map<number, IPdfPageMetric>();
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
    let pendingPageMutationRevisionSwap: {
        revision: string;
        pageNumber: number;
        invalidatedPages: readonly number[];
        rotationDelta?: 90 | 180 | 270;
        preservePageMetrics: boolean;
    } | null = null;
    let pendingPageMutationGeometryPreview: {
        pages: readonly number[];
        rotationDelta: 90 | 180 | 270;
        previousMetrics: ReadonlyMap<number, IPdfPageMetric | undefined>;
        previousProvisionalPages: ReadonlySet<number>;
        previousBasePageWidth: number | null;
        previousBasePageHeight: number | null;
        previousTrustedGeometrySeedPageNumber: number | null;
    } | null = null;
    let isLoadFromSourceActive = false;
    let viewerResidencyState: TViewerResidencyState = options.isActive?.value === false ? 'warm' : 'active';
    let residencyTransitionGeneration = 0;
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
                {code: 'RENDERER_PDF_RANGE_READ_FAILED'},
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
        isSameDocumentRewrite = false,
    ) {
        return transitions.publish({
            phase,
            fence,
            plan: activePlan,
            reason,
            isSameDocumentRewrite,
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
        provisionalPageMetrics.clear();
        nativeGeometryMetrics.clear();
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
        pageNumber: TPageNumber;
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

    function hasExactPageGeometry(pageNumber: TPageNumber) {
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
        pageNumber: TPageNumber,
        version: number,
    ): Promise<IPdfPageMetric | null> {
        if (pageNumber < 1 || pageNumber > document.numPages) {
            return null;
        }

        const cachedMetric = pageMetrics.value[pageNumber - 1];
        if (isValidPageMetric(cachedMetric) && !provisionalPageMetrics.has(pageNumber)) {
            return cachedMetric;
        }

        const inFlight = pageMetricLoads.get(pageNumber);
        if (inFlight) {
            return inFlight;
        }

        const isStaleMetricLoad = () => version !== getRenderVersion() || document !== pdfDocument.value;
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
            let page: IPdfPage;
            try {
                page = await pageCache.getPage(pageNumber);
            } catch (error) {
                // A request that outlived its document rejects, for example a
                // fast scroll still hydrating when the tab closes. The cache
                // reports it as stale, but PDF.js can reject first with its
                // own "Transport destroyed", so staleness decides rather than
                // the error type. A superseded metric load has nothing to
                // report, and several callers hydrate fire-and-forget.
                if (isStaleMetricLoad()) {
                    return null;
                }
                throw error;
            }
            if (isStaleMetricLoad()) {
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

            provisionalPageMetrics.delete(pageNumber);
            if (cachedMetric
                && cachedMetric.width === metric.width
                && cachedMetric.height === metric.height
                && cachedMetric.rotation === metric.rotation
                && cachedMetric.userUnit === metric.userUnit) {
                return metric;
            }
            pageMetrics.value[pageNumber - 1] = metric;
            triggerRef(pageMetrics);
            if (trustedGeometrySeedPageNumber === pageNumber || cachedMetric) {
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

    async function ensurePageMetricsInRange(
        startPage: number,
        endPage: number,
        pagesToRefresh: readonly number[] = [],
    ) {
        const document = pdfDocument.value;
        const totalPages = numPages.value;
        if (!document || totalPages <= 0) {
            return false;
        }

        const rangeStart = clamp(Math.min(startPage, endPage), 1, totalPages);
        const rangeEnd = clamp(Math.max(startPage, endPage), 1, totalPages);
        for (const pageNumber of pagesToRefresh) {
            if (Number.isSafeInteger(pageNumber) && pageNumber >= rangeStart && pageNumber <= rangeEnd) {
                provisionalPageMetrics.add(pageNumber);
                nativeGeometryMetrics.delete(pageNumber);
            }
        }
        const missingPageCount = rangeEnd - rangeStart + 1;
        let hasMissingPage = false;
        for (let pageNumber = rangeStart; pageNumber <= rangeEnd; pageNumber += 1) {
            if (!isValidPageMetric(pageMetrics.value[pageNumber - 1]) || provisionalPageMetrics.has(pageNumber)) {
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
                if (isValidPageMetric(pageMetrics.value[pageNumber - 1]) && !provisionalPageMetrics.has(pageNumber)) {
                    continue;
                }
                await loadPageMetric(document, requirePageNumber(pageNumber, totalPages), version);
            }
        }));

        return version === getRenderVersion() && document === pdfDocument.value;
    }

    function hasNavigablePageGeometry(pageNumber: number) {
        const metric = pageMetrics.value[pageNumber - 1];
        return isValidPageMetric(metric)
            && (!provisionalPageMetrics.has(pageNumber) || nativeGeometryMetrics.get(pageNumber) === metric);
    }

    /**
     * Navigation places a page from its size, not from its PDF.js page proxy.
     * A native size that PDF.js has not confirmed yet is exact, and waiting for
     * that confirmation can queue behind a long raster in the single PDF.js
     * worker. Pages without trusted geometry still load their metrics.
     */
    async function ensureNavigationPageMetrics(startPage: number, endPage: number) {
        const totalPages = numPages.value;
        if (!pdfDocument.value || totalPages <= 0) {
            return false;
        }
        const rangeStart = clamp(Math.min(startPage, endPage), 1, totalPages);
        const rangeEnd = clamp(Math.max(startPage, endPage), 1, totalPages);
        for (let pageNumber = rangeStart; pageNumber <= rangeEnd; pageNumber += 1) {
            if (!hasNavigablePageGeometry(pageNumber)) {
                return ensurePageMetricsInRange(rangeStart, rangeEnd);
            }
        }
        return false;
    }

    function resetLoadMetadata() {
        provisionalPageMetrics.clear();
        nativeGeometryMetrics.clear();
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

        await loadPageMetric(document, requirePageNumber(1, document.numPages), version);
        if (version !== getRenderVersion() || document !== pdfDocument.value) {
            return;
        }

        if (!isValidPageMetric(pageMetrics.value[0])) {
            resetLoadMetadata();
        }
    }

    function leaseOwnedPage(
        document: IPdfDocument,
        pageNumber: TPageNumber,
        retention: TPdfDocumentPageLeaseRetention = 'render-cache', signal?: AbortSignal,
    ) {
        if (pdfDocument.value !== document) {
            throw createStalePdfDocumentError(
                'Rendering cancelled: PDF page lease owner became stale',
            );
        }
        return retention === 'transient-background'
            ? pageCache.leaseTransientBackgroundPage(pageNumber, signal)
            : pageCache.leasePage(pageNumber, signal);
    }

    async function readNativePageGeometry(source: TPdfSource, version: number): Promise<IPdfNativePageGeometry | null> {
        if (!isPathPdfSource(source)) return null;
        const revision = source.revision ?? options.documentRevisionToken?.value;
        if (!revision) return null;
        try {
            const read = getDocumentFilesCapability().getPdfNativePageSizes;
            if (!read) return null;
            const geometry = await read(source.path, {
                mode: 'exact',
                expectedDocumentRevisionToken: revision,
            });
            return geometry.kind === 'exact'
                && geometry.documentRef === source.path
                && geometry.documentRevisionToken === revision
                ? geometry
                : null;
        } catch (error) {
            // Browser sources and installations without the native reader
            // retain PDF.js geometry discovery as their fallback.
            if (version === getRenderVersion()) {
                BrowserLogger.warn('pdf-document', 'Bulk PDF geometry unavailable; using PDF.js page metrics', error);
            }
            return null;
        }
    }

    function installNativePageGeometry(geometry: IPdfNativePageGeometry, totalPages: number) {
        if (geometry.pageCount !== totalPages || geometry.pages.length !== totalPages) return false;
        const metrics: IPdfPageMetric[] = [];
        for (const [
            index,
            page,
        ] of geometry.pages.entries()) {
            if (page.pageNumber !== index + 1) return false;
            const rotated = page.rotation === 90 || page.rotation === 270;
            const metric: IPdfPageMetric = {
                width: (rotated ? page.heightPoints : page.widthPoints) * page.userUnit,
                height: (rotated ? page.widthPoints : page.heightPoints) * page.userUnit,
                rotation: page.rotation,
                userUnit: page.userUnit,
            };
            if (!isValidPageMetric(metric)) return false;
            metrics.push(metric);
        }
        pageMetrics.value = metrics;
        provisionalPageMetrics.clear();
        nativeGeometryMetrics.clear();
        for (const [
            index,
            metric,
        ] of metrics.entries()) {
            provisionalPageMetrics.add(index + 1);
            nativeGeometryMetrics.set(index + 1, metric);
        }
        replaceTrustedBaseMetrics();
        bumpPageMetricsVersion();
        return true;
    }

    async function readPdfjsPageGeometry(document: IPdfDocument, version: number) {
        // Keep the established sparse path for exceptionally large browser
        // sources; native path-backed documents use the bulk reader above.
        if (document.numPages > PDF_PAGE_METRICS_DENSE_LIMIT) return;
        // Blob sources have no native revision identity. Read their geometry
        // through PDF.js and publish once, so navigation never uses a mixture
        // of exact heights and page-count-sized estimates.
        const metrics = new Array<IPdfPageMetric>(document.numPages);
        let nextPage = 1;
        let failedPageCount = 0;
        let firstFailure: unknown;
        const isCurrent = () => version === getRenderVersion() && document === pdfDocument.value;
        await Promise.all(Array.from({length: Math.min(4, document.numPages)}, async () => {
            while (nextPage <= document.numPages && isCurrent()) {
                const pageNumber = nextPage++;
                try {
                    const page = await pageCache.getPage(requirePageNumber(pageNumber, document.numPages));
                    if (!isCurrent()) return;
                    const viewport = page.getViewport({scale: 1});
                    const metric: IPdfPageMetric = {
                        width: viewport.width,
                        height: viewport.height,
                        rotation: viewport.rotation,
                        userUnit: viewport.userUnit,
                    };
                    if (!isValidPageMetric(metric)) throw new Error('PDF page has invalid geometry');
                    metrics[pageNumber - 1] = metric;
                } catch (error) {
                    if (!isCurrent()) return;
                    if (pageNumber === 1) throw error;
                    // An unreadable later page must not prevent the readable
                    // part of a malformed document from opening. Keep a hole
                    // so the normal page request still reports its failure.
                    failedPageCount += 1;
                    firstFailure ??= error;
                }
            }
        }));
        if (isCurrent() && failedPageCount > 0) {
            BrowserLogger.warn('pdf-document', `Unable to measure ${failedPageCount} PDF pages`, firstFailure);
        }
        if (!isCurrent()) return;
        pageMetrics.value = metrics;
        provisionalPageMetrics.clear();
        nativeGeometryMetrics.clear();
        replaceTrustedBaseMetrics();
        bumpPageMetricsVersion();
    }

    async function acceptLoadedDocument(
        document: IPdfDocument,
        version: number,
        lifecycleKey: string,
        source: TPdfSource,
        nativeGeometry: IPdfNativePageGeometry | null = null,
        preserveExistingPageMetrics = false,
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
            pageNumber: TPageNumber,
            retention: TPdfDocumentPageLeaseRetention = 'render-cache',
            signal?: AbortSignal,
        ) => leaseOwnedPage(document, pageNumber, retention, signal);
        registerPdfDocumentPageLeaseOwner(document, (pageNumber, retention) => (
            leaseOwnedPage(document, requirePageNumber(pageNumber, document.numPages), retention)
        ));
        activeRasterScheduler = ensurePdfPageRasterScheduler(document, {
            documentFence: captureFence(),
            leasePage,
            maxConcurrency: Math.min(2, getPerformanceProfile().concurrentPdfRenders),
        });
        numPages.value = document.numPages;
        if (!preserveExistingPageMetrics
            && (!nativeGeometry || !installNativePageGeometry(nativeGeometry, document.numPages))) {
            await readPdfjsPageGeometry(document, version);
        }
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

    function startLoad(
        preservePageStructure: boolean,
        pagesToInvalidate: readonly number[] | null = null,
        preservePageMetrics = false,
    ) {
        const shouldPreservePageStructure = preservePageStructure || trustedGeometrySeedPending;
        const savedState = preserveLoadState(shouldPreservePageStructure);
        trustedGeometrySeedPending = false;
        pendingRangeReadFailure = null;

        // Cancel any in-progress load - latest wins
        cleanup();

        if (shouldPreservePageStructure) {
            restorePreservedLoadState(savedState);
            if (!preservePageMetrics) {
                for (const pageNumber of pagesToInvalidate ?? []) {
                    if (Number.isSafeInteger(pageNumber) && pageNumber > 0 && pageNumber <= numPages.value) {
                        // Keep the old dimensions as a layout seed, but require
                        // the replacement PDF.js page to refresh this metric
                        // before fit scale is committed for the new revision.
                        provisionalPageMetrics.add(pageNumber);
                        nativeGeometryMetrics.delete(pageNumber);
                    }
                }
            }
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
            BrowserLogger.error('pdf-document', 'Failed to load PDF', error, {code: 'RENDERER_PDF_DOCUMENT_LOAD_FAILED'});
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
            pagesToInvalidate?: readonly number[] | null;
            preservePageMetrics?: boolean;
        },
    ) {
        const version = startLoad(
            loadOptions?.preservePageStructure === true,
            loadOptions?.pagesToInvalidate ?? null,
            loadOptions?.preservePageMetrics === true,
        );
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
            const nativeGeometry = loadOptions?.preservePageMetrics === true
                ? null
                : readNativePageGeometry(src, version);
            const document = await sourceLoader.open(src, version);
            if (!document) {
                return null;
            }
            return await acceptLoadedDocument(
                document,
                version,
                lifecycleKey,
                src,
                await nativeGeometry,
                loadOptions?.preservePageMetrics === true,
            );
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
        cancelPageMutationRotationPreview();
        teardownWaitAbortController?.abort();
        teardownWaitAbortController = null;
        pendingRangeReadFailure = null;
        const version = incrementRenderVersion();
        const document = pdfDocument.value;
        const rasterScheduler = activeRasterScheduler;
        if (rasterScheduler) {
            rasterScheduler.invalidate({
                documentFence: rasterScheduler.documentFence,
                reason: 'document-cleanup',
            });
            activeRasterScheduler = null;
            options.emitRasterScheduler?.(null);
        }
        pageCache.cleanupAll();
        pageMetricLoads.clear();
        sourceLoader.cancelPendingOpen();
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
        const preserveVisibleContent = isReload && pendingPreserveVisibleContent;
        const stagedMutation = pendingPageMutationRevisionSwap;
        const stagedMutationMatchesRevision = stagedMutation !== null
            && stagedMutation.revision === String(options.documentRevisionToken?.value ?? '');
        pendingPreserveVisibleContent = false;
        return {
            isReload,
            isSelectiveReload,
            pagesToInvalidate,
            preserveVisibleContent,
            preservePageStructure: isSelectiveReload || preserveVisibleContent,
            preservePageMetrics: isSelectiveReload
                && stagedMutationMatchesRevision
                && stagedMutation?.preservePageMetrics === true,
            ...(isSelectiveReload && stagedMutationMatchesRevision && stagedMutation?.rotationDelta !== undefined
                ? {rotationDelta: stagedMutation.rotationDelta}
                : {}),
        };
    }

    async function invalidate(reason: string, isSameDocumentRewrite = false) {
        scheduledLoadToken += 1;
        const wasActive = isLoadFromSourceActive;
        documentLoadToken += 1;
        isLoadFromSourceActive = false;
        await emitTransition('invalidated', reason, captureFence(), isSameDocumentRewrite);
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
            pendingPageMutationRevisionSwap = null;
            return activeOpenSurfaceGeneration;
        }
        // Join the generation that the host has already opened for this load.
        // The session is created before the host mints its first generation,
        // and a later document can replace the previous generation before the
        // PDF watcher runs. Reusing the session's old generation here would
        // make acquireSource reject the legitimate open and leave the PDF
        // document permanently absent. acquireSource still validates this
        // snapshot synchronously, so an old asynchronous continuation cannot
        // install a competing surface.
        const expectedGeneration = surface.snapshot.value.generation;
        const documentRevision = String(options.documentRevisionToken?.value ?? `load:${String(loadToken)}`);
        const stagedRevisionSwap = pendingPageMutationRevisionSwap;
        if (stagedRevisionSwap) {
            const currentDocumentId = surface.snapshot.value.identity?.documentId
                ?? options.openSurfaceDocumentId?.()
                ?? `pdf-open-${String(loadToken)}`;
            const didPreserveCommittedSurface = documentRevision === stagedRevisionSwap.revision
                && surface.prepareRevisionSwap({
                    documentId: currentDocumentId,
                    documentRevision: stagedRevisionSwap.revision,
                }, stagedRevisionSwap.pageNumber, stagedRevisionSwap.invalidatedPages);
            pendingPageMutationRevisionSwap = null;
            if (!didPreserveCommittedSurface) {
                // The lifecycle changed between staging and loading (for
                // example, a close won the race). Fall back to a regular open
                // instead of carrying a selective plan onto an uncommitted
                // surface.
                const {
                    rotationDelta: _rotationDelta, ...regularOpenPlan
                } = activePlan;
                activePlan = {
                    ...regularOpenPlan,
                    isSelectiveReload: false,
                    pagesToInvalidate: null,
                    preserveVisibleContent: false,
                    preservePageStructure: false,
                    preservePageMetrics: false,
                };
            }
        }
        activeOpenSurfaceGeneration = surface.acquireSource({
            // The host's provisional identity is the stable logical document
            // id. Paths inside the feature pack may already point at a managed
            // working copy and must only refine the revision, never replace the
            // opening generation.
            documentId: surface.snapshot.value.identity?.documentId
                ?? options.openSurfaceDocumentId?.()
                ?? `pdf-open-${String(loadToken)}`,
            documentRevision,
        }, expectedGeneration) ?? 0;
        activeDocumentRevision = activeOpenSurfaceGeneration === 0
            ? null
            : surface.snapshot.value.identity?.documentRevision ?? documentRevision;
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
        if (options.chassisAuthority?.openSurface && activeOpenSurfaceGeneration === 0) {
            // A source that lost its expected surface generation is stale.
            // Keep its PDF proxy out of the shared viewport rather than
            // falling back to constructing a competing open transaction.
            isLoadFromSourceActive = false;
            resolveLoadSettle();
            return;
        }
        if (!activePlan.preserveVisibleContent) {
            options.emitInitialVisualPending?.();
        }
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
                ...(activePlan.isSelectiveReload && activePlan.pagesToInvalidate
                    ? {pagesToInvalidate: activePlan.pagesToInvalidate}
                    : {}),
                ...(activePlan.preservePageMetrics ? {preservePageMetrics: true} : {}),
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
            if (activeDocumentRevision) {
                options.chassisAuthority?.openSurface.cancelRevisionSwap(
                    activeOpenSurfaceGeneration,
                    activeDocumentRevision,
                );
            }
            isLoadFromSourceActive = false;
            await emitTransition('invalidated', 'load-aborted');
            resolveLoadSettle();
            return;
        }

        const deferSelectiveDocumentPublish = activePlan.isSelectiveReload
            && activePlan.preserveVisibleContent;
        const publishLoadedDocument = () => {
            options.emitRasterScheduler?.(activeRasterScheduler);
            options.emitDocument?.(pdfDocument.value);
            options.emitTotalPages?.(numPages.value);
        };
        if (!deferSelectiveDocumentPublish) {
            publishLoadedDocument();
        }

        const readyFence = captureFence();
        await emitTransition('ready', isReload ? 'reload' : 'open', readyFence);
        if (activeLoadToken !== documentLoadToken || readyFence.documentVersion !== getRenderVersion()) {
            return;
        }
        if (deferSelectiveDocumentPublish) {
            // The viewport's ready transition refreshes invalidated geometry
            // and commits Fit Width before the replacement source can start a
            // raster. Publishing it earlier let the first rotated page paint
            // at the preceding page's scale, followed by a visible jump.
            publishLoadedDocument();
        }
        if (activeDocumentRevision && activeOpenSurfaceGeneration > 0) {
            options.chassisAuthority?.openSurface.completeRevisionSwap(
                activeOpenSurfaceGeneration,
                activeDocumentRevision,
            );
        }
        isLoadFromSourceActive = false;
        await emitTransition('settled', isReload ? 'reload' : 'open', readyFence);
        resolveLoadSettle();
    }

    function scheduleLoad(isReload = false) {
        // The lifecycle queue may still be waiting for an older load. Cancel
        // its pre-submit work before the replacement joins that queue.
        sourceLoader.cancelPendingOpen();
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
        cancelPageMutationRotationPreview();
        sourceLoader.cancelPendingOpen();
        if (pendingPageMutationRevisionSwap) {
            options.chassisAuthority?.openSurface.cancelRevisionSwap(
                activeOpenSurfaceGeneration,
                pendingPageMutationRevisionSwap.revision,
            );
        }
        pendingPageMutationRevisionSwap = null;
        pendingPagesToInvalidate = null;
        pendingPreserveVisibleContent = false;
        const invalidation = invalidate(reason);
        runGuardedTask(async () => {
            await invalidation;
            cleanup();
            options.emitDocument?.(null);
        }, {
            category: 'user-visible-operation',
            scope: 'pdf-viewer',
            message: 'Failed to invalidate PDF document session',
        });
    }

    function scheduleSourceReplacement(isReload: boolean, isSameDocumentRewrite = false) {
        sourceLoader.cancelPendingOpen();
        const invalidation = invalidate('source-replaced', isSameDocumentRewrite);
        const activeScheduledLoadToken = scheduledLoadToken;
        runGuardedTask(async () => {
            await invalidation;
            if (activeScheduledLoadToken !== scheduledLoadToken) {
                return;
            }
            await load(isReload);
        }, {
            category: 'user-visible-operation',
            scope: 'pdf-viewer',
            message: 'Failed to load replacement PDF source',
        });
    }

    function cleanupInactiveDocumentCaches(
        document: IPdfDocument | null,
        transitionGeneration: number,
    ) {
        if (
            document === null
            || document !== pdfDocument.value
            || transitionGeneration !== residencyTransitionGeneration
            || options.isActive?.value !== false
            || options.isAnySaving?.value === true
        ) {
            return;
        }
        const decision = resolvePdfViewerResidencyDecision({
            isActive: false,
            isAnySaving: false,
            hasReclaimableDocumentCaches: Boolean(document && typeof document.cleanup === 'function'),
            previousState: viewerResidencyState,
        });
        viewerResidencyState = decision.state;

        if (!decision.shouldCleanupDocumentCaches || !document || typeof document.cleanup !== 'function') {
            return;
        }
        void Promise.resolve(document.cleanup())
            .then(() => {
                if (
                    document === pdfDocument.value
                    && transitionGeneration === residencyTransitionGeneration
                    && options.isActive?.value === false
                    && options.isAnySaving?.value !== true
                ) {
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
        usePdfOpeningGeometryLifecycle({
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
            const sourceIdentifier = documentRef
                ?? (typeof source === 'string' ? source : null)
                ?? (typeof source === 'object' && source !== null && 'path' in source ? source.path : 'memory');
            const pageSource = createPdfPageSource({
                documentRef: documentRef
                    ?? (typeof source === 'string' ? parseDocumentRef(source) : null)
                    ?? createNativeDocumentRefValue('/memory/pdf').path,
                pdfDocument: document,
                getPage: pageNumber => pageCache.getPage(requirePageNumber(pageNumber, document.numPages)),
                renderPage: request => renderPdfDocumentPageSource({
                    document,
                    request,
                    surfaceBudget: authority.surfaceBudget,
                    scopeId: `pdf-page-source:${sourceIdentifier}`,
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
        if (!newSrc) {
            if (pendingPageMutationRevisionSwap) {
                options.chassisAuthority?.openSurface.cancelRevisionSwap(
                    activeOpenSurfaceGeneration,
                    pendingPageMutationRevisionSwap.revision,
                );
            }
            pendingPageMutationRevisionSwap = null;
            pendingPagesToInvalidate = null;
            pendingPreserveVisibleContent = false;
            invalidateAndCleanup('source-cleared');
            return;
        }
        if (!pendingPageMutationRevisionSwap) {
            cancelPageMutationRotationPreview();
        }
        scheduleSourceReplacement(Boolean(oldSrc), pendingPageMutationRevisionSwap !== null
            || isRewriteOfSameDocument(oldSrc, newSrc));
    });

    watch(() => options.isActive?.value ?? true, (active) => {
        const transitionGeneration = ++residencyTransitionGeneration;
        if (!active) {
            const document = pdfDocument.value;
            viewerResidencyState = 'warm';
            runGuardedTask(() => enqueueLifecycleOperation(async () => {
                await invalidate('deactivated');
                cleanupInactiveDocumentCaches(document, transitionGeneration);
            }), {
                category: 'user-visible-operation',
                scope: 'pdf-viewer',
                message: 'Failed to deactivate PDF document session',
            });
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
    }
    onScopeDispose(() => {
        void dispose();
    }, true);

    function normalizePageMutationPreviewPages(pages: readonly number[]) {
        return [...new Set(pages
            .filter(page => Number.isSafeInteger(page) && page >= 1 && page <= numPages.value)
            .map(page => requirePageNumber(page, numPages.value)))];
    }

    function matchesPageMutationGeometryPreview(pages: readonly number[], rotationDelta: 90 | 180 | 270) {
        const preview = pendingPageMutationGeometryPreview;
        if (!preview || preview.rotationDelta !== rotationDelta || preview.pages.length !== pages.length) {
            return false;
        }
        const previewPages = new Set(preview.pages);
        return pages.every(page => previewPages.has(page));
    }

    function beginPageMutationRotationPreview(
        pages: readonly number[],
        rotationDelta: 90 | 180 | 270,
    ) {
        if (
            !pdfDocument.value
            || isLoading.value
            || numPages.value < 1
            || pendingPageMutationRevisionSwap
            || pendingPageMutationGeometryPreview
        ) {
            return false;
        }
        const normalizedPages = normalizePageMutationPreviewPages(pages);
        if (normalizedPages.length === 0) {
            return false;
        }

        const nextMetrics = pageMetrics.value.slice();
        const previousMetrics = new Map<number, IPdfPageMetric | undefined>();
        const previousProvisionalPages = new Set<number>();
        let measuredPageCount = 0;
        for (const pageNumber of normalizedPages) {
            const index = pageNumber - 1;
            const metric = nextMetrics[index];
            previousMetrics.set(pageNumber, metric);
            if (provisionalPageMetrics.has(pageNumber)) {
                previousProvisionalPages.add(pageNumber);
            }
            if (!isValidPageMetric(metric)) {
                continue;
            }
            const currentRotation = metric.rotation ?? 0;
            if (![
                0,
                90,
                180,
                270,
            ].includes(currentRotation)) {
                return false;
            }
            const nextRotation = (currentRotation + rotationDelta) % 360;
            nextMetrics[index] = {
                ...metric,
                ...(rotationDelta === 90 || rotationDelta === 270
                    ? {
                        width: metric.height,
                        height: metric.width,
                    }
                    : {}),
                rotation: nextRotation,
            };
            measuredPageCount += 1;
        }
        if (measuredPageCount === 0) {
            return false;
        }

        pendingPageMutationGeometryPreview = {
            pages: normalizedPages,
            rotationDelta,
            previousMetrics,
            previousProvisionalPages,
            previousBasePageWidth: basePageWidth.value,
            previousBasePageHeight: basePageHeight.value,
            previousTrustedGeometrySeedPageNumber: trustedGeometrySeedPageNumber,
        };
        pageMetrics.value = nextMetrics;
        normalizedPages.forEach(page => provisionalPageMetrics.delete(page));
        const isAllPagesSelected = normalizedPages.length === numPages.value;
        if (isAllPagesSelected && (rotationDelta === 90 || rotationDelta === 270)) {
            basePageWidth.value = pendingPageMutationGeometryPreview.previousBasePageHeight;
            basePageHeight.value = pendingPageMutationGeometryPreview.previousBasePageWidth;
        } else {
            replaceTrustedBaseMetrics();
        }
        bumpPageMetricsVersion();
        return true;
    }

    function cancelPageMutationRotationPreview() {
        const preview = pendingPageMutationGeometryPreview;
        if (!preview) {
            return false;
        }
        const restoredMetrics = pageMetrics.value.slice();
        for (const pageNumber of preview.pages) {
            const previousMetric = preview.previousMetrics.get(pageNumber);
            if (previousMetric) {
                restoredMetrics[pageNumber - 1] = previousMetric;
            } else {
                Reflect.deleteProperty(restoredMetrics, pageNumber - 1);
            }
            provisionalPageMetrics.delete(pageNumber);
            if (preview.previousProvisionalPages.has(pageNumber)) {
                provisionalPageMetrics.add(pageNumber);
            }
        }
        pendingPageMutationGeometryPreview = null;
        pageMetrics.value = restoredMetrics;
        basePageWidth.value = preview.previousBasePageWidth;
        basePageHeight.value = preview.previousBasePageHeight;
        trustedGeometrySeedPageNumber = preview.previousTrustedGeometrySeedPageNumber;
        bumpPageMetricsVersion();
        return true;
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
        getPage: (pageNumber: TPageNumber): Promise<IPdfPage> => pageCache.getPage(pageNumber),
        leasePage: (pageNumber: TPageNumber, retention: TPdfDocumentPageLeaseRetention = 'render-cache') => (
            retention === 'transient-background'
                ? pageCache.leaseTransientBackgroundPage(pageNumber)
                : pageCache.leasePage(pageNumber)
        ),
        evictPage: pageCache.evictPage,
        cleanupPageCache: pageCache.cleanupAll,
        ensurePageMetricsInRange,
        ensureNavigationPageMetrics,
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
        beginPageMutationRotationPreview,
        cancelPageMutationRotationPreview,
        preparePageMutationRevisionSwap(
            revision: string,
            pages: readonly number[],
            pageNumber: number,
            rotationDelta?: 90 | 180 | 270,
        ) {
            const surface = options.chassisAuthority?.openSurface;
            if (
                !surface
                || surface.snapshot.value.phase !== 'ready'
                || revision.length === 0
                || pages.length === 0
                || !Number.isSafeInteger(pageNumber)
                || pageNumber < 1
            ) {
                return false;
            }
            let preservePageMetrics = false;
            if (rotationDelta !== undefined) {
                const normalizedPages = normalizePageMutationPreviewPages(pages);
                const hasOptimisticPreview = matchesPageMutationGeometryPreview(normalizedPages, rotationDelta);
                if (pendingPageMutationGeometryPreview && !hasOptimisticPreview) {
                    return false;
                }
                if (hasOptimisticPreview) {
                    preservePageMetrics = normalizedPages.every(page => (
                        isValidPageMetric(pageMetrics.value[page - 1])
                    ));
                    for (const pageNumberToRotate of normalizedPages) {
                        provisionalPageMetrics.delete(pageNumberToRotate);
                    }
                    pendingPageMutationGeometryPreview = null;
                } else {
                    preservePageMetrics = true;
                    const nextMetrics = pageMetrics.value.slice();
                    for (const pageNumberToRotate of pages) {
                        const metric = nextMetrics[pageNumberToRotate - 1];
                        const currentRotation = metric?.rotation ?? 0;
                        if (
                            !isValidPageMetric(metric)
                            || ![
                                0,
                                90,
                                180,
                                270,
                            ].includes(currentRotation)
                        ) {
                            preservePageMetrics = false;
                            break;
                        }
                        const nextRotation = (currentRotation + rotationDelta) % 360;
                        nextMetrics[pageNumberToRotate - 1] = {
                            ...metric,
                            ...(rotationDelta === 90 || rotationDelta === 270
                                ? {
                                    width: metric.height,
                                    height: metric.width,
                                }
                                : {}),
                            rotation: nextRotation,
                        };
                    }
                    if (preservePageMetrics) {
                        pageMetrics.value = nextMetrics;
                        for (const pageNumberToRotate of pages) {
                            provisionalPageMetrics.delete(pageNumberToRotate);
                        }
                        replaceTrustedBaseMetrics();
                        bumpPageMetricsVersion();
                    }
                }
            }
            pendingPreserveVisibleContent = true;
            pendingPagesToInvalidate = [...pages];
            pendingPageMutationRevisionSwap = {
                revision,
                pageNumber,
                invalidatedPages: [...pages],
                ...(rotationDelta === undefined ? {} : {rotationDelta}),
                preservePageMetrics,
            };
            return true;
        },
        invalidatePagesOnNextReload(pages: readonly number[]) {
            pendingPagesToInvalidate = [...pages];
        },
        get activeLoadPlan() {
            return activePlan;
        },
        get pendingPageMutationRevisionSwap() {
            return pendingPageMutationRevisionSwap;
        },
    };
};

export type TPdfDocumentSession = ReturnType<typeof createPdfDocumentSession>;
