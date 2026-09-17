<template>
    <header
        class="toolbar scan-cleanup-toolbar"
        :aria-label="t('scanCleanup.workspaceTitle')"
    >
        <div class="scan-cleanup-toolbar-zone scan-cleanup-toolbar-zone-left">
            <UButton
                class="scan-cleanup-toolbar-done"
                type="button"
                color="neutral"
                variant="ghost"
                size="sm"
                icon="i-ph-caret-left"
                :label="t('scanCleanup.done')"
                @click="emit('done')"
            />
            <AppTooltip :text="t('scanCleanup.description')" usefulness="always">
                <h2 class="scan-cleanup-toolbar-title">{{ t('scanCleanup.workspaceTitle') }}</h2>
            </AppTooltip>
        </div>

        <div class="scan-cleanup-toolbar-zone scan-cleanup-toolbar-zone-center">
            <div
                v-if="isRunning"
                :class="SCAN_CLEANUP_RUN_METER_CLASS"
            >
                <p
                    class="scan-cleanup-run-meter-status"
                    role="status"
                    aria-live="polite"
                >
                    <span class="scan-cleanup-run-meter-phase">
                        {{ transitionText || progressPhaseText }}
                    </span>
                    <template v-if="!transitionText && progressCountText">
                        <span class="scan-cleanup-run-meter-separator" aria-hidden="true">·</span>
                        <ScanCleanupStableWidthText
                            class="scan-cleanup-run-meter-count"
                            :text="progressCountText"
                            :widest="progressCountWidestText"
                        />
                    </template>
                    <span class="scan-cleanup-run-meter-spacer" aria-hidden="true" />
                    <span class="scan-cleanup-run-meter-step">{{ progressStepText }}</span>
                    <span class="scan-cleanup-run-meter-separator" aria-hidden="true">·</span>
                    <ScanCleanupStableWidthText
                        class="scan-cleanup-run-meter-eta"
                        :text="resolvedProgressEtaText"
                        :widest="resolvedProgressEtaWidestText"
                    />
                </p>
                <ol
                    class="scan-cleanup-run-segments"
                    :aria-label="t('scanCleanup.progressPhases.label')"
                >
                    <li
                        v-for="phase in progressPhases"
                        :key="phase.id"
                        class="scan-cleanup-run-segment"
                        :class="{'scan-cleanup-run-segment--current': phase.state === 'current'}"
                        :aria-label="phase.label"
                        :aria-current="phase.state === 'current' ? 'step' : undefined"
                    >
                        <span
                            v-if="phase.state === 'complete'"
                            class="scan-cleanup-run-segment-fill scan-cleanup-run-segment-fill--complete"
                        />
                        <span
                            v-else-if="phase.state === 'current'"
                            class="scan-cleanup-run-segment-track"
                            role="progressbar"
                            :aria-label="t('scanCleanup.runStatusLabel')"
                            aria-valuemin="0"
                            aria-valuemax="100"
                            :aria-valuenow="meterIsIndeterminate ? undefined : normalizedPercent ?? undefined"
                            :aria-valuetext="`${progressStepText}: ${transitionText || progressText}`"
                        >
                            <span
                                class="scan-cleanup-run-segment-fill"
                                :class="{'scan-cleanup-run-segment-fill--indeterminate': meterIsIndeterminate}"
                                :style="meterIsIndeterminate ? undefined : {width: `${normalizedPercent}%`}"
                            />
                        </span>
                    </li>
                </ol>
            </div>
            <template v-else>
                <AppTooltip :text="t('scanCleanup.zones.toggleHint')">
                    <UButton
                        class="scan-cleanup-toolbar-zone-editor"
                        type="button"
                        :color="zoneEditing ? 'primary' : 'neutral'"
                        :variant="zoneEditing ? 'soft' : 'ghost'"
                        size="xs"
                        square
                        icon="i-ph-bounding-box"
                        :aria-label="t('scanCleanup.zones.toggle')"
                        :aria-pressed="zoneEditing"
                        @click="emit('update:zoneEditing', !zoneEditing)"
                    />
                </AppTooltip>
                <AppTooltip :text="t('scanCleanup.detectAll.redetect')">
                    <UButton
                        class="scan-cleanup-toolbar-redetect"
                        type="button"
                        color="neutral"
                        variant="ghost"
                        size="xs"
                        icon="i-ph-arrows-clockwise"
                        :label="t('scanCleanup.detectAll.redetect')"
                        :aria-label="t('scanCleanup.detectAll.redetect')"
                        :disabled="!canDetectAll || isDetecting"
                        @click="emit('detect-all')"
                    />
                </AppTooltip>
                <div class="scan-cleanup-toolbar-status-slot">
                    <template v-if="runError">
                        <span class="scan-cleanup-toolbar-error" role="alert">
                            {{ runError }}
                        </span>
                        <UButton
                            class="scan-cleanup-toolbar-dismiss-error"
                            type="button"
                            color="neutral"
                            variant="ghost"
                            size="xs"
                            square
                            icon="i-ph-x"
                            :aria-label="t('common.close')"
                            @click="emit('dismiss-run-error')"
                        />
                    </template>
                    <template v-else-if="isDetecting">
                        <ScanCleanupStableWidthText
                            :class="SCAN_CLEANUP_TOOLBAR_COUNT_CLASS"
                            role="status"
                            aria-live="polite"
                            :aria-label="detectionProgressText"
                            :text="detectionProgressText"
                            :widest="detectionProgressWidestText"
                        />
                        <AppTooltip :text="detectionCancelLabel" usefulness="always">
                            <UButton
                                :class="SCAN_CLEANUP_TOOLBAR_CANCEL_DETECTION_CLASS"
                                type="button"
                                color="neutral"
                                variant="ghost"
                                size="xs"
                                square
                                :icon="detectionCancelRequested ? 'i-ph-circle-notch' : 'i-ph-x'"
                                :aria-label="detectionCancelLabel"
                                :disabled="detectionCancelRequested"
                                @click="emit('cancel-detection')"
                            />
                        </AppTooltip>
                    </template>
                    <span v-else-if="detectionError" class="scan-cleanup-toolbar-error" role="alert">
                        {{ detectionError }}
                    </span>
                    <span v-else-if="outputEstimate" class="scan-cleanup-toolbar-estimate">
                        {{ outputEstimate }}
                    </span>
                    <span v-else class="scan-cleanup-toolbar-status-placeholder" aria-hidden="true">&nbsp;</span>
                </div>
            </template>
        </div>

        <div class="scan-cleanup-toolbar-zone scan-cleanup-toolbar-zone-right">
            <div
                v-if="settingsBadges.length > 0 && !isRunning"
                class="scan-cleanup-settings-badges"
                role="status"
                :aria-label="t('scanCleanup.settingsBadges.title')"
            >
                    <span
                        v-for="badge in settingsBadges"
                        :key="badge.id"
                        class="scan-cleanup-settings-badge"
                    >
                        <span class="scan-cleanup-settings-badge-label">{{ badge.label }}</span>
                        <UButton
                            class="scan-cleanup-settings-badge-remove"
                            type="button"
                            color="neutral"
                            variant="ghost"
                            size="xs"
                            square
                            icon="i-ph-x"
                            :aria-label="t('scanCleanup.settingsBadges.remove', {setting: badge.label})"
                            @click="emit('remove-setting', badge.id)"
                        />
                    </span>
                <UButton
                    class="scan-cleanup-settings-reset"
                    type="button"
                    color="neutral"
                    variant="ghost"
                    size="xs"
                    icon="i-ph-arrow-u-up-left"
                    :label="t('scanCleanup.settingsBadges.reset')"
                    @click="emit('reset-settings')"
                />
            </div>
            <div class="scan-cleanup-toolbar-primary-slot">
                <UButton
                    v-if="isRunning"
                    :class="SCAN_CLEANUP_TOOLBAR_PRIMARY_ACTION_CLASS"
                    type="button"
                    color="neutral"
                    variant="outline"
                    size="sm"
                    :label="cancelRequested ? t('scanCleanup.canceling') : t('scanCleanup.cancel')"
                    :disabled="cancelRequested"
                    @click="emit('cancel')"
                />
                <AppTooltip
                    v-else
                    :text="runDisabledReason || runLabel"
                    usefulness="always"
                >
                    <UButton
                        :class="SCAN_CLEANUP_TOOLBAR_PRIMARY_ACTION_CLASS"
                        type="button"
                        color="primary"
                        size="sm"
                        icon="i-ph-play"
                        :label="runLabel"
                        :disabled="!canRun"
                        @click="emit('run')"
                    />
                </AppTooltip>
            </div>
        </div>
    </header>
