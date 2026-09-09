<template>
    <Teleport
        v-if="toolbarActive"
        to="#editor-global-toolbar-host"
        :disabled="!canTeleportToolbar"
    >
        <ScanCleanupToolbar
            :can-detect-all="canDetectAll"
            :can-run="canRun"
            :cancel-requested="cancelRequested"
            :detection-cancel-requested="detectionCancelRequested"
            :detection-error="detectionError"
            :run-error="runError"
            :detection-progress-text="detectionProgressText"
            :detection-progress-widest-text="detectionProgressWidestText"
            :is-detecting="detectionPending"
            :is-running="isRunning"
            :output-estimate="outputEstimate"
            :percent="meterPercent"
            :progress-phase="progressPhase"
            :progress-count-text="progressCountText"
            :progress-count-widest-text="progressCountWidestText"
            :progress-eta-text="progressEtaText"
            :progress-eta-widest-text="progressEtaWidestText"
            :progress-phase-text="progressPhaseText"
            :progress-text="progressText"
            :run-label="runLabel"
            :run-disabled-reason="runDisabledReason"
            :settings-badges="settingsBadges"
            :zone-editing="zoneEditing"
            :transition-text="transitionText"
            @cancel="cancel"
            @cancel-detection="cancelDetection"
            @detect-all="detectAllPages"
            @dismiss-run-error="dismissRunError"
            @done="done"
            @remove-setting="removeSettingBadge"
            @reset-settings="resetSettingsToDefaults"
            @run="runWithSettingsToast"
            @update:zone-editing="zoneEditing = $event"
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
            <fieldset class="scan-cleanup-options-rail app-scrollbar app-scroll-region--balanced" :disabled="isRunning">
                <ScanCleanupSettingsPanel
                    :alignment-items="alignmentItems"
                    :apply-scope-items="applyScopeItems"
                    :blank-page-count="blankPageCount"
                    :content-boxes="scopeContentBoxes"
                    :customized-counts="scopeCustomizedCounts"
                    :excluded="scopeExcluded"
                    :has-scope-overrides="hasScopeOverrides"
                    :highlighted-scope="highlightedScope"
                    :inclusion-items="scopeInclusionItems"
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
                    :page-number="selectionLeader"
                    :placement-alignment="scopePlacementAlignment"
                    :reading-order-items="readingOrderItems"
                    :rotation="scopeRotation"
                    :rotation-items="scopeRotationItems"
                    :scope="settingsScope"
                    :selected-count="selectedPages.size"
                    :settings="settings"
                    :thickness-label="thicknessLabel"
                    :total-pages="previewTotalPages"
                    @reset-content-boxes="resetScopeContentBoxes"
                    @reset-control-override="resetScopeControlOverride"
                    @reset-manual-split="resetScopeManualSplit"
                    @reset-manual-skew="resetScopeManualSkew"
                    @reset-scope-overrides="resetScopeOverrides"
                    @margin-interaction="marginBoundaryVisible = $event"
                    @thickness-input="handleThicknessInput"
                    @update-inclusion="handleScopeInclusion"
                    @update-layout="handleScopeLayout"
                    @update-margin="updateScopeMargin"
                    @update-manual-skew="updateScopeManualSkew"
                    @update-output-mode="handleScopeOutputMode"
                    @update:margins-linked="setScopeMarginsLinked"
                    @update-placement="updateScopePlacement"
                    @update-rotation="handleScopeRotation"
                    @update-setting="updateDocumentSetting"
                    @update:scope="setSettingsScope"
                />
            </fieldset>

            <ScanCleanupThumbnailRail
                :source="pageSource"
                :source-pending="pageSourcePending"
                :total-pages="previewTotalPages"
                :selection-leader="selectionLeader"
                :selected-pages="selectedPages"
                :overrides="settings.pageOverrides"
                :classifications="authoritativeLayoutByPage"
                :confidences="detectedLayoutConfidenceByPage"
                :diagnostics="previewMetadataByPage"
                :document-output-mode="settings.outputMode"
                :preserve-original-quality="settings.preserveOriginalQuality === true"
                :recommended-output-modes="recommendedOutputModeByPage"
                :recommended-output-mode-confidences="recommendedOutputModeConfidenceByPage"
                :recommended-output-mode-reasons="recommendedOutputModeReasonByPage"
                :text-axes="detectedTextAxisByPage"
                :disabled="isRunning"
                :processed-pages="processedPages"
                :detection-active="detectionPending"
                :settled-pages="detectionSettledPages"
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
                    :stale-page="previewResult !== null && previewResult.pageNumber !== previewPage"
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
                    @previous="navigatePreview(-1)"
                    @next="navigatePreview(1)"
                    @retry="retryPreview"
                    @invalidate-detail="clearPreviewDetail"
                    @request-detail="requestPreviewDetail"
                    @update:view-mode="previewViewMode = $event"
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
import type {TDocumentRef} from '@contracts/documentRef';
import {requirePageNumber} from '@contracts/pageNumbers';
import type {
    IScanCleanupOptions,
    IScanCleanupPageOverride,
    TScanCleanupOutputMode,
    TScanCleanupPageLayoutOverride,
    TScanCleanupPageRotation,
} from '@contracts/electronApiScanCleanup';
import {resolveScanCleanupEffectiveOutputMode} from '@contracts/electronApiScanCleanup';
import {
    resetScanCleanupOptionsToDefaults,
    resolveScanCleanupNonDefaultSettings,
    type TScanCleanupNonDefaultSettingKey,
} from '@app/modules/scan-cleanup/runtime/scanCleanupSettingsBadges';
import {formatScanCleanupSettingsBadge} from '@app/modules/scan-cleanup/runtime/formatScanCleanupSettingsBadge';
import {DEFAULT_SCAN_CLEANUP_PREFERENCES} from '@contracts/scanCleanupSettings';
import {
    attachScanCleanupPageOverrideDefaults,
    areScanCleanupMarginsMmEqual,
    createScanCleanupPageOverride,
    DEFAULT_SCAN_CLEANUP_PAGE_OVERRIDE,
    getScanCleanupPageOverride,
    isDefaultScanCleanupPageOverride,
    resolveScanCleanupMarginsMm,
    resolveScanCleanupOutputPlacement,
    resolveScanCleanupPageLayout,
} from '@contracts/scanCleanupPageOverrides';
import type {IDocumentPageSource} from '@app/utils/document-viewer/source/documentPageSource';
import type {IScanCleanupTabSessionState} from '@app/modules/workspace-shell/public';
import ScanCleanupPreviewPane from '@app/modules/scan-cleanup/components/preview/PreviewShell.vue';
import ScanCleanupThumbnailRail from '@app/modules/scan-cleanup/components/ScanCleanupThumbnailRail.vue';
import ScanCleanupToolbar from '@app/modules/scan-cleanup/components/ScanCleanupToolbar.vue';
import ScanCleanupSettingsPanel from '@app/modules/scan-cleanup/components/settings/ScanCleanupSettingsPanel.vue';
import type {TScanCleanupOverrideControl} from '@app/modules/scan-cleanup/composables/useScanCleanupSelection';
import {useScanCleanupWorkspaceSession} from '@app/modules/scan-cleanup/composables/useScanCleanupWorkspaceSession';
import {resolveScanCleanupMixedValue} from '@app/modules/scan-cleanup/runtime/scanCleanupSelectionOverrides';
import {
    createScanCleanupPageRange,
    type TScanCleanupPageScope,
} from '@app/modules/scan-cleanup/runtime/resolveScanCleanupApplyScope';

