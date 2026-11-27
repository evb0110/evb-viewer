import type {TDocumentRef} from '@contracts/documentRef';
import type {TScanCleanupPageOutputMapping} from '@contracts/scan-cleanup/domain';
import {
    type TScanCleanupPlacementAnchorsByPage,
    resolveScanCleanupDocumentInkAnchors,
} from '@evb/scan-cleanup/core/policy/scanCleanupPagePolicy';
import {
    isScanCleanupSourceSha256,toPlainScanCleanupOptions,
} from '@contracts/scan-cleanup/scanCleanupSettings';
import {isScanCleanupRunning} from '@app/modules/scan-cleanup/runtime/scanCleanupRunCoordinator';
import {useScanCleanupSelection} from '@app/modules/scan-cleanup/composables/useScanCleanupSelection';
import {useScanCleanupDocumentSettings} from '@app/modules/scan-cleanup/composables/useScanCleanupDocumentSettings';
import {useScanCleanupDetectionSession} from '@app/modules/scan-cleanup/composables/useScanCleanupDetectionSession';
import {useScanCleanupPreviewSession} from '@app/modules/scan-cleanup/composables/useScanCleanupPreviewSession';
import {useScanCleanupRunSession} from '@app/modules/scan-cleanup/composables/useScanCleanupRunSession';
import {useScanCleanupActivityTimeline} from '@app/modules/scan-cleanup/composables/useScanCleanupActivityTimeline';
import {resolveScanCleanupActivity} from '@app/modules/scan-cleanup/runtime/resolveScanCleanupActivity';
import type {IScanCleanupTabSessionState} from '@app/modules/workspace-shell/public';

interface IUseScanCleanupWorkspaceSessionOptions {
    active: () => boolean;
    sourcePath: () => TDocumentRef | null;
    documentKey: () => string | null;
    /** The logical document: a restore keeps it, an open of another document does not. */
    documentSessionKey?: () => string | null;
    sourceSha256?: () => string | null;
    documentRevision?: () => string | null;
    ownerId?: () => string | undefined;
    currentPage: () => number;
    totalPages: () => number;
    initialPreviewPage?: () => number | undefined;
    initialPreviewViewMode?: () => 'original' | 'cleaned' | undefined;
    pageMapping?: () => TScanCleanupPageOutputMapping | null | undefined;
    /** The tab's view-state command: it owns the preview page and mode across activations. */
    saveViewState?: (state: IScanCleanupTabSessionState) => void;
}

