<template>
    <div
        class="scan-cleanup-activity"
        :class="{[SCAN_CLEANUP_RUN_METER_CLASS]: activity.run}"
        :data-phase="activity.phase"
        :data-step="activity.step"
    >
        <span class="sr-only" role="status" aria-live="polite">{{ announcedSentence }}</span>
        <UPopover
            v-model:open="detailsOpen"
            portal="body"
            :content="{side: 'bottom', align: 'center', sideOffset: 6}"
        >
            <button
                type="button"
                class="scan-cleanup-activity-trigger"
                :aria-label="t('scanCleanup.activity.showDetails', {status: statusSentence})"
            >
                <span class="scan-cleanup-activity-phase">{{ t(`scanCleanup.activity.phase.${activity.phase}`) }}</span>
                <UIcon name="i-ph-caret-right" class="scan-cleanup-activity-separator" aria-hidden="true" />
                <span class="scan-cleanup-activity-detail">{{ notice || detailText }}</span>
                <template v-if="countText">
                    <span class="scan-cleanup-activity-dot" aria-hidden="true">·</span>
                    <!-- The label carries the current count alone; the text also
                         holds the reserved widest count. -->
                    <ScanCleanupStableWidthText
                        class="scan-cleanup-activity-count"
                        :class="{[SCAN_CLEANUP_TOOLBAR_COUNT_CLASS]: !activity.run}"
                        :aria-label="countText"
                        :text="countText"
                        :widest="countWidestText"
                    />
                </template>
                <span class="scan-cleanup-activity-spacer" aria-hidden="true" />
                <ScanCleanupStableWidthText
                    class="scan-cleanup-activity-time"
                    :text="timeText"
                    :widest="timeWidestText"
                />
                <UIcon
                    name="i-ph-caret-down"
                    class="scan-cleanup-activity-caret"
                    :class="{'is-open': detailsOpen}"
                    aria-hidden="true"
                />
            </button>
            <template #content>
                <section class="scan-cleanup-activity-details" :aria-label="t('scanCleanup.activity.title')">
                    <header class="scan-cleanup-activity-details-header">
                        <strong>{{ t('scanCleanup.activity.title') }}</strong>
                        <span v-if="totalElapsedText">{{ totalElapsedText }}</span>
                    </header>
                    <section
                        v-for="group in stepGroups"
                        :key="group.phase"
                        class="scan-cleanup-activity-phase-group"
                        :data-phase="group.phase"
                    >
                        <h3 class="scan-cleanup-activity-phase-heading">
                            <span>{{ t(`scanCleanup.progressPhases.${group.phase}`) }}</span>
                            <span v-if="group.note" class="scan-cleanup-activity-phase-note">{{ group.note }}</span>
                        </h3>
                        <ol class="scan-cleanup-activity-steps">
                            <li
                                v-for="step in group.steps"
                                :key="step.id"
                                class="scan-cleanup-activity-step"
                                :data-step="step.id"
                                :data-state="step.state"
                                :aria-current="step.id === activity.step ? 'step' : undefined"
                            >
                                <UIcon
                                    :name="STEP_ICONS[step.state]"
                                    class="scan-cleanup-activity-step-icon"
                                    :class="{'is-spinning': step.state === 'active'}"
                                    :aria-label="t(`scanCleanup.activity.stepState.${step.state}`)"
                                />
                                <span class="scan-cleanup-activity-step-label">{{ t(`scanCleanup.activity.step.${step.id}`) }}</span>
                                <span class="scan-cleanup-activity-step-count">{{ step.countText }}</span>
                                <span class="scan-cleanup-activity-step-time">{{ step.timeText }}</span>
                                <span class="scan-cleanup-activity-step-hint">{{ t(`scanCleanup.activity.stepHint.${step.id}`) }}</span>
                            </li>
                        </ol>
                    </section>
                </section>
            </template>
        </UPopover>
        <span
            class="scan-cleanup-activity-rail"
            role="progressbar"
            :aria-label="t('scanCleanup.progressPhases.label')"
            aria-valuemin="0"
            aria-valuemax="100"
            :aria-valuenow="activity.fraction === null ? undefined : Math.round(activity.fraction * 100)"
            :aria-valuetext="announcedSentence"
        >
            <span
                v-for="segment in segments"
                :key="segment.phase"
                class="scan-cleanup-activity-segment"
                :data-phase="segment.phase"
                :data-state="segment.state"
            >
                <span
                    v-if="segment.bufferWidth"
                    class="scan-cleanup-activity-buffer"
                    :style="{width: segment.bufferWidth}"
                />
                <span
                    v-if="segment.state !== 'waiting'"
                    class="scan-cleanup-activity-fill"
                    :class="{
                        'is-indeterminate': segment.indeterminate,
                        'is-settling': segment.settling,
                    }"
                    :style="segment.indeterminate ? undefined : {width: segment.fillWidth}"
                />
            </span>
        </span>
    </div>