</template>

<script setup lang="ts">
import ScanCleanupStableWidthText from '@app/modules/scan-cleanup/components/ScanCleanupStableWidthText.vue';
import {
    SCAN_CLEANUP_RUN_METER_CLASS,
    SCAN_CLEANUP_TOOLBAR_CANCEL_DETECTION_CLASS,
    SCAN_CLEANUP_TOOLBAR_COUNT_CLASS,
    SCAN_CLEANUP_TOOLBAR_PRIMARY_ACTION_CLASS,
} from '@contracts/scan-cleanup/toolbarSelectors';

const {
    canDetectAll,
    canRun,
    cancelRequested,
    detectionCancelRequested,
    detectionError,
    detectionProgressText,
    detectionProgressWidestText,
    isDetecting,
    isRunning,
    outputEstimate,
    percent,
    progressPhase = 'clean',
    progressCountText,
    progressCountWidestText = '',
    progressEtaText = '',
    progressEtaWidestText = '',
    progressPhaseText,
    progressText,
    runError = '',
    runLabel,
    runDisabledReason,
    settingsBadges = [],
    zoneEditing,
    transitionText,
} = defineProps<{
    canDetectAll: boolean;
    canRun: boolean;
    cancelRequested: boolean;
    detectionCancelRequested: boolean;
    detectionError: string;
    detectionProgressText: string;
    detectionProgressWidestText: string;
    isDetecting: boolean;
    isRunning: boolean;
    outputEstimate: string;
    percent: number | null;
    progressPhase?: 'analyze' | 'clean' | 'finish';
    progressCountText: string;
    progressCountWidestText?: string;
    progressEtaText?: string;
    progressEtaWidestText?: string;
    progressPhaseText: string;
    progressText: string;
    runError?: string;
    runLabel: string;
    runDisabledReason: string;
    settingsBadges?: ReadonlyArray<{
        id: string;
        label: string
    }>;
    zoneEditing?: boolean;
    transitionText: string;
}>();
const emit = defineEmits<{
    cancel: [];
    'cancel-detection': [];
    'detect-all': [];
    'dismiss-run-error': [];
    done: [];
    'remove-setting': [id: string];
    'reset-settings': [];
    run: [];
    'update:zoneEditing': [value: boolean];
}>();
const {t} = useTypedI18n();
const normalizedPercent = computed(() => percent === null
    ? null
    : Math.min(100, Math.max(0, Math.round(percent))));
