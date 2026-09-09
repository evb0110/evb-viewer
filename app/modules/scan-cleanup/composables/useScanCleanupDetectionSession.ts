import type {
    IScanCleanupDetectionResult,
    IScanCleanupSourcePageMetadata,
    IScanCleanupOptions,
    IScanCleanupPagePlanEvidence,
    IScanCleanupPageOverride,
    IScanCleanupPlacementAnchorSummary,
    IScanCleanupPreviewResult,
    TScanCleanupErrorCode,
    TScanCleanupDetectionJobState,
} from '@contracts/electronApiScanCleanup';
import {
    attachScanCleanupPageOverrideDefaults,
    estimateScanCleanupOutputPages,
    getScanCleanupPageOverride,
    getScanCleanupPageOverrideDefaults,
    resolveScanCleanupPageLayout,
    shouldShowScanCleanupOutputEstimate,
} from '@contracts/scanCleanupPageOverrides';
import {isScanCleanupSourceSha256} from '@contracts/scanCleanupSettings';
import type {TDocumentRef} from '@contracts/documentRef';
import { createEpochMs } from '@contracts/timestamps';
import { createDisposalFlag } from '@app/utils/createDisposalFlag';
import type { TJobId } from '@contracts/shared';
import {requirePageNumber} from '@contracts/pageNumbers';
import type {ComputedRef} from 'vue';
import {applyScanCleanupDetectionResults} from '@app/modules/scan-cleanup/runtime/applyScanCleanupDetectionResults';
import {formatScanCleanupPreAnalysisProgress} from '@app/modules/scan-cleanup/runtime/formatScanCleanupProgress';
import {
    scanCleanupAutoDetectionCanceledDocuments as autoDetectionCanceledDocuments,
    scanCleanupDetectionSessionCache as detectionSessionCache,
    discardScanCleanupDetectionStateForAliases,
    isScanCleanupLifecycleIdentityPromotion,
    promoteScanCleanupDetectionState,
    retireSupersededScanCleanupDetectionState,
    type IScanCleanupDetectionSessionCacheEntry as IDetectionSessionCacheEntry,
} from '@app/modules/scan-cleanup/runtime/scanCleanupDetectionSessionCache';
import {toPlainScanCleanupOptions} from '@app/modules/scan-cleanup/persistence/preferencesRepository';
import {getScanCleanupCapability} from '@app/utils/getScanCleanupCapability';
import {toBridgeSafeScanCleanupPayload} from '@app/modules/scan-cleanup/runtime/toBridgeSafeScanCleanupPayload';
import {useScanCleanupPageEta} from '@app/modules/scan-cleanup/composables/useScanCleanupPageEta';
import {formatScanCleanupErrorMessage} from '@app/modules/scan-cleanup/runtime/formatScanCleanupErrorMessage';
import {formatScanCleanupScratchMessage} from '@app/modules/scan-cleanup/runtime/formatScanCleanupScratchMessage';
import {SCAN_CLEANUP_STREAMING_BATCH_PAGES} from '@contracts/scan-cleanup/inputLimits';

type TScanCleanupLayoutClassification = IScanCleanupPreviewResult['pageMetadata']['layoutClassification'];

const DETECTION_CANCELLATION_TIMEOUT_MS = 10_000;
const DETECTION_SUBSCRIPTION_RECONCILIATION_ATTEMPTS = 3;
// Native emits full result arrays only below this document-size boundary.
// Larger jobs stream one bounded batch at a time, so the renderer keeps only
// the recent pages needed for an active preview and explicit edits.
const DETECTION_RESULT_ARRAY_COMPATIBILITY_LIMIT = SCAN_CLEANUP_STREAMING_BATCH_PAGES;
const DETECTION_PAGE_CACHE_LIMIT = 256;

interface IUseScanCleanupDetectionSessionOptions {
    active: () => boolean;
    documentRevision: ComputedRef<string>;
    isRunning: ComputedRef<boolean>;
    lifecycleDocumentKey: ComputedRef<string | null>;
    ownerId: string;
    settings: IScanCleanupOptions;
    sourceSha256: ComputedRef<string | null>;
    sourcePath: ComputedRef<TDocumentRef | null>;
    totalPages: ComputedRef<number>;
}

function resolveManualLayoutClassification(
    options: Pick<IScanCleanupOptions, 'layoutMode'>,
    pageOverride: IScanCleanupPageOverride,
): TScanCleanupLayoutClassification | undefined {
    const layout = resolveScanCleanupPageLayout(options.layoutMode, pageOverride.layoutOverride);
    if (layout === 'force-two-page') {
        return 'two-page-spread';
    }
    if (layout === 'force-single') {
        return 'single-uncut-page';
    }
    if (layout === 'keep-left' || layout === 'keep-right') {
        return 'page-with-offcut';
    }
    return pageOverride.manualSplit === null ? undefined : 'two-page-spread';
}

function detectionPhaseRank(stage: TScanCleanupDetectionJobState['progress']['stage']) {
    if (stage === 'queued') {
        return 0;
    }
    if (stage === 'rasterizing') {
        return 1;
    }
    return 2;
}

function detectionIsTerminal(state: TScanCleanupDetectionJobState | null) {
    return state !== null && [
        'completed',
        'failed',
        'canceled',
    ].includes(state.status);
}

function yieldToDetectionReconciliation() {
    return new Promise<void>(resolve => setTimeout(resolve, 0));
}