</template>

<script setup lang="ts">
import {useNow} from '@vueuse/core';
import ScanCleanupStableWidthText from '@app/modules/scan-cleanup/components/ScanCleanupStableWidthText.vue';
import type {IScanCleanupActivityTimeline} from '@app/modules/scan-cleanup/composables/useScanCleanupActivityTimeline';
import {
    formatScanCleanupActivityCount,
    formatScanCleanupActivityStatus,
    formatScanCleanupDuration,
    formatScanCleanupEta,
    resolveScanCleanupTimeWidestText,
} from '@app/modules/scan-cleanup/runtime/formatScanCleanupProgress';
import {
    type IScanCleanupActivity,
    SCAN_CLEANUP_ACTIVITY_PHASES,
    type TScanCleanupActivityStepState,
} from '@app/modules/scan-cleanup/runtime/resolveScanCleanupActivity';
import {
    SCAN_CLEANUP_RUN_METER_CLASS,
    SCAN_CLEANUP_TOOLBAR_COUNT_CLASS,
} from '@contracts/scan-cleanup/toolbarSelectors';

const {
    activity,
    timeline = null,
    notice = '',
} = defineProps<{
    activity: IScanCleanupActivity;
    timeline?: IScanCleanupActivityTimeline | null;
    /** Replaces the activity sentence, such as a refused cancellation. */
    notice?: string;
}>();
const {t} = useTypedI18n();
const detailsOpen = ref(false);
const now = useNow({interval: 1000});

const STEP_ICONS: Record<TScanCleanupActivityStepState, string> = {
    done: 'i-ph-check-circle',
    active: 'i-ph-circle-notch',
    waiting: 'i-ph-circle',
};

const detailText = computed(() => t(`scanCleanup.activity.detail.${activity.detail}`));
const countText = computed(() => activity.count === null
    ? ''
    : formatScanCleanupActivityCount(activity.count, t));
const countWidestText = computed(() => activity.count === null || activity.count.total === undefined
    ? countText.value
    : formatScanCleanupActivityCount({
        completed: activity.count.total,
        total: activity.count.total,
    }, t));
function elapsedSince(startedAtMs: number | undefined, endedAtMs?: number) {
    return startedAtMs === undefined
        ? ''
        : formatScanCleanupDuration((endedAtMs ?? now.value.getTime()) - startedAtMs);
}
// The job's own estimate when it has measured enough work; otherwise how long
// the current step has been running, so a step that reports no counts still
// visibly moves.
const timeText = computed(() => {
    if (activity.etaSeconds !== undefined) {
        return formatScanCleanupEta(activity.etaSeconds, t);
    }
    const elapsed = elapsedSince(timeline?.steps[activity.step]?.startedAtMs);
    return elapsed === '' ? '' : t('scanCleanup.activity.elapsed', {time: elapsed});
});
const timeWidestText = computed(() => resolveScanCleanupTimeWidestText(t));
// What assistive tech announces: phase, step and count. The clock is left out
// so a ticking time does not produce an announcement every second.
const announcedSentence = computed(() => [
    t(`scanCleanup.progressPhases.${activity.phase}`),
    notice || formatScanCleanupActivityStatus(activity, t),
].join('. '));
const statusSentence = computed(() => [
    announcedSentence.value,
    timeText.value,
].filter(Boolean).join('. '));
const totalElapsedText = computed(() => timeline === null
    ? ''
    : t('scanCleanup.activity.totalElapsed', {time: elapsedSince(timeline.startedAtMs)}));

