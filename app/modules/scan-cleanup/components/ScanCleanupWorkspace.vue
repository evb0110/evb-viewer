<template>
    <Teleport
        v-if="toolbarActive"
        to="#editor-global-toolbar-host"
        :disabled="!canTeleportToolbar"
    >
        <ScanCleanupToolbar
            :activity="activity"
            :activity-timeline="activityTimeline"
            :can-run="canRun"
            :cancel-requested="cancelRequested"
            :cancel-status-text="cancelStatusText"
            :detection-cancel-requested="detectionCancelRequested"
            :detection-error="detectionError"
            :run-error="runError"
            :is-detecting="detectionPending"
            :finishing="finishing"
            :is-running="isRunning"
            :output-estimate="outputEstimate"
            :run-label="runLabel"
            :run-disabled-reason="runDisabledReason"
            @cancel="cancel"
            @cancel-detection="cancelDetection"
            @dismiss-run-error="dismissRunError"
            @done="done"
            @run="run"
        />
    </Teleport>
    <section
        class="scan-cleanup-surface"
        :aria-label="t('scanCleanup.workspaceTitle')"
        :data-detection-status="detectionTerminalStatus ?? (detectionPending ? 'pending' : 'idle')"
    >
        <div
            class="scan-cleanup-workspace app-scrollbar app-scroll-region--balanced"
            :aria-busy="isRunning"
        >
            <fieldset
                class="scan-cleanup-options-rail app-scrollbar app-scroll-region--balanced"
                :disabled="isRunning"
            >
                <ScanCleanupSettingsPanel
                    :alignment-items="alignmentItems"
                    :apply-scope-items="applyScopeItems"
                    :blank-page-count="blankPageCount"
                    :can-run-selection="canRunSelection"
                    :changed-settings="changedSettings"
                    :content-boxes="scopeContentBoxes"
                    :excluded="scopeExcluded"
                    :has-document-overrides="hasDocumentOverrides"
                    :has-page-overrides="hasPageTabOverrides"
                    :layout="scopeLayout"
                    :layout-items="scopeLayoutItems"
                    :manual-split="scopeManualSplit"
                    :manual-skew="scopeManualSkew"
                    :detected-skew-degrees="scopeDetectedSkewDegrees"
                    :margins="scopeMargins"
                    :margins-linked="scopeMarginsLinked"
                    :output-items="outputItems"
                    :output-mode-override="scopeOutputModeOverride"
                    :output-mode-override-items="scopeOutputModeOverrideItems"
                    :override-counts="scopeOverrideCounts"
                    :page-facts="pageFacts"
                    :page-number="selectionLeader"
                    :placement-alignment="scopePlacementAlignment"
                    :reading-order-items="readingOrderItems"
                    :rotation="scopeRotation"
                    :rotation-items="scopeRotationItems"
                    :selected-count="selectedPages.size"
                    :selection-run-disabled-reason="selectionRunDisabledReason"
                    :selection-run-label="selectionRunLabel"
                    :settings="settings"
                    :show-reading-order="showReadingOrder"
                    :tab="settingsTab"
                    :thickness-label="thicknessLabel"
                    :total-pages="previewTotalPages"
                    @reset-content-boxes="resetScopeContentBoxes"
                    @reset-control-override="resetControlOverride"
                    @reset-manual-split="resetScopeManualSplit"
                    @reset-manual-skew="resetScopeManualSkew"
                    @reset-page-overrides="resetPageTabOverrides"
                    @reset-settings="resetSettingsToDefaults"
                    @margin-interaction="marginBoundaryVisible = $event"
                    @run-selection="runSelection"
                    @thickness-input="handleThicknessInput"
                    @update-document-output="updateDocumentOutput"
                    @update-inclusion="handleScopeInclusion"
                    @update-layout="handleScopeLayout"
                    @update-margin="updateScopeMargins"
                    @update-manual-skew="updateScopeManualSkew"
                    @update-output-mode="handleScopeOutputMode"
                    @update:margins-linked="setScopeMarginsLinked"
                    @update-placement="updateScopePlacement"
                    @update-rotation="handleScopeRotation"
                    @update-setting="updateDocumentSetting"
                    @update:tab="setSettingsTab"
                />
            </fieldset>

            <ScanCleanupThumbnailRail
                :active="workspaceActive"
                :source="pageSource"
                :source-pending="pageSourcePending"
                :total-pages="previewTotalPages"
                :selection-leader="selectionLeader"
                :selected-pages="selectedPages"
                :overrides="settings.pageOverrides"
                :page-override-defaults="settings.pageOverrideDefaults"
                :margins-mm="settings.marginsMm"
                :classifications="authoritativeLayoutByPage"
                :confidences="detectedLayoutConfidenceByPage"
                :document-output-mode="settings.outputMode"
                :preserve-original-quality="settings.preserveOriginalQuality === true"
                :recommended-output-modes="recommendedOutputModeByPage"
                :text-axes="detectedTextAxisByPage"
                :disabled="isRunning"
                :can-redetect="canDetectAll && !detectionPending"
                :processed-pages="processedPages"
                :active-pages="activePages"
                :detection-active="detectionPending"
                :settled-pages="detectionSettledPages"
                @inspect-page="inspectPage"
                @redetect="detectAllPages"
                @select-page="selectPage"
                @update:override="updatePageOverride"
            />

            <div class="scan-cleanup-preview-hero">
                <ScanCleanupPreviewPane
                    ref="previewPane"
                    :result="previewResult"
                    :result-current="previewResultCurrent"
                    :result-presentation-key="previewResultPresentationKey"
                    :detail-result="previewDetailResult"
                    :raw-result="previewRawResult"
                    :loading="previewLoading"
                    :error="previewError"
                    :source="pageSource"
                    :layout-classification="authoritativeLayoutByPage.get(previewPage)"
                    :layout-detection-complete="layoutDetectionComplete"
                    :rotation-degrees="currentPageOverride.rotationDegrees"
                    :view-mode="previewViewMode"
                    :match-page-size="settings.matchPageSize"
                    :alignment="settings.pageAlignment"
                    :page-number="previewPage"
                    :total-pages="previewTotalPages"
                    :show-margin-boundary="marginBoundaryVisible"
                    :manual-split="currentPageOverride.manualSplit"
                    :reading-order="settings.readingOrder"
                    :manual-content-boxes="currentPageOverride.manualContentBoxes ?? {}"
                    :manual-zones="currentPageOverride.manualZones"
                    :output-mode="previewOutputMode"
                    :placement-overrides="currentPageOverride.placementOverrides ?? {}"
                    :lossless="settings.preserveOriginalQuality === true"
                    :show-first-run-guidance="showFirstRunGuidance"
                    :zone-editing="zoneEditing"
                    :disabled="isRunning"
                    :activity="activity"
                    :activity-timeline="activityTimeline"
                    @previous="navigatePreview(-1)"
                    @next="navigatePreview(1)"
                    @retry="retryPreview"
                    @invalidate-detail="clearPreviewDetail"
                    @request-detail="requestPreviewDetail"
                    @update:view-mode="previewViewMode = $event"
                    @update:zone-editing="zoneEditing = $event"
                    @update:manual-split="updateCurrentManualSplit"
                    @update:manual-content-box="updateCurrentManualContentBox"
                    @update:manual-zones="updateCurrentManualZones"
                    @update:placement="updateCurrentPlacement"
                    @use-mixed-output="useMixedOutput"
                    @dismiss-first-run-guidance="dismissFirstRunGuidance"
                />
            </div>
        </div>
    </section>
