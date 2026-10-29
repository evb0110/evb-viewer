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
            <fieldset class="scan-cleanup-options-rail app-scrollbar app-scroll-region--balanced" :disabled="isRunning">
                <ScanCleanupSettingsPanel
                    :alignment-items="alignmentItems"
                    :apply-scope-items="applyScopeItems"
                    :blank-page-count="blankPageCount"
                    :changed-settings="changedSettings"
                    :content-boxes="scopeContentBoxes"
                    :customized-counts="scopeCustomizedCounts"
                    :excluded="scopeExcluded"
                    :has-scope-overrides="hasScopeOverrides"
                    :highlighted-scope="highlightedScope"
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
                    @reset-settings="resetSettingsToDefaults"
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
                :active="workspaceActive"
                :source="pageSource"
                :source-pending="pageSourcePending"
                :total-pages="previewTotalPages"
                :selection-leader="selectionLeader"
                :selected-pages="selectedPages"
                :overrides="settings.pageOverrides"
                :classifications="authoritativeLayoutByPage"
                :confidences="detectedLayoutConfidenceByPage"
                :document-output-mode="settings.outputMode"
                :preserve-original-quality="settings.preserveOriginalQuality === true"
                :recommended-output-modes="recommendedOutputModeByPage"
                :text-axes="detectedTextAxisByPage"
                :disabled="isRunning"
                :can-redetect="canDetectAll && !detectionPending"
                :processed-pages="processedPages"
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
import { useFailureToast } from '@app/composables/useFailureToast';
import {BrowserLogger} from '@app/utils/browserLogger';
import type {TDocumentRef} from '@contracts/documentRef';
import {requirePageNumber} from '@contracts/pageNumbers';
import type {
    IScanCleanupOptions,
    IScanCleanupPageOverride,
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
    attachScanCleanupPageOverrideDefaults,
    areScanCleanupMarginsMmEqual,
    createScanCleanupPageOverride,
    DEFAULT_SCAN_CLEANUP_PAGE_OVERRIDE,
    getScanCleanupPageOverride,
    isDefaultScanCleanupPageOverride,
    isScanCleanupPageOverrideInherited,
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
import type {TScanCleanupOverrideControl} from '@app/modules/scan-cleanup/composables/useScanCleanupSelection';
import {useScanCleanupWorkspaceSession} from '@app/modules/scan-cleanup/composables/useScanCleanupWorkspaceSession';
import type {IScanCleanupPageFacts} from '@app/modules/scan-cleanup/runtime/describeScanCleanupPage';
import {resolveScanCleanupMixedValue} from '@app/modules/scan-cleanup/runtime/scanCleanupSelectionOverrides';
import {
    updateScanCleanupPageOverrideRotation,
    type TScanCleanupPageOverrideUpdate,
} from '@app/modules/scan-cleanup/runtime/scanCleanupSelectionOverrides';
import {
    createScanCleanupPageRange,
    type TScanCleanupPageScope,
} from '@app/modules/scan-cleanup/runtime/resolveScanCleanupApplyScope';

const { t } = useTypedI18n();
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
const previewPane = ref<{revealLatestFrame: (signal?: AbortSignal) => Promise<'published' | 'dropped'>;} | null>(null);
const workspaceSession = useScanCleanupWorkspaceSession({
    // Losing the source ends the session: detection and preview cancel instead
    // of queueing IPC against a working copy the main process has already
    // retired. Switching tabs pauses that work without changing identity.
    active: () => workspaceActive.value,
    beforeRun: signal => previewPane.value?.revealLatestFrame(signal),
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
    documentSettingsLoadFailure,
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
    presentFailureToast,
    presentNoticeToast,
} = useFailureToast();
let toldSettingsLoadFailure: typeof documentSettingsLoadFailure.value = null;
// Settings that did not load are told once, with Retry, when this workspace
// is the one on screen; the rail keeps its defaults meanwhile.
watch([
    documentSettingsLoadFailure,
    () => workspaceActive.value,
], ([
    failure,
    active,
]) => {
    if (failure && active && failure !== toldSettingsLoadFailure) {
        toldSettingsLoadFailure = failure;
        presentFailureToast(failure);
    }
}, {immediate: true});
const {
    applyLeaderOverrides,
    currentPageOverride,
    highlightedScope,
    leader: selectionLeader,
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
    updateLayoutOverride: updateSelectionLayoutOverride,
    updateMargins: updateSelectionMargins,
    setMarginsLinked: setSelectionMarginsLinked,
    updateOutputModeOverride: updateSelectionOutputModeOverride,
    updateOverrides: updateSelectionOverrides,
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
    cancelStatusText,
    canRun,
    dismissError: dismissRunError,
    error: runError,
    finishing,
    isRunning,
    ownerId,
    processedPages,
    runLabel,
    runDisabledReason,
    run,
} = workspaceSession.run;
// A failed analysis is told once, when this workspace is the one on screen: an
// expected refusal as a warning, a defect with its Error ID. The toolbar keeps
// the reason on its status line meanwhile.
const EXPECTED_DETECTION_REFUSALS = new Set([
    'insufficient-scratch',
    'encrypted',
    'needs-password',
    'too-large',
]);
let toldDetectionError = '';
watch([
    detectionError,
    () => workspaceActive.value,
], ([
    message,
    active,
]) => {
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
        failure: BrowserLogger.error('scan-cleanup', 'Scan cleanup page analysis failed', message, {code: 'RENDERER_SCAN_CLEANUP_OPERATION_FAILED'}),
        title: t('scanCleanup.detectAll.failed'),
        description: message,
    });
}, {immediate: true});
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
const {
    activity,
    activityTimeline,
} = workspaceSession;
// Settings persist from one document to the next, so the rail names the ones
// that differ from the defaults where they can be reset in one click.
const changedSettings = computed(() => resolveScanCleanupNonDefaultSettings(settings)
    .map(setting => formatScanCleanupSettingsBadge(t, setting.key, setting.value)));
