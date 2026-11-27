<template>
    <AppTooltip :text="triggerDetail" :content="{ side: 'top' }" :disabled="open">
        <UPopover v-model:open="open" :content="{ side: 'top', align: 'start', sideOffset: 6, collisionPadding: 12 }">
            <button type="button" class="picker-trigger" data-model-picker-trigger :aria-label="triggerDetail">
                <AssistantProviderIcon v-if="selectedInstance" class="trigger-icon" :provider="selectedInstance.driver" :badge="instanceBadge(selectedInstance, instances)" />
                <span class="trigger-model">{{ selectedModel?.shortLabel ?? selectedModel?.label ?? selection?.model ?? t('assistant.selectInstance') }}</span>
                <span v-if="effortLabel || isFast" class="trigger-traits">
                    <span v-if="effortLabel" class="trigger-effort">{{ effortLabel }}</span>
                    <UIcon v-if="isFast" name="i-ph-lightning-fill" class="trigger-fast" />
                </span>
            </button>
            <template #content>
                <div class="model-picker" data-model-picker>
                    <div class="picker-body">
                        <AssistantModelPickerContent ref="content" :instances="instances" :selection="selection" @pick="pickModel" @focus-effort="effortColumn?.focusLevel()" @close="open = false" />
                        <AssistantModelEffortColumn ref="effortColumn" :model="selectedModel" :model-label="selectedModel?.shortLabel ?? selectedModel?.label ?? ''" :effort="selection?.effort ?? ''" @pick="pickEffort" @back="content?.focusSearch()" />
                    </div>
                    <div v-if="supportsFast" class="picker-footer">
                        <div ref="speedControl" class="speed-control" role="radiogroup" :aria-label="t('assistant.speedMode')" @keydown="handleSpeedKeydown">
                            <button v-for="speed in speeds" :key="speed.id" type="button" role="radio" class="speed-segment" :aria-checked="currentSpeed === speed.id" :tabindex="currentSpeed === speed.id ? 0 : -1" @click="pickSpeed(speed.id)">
                                <UIcon v-if="speed.id === 'fast'" name="i-ph-lightning-fill" class="speed-icon" />
                                {{ t(speed.key) }}
                            </button>
                        </div>
                    </div>
                </div>
            </template>
        </UPopover>
    </AppTooltip>
</template>

<script setup lang="ts">
import type {
    IAssistantInstanceStatus, IAssistantSelection,
} from '@contracts/assistant';
import { resolveAssistantSelection } from '@app/modules/agent-panel/utils/assistantSelectionPreference';
import { instanceBadge } from '@app/modules/agent-panel/utils/assistantModelPicker';
import AssistantProviderIcon from '@app/modules/agent-panel/components/AssistantProviderIcon.vue';
import AssistantModelPickerContent from '@app/modules/agent-panel/components/AssistantModelPickerContent.vue';
import AssistantModelEffortColumn from '@app/modules/agent-panel/components/AssistantModelEffortColumn.vue';
import { useTypedI18n } from '@app/composables/useTypedI18n';

const {
    instances,
    selection,
} = defineProps<{
    instances: IAssistantInstanceStatus[];
    selection: IAssistantSelection | null;
}>();
const emit = defineEmits<{ select: [selection: IAssistantSelection] }>();
const { t } = useTypedI18n();
const open = ref(false);
const content = ref<InstanceType<typeof AssistantModelPickerContent> | null>(null);
const effortColumn = ref<InstanceType<typeof AssistantModelEffortColumn> | null>(null);
const selectedInstance = computed(() => instances.find(instance => instance.id === selection?.instanceId));
const selectedModel = computed(() => selectedInstance.value?.models.find(model => model.id === selection?.model));
const supportsFast = computed(() => selectedModel.value?.serviceTiers?.some(tier => tier.id === 'fast' || tier.id === 'priority') === true);
const isFast = computed(() => supportsFast.value && selection?.speedMode === 'fast');
const effortLabel = computed(() => selectedModel.value?.reasoningEfforts?.find(option => option.id === selection?.effort)?.label ?? '');
const speeds = [
    {
        id: 'standard',
        key: 'assistant.speedStandard',
    },
    {
        id: 'fast',
        key: 'assistant.speedFast',
    },
] as const;
// The tooltip and screen readers name what the trigger abbreviates: instance, full model, effort and speed.
const triggerDetail = computed(() => [
    selectedInstance.value?.label ?? t('assistant.selectInstance'),
    selectedModel.value?.label ?? selection?.model,
    effortLabel.value,
    supportsFast.value ? t(isFast.value ? 'assistant.speedFast' : 'assistant.speedStandard') : '',
].filter(Boolean).join(' · '));