</template>

<script setup lang="ts">
import {whenever} from '@vueuse/core';
import {useFailureToast} from '@app/composables/useFailureToast';
import {BrowserLogger} from '@app/utils/browserLogger';
import type {TDocumentRef} from '@contracts/documentRef';
import {requirePageNumber} from '@contracts/pageNumbers';
import type {
    IScanCleanupOptions,
    TScanCleanupOutputMode,
    TScanCleanupPageLayoutOverride,
    TScanCleanupPageRotation,
} from '@contracts/scan-cleanup/electronApiScanCleanup';
import {resolveScanCleanupEffectiveOutputMode} from '@contracts/scan-cleanup/electronApiScanCleanup';
import {
    resetScanCleanupOptionsToDefaults,
    resolveScanCleanupNonDefaultSettings,
} from '@app/modules/scan-cleanup/runtime/scanCleanupSettingsBadges';
import {formatScanCleanupSettingsBadge} from '@app/modules/scan-cleanup/runtime/formatScanCleanupSettingsBadge';
import {
    areScanCleanupMarginsMmEqual,
    createScanCleanupPageOverride,
    DEFAULT_SCAN_CLEANUP_PAGE_OVERRIDE,
    getScanCleanupPageOverride,
    isDefaultScanCleanupPageOverride,
} from '@contracts/scan-cleanup/scanCleanupPageOverrides';
import {
    resolveScanCleanupMarginsMm,
    resolveScanCleanupOutputPlacement,
    resolveScanCleanupPageLayout,
} from '@evb/scan-cleanup/core/policy/scanCleanupPagePolicy';
import type {IDocumentPageSource} from '@app/modules/document-viewer/public';
import type {IScanCleanupTabSessionState} from '@app/modules/workspace-shell/public';
import ScanCleanupPreviewPane from '@app/modules/scan-cleanup/components/preview/PreviewShell.vue';
import ScanCleanupThumbnailRail from '@app/modules/scan-cleanup/components/ScanCleanupThumbnailRail.vue';
import ScanCleanupToolbar from '@app/modules/scan-cleanup/components/ScanCleanupToolbar.vue';
import ScanCleanupSettingsPanel from '@app/modules/scan-cleanup/components/settings/ScanCleanupSettingsPanel.vue';
import {useScanCleanupWorkspaceSession} from '@app/modules/scan-cleanup/composables/useScanCleanupWorkspaceSession';
import {scanCleanupOutputModeLabel, type IScanCleanupPageFacts} from '@app/modules/scan-cleanup/runtime/describeScanCleanupPage';
import {
    resolveScanCleanupMixedValue,
    updateScanCleanupPageOverrideRotation,
} from '@app/modules/scan-cleanup/runtime/scanCleanupSelectionOverrides';

