import type {
    IPdfDocument,
    IPdfPage,
    TPdfDocumentPageLeaseRetention,
} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import { clamp } from 'es-toolkit/math';
import type {
    ComputedRef,
    Ref,
} from 'vue';
import type { TaggedUnion } from 'type-fest';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type { TDocumentRef } from '@contracts/documentRef';
import {
    mapPageNumberThroughPageIdentityDelta,
    type IPageIdentityDelta,
} from '@contracts/electronApiPageOps';
import { recordPdfDocumentLoadedRevision } from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentLoadedRevision';
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
    cloneSparsePageMetrics,
    forEachKnownPageMetric,
    PDF_PAGE_METRICS_DENSE_LIMIT,
} from '@app/modules/document-viewer/public';
import { isPathPdfSource } from '@app/modules/pdf-viewer/engine/pdf-document-source/isPathPdfSource';
import { buildTrustedPdfGeometrySeed } from '@app/modules/pdf-viewer/runtime/lifecycle/buildTrustedPdfGeometrySeed';
import { usePdfOpeningGeometryLifecycle } from '@app/modules/pdf-viewer/runtime/lifecycle/usePdfOpeningGeometryLifecycle';
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

// Below the measured native crossover, Blob opens keep PDF.js geometry
// independent of background whole-document metadata reads.
const PDF_BLOB_NATIVE_GEOMETRY_MIN_PAGES = 1_000;

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

/** Currentness coordinates every downstream session of one view captures and revalidates. */
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
    src?: Readonly<Ref<TPdfSource | null>> | undefined;
    reloadSrc?: Readonly<Ref<TPdfSource | null>> | undefined;
    documentLifecycleKey?: Readonly<Ref<string | null>> | undefined;
    documentRevisionToken?: Readonly<Ref<TDocumentRevisionToken | null>> | undefined;
    workingCopyPath?: Readonly<Ref<TDocumentRef | null>> | undefined;
    isAnySaving?: Readonly<Ref<boolean>> | undefined;
}

/** One viewer of the document: its open surface, its activity and what it shows. */
export interface IAttachPdfDocumentViewOptions {
    chassisAuthority?: IDocumentViewerRuntime | null | undefined;
    openSurfaceDocumentId?: (() => string) | undefined;
    emitInitialVisualPending?: (() => void) | undefined;
    originalDocumentId?: ComputedRef<string | null> | undefined;
    currentPage?: ComputedRef<number> | undefined;
    isActive?: ComputedRef<boolean> | undefined;
    emitDocument?: ((document: IPdfDocument | null) => void) | undefined;
    emitTotalPages?: ((total: number) => void) | undefined;
    emitLoading?: ((loading: boolean) => void) | undefined;
    emitLoadError?: ((error: unknown) => void) | undefined;
    /**
     * Pages whose shared geometry a rotation preview or a staged rotation
     * changed (`rotationDelta`), or restored (`null`). The view keeps its own
     * reading point through it.
     */
    onPageRotationGeometry?: ((pages: readonly number[], rotationDelta: 90 | 180 | 270 | null) => void) | undefined;
}

interface IPdfStagedRevisionSwap {
    readonly revision: string;
    readonly invalidatedPages: readonly number[];
    readonly rotationDelta?: 90 | 180 | 270;
    readonly pageIdentityDelta?: IPageIdentityDelta;
    readonly preservePageMetrics: boolean;
}

/** A document load while its views present it. */
interface IPdfDocumentPresentingLoad {
    readonly token: number;
    readonly plan: IPdfDocumentLoadPlan;
    readonly stagedRevisionSwap: IPdfStagedRevisionSwap | null;
    /** `loading` until the proxy is accepted; a view that attaches later presents it on its own. */
    stage: 'loading' | 'presenting';
    /** Each view that presents this load, with the view token it began with (null: it skipped). */
    readonly views: Map<IPdfDocumentViewPresenter, Promise<number | null>>;
}

/** What the document asks of each view that presents it. */
interface IPdfDocumentViewPresenter {
    isActive(): boolean;
    beginLoad(load: IPdfDocumentPresentingLoad): Promise<number | null>;
    abortLoad(token: number | null, error: unknown): Promise<void>;
    completeLoad(token: number | null): Promise<void>;
    invalidate(reason: string, isSameDocumentRewrite?: boolean): Promise<void>;
    restore(): Promise<void>;
    cancelStagedRevisionSwap(revision: string): void;
    clearPresentedDocument(): void;
    presentPageRotationGeometry(pages: readonly number[], rotationDelta: 90 | 180 | 270 | null): void;
    dispose(): Promise<void>;
}

function isRewriteOfSameDocument(previous: TPdfSource | null, next: TPdfSource) {
    return isPathPdfSource(previous)
        && isPathPdfSource(next)
        && previous.path === next.path
        && (previous.revision ?? null) === (next.revision ?? null);
}

/** Also the plan of a view that presents a document for the first time: it has nothing to preserve. */
const IDLE_PLAN: IPdfDocumentLoadPlan = {
    isReload: false,
    isSelectiveReload: false,
    pagesToInvalidate: null,
    preserveVisibleContent: false,
    preservePageStructure: false,
    preservePageMetrics: false,
};