// A transition has no job yet, so its 0% is a placeholder rather than a
// measurement; the track pulses instead of promising a start it cannot show.
const meterIsIndeterminate = computed(() => normalizedPercent.value === null || transitionText !== '');
const PROGRESS_PHASE_IDS = [
    'analyze',
    'clean',
    'finish',
] as const;
const progressPhases = computed(() => {
    const currentIndex = PROGRESS_PHASE_IDS.indexOf(progressPhase);
    return PROGRESS_PHASE_IDS.map((id, index) => ({
        id,
        index: index + 1,
        label: t(`scanCleanup.progressPhases.${id}`),
        state: index < currentIndex
            ? 'complete' as const
            : index === currentIndex
                ? 'current' as const
                : 'upcoming' as const,
    }));
});
const progressStepText = computed(() => t('scanCleanup.runStep', {
    index: PROGRESS_PHASE_IDS.indexOf(progressPhase) + 1,
    count: PROGRESS_PHASE_IDS.length,
}));
const resolvedProgressEtaText = computed(() => progressEtaText === ''
    ? t('scanCleanup.etaPending')
    : progressEtaText);
const resolvedProgressEtaWidestText = computed(() => progressEtaWidestText === ''
    ? resolvedProgressEtaText.value
    : progressEtaWidestText);
// Cancelling detection is not destructive: pages already detected keep their
// results, so the control names that outcome instead of a bare “Cancel”.
const detectionCancelLabel = computed(() => t(detectionCancelRequested
    ? 'scanCleanup.detectAll.canceling'
    : 'scanCleanup.detectAll.cancelDetection'));
</script>

<style scoped>
.scan-cleanup-toolbar {
    display: grid;
    grid-template-columns:
        minmax(0, 1fr)
        minmax(0, var(--app-scan-toolbar-meter-width))
        minmax(0, 1fr);
    gap: var(--app-space-7xl);
    overflow: hidden;
    padding: var(--app-space-3xl) var(--app-space-7xl);
}

.scan-cleanup-toolbar-zone,
.scan-cleanup-toolbar-status-slot,
.scan-cleanup-toolbar-primary-slot {
    display: flex;
    min-width: 0;
    align-items: center;
}

.scan-cleanup-toolbar-zone-left {
    gap: var(--app-space-5xl);
    overflow: hidden;
}

.scan-cleanup-toolbar-zone-center {
    justify-content: center;
    gap: var(--app-space-5xl);
    overflow: hidden;
}

.scan-cleanup-toolbar-zone-right {
    justify-content: flex-end;
    gap: var(--app-space-3xl);
    overflow: hidden;
}

.scan-cleanup-toolbar-done {
    flex: none;
}

.scan-cleanup-toolbar-title {
    flex: none;
    color: var(--ui-text-highlighted);
    font-size: var(--app-text-size-body);
    font-weight: var(--app-font-weight-heading);
    white-space: nowrap;
}

.scan-cleanup-run-meter {
    display: flex;
    width: 100%;
    flex-direction: column;
    gap: var(--app-space-sm);
}

/* One sentence for the whole run: what is happening and how far on the left,
   which step and how long on the right. */