const {t} = useTypedI18n();
const {
    sourcePath,
    currentPage = 1,
    totalPages = 1,
    documentKey = null,
    documentSessionKey = null,
    documentRevision = null,
    sourceSha256 = null,
    pageSource = null,
    pageSourcePending = false,
    sessionState = null,
    toolbarActive = true,
    canTeleportToolbar = false,
} = defineProps<{
    sourcePath: TDocumentRef | null;
    currentPage?: number;
    totalPages?: number;
    documentKey?: string | null;
    documentSessionKey?: string | null;
    documentRevision?: string | null;
    sourceSha256?: string | null;
    pageSource?: IDocumentPageSource | null;
    pageSourcePending?: boolean;
    sessionState?: IScanCleanupTabSessionState | null;
    toolbarActive?: boolean;
    canTeleportToolbar?: boolean;
}>();
const emit = defineEmits<{
    done: [];
    ready: [];
    'update:session-state': [state: IScanCleanupTabSessionState];
}>();
onMounted(() => emit('ready'));
// Inactive tabs stay mounted so their settings, selection, owner id, and
// acquired source hash survive a round trip. Heavy preview/detection work does
// not: toolbar ownership is the shell's existing signal that this workspace is
// the visible tab.
const workspaceActive = computed(() => sourcePath !== null && toolbarActive);
const previewPane = ref<{scheduleDetailRequest: () => void} | null>(null);
const workspaceSession = useScanCleanupWorkspaceSession({
    // Losing the source ends the session: detection and preview cancel instead
    // of queueing IPC against a working copy the main process has already
    // retired. Switching tabs pauses that work without changing identity.
    active: () => workspaceActive.value,
    sourcePath: () => sourcePath,
    documentKey: () => documentKey,
    documentSessionKey: () => documentSessionKey,
    documentRevision: () => documentRevision,
    pageMapping: () => sessionState?.pageMapping,
    sourceSha256: () => sourceSha256,
    ownerId: () => sessionState?.ownerId,
    currentPage: () => currentPage,
    totalPages: () => totalPages,
    initialPreviewPage: () => sessionState?.previewPage,
    initialPreviewViewMode: () => sessionState?.previewViewMode,
    saveViewState: (state) => emit('update:session-state', state),
});
const {
    alignmentItems,
    documentSettingsLoadFailure,
    handleThicknessInput,
    layoutItems,
    marginsLinked: documentMarginsLinked,
    outputItems,
    readingOrderItems,
    resetPageOverrides,
    showFirstRunGuidance,
    dismissFirstRunGuidance,
    thicknessLabel,
    values: settings,
    editDocumentSettings,
} = workspaceSession.settings;
const {presentFailureToast, presentNoticeToast} = useFailureToast();
let toldSettingsLoadFailure: typeof documentSettingsLoadFailure.value = null;
// Settings that did not load are told once, with Retry, when this workspace
// is the one on screen; the rail keeps its defaults meanwhile.
watch(
    [documentSettingsLoadFailure, () => workspaceActive.value],
    ([failure, active]) => {
        if (failure && active && failure !== toldSettingsLoadFailure) {
            toldSettingsLoadFailure = failure;
            presentFailureToast(failure);
        }
    },
    {immediate: true},
);
const {
    applyLeaderOverrides,
    currentPageOverride,
    inspectPage: inspectSelectionPage,
    leader: selectionLeader,
    pageTabPageNumbers,
    resetControlOverride,
    resetPageTabOverrides,
    selectedPages,
    selectPage,
    setMarginsLinked: setScopeMarginsLinked,
    setSettingsTab,
    settingsTab,
    updateCurrentManualContentBox,
    updateCurrentManualSplit,
    updateCurrentManualZones,
    updateCurrentPlacement,
    updatePageOverride,
    updateScopeLayout,
    updateScopeMargins,
    updateScopeOverrides,
    updateScopePlacement,
} = workspaceSession.selection;
const previewPage = selectionLeader;
const {
    activePages: detectionActivePages,
    authoritativeLayoutByPage,
    blankPageCount,
    canDetectAll,
    cancel: cancelDetection,
    cancelRequested: detectionCancelRequested,
    confidenceByPage: detectedLayoutConfidenceByPage,
    detectAllPages,
    detectionResultStoreId,
    error: detectionError,
    errorCode: detectionErrorCode,
    layoutDetectionComplete,
    outputEstimate,
    pending: detectionPending,
    terminalStatus: detectionTerminalStatus,
    settledPages: detectionSettledPages,
    recommendedOutputModeByPage,
    recommendedOutputModeConfidenceByPage,
    recommendedOutputModeReasonByPage,
    textAxisByPage: detectedTextAxisByPage,
} = workspaceSession.detection;
const {
    clearDetail: clearPreviewDetail,
    error: previewError,
    detailError: previewDetailError,
    detailResult: previewDetailResult,
    loading: previewLoading,
    metadataByPage: previewMetadataByPage,
    navigate: navigatePreview,
    result: previewResult,
    rawResult: previewRawResult,
    resultCurrent: previewResultCurrent,
    resultPresentationKey: previewResultPresentationKey,
    retry: retryPreview,
    requestDetail: requestPreviewDetail,
    totalPages: previewTotalPages,
    viewMode: previewViewMode,
} = workspaceSession.preview;
const {
    activePages: runActivePages,
    cancel,
    cancelRequested,
    cancelStatusText,
    canRun,
    canRunSelection,
    dismissError: dismissRunError,
    error: runError,
    finishing,
    isRunning,
    processedPages,
    runLabel,
    runDisabledReason,
    run,
    runSelection,
    selectionRunDisabledReason,
    selectionRunLabel,
    waitingForDetection,
} = workspaceSession.run;
// A failed analysis is told once, when this workspace is the one on screen: an
// expected refusal as a warning, a defect with its Error ID. The toolbar keeps
// the reason on its status line meanwhile.
const EXPECTED_DETECTION_REFUSALS = new Set(['insufficient-scratch', 'encrypted', 'needs-password', 'too-large', 'source-missing']);
let toldDetectionError = '';
watch(
    [detectionError, () => workspaceActive.value],
    ([message, active]) => {
        if (message === '') {
            toldDetectionError = '';
            return;
        }
        if (message === toldDetectionError) {
            return;
        }
        // A cleanup queued behind this analysis reports the failure as its own,
        // whether or not this workspace is on screen when it fails.
        if (isRunning.value) {
            toldDetectionError = message;
            return;
        }
        if (!active) {
            return;
        }
        toldDetectionError = message;
        if (EXPECTED_DETECTION_REFUSALS.has(detectionErrorCode.value ?? '')) {
            presentNoticeToast({
                tone: 'warning',
                title: t('scanCleanup.detectAll.failed'),
                description: message,
            });
            return;
        }
        presentFailureToast({
            failure: BrowserLogger.error('scan-cleanup', 'Scan cleanup page analysis failed', message, {
                code: 'RENDERER_SCAN_CLEANUP_OPERATION_FAILED',
            }),
            title: t('scanCleanup.detectAll.failed'),
            description: message,
        });
    },
    {immediate: true},
);
// A failed detail tile leaves the cleaned base on screen and usable, so it is
// told once as a toast, not inside the preview. A newer demand, a rendered
// tile or a closed source clears the failure and with it its toast, so fast
// scrolling cannot stack them. Retry asks for the viewport on screen now.
const toast = useToast();
let toldDetailFailureId: string | null = null;
function dismissDetailFailure() {
    if (toldDetailFailureId !== null) {
        toast.remove(toldDetailFailureId);
    }
    toldDetailFailureId = null;
}
watch(previewDetailError, (failure) => {
    dismissDetailFailure();
    if (!failure) {
        return;
    }
    const told = {
        title: t('scanCleanup.preview.detailUnavailable'),
        description: failure.message,
        actions: [
            {
                label: t('scanCleanup.preview.retry'),
                color: 'neutral' as const,
                variant: 'outline' as const,
                onClick: () => previewPane.value?.scheduleDetailRequest(),
            },
        ],
    };
    if (EXPECTED_DETECTION_REFUSALS.has(failure.code)) {
        toldDetailFailureId = `scan-cleanup-detail-failure:${sourcePath}`;
        presentNoticeToast({
            ...told,
            id: toldDetailFailureId,
            tone: 'warning',
        });
        return;
    }
    const receipt = BrowserLogger.error('scan-cleanup', 'Scan cleanup detail preview failed', failure.message, {
        code: 'RENDERER_SCAN_CLEANUP_OPERATION_FAILED',
    });
    toldDetailFailureId = receipt.eventId;
    presentFailureToast({
        ...told,
        failure: receipt,
    });
});
onBeforeUnmount(dismissDetailFailure);
const marginBoundaryVisible = ref(false);
const {activity, activityTimeline} = workspaceSession;
const activePages = computed<ReadonlySet<number>>(() =>
    isRunning.value && !waitingForDetection.value ? runActivePages.value : detectionActivePages.value,
);
// Settings persist from one document to the next, so the rail names the ones
// that differ from the defaults where they can be reset in one click.
const changedSettings = computed(() =>
    resolveScanCleanupNonDefaultSettings(settings).map((setting) => formatScanCleanupSettingsBadge(t, setting.key, setting.value)),
);
const zoneEditing = ref(false);