const segments = computed(() => {
    const currentIndex = SCAN_CLEANUP_ACTIVITY_PHASES.indexOf(activity.phase);
    return SCAN_CLEANUP_ACTIVITY_PHASES.map((phase, index) => {
        const state = index < currentIndex ? 'done' as const : index === currentIndex ? 'active' as const : 'waiting' as const;
        const current = state === 'active';
        return {
            phase,
            state,
            indeterminate: current && activity.fraction === null,
            // Every page has a verdict and the document-wide pass is running.
            settling: current && activity.step === 'compare',
            fillWidth: `${String(state === 'done' ? 100 : Math.round((activity.fraction ?? 0) * 1000) / 10)}%`,
            bufferWidth: current && activity.bufferFraction > (activity.fraction ?? 0)
                ? `${String(Math.round(activity.bufferFraction * 1000) / 10)}%`
                : '',
        };
    });
});

const stepGroups = computed(() => SCAN_CLEANUP_ACTIVITY_PHASES.map(phase => ({
    phase,
    // Before Clean up is pressed, the run's phases are what happens next, not
    // work that has stalled.
    note: phase !== 'analyze' && !activity.run ? t('scanCleanup.activity.runStartsLater') : '',
    steps: activity.steps.filter(step => step.phase === phase).map(step => {
        const timing = timeline?.steps[step.id];
        return {
            ...step,
            countText: step.count === undefined ? '' : formatScanCleanupActivityCount(step.count, t),
            timeText: step.state === 'waiting' ? '' : elapsedSince(timing?.startedAtMs, timing?.endedAtMs),
        };
    }),
})));
</script>

<style scoped>
.scan-cleanup-activity {
    display: flex;
    width: 100%;
    min-width: 0;
    flex-direction: column;
    gap: var(--app-space-xs);
}

/* One sentence: which phase, what is happening in it, how far and how long.
   The whole line opens the step list. */
.scan-cleanup-activity-trigger {
    display: flex;
    min-width: 0;
    align-items: center;
    padding: 0 var(--app-space-xs);
    border: 0;
    border-radius: var(--app-radius-sm);
    margin: 0 calc(var(--app-space-xs) * -1);
    background: transparent;
    color: var(--ui-text-muted);
    cursor: pointer;
    font: inherit;
    font-size: var(--app-text-size-body-sm);
    gap: var(--app-space-md);
    text-align: start;
    white-space: nowrap;
}

.scan-cleanup-activity-trigger:hover {
    background: var(--ui-bg-elevated);
}

.scan-cleanup-activity-trigger:focus-visible {
    outline: 2px solid var(--ui-primary);
    outline-offset: 1px;
}

.scan-cleanup-activity-phase {
    flex: none;
    color: var(--ui-text-dimmed);
}

.scan-cleanup-activity-separator {
    flex: none;
    color: var(--ui-text-dimmed);
}

.scan-cleanup-activity-detail {
    min-width: 0;
    overflow: hidden;
    color: var(--ui-text-highlighted);
    font-weight: var(--app-font-weight-heading);
    text-overflow: ellipsis;
}

.scan-cleanup-activity-dot {
    flex: none;
    color: var(--ui-text-dimmed);
}

.scan-cleanup-activity-count,
.scan-cleanup-activity-time {
    flex: none;
    font-variant-numeric: tabular-nums;
}

.scan-cleanup-activity-spacer {
    flex: 1;
}

.scan-cleanup-activity-caret {
    flex: none;
    color: var(--ui-text-dimmed);
    transition: transform var(--app-transition-standard);
}

.scan-cleanup-activity-caret.is-open {
    transform: rotate(180deg);
}

.scan-cleanup-activity :deep(.scan-cleanup-stable-width-text) {
    justify-items: start;
}

/* The three phases of a cleanup as one bar. A finished phase is full, the
   current one fills with pages done and shows work read ahead of it, the
   rest wait. */
.scan-cleanup-activity-rail {
    display: grid;
    gap: var(--app-space-xs);
    grid-template-columns: 3fr 3fr 1fr;
}

.scan-cleanup-activity-segment {
    position: relative;
    display: block;
    overflow: hidden;
    height: var(--app-scan-toolbar-progress-height);
    border-radius: var(--app-radius-full);
    background: var(--ui-border);
}