.scan-cleanup-run-meter-status {
    display: flex;
    min-width: 0;
    align-items: baseline;
    margin: 0;
    gap: var(--app-space-md);
    font-size: var(--app-text-size-body-sm);
    overflow: hidden;
    white-space: nowrap;
}

.scan-cleanup-run-meter-phase {
    min-width: 0;
    overflow: hidden;
    color: var(--ui-text-highlighted);
    font-weight: var(--app-font-weight-heading);
    text-overflow: ellipsis;
}

.scan-cleanup-run-meter-spacer {
    flex: 1;
}

.scan-cleanup-run-meter-separator {
    flex: none;
    color: var(--ui-text-dimmed);
}

.scan-cleanup-run-meter-count,
.scan-cleanup-run-meter-step,
.scan-cleanup-run-meter-eta {
    flex: none;
    color: var(--ui-text-muted);
}

.scan-cleanup-run-meter-status :deep(.scan-cleanup-stable-width-text) {
    justify-items: start;
}

/* One bar in three equal segments: finished segments are full, the current one
   fills, the rest are empty — the whole run reads at a glance. */
.scan-cleanup-run-segments {
    display: grid;
    padding: 0;
    margin: 0;
    gap: var(--app-space-xs);
    grid-template-columns: repeat(3, minmax(0, 1fr));
    list-style: none;
}

.scan-cleanup-run-segment {
    display: block;
    overflow: hidden;
    height: var(--app-scan-toolbar-progress-height);
    border-radius: var(--app-radius-full);
    background: var(--ui-border);
}

.scan-cleanup-run-segment-track {
    display: block;
    height: 100%;
}

.scan-cleanup-run-segment-fill {
    display: block;
    height: 100%;
    background: var(--ui-primary);
    transition: width var(--app-transition-standard);
}

.scan-cleanup-run-segment-fill--complete {
    width: 100%;
}

.scan-cleanup-run-segment-fill--indeterminate {
    width: 40%;
    animation: scan-cleanup-progress-indeterminate 1.5s ease-in-out infinite;
}

@keyframes scan-cleanup-progress-indeterminate {
    0% {
        transform: translateX(-100%);
    }

    100% {
        transform: translateX(350%);
    }
}

@media (prefers-reduced-motion: reduce) {
    .scan-cleanup-run-segment-fill--indeterminate {
        width: 100%;
        animation: none;
        opacity: var(--app-scan-toolbar-indeterminate-opacity);
    }
}

.scan-cleanup-toolbar-redetect {
    width: var(--app-scan-toolbar-redetect-width);
    flex: none;
    justify-content: center;
}

.scan-cleanup-toolbar-status-slot {
    width: var(--app-scan-toolbar-status-width);
    height: var(--app-control-height-xs);
    min-width: var(--app-scan-toolbar-status-width);
    flex: none;
    justify-content: flex-start;
    gap: var(--app-space-sm);
    overflow: hidden;
}

.scan-cleanup-toolbar-primary-slot {
    width: var(--app-scan-toolbar-primary-width);
    min-width: var(--app-scan-toolbar-primary-width);
    flex-direction: column;
    align-items: stretch;
    gap: var(--app-space-sm);
}

.scan-cleanup-toolbar-primary-action {
    width: 100%;
    justify-content: center;
}

.scan-cleanup-settings-badges {
    display: flex;
    min-width: 0;
    max-width: calc(var(--app-scan-toolbar-right-zone-width) * 3);
    flex-wrap: nowrap;
    align-items: center;
    justify-content: flex-end;
    overflow: hidden;
    gap: var(--app-space-xs);
}

.scan-cleanup-settings-badge {
    display: inline-flex;
    min-width: 0;
    flex: 0 1 auto;
    align-items: center;
    border: 1px solid var(--ui-border);
    border-radius: var(--app-radius-full);
    background: var(--ui-bg-muted);
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-kicker);
}

.scan-cleanup-settings-badge-label {
    overflow: hidden;
    padding-inline-start: var(--app-space-sm);
    text-overflow: ellipsis;
    white-space: nowrap;
}

.scan-cleanup-settings-badge-remove {
    flex: none;
}

.scan-cleanup-settings-reset {
    flex: none;
}

.scan-cleanup-toolbar-count {
    flex: none;
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-body-sm);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
}

.scan-cleanup-toolbar-estimate,
.scan-cleanup-toolbar-error,
.scan-cleanup-toolbar-status-placeholder {
    min-width: 0;
    overflow: hidden;
    font-size: var(--app-text-size-body-sm);
    text-overflow: ellipsis;
    white-space: nowrap;
}

.scan-cleanup-toolbar-estimate,
.scan-cleanup-toolbar-status-placeholder {
    color: var(--ui-text-muted);
}

.scan-cleanup-toolbar-error {
    color: var(--ui-error);
}

.scan-cleanup-toolbar-dismiss-error {
    flex: none;
}
</style>