const allScopeDefaultOverride = computed(() => settings.pageOverrideDefaults ?? createScanCleanupPageOverride());

function resetSettingsToDefaults() {
    if (isRunning.value) {
        return;
    }
    resetPageOverrides();
    editDocumentSettings([], () => resetScanCleanupOptionsToDefaults(settings));
}

// The Document tab edits the values pages inherit, so only the Pages tab has
// pages of its own to read and mark.
const documentTab = computed(() => settingsTab.value === 'document');
const singlePageTab = computed(() => !documentTab.value && selectedPages.value.size < 2);
const scopePageNumbers = computed<readonly number[]>(() => (documentTab.value ? [] : pageTabPageNumbers.value));
function getPageOverride(page: number) {
    return getScanCleanupPageOverride(settings.pageOverrides, requirePageNumber(page), settings.pageOverrideDefaults, settings.marginsMm);
}
function existingOverridePages() {
    return Object.keys(settings.pageOverrides)
        .map(Number)
        .filter((page) => Number.isSafeInteger(page) && page >= 1 && page <= previewTotalPages.value);
}

const scopePageOverrides = computed(() => scopePageNumbers.value.map((page) => getPageOverride(page)));

function resolveAllPageOverrideValue<T>(defaultValue: T, read: (override: ReturnType<typeof getScanCleanupPageOverride>) => T) {
    const values = [settings.pageOverrideDefaults === undefined ? defaultValue : read(allScopeDefaultOverride.value)];
    for (const page of existingOverridePages()) {
        values.push(read(getPageOverride(page)));
    }
    return resolveScanCleanupMixedValue(values);
}
const scopeLayout = computed(() =>
    documentTab.value
        ? resolveScanCleanupMixedValue([settings.layoutMode])
        : resolveScanCleanupMixedValue(scopePageOverrides.value.map((override) => override.layoutOverride)),
);
const scopeRotation = computed(() =>
    documentTab.value
        ? resolveScanCleanupMixedValue([allScopeDefaultOverride.value.rotationDegrees])
        : resolveScanCleanupMixedValue(scopePageOverrides.value.map((override) => override.rotationDegrees)),
);
// A page whose mode matches the one pages inherit, which a copy to all pages
// may have set, follows the document; only a different mode is its own.
const scopeOutputModeOverride = computed(() => {
    if (documentTab.value) {
        return resolveAllPageOverrideValue(undefined, (override) => override.outputModeOverride);
    }
    const inherited = allScopeDefaultOverride.value.outputModeOverride;
    return resolveScanCleanupMixedValue(
        scopePageOverrides.value.map((override) => (override.outputModeOverride === inherited ? undefined : override.outputModeOverride)),
    );
});
const scopeExcluded = computed(() =>
    documentTab.value
        ? resolveScanCleanupMixedValue([allScopeDefaultOverride.value.excluded])
        : resolveScanCleanupMixedValue(scopePageOverrides.value.map((override) => override.excluded)),
);
const scopeManualSplit = computed(() =>
    documentTab.value
        ? resolveAllPageOverrideValue(null, (override) => override.manualSplit)
        : resolveScanCleanupMixedValue(scopePageOverrides.value.map((override) => override.manualSplit)),
);
const scopeManualSkew = computed(() =>
    documentTab.value
        ? resolveAllPageOverrideValue(undefined, (override) => override.manualSkewDegrees)
        : resolveScanCleanupMixedValue(scopePageOverrides.value.map((override) => override.manualSkewDegrees)),
);
// A preview rendered with a manual angle reports that angle as detected, so it
// cannot seed the stepper after the page returns to Automatic.
const scopeDetectedSkewDegrees = computed(() => {
    const metadata = singlePageTab.value ? previewMetadataByPage.get(selectionLeader.value) : undefined;
    return metadata && metadata.manualSkew !== true ? metadata.detectedSkewDegrees : undefined;
});
const scopeContentBoxes = computed(() =>
    documentTab.value
        ? resolveAllPageOverrideValue({}, (override) => override.manualContentBoxes ?? {})
        : resolveScanCleanupMixedValue(scopePageOverrides.value.map((override) => override.manualContentBoxes ?? {})),
);
const scopeMargins = computed(() =>
    documentTab.value
        ? resolveScanCleanupMixedValue([resolveScanCleanupMarginsMm(settings.marginsMm, allScopeDefaultOverride.value)])
        : resolveScanCleanupMixedValue(
              scopePageOverrides.value.map((override) => resolveScanCleanupMarginsMm(settings.marginsMm, override)),
          ),
);
const scopePlacementAlignment = computed(() =>
    documentTab.value
        ? resolveScanCleanupMixedValue(
              (['full', 'left', 'right'] as const).map((half) =>
                  resolveScanCleanupOutputPlacement(settings.pageAlignment, allScopeDefaultOverride.value, half),
              ),
          )
        : resolveScanCleanupMixedValue(
              scopePageOverrides.value.flatMap((override) =>
                  (['full', 'left', 'right'] as const).map((half) =>
                      resolveScanCleanupOutputPlacement(settings.pageAlignment, override, half),
                  ),
              ),
          ),
);
const scopeMarginsLinked = computed(() => documentMarginsLinked.value);
// Only the Pages tab marks a control as overridden: the Document tab edits the
// defaults that every page without its own setting follows.
const scopeOverrideCounts = computed(() => {
    const counts = {
        inclusion: 0,
        layout: 0,
        margins: 0,
        outputMode: 0,
        placement: 0,
        rotation: 0,
    };
    if (documentTab.value) {
        return counts;
    }
    const documentRotation = allScopeDefaultOverride.value.rotationDegrees;
    const pages = scopePageNumbers.value;
    for (const page of pages) {
        if (!Number.isSafeInteger(page) || page < 1 || page > previewTotalPages.value) {
            continue;
        }
        const override = getPageOverride(page);
        if (resolveScanCleanupPageLayout(settings.layoutMode, override.layoutOverride) !== settings.layoutMode) {
            counts.layout += 1;
        }
        if (override.rotationDegrees !== documentRotation) {
            counts.rotation += 1;
        }
        if (override.outputModeOverride !== allScopeDefaultOverride.value.outputModeOverride) {
            counts.outputMode += 1;
        }
        if (override.excluded !== DEFAULT_SCAN_CLEANUP_PAGE_OVERRIDE.excluded) {
            counts.inclusion += 1;
        }
        if (override.marginsMm && !areScanCleanupMarginsMmEqual(override.marginsMm, settings.marginsMm)) {
            counts.margins += 1;
        }
        if (Object.values(override.placementOverrides ?? {}).some((alignment) => alignment !== settings.pageAlignment)) {
            counts.placement += 1;
        }
    }
    return counts;
});
const hasDocumentOverrides = computed(
    () => Object.keys(settings.pageOverrides).length > 0 || !isDefaultScanCleanupPageOverride(allScopeDefaultOverride.value),
);
const hasPageTabOverrides = computed(() => pageTabPageNumbers.value.some((page) => settings.pageOverrides[String(page)] !== undefined));
// Reading order only decides which half of a cut page comes first, so it shows
// once a page is, or may be, cut into two: by the layout settings, a manual
// cutter, or detection. A large document's detection keeps only a bounded
// window of verdicts, so pages it has not reported may be spreads when they
// inherit Auto or were set back to Auto on their own.
const showReadingOrder = computed(() => {
    if (settings.layoutMode === 'force-two-page' || settings.pageOverrideDefaults?.layoutOverride === 'spread') {
        return true;
    }
    if (Object.values(settings.pageOverrides).some((override) => override.layoutOverride === 'spread' || override.manualSplit !== null)) {
        return true;
    }
    const layoutByPage = authoritativeLayoutByPage.value;
    for (const classification of layoutByPage.values()) {
        if (classification === 'two-page-spread') {
            return true;
        }
    }
    if (settings.layoutMode !== 'auto' || detectionResultStoreId.value === null || layoutByPage.size >= previewTotalPages.value) {
        return false;
    }
    return (
        (settings.pageOverrideDefaults?.layoutOverride ?? 'auto') === 'auto' ||
        existingOverridePages().some((page) => !layoutByPage.has(page) && settings.pageOverrides[String(page)]?.layoutOverride === 'auto')
    );
});
const scopeLayoutItems = computed(() =>
    documentTab.value
        ? layoutItems.value
        : [
              ...(scopeLayout.value.mixed
                  ? [
                        {
                            value: 'mixed' as const,
                            label: t('scanCleanup.settings.mixed'),
                            disabled: true,
                        },
                    ]
                  : []),
              {
                  value: 'auto' as const,
                  label: t('scanCleanup.pages.override.auto'),
              },
              {
                  value: 'single' as const,
                  label: t('scanCleanup.pages.override.single'),
              },
              {
                  value: 'spread' as const,
                  label: t('scanCleanup.pages.override.spread'),
              },
              {
                  value: 'keep-left' as const,
                  label: t('scanCleanup.pages.override.keepLeft'),
              },
              {
                  value: 'keep-right' as const,
                  label: t('scanCleanup.pages.override.keepRight'),
              },
          ],
);
const scopeRotationItems = computed(() => [
    ...(scopeRotation.value.mixed
        ? [
              {
                  value: 'mixed' as const,
                  label: t('scanCleanup.settings.mixed'),
                  disabled: true,
              },
          ]
        : []),
    ...([0, 90, 180, 270] as const).map((value) => ({
        value: String(value),
        label: t('scanCleanup.settings.rotationDegrees', {value}),
    })),
]);
// A single page names the mode it inherits, so "Follow document" says what it
// follows: the page defaults a copy to all pages set, else the document's
// mode. Several pages, or an Auto page detection has not decided yet, cannot
// name one, and an unresolved Auto is never presented as B&W.
const inheritedOutputMode = computed(() =>
    singlePageTab.value
        ? resolveScanCleanupEffectiveOutputMode({
              options: {
                  outputMode: settings.outputMode,
                  preserveOriginalQuality: false,
              },
              pageOverride: allScopeDefaultOverride.value,
              detectedOutputMode: recommendedOutputModeByPage.value.get(selectionLeader.value),
          })
        : undefined,
);
const scopeOutputModeOverrideItems = computed(() => [
    ...(scopeOutputModeOverride.value.mixed
        ? [
              {
                  value: 'mixed-values' as const,
                  label: t('scanCleanup.settings.mixed'),
                  disabled: true,
              },
          ]
        : []),
    {
        value: 'auto' as const,
        label:
            inheritedOutputMode.value === undefined
                ? t('scanCleanup.pages.outputModeFollowDocument')
                : t('scanCleanup.pages.outputModeFollowDocumentWithMode', {
                      mode: scanCleanupOutputModeLabel(t, inheritedOutputMode.value),
                  }),
    },
    {
        value: 'bw' as const,
        label: t('scanCleanup.output.bw'),
    },
    {
        value: 'grayscale' as const,
        label: t('scanCleanup.output.grayscale'),
    },
    {
        value: 'color' as const,
        label: t('scanCleanup.output.color'),
    },
    {
        value: 'mixed' as const,
        label: t('scanCleanup.output.mixed'),
    },
]);
const previewOutputMode = computed<TScanCleanupOutputMode | undefined>(() =>
    resolveScanCleanupEffectiveOutputMode({
        options: settings,
        pageOverride: currentPageOverride.value,
        detectedOutputMode: recommendedOutputModeByPage.value.get(previewPage.value),
        renderedOutputMode:
            previewResultCurrent.value && previewResult.value?.pageNumber === previewPage.value
                ? (previewResult.value.outputs[0]?.metadata.outputMode ?? previewResult.value.pageMetadata.recommendedOutputMode)
                : undefined,
    }),
);
const applyScopeItems = computed(() => {
    const actions = (
        [
            ['all', 'allPages'],
            ['from-here', 'fromHere'],
            ['every-other', 'everyOther'],
            ...(selectedPages.value.size >= 2 ? [['selected', 'selectedPages'] as const] : []),
        ] as const
    ).map(([scope, label]) => ({
        label: t(`scanCleanup.settings.applyScopes.${label}`),
        onSelect: () => applyLeaderOverrides(scope),
    }));
    return [
        {
            type: 'label' as const,
            label: t('scanCleanup.settings.applyScopes.menuLabel'),
        },
        ...actions,
    ];
});

