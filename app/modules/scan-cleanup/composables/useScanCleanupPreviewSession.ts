import { getErrorMessage } from '@app/utils/error';
import {
    isScanCleanupErrorEnvelope,
    resolveScanCleanupEffectiveOutputMode,
    type IScanCleanupOptions,
    type IScanCleanupDocumentPrior,
    type IScanCleanupPagePlanEvidence,
    type IScanCleanupPlacementAnchorSummary,
    type IScanCleanupPlacementAnchor,
    type IScanCleanupRawPreviewEvent,
    type IScanCleanupRawPreviewResult,
    type IScanCleanupPreviewRequest,
    type IScanCleanupPreviewResult,
    type TScanCleanupErrorCode,
    type TScanCleanupOutputMode,
    type TScanCleanupOutputHalf,
    type TScanCleanupPreviewWireResult,
} from '@contracts/electronApiScanCleanup';
import {
    findSerializableErrorEnvelope,
    SERIALIZABLE_ERROR_PREFIX,
} from '@contracts/serializableError';
import type {TDocumentRef} from '@contracts/documentRef';
import {
    createRequestId,
    type TRequestId,
} from '@contracts/shared';
import {requirePageNumber} from '@contracts/pageNumbers';
import type {TScanCleanupPlacementAnchorsByPage} from '@contracts/scanCleanupPageOverrides';
import {
    attachScanCleanupPageOverrideDefaults,
    getScanCleanupPageOverride,
    resolveScanCleanupOutputPlacement,
    scanCleanupMatchedCanvasOverridesSignature,
    toScanCleanupLayoutByPage,
} from '@contracts/scanCleanupPageOverrides';
import type {
    ComputedRef,
    Ref,
} from 'vue';
import {createScanCleanupPreviewPrefetcher} from '@app/modules/scan-cleanup/runtime/scanCleanupPreviewPrefetcher';
import {isScanCleanupLifecycleIdentityPromotion} from '@app/modules/scan-cleanup/runtime/scanCleanupDetectionSessionCache';
import {
    createScanCleanupPreviewCache,
    SCAN_CLEANUP_PREVIEW_CACHE_KEY_SEPARATOR,
} from '@app/modules/scan-cleanup/runtime/createScanCleanupPreviewCache';
import {toPlainScanCleanupOptions} from '@app/modules/scan-cleanup/persistence/preferencesRepository';
import {getScanCleanupCapability} from '@app/utils/getScanCleanupCapability';
import {toBridgeSafeScanCleanupPayload} from '@app/modules/scan-cleanup/runtime/toBridgeSafeScanCleanupPayload';
import {
    createScanCleanupNaturalPageOrder,
    type TScanCleanupOrderedPages,
    type TScanCleanupSelectionIntent,
} from '@app/modules/scan-cleanup/runtime/resolveScanCleanupSelection';

type TScanCleanupLayoutClassification = IScanCleanupPreviewResult['pageMetadata']['layoutClassification'];

/**
 * Longer than the ~400-500 ms cadence of a rail flick measured in the user's
 * recording, so a burst of navigations coalesces into the page it ends on,
 * and only ever applied while a preview is already rendering.
 */
const SCAN_CLEANUP_PREVIEW_BURST_DEBOUNCE_MS = 600;
// How many times a page may re-ask for a preview that answered `canceled`
// before it stops. Two covers losing the run to a supersede and then to the
// prefetch drop behind it; beyond that something is wrong that retrying will
// not fix.
const PREVIEW_CANCELLATION_RETRY_LIMIT = 2;
const PREVIEW_METADATA_PAGE_CACHE_LIMIT = 256;

type TScanCleanupDetailDiagnostic =
    | {
        kind: 'not-requested';
        reason: 'ineligible' | 'missing-capability' | 'unsupported-output-mode'
    }
    | {
        kind: 'bridge-null';
        attempts: number
    }
    | {
        kind: 'service-failure';
        attempts: number;
        message: string
    }
    | null;