export const useScanCleanupWorkspaceSession = (options: IUseScanCleanupWorkspaceSessionOptions) => {
    const initialPreviewPage = Math.max(1, Math.trunc(options.initialPreviewPage?.() ?? options.currentPage()));
    const initialPreviewViewMode = options.initialPreviewViewMode?.() ?? 'cleaned';
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
        active: options.active,
        documentRevision,
        documentLifecycleKey: lifecycleDocumentKey,
        sourceSha256,
        legacyDocumentKey,
    });
    const resolvedOptions = computed(() => toPlainScanCleanupOptions(settings.values));
    let previewResult = null as ReturnType<typeof useScanCleanupPreviewSession> | null;
    const selection = useScanCleanupSelection({
        initialPage: initialPreviewPage,
        previewTotalPages: () => previewResult?.totalPages.value ?? Math.max(1, totalPages.value),
        marginsLinked: settings.marginsLinked,
        editDocumentSettings: settings.editDocumentSettings,
        updateDocumentMargin: settings.updateMargin,
        setDocumentMarginsLinked: settings.setMarginsLinked,
        resetPageOverrides: settings.resetPageOverrides,
        settings: settings.values,
        saveLeader: () => saveViewState(),
    });
    // Writes this view to the tab. A replacement's page mapping stays until
    // the one replacement it was written for consumes it.
    function saveViewState(pageMapping = options.pageMapping?.()) {
        options.saveViewState?.({
            ownerId,
            previewPage: selection.leader.value,
            previewViewMode: previewResult?.viewMode.value ?? initialPreviewViewMode,
            ...(pageMapping ? {pageMapping} : {}),
        });
    }
    const documentIdentity = computed(() => `${options.documentSessionKey?.() ?? sourcePath.value ?? ''}\u0000${documentRevision.value}`);
    // One transition for the selection: coming on screen restarts it at its
    // leader, a replaced document maps it through the replacement's page
    // mapping, and a changed page count keeps it in range.
    watch([
        options.active,
        documentIdentity,
        totalPages,
    ], ([
        active,
        identity,
        pageCount,
    ], previous) => {
        // No count yet (a document still loading) is not a count of no pages: the last one stands.
        const countedPages = pageCount > 0 ? pageCount : previous?.[2] ?? 0;
        const normalizedPageCount = Math.max(1, Math.trunc(countedPages));
        // A retained page stands until the viewer or a preview has counted the pages.
        const knownPageCount = previewResult?.rawResult.value?.totalPages ?? previewResult?.result.value?.totalPages ?? (countedPages > 0 ? normalizedPageCount : null);
        if (active && !previous?.[0] && knownPageCount !== null) selection.resetToLeader(knownPageCount);
        if (!previous?.length) return;
        if (identity !== previous[1]) {
            const pageMapping = options.pageMapping?.();
            selection.reconcileDocumentReplacement({
                defaultPage: options.currentPage(),
                pageCount: normalizedPageCount,
                ...(pageMapping === undefined ? {} : {pageMapping}),
            });
            saveViewState(null);
        } else if (pageCount > 0 && pageCount !== previous[2]) {
            selection.reconcilePageCount(normalizedPageCount, options.currentPage());
        }
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
    const placementAnchorsByPage = computed<TScanCleanupPlacementAnchorsByPage>(() => (
        resolveScanCleanupDocumentInkAnchors(resolvedOptions.value, detection.inkSheets.value)
    ));
    previewResult = useScanCleanupPreviewSession({
        active: options.active,
        authoritativeLayoutByPage: detection.authoritativeLayoutByPage,
        documentCanvasSignature: detection.documentCanvasSignature,
        getPreviewPageEvidence: detection.getPreviewPageEvidence,
        documentRevision,
        initialViewMode: initialPreviewViewMode,
        layoutDetectionComplete: detection.layoutDetectionComplete,
        lifecycleDocumentKey,
        ownerId,
        detectionResultStoreId: detection.detectionResultStoreId,
        placementAnchorSummary: detection.placementAnchorSummary,
        placementAnchorCalibrationPending: detection.placementAnchorCalibrationPending,
        placementAnchorsByPage,
        resolvePlacementAnchorsForPage: detection.resolvePlacementAnchorsForPage,
        previewPage: selection.leader,
        resolvedOptions,
        selectPage: selection.selectPage,
        settings: settings.values,
        sourceSha256,
        sourcePath,
        totalPages,
    });
    const run = useScanCleanupRunSession({
        active: options.active,
        beforeRun: () => {
            previewResult.pauseForRun();
        },
        detectionError: detection.error,
        detectionErrorCode: detection.errorCode,
        detectionEvidenceComplete: detection.detectionEvidenceComplete,
        detectionResultStoreId: detection.detectionResultStoreId,
        placementAnchorSummary: detection.placementAnchorSummary,
        placementAnchorCalibrationPending: detection.placementAnchorCalibrationPending,
        placementAnchorCalibrationError: detection.placementAnchorCalibrationError,
        detectionPending: detection.pending,
        detectionStatus: detection.terminalStatus,
        documentSettingsReady: computed(() => settings.documentSettingsReady.value),
        documentRevision,
        ownerId,
        placementAnchorsByPage,
        previewTotalPages: () => previewResult.totalPages.value,
        resolveConversionEvidence: detection.resolveConversionEvidence,
        sourcePageNumbers: computed(() => {
            if (selection.settingsScope.value === 'all') {
                return null;
            }
            if (selection.settingsScope.value === 'page') {
                return [selection.leader.value];
            }
            return [...selection.selectedPages.value].sort((left, right) => left - right);
        }),
        resolvedOptions,
        settings: settings.values,
        sourcePath,
        totalPages,
        refreshDetection: detection.refreshDetection,
        waitForDetectionBeforeRun: detection.waitForTerminal,
    });
    // The final renderer reports a source page only after every output leaf
    // for that page has been published. Use that same durable boundary to
    // refresh a preview whose provisional document plan changed during
    // detection. The previous completed frame remains visible while this one
    // is built, and the retained raw-raster cache makes the refresh a single
    // preview sidecar pass rather than another PDF rasterization.
    const runPreviewRefreshPages = new Set<number>();
    watch([
        run.isRunning,
        selection.leader,
        () => run.processedPages.value.has(selection.leader.value),
    ], ([
        running,
        pageNumber,
        pageCompleted,
    ], [wasRunning]) => {
        if (!running) {
            runPreviewRefreshPages.clear();
            if (wasRunning) {
                previewResult.schedule();
            }
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

    const activity = computed(() => resolveScanCleanupActivity({
        detection: {
            pending: detection.pending.value,
            progress: detection.jobProgress.value,
            analyzedPages: detection.analyzedPages.value,
            totalPages: totalPages.value,
            calibrating: detection.placementAnchorCalibrationPending.value,
        },
        run: run.isRunning.value
            ? {
                waitingForDetection: run.waitingForDetection.value,
                starting: run.starting.value,
                progress: run.jobProgress.value,
                committing: run.finishing.value,
            }
            : null,
    }));
    const activityTimeline = useScanCleanupActivityTimeline(activity);
    const preview = {
        ...previewResult,
        viewMode: computed({
            get: () => previewResult.viewMode.value,
            set: (viewMode: 'original' | 'cleaned') => {
                previewResult.viewMode.value = viewMode;
                saveViewState();
            },
        }),
    };
    saveViewState();

    return {
        selection,
        settings,
        detection,
        preview,
        run: {
            ...run,
            ownerId,
        },
        activity,
        activityTimeline,
    };
};