function inspectPage(page: number) {
    if (!isRunning.value) {
        inspectSelectionPage(page);
    }
}

const pageFacts = computed<IScanCleanupPageFacts | null>(() => {
    if (!singlePageTab.value) {
        return null;
    }
    const page = selectionLeader.value;
    return {
        classification: authoritativeLayoutByPage.value.get(page),
        diagnostics: previewMetadataByPage.get(page),
        layoutConfidence: detectedLayoutConfidenceByPage.value.get(page),
        override: currentPageOverride.value,
        recommendedOutputMode: recommendedOutputModeByPage.value.get(page),
        recommendedOutputModeConfidence: recommendedOutputModeConfidenceByPage.value.get(page),
        recommendedOutputModeReason: recommendedOutputModeReasonByPage.value.get(page),
        textAxis: detectedTextAxisByPage.value.get(page),
    };
});

function done() {
    emit('done');
}

function updateDocumentSetting(key: keyof IScanCleanupOptions, value: IScanCleanupOptions[keyof IScanCleanupOptions]) {
    editDocumentSettings([], () => Object.assign(settings, {[key]: value}));
}

// Original images and a raster mode are one choice in the rail, stored as
// `preserveOriginalQuality` beside the raster mode it leaves untouched.
function updateDocumentOutput(value: string | number) {
    const output = String(value);
    if (output === 'original') {
        editDocumentSettings([], () => {
            settings.preserveOriginalQuality = true;
        });
        return;
    }
    if (outputItems.value.some((item) => item.value === output)) {
        editDocumentSettings([], () => {
            settings.preserveOriginalQuality = false;
            settings.outputMode = output as IScanCleanupOptions['outputMode'];
        });
    }
}

