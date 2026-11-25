<template>
    <header
        class="toolbar scan-cleanup-toolbar"
        :aria-label="t('scanCleanup.workspaceTitle')"
    >
        <div class="scan-cleanup-toolbar-zone scan-cleanup-toolbar-zone-left">
            <!-- On a phone the toolbar buttons show only their icons; the
                 name stays for assistive tech and the tooltip says it. -->
            <AppTooltip :text="t('scanCleanup.done')" usefulness="no-text">
                <UButton
                    class="scan-cleanup-toolbar-done"
                    type="button"
                    color="neutral"
                    variant="ghost"
                    size="sm"
                    icon="i-ph-caret-left"
                    :label="t('scanCleanup.done')"
                    :aria-label="t('scanCleanup.done')"
                    @click="emit('done')"
                />
            </AppTooltip>
            <AppTooltip :text="t('scanCleanup.description')" usefulness="always">
                <h2 class="scan-cleanup-toolbar-title">{{ t('scanCleanup.workspaceTitle') }}</h2>
            </AppTooltip>
        </div>

        <div class="scan-cleanup-toolbar-zone scan-cleanup-toolbar-zone-center">
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
                        <!-- A disabled button shows no tooltip, so the reason it is
                             disabled is said where the estimate would be. -->
                        <span
                            v-else-if="!canRun && runDisabledReason"
                            class="scan-cleanup-toolbar-estimate"
                            data-run-disabled-reason
                        >{{ runDisabledReason }}</span>
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
            <div class="scan-cleanup-toolbar-primary-slot">
                <AppTooltip v-if="isRunning" :text="cancelLabel" usefulness="no-text">
                    <UButton
                        :class="[SCAN_CLEANUP_TOOLBAR_PRIMARY_ACTION_CLASS, 'scan-cleanup-toolbar-cancel-run', {'is-canceling': cancelRequested && !finishing}]"
                        type="button"
                        color="neutral"
                        variant="outline"
                        size="sm"
                        :icon="cancelRequested || finishing ? 'i-ph-circle-notch' : 'i-ph-x'"
                        :label="cancelLabel"
                        :aria-label="cancelLabel"
                        :disabled="cancelRequested || finishing"
                        @click="emit('cancel')"
                    />
                </AppTooltip>
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
                        :aria-label="runLabel"
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
} = defineProps<{
    activity?: IScanCleanupActivity | null;
    activityTimeline?: IScanCleanupActivityTimeline | null;
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
}>();
const emit = defineEmits<{
    cancel: [];
    'cancel-detection': [];
    'dismiss-run-error': [];
    done: [];
    run: [];
}>();
const {t} = useTypedI18n();
// A failed run stays readable until dismissed, even while analysis restarts.
const meterVisible = computed(() => activity !== null && (activity.run || runError === ''));
// Cancelling detection is not destructive: pages already detected keep their
// results, so the control names that outcome instead of a bare “Cancel”.
const cancelLabel = computed(() => t(finishing
    ? 'scanCleanup.finishing'
    : cancelRequested ? 'scanCleanup.canceling' : 'scanCleanup.cancel'));
const detectionCancelLabel = computed(() => t(detectionCancelRequested
    ? 'scanCleanup.detectAll.canceling'
    : 'scanCleanup.detectAll.cancelDetection'));
</script>

<style scoped>
.scan-cleanup-toolbar {
    display: grid;

    /* One row, as tall as the reader's, so switching tabs leaves the tab
       strip in place. The sides never shrink below Done and the primary
       action (#967, #976); the meter takes the rest and its text yields. */
    grid-template-columns:
        minmax(min-content, 1fr)
        minmax(0, var(--app-scan-toolbar-meter-width))
        minmax(min-content, 1fr);
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
    position: relative;
    z-index: var(--app-z-floating-chrome);
    flex-wrap: nowrap;
    justify-content: flex-end;
    gap: var(--app-space-3xl);
    overflow: visible;
}

.scan-cleanup-toolbar-done {
    flex: none;
}

/* The title adds nothing to the side's minimum, so it is the first text
   to yield in a narrow window. */
.scan-cleanup-toolbar-title {
    width: 0;
    min-width: 0;
    flex-grow: 1;
    overflow: hidden;
    color: var(--ui-text-highlighted);
    font-size: var(--app-text-size-body);
    font-weight: var(--app-font-weight-heading);
    text-overflow: ellipsis;
    white-space: nowrap;
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
    justify-content: center;
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

/* The running Cancel shows its icon only where its label is hidden. */
@media (width >= 37.5rem) {
    .scan-cleanup-toolbar-cancel-run :deep([data-slot='leadingIcon']) {
        display: none;
    }
}

/* Canceling has no notice in the meter, so on a phone too the disabled
   Cancel says “Canceling…” in words. */
.scan-cleanup-toolbar-cancel-run.is-canceling :deep([data-slot='leadingIcon']) {
    display: none;
}

/* On a phone the buttons keep their icons and give the meter the width, so
   the bar stays one row, as tall as the reader's. */
@media (width < 37.5rem) {
    .scan-cleanup-toolbar {
        gap: var(--app-space-sm);
    }

    .scan-cleanup-toolbar-title,
    .scan-cleanup-toolbar-trailing-slot:empty {
        display: none;
    }

    .scan-cleanup-toolbar-done :deep([data-slot='label']),
    .scan-cleanup-toolbar-primary-action:not(.is-canceling) :deep([data-slot='label']) {
        display: none;
    }

    .scan-cleanup-toolbar-primary-slot {
        width: auto;
        min-width: 0;
    }
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
