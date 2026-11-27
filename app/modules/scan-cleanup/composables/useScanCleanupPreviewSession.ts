import {isAbortError} from '@contracts/isAbortError';
import {narrowScanCleanupPreviewRequestToPage} from '@contracts/scan-cleanup/narrowScanCleanupPreviewRequestToPage';
import {getErrorMessage} from '@app/utils/error';
import {stripIpcInvocationPrefix} from '@app/utils/stripIpcInvocationPrefix';
import {
    SCAN_CLEANUP_ERROR_ENVELOPE_SCHEMA,
    resolveScanCleanupEffectiveOutputMode,
    type IScanCleanupOptions,
    type IScanCleanupDocumentPrior,
    type IScanCleanupPagePlanEvidence,
    type IScanCleanupPlacementAnchorCalibration,
    type IScanCleanupPlacementAnchorSummary,
    type IScanCleanupRawPreviewEvent,
    type IScanCleanupRawPreviewResult,
    type IScanCleanupPreviewRequest,
    type IScanCleanupPreviewResult,
    type TScanCleanupErrorCode,
    type TScanCleanupOutputMode,
    type TScanCleanupPreviewWireResult,
} from '@contracts/scan-cleanup/electronApiScanCleanup';
import {findSerializableErrorEnvelope, SERIALIZABLE_ERROR_PREFIX} from '@contracts/serializableError';
import type {TDocumentRef} from '@contracts/documentRef';
import {createRequestId, type TRequestId} from '@contracts/shared';
import {requirePageNumber} from '@contracts/pageNumbers';
import {useTimeoutFn} from '@vueuse/core';
import type {TScanCleanupPlacementAnchorsByPage} from '@evb/scan-cleanup/core/policy/scanCleanupPagePolicy';
import {attachScanCleanupPageOverrideDefaults, getScanCleanupPageOverride} from '@contracts/scan-cleanup/scanCleanupPageOverrides';
import {
    scanCleanupMatchedCanvasOverridesSignature,
    toScanCleanupLayoutByPage,
    usesScanCleanupInkAlignment,
} from '@evb/scan-cleanup/core/policy/scanCleanupPagePolicy';
import type {ComputedRef, Ref} from 'vue';
import {isScanCleanupLifecycleIdentityPromotion} from '@app/modules/scan-cleanup/runtime/scanCleanupDetectionSessionCache';
import type {IScanCleanupPreviewPageEvidence} from '@app/modules/scan-cleanup/composables/useScanCleanupDetectionSession';
import {
    createScanCleanupPreviewCache,
    SCAN_CLEANUP_PREVIEW_CACHE_KEY_SEPARATOR,
} from '@app/modules/scan-cleanup/runtime/createScanCleanupPreviewCache';
import {toPlainScanCleanupOptions} from '@contracts/scan-cleanup/scanCleanupSettings';
import {getScanCleanupCapability} from '@app/utils/getScanCleanupCapability';
import {toBridgeSafeScanCleanupPayload} from '@app/modules/scan-cleanup/runtime/toBridgeSafeScanCleanupPayload';
import {formatScanCleanupErrorByCode} from '@app/modules/scan-cleanup/runtime/formatScanCleanupErrorMessage';
import {
    createScanCleanupNaturalPageOrder,
    type TScanCleanupOrderedPages,
    type TScanCleanupSelectionIntent,
} from '@app/modules/scan-cleanup/runtime/resolveScanCleanupSelection';

type TScanCleanupLayoutClassification = IScanCleanupPreviewResult['pageMetadata']['layoutClassification'];

interface IScanCleanupPreviewPrefetchCandidate<TRequest> {
    key: string;
    request: TRequest;
}

export interface IScanCleanupPreviewPrefetchDependencies<TRequest, TResult> {
    isCached: (key: string) => boolean;
    preview: (request: TRequest) => Promise<TResult | null>;
    store: (key: string, result: TResult) => void;
}

export interface IScanCleanupPreviewPrefetcher<TRequest> {
    schedule: (candidates: Array<IScanCleanupPreviewPrefetchCandidate<TRequest>>) => void;
    supersede: () => void;
}

interface IQueuedPrefetch<TRequest> {
    candidates: Array<IScanCleanupPreviewPrefetchCandidate<TRequest>>;
    generation: number;
}

export function createScanCleanupPreviewPrefetcher<TRequest, TResult>(
    dependencies: IScanCleanupPreviewPrefetchDependencies<TRequest, TResult>,
): IScanCleanupPreviewPrefetcher<TRequest> {
    let generation = 0;
    let queued: IQueuedPrefetch<TRequest> | null = null;
    let worker: Promise<void> | null = null;

    async function drainQueue() {
        while (queued) {
            const current = queued;
            queued = null;
            for (const candidate of current.candidates) {
                if (current.generation !== generation) {
                    break;
                }
                if (dependencies.isCached(candidate.key)) {
                    continue;
                }
                try {
                    // A prefetch that reached the renderer is stored even when
                    // navigation has already moved past it. The key names the
                    // page and the options that produced it, so a late entry is
                    // never stale, and discarding it threw away the whole cost
                    // of the request for nothing.
                    // A cancelled or dropped prefetch answers with nothing;
                    // the page is requested again when the user reaches it.
                    const prefetched = await dependencies.preview(candidate.request);
                    if (prefetched !== null) {
                        dependencies.store(candidate.key, prefetched);
                    }
                } catch {
                    // Aborted or failed: the next schedule re-queues whatever
                    // the user still wants.
                }
                if (current.generation !== generation) {
                    break;
                }
            }
        }
    }

    function startWorker() {
        if (worker) {
            return;
        }
        const current = drainQueue();
        worker = current;
        void current
            .finally(() => {
                if (worker === current) {
                    worker = null;
                }
                if (queued) {
                    startWorker();
                }
            })
            .catch(() => undefined);
    }

    return {
        schedule(candidates) {
            generation += 1;
            queued = {
                candidates,
                generation,
            };
            startWorker();
        },
        supersede() {
            generation += 1;
            queued = null;
        },
    };
}