function useMixedOutput() {
    editDocumentSettings([], () => {
        settings.preserveOriginalQuality = false;
    });
    updatePageOverride(previewPage.value, {
        ...currentPageOverride.value,
        outputModeOverride: 'mixed',
    });
}

function handleScopeLayout(value: string | number) {
    const layout = String(value);
    if (documentTab.value) {
        updateScopeLayout(layout as IScanCleanupOptions['layoutMode']);
        return;
    }
    if (scopeLayoutItems.value.some((item) => item.value === layout && !('disabled' in item && item.disabled === true))) {
        updateScopeLayout(layout as TScanCleanupPageLayoutOverride);
    }
}

function handleScopeOutputMode(value: string | number) {
    const outputMode = String(value);
    // "Follow document" is the output reset: both return to the inherited mode.
    if (outputMode === 'auto') {
        resetControlOverride('output-mode');
        return;
    }
    if (['bw', 'mixed', 'grayscale', 'color'].includes(outputMode)) {
        updateScopeOverrides((current) => ({
            ...current,
            outputModeOverride: outputMode as TScanCleanupOutputMode,
        }));
    }
}

function handleScopeRotation(value: string | number) {
    const rotation = Number(value) as TScanCleanupPageRotation;
    if ([0, 90, 180, 270].includes(rotation)) {
        updateScopeOverrides((current) => updateScanCleanupPageOverrideRotation(current, rotation));
    }
}

