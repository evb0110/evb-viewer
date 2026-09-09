import type {TDocumentRef} from '@contracts/documentRef';
import {requirePageNumber} from '@contracts/pageNumbers';
import type {TScanCleanupPageOutputMapping} from '@contracts/scan-cleanup/domain';
import type {
    IScanCleanupPagePlanEvidence,
    IScanCleanupSourcePageMetadata,
} from '@contracts/electronApiScanCleanup';
import type {
    IScanCleanupPlacementAnchorSample,
    TScanCleanupPlacementAnchorsByPage,
} from '@contracts/scanCleanupPageOverrides';
import {
    attachScanCleanupPageOverrideDefaults,
    getScanCleanupPageOverride,
    resolveScanCleanupPlacementAnchors,
    SCAN_CLEANUP_OUTPUT_HALVES,
    SCAN_CLEANUP_INK_ANCHOR_TOLERANCE_MM,
    usesScanCleanupInkAlignment,
} from '@contracts/scanCleanupPageOverrides';
import {isScanCleanupSourceSha256} from '@contracts/scanCleanupSettings';
import {isScanCleanupRunning} from '@app/modules/scan-cleanup/runtime/scanCleanupRunCoordinator';
import {useScanCleanupSelection} from '@app/modules/scan-cleanup/composables/useScanCleanupSelection';
import {useScanCleanupDocumentSettings} from '@app/modules/scan-cleanup/composables/useScanCleanupDocumentSettings';
import {useScanCleanupDetectionSession} from '@app/modules/scan-cleanup/composables/useScanCleanupDetectionSession';
import {useScanCleanupPreviewSession} from '@app/modules/scan-cleanup/composables/useScanCleanupPreviewSession';
import {useScanCleanupRunSession} from '@app/modules/scan-cleanup/composables/useScanCleanupRunSession';
import {toPlainScanCleanupOptions} from '@app/modules/scan-cleanup/persistence/preferencesRepository';

const POINTS_PER_MM = 72 / 25.4;

/**
 * The rotated height of a source sheet, in points; 0 when the paper cannot be
 * measured.
 */
function resolveScanCleanupSheetHeightPoints(metadata: IScanCleanupSourcePageMetadata | undefined) {
    if (metadata === undefined) {
        return 0;
    }
    const swapsAxes = (((Math.round(metadata.rotation / 90) % 2) + 2) % 2) === 1;
    return swapsAxes ? metadata.widthPoints : metadata.heightPoints;
}

/**
 * The height every ink sample and the snapping tolerance are measured against:
 * the tallest sheet the document produces, which is the rectangle the matched
 * canvas settles on. Content boxes come normalized against their own sheet, so
 * a shorter sheet's box is rescaled onto this reference before it is compared,
 * and a millimetre tolerance becomes comparable once divided by it. Paper that
 * cannot be measured leaves the tolerance at zero, which still keeps every
 * output on its own ink and only stops pages from snapping together.
 */
function resolveScanCleanupInkReferenceHeightPoints(
    pageNumbers: Iterable<number>,
    metadataByPage: ReadonlyMap<number, IScanCleanupSourcePageMetadata>,
) {
    let heightPoints = 0;
    for (const pageNumber of pageNumbers) {
        heightPoints = Math.max(
            heightPoints,
            resolveScanCleanupSheetHeightPoints(metadataByPage.get(pageNumber)),
        );
    }
    return heightPoints;
}

interface IUseScanCleanupWorkspaceSessionOptions {
    active: () => boolean;
    beforeRun?: () => Promise<void> | void;
    sourcePath: () => TDocumentRef | null;
    documentKey: () => string | null;
    sourceSha256?: () => string | null;
    documentRevision?: () => string | null;
    ownerId?: () => string | undefined;
    currentPage: () => number;
    totalPages: () => number;
    initialPreviewPage?: () => number | undefined;
    initialPreviewViewMode?: () => 'original' | 'cleaned' | undefined;
    pageMapping?: () => TScanCleanupPageOutputMapping | null | undefined;
}