interface IUseScanCleanupPreviewSessionOptions {
    active: () => boolean;
    authoritativeLayoutByPage: ComputedRef<ReadonlyMap<number, TScanCleanupLayoutClassification>>;
    documentCanvasSignature: Ref<string>;
    documentRevision: ComputedRef<string>;
    documentPriorByPage: ReadonlyMap<number, IScanCleanupDocumentPrior>;
    initialViewMode?: 'original' | 'cleaned' | undefined;
    layoutDetectionComplete: ComputedRef<boolean>;
    lifecycleDocumentKey: ComputedRef<string | null>;
    ownerId: string;
    pagePlanEvidenceByPage: ReadonlyMap<number, IScanCleanupPagePlanEvidence>;
    placementAnchorSummary?: Readonly<Ref<IScanCleanupPlacementAnchorSummary | null>>;
    placementAnchorsByPage: ComputedRef<TScanCleanupPlacementAnchorsByPage>;
    previewPage: Ref<number>;
    resolvedOptions?: ComputedRef<IScanCleanupOptions>;
    recommendedOutputModeByPage: ReadonlyMap<number, TScanCleanupOutputMode>;
    sourceSha256?: ComputedRef<string | null>;
    softAlphaForegroundRecommendationByPage: ReadonlyMap<number, boolean>;
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
    const pageOverride = getScanCleanupPageOverride(
        previewOptions.pageOverrides,
        requirePageNumber(pageNumber),
    );
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
            despeckleLevel: previewOptions.despeckleLevel
                ?? ((previewOptions.despeckle ?? true) ? 'normal' : 'off'),
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
    const {t} = useTypedI18n();
    const result = shallowRef<IScanCleanupPreviewResult | null>(null);
    const rawResult = shallowRef<IScanCleanupRawPreviewResult | null>(null);
    const resultKey = shallowRef<string | null>(null);
    const resultPresentationKey = shallowRef('');
    const detailResult = shallowRef<IScanCleanupPreviewResult | null>(null);
    const detailLoading = ref(false);
    const detailDiagnostic = ref<TScanCleanupDetailDiagnostic>(null);
    const loading = ref(false);
    const error = ref('');
    const errorCode = ref<TScanCleanupErrorCode | null>(null);
    const viewMode = ref<'original' | 'cleaned'>(options.initialViewMode ?? 'cleaned');
    const cache = createScanCleanupPreviewCache();
    const detailSourceCache = createScanCleanupPreviewCache({
        maxEntries: 4,
        maxBytes: 48 * 1024 * 1024,
    });
    const metadataByPage = reactive(new Map<number, IScanCleanupPreviewResult['pageMetadata']>());
    const metadataPageOrder = new Set<number>();
    let sequence = 0;
    let detailSequence = 0;
    let displayedDetailSourceKey: string | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let detailRetryTimer: ReturnType<typeof setTimeout> | null = null;
    let detailRetriesRemaining = 0;
    let detailAttemptCount = 0;
    let scheduledPage: number | null = null;
    let scheduledKey: string | null = null;
    let cancellationRetryKey: string | null = null;
    let cancellationRetries = 0;
    // A real source/revision lifecycle change retires this generation. A
    // guarded path-to-SHA identity promotion leaves it untouched so retained
    // rasters and in-flight preview work remain valid.
    const lifecycleGeneration = ref(0);
    let userPresentationGeneration = 0;
    let activeVisibleRequestId: TRequestId | null = null;
    // Keep the bounded in-flight window keyed by request. A page can have two
    // attempts during a cancellation retry, so an array of page numbers would
    // remove the wrong entry when the older attempt settles last.
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
        return [...streamedRawByRequest.values()]
            .reverse()
            .find(raw => raw.pageNumber === pageNumber);
    }

    function trimStreamedRaw() {
        while (streamedRawByRequest.size > STREAMED_RAW_PAGES_MAX) {
            const evictable = [...streamedRawByRequest.keys()].find(requestId => (
                !inFlightPreviewRequestIds.has(requestId)
                && requestId !== activeVisibleRequestId
            ));
            if (evictable === undefined) break;
            streamedRawByRequest.delete(evictable);
        }
    }

    function retainPageMetadata(
        pageNumber: number,
        metadata: IScanCleanupPreviewResult['pageMetadata'],
    ) {
        metadataByPage.delete(pageNumber);
        metadataByPage.set(pageNumber, metadata);
        metadataPageOrder.delete(pageNumber);
        metadataPageOrder.add(pageNumber);
        while (metadataPageOrder.size > PREVIEW_METADATA_PAGE_CACHE_LIMIT) {
            const oldest = metadataPageOrder.values().next().value;
            if (oldest === undefined) {
                break;
            }
            metadataPageOrder.delete(oldest);
            metadataByPage.delete(oldest);
        }
    }

    const totalPages = computed(() => rawResult.value?.totalPages
        ?? result.value?.totalPages
        ?? Math.max(1, options.totalPages.value));
    const resolvedOptions = options.resolvedOptions
        ?? computed(() => toPlainScanCleanupOptions(options.settings));
    const resultCurrent = computed(() => result.value !== null && resultKey.value === cacheKey());
    const classificationDiffersByPage = computed<ReadonlyMap<number, boolean>>(() => {
        const differences = new Map<number, boolean>();
        for (const [
            pageNumber,
            metadata,
        ] of metadataByPage) {
            const authoritative = options.authoritativeLayoutByPage.value.get(pageNumber);
            if (authoritative !== undefined && authoritative !== metadata.layoutClassification) {
                differences.set(pageNumber, true);
            }
        }
        return differences;
    });
    const prefetcher = createScanCleanupPreviewPrefetcher<IScanCleanupPreviewRequest, IScanCleanupPreviewResult>({
        isCached: key => cache.has(key),
        preview: request => {
            const capability = getScanCleanupCapability();
            if (!capability) {
                return Promise.reject(new Error('Scan cleanup preview is unavailable'));
            }
            inFlightPreviewRequestIds.add(request.requestId);
            return capability.preview(toBridgeSafeScanCleanupPayload(request))
                .then(previewResult => withStreamedRaw(previewResult, request.requestId))
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
    function withStreamedRaw(
        previewResult: TScanCleanupPreviewWireResult,
        requestId: TRequestId,
    ): IScanCleanupPreviewResult | null {
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
        const heldBase = rawResult.value?.pageNumber === previewResult.pageNumber
            ? rawResult.value
            : result.value?.pageNumber === previewResult.pageNumber
                ? result.value
                : undefined;
        const streamed = streamedRawByRequest.get(previewResult.requestId ?? requestId)
            ?? retainedRawForPage(previewResult.pageNumber)
            ?? heldBase;
        if (!streamed) throw new Error('Scan cleanup preview arrived without its page raster');
        return {
            ...previewResult,
            rawImageData: streamed.rawImageData,
        };
    }

    function cacheKey(
        pageNumber = options.previewPage.value,
        previewOptions = resolvedOptions.value,
        previewSourcePath = options.sourcePath.value,
    ) {
        const authoritativeLayout = options.authoritativeLayoutByPage.value.get(pageNumber);
        const renderedLayout = metadataByPage.get(pageNumber)?.layoutClassification;
        const unresolvedPageLayout = authoritativeLayout === renderedLayout
            ? null
            : authoritativeLayout ?? null;
        return createScanCleanupPreviewCacheKey(
            pageNumber,
            previewOptions,
            previewSourcePath,
            options.documentRevision.value,
            options.documentPriorByPage.get(pageNumber) ?? null,
            options.documentCanvasSignature.value,
            matchedCanvasOverridesSignature.value,
            resolveOutputModeRecommendation(pageNumber) ?? null,
            resolveSoftAlphaForegroundRecommendation(pageNumber) ?? null,
            unresolvedPageLayout,
            options.pagePlanEvidenceByPage.get(pageNumber) ?? null,
            options.layoutDetectionComplete.value,
            placementAnchorsFor(pageNumber) ?? null,
        ) + `${SCAN_CLEANUP_PREVIEW_CACHE_KEY_SEPARATOR}lifecycle:${String(lifecycleGeneration.value)}`;
    }

    function placementAnchorsFor(pageNumber: number) {
        const anchors = options.placementAnchorsByPage.value.get(pageNumber);
        if (anchors !== undefined && Object.keys(anchors).length > 0) {
            return anchors;
        }
        const summary = options.placementAnchorSummary?.value ?? null;
        if (summary === null || !options.settings.matchPageSize) {
            return undefined;
        }
        const pageOverride = getScanCleanupPageOverride(
            options.settings.pageOverrides,
            requirePageNumber(pageNumber),
        );
        const summaryAnchors = summary.samples
            .filter(sample => sample.pageNumber === pageNumber && resolveScanCleanupOutputPlacement(
                options.settings.pageAlignment,
                pageOverride,
                sample.half,
            ) === 'ink')
            .reduce<Partial<Record<TScanCleanupOutputHalf, IScanCleanupPlacementAnchor>>>((resolved, sample) => {
                resolved[sample.half] = sample.anchor;
                return resolved;
            }, {});
        return Object.keys(summaryAnchors).length === 0 ? undefined : summaryAnchors;
    }

    function presentationKey(key: string) {
        const separator = key.indexOf(SCAN_CLEANUP_PREVIEW_CACHE_KEY_SEPARATOR);
        const identity = separator < 0 ? key : key.slice(0, separator);
        return `${identity}${SCAN_CLEANUP_PREVIEW_CACHE_KEY_SEPARATOR}`
            + `lifecycle:${String(lifecycleGeneration.value)}`
            + `${SCAN_CLEANUP_PREVIEW_CACHE_KEY_SEPARATOR}user:${String(userPresentationGeneration)}`;
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
    const matchedCanvasOverridesSignature = computed(
        () => scanCleanupMatchedCanvasOverridesSignature(
            options.settings.pageOverrides,
            options.settings.pageOverrideDefaults,
        ),
    );

    function resolveOutputModeRecommendation(pageNumber: number) {
        const pageOverride = getScanCleanupPageOverride(
            options.settings.pageOverrides,
            requirePageNumber(pageNumber),
        );
        if (
            options.settings.preserveOriginalQuality
            || options.settings.outputMode !== 'auto'
            || pageOverride.outputModeOverride !== undefined
        ) {
            return undefined;
        }
        return resolveScanCleanupEffectiveOutputMode({
            options: options.settings,
            pageOverride,
            detectedOutputMode: options.recommendedOutputModeByPage.get(pageNumber),
        });
    }

    function resolveSoftAlphaForegroundRecommendation(pageNumber: number) {
        return resolveOutputModeRecommendation(pageNumber) === 'mixed'
            ? options.softAlphaForegroundRecommendationByPage.get(pageNumber)
            : undefined;
    }

    function nextRequestId() {
        // The request ID only correlates streamed/raw responses. Keep it opaque
        // and fixed-size instead of embedding the potentially large cache key.
        return createRequestId('scan-cleanup-preview');
    }

    function cachePreview(key: string, previewResult: IScanCleanupPreviewResult) {
        if (!key.endsWith(
            `${SCAN_CLEANUP_PREVIEW_CACHE_KEY_SEPARATOR}lifecycle:${String(lifecycleGeneration.value)}`,
        )) {
            return;
        }
        cache.set(key, previewResult);
    }

    function clearTimer() {
        if (timer !== null) clearTimeout(timer);
        timer = null;
    }

    function clearDetailRetry() {
        if (detailRetryTimer !== null) clearTimeout(detailRetryTimer);
        detailRetryTimer = null;
    }

    function invalidateDetailRequest() {
        detailSequence += 1;
        clearDetailRetry();
        detailRetriesRemaining = 0;
        detailLoading.value = false;
        detailDiagnostic.value = null;
    }

    function clearDetail() {
        invalidateDetailRequest();
        detailResult.value = null;
        detailDiagnostic.value = null;
        displayedDetailSourceKey = null;
    }

    function cancel(invalidateRawCache = true) {
        sequence += 1;
        prefetcher.supersede();
        clearTimer();
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
        void capability.cancelPreview({
            sourcePdfPath: options.sourcePath.value,
            ownerId: options.ownerId,
            documentRevision: options.documentRevision.value,
            invalidateRawCache,
        }).catch(() => undefined);
    }

    async function pauseForRun() {
        const previewPending = () => !resultCurrent.value && loading.value;
        // Detection changes the cache identity from provisional to final. If
        // that change landed immediately before Clean Up, let its visible
        // generation finish once before canceling preview work; otherwise the
        // preserve-displayed-result path would freeze the stale frame for the
        // whole run.
        if (
            options.layoutDetectionComplete.value
            && !resultCurrent.value
            && options.active()
            && options.sourcePath.value
            && getScanCleanupCapability()
        ) {
            schedule(true);
            if (previewPending()) {
                await new Promise<void>(resolve => {
                    const stop = watch([
                        resultCurrent,
                        loading,
                    ], ([
                        current,
                        previewLoading,
                    ]) => {
                        if (!current && previewLoading) {
                            return;
                        }
                        stop();
                        resolve();
                    }, {flush: 'sync'});
                });
            }
        }
        cancel(false);
    }

    function scheduleAdjacentPrefetch(
        previewResult: IScanCleanupPreviewResult,
        previewOptions: IScanCleanupOptions,
        previewSourcePath: TDocumentRef,
    ) {
        const adjacentPages = [
            previewResult.pageNumber + 1,
            previewResult.pageNumber - 1,
        ]
            .filter(pageNumber => pageNumber >= 1 && pageNumber <= previewResult.totalPages);
        prefetcher.schedule(adjacentPages.map(pageNumber => {
            const documentPrior = options.documentPriorByPage.get(pageNumber);
            const outputModeRecommendation = resolveOutputModeRecommendation(pageNumber);
            const softAlphaForegroundRecommendation =
                resolveSoftAlphaForegroundRecommendation(pageNumber);
            const pagePlanEvidence = options.pagePlanEvidenceByPage.get(pageNumber);
            const placementAnchors = placementAnchorsFor(pageNumber);
            const key = cacheKey(pageNumber, previewOptions, previewSourcePath);
            return {
                key,
                request: {
                    requestId: nextRequestId(),
                    sourcePdfPath: previewSourcePath,
                    ownerId: options.ownerId,
                    documentRevision: options.documentRevision.value,
                    pageNumber: requirePageNumber(pageNumber),
                    options: previewOptions,
                    ...(documentPrior === undefined ? {} : {documentPrior}),
                    ...(outputModeRecommendation === undefined
                        ? {}
                        : {outputModeRecommendation}),
                    ...(softAlphaForegroundRecommendation === undefined
                        ? {}
                        : {softAlphaForegroundRecommendation}),
                    ...(pagePlanEvidence === undefined ? {} : {pagePlanEvidence}),
                    ...(placementAnchors === undefined ? {} : {placementAnchors}),
                    layoutDetectionComplete: options.layoutDetectionComplete.value,
                    layoutByPage: layoutByPage.value,
                },
            };
        }));
    }

    function schedule(immediate = false) {
        // Base-preview identity owns detail identity. Invalidate detail work
        // before the availability guard so source removal/deactivation cannot
        // leave a retry or an older viewport render alive.
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
        clearTimer();
        const requestPage = options.previewPage.value;
        const requestOptions = resolvedOptions.value;
        const requestSourcePath = options.sourcePath.value;
        const documentPrior = options.documentPriorByPage.get(requestPage);
        const outputModeRecommendation = resolveOutputModeRecommendation(requestPage);
        const softAlphaForegroundRecommendation =
            resolveSoftAlphaForegroundRecommendation(requestPage);
        const pagePlanEvidence = options.pagePlanEvidenceByPage.get(requestPage);
        const placementAnchors = placementAnchorsFor(requestPage);
        const key = cacheKey(requestPage, requestOptions, requestSourcePath);
        const requestId = nextRequestId();
        activeVisibleRequestId = requestId;
        const retainedRaw = retainedRawForPage(requestPage);
        if (retainedRaw) rawResult.value = retainedRaw;
        const initialRequest = scheduledPage === null;
        // A navigation reaches the previous page's key unchanged; anything else
        // — a settings change, a new document prior, another source — makes
        // every page's work stale and keeps no window.
        const navigated = scheduledPage !== null
            && scheduledKey === cacheKey(scheduledPage, requestOptions, requestSourcePath);
        // Turning to another page starts a new attempt at whatever page the
        // user lands on, including the one that gave up earlier.
        if (scheduledPage !== requestPage) {
            cancellationRetryKey = null;
            cancellationRetries = 0;
        }
        scheduledPage = requestPage;
        scheduledKey = key;
        const activeDetailOutputMode = resolveDetailOutputMode(requestPage);
        const activeDetailSourceKey = activeDetailOutputMode === undefined
            ? null
            : detailSourceKey(key, activeDetailOutputMode);
        if (displayedDetailSourceKey !== activeDetailSourceKey) {
            detailResult.value = null;
            displayedDetailSourceKey = null;
        }
        // Look the page up before cancelling anything: a navigation that the
        // cache can answer has no reason to disturb work in flight at all.
        const cached = cache.get(key);
        // Original must never keep painting the raw bytes from the page that
        // was just left while this page has no cached raster of its own.
        if (!cached && viewMode.value === 'original') rawResult.value = null;
        if (!navigated) prefetcher.supersede();
        void capability.cancelPreview({
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
                ? {retainPages: [...new Set([
                    ...[...inFlightPreviewPages.values()].slice(-1),
                    requestPage - 1,
                    requestPage,
                    requestPage + 1,
                ])].filter(pageNumber => pageNumber >= 1 && pageNumber <= totalPages.value)}
                : {}),
        }).catch(() => undefined);
        if (cached) {
            resultKey.value = key;
            resultPresentationKey.value = presentationKey(key);
            result.value = cached;
            rawResult.value = cached;
            loading.value = false;
            error.value = '';
            errorCode.value = null;
            scheduleAdjacentPrefetch(cached, requestOptions, requestSourcePath);
            return;
        }
        loading.value = true;
        error.value = '';
        errorCode.value = null;
        const runPreview = async () => {
            timer = null;
            try {
                // One request per page switch. Its raw raster arrives over
                // `onPreviewRaw` a sidecar run ahead of the cleaned outputs and
                // is displayed there; this promise settles with the cleaned
                // result that supersedes it.
                const previewResult = withStreamedRaw(await capability.preview(toBridgeSafeScanCleanupPayload({
                    requestId,
                    sourcePdfPath: requestSourcePath,
                    ownerId: options.ownerId,
                    documentRevision: options.documentRevision.value,
                    pageNumber: requirePageNumber(requestPage),
                    options: requestOptions,
                    visible: true,
                    ...(documentPrior === undefined ? {} : {documentPrior}),
                    ...(outputModeRecommendation === undefined
                        ? {}
                        : {outputModeRecommendation}),
                    ...(softAlphaForegroundRecommendation === undefined
                        ? {}
                        : {softAlphaForegroundRecommendation}),
                    ...(pagePlanEvidence === undefined ? {} : {pagePlanEvidence}),
                    ...(placementAnchors === undefined ? {} : {placementAnchors}),
                    layoutDetectionComplete: options.layoutDetectionComplete.value,
                    layoutByPage: layoutByPage.value,
                })), requestId);
                // A cancelled request has no result to keep or display. When the
                // page it was rendering is still the page the user is on, the
                // run was retired by something that has since finished — a
                // superseded generation, a prefetch whose lease was dropped —
                // so the page is asked for again instead of being left on a
                // spinner that nothing will ever answer. The budget is per key,
                // so a page that keeps losing its run stops rather than looping.
                if (previewResult === null) {
                    if (requestSequence === sequence) {
                        if (cancellationRetryKey !== key) {
                            cancellationRetryKey = key;
                            cancellationRetries = 0;
                        }
                        if (cancellationRetries < PREVIEW_CANCELLATION_RETRY_LIMIT) {
                            cancellationRetries += 1;
                            timer = setTimeout(schedule, 0);
                            return;
                        }
                        // Out of budget. Saying so puts the page on the same
                        // recoverable footing a failed render has — the error
                        // surface carries a Retry — instead of leaving a blank
                        // frame that nothing will ever fill.
                        error.value = t('scanCleanup.preview.canceledRepeatedly');
                        errorCode.value = 'canceled';
                    }
                    return;
                }
                cancellationRetryKey = null;
                // Cached before the staleness check: the key names the page and
                // the options that produced this result, so a preview that
                // outlived the navigation that asked for it is still exactly
                // what the next visit to that page needs.
                cachePreview(key, previewResult);
                if (requestSequence !== sequence) {
                    return;
                }
                retainPageMetadata(previewResult.pageNumber, previewResult.pageMetadata);
                resultKey.value = key;
                resultPresentationKey.value = presentationKey(key);
                result.value = previewResult;
                scheduleAdjacentPrefetch(previewResult, requestOptions, requestSourcePath);
            } catch (caught) {
                if (requestSequence !== sequence || (caught instanceof Error && caught.name === 'AbortError')) {
                    return;
                }
                const envelope = findSerializableErrorEnvelope(caught, isScanCleanupErrorEnvelope);
                error.value = envelope?.message
                    ?? (caught instanceof Error && !getErrorMessage(caught).includes(SERIALIZABLE_ERROR_PREFIX)
                        ? getErrorMessage(caught)
                        : t('scanCleanup.preview.unavailable'));
                errorCode.value = envelope?.code ?? 'internal';
            } finally {
                if (requestSequence === sequence) loading.value = false;
            }
        };
        // A deliberate page turn goes straight through: nothing is rendering, so
        // waiting would only delay the page. A turn made while a page is still
        // rendering is a burst — every navigation restarts this timer, so a
        // flick issues one request for the page it stops on instead of one per
        // page it passes. Everything else is an options change and keeps the
        // settled debounce it has always had.
        const requestDelayMs = immediate
            ? 0
            : initialRequest
                ? 0
                : navigated
                    ? (inFlightPreviewPages.size === 0 ? 0 : SCAN_CLEANUP_PREVIEW_BURST_DEBOUNCE_MS)
                    : 250;
        timer = setTimeout(() => {
            inFlightPreviewPages.set(requestId, requestPage);
            inFlightPreviewRequestIds.add(requestId);
            void runPreview().finally(() => {
                inFlightPreviewPages.delete(requestId);
                inFlightPreviewRequestIds.delete(requestId);
                trimStreamedRaw();
            });
        }, requestDelayMs);
    }

    function resolveDetailOutputMode(pageNumber = options.previewPage.value) {
        const pageOverride = getScanCleanupPageOverride(
            options.settings.pageOverrides,
            requirePageNumber(pageNumber),
        );
        const renderedOutputMode = result.value?.pageNumber === pageNumber
            ? result.value.outputs[0]?.metadata.outputMode
                ?? result.value.pageMetadata.recommendedOutputMode
            : undefined;
        return resolveScanCleanupEffectiveOutputMode({
            options: options.settings,
            pageOverride,
            detectedOutputMode: options.recommendedOutputModeByPage.get(pageNumber),
            renderedOutputMode,
        });
    }

    function detailSourceKey(baseKey: string, outputMode: ReturnType<typeof resolveDetailOutputMode>) {
        return JSON.stringify({
            baseKey,
            outputMode,
        });
    }

    function scheduleDetailRetry(
        viewports: NonNullable<IScanCleanupPreviewRequest['detail']>['viewports'],
        requestSequence: number,
    ) {
        if (requestSequence !== detailSequence || detailRetriesRemaining <= 0) {
            return;
        }
        detailRetriesRemaining -= 1;
        detailRetryTimer = setTimeout(() => {
            detailRetryTimer = null;
            void requestDetail(viewports, true);
        }, 1_000);
    }

    async function requestDetail(
        viewports: NonNullable<IScanCleanupPreviewRequest['detail']>['viewports'],
        isRetry = false,
    ) {
        if (
            !options.active()
            || !options.sourcePath.value
            || options.settings.preserveOriginalQuality
            || !resultCurrent.value
        ) {
            detailDiagnostic.value = {
                kind: 'not-requested',
                reason: 'ineligible',
            };
            return;
        }
        if (!isRetry) {
            clearDetailRetry();
            detailRetriesRemaining = 2;
            detailDiagnostic.value = null;
        }
        const capability = getScanCleanupCapability();
        if (!capability) {
            detailDiagnostic.value = {
                kind: 'not-requested',
                reason: 'missing-capability',
            };
            return;
        }
        prefetcher.supersede();
        const requestPage = options.previewPage.value;
        const requestOptions = resolvedOptions.value;
        const requestSourcePath = options.sourcePath.value;
        const outputMode = resolveDetailOutputMode(requestPage);
        if (outputMode === undefined) {
            detailLoading.value = false;
            detailDiagnostic.value = {
                kind: 'not-requested',
                reason: 'unsupported-output-mode',
            };
            return;
        }
        const baseKey = cacheKey(requestPage, requestOptions, requestSourcePath);
        const sourceKey = detailSourceKey(baseKey, outputMode);
        const tileKey = createScanCleanupDetailTileCacheKey(sourceKey, viewports);
        const requestSequence = ++detailSequence;
        const cached = detailSourceCache.get(tileKey);
        if (cached) {
            detailResult.value = cached;
            displayedDetailSourceKey = sourceKey;
            detailLoading.value = false;
            return;
        }
        detailResult.value = null;
        displayedDetailSourceKey = null;
        detailLoading.value = true;
        if (!isRetry) detailAttemptCount = 0;
        detailAttemptCount += 1;
        try {
            const documentPrior = options.documentPriorByPage.get(requestPage);
            const softAlphaForegroundRecommendation =
                options.softAlphaForegroundRecommendationByPage.get(requestPage);
            const pagePlanEvidence = options.pagePlanEvidenceByPage.get(requestPage);
            const placementAnchors = placementAnchorsFor(requestPage);
            const requestId = nextRequestId();
            const wireResult = await capability.preview(toBridgeSafeScanCleanupPayload({
                requestId,
                sourcePdfPath: requestSourcePath,
                ownerId: options.ownerId,
                documentRevision: options.documentRevision.value,
                pageNumber: requirePageNumber(requestPage),
                options: requestOptions,
                ...(documentPrior === undefined ? {} : {documentPrior}),
                ...(softAlphaForegroundRecommendation === undefined
                    ? {}
                    : {softAlphaForegroundRecommendation}),
                ...(pagePlanEvidence === undefined ? {} : {pagePlanEvidence}),
                ...(placementAnchors === undefined ? {} : {placementAnchors}),
                layoutDetectionComplete: options.layoutDetectionComplete.value,
                layoutByPage: layoutByPage.value,
                detail: {
                    viewports,
                    outputMode,
                },
            }));
            const next = withStreamedRaw(wireResult, requestId);
            if (requestSequence !== detailSequence || baseKey !== cacheKey()) {
                return;
            }
            // A cancelled tile has no result; the viewport is stationary, so it
            // takes the same bounded retry a failed one does rather than
            // waiting for a gesture that is not coming.
            if (next === null) {
                if (detailRetriesRemaining > 0) {
                    scheduleDetailRetry(viewports, requestSequence);
                } else {
                    detailDiagnostic.value = {
                        kind: 'bridge-null',
                        attempts: detailAttemptCount,
                    };
                }
                return;
            }
            detailSourceCache.set(tileKey, next);
            detailResult.value = next;
            displayedDetailSourceKey = sourceKey;
        } catch (caught) {
            const normalizedMessage = caught instanceof Error
                ? getErrorMessage(caught)
                    .replace(/^Error invoking remote method '[^']+':\s*/u, '')
                    .replace(/^(?:Error:\s*)+/u, '')
                    .trim()
                : '';
            if (detailRetriesRemaining <= 0 && !(caught instanceof Error && caught.name === 'AbortError')) {
                detailDiagnostic.value = {
                    kind: 'service-failure',
                    attempts: detailAttemptCount,
                    message: (normalizedMessage || 'Unknown detail failure').slice(0, 256),
                };
            }
            if (
                normalizedMessage.startsWith('Scan cleanup detail geometry is unavailable')
            ) {
                cache.delete(baseKey);
                schedule();
                return;
            }
            // A failed detail render retries on its own: the viewport is
            // stationary, so no user gesture would otherwise re-request it.
            if (!(caught instanceof Error && caught.name === 'AbortError')) {
                scheduleDetailRetry(viewports, requestSequence);
            }
        } finally {
            if (requestSequence === detailSequence) {
                detailLoading.value = false;
            }
        }
    }

    function retry() {
        // The user asking again is a fresh start: the budget that gave up is
        // theirs to spend again.
        cancellationRetryKey = null;
        cancellationRetries = 0;
        userPresentationGeneration += 1;
        cache.delete(cacheKey(options.previewPage.value));
        schedule();
    }

    function navigate(delta: number) {
        const page = Math.min(totalPages.value, Math.max(1, options.previewPage.value + delta));
        options.selectPage(page, 'single', createScanCleanupNaturalPageOrder(totalPages.value));
    }

    const stopRawStream = getScanCleanupCapability()?.onPreviewRaw(acceptStreamedRaw) ?? null;

    watch(options.active, active => {
        if (active) schedule();
        // An inactive tab still owns its document. Stop only renderer-visible
        // preview work here: detection and a Run waiting on it share the raw
        // raster document in the main process, so invalidating that document
        // would abort the run with “Scan cleanup document was closed”. A real
        // document lifecycle change and unmount still call cancel() below and
        // invalidate the retained document.
        else cancel(false);
    }, {immediate: true});
    watch(options.lifecycleDocumentKey, (key, previousKey) => {
        if (previousKey !== null && isScanCleanupLifecycleIdentityPromotion(
            previousKey,
            key,
            options.sourcePath.value,
            options.sourceSha256?.value ?? null,
            options.documentRevision.value,
        )) {
            // The source path, revision, raster bytes, and native request are
            // unchanged. Promotion only changes detection's restore alias;
            // retaining this session avoids canceling an in-flight preview or
            // discarding the already streamed raster.
            return;
        }
        cancel();
        lifecycleGeneration.value += 1;
        cancellationRetryKey = null;
        cancellationRetries = 0;
        error.value = '';
        errorCode.value = null;
        cache.clear();
        detailSourceCache.clear();
        metadataByPage.clear();
        metadataPageOrder.clear();
        streamedRawByRequest.clear();
        inFlightPreviewPages.clear();
        inFlightPreviewRequestIds.clear();
        activeVisibleRequestId = null;
        result.value = null;
        rawResult.value = null;
        resultKey.value = null;
        resultPresentationKey.value = '';
        detailResult.value = null;
        detailDiagnostic.value = null;
        displayedDetailSourceKey = null;
    });
    watch(cacheKey, () => schedule());
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
        detailLoading,
        detailDiagnostic,
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