/**
 * Longer than the ~400-500 ms cadence of a rail flick measured in the user's
 * recording, so a burst of navigations coalesces into the page it ends on,
 * and only ever applied while a preview is already rendering.
 */
const SCAN_CLEANUP_PREVIEW_BURST_DEBOUNCE_MS = 600;
const PREVIEW_METADATA_PAGE_CACHE_LIMIT = 256;

/** What a failed preview tells the user, and the code it failed with. */
export interface IScanCleanupPreviewFailure {
    message: string;
    code: TScanCleanupErrorCode;
}

interface IUseScanCleanupPreviewSessionOptions {
    active: () => boolean;
    authoritativeLayoutByPage: ComputedRef<ReadonlyMap<number, TScanCleanupLayoutClassification>>;
    documentCanvasSignature: Readonly<Ref<string>>;
    /** Per-page detection evidence read lazily for cache keys and preview requests. */
    getPreviewPageEvidence: (pageNumber: number) => IScanCleanupPreviewPageEvidence | undefined;
    documentRevision: ComputedRef<string>;
    initialViewMode?: 'original' | 'cleaned' | undefined;
    layoutDetectionComplete: ComputedRef<boolean>;
    lifecycleDocumentKey: ComputedRef<string | null>;
    ownerId: string;
    /** A retained result store makes the main-process calibration the authority. */
    detectionResultStoreId?: Readonly<Ref<string | null>>;
    placementAnchorSummary?: Readonly<Ref<IScanCleanupPlacementAnchorSummary | null>>;
    placementAnchorCalibrationPending?: Readonly<Ref<boolean>>;
    placementAnchorsByPage: ComputedRef<TScanCleanupPlacementAnchorsByPage>;
    resolvePlacementAnchorsForPage?: (pageNumber: number) => Promise<IScanCleanupPlacementAnchorCalibration | undefined>;
    previewPage: Ref<number>;
    resolvedOptions?: ComputedRef<IScanCleanupOptions>;
    sourceSha256?: ComputedRef<string | null>;
    selectPage: (page: number, intent: TScanCleanupSelectionIntent, orderedPages: TScanCleanupOrderedPages) => void;
    settings: IScanCleanupOptions;
    sourcePath: ComputedRef<TDocumentRef | null>;
    totalPages: ComputedRef<number>;
}

export function createScanCleanupPreviewCacheKey(
    pageNumber: number,
    previewOptions: IScanCleanupOptions,
    previewSourcePath: TDocumentRef | null,
    documentRevision: string | null = null,
    documentPrior: IScanCleanupDocumentPrior | null = null,
    // Already reduced from the shared document-canvas plan in the main
    // process. A cache key is asked for once per schedule and prefetch, so it
    // consumes the plan identity rather than re-planning the document here.
    documentCanvasSignature = '',
    // Likewise already reduced, by scanCleanupMatchedCanvasOverridesSignature.
    // This one cannot be derived here at all: `previewOptions` carries only the
    // keyed page's override, and the canvas is measured from every page's.
    matchedCanvasOverridesSignature = '',
    // Detection can settle after the first visible preview has already
    // started. It revalidates the one cached entry owned by this page.
    outputModeRecommendation: TScanCleanupOutputMode | null = null,
    softAlphaForegroundRecommendation: boolean | null = null,
    pageLayoutClassification: TScanCleanupLayoutClassification | null = null,
    pagePlanEvidence: IScanCleanupPagePlanEvidence | null = null,
    layoutDetectionComplete = false,
    // Resolved across the whole document, so this page's `ink` position can
    // move when another page's content box does.
    placementAnchors: IScanCleanupPreviewRequest['placementAnchors'] | null = null,
) {
    attachScanCleanupPageOverrideDefaults(previewOptions.pageOverrides, previewOptions.pageOverrideDefaults, previewOptions.marginsMm);
    const pageOverride = getScanCleanupPageOverride(previewOptions.pageOverrides, requirePageNumber(pageNumber));
    // The visible page's classification decides its own output count, while
    // the main process's canvas signature changes only when the shared
    // rectangle actually moves. Document-wide overrides remain separate
    // because they can move that rectangle before another preview is run.
    const validity = JSON.stringify({
        documentPrior,
        outputModeRecommendation,
        softAlphaForegroundRecommendation,
        canvas: previewOptions.matchPageSize ? documentCanvasSignature : '',
        canvasOverrides: previewOptions.matchPageSize ? matchedCanvasOverridesSignature : '',
        pageLayoutClassification,
        pagePlanEvidence,
        layoutDetectionComplete,
        placementAnchors: previewOptions.matchPageSize ? placementAnchors : null,
    });
    const identity = JSON.stringify({
        sourcePath: previewSourcePath,
        documentRevision,
        page: pageNumber,
        documentOptions: {
            preserveOriginalQuality: previewOptions.preserveOriginalQuality === true,
            layoutMode: previewOptions.layoutMode,
            outputMode: previewOptions.outputMode,
            binarization: previewOptions.binarization ?? 'auto',
            normalizeIllumination: previewOptions.normalizeIllumination ?? true,
            thickness: previewOptions.thickness,
            crop: previewOptions.crop,
            matchPageSize: previewOptions.matchPageSize,
            pageAlignment: previewOptions.pageAlignment,
            marginsMm: previewOptions.marginsMm,
            despeckleLevel: previewOptions.despeckleLevel ?? ((previewOptions.despeckle ?? true) ? 'normal' : 'off'),
            autoDewarp: previewOptions.autoDewarp ?? false,
            autoDewarpDepth: previewOptions.autoDewarpDepth,
            readingOrder: previewOptions.readingOrder,
            skipBlankPages: previewOptions.skipBlankPages,
            pageOverrideDefaults: previewOptions.pageOverrideDefaults,
        },
        pageOverride: {
            rotationDegrees: pageOverride.rotationDegrees,
            layoutOverride: pageOverride.layoutOverride,
            excluded: pageOverride.excluded,
            manualSplit: pageOverride.manualSplit,
            manualSkewDegrees: pageOverride.manualSkewDegrees,
            manualContentBoxes: pageOverride.manualContentBoxes ?? {},
            manualZones: pageOverride.manualZones ?? {
                picture: [],
                fill: [],
            },
            placementOverrides: pageOverride.placementOverrides ?? {},
            outputModeOverride: pageOverride.outputModeOverride,
            marginsMm: pageOverride.marginsMm,
        },
    });
    return `${identity}${SCAN_CLEANUP_PREVIEW_CACHE_KEY_SEPARATOR}${validity}`;
}

