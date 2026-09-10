import type {
    IScanCleanupDocumentPrior,
    IScanCleanupOptions,
    IScanCleanupPagePlanEvidence,
    IScanCleanupPlacementAnchorSummary,
    IScanCleanupSourcePageMetadata,
    TScanCleanupLayoutClassification,
    TScanCleanupErrorCode,
    TScanCleanupDetectionJobState,
} from '@contracts/electronApiScanCleanup';
import type {TDocumentRef} from '@contracts/documentRef';
import {requirePageNumber} from '@contracts/pageNumbers';
import type {
    ComputedRef,
    Ref,
} from 'vue';
import type {TScanCleanupPlacementAnchorsByPage} from '@contracts/scanCleanupPageOverrides';
import {
    attachScanCleanupPageOverrideDefaults,
    getScanCleanupPageOverride,
    resolveScanCleanupOutputPlacement,
    SCAN_CLEANUP_OUTPUT_HALVES,
    toScanCleanupLayoutByPage,
    usesScanCleanupInkAlignment,
} from '@contracts/scanCleanupPageOverrides';
import {
    beginScanCleanupAttempt,
    cancelScanCleanup,
    getScanCleanupRunError,
    getScanCleanupRunErrorCode,
    getScanCleanupRunFailure,
    isScanCleanupRunning,
    reportScanCleanupRunError,
    resolveScanCleanupProcessedPages,
    ScanCleanupRunReconciliationError,
    scanCleanupRun,
    setScanCleanupWorkspaceOwnerOpen,
    setScanCleanupRunError,
    startScanCleanup,
    type TScanCleanupRendererStartResult,
} from '@app/modules/scan-cleanup/runtime/scanCleanupRunCoordinator';
import {formatScanCleanupProgress} from '@app/modules/scan-cleanup/runtime/formatScanCleanupProgress';
import {formatScanCleanupErrorMessage} from '@app/modules/scan-cleanup/runtime/formatScanCleanupErrorMessage';
import {toPlainScanCleanupOptions} from '@app/modules/scan-cleanup/persistence/preferencesRepository';
import {getScanCleanupCapability} from '@app/utils/getScanCleanupCapability';
import {SCAN_CLEANUP_INPUT_MAX_PAGE_ENTRIES} from '@contracts/scan-cleanup/inputLimits';
import {formatFailurePresentationDescription} from '@app/composables/useFailureToast';

const ETA_PAGE_STAGES = new Set([
    'rasterizing',
    'classifying',
    'rendering',
]);
// Large detection jobs hand their complete result store to main through an
// opaque id. Keep legacy object maps only for the explicit small-document
// compatibility path, even if a misconfigured or expired handoff leaves the
// id absent.
const DETECTION_RESULT_ARRAY_COMPATIBILITY_LIMIT = 20_000;
const SCAN_CLEANUP_INK_ANCHOR_CAPACITY_MESSAGE =
    'Ink placement for documents over 20,000 pages is unavailable. Select a bounded page range or choose another alignment.';
const SCAN_CLEANUP_INK_ANCHOR_MISSING_MESSAGE =
    'Ink placement evidence is unavailable for a selected page. Run detection again or choose another alignment.';

