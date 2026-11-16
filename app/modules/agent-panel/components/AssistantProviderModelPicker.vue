<template>
    <UPopover v-model:open="open" :content="{ side: 'top', align: 'start', collisionPadding: 12 }">
        <UButton class="picker-trigger" :aria-label="selectionDescription" color="neutral" variant="ghost" size="xs" trailing-icon="i-ph-caret-down">
            <template #leading><AssistantProviderIcon v-if="selectedInstance" :provider="selectedInstance.driver" /></template>
            <span v-if="showInstanceLabel" class="picker-trigger-instance">{{ selectedInstance?.label }}</span>
            <span class="picker-trigger-model">{{ selectedModel?.label ?? selection?.model ?? t('assistant.selectInstance') }}</span>
            <span v-if="selectedEffort" class="picker-trigger-trait">{{ effortName(selectedEffort) }}</span>
            <UIcon v-if="selection?.speedMode === 'fast'" name="i-ph-lightning" class="picker-trigger-fast" />
        </UButton>
        <template #content>
            <div class="provider-picker" :style="{ width: width ? `${width}px` : undefined }">
                <div class="picker-body">
                    <div class="picker-models" @keydown="handleModelKeydown">
                        <UInput ref="searchInput" v-model="search" :placeholder="t('assistant.searchModels')" :aria-label="t('assistant.searchModels')" icon="i-ph-magnifying-glass" autofocus class="picker-search" />
                        <div class="picker-model-list app-scrollbar">
                            <section v-for="instance in visibleInstances" :key="instance.id" class="picker-group">
                                <header class="picker-column-label">
                                    <AssistantProviderIcon :provider="instance.driver" />
                                    <span>{{ instance.label }}</span>
                                </header>
                                <p v-if="instance.state !== 'ready'" class="picker-status">{{ t(stateKeys[instance.state]) }}<span v-if="instance.message">: {{ instance.message }}</span></p>
                                <button v-for="model in matchingModels(instance)" :key="model.id" type="button" class="picker-row picker-model" data-picker-row :aria-pressed="isSelected(instance, model.id)" @click="selectModel(instance, model.id)">
                                    <span class="picker-row-label">{{ model.label }}</span>
                                    <UIcon v-if="isSelected(instance, model.id)" name="i-ph-check" />
                                </button>
                            </section>
                        </div>
                    </div>
                    <div v-if="selectedModel?.reasoningEfforts?.length" ref="effortColumn" class="picker-efforts" role="radiogroup" :aria-label="t('assistant.reasoningEffort')" @keydown="handleEffortKeydown">
                        <div class="picker-column-label">{{ t('assistant.reasoningEffort') }}</div>
                        <button v-for="effort in selectedModel.reasoningEfforts" :key="effort.id" type="button" role="radio" class="picker-row" data-picker-row data-effort-row :aria-checked="effort.id === selectedEffort?.id" :tabindex="effort.id === effortTabStop ? 0 : -1" :title="effort.description" @click="selection && emit('select', { ...selection, effort: effort.id })">
                            <span class="picker-row-label">{{ effortName(effort) }}</span>
                            <UIcon v-if="effort.id === selectedEffort?.id" name="i-ph-check" />
                            <span v-else-if="isDefaultEffort(effort)" class="picker-row-note">{{ t('assistant.effortDefault') }}</span>
                        </button>
                    </div>
                </div>
                <div v-if="supportsFast" class="picker-speed" role="radiogroup" :aria-label="t('assistant.speedMode')" @keydown="handleSpeedKeydown">
                    <button v-for="speed in speeds" :key="speed.id" type="button" role="radio" class="picker-speed-option" data-picker-row :aria-checked="(selection?.speedMode ?? 'standard') === speed.id" :tabindex="(selection?.speedMode ?? 'standard') === speed.id ? 0 : -1" @click="selection && emit('select', { ...selection, speedMode: speed.id })">
                        <UIcon v-if="speed.id === 'fast'" name="i-ph-lightning" />
                        {{ t(speed.key) }}
                    </button>
                </div>
            </div>
        </template>
    </UPopover>
</template>