.scan-cleanup-activity-buffer,
.scan-cleanup-activity-fill {
    position: absolute;
    inset: 0 auto 0 0;
    display: block;
    transition: width var(--app-transition-standard);
}

.scan-cleanup-activity-buffer {
    background: var(--ui-primary);
    opacity: var(--app-scan-toolbar-buffer-opacity);
}

.scan-cleanup-activity-fill {
    background: var(--ui-primary);
}

.scan-cleanup-activity-segment[data-state='done'] .scan-cleanup-activity-fill {
    width: 100%;
}

.scan-cleanup-activity-fill.is-indeterminate {
    width: 40%;
    animation: scan-cleanup-activity-indeterminate 1.5s ease-in-out infinite;
}

.scan-cleanup-activity-fill.is-settling {
    animation: scan-cleanup-activity-settling 1.5s ease-in-out infinite alternate;
}

@keyframes scan-cleanup-activity-indeterminate {
    0% {
        transform: translateX(-100%);
    }

    100% {
        transform: translateX(350%);
    }
}

@keyframes scan-cleanup-activity-settling {
    0% {
        opacity: 1;
    }

    100% {
        opacity: var(--app-scan-toolbar-indeterminate-opacity);
    }
}

@media (prefers-reduced-motion: reduce) {
    .scan-cleanup-activity-fill.is-indeterminate {
        width: 100%;
        animation: none;
        opacity: var(--app-scan-toolbar-indeterminate-opacity);
    }

    .scan-cleanup-activity-fill.is-settling {
        animation: none;
    }
}

.scan-cleanup-activity-details {
    display: flex;
    width: var(--app-scan-activity-details-width);
    max-width: calc(100vw - var(--app-space-7xl) * 2);
    flex-direction: column;
    padding: var(--app-space-5xl) var(--app-space-7xl);
    font-size: var(--app-text-size-body-sm);
    gap: var(--app-space-5xl);
}

.scan-cleanup-activity-details-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    color: var(--ui-text-highlighted);
    gap: var(--app-space-5xl);
}

.scan-cleanup-activity-details-header span {
    color: var(--ui-text-muted);
    font-variant-numeric: tabular-nums;
}

.scan-cleanup-activity-phase-group {
    display: flex;
    flex-direction: column;
    gap: var(--app-space-sm);
}

.scan-cleanup-activity-phase-heading {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin: 0;
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-kicker);
    font-weight: var(--app-font-weight-heading);
    gap: var(--app-space-5xl);
    letter-spacing: var(--app-letter-spacing-caps);
    text-transform: uppercase;
}

.scan-cleanup-activity-phase-note {
    color: var(--ui-text-dimmed);
    font-weight: normal;
    letter-spacing: normal;
    text-transform: none;
}

.scan-cleanup-activity-steps {
    display: flex;
    flex-direction: column;
    padding: 0;
    margin: 0;
    gap: var(--app-space-md);
    list-style: none;
}

.scan-cleanup-activity-step {
    display: grid;
    align-items: center;
    column-gap: var(--app-space-md);
    grid-template-columns: auto minmax(0, 1fr) auto var(--app-scan-activity-time-width);
}

.scan-cleanup-activity-step-icon {
    color: var(--ui-text-dimmed);
}

.scan-cleanup-activity-step[data-state='done'] .scan-cleanup-activity-step-icon {
    color: var(--ui-success);
}

.scan-cleanup-activity-step[data-state='active'] .scan-cleanup-activity-step-icon {
    color: var(--ui-primary);
}

.scan-cleanup-activity-step-label {
    color: var(--ui-text);
}

.scan-cleanup-activity-step[data-state='waiting'] .scan-cleanup-activity-step-label {
    color: var(--ui-text-muted);
}

.scan-cleanup-activity-step[aria-current='step'] .scan-cleanup-activity-step-label {
    color: var(--ui-text-highlighted);
    font-weight: var(--app-font-weight-heading);
}

.scan-cleanup-activity-step-count,
.scan-cleanup-activity-step-time {
    color: var(--ui-text-muted);
    font-variant-numeric: tabular-nums;
    text-align: end;
    white-space: nowrap;
}

.scan-cleanup-activity-step-hint {
    color: var(--ui-text-dimmed);
    font-size: var(--app-text-size-caption);
    grid-column: 2 / -1;
}
</style>
