<template>
    <UModal
        v-model:open="open"
        :title="t('optimizePdf.title')"
        :ui="{ footer: 'justify-end gap-2' }"
    >
        <template #description>
            <span class="sr-only">
                {{ t('optimizePdf.dialogDescription') }}
            </span>
        </template>

        <template #body>
            <div class="flex flex-col gap-4">
                <URadioGroup
                    v-model="preset"
                    :legend="t('optimizePdf.presetLabel')"
                    :items="presetOptions"
                    :ui="radioGroupUi"
                    :disabled="isRunning"
                />

                <div class="optimize-status-slot">
                    <UAlert
                        color="warning"
                        variant="soft"
                        icon="i-ph-warning-circle"
                        :description="t('optimizePdf.flattenWarning')"
                        :class="{invisible: !selectedPresetDestructive || isRunning || Boolean(progress)}"
                        :aria-hidden="selectedPresetDestructive && !isRunning && !progress
                            ? undefined
                            : 'true'"
                    />

                    <div
                        class="flex flex-col gap-2"
                        :class="{invisible: !isRunning && !progress}"
                        :aria-hidden="isRunning || progress ? undefined : 'true'"
                    >
                        <div class="flex items-center justify-between gap-3 text-xs text-muted">
                            <span>
                                {{ progressStatus }}
                                <span v-if="phaseClock" class="tabular-nums">{{ phaseClock }}</span>
                            </span>
                            <span>{{ progressPercentLabel }}</span>
                        </div>
                        <UProgress
                            color="primary"
                            size="md"
                            :max="100"
                            :model-value="progressPercent"
                            :ui="progressUi"
                        />
                    </div>
                </div>

                <AppFailureAlert
                    v-if="error"
                    :presentation="error"
                    icon="i-ph-warning-circle"
                />
            </div>
        </template>

        <template #footer>
            <UButton
                color="neutral"
                variant="outline"
                :label="t('common.cancel')"
                :disabled="isRunning"
                @click="open = false"
            />
            <UButton
                color="primary"
                class="justify-center"
                :disabled="isRunning"
                @click="handleSubmit"
            >
                <span class="inline-flex items-center justify-center gap-2">
                    <UIcon
                        :name="isRunning ? 'i-ph-circle-notch' : 'i-ph-gauge'"
                        :class="[
                            'size-4 shrink-0',
                            isRunning ? 'animate-spin' : '',
                        ]"
                        aria-hidden="true"
                    />
                    <span>{{ t('optimizePdf.saveCopyAction') }}</span>
                </span>
            </UButton>
        </template>
    </UModal>
</template>

<script setup lang="ts">
import AppFailureAlert from '@app/components/AppFailureAlert.vue';
import type {FailurePresentation} from '@app/composables/useFailureToast';
import { useStageElapsedClock } from '@app/composables/useStageElapsedClock';
import type {
    IPdfOptimizeOptions,
    IPdfOptimizeProgress,
    TPdfOptimizePreset,
} from '@contracts/electronApiDocuments';

const open = defineModel<boolean>('open', { required: true });

const {
    error,
    isRunning,
    progress,
} = defineProps<{
    isRunning: boolean;
    progress: IPdfOptimizeProgress | null;
    error: FailurePresentation | null;
}>();

const emit = defineEmits<{submit: [payload: IPdfOptimizeOptions];}>();
const { t } = useTypedI18n();

const preset = ref<TPdfOptimizePreset>('balancedScanned');

const radioGroupUi = {
    fieldset: 'gap-y-2',
    legend: 'mb-0.5 text-xs text-muted font-normal',
    item: 'items-start',
    label: 'font-normal',
    description: 'text-xs',
} as const;
const progressUi = {
    base: 'bg-elevated',
    indicator: 'duration-200',
} as const;

const presetOptions = computed(() => [
    {
        value: 'lossless',
        label: t('optimizePdf.presets.lossless.label'),
        description: t('optimizePdf.presets.lossless.description'),
    },
    {
        value: 'balancedScanned',
        label: t('optimizePdf.presets.balancedScanned.label'),
        description: t('optimizePdf.presets.balancedScanned.description'),
    },
    {
        value: 'smallScanned',
        label: t('optimizePdf.presets.smallScanned.label'),
        description: t('optimizePdf.presets.smallScanned.description'),
    },
    {
        value: 'blackAndWhite',
        label: t('optimizePdf.presets.blackAndWhite.label'),
        description: t('optimizePdf.presets.blackAndWhite.description'),
    },
] satisfies Array<{
    value: TPdfOptimizePreset;
    label: string;
    description: string;
}>);

const selectedPresetDestructive = computed(() => preset.value !== 'lossless');

// Stages without a page count still show movement: their elapsed time.
const phaseClock = useStageElapsedClock(
    () => (isRunning ? progress?.phase ?? 'preparing' : null),
    new Set<IPdfOptimizeProgress['phase']>([
        'preparing',
        'optimizing',
        'validating',
    ]),
);
const progressPercent = computed(() => progress?.percent ?? 0);
const progressPercentLabel = computed(() => `${Math.max(0, Math.min(100, progressPercent.value))}%`);
const progressStatus = computed(() => {
    if (!progress) {
        return t('optimizePdf.progress.preparing');
    }

    switch (progress.phase) {
        case 'preparing':
            return t('optimizePdf.progress.preparing');
        case 'rendering':
            return t('optimizePdf.progress.rendering');
        case 'assembling':
            return t('optimizePdf.progress.assembling');
        case 'optimizing':
            return t('optimizePdf.progress.optimizing');
        case 'validating':
            return t('optimizePdf.progress.validating');
        case 'complete':
            return t('optimizePdf.progress.complete');
    }
});

function handleSubmit() {
    if (isRunning) {
        return;
    }

    emit('submit', { preset: preset.value });
}
</script>

<style scoped>
.optimize-status-slot {
    display: grid;
}

.optimize-status-slot > * {
    grid-area: 1 / 1;
}
</style>