export const useScanCleanupDetectionSession = (options: IUseScanCleanupDetectionSessionOptions) => {
    attachScanCleanupPageOverrideDefaults(
        options.settings.pageOverrides,
        options.settings.pageOverrideDefaults,
        options.settings.marginsMm,
    );
    const {t} = useTypedI18n();
    const starting = ref(false);
    const autoPending = ref(false);
    const jobState = shallowRef<TScanCleanupDetectionJobState | null>(null);
    const hasDetectionJob = () => jobState.value !== null;
    const documentCanvasSignature = shallowRef('');
    const error = ref('');
    const errorCode = ref<TScanCleanupErrorCode | null>(null);
    const signatures = new Map<number, string>();
    const detectedLayoutByPage = reactive(new Map<number, TScanCleanupLayoutClassification>());
    const confidenceByPage = reactive(new Map<number, number>());
    const documentPriorByPage = reactive(new Map<number, NonNullable<IScanCleanupDetectionResult['documentPrior']>>());
    const textAxisByPage = reactive(new Map<number, NonNullable<IScanCleanupDetectionResult['textAxis']>>());
    const recommendedOutputModeByPage = reactive(
        new Map<number, NonNullable<IScanCleanupDetectionResult['recommendedOutputMode']>>(),
    );
    const pagePlanEvidenceByPage = reactive(new Map<number, IScanCleanupPagePlanEvidence>());
    // Pages the running job has finished a stage for, accumulated across the
    // job: the rasterizing stage reports read pages and the detecting stage
    // reports analyzed ones, and neither set is a superset of the other. A page
    // leaves its loading state as soon as its own work lands, instead of
    // waiting for the whole batch.
    const settledPages = reactive(new Set<number>());
    const recommendedOutputModeConfidenceByPage = reactive(new Map<number, number>());
    const recommendedOutputModeReasonByPage = reactive(
        new Map<number, NonNullable<IScanCleanupDetectionResult['recommendedOutputModeReason']>>(),
    );
    const softAlphaForegroundRecommendationByPage = reactive(new Map<number, boolean>());
    const sourcePageMetadataByPage = reactive(new Map<number, IScanCleanupSourcePageMetadata>());
    const retainedDetectionPages = new Set<number>();
    const detectionResultCount = ref(0);
    // Native detection knows the document size before the PDF viewer may have
    // published its own metadata. Keep that count with the detection evidence
    // so completion checks do not treat an uninitialized viewer count as zero.
    const detectionDocumentPageCount = ref(0);
    const detectionEvidenceComplete = ref(false);
    const detectionResultStoreId = shallowRef<string | null>(null);
    const placementAnchorSummary = shallowRef<IScanCleanupPlacementAnchorSummary | null>(null);
    let jobId: TJobId | null = null;
    let jobDocumentKey: string | null = null;
    let jobDocumentRevision: string | null = null;
    // Bumped whenever the document lifecycle replaces the session. A pending
    // detect-all continuation from before the bump must never cache results,
    // subscribe, or mutate session maps for the replacement document.
    let requestGeneration = 0;
    let stopSubscription: (() => void) | null = null;
    const lifecycle = createDisposalFlag();
    let scheduledAutoDetection: ReturnType<typeof setTimeout> | null = null;
    let detectionRetirementTail = Promise.resolve();
    const terminalWaiters = new Map<TJobId, Set<() => void>>();
    // The native detection cache owns both aliases while a source hash is
    // being published. Keep only the current document's aliases so closing a
    // workspace cannot erase an unrelated document's restore entry.
    const documentAliases = new Set<string>();
    let rememberedSourcePath = options.sourcePath.value;

    function rememberDocumentAliases(lifecycleKey: string | null | undefined) {
        if (lifecycleKey) documentAliases.add(lifecycleKey);
        if (options.sourcePath.value) documentAliases.add(options.sourcePath.value);
    }

    function enqueueDetectionRetirement(detectionJobId: TJobId, documentRevision: string) {
        const capability = getScanCleanupCapability();
        detectionRetirementTail = detectionRetirementTail.then(async () => {
            if (!capability) {
                return;
            }
            await new Promise<void>(resolve => {
                let settled = false;
                let timeout: ReturnType<typeof setTimeout> | null = null;
                const finish = () => {
                    if (settled) {
                        return;
                    }
                    settled = true;
                    if (timeout !== null) clearTimeout(timeout);
                    const waiters = terminalWaiters.get(detectionJobId);
                    waiters?.delete(finish);
                    if (waiters?.size === 0) terminalWaiters.delete(detectionJobId);
                    resolve();
                };
                const waiters = terminalWaiters.get(detectionJobId) ?? new Set<() => void>();
                waiters.add(finish);
                terminalWaiters.set(detectionJobId, waiters);
                timeout = setTimeout(finish, DETECTION_CANCELLATION_TIMEOUT_MS);
                void capability.cancelDetection(detectionJobId, {
                    ownerId: options.ownerId,
                    documentRevision,
                }).then(async () => {
                    // IPC acknowledges the transition to `canceling`, not the
                    // terminal cancellation. Reusing the stable broker owner
                    // before that terminal event can rejoin the retiring job.
                    const state = await capability.getDetectionJobState(detectionJobId, {
                        ownerId: options.ownerId,
                        documentRevision,
                    }).catch(() => null);
                    if (!state || detectionIsTerminal(state)) finish();
                }).catch(finish);
            });
        });
        return detectionRetirementTail;
    }

    async function waitForDetectionRetirements() {
        // A second lifecycle transition can enqueue while the first cancel is
        // crossing IPC. Follow the moving tail until the exact serialized
        // queue observed after the last await has drained.
        let awaitedTail: Promise<void>;
        do {
            awaitedTail = detectionRetirementTail;
            await awaitedTail;
        } while (awaitedTail !== detectionRetirementTail);
    }

    function clearOutputModeRecommendations() {
        recommendedOutputModeByPage.clear();
        recommendedOutputModeConfidenceByPage.clear();
        recommendedOutputModeReasonByPage.clear();
        softAlphaForegroundRecommendationByPage.clear();
    }

    const manualLayoutOverrideByPage = computed<ReadonlyMap<number, TScanCleanupLayoutClassification>>(() => {
        const layouts = new Map<number, TScanCleanupLayoutClassification>();
        for (const pageKey of Object.keys(options.settings.pageOverrides)) {
            const pageNumber = Number(pageKey);
            if (!Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > options.totalPages.value) {
                continue;
            }
            const classification = resolveManualLayoutClassification(
                options.settings,
                getScanCleanupPageOverride(
                    options.settings.pageOverrides,
                    requirePageNumber(pageNumber, options.totalPages.value),
                ),
            );
            if (classification !== undefined) layouts.set(pageNumber, classification);
        }
        return layouts;
    });
    const authoritativeLayoutByPage = computed<ReadonlyMap<number, TScanCleanupLayoutClassification>>(() => {
        const layouts = new Map(detectedLayoutByPage);
        for (const [
            pageNumber,
            classification,
        ] of manualLayoutOverrideByPage.value) {
            layouts.set(pageNumber, classification);
        }
        return layouts;
    });
    const isDetecting = computed(() => jobState.value?.status === 'queued'
        || jobState.value?.status === 'running'
        || jobState.value?.status === 'canceling');
    function jobBelongsToCurrentDocument() {
        return jobDocumentKey === options.lifecycleDocumentKey.value
            && jobDocumentRevision === options.documentRevision.value;
    }
    const terminalStatus = computed<'completed' | 'failed' | 'canceled' | null>(() => {
        const status = jobState.value?.status;
        if (
            !jobBelongsToCurrentDocument()
            || (status === 'completed' && !evidenceIsCurrent())
        ) {
            return null;
        }
        return status === 'completed' || status === 'failed' || status === 'canceled'
            ? status
            : null;
    });
    const layoutDetectionComplete = computed(() => terminalStatus.value === 'completed');
    const cancelRequested = computed(() => jobState.value?.status === 'canceling');
    // `autoPending` owns the outer async startup/subscription call and can
    // remain true for a turn after a terminal event has already supplied the
    // final document plan. Terminal detection is authoritative for the UI:
    // cleanup starting in that turn must not keep the provisional caption or
    // page frames alive.
    const pending = computed(() => starting.value
        || isDetecting.value
        || (autoPending.value && terminalStatus.value === null));
    const canStart = computed(() => Boolean(options.sourcePath.value)
        && !options.isRunning.value
        && !isDetecting.value
        && !starting.value
        && getScanCleanupCapability() !== null);
    const canDetectAll = computed(() => canStart.value && !autoPending.value);
    const progress = computed(() => jobState.value?.progress ?? {
        stage: 'detecting' as const,
        completedUnits: 0,
        totalUnits: Math.max(1, options.totalPages.value),
        percent: 0,
        completedPageNumbers: [],
    });
    // Raster production and native analysis overlap, but that handoff is an
    // implementation detail. Count only actual page verdicts so the one
    // user-facing pre-analysis counter never changes meaning or moves backward.
    const preAnalysisProgress = computed(() => ({
        completedUnits: Math.min(options.totalPages.value, detectionResultCount.value),
        totalUnits: Math.max(1, options.totalPages.value),
    }));
    const preAnalysisParts = computed(() => formatScanCleanupPreAnalysisProgress(preAnalysisProgress.value, t));
    const progressText = computed(() => preAnalysisParts.value.text);
    const progressPhaseText = computed(() => preAnalysisParts.value.phase);
    const progressCountText = computed(() => preAnalysisParts.value.count);
    const progressPercent = computed(() => preAnalysisProgress.value.totalUnits === 0
        ? 0
        : preAnalysisProgress.value.completedUnits / preAnalysisProgress.value.totalUnits * 100);
    const {
        progressEtaText,
        progressEtaWidestText,
    } = useScanCleanupPageEta(computed(() => {
        const state = jobState.value;
        if (state === null || detectionIsTerminal(state)) {
            return null;
        }
        return {
            completedAtMs: state.updatedAtMs > 0 ? state.updatedAtMs : createEpochMs(),
            completedUnits: preAnalysisProgress.value.completedUnits,
            phaseKey: 'analysis',
            runKey: state.jobId,
            totalUnits: preAnalysisProgress.value.totalUnits,
        };
    }), computed(() => t('scanCleanup.detectAll.reconciling')));
    // The same sentence at its widest counter, so the status line can reserve
    // its box and the cancel button beside it never moves as the count grows.
    const preAnalysisWidestParts = computed(() => formatScanCleanupPreAnalysisProgress({
        ...preAnalysisProgress.value,
        completedUnits: preAnalysisProgress.value.totalUnits,
    }, t));
    const progressWidestText = computed(() => preAnalysisWidestParts.value.text);
    const progressCountWidestText = computed(() => preAnalysisWidestParts.value.count);
    const blankPageCount = computed(() => jobState.value?.status === 'completed'
        ? jobState.value.results.filter(result => result.recommendedOutputModeReason === 'blank').length
        : 0);
    const outputEstimate = computed(() => {
        const estimate = estimateScanCleanupOutputPages(
            options.totalPages.value,
            options.settings,
            authoritativeLayoutByPage.value,
        );
        if (!shouldShowScanCleanupOutputEstimate(
            options.totalPages.value,
            options.settings,
            authoritativeLayoutByPage.value,
        )) {
            return '';
        }
        return t(estimate.exact ? 'scanCleanup.estimateExact' : 'scanCleanup.estimateAbout', {
            input: options.totalPages.value,
            output: estimate.outputPages,
        });
    });

    // Page evidence signatures contain document-wide inputs plus the override
    // inputs that change what one page's detection computes. The configured
    // output mode is deliberately absent — the recommendation is a page
    // diagnostic and survives mode changes while the evidence is unchanged. So
    // is matchPageSize: the canvas is measured from the document's own page
    // geometry, so toggling it no longer changes anything detection reports and
    // must not throw a whole document's evidence away. So is excluded: it only
    // decides whether the analyzed page reaches the output, so toggling it must
    // not drop the page back to a pending spinner. Manual content boxes are
    // render overrides over the retained automatic page-plan evidence; editing
    // one must redraw that page, not restart document reconciliation.
    const documentSignature = computed(() => {
        const lossless = options.settings.preserveOriginalQuality === true;
        return JSON.stringify({
            layoutMode: options.settings.layoutMode,
            preserveOriginalQuality: lossless,
            crop: options.settings.crop,
            marginsMm: options.settings.marginsMm,
            normalizeIllumination: !lossless && (options.settings.normalizeIllumination ?? true),
            autoDewarp: !lossless && (options.settings.autoDewarp ?? false),
            autoDewarpDepth: options.settings.autoDewarpDepth,
            pageOverrideDefaults: options.settings.pageOverrideDefaults,
        });
    });
    function pageOverrideSignature(pageNumber: number) {
        const pageOverride = pageNumber === 0
            ? getScanCleanupPageOverrideDefaults(options.settings.pageOverrides)
            : getScanCleanupPageOverride(
                options.settings.pageOverrides,
                requirePageNumber(pageNumber),
            );
        return JSON.stringify({
            layoutOverride: pageOverride.layoutOverride,
            rotationDegrees: pageOverride.rotationDegrees,
            manualSplit: pageOverride.manualSplit,
            manualSkewDegrees: pageOverride.manualSkewDegrees,
            manualZones: pageOverride.manualZones ?? {
                picture: [],
                fill: [],
            },
        });
    }

    // The default page portion is the same for every untouched page. Keep that
    // one value scalar, then store only explicitly edited pages for a running
    // detection request.
    const defaultPageOverrideSignature = computed(() => pageOverrideSignature(0));
    const pageOverrideSignatureToken = computed(() => Object.keys(options.settings.pageOverrides)
        .map(pageKey => {
            const pageSignature = pageOverrideSignature(Number(pageKey));
            return pageSignature === defaultPageOverrideSignature.value
                ? ''
                : `${pageKey}:${pageSignature}`;
        })
        .filter(Boolean)
        .sort()
        .join(','));
    let detectionDocumentSignature = documentSignature.value;
    let detectionPageOverrideSignatureToken = pageOverrideSignatureToken.value;
    const detectionPageOverrideSignatures = new Map<number, string>();

    function captureDetectionSignatures() {
        detectionDocumentSignature = documentSignature.value;
        detectionPageOverrideSignatureToken = pageOverrideSignatureToken.value;
        detectionPageOverrideSignatures.clear();
        for (const pageKey of Object.keys(options.settings.pageOverrides)) {
            const pageNumber = Number(pageKey);
            if (
                Number.isSafeInteger(pageNumber)
                && pageNumber >= 1
                && pageNumber <= options.totalPages.value
            ) {
                const pageSignature = pageOverrideSignature(pageNumber);
                if (pageSignature !== defaultPageOverrideSignature.value) {
                    detectionPageOverrideSignatures.set(pageNumber, pageSignature);
                }
            }
        }
    }

    function readPageOverrideSignatures() {
        const current = new Map<number, string>();
        for (const pageKey of Object.keys(options.settings.pageOverrides)) {
            const pageNumber = Number(pageKey);
            if (
                Number.isSafeInteger(pageNumber)
                && pageNumber >= 1
                && pageNumber <= options.totalPages.value
            ) {
                const pageSignature = pageOverrideSignature(pageNumber);
                if (pageSignature !== defaultPageOverrideSignature.value) {
                    current.set(pageNumber, pageSignature);
                }
            }
        }
        return current;
    }

    let observedDocumentSignature = documentSignature.value;
    let observedPageOverrideSignatures = readPageOverrideSignatures();
    let observedTotalPages = options.totalPages.value;

    function detectionRequestSignature(pageNumber: number) {
        return `${detectionDocumentSignature}:${detectionPageOverrideSignatures.get(pageNumber)
            ?? defaultPageOverrideSignature.value}`;
    }

    function signature(pageNumber: number) {
        return `${documentSignature.value}:${pageOverrideSignature(pageNumber)}`;
    }

    function resolveDetectionDocumentPageCount(fallback = options.totalPages.value) {
        return detectionDocumentPageCount.value > 0
            ? detectionDocumentPageCount.value
            : fallback;
    }

    function evidenceIsCurrent(
        evidenceSignatures: ReadonlyMap<number, string> = signatures,
        documentPageCount = resolveDetectionDocumentPageCount(),
    ) {
        // A terminal detection state records one signature per result page.
        // Page edits remove just that entry, while document-wide edits clear the
        // map. Size therefore proves coverage and the scalar document token
        // avoids walking a million-page document to compare identical values.
        return (
            documentPageCount > 0
            && (
                evidenceSignatures.size === documentPageCount
                || (detectionEvidenceComplete.value && detectionResultCount.value === documentPageCount)
            )
        )
            && detectionDocumentSignature === documentSignature.value
            && detectionPageOverrideSignatureToken === pageOverrideSignatureToken.value;
    }

    async function reconcileDetectionJobState(
        capability: NonNullable<ReturnType<typeof getScanCleanupCapability>>,
        detectionJobId: TJobId,
        owner: {
            ownerId: string;
            documentRevision: string
        },
    ) {
        for (let attempt = 0; attempt < DETECTION_SUBSCRIPTION_RECONCILIATION_ATTEMPTS; attempt += 1) {
            const state = await Promise.resolve()
                .then(() => capability.getDetectionJobState(detectionJobId, owner))
                .catch(() => null);
            if (state) {
                return state;
            }
            if (attempt + 1 < DETECTION_SUBSCRIPTION_RECONCILIATION_ATTEMPTS) {
                await yieldToDetectionReconciliation();
            }
        }
        return null;
    }

    function clearDetectionEvidence() {
        signatures.clear();
        retainedDetectionPages.clear();
        detectionResultCount.value = 0;
        detectionDocumentPageCount.value = 0;
        detectionEvidenceComplete.value = false;
        detectionResultStoreId.value = null;
        placementAnchorSummary.value = null;
        detectedLayoutByPage.clear();
        confidenceByPage.clear();
        documentPriorByPage.clear();
        settledPages.clear();
        textAxisByPage.clear();
        pagePlanEvidenceByPage.clear();
        sourcePageMetadataByPage.clear();
        clearOutputModeRecommendations();
    }

    function clearDetectionEvidenceForPage(pageNumber: number) {
        // A page edit can change the document top edge. Do not reuse the
        // previous xlarge calibration while replacement detection is pending.
        placementAnchorSummary.value = null;
        retainedDetectionPages.delete(pageNumber);
        signatures.delete(pageNumber);
        detectedLayoutByPage.delete(pageNumber);
        confidenceByPage.delete(pageNumber);
        documentPriorByPage.delete(pageNumber);
        settledPages.delete(pageNumber);
        textAxisByPage.delete(pageNumber);
        pagePlanEvidenceByPage.delete(pageNumber);
        sourcePageMetadataByPage.delete(pageNumber);
        recommendedOutputModeByPage.delete(pageNumber);
        recommendedOutputModeConfidenceByPage.delete(pageNumber);
        recommendedOutputModeReasonByPage.delete(pageNumber);
        softAlphaForegroundRecommendationByPage.delete(pageNumber);
    }

    function retainDetectionPage(
        pageNumber: number,
        documentPageCount = resolveDetectionDocumentPageCount(),
    ) {
        retainedDetectionPages.delete(pageNumber);
        retainedDetectionPages.add(pageNumber);
        if (documentPageCount <= DETECTION_RESULT_ARRAY_COMPATIBILITY_LIMIT) {
            return;
        }
        while (retainedDetectionPages.size > DETECTION_PAGE_CACHE_LIMIT) {
            const oldest = retainedDetectionPages.values().next().value;
            if (oldest === undefined) {
                return;
            }
            clearDetectionEvidenceForPage(oldest);
        }
    }

    function trimLargeDetectionMaps(documentPageCount = resolveDetectionDocumentPageCount()) {
        if (documentPageCount <= DETECTION_RESULT_ARRAY_COMPATIBILITY_LIMIT) {
            return;
        }
        const maps = [
            detectedLayoutByPage,
            confidenceByPage,
            documentPriorByPage,
            textAxisByPage,
            recommendedOutputModeByPage,
            recommendedOutputModeConfidenceByPage,
            recommendedOutputModeReasonByPage,
            softAlphaForegroundRecommendationByPage,
            pagePlanEvidenceByPage,
            sourcePageMetadataByPage,
        ];
        for (const map of maps) {
            while (map.size > DETECTION_PAGE_CACHE_LIMIT) {
                const oldest = map.keys().next().value;
                if (oldest === undefined) break;
                map.delete(oldest);
            }
        }
    }

    function retainSettledPage(
        pageNumber: number,
        documentPageCount = resolveDetectionDocumentPageCount(),
    ) {
        if (documentPageCount <= DETECTION_RESULT_ARRAY_COMPATIBILITY_LIMIT) {
            settledPages.add(pageNumber);
            return;
        }
        settledPages.delete(pageNumber);
        settledPages.add(pageNumber);
        while (settledPages.size > DETECTION_PAGE_CACHE_LIMIT) {
            const oldest = settledPages.values().next().value;
            if (oldest === undefined) {
                return;
            }
            settledPages.delete(oldest);
        }
    }

    function applyState(state: TScanCleanupDetectionJobState) {
        if (detectionIsTerminal(state)) {
            for (const settle of terminalWaiters.get(state.jobId) ?? []) settle();
            terminalWaiters.delete(state.jobId);
        }
        if (lifecycle.isDisposed() || state.jobId !== jobId) {
            return;
        }
        const current = jobState.value;
        if (current?.jobId === state.jobId) {
            const currentPhase = detectionPhaseRank(current.progress.stage);
            const nextPhase = detectionPhaseRank(state.progress.stage);
            if (
                state.updatedAtMs < current.updatedAtMs
                || nextPhase < currentPhase
                || (
                    nextPhase === currentPhase
                    && state.progress.completedUnits < current.progress.completedUnits
                )
            ) {
                return;
            }
        }
        const reportedResultCount = state.resultCount
            ?? (state.progress.stage === 'detecting'
                ? state.progress.completedUnits
                : detectionResultCount.value);
        // On a hard reopen, detection can publish its first running state
        // before the PDF viewer has finished loading its own page count. The
        // native state already carries the authoritative document size, so it
        // must control renderer retention as soon as it arrives. Otherwise a
        // large document is treated as a small compatibility job and every
        // streamed result remains in renderer maps.
        // A positive native total is the only count that belongs to this
        // detection job. Viewer metadata can still describe the document that
        // was open before a hard reopen, so it must not keep a replacement job
        // in the large-document retention mode.
        const nativePageCount = state.progress.totalUnits > 0
            ? state.progress.totalUnits
            : null;
        const documentPageCount = nativePageCount ?? Math.max(
            options.totalPages.value,
            detectionDocumentPageCount.value,
            state.progress.completedUnits,
            reportedResultCount,
            state.results.length,
        );
        if (nativePageCount !== null) {
            detectionDocumentPageCount.value = nativePageCount;
        } else if (documentPageCount > detectionDocumentPageCount.value) {
            detectionDocumentPageCount.value = documentPageCount;
        }
        detectionResultCount.value = Math.max(detectionResultCount.value, reportedResultCount);
        if (state.status === 'completed') {
            detectionEvidenceComplete.value = documentPageCount > 0
                && detectionResultCount.value >= documentPageCount;
        }
        for (const result of state.results) {
            retainDetectionPage(result.pageNumber, documentPageCount);
            // Large renderer projections omit completedPageNumbers, but every
            // result is still a settled page that must be retained in the
            // bounded settled-page set.
            retainSettledPage(result.pageNumber, documentPageCount);
            const requestSignature = detectionRequestSignature(result.pageNumber);
            if (requestSignature === signature(result.pageNumber)) {
                signatures.set(result.pageNumber, requestSignature);
            } else {
                signatures.delete(result.pageNumber);
            }
            if (result.sourcePageMetadata !== undefined) {
                sourcePageMetadataByPage.set(result.pageNumber, result.sourcePageMetadata);
            } else {
                sourcePageMetadataByPage.delete(result.pageNumber);
            }
            if (result.pagePlanEvidence !== undefined) {
                pagePlanEvidenceByPage.set(result.pageNumber, result.pagePlanEvidence);
            } else {
                pagePlanEvidenceByPage.delete(result.pageNumber);
            }
        }
        jobState.value = state;
        documentCanvasSignature.value = state.documentCanvasSignature ?? '';
        if (state.detectionResultStoreId !== undefined) {
            detectionResultStoreId.value = state.detectionResultStoreId;
        }
        placementAnchorSummary.value = state.placementAnchorSummary ?? null;
        for (const pageNumber of state.progress.completedPageNumbers ?? []) {
            retainSettledPage(pageNumber, documentPageCount);
        }
        const completedWithCurrentEvidence = state.status === 'completed'
            && evidenceIsCurrent(signatures, documentPageCount);
        applyScanCleanupDetectionResults(
            // The state payload already contains the latest bounded window and
            // is the authoritative batch to derive from.
            state.results,
            detectedLayoutByPage,
            confidenceByPage,
            pageNumber => signatures.get(pageNumber) === signature(pageNumber),
            documentPriorByPage,
            textAxisByPage,
            recommendedOutputModeByPage,
            recommendedOutputModeConfidenceByPage,
            recommendedOutputModeReasonByPage,
            softAlphaForegroundRecommendationByPage,
        );
        trimLargeDetectionMaps(documentPageCount);
        if (state.status === 'failed') {
            // A scratch refusal is the one detection failure the user can act
            // on, so it is stated in full instead of a generic headline with
            // the English exception appended to it.
            error.value = state.errorCode === 'insufficient-scratch'
                ? formatScanCleanupScratchMessage(t, state.scratchShortfall)
                : formatScanCleanupErrorMessage(
                    t('scanCleanup.detectAll.failed'),
                    state.error,
                );
            errorCode.value = state.errorCode;
        } else if (state.status === 'completed') {
            error.value = '';
            errorCode.value = null;
        } else if (state.status === 'canceled') {
            error.value = '';
            errorCode.value = null;
        }
        if (
            !lifecycle.isDisposed()
            && jobDocumentKey
            && completedWithCurrentEvidence
            && documentPageCount <= DETECTION_RESULT_ARRAY_COMPATIBILITY_LIMIT
        ) {
            detectionSessionCache.set(jobDocumentKey, {
                ownerId: options.ownerId,
                results: state.results.map(result => ({...result})),
                signatures: new Map(signatures),
                documentSignature: detectionDocumentSignature,
                signatureToken: detectionPageOverrideSignatureToken,
                state: structuredClone(state),
                totalPages: state.progress.totalUnits,
            });
        }
        if (!lifecycle.isDisposed() && state.status === 'completed' && !completedWithCurrentEvidence) {
            jobState.value = null;
            documentCanvasSignature.value = '';
            scheduleAutoDetect();
        }
    }

    async function detectAllPages(automatic = false) {
        if (!options.sourcePath.value || !canStart.value) {
            return;
        }
        const capability = getScanCleanupCapability();
        if (!capability) {
            return;
        }
        error.value = '';
        errorCode.value = null;
        if (!automatic && options.lifecycleDocumentKey.value) {
            autoDetectionCanceledDocuments.delete(options.lifecycleDocumentKey.value);
        }
        captureDetectionSignatures();
        signatures.clear();
        const requestSourcePath = options.sourcePath.value;
        const requestDocumentRevision = options.documentRevision.value;
        const generation = ++requestGeneration;
        const isStale = () => lifecycle.isDisposed()
            || generation !== requestGeneration
            || requestSourcePath !== options.sourcePath.value
            || requestDocumentRevision !== options.documentRevision.value;
        jobDocumentKey = options.lifecycleDocumentKey.value;
        jobDocumentRevision = requestDocumentRevision;
        jobId = null;
        jobState.value = null;
        documentCanvasSignature.value = '';
        detectionResultStoreId.value = null;
        starting.value = true;
        let result;
        try {
            result = await capability.detectAll(toBridgeSafeScanCleanupPayload({
                sourcePdfPath: requestSourcePath,
                ownerId: options.ownerId,
                documentRevision: jobDocumentRevision,
                options: toPlainScanCleanupOptions(options.settings),
            }));
        } catch (caught) {
            if (isStale()) {
                scheduleAutoDetect();
            } else {
                error.value = formatScanCleanupErrorMessage(
                    t('scanCleanup.detectAll.failed'),
                    caught,
                );
                errorCode.value = 'internal';
            }
            return;
        } finally {
            if (!lifecycle.isDisposed()) starting.value = false;
        }
        if (isStale()) {
            if (result.started) {
                void enqueueDetectionRetirement(result.jobId, requestDocumentRevision);
            }
            // The lifecycle watcher may have tried to schedule the replacement
            // while `starting` still belonged to this request. Make the retry
            // explicit after the stale request releases that gate.
            scheduleAutoDetect();
            return;
        }
        if (!result.started) {
            error.value = result.errorCode === 'tools-unavailable'
                ? t('scanCleanup.runDisabled.unavailable')
                : formatScanCleanupErrorMessage(t('scanCleanup.detectAll.failed'), result.error);
            errorCode.value = result.errorCode;
            return;
        }
        clearDetectionEvidence();
        jobId = result.jobId;
        jobState.value = {
            jobId: result.jobId,
            status: 'queued',
            progress: {
                stage: 'queued',
                completedUnits: 0,
                totalUnits: options.totalPages.value,
                percent: 0,
                completedPageNumbers: [],
            },
            results: [],
            updatedAtMs: createEpochMs(0),
        };
        const owner = {
            ownerId: options.ownerId,
            documentRevision: requestDocumentRevision,
        };
        let state: TScanCleanupDetectionJobState | null;
        try {
            state = await capability.subscribeDetectionJob(result.jobId, owner);
        } catch (caught) {
            const isCurrentJob = !isStale() && result.jobId === jobId;
            if (!isCurrentJob) {
                void Promise.resolve()
                    .then(() => capability.cancelDetection(result.jobId, owner))
                    .catch(() => undefined);
                return;
            }
            const reconciled = await reconcileDetectionJobState(capability, result.jobId, owner);
            const stillCurrentJob = !isStale() && result.jobId === jobId;
            if (!stillCurrentJob) {
                return;
            }
            if (reconciled) {
                applyState(reconciled);
                return;
            }
            // A job that cannot be observed is abandoned at the renderer
            // boundary. The main-process cancel is best effort, but the UI
            // must release its queued/running guard even when the bridge is
            // already gone.
            await Promise.resolve()
                .then(() => capability.cancelDetection(result.jobId, owner))
                .catch(() => false);
            if (!isStale() && result.jobId === jobId) {
                jobId = null;
                jobState.value = null;
                documentCanvasSignature.value = '';
                error.value = formatScanCleanupErrorMessage(
                    t('scanCleanup.errors.detectionSubscriptionFailed'),
                    caught,
                );
                errorCode.value = 'internal';
            }
            return;
        }
        if (isStale() || result.jobId !== jobId) {
            return;
        }
        if (state) applyState(state);
    }

    async function cancel() {
        if (!jobId || cancelRequested.value) {
            return;
        }
        const capability = getScanCleanupCapability();
        if (!capability) {
            return;
        }
        if (await capability.cancelDetection(jobId, {
            ownerId: options.ownerId,
            documentRevision: jobDocumentRevision ?? options.documentRevision.value,
        }) && !lifecycle.isDisposed() && jobDocumentKey) {
            autoDetectionCanceledDocuments.add(jobDocumentKey);
        }
    }

    async function settleCurrentDetection(cancelCurrent: boolean) {
        return new Promise<void>((resolve, reject) => {
            const waitState: {settled: boolean} = {settled: false};
            let stopStarting: (() => void) | null = null;
            let targetJobId: TJobId | null = null;
            let terminalWaiter: (() => void) | null = null;
            const timeout = cancelCurrent
                ? setTimeout(() => {
                    finish(new Error(t('scanCleanup.detectAll.cancelTimeout')));
                }, DETECTION_CANCELLATION_TIMEOUT_MS)
                : null;

            function cleanup() {
                if (timeout !== null) clearTimeout(timeout);
                stopStarting?.();
                if (targetJobId && terminalWaiter) {
                    const waiters = terminalWaiters.get(targetJobId);
                    waiters?.delete(terminalWaiter);
                    if (waiters?.size === 0) terminalWaiters.delete(targetJobId);
                }
            }

            function finish(caught?: unknown) {
                if (waitState.settled) {
                    return;
                }
                waitState.settled = true;
                cleanup();
                if (caught === undefined) {
                    resolve();
                } else {
                    reject(caught);
                }
            }

            void (async () => {
                if (starting.value) {
                    await new Promise<void>(resolveStarting => {
                        stopStarting = watch(starting, value => {
                            if (!value) resolveStarting();
                        }, {flush: 'sync'});
                    });
                    const stopAfterStarting = stopStarting as (() => void) | null;
                    stopAfterStarting?.();
                    stopStarting = null;
                    if (waitState.settled) {
                        return;
                    }
                    await nextTick();
                }
                targetJobId = jobId;
                const targetJobRevision = jobDocumentRevision ?? options.documentRevision.value;
                if (!targetJobId || detectionIsTerminal(jobState.value)) {
                    finish();
                    return;
                }
                const capability = getScanCleanupCapability();
                if (!capability) {
                    finish();
                    return;
                }
                terminalWaiter = () => finish();
                const waiters = terminalWaiters.get(targetJobId) ?? new Set<() => void>();
                waiters.add(terminalWaiter);
                terminalWaiters.set(targetJobId, waiters);
                if (cancelCurrent && !cancelRequested.value) {
                    await capability.cancelDetection(targetJobId, {
                        ownerId: options.ownerId,
                        documentRevision: targetJobRevision,
                    });
                    if (waitState.settled) {
                        return;
                    }
                }
                const latest = await capability.getDetectionJobState(targetJobId, {
                    ownerId: options.ownerId,
                    documentRevision: targetJobRevision,
                });
                if (waitState.settled) {
                    return;
                }
                if (!latest) {
                    // A subscribed job can briefly be absent from a direct
                    // reconciliation read while its start is publishing. A
                    // run waiting for evidence must keep its event waiter in
                    // place; cancellation, conversely, may treat absence as
                    // terminal because there is no remaining work to stop.
                    if (cancelCurrent) finish();
                    return;
                }
                applyState(latest);
            })().catch(finish);
        });
    }

    async function cancelAndWaitForTerminal() {
        await settleCurrentDetection(true);
    }

    async function waitForTerminal() {
        // Evidence invalidation clears the completed snapshot before its
        // zero-delay replacement is started. A cleanup click can land in that
        // turn: make the click own the replacement rather than returning from
        // an empty session and misclassifying the transient gap as missing
        // evidence. Acquiring an authoritative source hash can retire that
        // run-owned start in flight, so follow only the replacement explicitly
        // scheduled by the current lifecycle. Terminal failed/canceled states
        // and real start failures remain authoritative and are not retried.
        const waitSourcePath = options.sourcePath.value;
        const waitDocumentRevision = options.documentRevision.value;
        let mayStartMissingDetection = jobState.value === null;
        const belongsToWaitedDocument = () => waitSourcePath === options.sourcePath.value
            && waitDocumentRevision === options.documentRevision.value;
        while (!lifecycle.isDisposed() && options.active() && belongsToWaitedDocument()) {
            if (terminalStatus.value !== null) {
                return;
            }
            if (
                jobState.value !== null
                && (
                    !jobBelongsToCurrentDocument()
                    || detectionIsTerminal(jobState.value)
                )
            ) {
                // Computed identity changes synchronously, while the watcher
                // that retires the old maps and schedules their replacement
                // runs in Vue's next flush. Do not let the raw prior terminal
                // snapshot escape through that one-turn gap.
                mayStartMissingDetection = true;
                await nextTick();
                if (!belongsToWaitedDocument() || Boolean(terminalStatus.value)) {
                    return;
                }
            }
            if (jobState.value === null && !starting.value) {
                if (
                    !mayStartMissingDetection
                    || error.value
                    || getScanCleanupCapability() === null
                ) {
                    return;
                }
                if (scheduledAutoDetection !== null) {
                    clearTimeout(scheduledAutoDetection);
                    scheduledAutoDetection = null;
                    autoPending.value = false;
                }
                await waitForDetectionRetirements();
                if (!belongsToWaitedDocument() || Boolean(lifecycle.isDisposed()) || !options.active()) {
                    return;
                }
                const generation = requestGeneration;
                mayStartMissingDetection = false;
                await detectAllPages(false);
                if (!belongsToWaitedDocument() || Boolean(terminalStatus.value)) {
                    return;
                }
                if (!hasDetectionJob()) {
                    const replacementScheduled = Boolean(scheduledAutoDetection)
                        || generation !== requestGeneration;
                    if (!replacementScheduled || error.value) {
                        return;
                    }
                    mayStartMissingDetection = true;
                    continue;
                }
            }
            await settleCurrentDetection(false);
            if (!belongsToWaitedDocument() || Boolean(terminalStatus.value)) {
                return;
            }
            if (jobState.value === null && scheduledAutoDetection !== null && !error.value) {
                mayStartMissingDetection = true;
                continue;
            }
            return;
        }
    }

    function cacheIsFresh(entry: IDetectionSessionCacheEntry, lifecycleDocumentKey: string) {
        const documentIdentity = lifecycleDocumentKey.split('\u0000', 1)[0] ?? '';
        const authoritativeIdentity = isScanCleanupSourceSha256(options.sourceSha256.value)
            && documentIdentity === options.sourceSha256.value.toLowerCase();
        const documentPageCount = options.totalPages.value > 0
            ? options.totalPages.value
            : entry.totalPages;
        if (
            (!authoritativeIdentity && entry.ownerId !== options.ownerId)
            || entry.totalPages !== documentPageCount
            || documentPageCount > DETECTION_RESULT_ARRAY_COMPATIBILITY_LIMIT
            || entry.signatures.size !== documentPageCount
            || entry.documentSignature !== documentSignature.value
            || entry.signatureToken !== pageOverrideSignatureToken.value
        ) {
            return false;
        }
        if (!evidenceIsCurrent(entry.signatures, documentPageCount)) {
            return false;
        }
        return entry.state.status === 'completed' && entry.results.length === documentPageCount;
    }

    function restoreSession(key: string | null) {
        if (key === null) {
            return false;
        }
        captureDetectionSignatures();
        const cached = detectionSessionCache.get(key);
        if (!cached || !cacheIsFresh(cached, key)) {
            return false;
        }
        jobDocumentKey = key;
        jobDocumentRevision = options.documentRevision.value;
        jobState.value = structuredClone(cached.state);
        documentCanvasSignature.value = cached.state.documentCanvasSignature ?? '';
        placementAnchorSummary.value = cached.state.placementAnchorSummary ?? null;
        detectionResultCount.value = cached.state.resultCount ?? cached.results.length;
        detectionDocumentPageCount.value = cached.totalPages;
        detectionEvidenceComplete.value = detectionResultCount.value >= cached.totalPages;
        retainedDetectionPages.clear();
        for (const result of cached.results) {
            retainDetectionPage(result.pageNumber, cached.totalPages);
        }
        sourcePageMetadataByPage.clear();
        for (const result of cached.results) {
            if (result.sourcePageMetadata !== undefined) {
                sourcePageMetadataByPage.set(result.pageNumber, result.sourcePageMetadata);
            }
        }
        signatures.clear();
        for (const [
            pageNumber,
            value,
        ] of cached.signatures) signatures.set(pageNumber, value);
        settledPages.clear();
        for (const result of cached.results) retainSettledPage(result.pageNumber, cached.totalPages);
        applyScanCleanupDetectionResults(
            cached.results,
            detectedLayoutByPage,
            confidenceByPage,
            undefined,
            documentPriorByPage,
            textAxisByPage,
            recommendedOutputModeByPage,
            recommendedOutputModeConfidenceByPage,
            recommendedOutputModeReasonByPage,
            softAlphaForegroundRecommendationByPage,
        );
        pagePlanEvidenceByPage.clear();
        for (const result of cached.results) {
            if (result.pagePlanEvidence !== undefined) {
                pagePlanEvidenceByPage.set(result.pageNumber, result.pagePlanEvidence);
            }
        }
        trimLargeDetectionMaps(cached.totalPages);
        return true;
    }

    async function maybeAutoDetect() {
        const key = options.lifecycleDocumentKey.value;
        if (
            lifecycle.isDisposed()
            || !options.active()
            || !options.sourcePath.value
            || !canStart.value
            || restoreSession(key)
            || (key !== null && autoDetectionCanceledDocuments.has(key))
        ) {
            autoPending.value = false;
            return;
        }
        autoPending.value = true;
        try {
            await detectAllPages(true);
        } finally {
            autoPending.value = false;
        }
    }

    function scheduleAutoDetect() {
        if (lifecycle.isDisposed() || scheduledAutoDetection !== null) {
            return;
        }
        const generation = requestGeneration;
        const scheduled = setTimeout(async () => {
            await waitForDetectionRetirements();
            if (scheduledAutoDetection !== scheduled) {
                return;
            }
            scheduledAutoDetection = null;
            if (generation !== requestGeneration) {
                scheduleAutoDetect();
                return;
            }
            void maybeAutoDetect();
        }, 0);
        scheduledAutoDetection = scheduled;
    }

    onMounted(() => {
        stopSubscription = getScanCleanupCapability()?.onDetectionJobState(applyState) ?? null;
        void maybeAutoDetect();
    });
    watch(options.lifecycleDocumentKey, (key, previousKey) => {
        const promoted = previousKey !== undefined
            && isScanCleanupLifecycleIdentityPromotion(
                previousKey,
                key,
                options.sourcePath.value,
                options.sourceSha256.value,
                options.documentRevision.value,
            );
        const sourceChanged = Boolean(
            options.sourcePath.value
            && options.sourcePath.value !== rememberedSourcePath
            && !promoted,
        );
        if (sourceChanged) {
            documentAliases.clear();
        }
        rememberedSourcePath = options.sourcePath.value;
        // A promotion owns both spellings of one document. On a real source
        // switch, retaining the previous document here would let closing the
        // new document evict an unrelated recent restore entry.
        if (!sourceChanged) rememberDocumentAliases(previousKey);
        rememberDocumentAliases(key);
        if (promoted) {
            promoteScanCleanupDetectionState({
                provisionalLifecycleKey: previousKey,
                authoritativeLifecycleKey: key,
                sourcePath: options.sourcePath.value,
                sourceSha256: options.sourceSha256.value,
                documentRevision: options.documentRevision.value,
            });
            // Identity publication does not replace the source or revision.
            // Keep the native job, accumulated evidence, and renderer state;
            // only its cache key changes.
            jobDocumentKey = key;
            jobDocumentRevision = options.documentRevision.value;
            if (jobState.value === null && !isDetecting.value) {
                autoPending.value = Boolean(options.active() && options.sourcePath.value);
                scheduleAutoDetect();
            }
            return;
        }
        if (key === null) {
            // The workspace can stay mounted while its document is closed.
            // This is the actual lifecycle boundary for detection state; a
            // panel/session unmount alone must leave an authoritative entry
            // available for a later reopen.
            discardScanCleanupDetectionStateForAliases([...documentAliases]);
            documentAliases.clear();
        }
        retireSupersededScanCleanupDetectionState(key);
        requestGeneration += 1;
        if (jobId && isDetecting.value) {
            void enqueueDetectionRetirement(
                jobId,
                jobDocumentRevision ?? options.documentRevision.value,
            );
        }
        jobId = null;
        jobDocumentRevision = null;
        jobDocumentKey = options.lifecycleDocumentKey.value;
        jobState.value = null;
        documentCanvasSignature.value = '';
        error.value = '';
        errorCode.value = null;
        clearDetectionEvidence();
        detectionDocumentSignature = documentSignature.value;
        detectionPageOverrideSignatureToken = pageOverrideSignatureToken.value;
        detectionPageOverrideSignatures.clear();
        observedDocumentSignature = documentSignature.value;
        observedPageOverrideSignatures = readPageOverrideSignatures();
        observedTotalPages = options.totalPages.value;
        autoPending.value = Boolean(options.active() && options.sourcePath.value);
        // The mounted hook owns the initial auto-detect; scheduling it here too
        // would race a just-started or just-completed job on the same document.
        if (previousKey !== undefined) {
            scheduleAutoDetect();
        }
    }, {immediate: true});
    watch(options.sourcePath, sourcePath => {
        if (sourcePath !== null) {
            return;
        }
        // Some document-close flows clear the acquired path before clearing
        // their legacy key, so the lifecycle key watcher is not guaranteed to
        // observe a null transition of its own.
        discardScanCleanupDetectionStateForAliases([...documentAliases]);
        documentAliases.clear();
        clearDetectionEvidence();
    });
    watch(options.active, active => {
        if (active) scheduleAutoDetect();
    });
    // Recommendations are page diagnostics and survive output-mode changes.
    // Switching back to automatic mode must have usable recommendations, so a
    // previously canceled or stranded detection is rescheduled here.
    watch(
        () => options.settings.outputMode === 'auto'
            && options.settings.preserveOriginalQuality !== true,
        automaticMode => {
            if (!automaticMode) {
                return;
            }
            const key = options.lifecycleDocumentKey.value;
            if (key !== null) autoDetectionCanceledDocuments.delete(key);
            scheduleAutoDetect();
        },
    );
    watch(
        [
            documentSignature,
            pageOverrideSignatureToken,
            options.totalPages,
        ],
        ([
            currentDocumentSignature,
            ,
            currentTotalPages,
        ]) => {
            const currentPageSignatures = readPageOverrideSignatures();
            const documentChanged = currentDocumentSignature !== observedDocumentSignature;
            const pageCountChanged = currentTotalPages !== observedTotalPages
                && !(
                    observedTotalPages === 0
                    && detectionDocumentPageCount.value === currentTotalPages
                );
            const changedPages = new Set<number>();
            if (documentChanged || pageCountChanged) {
                clearDetectionEvidence();
            } else {
                for (const pageNumber of new Set([
                    ...observedPageOverrideSignatures.keys(),
                    ...currentPageSignatures.keys(),
                ])) {
                    if (observedPageOverrideSignatures.get(pageNumber) !== currentPageSignatures.get(pageNumber)) {
                        changedPages.add(pageNumber);
                    }
                }
                for (const pageNumber of changedPages) clearDetectionEvidenceForPage(pageNumber);
            }
            observedDocumentSignature = currentDocumentSignature;
            observedPageOverrideSignatures = currentPageSignatures;
            observedTotalPages = currentTotalPages;
            if (!documentChanged && !pageCountChanged && changedPages.size === 0) {
                return;
            }
            const key = options.lifecycleDocumentKey.value;
            if (key !== null) detectionSessionCache.delete(key);
            if (!isDetecting.value) {
                jobState.value = null;
                documentCanvasSignature.value = '';
                scheduleAutoDetect();
            }
        },
    );
    onBeforeUnmount(() => {
        lifecycle.dispose();
        if (scheduledAutoDetection !== null) {
            clearTimeout(scheduledAutoDetection);
            scheduledAutoDetection = null;
        }
        stopSubscription?.();
        if (jobId && isDetecting.value) {
            void getScanCleanupCapability()?.cancelDetection(jobId, {
                ownerId: options.ownerId,
                documentRevision: jobDocumentRevision ?? options.documentRevision.value,
            }).catch(() => undefined);
        }
    });

    return {
        authoritativeLayoutByPage,
        blankPageCount,
        canDetectAll,
        cancel,
        cancelAndWaitForTerminal,
        cancelRequested,
        confidenceByPage,
        detectAllPages,
        documentCanvasSignature,
        documentPriorByPage,
        detectionEvidenceComplete: computed(() => detectionEvidenceComplete.value),
        detectionResultStoreId: computed(() => detectionResultStoreId.value),
        placementAnchorSummary: computed(() => placementAnchorSummary.value),
        error,
        errorCode,
        isDetecting,
        layoutDetectionComplete,
        maybeAutoDetect,
        outputEstimate,
        pagePlanEvidenceByPage,
        pending,
        progress,
        progressCountText,
        progressCountWidestText,
        progressEtaText,
        progressEtaWidestText,
        progressPercent,
        progressPhaseText,
        progressText,
        progressWidestText,
        recommendedOutputModeByPage,
        recommendedOutputModeConfidenceByPage,
        recommendedOutputModeReasonByPage,
        softAlphaForegroundRecommendationByPage,
        settledPages,
        sourcePageMetadataByPage: computed(() => sourcePageMetadataByPage),
        textAxisByPage,
        terminalStatus,
        waitForTerminal,
    };
};