export const useScanCleanupWorkspaceSession = (options: IUseScanCleanupWorkspaceSessionOptions) => {
    const initialPreviewPage = Math.max(1, Math.trunc(options.initialPreviewPage?.() ?? options.currentPage()));
    const ownerId = options.ownerId?.() ?? globalThis.crypto.randomUUID();
    const sourcePath = computed(options.sourcePath);
    const totalPages = computed(options.totalPages);
    const legacyDocumentKey = computed(() => options.documentKey() ?? sourcePath.value);
    const sourceSha256 = computed(() => {
        const supplied = options.sourceSha256?.() ?? options.documentKey();
        return isScanCleanupSourceSha256(supplied) ? supplied.toLowerCase() : null;
    });
    const documentRevision = computed(() => options.documentRevision?.()
        ?? legacyDocumentKey.value
        ?? sourcePath.value
        ?? 'unavailable');
    const lifecycleDocumentKey = computed(() => legacyDocumentKey.value === null
        ? null
        : `${sourceSha256.value ?? legacyDocumentKey.value}\u0000${documentRevision.value}`);

    const settings = useScanCleanupDocumentSettings({
        documentLifecycleKey: lifecycleDocumentKey,
        sourceSha256,
        legacyDocumentKey,
    });
    watch(
        [
            () => settings.values.pageOverrides,
            () => settings.values.pageOverrideDefaults,
        ],
        (
            [
                pageOverrides,
                pageOverrideDefaults,
            ],
        ) => {
            attachScanCleanupPageOverrideDefaults(
                pageOverrides,
                pageOverrideDefaults,
                settings.values.marginsMm,
            );
        },
        {
            deep: true,
            immediate: true,
        },
    );
    const resolvedOptions = computed(() => toPlainScanCleanupOptions(settings.values));
    let previewResult = null as ReturnType<typeof useScanCleanupPreviewSession> | null;
    const selection = useScanCleanupSelection({
        initialPage: initialPreviewPage,
        previewResult: () => previewResult?.result.value ?? null,
        previewTotalPages: () => previewResult?.totalPages.value ?? Math.max(1, totalPages.value),
        settings: settings.values,
    });
    watch(options.active, active => {
        if (active) selection.resetToLeader(previewResult?.totalPages.value ?? Math.max(1, totalPages.value));
    }, {immediate: true});
    const detection = useScanCleanupDetectionSession({
        active: options.active,
        documentRevision,
        isRunning: isScanCleanupRunning,
        lifecycleDocumentKey,
        ownerId,
        settings: settings.values,
        sourceSha256,
        sourcePath,
        totalPages,
    });
    // `ink` keeps every output at the height its source ink sat relative to
    // the rest of the document, and pages whose ink agrees share one position.
    // That comparison is document-wide, so it is resolved once here rather
    // than per request: the preview the user judges and the run they start
    // must place a page identically.
    const placementAnchorsByPage = computed<TScanCleanupPlacementAnchorsByPage>(() => {
        const cleanupOptions = resolvedOptions.value;
        if (!usesScanCleanupInkAlignment(cleanupOptions)) {
            return new Map();
        }
        const metadataByPage = detection.sourcePageMetadataByPage.value;
        const included = [...detection.pagePlanEvidenceByPage].filter(
            ([pageNumber]) => !getScanCleanupPageOverride(
                cleanupOptions.pageOverrides,
                requirePageNumber(pageNumber),
            ).excluded,
        );
        const referenceHeightPoints = resolveScanCleanupInkReferenceHeightPoints(
            included.map(([pageNumber]) => pageNumber),
            metadataByPage,
        );
        const samples: IScanCleanupPlacementAnchorSample[] = [];
        // A sheet that cannot be measured keeps its own-sheet fraction, which
        // is not comparable with the others; snapping is only meaningful when
        // every included output speaks the reference height's units.
        let everySheetMeasured = referenceHeightPoints > 0;
        for (const [
            pageNumber,
            evidence,
        ] of included) {
            const brandedPageNumber = requirePageNumber(pageNumber);
            const pageOverride = getScanCleanupPageOverride(cleanupOptions.pageOverrides, brandedPageNumber);
            const sheetHeightPoints = resolveScanCleanupSheetHeightPoints(metadataByPage.get(pageNumber));
            const measured = referenceHeightPoints > 0 && sheetHeightPoints > 0;
            everySheetMeasured &&= measured;
            const scale = measured ? sheetHeightPoints / referenceHeightPoints : 1;
            for (const half of SCAN_CLEANUP_OUTPUT_HALVES) {
                const box = pageOverride.manualContentBoxes?.[half] ?? evidence.outputs[half]?.contentBox;
                if (box === undefined) {
                    continue;
                }
                samples.push({
                    pageNumber: brandedPageNumber,
                    half,
                    yNormalized: box.yNormalized * scale,
                });
            }
        }
        return resolveScanCleanupPlacementAnchors(
            samples,
            everySheetMeasured
                ? SCAN_CLEANUP_INK_ANCHOR_TOLERANCE_MM * POINTS_PER_MM / referenceHeightPoints
                : 0,
        );
    });
    previewResult = useScanCleanupPreviewSession({
        active: options.active,
        authoritativeLayoutByPage: detection.authoritativeLayoutByPage,
        documentCanvasSignature: detection.documentCanvasSignature,
        documentRevision,
        documentPriorByPage: detection.documentPriorByPage,
        initialViewMode: options.initialPreviewViewMode?.(),
        layoutDetectionComplete: detection.layoutDetectionComplete,
        lifecycleDocumentKey,
        ownerId,
        pagePlanEvidenceByPage: detection.pagePlanEvidenceByPage,
        placementAnchorsByPage,
        previewPage: selection.leader,
        recommendedOutputModeByPage: detection.recommendedOutputModeByPage,
        resolvedOptions,
        softAlphaForegroundRecommendationByPage:
            detection.softAlphaForegroundRecommendationByPage,
        selectPage: selection.selectPage,
        settings: settings.values,
        sourceSha256,
        sourcePath,
        totalPages,
    });
    const documentIdentity = computed(() => `${sourcePath.value ?? ''}\u0000${documentRevision.value}`);
    watch([
        documentIdentity,
        totalPages,
    ], (
        [
            identity,
            pageCount,
        ],
        [previousIdentity],
    ) => {
        const normalizedPageCount = Math.max(1, Math.trunc(pageCount));
        if (identity !== previousIdentity) {
            const pageMapping = options.pageMapping?.();
            selection.reconcileDocumentReplacement({
                defaultPage: options.currentPage(),
                pageCount: normalizedPageCount,
                ...(pageMapping === undefined ? {} : {pageMapping}),
            });
            return;
        }
        selection.reconcilePageCount(normalizedPageCount, options.currentPage());
    });
    function resolvePagePlanEvidence(pageNumbers: readonly number[] | null) {
        if (pageNumbers === null) {
            return new Map<number, IScanCleanupPagePlanEvidence>(detection.pagePlanEvidenceByPage);
        }
        const evidence = new Map<number, IScanCleanupPagePlanEvidence>();
        for (const pageNumber of pageNumbers) {
            const detected = detection.pagePlanEvidenceByPage.get(pageNumber);
            if (detected !== undefined) evidence.set(pageNumber, detected);
        }
        return evidence;
    }
    const run = useScanCleanupRunSession({
        active: options.active,
        authoritativeLayoutByPage: detection.authoritativeLayoutByPage,
        beforeRun: async () => {
            await previewResult.pauseForRun();
            await options.beforeRun?.();
        },
        detectionError: detection.error,
        detectionErrorCode: detection.errorCode,
        detectionEvidenceComplete: detection.detectionEvidenceComplete,
        detectionResultStoreId: detection.detectionResultStoreId,
        placementAnchorSummary: detection.placementAnchorSummary,
        detectionPending: detection.pending,
        detectionStatus: detection.terminalStatus,
        documentSettingsReady: computed(() => settings.documentSettingsReady.value),
        documentPriorByPage: detection.documentPriorByPage,
        documentRevision,
        onCompleted: settings.dismissFirstRunGuidance,
        ownerId,
        placementAnchorsByPage,
        previewTotalPages: () => previewResult.totalPages.value,
        resolvePagePlanEvidence,
        sourcePageNumbers: computed(() => {
            if (selection.settingsScope.value === 'all') {
                return null;
            }
            if (selection.settingsScope.value === 'page') {
                return [selection.leader.value];
            }
            return [...selection.selectedPages.value].sort((left, right) => left - right);
        }),
        sourcePageMetadataByPage: detection.sourcePageMetadataByPage,
        recommendedOutputModeByPage: detection.recommendedOutputModeByPage,
        resolvedOptions,
        softAlphaForegroundRecommendationByPage:
            detection.softAlphaForegroundRecommendationByPage,
        settings: settings.values,
        sourcePath,
        totalPages,
        waitForDetectionBeforeRun: detection.waitForTerminal,
    });
    // The final renderer reports a source page only after every output leaf
    // for that page has been published. Use that same durable boundary to
    // refresh a preview whose provisional document plan changed during
    // detection. The previous completed frame remains visible while this one
    // is built, and the retained raw-raster cache makes the refresh a single
    // preview sidecar pass rather than another PDF rasterization.
    const runPreviewRefreshPages = new Set<number>();
    watch(run.isRunning, (running, wasRunning) => {
        if (wasRunning && !running) {
            previewResult.schedule();
        }
    });
    watch([
        run.isRunning,
        selection.leader,
        () => run.processedPages.value.has(selection.leader.value),
    ], ([
        running,
        pageNumber,
        pageCompleted,
    ]) => {
        if (!running) {
            runPreviewRefreshPages.clear();
            return;
        }
        if (!pageCompleted || runPreviewRefreshPages.has(pageNumber)) {
            return;
        }
        runPreviewRefreshPages.add(pageNumber);
        if (!previewResult.resultCurrent.value) {
            previewResult.schedule();
        }
    });
    // Preview has its own immediate activity watcher. Detection is a main-side
    // job, so ordinarily cancel it and wait for its terminal snapshot when the
    // tab becomes inactive. Once Clean Up owns that pass, however, detection is
    // part of the user's engaged run: keep it alive across tab switches so the
    // run can start instead of misreporting its deliberate cancellation as
    // missing evidence. If an ordinary hidden tab returns while cancellation
    // is crossing the bridge, resume only after that old job has settled.
    watch(options.active, active => {
        if (active || run.waitingForDetection.value) {
            return;
        }
        void detection.cancelAndWaitForTerminal()
            .catch(() => undefined)
            .then(() => {
                if (options.active()) {
                    void detection.maybeAutoDetect();
                }
            });
    });

    return {
        selection,
        settings,
        detection,
        preview: previewResult,
        run: {
            ...run,
            ownerId,
        },
    };
};