/** A reload for a view whose surface cannot keep its picture through a staged page mutation. */
function withoutPreservedPresentation(plan: IPdfDocumentLoadPlan): IPdfDocumentLoadPlan {
    const {
        rotationDelta: _rotationDelta, ...regularPlan
    } = plan;
    return {
        ...regularPlan,
        isSelectiveReload: false,
        pagesToInvalidate: null,
        preserveVisibleContent: false,
        preservePageStructure: false,
        preservePageMetrics: false,
    };
}

function normalizePdfDocumentLifecycleKey(value: string | null | undefined, fallback: string) {
    const normalized = value?.trim();
    if (normalized === undefined || normalized.length === 0) {
        return fallback;
    }
    return normalized;
}

/**
 * Sole owner of PDF document truth: the PDF.js proxy, page geometry, the
 * load-token/render-version pair, the per-document raster scheduler and the
 * load plan. The workspace document creates one for all its views; each
 * viewer attaches a view, which presents the document on its own open
 * surface and carries the fence and transitions its sessions subscribe to.
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

    // Every page's geometry is installed before first layout (the native
    // table for path-backed files, one dense PDF.js read otherwise) and is
    // final for the revision. Only a Blob source above the dense limit still
    // measures its pages here, one missing page at a time.
    const pageMetricLoads = new Map<number, Promise<IPdfPageMetric | null>>();
    let activeLifecycleKey = fallbackLifecycleKey;
    let teardownWaitAbortController: AbortController | null = null;
    let trustedGeometrySeedPending = false;
    let trustedGeometrySeedPageNumber: number | null = null;
    let activeRasterScheduler: IPdfPageRasterScheduler | null = null;

    let documentLoadToken = 0;
    let scheduledLoadToken = 0;
    let activePlan: IPdfDocumentLoadPlan = IDLE_PLAN;
    let presentingLoad: IPdfDocumentPresentingLoad | null = null;
    let pendingPreserveVisibleContent = false;
    let pendingPagesToInvalidate: number[] | null = null;
    let pendingPageMutationRevisionSwap: IPdfStagedRevisionSwap | null = null;
    let pendingPageMutationGeometryPreview: {
        pages: readonly number[];
        rotationDelta: 90 | 180 | 270;
        previousMetrics: ReadonlyMap<number, IPdfPageMetric | undefined>;
        previousBasePageWidth: number | null;
        previousBasePageHeight: number | null;
        previousTrustedGeometrySeedPageNumber: number | null;
    } | null = null;
    let viewerResidencyState: TViewerResidencyState = 'active';
    let residencyTransitionGeneration = 0;
    let pendingRangeReadFailure: {
        version: number;
        receipt: FailureReceipt;
    } | null = null;

    // The views that present this document. Residency and every load follow them.
    const views = shallowRef(new Set<IPdfDocumentViewPresenter>());
    const isAnyViewActive = () => [...views.value].some(view => view.isActive());
    let disposed = false;
    let lifecycleBarrier: Promise<void> = Promise.resolve();

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

    function forEachView(run: (view: IPdfDocumentViewPresenter) => Promise<void>) {
        return Promise.all([...views.value].map(run)).then(() => undefined);
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
                await document.loadingTask.destroy();
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
        if (isValidPageMetric(cachedMetric)) {
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

            const metric = readPdfjsPageMetric(page);
            if (!isValidPageMetric(metric)) {
                return null;
            }
            pageMetrics.value[pageNumber - 1] = metric;
            triggerRef(pageMetrics);
            if (trustedGeometrySeedPageNumber === pageNumber) {
                // The opening shell seed is not a document maximum. Once
                // PDF.js measures that page, rebuild the fallback baseline so
                // a larger seed box cannot remain sticky.
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

    /** Measures the pages in a range that have no geometry yet (sparse sources only). */
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
                await loadPageMetric(document, requirePageNumber(pageNumber, totalPages), version);
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

    function readPdfjsPageMetric(page: IPdfPage): IPdfPageMetric {
        const viewport = page.getViewport({scale: 1});
        return {
            width: viewport.width,
            height: viewport.height,
            rotation: viewport.rotation,
            userUnit: viewport.userUnit,
        };
    }

    /**
     * Page 1 is read for its first raster anyway. Compare the native table
     * with PDF.js there: a disagreement is a geometry defect to report, never
     * a relayout under the reader.
     */
    async function verifyNativePageGeometry(document: IPdfDocument) {
        const installed = pageMetrics.value[0];
        const page = await pageCache.getPage(requirePageNumber(1, document.numPages)).catch(() => null);
        const measured = page && document === pdfDocument.value ? readPdfjsPageMetric(page) : null;
        if (
            installed && measured && (
                Math.abs(measured.width - installed.width) > 0.01
                || Math.abs(measured.height - installed.height) > 0.01
                || measured.rotation !== installed.rotation
            )
        ) {
            BrowserLogger.warn('pdf-document', 'Native page geometry disagrees with PDF.js; keeping the installed table', {
                installed,
                measured,
            });
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
        const path = isPathPdfSource(source) ? source.path : options.workingCopyPath?.value;
        const revision = (isPathPdfSource(source) ? source.revision : undefined) ?? options.documentRevisionToken?.value;
        if (!path || !revision) return null;
        try {
            const read = getDocumentFilesCapability().getPdfNativePageSizes;
            if (!read) return null;
            const geometry = await read(path, {
                mode: 'exact',
                expectedDocumentRevisionToken: revision,
            });
            return geometry.kind === 'exact'
                && geometry.documentRef === path
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

    function installNativePageGeometry(geometry: IPdfNativePageGeometry, totalPages: number, source: TPdfSource) {
        if (!isPathPdfSource(source) && (
            geometry.documentRef !== options.workingCopyPath?.value
            || geometry.documentRevisionToken !== options.documentRevisionToken?.value
        )) return false;
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
        replaceTrustedBaseMetrics();
        bumpPageMetricsVersion();
        return true;
    }

    async function readPdfjsPageGeometry(document: IPdfDocument, version: number) {
        // Keep the established sparse path for exceptionally large browser
        // sources; native path-backed documents use the bulk reader above.
        // The old dimensions of rewritten pages are measured again on demand.
        if (document.numPages > PDF_PAGE_METRICS_DENSE_LIMIT) {
            for (const pageNumber of activePlan.pagesToInvalidate ?? []) {
                Reflect.deleteProperty(pageMetrics.value, pageNumber - 1);
            }
            return;
        }
        // Sources without matching native provenance read their geometry
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
                    const metric = readPdfjsPageMetric(page);
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
            documentFence: {
                loadToken: documentLoadToken,
                documentVersion: version,
                documentRevision: options.documentRevisionToken?.value == null
                    ? null
                    : String(options.documentRevisionToken.value),
            },
            leasePage,
            maxConcurrency: Math.min(2, getPerformanceProfile().concurrentPdfRenders),
        });
        numPages.value = document.numPages;
        if (!preserveExistingPageMetrics) {
            if (nativeGeometry && installNativePageGeometry(nativeGeometry, document.numPages, source)) {
                await verifyNativePageGeometry(document);
            } else {
                await readPdfjsPageGeometry(document, version);
            }
        }
        if (!isValidPageMetric(pageMetrics.value[0])) {
            await loadPageMetric(document, requirePageNumber(1, document.numPages), version);
            if (version === getRenderVersion() && document === pdfDocument.value && !isValidPageMetric(pageMetrics.value[0])) {
                resetLoadMetadata();
            }
        }
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
        activeRasterScheduler = null;
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
            preservePageMetrics?: boolean;
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
            const nativeGeometry = loadOptions?.preservePageMetrics !== true && isPathPdfSource(src)
                ? readNativePageGeometry(src, version)
                : null;
            const document = await sourceLoader.open(src, version);
            if (!document) {
                return null;
            }
            return await acceptLoadedDocument(
                document,
                version,
                lifecycleKey,
                src,
                await (nativeGeometry ?? (loadOptions?.preservePageMetrics !== true
                    && document.numPages > PDF_BLOB_NATIVE_GEOMETRY_MIN_PAGES
                    && document.numPages <= PDF_PAGE_METRICS_DENSE_LIMIT
                    ? readNativePageGeometry(src, version)
                    : null)),
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
        restorePageMutationGeometryPreview();
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
        documentLoadToken += 1;
        presentingLoad = null;
        await forEachView(view => view.invalidate(reason, isSameDocumentRewrite));
    }

    function cancelStagedRevisionSwap() {
        const staged = pendingPageMutationRevisionSwap;
        if (staged) {
            views.value.forEach(view => view.cancelStagedRevisionSwap(staged.revision));
        }
        pendingPageMutationRevisionSwap = null;
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
        activePlan = computeLoadPlan(isReload);
        const presenting: IPdfDocumentPresentingLoad = {
            token: activeLoadToken,
            plan: activePlan,
            stagedRevisionSwap: pendingPageMutationRevisionSwap,
            stage: 'loading',
            views: new Map(),
        };
        pendingPageMutationRevisionSwap = null;
        presentingLoad = presenting;
        views.value.forEach(view => presenting.views.set(view, view.beginLoad(presenting)));
        const began = await Promise.all(presenting.views.values());
        if (activeLoadToken !== documentLoadToken) {
            return;
        }
        if (began.length > 0 && began.every(token => token === null)) {
            // Every view's surface lost its generation: this source is stale.
            // Keep its PDF.js proxy out rather than open a document nobody shows.
            presentingLoad = null;
            return;
        }

        let loaded: Awaited<ReturnType<typeof loadPdf>> = null;
        let thrownLoadError: unknown = null;
        try {
            loaded = await loadPdf(src as TPdfSource, {
                ...(options.documentLifecycleKey?.value
                    ? {lifecycleKey: options.documentLifecycleKey.value}
                    : {}),
                ...(activePlan.preservePageStructure ? {preservePageStructure: true} : {}),
                ...(activePlan.preservePageMetrics ? {preservePageMetrics: true} : {}),
            });
        } catch (error) {
            thrownLoadError = error;
        }

        if (activeLoadToken !== documentLoadToken) {
            return;
        }
        presenting.stage = 'presenting';
        const presentations = [...presenting.views].map(async ([
            view,
            token,
        ]) => (loaded
            ? view.completeLoad(await token)
            : view.abortLoad(await token, thrownLoadError ?? loadError.value)));
        await Promise.all(presentations);
        if (presentingLoad === presenting) {
            presentingLoad = null;
        }
    }

    function scheduleLoad(isReload = false) {
        // The lifecycle queue may still be waiting for an older load. Cancel
        // its pre-submit work before the replacement joins that queue; only
        // the latest scheduled load runs, so views mounting together open the
        // document once.
        sourceLoader.cancelPendingOpen();
        const activeScheduledLoadToken = ++scheduledLoadToken;
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
        restorePageMutationGeometryPreview();
        sourceLoader.cancelPendingOpen();
        cancelStagedRevisionSwap();
        pendingPagesToInvalidate = null;
        pendingPreserveVisibleContent = false;
        const invalidation = invalidate(reason);
        runGuardedTask(async () => {
            await invalidation;
            cleanup();
            views.value.forEach(view => view.clearPresentedDocument());
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

    /** No view presents the document any more: release it, as closing its last viewer does. */
    function releaseDocument() {
        scheduledLoadToken += 1;
        documentLoadToken += 1;
        presentingLoad = null;
        pendingPageMutationRevisionSwap = null;
        pendingPagesToInvalidate = null;
        pendingPreserveVisibleContent = false;
        cleanup();
    }

    // Runs after every view that stopped being active has cancelled its work:
    // PDF.js must not clean up while a render is running.
    function cleanupInactiveDocumentCaches(
        document: IPdfDocument | null,
        transitionGeneration: number,
    ) {
        if (
            document === null
            || document !== pdfDocument.value
            || transitionGeneration !== residencyTransitionGeneration
            || isAnyViewActive()
            || options.isAnySaving?.value === true
        ) {
            return;
        }
        pageCache.cleanupAll();
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
                    && !isAnyViewActive()
                    && options.isAnySaving?.value !== true
                ) {
                    viewerResidencyState = resolvePostReclaimResidencyState(viewerResidencyState);
                }
            })
            .catch(() => {});
    }

    // Residency follows the views: a view that stops being active cancels its
    // own work, and the document reclaims its caches once none is active. A
    // view that becomes active again restores, or loads a document it lost.
    watch(() => [...views.value].map(view => [
        view,
        view.isActive(),
    ] as const), (entries, previousEntries) => {
        const previous = new Map(previousEntries);
        const deactivated = entries.filter(([
            view,
            active,
        ]) => !active && previous.get(view) === true).map(([view]) => view);
        const activated = entries.filter(([
            view,
            active,
        ]) => active && previous.get(view) === false).map(([view]) => view);
        if (deactivated.length === 0 && activated.length === 0) {
            return;
        }
        const transitionGeneration = ++residencyTransitionGeneration;
        viewerResidencyState = isAnyViewActive() ? 'active' : 'warm';
        if (deactivated.length > 0) {
            const document = pdfDocument.value;
            runGuardedTask(() => enqueueLifecycleOperation(async () => {
                await Promise.all(deactivated.map(view => view.invalidate('deactivated')));
                cleanupInactiveDocumentCaches(document, transitionGeneration);
            }), {
                category: 'user-visible-operation',
                scope: 'pdf-viewer',
                message: 'Failed to deactivate PDF document session',
            });
        }
        if (activated.length === 0) {
            return;
        }
        if (options.src?.value && !pdfDocument.value && !isLoading.value) {
            scheduleLoad();
            return;
        }
        if (pdfDocument.value && !isLoading.value) {
            runGuardedTask(() => enqueueLifecycleOperation(
                () => Promise.all(activated.map(view => view.restore())).then(() => undefined),
            ), {
                category: 'user-visible-operation',
                scope: 'pdf-viewer',
                message: 'Failed to restore PDF document session',
            });
        }
    });

    async function dispose() {
        if (disposed) {
            return;
        }
        disposed = true;
        for (const view of [...views.value]) {
            await view.dispose();
        }
        releaseDocument();
    }

    watch(() => options.src?.value ?? null, (newSrc, oldSrc) => {
        if (newSrc === oldSrc) {
            return;
        }
        if (!newSrc) {
            cancelStagedRevisionSwap();
            pendingPagesToInvalidate = null;
            pendingPreserveVisibleContent = false;
            invalidateAndCleanup('source-cleared');
            return;
        }
        if (!pendingPageMutationRevisionSwap) {
            restorePageMutationGeometryPreview();
        }
        if (views.value.size === 0) {
            // Nothing presents the document: the next view that does loads it.
            return;
        }
        scheduleSourceReplacement(Boolean(oldSrc), pendingPageMutationRevisionSwap !== null
            || isRewriteOfSameDocument(oldSrc, newSrc));
    });

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

    function rotatePageMetric(metric: IPdfPageMetric, rotationDelta: 90 | 180 | 270): IPdfPageMetric | null {
        const currentRotation = metric.rotation ?? 0;
        if (![
            0,
            90,
            180,
            270,
        ].includes(currentRotation)) {
            return null;
        }
        return {
            ...metric,
            ...(rotationDelta === 90 || rotationDelta === 270
                ? {
                    width: metric.height,
                    height: metric.width,
                }
                : {}),
            rotation: (currentRotation + rotationDelta) % 360,
        };
    }

    // Every view keeps its own reading point through a change of the shared geometry.
    function presentPageRotationGeometry(pages: readonly number[], rotationDelta: 90 | 180 | 270 | null) {
        views.value.forEach(view => view.presentPageRotationGeometry(pages, rotationDelta));
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
        let measuredPageCount = 0;
        for (const pageNumber of normalizedPages) {
            const index = pageNumber - 1;
            const metric = nextMetrics[index];
            previousMetrics.set(pageNumber, metric);
            if (!isValidPageMetric(metric)) {
                continue;
            }
            const rotated = rotatePageMetric(metric, rotationDelta);
            if (!rotated) {
                return false;
            }
            nextMetrics[index] = rotated;
            measuredPageCount += 1;
        }
        if (measuredPageCount === 0) {
            return false;
        }

        pendingPageMutationGeometryPreview = {
            pages: normalizedPages,
            rotationDelta,
            previousMetrics,
            previousBasePageWidth: basePageWidth.value,
            previousBasePageHeight: basePageHeight.value,
            previousTrustedGeometrySeedPageNumber: trustedGeometrySeedPageNumber,
        };
        pageMetrics.value = nextMetrics;
        const isAllPagesSelected = normalizedPages.length === numPages.value;
        if (isAllPagesSelected && (rotationDelta === 90 || rotationDelta === 270)) {
            basePageWidth.value = pendingPageMutationGeometryPreview.previousBasePageHeight;
            basePageHeight.value = pendingPageMutationGeometryPreview.previousBasePageWidth;
        } else {
            replaceTrustedBaseMetrics();
        }
        bumpPageMetricsVersion();
        presentPageRotationGeometry(normalizedPages, rotationDelta);
        return true;
    }

    function restorePageMutationGeometryPreview() {
        const preview = pendingPageMutationGeometryPreview;
        if (!preview) {
            return null;
        }
        const restoredMetrics = pageMetrics.value.slice();
        for (const pageNumber of preview.pages) {
            const previousMetric = preview.previousMetrics.get(pageNumber);
            if (previousMetric) {
                restoredMetrics[pageNumber - 1] = previousMetric;
            } else {
                Reflect.deleteProperty(restoredMetrics, pageNumber - 1);
            }
        }
        pendingPageMutationGeometryPreview = null;
        pageMetrics.value = restoredMetrics;
        basePageWidth.value = preview.previousBasePageWidth;
        basePageHeight.value = preview.previousBasePageHeight;
        trustedGeometrySeedPageNumber = preview.previousTrustedGeometrySeedPageNumber;
        bumpPageMetricsVersion();
        return preview.pages;
    }

    function cancelPageMutationRotationPreview() {
        const pages = restorePageMutationGeometryPreview();
        if (!pages) {
            return false;
        }
        presentPageRotationGeometry(pages, null);
        return true;
    }

    /**
     * Stages the revision a page operation wrote, once for all views: the
     * next load of that revision keeps the pages it did not change.
     */
    function stagePageMutationRevisionSwap(
        revision: string,
        pages: readonly number[],
        rotationDelta?: 90 | 180 | 270,
        pageIdentityDelta?: IPageIdentityDelta,
    ) {
        if (pendingPageMutationRevisionSwap?.revision === revision) {
            return true;
        }
        if (revision.length === 0 || pages.length === 0) {
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
                pendingPageMutationGeometryPreview = null;
            } else {
                preservePageMetrics = true;
                const nextMetrics = pageMetrics.value.slice();
                for (const pageNumberToRotate of pages) {
                    const metric = nextMetrics[pageNumberToRotate - 1];
                    const rotated = isValidPageMetric(metric) ? rotatePageMetric(metric, rotationDelta) : null;
                    if (!rotated) {
                        preservePageMetrics = false;
                        break;
                    }
                    nextMetrics[pageNumberToRotate - 1] = rotated;
                }
                if (preservePageMetrics) {
                    pageMetrics.value = nextMetrics;
                    replaceTrustedBaseMetrics();
                    bumpPageMetricsVersion();
                    presentPageRotationGeometry(pages, rotationDelta);
                }
            }
        }
        pendingPreserveVisibleContent = true;
        pendingPagesToInvalidate = [...pages];
        pendingPageMutationRevisionSwap = {
            revision,
            invalidatedPages: [...pages],
            ...(rotationDelta === undefined ? {} : {rotationDelta}),
            ...(pageIdentityDelta === undefined ? {} : {pageIdentityDelta}),
            preservePageMetrics,
        };
        return true;
    }

    // What the document and every view of it read alike.
    const sharedDocument = {
        pdfDocument,
        acceptedSource,
        numPages,
        isLoading,
        basePageWidth,
        basePageHeight,
        pageMetrics,
        pageMetricsVersion,
        hasExactPageGeometry,
        getPage: (pageNumber: TPageNumber): Promise<IPdfPage> => pageCache.getPage(pageNumber),
        leasePage: (pageNumber: TPageNumber, retention: TPdfDocumentPageLeaseRetention = 'render-cache') => (
            retention === 'transient-background'
                ? pageCache.leaseTransientBackgroundPage(pageNumber)
                : pageCache.leasePage(pageNumber)
        ),
        ensurePageMetricsInRange,
        scheduleLoad,
        beginPageMutationRotationPreview,
        cancelPageMutationRotationPreview,
    };

    /**
     * One viewer's presentation of the document. The viewer's viewport,
     * rendering and annotation sessions receive it as their document: it reads
     * through to the shared proxy and geometry, and owns the view's open
     * surface generation, its transitions and fence, and what it has shown.
     */
    function attachView(viewOptions: IAttachPdfDocumentViewOptions = {}) {
        const surface = viewOptions.chassisAuthority?.openSurface;
        let viewToken = 0;
        let activeOpenSurfaceGeneration = surface?.snapshot.value.generation ?? 0;
        let activeDocumentRevision = surface?.snapshot.value.identity?.documentRevision
            ?? (options.documentRevisionToken?.value == null ? null : String(options.documentRevisionToken.value));
        let viewPlan: IPdfDocumentLoadPlan = IDLE_PLAN;
        let presentedDocument: IPdfDocument | null = null;
        // The view is loading from the moment it begins presenting a load
        // until the document it presents is in, also when it presents a
        // document that is already open.
        const presenting = shallowRef(false);
        // The page this view read when a page operation staged its revision.
        let stagedRevisionSwapPage: number | null = null;
        const disposables: Array<() => void | Promise<void>> = [];
        let viewDisposed = false;
        let loadSettleResolve: (() => void) | null = null;
        let loadSettlePromise: Promise<void> = Promise.resolve();

        function captureFence(): IPdfDocumentFence {
            return {
                loadToken: viewToken,
                documentVersion: getRenderVersion(),
                documentRevision: activeDocumentRevision,
                openSurfaceGeneration: activeOpenSurfaceGeneration,
            };
        }

        function isFenceCurrent(fence: IPdfDocumentFence) {
            const surfaceSnapshot = surface?.snapshot.value;
            return fence.loadToken === viewToken
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

        function publish(
            phase: TPdfDocumentPhase,
            reason: string,
            fence = captureFence(),
            isSameDocumentRewrite = false,
        ) {
            return transitions.publish({
                phase,
                fence,
                plan: viewPlan,
                reason,
                isSameDocumentRewrite,
            });
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

        function presentDocument(document: IPdfDocument | null) {
            presentedDocument = document;
            viewOptions.emitDocument?.(document);
        }

        function publishLoadedDocument() {
            if (pdfDocument.value) recordPdfDocumentLoadedRevision(pdfDocument.value, activeDocumentRevision);
            presentDocument(pdfDocument.value);
            viewOptions.emitTotalPages?.(numPages.value);
        }

        /**
         * The shared open surface belongs to document identity, so the
         * generation that fences every downstream visual commit of this view
         * is claimed here, before any presentation owner reacts to `loading`.
         * Returns false when the view's surface is stale for this load.
         */
        function claimOpenSurfaceGeneration(load: IPdfDocumentPresentingLoad) {
            const stagedPage = stagedRevisionSwapPage;
            stagedRevisionSwapPage = null;
            if (!surface) {
                activeOpenSurfaceGeneration = 0;
                activeDocumentRevision = options.documentRevisionToken?.value == null
                    ? null
                    : String(options.documentRevisionToken.value);
                return true;
            }
            // Join the generation that the host has already opened for this load.
            // The view is created before the host mints its first generation,
            // and a later document can replace the previous generation before the
            // PDF watcher runs. Reusing the view's old generation here would
            // make acquireSource reject the legitimate open and leave the PDF
            // document permanently absent. acquireSource still validates this
            // snapshot synchronously, so an old asynchronous continuation cannot
            // install a competing surface.
            const expectedGeneration = surface.snapshot.value.generation;
            const documentRevision = String(options.documentRevisionToken?.value ?? `load:${String(load.token)}`);
            const documentId = surface.snapshot.value.identity?.documentId
                ?? viewOptions.openSurfaceDocumentId?.()
                ?? `pdf-open-${String(load.token)}`;
            const stagedRevisionSwap = viewPlan === load.plan ? load.stagedRevisionSwap : null;
            if (stagedRevisionSwap) {
                const didPreserveCommittedSurface = stagedPage !== null
                    && documentRevision === stagedRevisionSwap.revision
                    && surface.prepareRevisionSwap({
                        documentId,
                        documentRevision: stagedRevisionSwap.revision,
                    }, stagedPage, stagedRevisionSwap.invalidatedPages);
                if (!didPreserveCommittedSurface) {
                    // The lifecycle changed between staging and loading (for
                    // example, a close won the race), or this view never
                    // staged the swap. Present a regular reload instead of
                    // carrying a selective plan onto an uncommitted surface.
                    viewPlan = withoutPreservedPresentation(viewPlan);
                }
            }
            // The host's provisional identity is the stable logical document
            // id. Paths inside the feature pack may already point at a managed
            // working copy and must only refine the revision, never replace the
            // opening generation.
            activeOpenSurfaceGeneration = surface.acquireSource({
                documentId,
                documentRevision,
            }, expectedGeneration) ?? 0;
            activeDocumentRevision = activeOpenSurfaceGeneration === 0
                ? null
                : surface.snapshot.value.identity?.documentRevision ?? documentRevision;
            // A source that lost its expected surface generation is stale for
            // this view; it keeps the PDF proxy out of its viewport rather than
            // constructing a competing open transaction.
            return activeOpenSurfaceGeneration !== 0;
        }

        async function beginLoad(load: IPdfDocumentPresentingLoad, plan = load.plan) {
            if (viewDisposed) {
                return null;
            }
            const token = ++viewToken;
            viewPlan = plan;
            beginLoadSettle();
            if (!claimOpenSurfaceGeneration(load)) {
                resolveLoadSettle();
                return null;
            }
            presenting.value = true;
            if (!viewPlan.preserveVisibleContent) {
                viewOptions.emitInitialVisualPending?.();
            }
            await publish('loading', viewPlan.isReload ? 'reload' : 'open');
            if (token !== viewToken) {
                return null;
            }
            if (!viewPlan.preserveVisibleContent) {
                presentDocument(null);
            }
            if (!viewPlan.isReload) {
                viewOptions.emitTotalPages?.(0);
            }
            return token;
        }

        async function abortLoad(token: number | null, error: unknown) {
            if (token === null || token !== viewToken) {
                return;
            }
            presenting.value = false;
            if (error) {
                viewOptions.emitLoadError?.(error);
            }
            if (activeDocumentRevision) {
                surface?.cancelRevisionSwap(activeOpenSurfaceGeneration, activeDocumentRevision);
            }
            await publish('invalidated', 'load-aborted');
            resolveLoadSettle();
        }

        async function completeLoad(token: number | null) {
            if (token === null || token !== viewToken) {
                return;
            }
            presenting.value = false;
            const reason = viewPlan.isReload ? 'reload' : 'open';
            const deferSelectiveDocumentPublish = viewPlan.isSelectiveReload
                && viewPlan.preserveVisibleContent;
            if (!deferSelectiveDocumentPublish) {
                publishLoadedDocument();
            }
            const readyFence = captureFence();
            await publish('ready', reason, readyFence);
            if (token !== viewToken || readyFence.documentVersion !== getRenderVersion()) {
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
                surface?.completeRevisionSwap(activeOpenSurfaceGeneration, activeDocumentRevision);
            }
            await publish('settled', reason, readyFence);
            resolveLoadSettle();
        }

        async function invalidateView(reason: string, isSameDocumentRewrite = false) {
            viewToken += 1;
            presenting.value = false;
            await publish('invalidated', reason, captureFence(), isSameDocumentRewrite);
            resolveLoadSettle();
        }

        /**
         * Presents the document to a viewer that mounted after it opened:
         * the transition channel does not replay readiness, so the view joins
         * a load still opening, presents an accepted document on its own, or
         * loads the source nothing has opened yet.
         */
        function present() {
            if (viewDisposed || presentingLoad?.views.has(view)) {
                return;
            }
            if (presentingLoad?.stage === 'loading') {
                presentingLoad.views.set(view, beginLoad(presentingLoad, IDLE_PLAN));
                return;
            }
            const document = pdfDocument.value;
            if (document && !isLoading.value) {
                if (presentedDocument !== document) {
                    const load: IPdfDocumentPresentingLoad = {
                        token: documentLoadToken,
                        plan: IDLE_PLAN,
                        stagedRevisionSwap: null,
                        stage: 'presenting',
                        views: new Map(),
                    };
                    runGuardedTask(async () => {
                        await completeLoad(await beginLoad(load));
                    }, {
                        category: 'user-visible-operation',
                        scope: 'pdf-viewer',
                        message: 'Failed to present PDF document in a new view',
                    });
                }
                return;
            }
            if (options.src?.value && !isLoading.value) {
                scheduleLoad();
            }
        }

        async function disposeView() {
            if (viewDisposed) {
                return;
            }
            viewDisposed = true;
            viewToken += 1;
            const remaining = new Set(views.value);
            remaining.delete(view);
            views.value = remaining;
            presentingLoad?.views.delete(view);
            // Reverse creation order: annotation detaches before rendering, which
            // detaches before viewport, which releases before the document does.
            for (const disposeSession of [...disposables].reverse()) {
                await disposeSession();
            }
            disposables.length = 0;
            transitions.dispose();
            resolveLoadSettle();
            if (disposed) {
                return;
            }
            if (views.value.size === 0) {
                releaseDocument();
            } else if (!isAnyViewActive()) {
                // Behind any deactivation of the remaining views still cancelling its work.
                const document = pdfDocument.value;
                const transitionGeneration = residencyTransitionGeneration;
                runGuardedTask(() => enqueueLifecycleOperation(
                    () => cleanupInactiveDocumentCaches(document, transitionGeneration),
                ), {
                    category: 'user-visible-operation',
                    scope: 'pdf-viewer',
                    message: 'Failed to reclaim PDF document caches',
                });
            }
        }

        const view: IPdfDocumentViewPresenter = {
            isActive: () => viewOptions.isActive?.value ?? true,
            beginLoad: load => beginLoad(load),
            abortLoad,
            completeLoad,
            invalidate: invalidateView,
            restore: () => publish('restore', 'activation').then(() => undefined),
            cancelStagedRevisionSwap(revision) {
                surface?.cancelRevisionSwap(activeOpenSurfaceGeneration, revision);
                stagedRevisionSwapPage = null;
            },
            clearPresentedDocument: () => presentDocument(null),
            presentPageRotationGeometry: (pages, rotationDelta) => viewOptions.onPageRotationGeometry?.(pages, rotationDelta),
            dispose: disposeView,
        };
        views.value = new Set(views.value).add(view);

        if (viewOptions.originalDocumentId && viewOptions.currentPage && options.src) {
            usePdfOpeningGeometryLifecycle({
                acceptedSource,
                chassisAuthority: viewOptions.chassisAuthority ?? null,
                currentPage: viewOptions.currentPage,
                documentId: viewOptions.originalDocumentId,
                numPages,
                pageMetrics,
                pageMetricsVersion,
                seedTrustedPageGeometry,
                src: options.src,
            });
        }
        const isEffectivelyLoading = computed(() => Boolean(options.src?.value) && (isLoading.value || presenting.value));
        watch(isEffectivelyLoading, value => viewOptions.emitLoading?.(value), { immediate: true });
        if (getCurrentInstance()) {
            onMounted(present);
        }
        onScopeDispose(() => {
            void disposeView();
        }, true);

        return {
            ...sharedDocument,
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
            subscribe(subscriber: TPdfDocumentTransitionSubscriber) {
                return transitions.subscribe(subscriber);
            },
            registerDisposable(disposeSession: () => void | Promise<void>) {
                disposables.push(disposeSession);
            },
            present,
            dispose: disposeView,
            /**
             * A page this view no longer shows gives its proxy back, unless
             * another view still shows it.
             */
            evictPage(pageNumber: TPageNumber) {
                const shownElsewhere = activeRasterScheduler?.snapshot().residentPages
                    .some(resident => resident.pageNumber === pageNumber) ?? false;
                if (!shownElsewhere) {
                    pageCache.evictPage(pageNumber);
                }
            },
            invalidatePagesOnNextReload(pages: readonly number[]) {
                pendingPagesToInvalidate = [...pages];
            },
            waitForLoadSettled: () => loadSettlePromise,
            preserveNextReloadVisibleContent(shouldPreserve: boolean) {
                pendingPreserveVisibleContent = shouldPreserve;
            },
            preparePageMutationRevisionSwap(
                revision: string,
                pages: readonly number[],
                pageNumber: number,
                rotationDelta?: 90 | 180 | 270,
                pageIdentityDelta?: IPageIdentityDelta,
            ) {
                if (
                    !surface
                    || surface.snapshot.value.phase !== 'ready'
                    || !Number.isSafeInteger(pageNumber)
                    || pageNumber < 1
                    || !stagePageMutationRevisionSwap(revision, pages, rotationDelta, pageIdentityDelta)
                ) {
                    return false;
                }
                stagedRevisionSwapPage = pageNumber;
                return true;
            },
            /**
             * Moves a reading anchor taken before a staged page mutation to that
             * page's number after it; a removed page reads the staged page.
             */
            carryAnchorThroughPageMutation<TAnchor extends {page: number}>(anchor: TAnchor | null): TAnchor | null {
                const delta = pendingPageMutationRevisionSwap?.pageIdentityDelta;
                if (!anchor || !delta || stagedRevisionSwapPage === null) {
                    return anchor;
                }
                const page = mapPageNumberThroughPageIdentityDelta(delta, requirePageNumber(anchor.page));
                return {
                    ...anchor,
                    page: page ?? stagedRevisionSwapPage,
                };
            },
            get activeLoadPlan() {
                return viewPlan;
            },
            get pendingPageMutationRevisionSwap() {
                return pendingPageMutationRevisionSwap;
            },
        };
    }

    return {
        ...sharedDocument,
        loadState,
        document: pdfDocument,
        loadError,
        get rasterScheduler(): IPdfPageRasterScheduler | null {
            return activeRasterScheduler;
        },
        seedTrustedPageGeometry,
        loadPdf,
        load,
        invalidate,
        dispose,
        cleanup,
        get activeLoadPlan() {
            return activePlan;
        },
        get pendingPageMutationRevisionSwap() {
            return pendingPageMutationRevisionSwap;
        },
        attachView,
    };
};

export type TPdfDocumentSession = ReturnType<typeof createPdfDocumentSession>;
/** What a viewer's sessions receive as their document: one view of the shared session. */
export type TPdfDocumentView = ReturnType<TPdfDocumentSession['attachView']>;