const zoneEditing = ref(false);

const allScopeDefaultOverride = computed(() => settings.pageOverrideDefaults
    ?? createScanCleanupPageOverride());

function setAllScopeDefault(value: IScanCleanupPageOverride) {
    const next = createScanCleanupPageOverride(value);
    settings.pageOverrideDefaults = next;
    attachScanCleanupPageOverrideDefaults(settings.pageOverrides, next, settings.marginsMm);
    return next;
}

function resetSettingsToDefaults() {
    if (isRunning.value) {
        return;
    }
    resetScanCleanupOptionsToDefaults(settings);
    resetPageOverrides();
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

function updateScopeOverrides(
    update: TScanCleanupPageOverrideUpdate,
    updateExisting: TScanCleanupPageOverrideUpdate = update,
) {
    if (settingsScope.value === 'all') {
        setAllScopeDefault(update(allScopeDefaultOverride.value, selectionLeader.value));
        updateSelectionOverrides(existingOverridePages(), updateExisting);
        return;
    }
    updateSelectionOverrides(scopePageNumbers.value, update);
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
        .filter(page => Number.isInteger(page) && page >= 1 && page <= previewTotalPages.value)
        .filter(page => !isScanCleanupPageOverrideInherited(settings.pageOverrides, getPageOverride(page))));
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
const scopeMarginsLinked = computed(() => documentMarginsLinked.value);
// Only the Page and Selected scopes mark a control as overridden: All edits the
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
    if (settingsScope.value === 'all') {
        return counts;
    }
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

// The rail's warning marker opens the page in Page scope, where its findings
// and the controls that fix them are.
function inspectPage(page: number) {
    if (isRunning.value) {
        return;
    }
    selectPage(page, 'single', [page]);
    setSettingsScope('page');
}

const pageFacts = computed<IScanCleanupPageFacts | null>(() => {
    if (settingsScope.value !== 'page') {
        return null;
    }
    const page = selectionLeader.value;
    return {
        classification: authoritativeLayoutByPage.value.get(page),
        diagnostics: previewMetadataByPage.get(page),
        layoutConfidence: detectedLayoutConfidenceByPage.get(page),
        override: currentPageOverride.value,
        recommendedOutputMode: recommendedOutputModeByPage.get(page),
        recommendedOutputModeConfidence: recommendedOutputModeConfidenceByPage.get(page),
        recommendedOutputModeReason: recommendedOutputModeReasonByPage.get(page),
        textAxis: detectedTextAxisByPage.get(page),
    };
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
    const layout = String(value);
    if (settingsScope.value === 'all') {
        if (![
            'auto',
            'force-single',
            'force-two-page',
        ].includes(layout)) {
            return;
        }
        const layoutMode = layout as IScanCleanupOptions['layoutMode'];
        settings.layoutMode = layoutMode;
        const matchingOverride = layoutMode === 'force-single'
            ? 'single'
            : layoutMode === 'force-two-page' ? 'spread' : 'auto';
        const resetMatchingPage = (current: IScanCleanupPageOverride) => current.layoutOverride === matchingOverride
            ? {
                ...current,
                layoutOverride: 'auto' as const,
            }
            : current;
        updateScopeOverrides(
            current => ({
                ...current,
                layoutOverride: DEFAULT_SCAN_CLEANUP_PAGE_OVERRIDE.layoutOverride,
            }),
            resetMatchingPage,
        );
        return;
    }
    if (scopeLayoutItems.value.some(item => item.value === layout && !('disabled' in item && item.disabled === true))) {
        updateSelectionLayoutOverride(layout as TScanCleanupPageLayoutOverride, scopePageNumbers.value);
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
        updateScopeOverrides(current => {
            if (outputMode === 'auto') {
                const {
                    outputModeOverride: _outputModeOverride,
                    ...withoutOutputMode
                } = current;
                return withoutOutputMode;
            }
            return {
                ...current,
                outputModeOverride: outputMode as TScanCleanupOutputMode,
            };
        });
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
        updateScopeOverrides(current => updateScanCleanupPageOverrideRotation(current, rotation));
    }
}

function handleScopeInclusion(value: string | number) {
    if (value === 'included' || value === 'excluded') {
        const excluded = value === 'excluded';
        updateScopeOverrides(current => ({
            ...current,
            excluded,
        }));
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
    if (settingsScope.value !== 'all') {
        // Page and Selected scopes equalize their own pages' margins, like
        // every other margin edit there; the document's stay as they are.
        const margins = scopeMargins.value;
        setSelectionMarginsLinked(
            linked,
            scopePageNumbers.value,
            margins.mixed ? undefined : margins.value,
        );
        return;
    }
    const {
        marginsMm: _marginsMm,
        ...withoutMargins
    } = allScopeDefaultOverride.value;
    setAllScopeDefault(createScanCleanupPageOverride(withoutMargins));
    setDocumentMarginsLinked(linked);
}

function updateScopePlacement(value: Parameters<typeof updateCurrentPlacementAll>[0]) {
    if (settingsScope.value === 'all') {
        updateCurrentPlacementAll(value);
        return;
    }
    updateSelectionPlacement(value, scopePageNumbers.value);
}

function resetScopeManualSplit() {
    updateScopeOverrides(current => ({
        ...current,
        manualSplit: null,
    }));
}

function resetScopeManualSkew() {
    updateScopeManualSkew(undefined);
}

function updateScopeManualSkew(value: number | undefined) {
    updateScopeOverrides(current => ({
        ...current,
        ...(value === undefined ? {manualSkewDegrees: undefined} : {manualSkewDegrees: value}),
    }));
}

function resetScopeContentBoxes() {
    updateScopeOverrides(current => ({
        ...current,
        manualContentBoxes: {},
    }));
}

function resetScopeControlOverride(control: TScanCleanupOverrideControl) {
    updateScopeOverrides(current => {
        if (control === 'layout') {
            return {
                ...current,
                layoutOverride: DEFAULT_SCAN_CLEANUP_PAGE_OVERRIDE.layoutOverride,
            };
        }
        if (control === 'rotation') {
            return updateScanCleanupPageOverrideRotation(
                current,
                DEFAULT_SCAN_CLEANUP_PAGE_OVERRIDE.rotationDegrees,
            );
        }
        if (control === 'inclusion') {
            return {
                ...current,
                excluded: DEFAULT_SCAN_CLEANUP_PAGE_OVERRIDE.excluded,
            };
        }
        if (control === 'output-mode') {
            const {
                outputModeOverride: _outputModeOverride,
                ...withoutOutputMode
            } = current;
            return withoutOutputMode;
        }
        if (control === 'margins') {
            const {
                marginsMm: _marginsMm,
                ...withoutMargins
            } = current;
            return withoutMargins;
        }
        const {
            placementOverrides: _placementOverrides,
            ...withoutPlacement
        } = current;
        return withoutPlacement;
    });
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

.scan-cleanup-preview-hero {
    position: relative;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
}

</style>
