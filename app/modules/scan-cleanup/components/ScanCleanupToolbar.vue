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
                    :disabled="isRunning"
                    @click="emit('update:zoneEditing', !zoneEditing)"
                />
            </AppTooltip>
            <!-- Analysis and a run share this slot and its size, so clicking
                 Clean up while pages are analyzed continues the same meter. -->
            <div class="scan-cleanup-toolbar-main-slot">
                <ScanCleanupActivityMeter
                    v-if="meterVisible && activity"
                    :activity="activity"
                    :timeline="activityTimeline"
                    :notice="cancelStatusText"
                />
                <template v-else>
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
                            <AppTooltip :text="runError" usefulness="overflow">
                                <span class="scan-cleanup-toolbar-error" role="alert" tabindex="0">
                                    {{ runError }}
                                </span>
                            </AppTooltip>
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
                        <AppTooltip v-else-if="detectionError" :text="detectionError" usefulness="overflow">
                            <span class="scan-cleanup-toolbar-error" role="alert" tabindex="0">
                                {{ detectionError }}
                            </span>
                        </AppTooltip>
                        <span v-else-if="outputEstimate" class="scan-cleanup-toolbar-estimate">
                            {{ outputEstimate }}
                        </span>
                        <span v-else class="scan-cleanup-toolbar-status-placeholder" aria-hidden="true">&nbsp;</span>
                    </div>
                </template>
            </div>
            <div class="scan-cleanup-toolbar-trailing-slot">
                <AppTooltip v-if="meterVisible && isDetecting && !isRunning" :text="detectionCancelLabel" usefulness="always">
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
            </div>
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
                    :label="finishing ? t('scanCleanup.finishing') : cancelRequested ? t('scanCleanup.canceling') : t('scanCleanup.cancel')"
                    :disabled="cancelRequested || finishing"
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
import ScanCleanupActivityMeter from '@app/modules/scan-cleanup/components/ScanCleanupActivityMeter.vue';
import type {IScanCleanupActivityTimeline} from '@app/modules/scan-cleanup/composables/useScanCleanupActivityTimeline';
import type {IScanCleanupActivity} from '@app/modules/scan-cleanup/runtime/resolveScanCleanupActivity';
import {
    SCAN_CLEANUP_TOOLBAR_CANCEL_DETECTION_CLASS,
    SCAN_CLEANUP_TOOLBAR_PRIMARY_ACTION_CLASS,
} from '@contracts/scan-cleanup/toolbarSelectors';

const {
    activity = null,
    activityTimeline = null,
    canDetectAll,
    canRun,
    cancelRequested,
    cancelStatusText = '',
    detectionCancelRequested,
    detectionError,
    finishing = false,
    isDetecting,
    isRunning,
    outputEstimate,
    runError = '',
    runLabel,
    runDisabledReason,
    settingsBadges = [],
    zoneEditing,
} = defineProps<{
    activity?: IScanCleanupActivity | null;
    activityTimeline?: IScanCleanupActivityTimeline | null;
    canDetectAll: boolean;
    canRun: boolean;
    cancelRequested: boolean;
    cancelStatusText?: string;
    detectionCancelRequested: boolean;
    detectionError: string;
    finishing?: boolean;
    isDetecting: boolean;
    isRunning: boolean;
    outputEstimate: string;
    runError?: string;
    runLabel: string;
    runDisabledReason: string;
    settingsBadges?: ReadonlyArray<{
        id: string;
        label: string
    }>;
    zoneEditing?: boolean;
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
// A failed run stays readable until dismissed, even while analysis restarts.
const meterVisible = computed(() => activity !== null && (activity.run || runError === ''));
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

.scan-cleanup-toolbar-redetect {
    width: var(--app-scan-toolbar-redetect-width);
    flex: none;
    justify-content: center;
}

.scan-cleanup-toolbar-main-slot {
    display: flex;
    min-width: 0;
    flex: 0 1 var(--app-scan-toolbar-activity-width);
    align-items: center;
    gap: var(--app-space-5xl);
}

.scan-cleanup-toolbar-status-slot {
    height: var(--app-control-height-xs);
    flex: 1 1 auto;
    justify-content: flex-start;
    gap: var(--app-space-sm);
    overflow: hidden;
}

.scan-cleanup-toolbar-trailing-slot {
    display: flex;
    width: var(--app-control-height-xs);
    flex: none;
    align-items: center;
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