export function createScanCleanupDetailTileCacheKey(
    sourceKey: string,
    viewports: NonNullable<IScanCleanupPreviewRequest['detail']>['viewports'],
) {
    return JSON.stringify({
        sourceKey,
        viewports: {
            ...(viewports.full === undefined ? {} : {full: viewports.full}),
            ...(viewports.left === undefined ? {} : {left: viewports.left}),
            ...(viewports.right === undefined ? {} : {right: viewports.right}),
        },
    });
}

/**
 * The cleaned preview the session publishes: a result together with the key it
 * was rendered for. Replaced whole, so a reader never pairs a result with
 * another request's key.
 */
export interface IScanCleanupPreviewFrame {
    readonly key: string;
    /** Changes only for a user, page or lifecycle transition, not a detection replan. */
    readonly presentationKey: string;
    readonly result: IScanCleanupPreviewResult;
}

function isCanceledPreview(value: TScanCleanupPreviewWireResult): value is {canceled: true} {
    return value.canceled === true;
}

function carriesRaster(value: TScanCleanupPreviewWireResult): value is IScanCleanupPreviewResult {
    return !isCanceledPreview(value) && value.rawImageData !== undefined;
}

export const useScanCleanupPreviewSession = (options: IUseScanCleanupPreviewSessionOptions) => {
    attachScanCleanupPageOverrideDefaults(
        options.settings.pageOverrides,
        options.settings.pageOverrideDefaults,
        options.settings.marginsMm,
    );
    const detected = (pageNumber: number) => options.getPreviewPageEvidence(pageNumber);
    const i18n = useTypedI18n();
    const {t} = i18n;
    const frame = shallowRef<IScanCleanupPreviewFrame | null>(null);
    const result = computed(() => frame.value?.result ?? null);
    const rawResult = shallowRef<IScanCleanupRawPreviewResult | null>(null);
    // A detail tile and the base preview it refines are one value: the tile is
    // dropped whenever its source key stops being the displayed one.
    const detail = shallowRef<{
        result: IScanCleanupPreviewResult;
        sourceKey: string;
    } | null>(null);
    const detailResult = computed(() => detail.value?.result ?? null);
    const detailLoading = ref(false);
    // The failed detail demand for the viewport on screen; the base stays
    // usable. Any newer demand, viewport or base clears it.
    const detailError = ref<IScanCleanupPreviewFailure | null>(null);
    const loading = ref(false);
    const error = ref('');
    const errorCode = ref<TScanCleanupErrorCode | null>(null);
    const viewMode = ref<'original' | 'cleaned'>(options.initialViewMode ?? 'cleaned');
    const cache = createScanCleanupPreviewCache();
    const detailSourceCache = createScanCleanupPreviewCache({
        maxEntries: 4,
        maxBytes: 48 * 1024 * 1024,
    });
    const resolvedPlacementAnchorsByPage = new Map<
        number,
        {
            calibrationIdentity: string;
            anchors: IScanCleanupPreviewRequest['placementAnchors'] | undefined;
        }
    >();
    // Map order is retention order.
    const metadataByPage = reactive(new Map<number, IScanCleanupPreviewResult['pageMetadata']>());
    let sequence = 0;
    let detailSequence = 0;
    // The base preview admission: each schedule passes its request and delay.
    let previewRequestDelayMs = 0;
    const previewRequest = useTimeoutFn(
        (sendRequest: () => void) => sendRequest(),
        () => previewRequestDelayMs,
        {immediate: false},
    );
    let scheduledPage: number | null = null;
    let scheduledKey: string | null = null;
    // A real source/revision lifecycle change retires this generation. A
    // guarded path-to-SHA identity promotion leaves it untouched so retained
    // rasters and in-flight preview work remain valid.
    const lifecycleGeneration = ref(0);
    let userPresentationGeneration = 0;
    let activeVisibleRequestId: TRequestId | null = null;
    // Keep the bounded in-flight window keyed by request. A page can have two
    // requests in flight when a navigation returns to it, so an array of page
    // numbers would remove the wrong entry when the older one settles last.
    const inFlightPreviewPages = new Map<TRequestId, number>();
    const inFlightPreviewRequestIds = new Set<TRequestId>();
    // A base preview pushes its page's raster the moment it exists and leaves
    // it out of the result it resolves with, so the bytes cross once. They wait
    // here for the result they belong to — which two callers can share, when a
    // navigation adopts a prefetch — and the window covers the visible page,
    // its two neighbours and the one still rendering. A retained entry is the
    // same buffer the cached result holds, so it costs nothing while that page
    // is cached.
    const streamedRawByRequest = new Map<TRequestId, IScanCleanupRawPreviewEvent>();
    const STREAMED_RAW_PAGES_MAX = 4;

    function retainedRawForPage(pageNumber: number) {
        return [...streamedRawByRequest.values()].reverse().find((raw) => raw.pageNumber === pageNumber);
    }

    function trimStreamedRaw() {
        while (streamedRawByRequest.size > STREAMED_RAW_PAGES_MAX) {
            const evictable = [...streamedRawByRequest.keys()].find(
                (requestId) => !inFlightPreviewRequestIds.has(requestId) && requestId !== activeVisibleRequestId,
            );
            if (evictable === undefined) {
                break;
            }
            streamedRawByRequest.delete(evictable);
        }
    }

    function retainPageMetadata(pageNumber: number, metadata: IScanCleanupPreviewResult['pageMetadata']) {
        metadataByPage.delete(pageNumber);
        metadataByPage.set(pageNumber, metadata);
        for (const oldest of metadataByPage.keys()) {
            if (metadataByPage.size <= PREVIEW_METADATA_PAGE_CACHE_LIMIT) {
                break;
            }
            metadataByPage.delete(oldest);
        }
    }

    const totalPages = computed(() => rawResult.value?.totalPages ?? result.value?.totalPages ?? Math.max(1, options.totalPages.value));
    const resolvedOptions = options.resolvedOptions ?? computed(() => toPlainScanCleanupOptions(options.settings));
    const resultCurrent = computed(() => frame.value !== null && frame.value.key === cacheKey());
    const resultPresentationKey = computed(() => frame.value?.presentationKey ?? '');

    function showFrame(key: string, previewResult: IScanCleanupPreviewResult) {
        frame.value = {
            key,
            presentationKey: presentationKey(key),
            result: previewResult,
        };
    }
    const classificationDiffersByPage = computed<ReadonlyMap<number, boolean>>(() => {
        const differences = new Map<number, boolean>();
        for (const [pageNumber, metadata] of metadataByPage) {
            const authoritative = options.authoritativeLayoutByPage.value.get(pageNumber);
            if (authoritative !== undefined && authoritative !== metadata.layoutClassification) {
                differences.set(pageNumber, true);
            }
        }
        return differences;
    });
    const prefetcher = createScanCleanupPreviewPrefetcher<IScanCleanupPreviewRequest, IScanCleanupPreviewResult>({
        isCached: (key) => cache.has(key),
        preview: (request) => {
            const capability = getScanCleanupCapability();
            if (!capability) {
                return Promise.reject(new Error('Scan cleanup preview is unavailable'));
            }
            inFlightPreviewRequestIds.add(request.requestId);
            return capability
                .preview(toBridgeSafeScanCleanupPayload(narrowScanCleanupPreviewRequestToPage(request)))
                .then((previewResult) => withStreamedRaw(previewResult, request.requestId))
                .finally(() => {
                    inFlightPreviewRequestIds.delete(request.requestId);
                    trimStreamedRaw();
                });
        },
        store: cachePreview,
    });

    function acceptStreamedRaw(raw: IScanCleanupRawPreviewEvent) {
        if (raw.ownerId !== options.ownerId || raw.documentRevision !== options.documentRevision.value) {
            return;
        }
        // Owner and revision survive a cancel; only a request still in flight
        // may stream a raster, so an event already queued when cancel() retired
        // the request IDs cannot resurrect the cleared preview.
        if (!inFlightPreviewRequestIds.has(raw.requestId)) {
            return;
        }
        streamedRawByRequest.delete(raw.requestId);
        streamedRawByRequest.set(raw.requestId, raw);
        trimStreamedRaw();
        // The raw page is shown while its cleanup runs, so it becomes the
        // displayed raster as soon as it lands — but only for the page the user
        // is actually on. A prefetched neighbour just waits for its result.
        if (raw.pageNumber === options.previewPage.value) {
            rawResult.value = raw;
        }
    }

    /**
     * Puts the streamed raster back on the result it was rendered from. A
     * detail tile reuses the already-held base raster locally. A cancelled
     * request has no result at all and answers with null.
     */
    function withStreamedRaw(previewResult: TScanCleanupPreviewWireResult, requestId: TRequestId): IScanCleanupPreviewResult | null {
        if (isCanceledPreview(previewResult)) {
            return null;
        }
        if (carriesRaster(previewResult)) {
            return previewResult;
        }
        // Detail tiles no longer echo the raw PNG. The page number is the
        // inexpensive identity tying them to the base raster already held by
        // this session; revision ownership was checked when that raster event
        // was accepted.
        const heldBase =
            rawResult.value?.pageNumber === previewResult.pageNumber
                ? rawResult.value
                : result.value?.pageNumber === previewResult.pageNumber
                  ? result.value
                  : undefined;
        const streamed =
            streamedRawByRequest.get(previewResult.requestId ?? requestId) ?? retainedRawForPage(previewResult.pageNumber) ?? heldBase;
        if (!streamed) {
            throw new Error('Scan cleanup preview arrived without its page raster');
        }
        return {
            ...previewResult,
            rawImageData: streamed.rawImageData,
        };
    }

    function cacheKey(
        pageNumber = options.previewPage.value,
        previewOptions = resolvedOptions.value,
        previewSourcePath = options.sourcePath.value,
        resolvedPlacementAnchors: IScanCleanupPreviewRequest['placementAnchors'] | null = null,
    ) {
        const authoritativeLayout = options.authoritativeLayoutByPage.value.get(pageNumber) ?? null;
        return (
            createScanCleanupPreviewCacheKey(
                pageNumber,
                previewOptions,
                previewSourcePath,
                options.documentRevision.value,
                detected(pageNumber)?.documentPrior ?? null,
                options.documentCanvasSignature.value,
                matchedCanvasOverridesSignature.value,
                resolveOutputModeRecommendation(pageNumber) ?? null,
                resolveSoftAlphaForegroundRecommendation(pageNumber) ?? null,
                authoritativeLayout,
                detected(pageNumber)?.pagePlanEvidence ?? null,
                options.layoutDetectionComplete.value,
                resolvedPlacementAnchors ?? placementAnchorsFor(pageNumber) ?? null,
            ) + `${SCAN_CLEANUP_PREVIEW_CACHE_KEY_SEPARATOR}lifecycle:${String(lifecycleGeneration.value)}`
        );
    }

    function placementAnchorCalibrationIdentity(summary: IScanCleanupPlacementAnchorSummary) {
        return JSON.stringify(summary.identity);
    }

    function retainResolvedPlacementAnchors(
        pageNumber: number,
        summary: IScanCleanupPlacementAnchorSummary,
        anchors: IScanCleanupPreviewRequest['placementAnchors'] | undefined,
    ) {
        resolvedPlacementAnchorsByPage.delete(pageNumber);
        resolvedPlacementAnchorsByPage.set(pageNumber, {
            calibrationIdentity: placementAnchorCalibrationIdentity(summary),
            anchors: anchors !== undefined && Object.keys(anchors).length > 0 ? anchors : undefined,
        });
        while (resolvedPlacementAnchorsByPage.size > PREVIEW_METADATA_PAGE_CACHE_LIMIT) {
            const oldest = resolvedPlacementAnchorsByPage.keys().next().value;
            if (oldest === undefined) {
                break;
            }
            resolvedPlacementAnchorsByPage.delete(oldest);
        }
    }

    function placementAnchorsFor(pageNumber: number) {
        const summary = options.placementAnchorSummary?.value ?? null;
        const resolved = summary === null ? undefined : resolvedPlacementAnchorsByPage.get(pageNumber);
        if (resolved !== undefined && summary !== null && resolved.calibrationIdentity === placementAnchorCalibrationIdentity(summary)) {
            return resolved.anchors;
        }
        // A retained result store places pages from the main-process
        // calibration; while that is missing (pending or failed) the renderer's
        // map covers only its retained window and must not stand in for it.
        // Without a store, the run sends the renderer's map, so the preview
        // shows that map too, whether or not a summary was built.
        if (summary === null && (options.detectionResultStoreId?.value ?? null) !== null && usesScanCleanupInkAlignment(options.settings)) {
            return undefined;
        }
        const anchors = options.placementAnchorsByPage.value.get(pageNumber);
        return anchors !== undefined && Object.keys(anchors).length > 0 ? anchors : undefined;
    }

    function presentationKey(key: string) {
        const [identity = key, validity = '{}'] = key.split(SCAN_CLEANUP_PREVIEW_CACHE_KEY_SEPARATOR);
        // Another page's override is the user's edit too: the frame redrawn for
        // it is a new presentation, not a replan the pane may keep pinned.
        const {canvasOverrides = ''} = JSON.parse(validity) as {canvasOverrides?: string};
        return (
            `${identity}${SCAN_CLEANUP_PREVIEW_CACHE_KEY_SEPARATOR}canvas:${canvasOverrides}` +
            SCAN_CLEANUP_PREVIEW_CACHE_KEY_SEPARATOR +
            `lifecycle:${String(lifecycleGeneration.value)}` +
            `${SCAN_CLEANUP_PREVIEW_CACHE_KEY_SEPARATOR}user:${String(userPresentationGeneration)}`
        );
    }

    // The layouts the main process measures the matched canvas from. They are
    // the renderer's own view of the document — the detection the user watched
    // run, plus their manual layout choices — so the preview it draws and the
    // run it starts are measured against the same document.
    //
    // Derived once per change of that view rather than once per request: every
    // preview and prefetch candidate in a burst reads the same record.
    const layoutByPage = computed(() => toScanCleanupLayoutByPage(options.authoritativeLayoutByPage.value));
    // The other half of what the canvas is measured from: the page overrides of
    // the whole document, which a single page's cache key cannot see. Derived
    // once per settings change for the same reason — a burst reads it, it does
    // not recompute it.
    const matchedCanvasOverridesSignature = computed(() =>
        scanCleanupMatchedCanvasOverridesSignature(options.settings.pageOverrides, options.settings.pageOverrideDefaults),
    );

    function resolveOutputModeRecommendation(pageNumber: number) {
        const pageOverride = getScanCleanupPageOverride(
            options.settings.pageOverrides,
            requirePageNumber(pageNumber),
            options.settings.pageOverrideDefaults,
            options.settings.marginsMm,
        );
        if (
            options.settings.preserveOriginalQuality ||
            options.settings.outputMode !== 'auto' ||
            pageOverride.outputModeOverride !== undefined
        ) {
            return undefined;
        }
        return resolveScanCleanupEffectiveOutputMode({
            options: options.settings,
            pageOverride,
            detectedOutputMode: detected(pageNumber)?.recommendedOutputMode,
        });
    }

    function resolveSoftAlphaForegroundRecommendation(pageNumber: number) {
        return resolveOutputModeRecommendation(pageNumber) === 'mixed'
            ? detected(pageNumber)?.softAlphaForegroundRecommendation
            : undefined;
    }

    function requiresAuthoritativePlacement(previewOptions: IScanCleanupOptions, key: string) {
        return (
            options.resolvePlacementAnchorsForPage !== undefined &&
            usesScanCleanupInkAlignment(previewOptions) &&
            (options.placementAnchorCalibrationPending?.value === true ||
                (options.placementAnchorSummary?.value !== null && options.placementAnchorSummary?.value !== undefined && !cache.has(key)))
        );
    }

    function placementCalibrationIsPending(previewOptions: IScanCleanupOptions) {
        return (
            options.resolvePlacementAnchorsForPage !== undefined &&
            options.placementAnchorSummary?.value === null &&
            options.placementAnchorCalibrationPending?.value === true &&
            usesScanCleanupInkAlignment(previewOptions)
        );
    }

    function nextRequestId() {
        // The request ID only correlates streamed/raw responses. Keep it opaque
        // and fixed-size instead of embedding the potentially large cache key.
        return createRequestId('scan-cleanup-preview');
    }

    /**
     * One page's preview request: the settings, plus what detection and the
     * document plan know about the page now. Read when the request is sent, as
     * the cache key it is stored under is, so the two never disagree.
     */
    function pageRequest(
        requestId: TRequestId,
        pageNumber: number,
        previewOptions: IScanCleanupOptions,
        previewSourcePath: TDocumentRef,
        placementAnchors: IScanCleanupPreviewRequest['placementAnchors'] | undefined,
    ): IScanCleanupPreviewRequest {
        const documentPrior = detected(pageNumber)?.documentPrior ?? undefined;
        const outputModeRecommendation = resolveOutputModeRecommendation(pageNumber);
        const softAlphaForegroundRecommendation = resolveSoftAlphaForegroundRecommendation(pageNumber);
        const pagePlanEvidence = detected(pageNumber)?.pagePlanEvidence;
        return {
            requestId,
            sourcePdfPath: previewSourcePath,
            ownerId: options.ownerId,
            documentRevision: options.documentRevision.value,
            pageNumber: requirePageNumber(pageNumber),
            options: previewOptions,
            ...(documentPrior === undefined ? {} : {documentPrior}),
            ...(outputModeRecommendation === undefined ? {} : {outputModeRecommendation}),
            ...(softAlphaForegroundRecommendation === undefined ? {} : {softAlphaForegroundRecommendation}),
            ...(pagePlanEvidence === undefined ? {} : {pagePlanEvidence}),
            ...(placementAnchors === undefined ? {} : {placementAnchors}),
            layoutDetectionComplete: options.layoutDetectionComplete.value,
            layoutByPage: layoutByPage.value,
        };
    }

    /**
     * Fetches one page's anchors from the main-process calibration. False when
     * the calibration moved while they were being resolved.
     */
    async function retainStorePlacementAnchors(pageNumber: number) {
        const resolved = await options.resolvePlacementAnchorsForPage?.(pageNumber);
        if (resolved === undefined) {
            return true;
        }
        const currentSummary = options.placementAnchorSummary?.value;
        if (
            currentSummary === null ||
            currentSummary === undefined ||
            placementAnchorCalibrationIdentity(resolved.summary) !== placementAnchorCalibrationIdentity(currentSummary)
        ) {
            return false;
        }
        retainResolvedPlacementAnchors(pageNumber, resolved.summary, resolved.placementAnchors);
        return true;
    }

    function cachePreview(key: string, previewResult: IScanCleanupPreviewResult) {
        if (!key.endsWith(`${SCAN_CLEANUP_PREVIEW_CACHE_KEY_SEPARATOR}lifecycle:${String(lifecycleGeneration.value)}`)) {
            return;
        }
        cache.set(key, previewResult);
    }

    function invalidateDetailRequest() {
        detailSequence += 1;
        detailLoading.value = false;
        detailError.value = null;
    }

    function clearDetail() {
        invalidateDetailRequest();
        detail.value = null;
    }

    function cancel(invalidateRawCache = true) {
        sequence += 1;
        prefetcher.supersede();
        previewRequest.stop();
        invalidateDetailRequest();
        // Cancellation retires work, not pixels. A completed frame remains the
        // displayed stale value until its replacement lands; lifecycle changes
        // clear it explicitly in their watcher below.
        // Every request a streamed raster could still belong to is superseded.
        streamedRawByRequest.clear();
        inFlightPreviewPages.clear();
        inFlightPreviewRequestIds.clear();
        activeVisibleRequestId = null;
        loading.value = false;
        if (!options.sourcePath.value) {
            return;
        }
        const capability = getScanCleanupCapability();
        if (!capability) {
            return;
        }
        void capability
            .cancelPreview({
                sourcePdfPath: options.sourcePath.value,
                ownerId: options.ownerId,
                documentRevision: options.documentRevision.value,
                invalidateRawCache,
            })
            .catch(() => undefined);
    }

    function pauseForRun() {
        cancel(false);
    }

    async function scheduleAdjacentPrefetch(
        previewResult: IScanCleanupPreviewResult,
        previewOptions: IScanCleanupOptions,
        previewSourcePath: TDocumentRef,
        requestSequence = sequence,
    ) {
        const adjacentPages = [previewResult.pageNumber + 1, previewResult.pageNumber - 1].filter(
            (pageNumber) => pageNumber >= 1 && pageNumber <= previewResult.totalPages,
        );
        const candidates = (
            await Promise.all(
                adjacentPages.map(async (pageNumber) => {
                    if (
                        options.resolvePlacementAnchorsForPage !== undefined &&
                        !cache.has(cacheKey(pageNumber, previewOptions, previewSourcePath, placementAnchorsFor(pageNumber))) &&
                        !(await retainStorePlacementAnchors(pageNumber).catch(() => false))
                    ) {
                        return null;
                    }
                    const placementAnchors = placementAnchorsFor(pageNumber);
                    return {
                        key: cacheKey(pageNumber, previewOptions, previewSourcePath, placementAnchors),
                        request: pageRequest(nextRequestId(), pageNumber, previewOptions, previewSourcePath, placementAnchors),
                    };
                }),
            )
        ).filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null);
        if (requestSequence !== sequence) {
            return;
        }
        prefetcher.schedule(candidates);
    }

    function schedule(immediate = false) {
        // Base-preview identity owns detail identity. Invalidate detail work
        // before the availability guard so source removal/deactivation cannot
        // leave an older viewport render or its failure alive.
        invalidateDetailRequest();
        if (!options.active() || !options.sourcePath.value) {
            return;
        }
        const capability = getScanCleanupCapability();
        if (!capability) {
            error.value = t('scanCleanup.preview.unavailable');
            errorCode.value = 'tools-unavailable';
            return;
        }
        const requestSequence = ++sequence;
        previewRequest.stop();
        const requestPage = options.previewPage.value;
        const requestOptions = resolvedOptions.value;
        const requestSourcePath = options.sourcePath.value;
        const key = cacheKey(requestPage, requestOptions, requestSourcePath);
        const requestId = nextRequestId();
        activeVisibleRequestId = requestId;
        const retainedRaw = retainedRawForPage(requestPage);
        if (retainedRaw) {
            rawResult.value = retainedRaw;
        }
        const initialRequest = scheduledPage === null;
        // A navigation reaches the previous page's key unchanged; anything else
        // — a settings change, a new document prior, another source — makes
        // every page's work stale and keeps no window.
        const navigated = scheduledPage !== null && scheduledKey === cacheKey(scheduledPage, requestOptions, requestSourcePath);
        scheduledPage = requestPage;
        scheduledKey = key;
        const activeDetailOutputMode = resolveDetailOutputMode(requestPage);
        if (activeDetailOutputMode === undefined || detail.value?.sourceKey !== detailSourceKey(key, activeDetailOutputMode)) {
            detail.value = null;
        }
        // Look the page up before cancelling anything: a navigation that the
        // cache can answer has no reason to disturb work in flight at all.
        const cached = requiresAuthoritativePlacement(requestOptions, key) ? undefined : cache.get(key);
        // Original must never keep painting the raw bytes from the page that
        // was just left while this page has no cached raster of its own.
        if (!cached && viewMode.value === 'original') {
            rawResult.value = null;
        }
        if (cached) {
            showFrame(key, cached);
            rawResult.value = cached;
            loading.value = false;
            error.value = '';
            errorCode.value = null;
            void scheduleAdjacentPrefetch(cached, requestOptions, requestSourcePath);
            return;
        }
        if (!navigated) {
            prefetcher.supersede();
        }
        void capability
            .cancelPreview({
                sourcePdfPath: requestSourcePath,
                ownerId: options.ownerId,
                documentRevision: options.documentRevision.value,
                invalidateRawCache: false,
                // The page being opened, its neighbours, and the page still
                // rendering: the adjacent prefetch of the page the user is about to
                // reach used to be the first casualty of reaching it. Only the most
                // recent render is held, so a sustained walk retires the older one
                // instead of accumulating pipelines. Anything that is not a
                // navigation names no window and cancels the document, as before.
                ...(navigated
                    ? {
                          retainPages: [
                              ...new Set([...[...inFlightPreviewPages.values()].slice(-1), requestPage - 1, requestPage, requestPage + 1]),
                          ].filter((pageNumber) => pageNumber >= 1 && pageNumber <= totalPages.value),
                      }
                    : {}),
            })
            .catch(() => undefined);
        if (placementCalibrationIsPending(requestOptions)) {
            loading.value = true;
            error.value = '';
            errorCode.value = null;
            return;
        }
        loading.value = true;
        error.value = '';
        errorCode.value = null;
        const runPreview = async () => {
            try {
                if (options.resolvePlacementAnchorsForPage !== undefined && !(await retainStorePlacementAnchors(requestPage))) {
                    return;
                }
                const resolvedPlacementAnchors = placementAnchorsFor(requestPage);
                if (requestSequence !== sequence) {
                    return;
                }
                const resolvedKey = cacheKey(requestPage, requestOptions, requestSourcePath, resolvedPlacementAnchors);
                const resolvedCached = cache.get(resolvedKey);
                if (resolvedCached) {
                    showFrame(resolvedKey, resolvedCached);
                    rawResult.value = resolvedCached;
                    loading.value = false;
                    void scheduleAdjacentPrefetch(resolvedCached, requestOptions, requestSourcePath, requestSequence);
                    return;
                }
                // One request per page switch. Its raw raster arrives over
                // `onPreviewRaw` a sidecar run ahead of the cleaned outputs and
                // is displayed there; this promise settles with the cleaned
                // result that supersedes it.
                const previewResult = withStreamedRaw(
                    await capability.preview(
                        toBridgeSafeScanCleanupPayload(
                            narrowScanCleanupPreviewRequestToPage({
                                ...pageRequest(requestId, requestPage, requestOptions, requestSourcePath, resolvedPlacementAnchors),
                                visible: true,
                            }),
                        ),
                    ),
                    requestId,
                );
                // A canceled request has no result. The owner keeps the
                // visible page's run through supersession, so it cancels one
                // only for a newer request or a closed source, and each of
                // those brings its own successor.
                if (previewResult === null) {
                    return;
                }
                // Cached before the staleness check: the key names the page and
                // the options that produced this result, so a preview that
                // outlived the navigation that asked for it is still exactly
                // what the next visit to that page needs.
                cachePreview(resolvedKey, previewResult);
                if (requestSequence !== sequence) {
                    return;
                }
                retainPageMetadata(previewResult.pageNumber, previewResult.pageMetadata);
                showFrame(resolvedKey, previewResult);
                void scheduleAdjacentPrefetch(previewResult, requestOptions, requestSourcePath, requestSequence);
            } catch (caught) {
                if (requestSequence !== sequence || isAbortError(caught)) {
                    return;
                }
                const failure = describePreviewFailure(caught);
                error.value = failure.message;
                errorCode.value = failure.code;
            } finally {
                if (requestSequence === sequence) {
                    loading.value = false;
                }
            }
        };
        // A deliberate page turn goes straight through: nothing is rendering, so
        // waiting would only delay the page. A turn made while a page is still
        // rendering is a burst — every navigation restarts this timer, so a
        // flick issues one request for the page it stops on instead of one per
        // page it passes. Everything else is an options change and keeps the
        // settled debounce it has always had.
        previewRequestDelayMs = immediate
            ? 0
            : initialRequest
              ? 0
              : navigated
                ? inFlightPreviewPages.size === 0
                    ? 0
                    : SCAN_CLEANUP_PREVIEW_BURST_DEBOUNCE_MS
                : 250;
        previewRequest.start(() => {
            inFlightPreviewPages.set(requestId, requestPage);
            inFlightPreviewRequestIds.add(requestId);
            void runPreview().finally(() => {
                inFlightPreviewPages.delete(requestId);
                inFlightPreviewRequestIds.delete(requestId);
                trimStreamedRaw();
            });
        });
    }

    function resolveDetailOutputMode(pageNumber = options.previewPage.value) {
        const pageOverride = getScanCleanupPageOverride(
            options.settings.pageOverrides,
            requirePageNumber(pageNumber),
            options.settings.pageOverrideDefaults,
            options.settings.marginsMm,
        );
        const renderedOutputMode =
            result.value?.pageNumber === pageNumber
                ? (result.value.outputs[0]?.metadata.outputMode ?? result.value.pageMetadata.recommendedOutputMode)
                : undefined;
        return resolveScanCleanupEffectiveOutputMode({
            options: options.settings,
            pageOverride,
            detectedOutputMode: detected(pageNumber)?.recommendedOutputMode,
            renderedOutputMode,
        });
    }

    function detailSourceKey(baseKey: string, outputMode: ReturnType<typeof resolveDetailOutputMode>) {
        return JSON.stringify({
            baseKey,
            outputMode,
        });
    }

    function describePreviewFailure(caught: unknown): IScanCleanupPreviewFailure {
        const envelope = findSerializableErrorEnvelope(caught, SCAN_CLEANUP_ERROR_ENVELOPE_SCHEMA);
        if (envelope) {
            return {
                message: formatScanCleanupErrorByCode(i18n, envelope.code, envelope.message, envelope.details?.scratchShortfall),
                code: envelope.code,
            };
        }
        return {
            message:
                caught instanceof Error && !getErrorMessage(caught).includes(SERIALIZABLE_ERROR_PREFIX)
                    ? formatScanCleanupErrorByCode(i18n, 'internal', caught)
                    : t('scanCleanup.preview.unavailable'),
            code: 'internal',
        };
    }

    async function requestDetail(viewports: NonNullable<IScanCleanupPreviewRequest['detail']>['viewports']) {
        // A new demand replaces whatever the last one ended with.
        detailError.value = null;
        const capability = getScanCleanupCapability();
        if (
            !options.active() ||
            !options.sourcePath.value ||
            options.settings.preserveOriginalQuality ||
            !resultCurrent.value ||
            !capability
        ) {
            return;
        }
        prefetcher.supersede();
        const requestPage = options.previewPage.value;
        const requestOptions = resolvedOptions.value;
        const requestSourcePath = options.sourcePath.value;
        const outputMode = resolveDetailOutputMode(requestPage);
        if (outputMode === undefined) {
            detailLoading.value = false;
            return;
        }
        const baseKey = cacheKey(requestPage, requestOptions, requestSourcePath);
        const sourceKey = detailSourceKey(baseKey, outputMode);
        const tileKey = createScanCleanupDetailTileCacheKey(sourceKey, viewports);
        const requestSequence = ++detailSequence;
        const cached = detailSourceCache.get(tileKey);
        detail.value = cached
            ? {
                  result: cached,
                  sourceKey,
              }
            : null;
        detailLoading.value = !cached;
        if (cached) {
            return;
        }
        try {
            // The same page inputs its base was rendered with, so the detail
            // refines that base rather than missing it.
            const requestId = nextRequestId();
            const wireResult = await capability.preview(
                toBridgeSafeScanCleanupPayload(
                    narrowScanCleanupPreviewRequestToPage({
                        ...pageRequest(requestId, requestPage, requestOptions, requestSourcePath, placementAnchorsFor(requestPage)),
                        detail: {
                            viewports,
                            outputMode,
                        },
                    }),
                ),
            );
            const next = withStreamedRaw(wireResult, requestId);
            if (requestSequence !== detailSequence || baseKey !== cacheKey()) {
                return;
            }
            // A canceled tile was retired by the owner for newer work, which
            // asks for its own tile.
            if (next === null) {
                return;
            }
            detailSourceCache.set(tileKey, next);
            detail.value = {
                result: next,
                sourceKey,
            };
        } catch (caught) {
            const normalizedMessage = caught instanceof Error ? stripIpcInvocationPrefix(getErrorMessage(caught)) : '';
            if (normalizedMessage.startsWith('Scan cleanup detail geometry is unavailable')) {
                cache.delete(baseKey);
                schedule();
                return;
            }
            // A real failure leaves the loaded base usable; the workspace tells
            // it once, and its Retry asks for the viewport again.
            if (requestSequence === detailSequence && baseKey === cacheKey() && !isAbortError(caught)) {
                const failure = describePreviewFailure(caught);
                if (failure.code !== 'canceled') {
                    detailError.value = failure;
                }
            }
        } finally {
            if (requestSequence === detailSequence) {
                detailLoading.value = false;
            }
        }
    }

    function retry() {
        userPresentationGeneration += 1;
        cache.delete(cacheKey(options.previewPage.value));
        schedule();
    }

    function navigate(delta: number) {
        const page = Math.min(totalPages.value, Math.max(1, options.previewPage.value + delta));
        options.selectPage(page, 'single', createScanCleanupNaturalPageOrder(totalPages.value));
    }

    const stopRawStream = getScanCleanupCapability()?.onPreviewRaw(acceptStreamedRaw) ?? null;

    watch(
        options.active,
        (active) => {
            if (active) {
                schedule();
            }
            // An inactive tab still owns its document. Stop only renderer-visible
            // preview work here: detection and a Run waiting on it share the raw
            // raster document in the main process, so invalidating that document
            // would abort the run with “Scan cleanup document was closed”. A real
            // document lifecycle change and unmount still call cancel() below and
            // invalidate the retained document.
            else {
                cancel(false);
            }
        },
        {immediate: true},
    );
    watch(options.lifecycleDocumentKey, (key, previousKey) => {
        if (
            previousKey !== null &&
            isScanCleanupLifecycleIdentityPromotion(
                previousKey,
                key,
                options.sourcePath.value,
                options.sourceSha256?.value ?? null,
                options.documentRevision.value,
            )
        ) {
            // The source path, revision, raster bytes, and native request are
            // unchanged. Promotion only changes detection's restore alias;
            // retaining this session avoids canceling an in-flight preview or
            // discarding the already streamed raster.
            return;
        }
        // cancel() retires every request and its streamed rasters; what is
        // left is what the retired document had published.
        cancel();
        lifecycleGeneration.value += 1;
        error.value = '';
        errorCode.value = null;
        cache.clear();
        detailSourceCache.clear();
        metadataByPage.clear();
        resolvedPlacementAnchorsByPage.clear();
        frame.value = null;
        rawResult.value = null;
        detail.value = null;
    });
    watch(
        () => {
            const summary = options.placementAnchorSummary?.value;
            return summary === null || summary === undefined ? null : placementAnchorCalibrationIdentity(summary);
        },
        (identity) => {
            for (const [pageNumber, resolved] of resolvedPlacementAnchorsByPage) {
                if (resolved.calibrationIdentity !== identity) {
                    resolvedPlacementAnchorsByPage.delete(pageNumber);
                }
            }
        },
    );
    watch([cacheKey, () => options.placementAnchorCalibrationPending?.value], () => schedule());
    onBeforeUnmount(() => {
        stopRawStream?.();
        cancel();
    });

    return {
        cancel,
        classificationDiffersByPage,
        clearDetail,
        error,
        errorCode,
        frame,
        detailError,
        detailLoading,
        detailResult,
        loading,
        metadataByPage,
        navigate,
        pauseForRun,
        result,
        resultPresentationKey,
        rawResult,
        resultCurrent,
        retry,
        requestDetail,
        schedule,
        totalPages,
        viewMode,
    };
};