<script setup lang="ts">
import type { IAgentAssistantEffortOption } from '@contracts/agent';
import type {
    IAssistantInstanceStatus, IAssistantSelection,
} from '@contracts/assistant';
import { resolveAssistantSelection } from '@app/modules/agent-panel/utils/assistantSelectionPreference';
import AssistantProviderIcon from '@app/modules/agent-panel/components/AssistantProviderIcon.vue';
import { useTypedI18n } from '@app/composables/useTypedI18n';
const props = defineProps<{
    instances: IAssistantInstanceStatus[];
    selection: IAssistantSelection | null;
    width?: number | undefined;
}>();
const emit = defineEmits<{ select: [selection: IAssistantSelection] }>();
const { t } = useTypedI18n();
const open = ref(false);
const search = ref('');
const searchInput = ref<{ inputRef?: HTMLInputElement | null } | null>(null);
const effortColumn = ref<HTMLElement | null>(null);
const visibleInstances = computed(() => props.instances.filter(instance => instance.enabled && instance.state !== 'disabled'));
const selectedInstance = computed(() => props.instances.find(instance => instance.id === props.selection?.instanceId));
const selectedModel = computed(() => selectedInstance.value?.models.find(model => model.id === props.selection?.model));
const selectedEffort = computed(() => selectedModel.value?.reasoningEfforts?.find(effort => effort.id === props.selection?.effort));
const effortTabStop = computed(() => selectedEffort.value?.id ?? selectedModel.value?.reasoningEfforts?.[0]?.id);
const supportsFast = computed(() => selectedModel.value?.serviceTiers?.some(tier => tier.id === 'fast' || tier.id === 'priority'));
// The provider icon names the driver; the instance label is needed only to tell two setups of one driver apart.
const showInstanceLabel = computed(() => visibleInstances.value.filter(instance => instance.driver === selectedInstance.value?.driver).length > 1);
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
const stateKeys = {
    checking: 'assistant.stateChecking',
    ready: 'assistant.stateReady',
    warning: 'assistant.stateWarning',
    error: 'assistant.stateError',
    disabled: 'assistant.stateDisabled',
    missing: 'assistant.stateMissing',
} as const;
const effortKeys: Readonly<Record<string, 'assistant.effort.none' | 'assistant.effort.minimal' | 'assistant.effort.low' | 'assistant.effort.medium' | 'assistant.effort.high' | 'assistant.effort.xhigh' | 'assistant.effort.max'>> = {
    none: 'assistant.effort.none',
    minimal: 'assistant.effort.minimal',
    low: 'assistant.effort.low',
    medium: 'assistant.effort.medium',
    high: 'assistant.effort.high',
    xhigh: 'assistant.effort.xhigh',
    max: 'assistant.effort.max',
};
function effortName(effort: IAgentAssistantEffortOption) {
    const key = effortKeys[effort.id];
    return key ? t(key) : effort.label;
}
function isDefaultEffort(effort: IAgentAssistantEffortOption) {
    return effort.isDefault === true || effort.id === selectedModel.value?.defaultReasoningEffort;
}
const selectionDescription = computed(() => [
    selectedInstance.value?.label ?? t('assistant.selectInstance'),
    selectedModel.value?.label ?? props.selection?.model,
    selectedEffort.value ? effortName(selectedEffort.value) : undefined,
    t(props.selection?.speedMode === 'fast' ? 'assistant.speedFast' : 'assistant.speedStandard'),
].filter(Boolean).join(' · '));
function matchingModels(instance: IAssistantInstanceStatus) {
    const query = search.value.trim().toLowerCase();
    return query ? instance.models.filter(model => model.label.toLowerCase().includes(query)) : instance.models;
}
function isSelected(instance: IAssistantInstanceStatus, model: string) {
    return props.selection?.instanceId === instance.id && props.selection.model === model;
}
async function selectModel(instance: IAssistantInstanceStatus, model: string) {
    const selection = resolveAssistantSelection({
        instanceId: instance.id,
        model,
        effort: props.selection?.effort ?? '',
        speedMode: props.selection?.speedMode ?? 'standard',
    }, props.instances, null);
    if (!selection) return;
    emit('select', selection);
    // Focus lands on the new model's effort levels, as in T3 Code's picker.
    await nextTick();
    effortColumn.value?.querySelector<HTMLElement>('[data-effort-row][tabindex="0"]')?.focus();
}
// Keyboard movement adapted from T3 Code ComposerModelEffort.tsx@0b6f482dc5 (MIT, T3 Tools Inc.).
function moveBetweenRows(event: KeyboardEvent, container: HTMLElement) {
    const rows = [...container.querySelectorAll<HTMLElement>('[data-picker-row]')];
    const index = rows.findIndex(row => row === document.activeElement);
    if (index < 0 && event.key === 'ArrowUp') return;
    const radio = container.getAttribute('role') === 'radiogroup';
    const destination = index + (event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1);
    const next = rows[radio ? (destination + rows.length) % rows.length : Math.min(rows.length - 1, Math.max(0, destination))];
    if (!next) return;
    event.preventDefault();
    next.focus();
    if (radio) next.click();
    next.scrollIntoView?.({ block: 'nearest' });
}
function handleModelKeydown(event: KeyboardEvent) {
    const container = event.currentTarget as HTMLElement;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') moveBetweenRows(event, container);
    else if (event.key === 'ArrowRight' && event.target !== searchInput.value?.inputRef) {
        const effort = effortColumn.value?.querySelector<HTMLElement>('[data-effort-row][tabindex="0"]');
        if (effort) {
            event.preventDefault();
            effort.focus();
        }
    }
}
function handleEffortKeydown(event: KeyboardEvent) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') moveBetweenRows(event, event.currentTarget as HTMLElement);
    else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        searchInput.value?.inputRef?.focus();
    }
}
function handleSpeedKeydown(event: KeyboardEvent) {
    if (['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(event.key)) moveBetweenRows(event, event.currentTarget as HTMLElement);
}
defineExpose({ open: () => { open.value = true; } });
</script>

<style scoped>
.picker-trigger {
    min-width: 0;
    max-width: 100%;
    overflow: hidden;
}

.picker-trigger-instance,
.picker-trigger-trait {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    color: var(--ui-text-muted);
    text-overflow: ellipsis;
    white-space: nowrap;
}

.picker-trigger-model {
    flex: 0 1 auto;
    min-width: 2ch;
    overflow: hidden;
    color: var(--ui-text);
    text-overflow: ellipsis;
    white-space: nowrap;
}

.picker-trigger-instance {
    flex-shrink: 2;
}

.picker-trigger-fast {
    flex: 0 0 auto;
    color: var(--ui-warning);
}

.provider-picker {
    display: flex;
    flex-direction: column;
    width: var(--app-assistant-picker-width);
    max-width: min(var(--app-assistant-picker-max-width), calc(100vw - var(--app-space-16xl)));
    max-height: var(--app-assistant-picker-max-height);
    overflow: hidden;
    container-type: inline-size;
}

.picker-body {
    display: flex;
    flex: 1 1 auto;
    min-height: 0;
    overflow: hidden auto;
}

.picker-models {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    min-width: 0;
    padding: var(--app-space-3xl);
}

.picker-search {
    width: 100%;
    margin-bottom: var(--app-space-lg);
}

.picker-model-list {
    height: var(--app-assistant-picker-lane-height);
    overflow: hidden auto;
}

.picker-efforts {
    display: flex;
    flex: 0 0 var(--app-assistant-picker-effort-width);
    flex-direction: column;
    gap: var(--app-space-xs);
    padding: var(--app-space-3xl);
    overflow: hidden auto;
    border-inline-start: 1px solid var(--ui-border);
    background: var(--ui-bg-muted);
}

/* Narrow panels stack the effort column under the model lane (T3 Code's max-sm layout). */
@container (width < 26rem) {
    .picker-body {
        flex-direction: column;
    }

    .picker-model-list {
        height: auto;
        max-height: var(--app-assistant-picker-lane-height);
    }

    .picker-efforts {
        flex-basis: auto;
        border-block-start: 1px solid var(--ui-border);
        border-inline-start: 0;
    }
}

.picker-group + .picker-group {
    margin-top: var(--app-space-lg);
}

.picker-column-label {
    display: flex;
    align-items: center;
    gap: var(--app-space-lg);
    padding: var(--app-space-lg) var(--app-space-lg) var(--app-space-sm);
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-kicker);
    font-weight: var(--app-font-weight-medium);
}

.picker-status {
    margin: 0;
    padding: 0 var(--app-space-lg) var(--app-space-sm);
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-kicker);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    user-select: text;
}