function handleScopeInclusion(value: string | number) {
    if (value === 'included' || value === 'excluded') {
        const excluded = value === 'excluded';
        updateScopeOverrides((current) => ({
            ...current,
            excluded,
        }));
    }
}

function resetScopeManualSplit() {
    updateScopeOverrides((current) => ({
        ...current,
        manualSplit: null,
    }));
}

function resetScopeManualSkew() {
    updateScopeManualSkew(undefined);
}

function updateScopeManualSkew(value: number | undefined) {
    updateScopeOverrides((current) => ({
        ...current,
        ...(value === undefined ? {manualSkewDegrees: undefined} : {manualSkewDegrees: value}),
    }));
}

function resetScopeContentBoxes() {
    updateScopeOverrides((current) => ({
        ...current,
        manualContentBoxes: {},
    }));
}

whenever(isRunning, () => {
    zoneEditing.value = false;
    marginBoundaryVisible.value = false;
});
</script>

<style>
.scan-cleanup-surface {
    grid-area: 1 / 1;
    display: flex;
    min-width: 0;
    min-height: 0;
    flex: 1;
    flex-direction: column;
    background: var(--ui-bg);
    container-type: inline-size;
}

.scan-cleanup-workspace {
    display: grid;
    min-height: 0;
    flex: 1;
    grid-template:
        'thumbnails preview settings' minmax(0, 1fr) / minmax(var(--app-scan-page-list-collapsed-width), var(--app-scan-page-list-width))
        minmax(0, 1fr)
        var(--app-scan-dialog-rail-width);
    overflow: hidden;
}