// Picking a model keeps the picker open and moves to its levels, as in T3 Code's docked picker.
function pickModel(instanceId: string, model: string) {
    const nextSelection = resolveAssistantSelection({
        instanceId,
        model,
        effort: selection?.effort ?? '',
        speedMode: selection?.speedMode ?? 'standard',
    }, instances, null);
    if (!nextSelection) {return;}
    emit('select', nextSelection);
    requestAnimationFrame(() => effortColumn.value?.focusLevel());
}

function pickEffort(effort: string) {
    if (selection) {emit('select', {
        ...selection,
        effort,
    });}
}

const speedControl = ref<HTMLElement | null>(null);
const currentSpeed = computed(() => selection?.speedMode ?? 'standard');

// One tab stop; the arrow keys move between and select the speeds.
function handleSpeedKeydown(event: KeyboardEvent) {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    if (!step || event.altKey || event.ctrlKey || event.metaKey) {return;}
    event.preventDefault();
    const index = speeds.findIndex(speed => speed.id === currentSpeed.value);
    const next = speeds[(index + step + speeds.length) % speeds.length];
    if (!next) {return;}
    pickSpeed(next.id);
    nextTick(() => speedControl.value?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus());
}

function pickSpeed(speedMode: IAssistantSelection['speedMode']) {
    if (selection) {emit('select', {
        ...selection,
        speedMode,
    });}
}
defineExpose({ open: () => { open.value = true; } });
</script>

<style lang="scss" scoped>
.picker-trigger {
    display: flex;
    min-width: 0;
    max-width: 100%;
    align-items: center;
    gap: var(--app-space-lg);
    padding: var(--app-space-sm) var(--app-space-3xl);
    border-radius: var(--app-radius-2xl);
    color: var(--ui-text);
    cursor: pointer;
    font-size: var(--app-text-size-body);
}

.picker-trigger:hover,
.picker-trigger[data-state='open'],
.picker-trigger:focus-visible {
    outline: none;
    background: color-mix(in oklab, var(--ui-text) 8%, transparent);
}

.trigger-icon {
    font-size: var(--app-text-size-title-sm);
}

.trigger-model {
    min-width: 0;

    @include app.truncate-single-line;
}

.trigger-traits {
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    gap: var(--app-space-lg);
    color: var(--ui-text-muted);
}

.picker-trigger:hover .trigger-traits,
.picker-trigger[data-state='open'] .trigger-traits {
    color: var(--ui-text);
}

.trigger-fast {
    width: var(--app-space-9xl);
    height: var(--app-space-9xl);
}

.model-picker {
    display: flex;
    max-width: calc(100vw - var(--app-space-16xl));
    max-height: var(--reka-popover-content-available-height, var(--app-assistant-picker-height));
    flex-direction: column;
    overflow: hidden;
}

/* One fixed height, so a model with more levels never resizes the popup (T3 Code). */
.picker-body {
    display: flex;
    height: var(--app-assistant-picker-height);
    min-height: 0;
}

.picker-footer {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--app-space-3xl);
    padding: var(--app-space-3xl) var(--app-space-9xl);
    border-top: 1px solid var(--ui-border);
    background: color-mix(in oklab, var(--ui-bg-muted) 40%, transparent);
}

.speed-control {
    display: flex;
    padding: var(--app-space-3xs);
    border-radius: var(--app-radius-2xl);
    background: color-mix(in oklab, var(--ui-bg-accented) 40%, transparent);
}

.speed-segment {
    display: flex;
    height: var(--app-space-16xl);
    align-items: center;
    gap: var(--app-space-sm);
    padding: 0 var(--app-space-3xl);
    color: var(--ui-text-muted);
    cursor: pointer;
    font-size: var(--app-text-size-caption);
}

.speed-segment:first-child {
    border-radius: var(--app-radius-md) 0 0 var(--app-radius-md);
}

.speed-segment:last-child {
    border-radius: 0 var(--app-radius-md) var(--app-radius-md) 0;
}

.speed-segment:hover {
    color: var(--ui-text);
}

.speed-segment[aria-checked='true'] {
    background: color-mix(in oklab, var(--ui-bg-accented) 72%, transparent);
    color: var(--ui-text);
}

.speed-icon {
    width: var(--app-space-9xl);
    height: var(--app-space-9xl);
}

/* A phone-width window stacks the levels under the list, as T3 Code does. */
@media (width < 40rem) {
    .picker-body {
        height: auto;
        flex: 1 1 auto;
        flex-direction: column;
    }

    /* Both halves give way to a short window; their rows keep scrolling. */
    .picker-body > :first-child {
        width: 100%;
        height: var(--app-assistant-picker-stacked-list-height);
        min-height: 0;
        flex: 0 1 auto;
    }

    .picker-body > :last-child {
        width: 100%;
        height: var(--app-assistant-picker-stacked-effort-height);
        min-height: 0;
        flex: 0 1 auto;
        border-top: 1px solid var(--ui-border);
        border-left: 0;
    }
}
</style>