interface IUseScanCleanupRunSessionOptions {
    active: () => boolean;
    /**
     * How each page is expected to be cut. The run measures its matched canvas
     * over the pages it produces, so it needs the same layouts the preview the
     * user has been looking at was measured against.
     */
    authoritativeLayoutByPage: ComputedRef<ReadonlyMap<number, TScanCleanupLayoutClassification>>;
    beforeRun: () => Promise<void> | void;
    detectionError: Readonly<Ref<string>>;
    detectionErrorCode: Readonly<Ref<TScanCleanupErrorCode | null>>;
    /** Opaque main-process handle for xlarge detection results. */
    detectionResultStoreId?: Readonly<Ref<string | null>>;
    /** Bounded document-wide calibration for xlarge `ink` placement. */
    placementAnchorSummary?: Readonly<Ref<IScanCleanupPlacementAnchorSummary | null>>;
    detectionPending: ComputedRef<boolean>;
    documentSettingsReady: ComputedRef<boolean>;
    detectionStatus: ComputedRef<Extract<TScanCleanupDetectionJobState['status'], 'completed' | 'failed' | 'canceled'> | null>;
    /**
     * Large detection jobs keep their page records in a file-backed store, so
     * completion cannot be inferred from the renderer's bounded page map.
     */
    detectionEvidenceComplete?: ComputedRef<boolean>;
    documentRevision: ComputedRef<string>;
    documentPriorByPage: ReadonlyMap<number, IScanCleanupDocumentPrior>;
    onCompleted: () => void;
    ownerId: string;
    placementAnchorsByPage: ComputedRef<TScanCleanupPlacementAnchorsByPage>;
    previewTotalPages: () => number;
    resolvedOptions?: ComputedRef<IScanCleanupOptions>;
    resolvePagePlanEvidence: (pageNumbers: readonly number[] | null) => ReadonlyMap<number, IScanCleanupPagePlanEvidence>;
    sourcePageNumbers: ComputedRef<number[] | null>;
    sourcePageMetadataByPage: ComputedRef<ReadonlyMap<number, IScanCleanupSourcePageMetadata>>;
    settings: IScanCleanupOptions;
    recommendedOutputModeByPage: ReadonlyMap<number, 'bw' | 'mixed' | 'grayscale' | 'color'>;
    softAlphaForegroundRecommendationByPage: ReadonlyMap<number, boolean>;
    sourcePath: ComputedRef<TDocumentRef | null>;
    totalPages: ComputedRef<number>;
    waitForDetectionBeforeRun: () => Promise<void>;
}