/* Constrained widths (split panes, narrow windows): the side rails give way
   first so the center preview keeps a usable width while every control stays
   reachable through its rail's own scrolling. */
@container (width <= 72rem) {
    .scan-cleanup-workspace {
        grid-template:
            'thumbnails preview settings' minmax(0, 1fr) / minmax(var(--app-scan-page-list-collapsed-width), 14rem)
            minmax(0, 1fr)
            minmax(16rem, var(--app-scan-dialog-rail-width));
    }
}

@container (width <= 52rem) {
    .scan-cleanup-workspace {
        grid-template:
            'thumbnails preview' minmax(16rem, 3fr)
            'settings settings' minmax(12rem, 2fr) / minmax(var(--app-scan-page-list-collapsed-width), 8rem)
            minmax(0, 1fr);
        overflow: auto;
        overscroll-behavior: contain;
    }

    .scan-cleanup-options-rail {
        border-block-start: var(--app-hairline-height) solid var(--ui-border);
        border-inline-start: 0;
    }
}

.scan-cleanup-options-rail {
    grid-area: settings;
    box-sizing: border-box;
    height: 100%;
    width: 100%;
    min-width: 0;
    min-height: 0;
    align-self: stretch;
    overflow: hidden;
    overscroll-behavior: contain;
    border: 0;
    border-inline-start: var(--app-hairline-height) solid var(--ui-border);
    padding: 0;
}

.scan-thumbnail-rail {
    grid-area: thumbnails;
}

.scan-cleanup-preview-hero {
    grid-area: preview;
}

.scan-cleanup-options-rail:disabled {
    opacity: var(--app-scan-disabled-opacity);
}

.scan-cleanup-preview-hero {
    position: relative;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
}
</style>
