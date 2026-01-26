<template>
    <nav class="stage-navigation" role="tablist" aria-label="Processing stages">
        <button
            v-for="stage in stages"
            :key="stage.id"
            class="stage-tab"
            :class="{
                'is-active': currentStage === stage.id,
                'is-disabled': isStageDisabled(stage.id),
                'is-complete': stageStatuses[stage.id] === 'complete',
                'is-error': stageStatuses[stage.id] === 'error',
            }"
            role="tab"
            :aria-selected="currentStage === stage.id"
            :aria-disabled="isStageDisabled(stage.id)"
            :disabled="isStageDisabled(stage.id)"
            :title="getStageTooltip(stage.id)"
            @click="handleSelect(stage.id)"
        >
            <span class="stage-icon">
                <UIcon
                    v-if="stageStatuses[stage.id] === 'complete'"
                    name="i-lucide-check"
                    class="size-4 stage-status-icon"
                />
                <UIcon
                    v-else-if="stageStatuses[stage.id] === 'error'"
                    name="i-lucide-circle-alert"
                    class="size-4 stage-status-icon"
                />
                <UIcon
                    v-else
                    :name="stage.icon"
                    class="size-4"
                />
            </span>
            <span class="stage-label">{{ stage.label }}</span>
        </button>
    </nav>
</template>

<script setup lang="ts">
import type {
    TProcessingStage,
    TStageStatus,
} from '@app/types/page-processing';

interface IStageConfig {
    id: TProcessingStage;
    label: string;
    icon: string;
    prerequisite?: TProcessingStage;
}

interface IProps {
    currentStage: TProcessingStage;
    stageStatuses: Record<TProcessingStage, TStageStatus>;
}

const props = defineProps<IProps>();

const emit = defineEmits<{(e: 'select', stage: TProcessingStage): void;}>();

const stages: IStageConfig[] = [
    {
        id: 'rotation',
        label: 'Rotation',
        icon: 'i-lucide-refresh-cw', 
    },
    {
        id: 'split',
        label: 'Split',
        icon: 'i-lucide-move-vertical', 
    },
    {
        id: 'deskew',
        label: 'Deskew',
        icon: 'i-lucide-scaling', 
    },
    {
        id: 'content',
        label: 'Content',
        icon: 'i-lucide-layout-grid', 
    },
    {
        id: 'margins',
        label: 'Margins',
        icon: 'i-lucide-move-horizontal', 
    },
    {
        id: 'output',
        label: 'Output',
        icon: 'i-lucide-file-text', 
    },
];

const stageOrder: TProcessingStage[] = [
    'rotation',
    'split',
    'deskew',
    'content',
    'margins',
    'output',
];

function isStageDisabled(stageId: TProcessingStage): boolean {
    const targetIndex = stageOrder.indexOf(stageId);

    for (let i = 0; i < targetIndex; i++) {
        const prerequisiteStage = stageOrder[i];
        if (prerequisiteStage) {
            const status = props.stageStatuses[prerequisiteStage];
            if (status === 'error') {
                return true;
            }
        }
    }

    return false;
}

function getStageTooltip(stageId: TProcessingStage): string {
    if (isStageDisabled(stageId)) {
        return 'Complete previous stages first';
    }

    const status = props.stageStatuses[stageId];
    if (status === 'complete') {
        return 'Stage complete';
    }
    if (status === 'error') {
        return 'Stage has errors';
    }

    return '';
}

function handleSelect(stageId: TProcessingStage) {
    if (!isStageDisabled(stageId)) {
        emit('select', stageId);
    }
}
</script>

<style scoped>
.stage-navigation {
    display: flex;
    border-bottom: 1px solid var(--ui-border);
    padding: 0 12px;
    gap: 4px;
    overflow-x: auto;
}

.stage-tab {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 12px 16px;
    border: none;
    background: none;
    color: var(--ui-text-muted);
    font-size: 0.8125rem;
    font-weight: 500;
    cursor: pointer;
    white-space: nowrap;
    position: relative;
    transition: color 0.15s, background-color 0.15s;
}

.stage-tab::after {
    content: '';
    position: absolute;
    bottom: -1px;
    left: 0;
    right: 0;
    height: 2px;
    background-color: transparent;
    transition: background-color 0.15s;
}

.stage-tab:hover:not(.is-disabled) {
    color: var(--ui-text);
    background-color: var(--ui-bg-muted);
}

.stage-tab.is-active {
    color: var(--ui-primary);
}

.stage-tab.is-active::after {
    background-color: var(--ui-primary);
}

.stage-tab.is-disabled {
    color: var(--ui-text-dimmed);
    cursor: not-allowed;
    opacity: 0.5;
}

.stage-tab.is-complete .stage-status-icon {
    color: var(--ui-success);
}

.stage-tab.is-error .stage-status-icon {
    color: var(--ui-error);
}

.stage-icon {
    display: flex;
    align-items: center;
    justify-content: center;
}

.stage-label {
    display: none;
}

@media (width >= 768px) {
    .stage-label {
        display: inline;
    }
}
</style>