export const useScanCleanupRunSession = (options: IUseScanCleanupRunSessionOptions) => {
    attachScanCleanupPageOverrideDefaults(
        options.settings.pageOverrides,
        options.settings.pageOverrideDefaults,
        options.settings.marginsMm,
    );
    const {t} = useTypedI18n();

    function formatStartFailure(
        result: Extract<TScanCleanupRendererStartResult, {started: false}>,
    ) {
        if (result.fallback === 'already-running') {
            return t('scanCleanup.errors.alreadyRunning');
        }
        if (result.fallback === 'unavailable' || result.errorCode === 'tools-unavailable') {
            return t('scanCleanup.runDisabled.unavailable');
        }
        return formatScanCleanupErrorMessage(t('scanCleanup.failed'), result.error);
    }

    function formatReconciliationFailure(error: ScanCleanupRunReconciliationError) {
        return formatScanCleanupErrorMessage(
            t(error.failure === 'recovery'
                ? 'scanCleanup.errors.runRecoveryFailed'
                : 'scanCleanup.errors.runSubscriptionFailed'),
            error.technicalDetail,
        );
    }

    const transition = ref<
        'idle' | 'waiting-for-detection' | 'starting-cleanup'
    >('idle');
    // The user asked to stop an attempt that has no job to cancel yet: cleanup
    // is still waiting for detection, or its start is still crossing the
    // bridge. The ask outlives that window, so the attempt either never starts
    // or is canceled the moment it has an id.
    const stopRequested = ref(false);
    const isStopRequested = () => stopRequested.value;
    // A run is under way from the click, not from the job id: everything the
    // click set in motion — waiting for detection and the start request itself
    // — is work the user must be able to stop.
    const isRunning = computed(() => isScanCleanupRunning.value || transition.value !== 'idle');
    let interruptPendingTransition: (() => void) | null = null;
    const cancelRequested = computed(() => (stopRequested.value && isRunning.value)
        || (scanCleanupRun.ownerId === options.ownerId
            && scanCleanupRun.jobState?.status === 'canceling'));
    const error = computed(() => {
        const description = getScanCleanupRunError(
            options.ownerId,
            options.sourcePath.value,
            options.documentRevision.value,
        );
        const failure = getScanCleanupRunFailure(
            options.ownerId,
            options.sourcePath.value,
            options.documentRevision.value,
        );
        return description && failure
            ? formatFailurePresentationDescription({
                failure,
                title: '',
                description,
            })
            : description;
    });
    const errorCode = computed(() => getScanCleanupRunErrorCode(
        options.ownerId,
        options.sourcePath.value,
        options.documentRevision.value,
    ));
    const runPageNumbers = computed(() => options.sourcePageNumbers.value);
    const runPageCount = computed(() => runPageNumbers.value?.length
        ?? Math.max(1, Math.trunc(options.totalPages.value)));
    const hasIncludedPage = computed(() => {
        const selected = runPageNumbers.value;
        if (selected !== null) {
            return selected.some(page => !getScanCleanupPageOverride(
                options.settings.pageOverrides,
                requirePageNumber(page, Math.max(1, options.totalPages.value)),
            ).excluded);
        }
        const totalPages = runPageCount.value;
        const defaultExcluded = options.settings.pageOverrideDefaults?.excluded === true;
        let includedPages = defaultExcluded ? 0 : totalPages;
        for (const [
            key,
            override,
        ] of Object.entries(options.settings.pageOverrides)) {
            const pageNumber = Number(key);
            if (
                Number.isSafeInteger(pageNumber)
                && pageNumber >= 1
                && pageNumber <= totalPages
            ) {
                includedPages += (override.excluded === true ? 0 : 1)
                    - (defaultExcluded ? 0 : 1);
            }
        }
        return includedPages > 0;
    });
    const marginsAreValid = computed(() => Object.values(options.settings.marginsMm).every(margin => (
        Number.isFinite(margin)
        && margin >= 0
        && margin <= 25
    )));
    const inkPlacementCapacityExceeded = computed(() => {
        const resolvedOptions = options.resolvedOptions?.value ?? options.settings;
        // Ink placement is document-wide: the top edge and each snapped
        // position depend on every included page. An xlarge detection keeps
        // only a bounded renderer window, so a small selected batch cannot
        // safely reuse the partial map and pretend its anchors are global.
        return options.totalPages.value > SCAN_CLEANUP_INPUT_MAX_PAGE_ENTRIES
            && usesScanCleanupInkAlignment(resolvedOptions)
            && options.detectionResultStoreId?.value !== null
            && options.detectionResultStoreId?.value !== undefined
            && (options.placementAnchorSummary?.value ?? null) === null;
    });
    const missingInkPlacementAnchorPage = computed(() => {
        const resolvedOptions = options.resolvedOptions?.value ?? options.settings;
        if (
            options.detectionStatus.value !== 'completed'
            || !usesScanCleanupInkAlignment(resolvedOptions)
        ) {
            return null;
        }
        if (options.placementAnchorSummary?.value !== null
            && options.placementAnchorSummary?.value !== undefined) {
            return null;
        }
        const requested = runPageNumbers.value;
        if (requested === null) {
            // Xlarge runs carry their bounded document calibration through the
            // detection state. Small full runs retain every page map, so only
            // selected pages can observe a bounded-map eviction here.
            return null;
        }
        const evidenceByPage = options.resolvePagePlanEvidence(requested);
        for (const pageNumber of requested) {
            const pageOverride = getScanCleanupPageOverride(
                resolvedOptions.pageOverrides,
                requirePageNumber(pageNumber, Math.max(1, options.totalPages.value)),
            );
            if (pageOverride.excluded) {
                continue;
            }
            const evidence = evidenceByPage.get(pageNumber);
            if (evidence === undefined) {
                // A completed large detection keeps the authoritative records
                // in main. The renderer map is intentionally bounded, so an
                // absent selected record must refuse rather than let native
                // choose its top-center fallback.
                if (options.detectionEvidenceComplete?.value === true) {
                    return pageNumber;
                }
                continue;
            }
            const anchors = options.placementAnchorsByPage.value.get(pageNumber);
            for (const half of SCAN_CLEANUP_OUTPUT_HALVES) {
                const contentBox = pageOverride.manualContentBoxes?.[half]
                    ?? evidence.outputs[half]?.contentBox;
                if (
                    resolveScanCleanupOutputPlacement(
                        resolvedOptions.pageAlignment,
                        pageOverride,
                        half,
                    ) === 'ink'
                    && contentBox !== undefined
                    && anchors?.[half] === undefined
                ) {
                    return pageNumber;
                }
            }
        }
        return null;
    });
    const isInkPlacementAnchorMissing = () => missingInkPlacementAnchorPage.value !== null;
    const progress = computed(() => scanCleanupRun.jobState?.progress ?? {
        stage: 'queued' as const,
        completedUnits: 0,
        totalUnits: runPageCount.value,
        percent: 0,
        completedPageNumbers: [],
    });
    const processedPages = computed(() => resolveScanCleanupProcessedPages(
        scanCleanupRun.jobState,
        scanCleanupRun.ownerDocumentRef,
        options.sourcePath.value,
        options.previewTotalPages(),
    ));
    const canRun = computed(() => Boolean(options.sourcePath.value)
        && options.documentSettingsReady.value
        && !isRunning.value
        && hasIncludedPage.value
        && marginsAreValid.value
        && !inkPlacementCapacityExceeded.value
        && missingInkPlacementAnchorPage.value === null
        && getScanCleanupCapability() !== null);
    const transitionText = computed(() => {
        if (transition.value === 'waiting-for-detection') {
            return t('scanCleanup.detectAll.preAnalyzing');
        }
        return transition.value === 'starting-cleanup'
            ? t('scanCleanup.startingCleanup')
            : '';
    });
    // Only ever read on the run affordance, which an engaged run replaces with
    // the cancel affordance, so the transition explains itself in the meter
    // rather than here.
    const runDisabledReason = computed(() => {
        if (!options.sourcePath.value) {
            return t('scanCleanup.runDisabled.noSource');
        }
        if (!options.documentSettingsReady.value) {
            return t('scanCleanup.preview.loading');
        }
        if (!hasIncludedPage.value) {
            return t('scanCleanup.runDisabled.noIncludedPages');
        }
        if (!marginsAreValid.value) {
            return t('scanCleanup.runDisabled.invalidMargins');
        }
        if (inkPlacementCapacityExceeded.value) {
            return SCAN_CLEANUP_INK_ANCHOR_CAPACITY_MESSAGE;
        }
        if (isInkPlacementAnchorMissing()) {
            return SCAN_CLEANUP_INK_ANCHOR_MISSING_MESSAGE;
        }
        if (getScanCleanupCapability() === null) {
            return t('scanCleanup.runDisabled.unavailable');
        }
        return '';
    });
    const progressParts = computed(() => formatScanCleanupProgress(progress.value, t));
    const progressPhaseText = computed(() => progressParts.value.phase);
    const progressCountText = computed(() => progressParts.value.count);
    const progressCountWidestText = computed(() => t('scanCleanup.runCount', {
        completed: progress.value.totalUnits,
        total: progress.value.totalUnits,
    }));
    const progressEtaPendingText = computed(() => t('scanCleanup.etaPending'));
    const pageProgressComplete = computed(() => [
        'classifying',
        'rendering',
    ].includes(progress.value.stage)
        && progress.value.totalUnits > 0
        && progress.value.completedUnits >= progress.value.totalUnits);
    const progressIsFinishing = computed(() => progress.value.percent >= 100
        || pageProgressComplete.value
        || [
            'collecting',
            'assembling',
            'handoff',
        ].includes(progress.value.stage));
    const progressEtaText = computed(() => {
        if (progressIsFinishing.value) {
            return [
                'collecting',
                'assembling',
                'handoff',
            ].includes(progress.value.stage)
                ? t('scanCleanup.almostDone')
                : t('scanCleanup.finishingPhase');
        }
        const etaSeconds = progress.value.etaSeconds;
        if (etaSeconds === undefined || !ETA_PAGE_STAGES.has(progress.value.stage)) {
            return progressEtaPendingText.value;
        }
        return etaSeconds >= 60
            ? t('scanCleanup.etaMinutes', {minutes: Math.max(1, Math.ceil(etaSeconds / 60))})
            : t('scanCleanup.etaSeconds', {seconds: Math.max(1, etaSeconds)});
    });
    const progressEtaWidestText = computed(() => [
        progressEtaPendingText.value,
        t('scanCleanup.etaMinutes', {minutes: 999}),
        t('scanCleanup.etaSeconds', {seconds: 999}),
        t('scanCleanup.finishingPhase'),
        t('scanCleanup.almostDone'),
    ].reduce((widest, candidate) => candidate.length > widest.length ? candidate : widest));
    const progressText = computed(() => `${progressParts.value.text}. ${progressEtaText.value}`);
    const runLabel = computed(() => options.sourcePageNumbers.value === null
        ? t('scanCleanup.cleanUp')
        : options.sourcePageNumbers.value.length === 1
            ? t('scanCleanup.cleanUpPage', {page: options.sourcePageNumbers.value[0] ?? 1})
            : t('scanCleanup.cleanUpPages', {count: options.sourcePageNumbers.value.length}));

    async function run() {
        if (!options.sourcePath.value) {
            return;
        }
        if (inkPlacementCapacityExceeded.value) {
            reportScanCleanupRunError(
                options.ownerId,
                SCAN_CLEANUP_INK_ANCHOR_CAPACITY_MESSAGE,
                options.sourcePath.value,
                'too-large',
                options.documentRevision.value,
            );
            return;
        }
        if (isInkPlacementAnchorMissing()) {
            reportScanCleanupRunError(
                options.ownerId,
                SCAN_CLEANUP_INK_ANCHOR_MISSING_MESSAGE,
                options.sourcePath.value,
                'internal',
                options.documentRevision.value,
            );
            return;
        }
        if (!canRun.value) {
            return;
        }
        // User-authored settings and selection belong to the click that began
        // the run. Detection evidence does not: page verdicts can still arrive
        // while the background job is settling, and snapshotting those maps
        // here silently discarded the newest usable page plans.
        const requestedPageNumbers = runPageNumbers.value;
        const requestSourcePdfPath = options.sourcePath.value;
        const requestDocumentRevision = options.documentRevision.value;
        const requestOptions = options.resolvedOptions?.value
            ?? toPlainScanCleanupOptions(options.settings);
        const requestedSourcePageNumbers = options.sourcePageNumbers.value === null
            ? null
            : [...options.sourcePageNumbers.value];
        const buildRequest = () => {
            // Detection may finish while the run waits for its terminal state.
            // Read the opaque handoff id at request-build time so a large result
            // store takes the descriptor path instead of falling back to maps.
            const detectionResultStoreId = options.detectionResultStoreId?.value ?? null;
            const placementAnchorSummary = options.placementAnchorSummary?.value ?? null;
            const pagePlanEvidence = options.resolvePagePlanEvidence(requestedPageNumbers);
            const legacyDetectionFields = detectionResultStoreId === null
                && runPageCount.value <= DETECTION_RESULT_ARRAY_COMPATIBILITY_LIMIT
                ? {
                    ...(options.recommendedOutputModeByPage.size === 0 ? {} : {outputModeRecommendations: Object.fromEntries(
                        options.recommendedOutputModeByPage,
                    )}),
                    ...(options.softAlphaForegroundRecommendationByPage.size === 0
                        ? {}
                        : {softAlphaForegroundRecommendations: Object.fromEntries(
                            options.softAlphaForegroundRecommendationByPage,
                        )}),
                    layoutByPage: toScanCleanupLayoutByPage(options.authoritativeLayoutByPage.value),
                    ...(options.sourcePageMetadataByPage.value.size === 0
                        ? {}
                        : {sourcePageMetadataByPage: Object.fromEntries(options.sourcePageMetadataByPage.value)}),
                    ...(options.documentPriorByPage.size === 0
                        ? {}
                        : {documentPriorByPage: Object.fromEntries(options.documentPriorByPage)}),
                    ...(pagePlanEvidence.size === 0
                        ? {}
                        : {pagePlanEvidenceByPage: Object.fromEntries(pagePlanEvidence)}),
                }
                : {};
            // Clustered over the whole document, then narrowed to the pages
            // this run produces: a partial run has to place its pages where a
            // full run would have. For xlarge ink runs the bounded summary is
            // authoritative, so do not duplicate it with the renderer's
            // retained-page anchor window in the IPC request. The conversion
            // resolves each batch from the summary instead.
            const placementAnchors: Array<readonly [string, NonNullable<
                ReturnType<typeof options.placementAnchorsByPage.value.get>
            >]> = [];
            const usesBoundedPlacementAnchorSummary = placementAnchorSummary !== null
                && detectionResultStoreId !== null;
            if (!usesBoundedPlacementAnchorSummary) {
                if (requestedPageNumbers === null) {
                    for (const [
                        pageNumber,
                        anchors,
                    ] of options.placementAnchorsByPage.value) {
                        if (Object.keys(anchors).length > 0) {
                            placementAnchors.push([
                                String(pageNumber),
                                anchors,
                            ]);
                        }
                    }
                } else {
                    for (const pageNumber of requestedPageNumbers) {
                        const anchors = options.placementAnchorsByPage.value.get(pageNumber);
                        if (anchors !== undefined && Object.keys(anchors).length > 0) {
                            placementAnchors.push([
                                String(pageNumber),
                                anchors,
                            ]);
                        }
                    }
                }
            }
            return {
                sourcePdfPath: requestSourcePdfPath,
                ownerId: options.ownerId,
                documentRevision: requestDocumentRevision,
                options: requestOptions,
                ...(requestedSourcePageNumbers === null
                    ? {}
                    : {sourcePageNumbers: requestedSourcePageNumbers}),
                ...(detectionResultStoreId === null
                    ? {}
                    : {detectionResultStoreId}),
                ...(placementAnchorSummary === null
                    ? {}
                    : {placementAnchorSummary}),
                ...legacyDetectionFields,
                ...(placementAnchors.length === 0
                    ? {}
                    : {placementAnchorsByPage: Object.fromEntries(placementAnchors)}),
            };
        };
        stopRequested.value = false;
        const stopWait = new Promise<void>(resolve => {
            interruptPendingTransition = resolve;
        });
        beginScanCleanupAttempt();
        try {
            // The detection pass is a uniform run input. A click made while it
            // is still running becomes one visible, cancelable cleanup attempt
            // and proceeds only after that pass reaches a terminal state.
            if (options.detectionPending.value || options.detectionStatus.value === null) {
                transition.value = 'waiting-for-detection';
                await Promise.race([
                    options.waitForDetectionBeforeRun(),
                    stopWait,
                ]);
                if (isStopRequested()) {
                    return;
                }
            }
            if (isStopRequested()) {
                return;
            }
            if (
                requestSourcePdfPath !== options.sourcePath.value
                || requestDocumentRevision !== options.documentRevision.value
            ) {
                reportScanCleanupRunError(
                    options.ownerId,
                    t('scanCleanup.documentChangedBeforeRun'),
                    requestSourcePdfPath,
                    'internal',
                    requestDocumentRevision,
                );
                return;
            }
            const detectionStatus = options.detectionStatus.value;
            if (detectionStatus !== 'completed') {
                const errorCode = detectionStatus === 'failed'
                    ? options.detectionErrorCode.value ?? 'internal'
                    : detectionStatus === 'canceled'
                        ? 'canceled'
                        : options.detectionErrorCode.value ?? 'internal';
                reportScanCleanupRunError(
                    options.ownerId,
                    (detectionStatus === 'failed' || detectionStatus === null) && options.detectionError.value
                        ? options.detectionError.value
                        : t('scanCleanup.detectAll.evidenceMissing'),
                    requestSourcePdfPath,
                    errorCode,
                    requestDocumentRevision,
                );
                return;
            }
            const detectionResultStoreId = options.detectionResultStoreId?.value ?? null;
            const hasAuthoritativeDetectionStore = detectionResultStoreId !== null;
            if (
                requestedPageNumbers === null
                && runPageCount.value > DETECTION_RESULT_ARRAY_COMPATIBILITY_LIMIT
                && detectionResultStoreId === null
            ) {
                // A completed xlarge detection has no renderer-sized result
                // map to fall back to. If its opaque handoff expired or was
                // never published, refuse the run rather than sending a
                // detection-free request to the worker.
                reportScanCleanupRunError(
                    options.ownerId,
                    t('scanCleanup.detectAll.evidenceMissing'),
                    requestSourcePdfPath,
                    'internal',
                    requestDocumentRevision,
                );
                return;
            }
            const pagePlanEvidence = options.resolvePagePlanEvidence(requestedPageNumbers);
            if (isInkPlacementAnchorMissing()) {
                reportScanCleanupRunError(
                    options.ownerId,
                    SCAN_CLEANUP_INK_ANCHOR_MISSING_MESSAGE,
                    requestSourcePdfPath,
                    'internal',
                    requestDocumentRevision,
                );
                return;
            }
            const detectionEvidenceComplete = options.detectionEvidenceComplete?.value;
            const pagePlanEvidenceMissing = hasAuthoritativeDetectionStore
                ? false
                : requestedPageNumbers === null
                    ? detectionEvidenceComplete === undefined
                        ? pagePlanEvidence.size < runPageCount.value
                        : !detectionEvidenceComplete
                    : requestedPageNumbers.some(pageNumber => !pagePlanEvidence.has(pageNumber));
            if (pagePlanEvidenceMissing) {
                reportScanCleanupRunError(
                    options.ownerId,
                    t('scanCleanup.detectAll.evidenceMissing'),
                    requestSourcePdfPath,
                    'internal',
                    requestDocumentRevision,
                );
                return;
            }
            let missingAutomaticModeDecisions = false as boolean;
            const checkAutomaticModeDecision = (pageNumber: number) => {
                const pageOverride = getScanCleanupPageOverride(
                    requestOptions.pageOverrides,
                    requirePageNumber(pageNumber, Math.max(1, options.totalPages.value)),
                );
                if (
                    !pageOverride.excluded
                    && (pageOverride.outputModeOverride ?? requestOptions.outputMode) === 'auto'
                    && !options.recommendedOutputModeByPage.has(pageNumber)
                ) {
                    missingAutomaticModeDecisions = true;
                }
            };
            if (hasAuthoritativeDetectionStore) {
                missingAutomaticModeDecisions = false;
            } else if (requestedPageNumbers === null) {
                // The completed detection result store is authoritative for a
                // full-document run. Walking 1..N here would recreate the
                // million-page allocation this session deliberately avoids.
                // Small compatibility callers without that scalar still use
                // their complete page map as the proof of coverage.
                const recommendationsComplete = options.detectionEvidenceComplete?.value
                    ?? options.recommendedOutputModeByPage.size >= runPageCount.value;
                missingAutomaticModeDecisions = !recommendationsComplete;
            } else {
                for (const pageNumber of requestedPageNumbers) {
                    checkAutomaticModeDecision(pageNumber);
                    if (missingAutomaticModeDecisions) break;
                }
            }
            if (missingAutomaticModeDecisions) {
                reportScanCleanupRunError(
                    options.ownerId,
                    options.detectionError.value || t('scanCleanup.detectAll.evidenceMissing'),
                    requestSourcePdfPath,
                    options.detectionErrorCode.value ?? 'internal',
                    requestDocumentRevision,
                );
                return;
            }
            transition.value = 'starting-cleanup';
            await nextTick();
            await options.beforeRun();
            setScanCleanupRunError(options.ownerId, '');
            if (isStopRequested()) {
                return;
            }
            const request = buildRequest();
            const result = await startScanCleanup(request);
            if (isStopRequested()) {
                // The stop arrived while the start was in flight. The job it
                // came back with is the one the user already asked to stop.
                if (result.started) await cancelScanCleanup();
                return;
            }
            if (!result.started) {
                reportScanCleanupRunError(
                    options.ownerId,
                    formatStartFailure(result),
                    requestSourcePdfPath,
                    result.errorCode,
                    requestDocumentRevision,
                );
            }
        } catch (caught) {
            reportScanCleanupRunError(
                options.ownerId,
                caught instanceof ScanCleanupRunReconciliationError
                    ? formatReconciliationFailure(caught)
                    : formatScanCleanupErrorMessage(t('scanCleanup.failed'), caught),
                requestSourcePdfPath,
                caught instanceof ScanCleanupRunReconciliationError
                    ? caught.errorCode
                    : 'internal',
                requestDocumentRevision,
            );
        } finally {
            interruptPendingTransition = null;
            transition.value = 'idle';
        }
    }

    async function cancel() {
        if (cancelRequested.value || !isRunning.value) {
            return;
        }
        if (!scanCleanupRun.activeJobId) {
            stopRequested.value = true;
            interruptPendingTransition?.();
            return;
        }
        await cancelScanCleanup();
    }

    function dismissError() {
        if (error.value) {
            setScanCleanupRunError(options.ownerId, '');
        }
    }

    watch(options.active, active => setScanCleanupWorkspaceOwnerOpen(options.ownerId, active), {immediate: true});
    watch(isScanCleanupRunning, running => {
        if (!running && scanCleanupRun.jobState?.status === 'completed') options.onCompleted();
    });
    onBeforeUnmount(() => setScanCleanupWorkspaceOwnerOpen(options.ownerId, false));

    return {
        cancel,
        cancelRequested,
        canRun,
        dismissError,
        error,
        errorCode,
        isRunning,
        processedPages,
        progress,
        progressCountText,
        progressCountWidestText,
        progressEtaText,
        progressEtaWidestText,
        progressPhaseText,
        progressText,
        runLabel,
        runDisabledReason,
        run,
        transitionText,
        waitingForDetection: computed(() => transition.value === 'waiting-for-detection'),
    };
};