const { t } = useTypedI18n();
const toast = typeof useToast === 'function'
    ? useToast()
    : {add: () => undefined};
const {
    sourcePath,
    currentPage = 1,
    totalPages = 1,
    documentKey = null,
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
const previewPane = ref<{revealLatestFrame: () => Promise<void>} | null>(null);
const workspaceSession = useScanCleanupWorkspaceSession({
    // Losing the source ends the session: detection and preview cancel instead
    // of queueing IPC against a working copy the main process has already
    // retired. Switching tabs pauses that work without changing identity.
    active: () => workspaceActive.value,
    beforeRun: () => previewPane.value?.revealLatestFrame(),
    sourcePath: () => sourcePath,
    documentKey: () => documentKey,
    documentRevision: () => documentRevision,
    pageMapping: () => sessionState?.pageMapping,
    sourceSha256: () => sourceSha256,
    ownerId: () => sessionState?.ownerId,
    currentPage: () => currentPage,
    totalPages: () => totalPages,
    initialPreviewPage: () => sessionState?.previewPage,
    initialPreviewViewMode: () => sessionState?.previewViewMode,
});
const {
    alignmentItems,
    handleThicknessInput,
    layoutItems,
    marginsLinked: documentMarginsLinked,
    setMarginsLinked: setDocumentMarginsLinked,
    outputItems,
    readingOrderItems,
    resetPageOverrides,
    showFirstRunGuidance,
    dismissFirstRunGuidance,
    thicknessLabel,
    updateMargin: updateDocumentMargin,
    values: settings,
} = workspaceSession.settings;
const {
    applyLeaderOverrides,
    currentPageOverride,
    highlightedScope,
    leader: selectionLeader,
    marginsLinked: selectionMarginsLinked,
    setMarginsLinked: setSelectionMarginsLinked,
    resetContentBoxes,
    resetControlOverride,
    resetManualSplit,
    resetManualSkew,
    resetOverrides,
    selectedPages,
    selectPage,
    setSettingsScope,
    settingsScope,
    updateCurrentManualContentBox,
    updateCurrentManualSplit,
    updateCurrentManualZones,
    updateCurrentPlacementAll,
    updatePageOverride,
    updatePlacement: updateSelectionPlacement,
    updateRotation: updateSelectionRotation,
    updateExcluded: updateSelectionExcluded,
    updateLayoutOverride: updateSelectionLayoutOverride,
    updateMargins: updateSelectionMargins,
    updateManualSkew: updateSelectionManualSkew,
    updateOutputModeOverride: updateSelectionOutputModeOverride,
    updateCurrentPlacement,
} = workspaceSession.selection;
const previewPage = selectionLeader;
const {
    authoritativeLayoutByPage,
    blankPageCount,
    canDetectAll,
    cancel: cancelDetection,
    cancelRequested: detectionCancelRequested,
    confidenceByPage: detectedLayoutConfidenceByPage,
    detectAllPages,
    error: detectionError,
    layoutDetectionComplete,
    outputEstimate,
    pending: detectionPending,
    progressCountText: detectionProgressCountText,
    progressCountWidestText: detectionProgressCountWidestText,
    progressEtaText: detectionProgressEtaText,
    progressEtaWidestText: detectionProgressEtaWidestText,
    progressPercent: detectionProgressPercent,
    progressPhaseText: detectionProgressPhaseText,
    progressText: detectionProgressText,
    progressWidestText: detectionProgressWidestText,
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
    detailResult: previewDetailResult,
    loading: previewLoading,
    metadataByPage: previewMetadataByPage,
    navigate: navigatePreview,
    result: previewResult,
    rawResult: previewRawResult,
    resultCurrent: previewResultCurrent = computed(() => true),
    resultPresentationKey: previewResultPresentationKey = computed(() => ''),
    retry: retryPreview,
    requestDetail: requestPreviewDetail,
    totalPages: previewTotalPages,
    viewMode: previewViewMode,
} = workspaceSession.preview;
const {
    cancel,
    cancelRequested,
    canRun,
    dismissError: dismissRunError,
    error: runError,
    isRunning,
    ownerId,
    processedPages,
    progress: jobProgress,
    progressCountText: runProgressCountText,
    progressCountWidestText: runProgressCountWidestText,
    progressEtaText: runProgressEtaText,
    progressEtaWidestText: runProgressEtaWidestText,
    progressPhaseText: runProgressPhaseText,
    progressText: runProgressText,
    runLabel,
    runDisabledReason,
    run,
    transitionText: runTransitionText,
    waitingForDetection,
} = workspaceSession.run;
const marginBoundaryVisible = ref(false);
let pageMappingConsumed = false;
watch(() => sessionState?.pageMapping, (mapping, previousMapping) => {
    if (mapping !== previousMapping) {
        pageMappingConsumed = false;
    }
});
const documentIdentity = computed(() => `${sourcePath ?? ''}\u0000${documentRevision ?? ''}`);
function emitSessionState() {
    const pageMapping = pageMappingConsumed ? undefined : sessionState?.pageMapping;
    emit('update:session-state', {
        ownerId,
        previewPage: previewPage.value,
        previewViewMode: previewViewMode.value,
        ...(pageMapping === undefined ? {} : {pageMapping}),
    });
}
const FINISH_STAGES = new Set([
    'collecting',
    'assembling',
    'handoff',
]);
const progressPhase = computed<'analyze' | 'clean' | 'finish'>(() => {
    if (waitingForDetection.value) {
        return 'analyze';
    }
    return FINISH_STAGES.has(jobProgress.value.stage) ? 'finish' : 'clean';
});
// The meter is explicitly phase-local. Analysis and cleanup count different
// work, so presenting them as one percentage created the observed 100% → 10%
// rewind. The phase rail owns overall position; the final short tail is
// indeterminate because its units are PDF objects rather than source pages.
const meterPercent = computed(() => waitingForDetection.value
    ? detectionProgressPercent.value
    : progressPhase.value === 'finish'
        ? null
        : jobProgress.value.percent);
const progressPhaseText = computed(() => waitingForDetection.value
    ? detectionProgressPhaseText.value
    : runProgressPhaseText.value);
const progressCountText = computed(() => waitingForDetection.value
    ? detectionProgressCountText.value
    : runProgressCountText.value);
const progressCountWidestText = computed(() => waitingForDetection.value
    ? detectionProgressCountWidestText.value
    : runProgressCountWidestText.value);
const progressEtaText = computed(() => {
    const eta = waitingForDetection.value
        ? detectionProgressEtaText.value
        : runProgressEtaText.value;
    if (eta === '') {
        return t('scanCleanup.etaPending');
    }
    return eta;
});
const progressEtaWidestText = computed(() => waitingForDetection.value
    ? detectionProgressEtaWidestText.value
    : runProgressEtaWidestText.value);
const progressText = computed(() => waitingForDetection.value
    ? `${detectionProgressText.value}. ${progressEtaText.value}`
    : runProgressText.value);
const transitionText = computed(() => waitingForDetection.value ? '' : runTransitionText.value);
const settingsBadges = computed(() => resolveScanCleanupNonDefaultSettings(settings).map(badge => ({
    id: badge.key,
    label: formatScanCleanupSettingsBadge(t, badge.key, badge.value),
})));
const zoneEditing = ref(false);

const allScopeDefaultOverride = computed(() => settings.pageOverrideDefaults
    ?? createScanCleanupPageOverride());

function setAllScopeDefault(value: IScanCleanupPageOverride) {
    const next = createScanCleanupPageOverride(value);
    settings.pageOverrideDefaults = next;
    attachScanCleanupPageOverrideDefaults(settings.pageOverrides, next, settings.marginsMm);
    return next;
}

function updateAllScopeDefault(value: Partial<IScanCleanupPageOverride>) {
    return setAllScopeDefault(createScanCleanupPageOverride({
        ...allScopeDefaultOverride.value,
        ...value,
    }));
}

function resetSettingsToDefaults() {
    if (isRunning.value) {
        return;
    }
    resetScanCleanupOptionsToDefaults(settings);
    resetPageOverrides();
}

function removeSettingBadge(id: string) {
    if (isRunning.value) {
        return;
    }
    const key = id as TScanCleanupNonDefaultSettingKey;
    if (key === 'pageOverrides') {
        resetPageOverrides();
        return;
    }
    if (key === 'marginsMm') {
        Object.assign(settings.marginsMm, DEFAULT_SCAN_CLEANUP_PREFERENCES.marginsMm);
        return;
    }
    if (key === 'autoDewarp') {
        settings.autoDewarp = DEFAULT_SCAN_CLEANUP_PREFERENCES.autoDewarp;
        settings.autoDewarpDepth = DEFAULT_SCAN_CLEANUP_PREFERENCES.autoDewarpDepth;
        return;
    }
    if (key === 'outputMode') {
        settings.outputMode = 'auto';
        return;
    }
    Object.assign(settings, {[key]: DEFAULT_SCAN_CLEANUP_PREFERENCES[key]});
}

function runWithSettingsToast() {
    if (settingsBadges.value.length > 0) {
        toast.add({
            title: t('scanCleanup.settingsBadges.toastTitle'),
            description: t('scanCleanup.settingsBadges.toastDescription', {settings: settingsBadges.value.map(badge => badge.label).join(', ')}),
        });
    }
    void run();
}

const scopePageNumbers = computed<TScanCleanupPageScope | readonly number[]>(() => settingsScope.value === 'all'
    ? createScanCleanupPageRange(1, Math.max(1, previewTotalPages.value))
    : settingsScope.value === 'page'
        ? [selectionLeader.value]
        : [...selectedPages.value].sort((left, right) => left - right));
function getPageOverride(page: number) {
    return getScanCleanupPageOverride(
        settings.pageOverrides,
        requirePageNumber(page, Math.max(1, previewTotalPages.value)),
    );
}
function existingOverridePages() {
    return Object.keys(settings.pageOverrides)
        .map(Number)
        .filter(page => Number.isSafeInteger(page) && page >= 1 && page <= previewTotalPages.value);
}
const scopePageOverrides = computed(() => settingsScope.value === 'all'
    ? []
    : [...scopePageNumbers.value].map(page => getPageOverride(page)));

function resolveAllPageOverrideValue<T>(
    defaultValue: T,
    read: (override: ReturnType<typeof getScanCleanupPageOverride>) => T,
) {
    const values = [settings.pageOverrideDefaults === undefined
        ? defaultValue
        : read(allScopeDefaultOverride.value)];
    for (const pageKey of Object.keys(settings.pageOverrides)) {
        const page = Number(pageKey);
        if (!Number.isSafeInteger(page) || page < 1 || page > previewTotalPages.value) {
            continue;
        }
        values.push(read(getPageOverride(page)));
    }
    return resolveScanCleanupMixedValue(values);
}
const scopeCustomizedCounts = computed(() => {
    const customizedPages = new Set(Object.keys(settings.pageOverrides)
        .map(Number)
        .filter(page => Number.isInteger(page) && page >= 1 && page <= previewTotalPages.value));
    return {
        all: isDefaultScanCleanupPageOverride(allScopeDefaultOverride.value)
            ? customizedPages.size
            : previewTotalPages.value,
        page: customizedPages.has(selectionLeader.value) ? 1 : 0,
        selected: [...selectedPages.value].filter(page => customizedPages.has(page)).length,
    };
});
const scopeLayout = computed(() => settingsScope.value === 'all'
    ? resolveScanCleanupMixedValue([settings.layoutMode])
    : resolveScanCleanupMixedValue(scopePageOverrides.value.map(override => override.layoutOverride)));
const scopeRotation = computed(() => settingsScope.value === 'all'
    ? resolveScanCleanupMixedValue([allScopeDefaultOverride.value.rotationDegrees])
    : resolveScanCleanupMixedValue(scopePageOverrides.value.map(override => override.rotationDegrees)));
const scopeOutputModeOverride = computed(() => settingsScope.value === 'all'
    ? resolveAllPageOverrideValue(undefined, override => override.outputModeOverride)
    : resolveScanCleanupMixedValue(scopePageOverrides.value.map(override => override.outputModeOverride)));
const scopeExcluded = computed(() => settingsScope.value === 'all'
    ? resolveScanCleanupMixedValue([allScopeDefaultOverride.value.excluded])
    : resolveScanCleanupMixedValue(scopePageOverrides.value.map(override => override.excluded)));
const scopeManualSplit = computed(() => settingsScope.value === 'all'
    ? resolveAllPageOverrideValue(null, override => override.manualSplit)
    : resolveScanCleanupMixedValue(scopePageOverrides.value.map(override => override.manualSplit)));
const scopeManualSkew = computed(() => settingsScope.value === 'all'
    ? resolveAllPageOverrideValue(undefined, override => override.manualSkewDegrees)
    : resolveScanCleanupMixedValue(scopePageOverrides.value.map(override => override.manualSkewDegrees)));
const scopeDetectedSkewDegrees = computed(() => settingsScope.value === 'page'
    ? previewMetadataByPage.get(selectionLeader.value)?.detectedSkewDegrees
    : undefined);
const scopeContentBoxes = computed(() => settingsScope.value === 'all'
    ? resolveAllPageOverrideValue({}, override => override.manualContentBoxes ?? {})
    : resolveScanCleanupMixedValue(scopePageOverrides.value.map(override => override.manualContentBoxes ?? {})));
const scopeMargins = computed(() => settingsScope.value === 'all'
    ? resolveScanCleanupMixedValue([resolveScanCleanupMarginsMm(
        settings.marginsMm,
        allScopeDefaultOverride.value,
    )])
    : resolveScanCleanupMixedValue(scopePageOverrides.value
        .map(override => resolveScanCleanupMarginsMm(settings.marginsMm, override))));
const scopePlacementAlignment = computed(() => settingsScope.value === 'all'
    ? resolveScanCleanupMixedValue(([
        'full',
        'left',
        'right',
    ] as const).map(half => resolveScanCleanupOutputPlacement(
        settings.pageAlignment,
        allScopeDefaultOverride.value,
        half,
    )))
    : resolveScanCleanupMixedValue(scopePageOverrides.value.flatMap(override => ([
        'full',
        'left',
        'right',
    ] as const).map(half => resolveScanCleanupOutputPlacement(settings.pageAlignment, override, half)))));
const scopeMarginsLinked = computed(() => settingsScope.value === 'all'
    ? documentMarginsLinked.value
    : selectionMarginsLinked.value);
function countAllScopeOverrides(
    isOverride: (override: ReturnType<typeof getScanCleanupPageOverride>) => boolean,
) {
    const defaultIsOverride = isOverride(allScopeDefaultOverride.value);
    let count = defaultIsOverride
        ? Math.max(1, Math.trunc(previewTotalPages.value))
        : 0;
    for (const pageKey of Object.keys(settings.pageOverrides)) {
        const page = Number(pageKey);
        if (!Number.isSafeInteger(page) || page < 1 || page > previewTotalPages.value) {
            continue;
        }
        const pageIsOverride = isOverride(getPageOverride(page));
        if (pageIsOverride !== defaultIsOverride) {
            count += pageIsOverride ? 1 : -1;
        }
    }
    return count;
}
const scopeOverrideCounts = computed(() => {
    if (settingsScope.value === 'all') {
        return {
            inclusion: countAllScopeOverrides(override => override.excluded
                !== DEFAULT_SCAN_CLEANUP_PAGE_OVERRIDE.excluded),
            layout: countAllScopeOverrides(override => resolveScanCleanupPageLayout(
                settings.layoutMode,
                override.layoutOverride,
            ) !== settings.layoutMode),
            margins: countAllScopeOverrides(override => override.marginsMm !== undefined
                && !areScanCleanupMarginsMmEqual(override.marginsMm, settings.marginsMm)),
            outputMode: countAllScopeOverrides(override => override.outputModeOverride !== undefined),
            placement: countAllScopeOverrides(override => Object.values(override.placementOverrides ?? {})
                .some(alignment => alignment !== settings.pageAlignment)),
            rotation: countAllScopeOverrides(override => override.rotationDegrees
                !== DEFAULT_SCAN_CLEANUP_PAGE_OVERRIDE.rotationDegrees),
        };
    }
    const counts = {
        inclusion: 0,
        layout: 0,
        margins: 0,
        outputMode: 0,
        placement: 0,
        rotation: 0,
    };
    const pages = scopePageNumbers.value;
    for (const page of pages) {
        if (!Number.isSafeInteger(page) || page < 1 || page > previewTotalPages.value) {
            continue;
        }
        const override = getPageOverride(page);
        if (resolveScanCleanupPageLayout(settings.layoutMode, override.layoutOverride) !== settings.layoutMode) {
            counts.layout += 1;
        }
        if (override.rotationDegrees !== DEFAULT_SCAN_CLEANUP_PAGE_OVERRIDE.rotationDegrees) {
            counts.rotation += 1;
        }
        if (override.outputModeOverride !== undefined) {
            counts.outputMode += 1;
        }
        if (override.excluded !== DEFAULT_SCAN_CLEANUP_PAGE_OVERRIDE.excluded) {
            counts.inclusion += 1;
        }
        if (override.marginsMm && !areScanCleanupMarginsMmEqual(override.marginsMm, settings.marginsMm)) {
            counts.margins += 1;
        }
        if (Object.values(override.placementOverrides ?? {})
            .some(alignment => alignment !== settings.pageAlignment)) {
            counts.placement += 1;
        }
    }
    return counts;
});
const hasScopeOverrides = computed(() => {
    if (settingsScope.value === 'all') {
        return Object.keys(settings.pageOverrides).length > 0
            || !isDefaultScanCleanupPageOverride(allScopeDefaultOverride.value);
    }
    for (const page of scopePageNumbers.value) {
        if (settings.pageOverrides[String(page)] !== undefined) {
            return true;
        }
    }
    return false;
});
const scopeLayoutItems = computed(() => settingsScope.value === 'all'
    ? layoutItems.value
    : [
        ...(scopeLayout.value.mixed ? [{
            value: 'mixed' as const,
            label: t('scanCleanup.settings.mixed'),
            disabled: true,
        }] : []),
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
    ]);
const scopeRotationItems = computed(() => [
    ...(scopeRotation.value.mixed ? [{
        value: 'mixed' as const,
        label: t('scanCleanup.settings.mixed'),
        disabled: true,
    }] : []),
    ...([
        0,
        90,
        180,
        270,
    ] as const).map(value => ({
        value: String(value),
        label: t('scanCleanup.settings.rotationDegrees', {value}),
    })),
]);
const scopeOutputModeOverrideItems = computed(() => [
    ...(scopeOutputModeOverride.value.mixed ? [{
        value: 'mixed-values' as const,
        label: t('scanCleanup.settings.mixed'),
        disabled: true,
    }] : []),
    {
        value: 'auto' as const,
        label: t('scanCleanup.pages.outputModeFollowDocument'),
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
        detectedOutputMode: recommendedOutputModeByPage.get(previewPage.value),
        renderedOutputMode: previewResultCurrent.value && previewResult.value?.pageNumber === previewPage.value
            ? previewResult.value.outputs[0]?.metadata.outputMode
                ?? previewResult.value.pageMetadata.recommendedOutputMode
            : undefined,
    }));
const scopeInclusionItems = computed(() => [
    ...(scopeExcluded.value.mixed ? [{
        value: 'mixed' as const,
        label: t('scanCleanup.settings.mixed'),
        disabled: true,
    }] : []),
    {
        value: 'included' as const,
        label: t('scanCleanup.pages.includeInOutput'),
    },
    {
        value: 'excluded' as const,
        label: t('scanCleanup.pages.excludedFromOutput'),
    },
]);
const applyScopeItems = computed(() => {
    const actions = ([
        [
            'all',
            'allPages',
        ],
        [
            'from-here',
            'fromHere',
        ],
        [
            'every-other',
            'everyOther',
        ],
        ...(selectedPages.value.size >= 2 ? [[
            'selected',
            'selectedPages',
        ] as const] : []),
    ] as const).map(([
        scope,
        label,
    ]) => ({
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

function done() {
    emit('done');
}

function updateDocumentSetting(
    key: keyof IScanCleanupOptions,
    value: IScanCleanupOptions[keyof IScanCleanupOptions],
) {
    Object.assign(settings, {[key]: value});
}

function useMixedOutput() {
    settings.preserveOriginalQuality = false;
    updateSelectionOutputModeOverride('mixed', [previewPage.value]);
}

function handleScopeLayout(value: string | number) {
    if (settingsScope.value === 'all') {
        if ([
            'auto',
            'force-single',
            'force-two-page',
        ].includes(String(value))) {
            const layoutMode = String(value) as IScanCleanupOptions['layoutMode'];
            settings.layoutMode = layoutMode;
            const matchingOverride = layoutMode === 'force-single'
                ? 'single'
                : layoutMode === 'force-two-page' ? 'spread' : 'auto';
            const matchingPages = Object.keys(settings.pageOverrides)
                .map(Number)
                .filter(page => getPageOverride(page).layoutOverride === matchingOverride);
            updateAllScopeDefault({layoutOverride: DEFAULT_SCAN_CLEANUP_PAGE_OVERRIDE.layoutOverride});
            updateSelectionLayoutOverride('auto', matchingPages);
        }
        return;
    }
    const layout = String(value) as TScanCleanupPageLayoutOverride;
    if (scopeLayoutItems.value.some(item => item.value === layout && !('disabled' in item && item.disabled === true))) {
        updateSelectionLayoutOverride(layout, scopePageNumbers.value);
    }
}

function handleScopeOutputMode(value: string | number) {
    const outputMode = String(value);
    if ([
        'auto',
        'bw',
        'mixed',
        'grayscale',
        'color',
    ].includes(outputMode)) {
        if (settingsScope.value === 'all') {
            if (outputMode === 'auto') {
                const {
                    outputModeOverride: _outputModeOverride,
                    ...withoutOutputMode
                } = allScopeDefaultOverride.value;
                setAllScopeDefault(createScanCleanupPageOverride(withoutOutputMode));
            } else {
                updateAllScopeDefault({outputModeOverride: outputMode as TScanCleanupOutputMode});
            }
            updateSelectionOutputModeOverride(
                outputMode as TScanCleanupOutputMode | 'auto',
                existingOverridePages(),
            );
            return;
        }
        updateSelectionOutputModeOverride(
            outputMode as TScanCleanupOutputMode | 'auto',
            scopePageNumbers.value,
        );
    }
}

function handleScopeRotation(value: string | number) {
    const rotation = Number(value) as TScanCleanupPageRotation;
    if ([
        0,
        90,
        180,
        270,
    ].includes(rotation)) {
        if (settingsScope.value === 'all') {
            const current = allScopeDefaultOverride.value;
            const rotationChanged = current.rotationDegrees !== rotation;
            setAllScopeDefault({
                ...current,
                rotationDegrees: rotation,
                manualSplit: rotationChanged ? null : current.manualSplit,
                manualSkewDegrees: rotationChanged ? undefined : current.manualSkewDegrees,
                manualContentBoxes: rotationChanged ? {} : current.manualContentBoxes ?? {},
                manualZones: rotationChanged ? {
                    picture: [],
                    fill: [],
                } : current.manualZones ?? {
                    picture: [],
                    fill: [],
                },
            });
            updateSelectionRotation(rotation, existingOverridePages());
            return;
        }
        updateSelectionRotation(rotation, scopePageNumbers.value);
    }
}

function handleScopeInclusion(value: string | number) {
    if (value === 'included' || value === 'excluded') {
        const excluded = value === 'excluded';
        if (settingsScope.value === 'all') {
            updateAllScopeDefault({excluded});
            updateSelectionExcluded(excluded, existingOverridePages());
            return;
        }
        updateSelectionExcluded(excluded, scopePageNumbers.value);
    }
}

function updateScopeMargin(target: Parameters<typeof updateDocumentMargin>[0], value: number) {
    if (settingsScope.value === 'all') {
        const {
            marginsMm: _marginsMm,
            ...withoutMargins
        } = allScopeDefaultOverride.value;
        setAllScopeDefault(createScanCleanupPageOverride(withoutMargins));
        updateDocumentMargin(target, value);
        return;
    }
    updateSelectionMargins(target, value, scopePageNumbers.value);
}

function setScopeMarginsLinked(linked: boolean) {
    if (settingsScope.value === 'all') {
        const {
            marginsMm: _marginsMm,
            ...withoutMargins
        } = allScopeDefaultOverride.value;
        setAllScopeDefault(createScanCleanupPageOverride(withoutMargins));
        setDocumentMarginsLinked(linked);
        return;
    }
    setSelectionMarginsLinked(linked, scopePageNumbers.value, scopeMargins.value.value);
}

function updateScopePlacement(value: Parameters<typeof updateCurrentPlacementAll>[0]) {
    if (settingsScope.value === 'all') {
        updateCurrentPlacementAll(value);
        return;
    }
    updateSelectionPlacement(value, scopePageNumbers.value);
}

function resetScopeManualSplit() {
    if (settingsScope.value === 'all') {
        updateAllScopeDefault({manualSplit: null});
        resetManualSplit(existingOverridePages());
        return;
    }
    resetManualSplit(scopePageNumbers.value);
}

function resetScopeManualSkew() {
    if (settingsScope.value === 'all') {
        const {
            manualSkewDegrees: _manualSkewDegrees,
            ...withoutManualSkew
        } = allScopeDefaultOverride.value;
        setAllScopeDefault(createScanCleanupPageOverride(withoutManualSkew));
        resetManualSkew(existingOverridePages());
        return;
    }
    resetManualSkew(scopePageNumbers.value);
}

function updateScopeManualSkew(value: number | undefined) {
    if (settingsScope.value === 'all') {
        if (value === undefined) {
            const {
                manualSkewDegrees: _manualSkewDegrees,
                ...withoutManualSkew
            } = allScopeDefaultOverride.value;
            setAllScopeDefault(createScanCleanupPageOverride(withoutManualSkew));
        } else {
            updateAllScopeDefault({manualSkewDegrees: value});
        }
        updateSelectionManualSkew(value, existingOverridePages());
        return;
    }
    updateSelectionManualSkew(value, scopePageNumbers.value);
}

function resetScopeContentBoxes() {
    if (settingsScope.value === 'all') {
        const {
            manualContentBoxes: _manualContentBoxes,
            ...withoutContentBoxes
        } = allScopeDefaultOverride.value;
        setAllScopeDefault(createScanCleanupPageOverride(withoutContentBoxes));
        resetContentBoxes(existingOverridePages());
        return;
    }
    resetContentBoxes(scopePageNumbers.value);
}

function resetScopeControlOverride(control: TScanCleanupOverrideControl) {
    if (settingsScope.value === 'all') {
        const current = allScopeDefaultOverride.value;
        let next: IScanCleanupPageOverride = current;
        if (control === 'layout') {
            next = {
                ...current,
                layoutOverride: DEFAULT_SCAN_CLEANUP_PAGE_OVERRIDE.layoutOverride,
            };
        } else if (control === 'rotation') {
            const rotationChanged = current.rotationDegrees !== DEFAULT_SCAN_CLEANUP_PAGE_OVERRIDE.rotationDegrees;
            next = {
                ...current,
                rotationDegrees: DEFAULT_SCAN_CLEANUP_PAGE_OVERRIDE.rotationDegrees,
                manualSplit: rotationChanged ? null : current.manualSplit,
                manualSkewDegrees: rotationChanged ? undefined : current.manualSkewDegrees,
                manualContentBoxes: rotationChanged ? {} : current.manualContentBoxes ?? {},
                manualZones: rotationChanged ? {
                    picture: [],
                    fill: [],
                } : current.manualZones ?? {
                    picture: [],
                    fill: [],
                },
            };
        } else if (control === 'inclusion') {
            next = {
                ...current,
                excluded: DEFAULT_SCAN_CLEANUP_PAGE_OVERRIDE.excluded,
            };
        } else if (control === 'output-mode') {
            const {
                outputModeOverride: _outputModeOverride,
                ...withoutOutputMode
            } = current;
            next = withoutOutputMode;
        } else if (control === 'margins') {
            const {
                marginsMm: _marginsMm,
                ...withoutMargins
            } = current;
            next = withoutMargins;
        } else {
            const {
                placementOverrides: _placementOverrides,
                ...withoutPlacement
            } = current;
            next = withoutPlacement;
        }
        setAllScopeDefault(createScanCleanupPageOverride(next));
        resetControlOverride(control, existingOverridePages());
        return;
    }
    resetControlOverride(control, scopePageNumbers.value);
}

function resetScopeOverrides() {
    if (settingsScope.value === 'all') {
        resetPageOverrides();
        return;
    }
    resetOverrides(scopePageNumbers.value);
}

watch(documentIdentity, () => {
    pageMappingConsumed = true;
    emitSessionState();
});
watch([
    previewPage,
    previewViewMode,
], emitSessionState, {immediate: true});
watch(isRunning, running => {
    if (running) {
        zoneEditing.value = false;
        marginBoundaryVisible.value = false;
    }
});
</script>

<style>
.scan-cleanup-surface {
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

.scan-cleanup-settings-content {
    min-width: 0;
}

.scan-cleanup-selection-hint {
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-kicker);
    line-height: var(--app-line-height-body);
}

/* Help text that is gated by another setting keeps its line reserved, so
   ticking a checkbox or changing scope never moves the controls below it. */
.scan-cleanup-selection-hint.is-reserved {
    min-height: calc(var(--app-text-size-kicker) * var(--app-line-height-body));
}

.scan-cleanup-selection-hint.is-reserved.is-two-lines {
    min-height: calc(var(--app-text-size-kicker) * var(--app-line-height-body) * 2);
}

/* A control whose value no longer applies stays in place and dims, matching
   ScanCleanupAutoValueRow, instead of unmounting and collapsing its row. */
.scan-cleanup-field-disabled {
    opacity: var(--app-scan-disabled-opacity);
}

/* Conditional badges, override markers and reset buttons are taller than the
   label text they sit beside; the row reserves their height in every state. */
.scan-cleanup-selection-field-label,
.scan-cleanup-margins-header {
    min-height: var(--app-scan-settings-affordance-height);
}

.scan-cleanup-lossless-explanation {
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-kicker);
}

.scan-cleanup-option-group {
    display: grid;
    gap: var(--app-space-3xl);
    padding-block-end: var(--app-space-5xl);
}

.scan-cleanup-option-group + .scan-cleanup-option-group {
    border-block-start: var(--app-hairline-height) solid var(--ui-border);
    padding-block-start: var(--app-space-5xl);
}

.scan-cleanup-option-group h3 {
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-kicker);
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
}

.scan-cleanup-scale {
    display: flex;
    justify-content: space-between;
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-kicker);
}

.scan-cleanup-alignment-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: var(--app-space-sm);
}

.scan-cleanup-alignment-grid > * {
    justify-content: center;
}

/* Not one of the nine anchors: it spans the row above them and carries its
   own label, so the grid still reads as a 3x3 compass. */
.scan-cleanup-alignment-ink {
    grid-column: 1 / -1;
}

.scan-cleanup-selection-field {
    display: grid;
    gap: var(--app-space-sm);
}

.scan-cleanup-margins-control {
    display: grid;
    gap: var(--app-space-3xl);
}

.scan-cleanup-margins-header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--app-space-sm);
    color: var(--ui-text);
    font-size: var(--app-text-size-body-sm);
}