.picker-row {
    display: flex;
    align-items: center;
    gap: var(--app-space-3xl);
    width: 100%;
    min-height: var(--app-space-16xl);
    padding: var(--app-space-sm) var(--app-space-lg);
    border-radius: var(--app-radius-md);
    color: var(--ui-text);
    font-size: var(--app-text-size-body-sm);
    text-align: start;
    cursor: pointer;
    outline: none;
}

.picker-row:hover,
.picker-row:focus-visible {
    background: var(--ui-bg-accented);
}

.picker-row[aria-pressed='true'],
.picker-row[aria-checked='true'] {
    font-weight: var(--app-font-weight-medium);
}

.picker-row-label {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.picker-row-note {
    color: var(--ui-text-dimmed);
    font-size: var(--app-text-size-micro);
}

.picker-speed {
    display: flex;
    flex-shrink: 0;
    gap: var(--app-space-xs);
    margin: 0 var(--app-space-3xl) var(--app-space-3xl);
    padding: var(--app-space-xs);
    border-radius: var(--app-radius-xl);
    background: var(--ui-bg-muted);
}

.picker-speed-option {
    display: flex;
    flex: 1 1 0;
    align-items: center;
    justify-content: center;
    gap: var(--app-space-sm);
    min-height: var(--app-space-16xl);
    border-radius: var(--app-radius-md);
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-kicker);
    cursor: pointer;
}

.picker-speed-option[aria-checked='true'] {
    background: var(--ui-bg-elevated);
    color: var(--ui-text);
    box-shadow: inset 0 0 0 1px var(--ui-border);
}

.picker-speed-option:focus-visible {
    outline: 2px solid var(--ui-primary);
    outline-offset: 1px;
}
</style>