.scan-cleanup-margins-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--app-space-3xl);
}

.scan-cleanup-selection-field-label {
    display: flex;
    align-items: center;
    gap: var(--app-space-sm);
}

.scan-cleanup-selection-field-label {
    justify-content: space-between;
    color: var(--ui-text);
    font-size: var(--app-text-size-body-sm);
}

.scan-cleanup-footnote {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-kicker);
}

.scan-cleanup-details-trigger:focus-visible {
    outline: var(--app-hairline-height) solid var(--ui-primary);
    outline-offset: var(--app-space-xs);
}

.scan-cleanup-details-popover {
    display: grid;
    max-width: var(--app-scan-details-width);
    gap: var(--app-space-9xl);
    padding: var(--app-space-12xl);
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-body-sm);
}

.scan-cleanup-preview-hero {
    position: relative;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
}

.scan-cleanup-reset-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--app-space-sm);
}

.scan-cleanup-reset-confirmation {
    display: grid;
    max-width: var(--app-scan-reset-confirmation-width);
    gap: var(--app-space-5xl);
    padding: var(--app-space-9xl);
    color: var(--ui-text);
    font-size: var(--app-text-size-body-sm);
}

.scan-cleanup-reset-confirmation > span {
    color: var(--ui-text-muted);
}
</style>
