<template>
    <UPopover :content="{ side: 'top', align: 'start', collisionPadding: 12 }">
        <UButton class="picker-trigger" :label="selectionLabel" :aria-label="selectionLabel"  color="neutral" variant="ghost" size="xs" trailing-icon="i-ph-caret-down" :ui="{ label: 'truncate' }">
            <template #leading><AssistantProviderIcon v-if="selectedInstance" :provider="selectedInstance.driver" /></template>
        </UButton>
        <template #content>
            <div class="provider-picker app-scrollbar" :style="{ width: width ? Math.min(width, 360) + 'px' : undefined }">
                <UInput v-model="search" :placeholder="t('assistant.searchModels')" :aria-label="t('assistant.searchModels')" icon="i-ph-magnifying-glass" autofocus class="picker-search" />
                <section v-for="instance in visibleInstances" :key="instance.id" class="picker-group">
                    <header>
                        <AssistantProviderIcon :provider="instance.driver" />
                        <strong>{{ instance.label }}</strong>
                    </header>
                    <p v-if="instance.state !== 'ready'" class="picker-status">{{ t(stateKeys[instance.state]) }}<span v-if="instance.message">: {{ instance.message }}</span></p>
                    <UButton v-for="model in instance.models.filter(item => !search || item.label.toLowerCase().includes(search.toLowerCase()))" :key="model.id" :label="model.label" :icon="selection?.instanceId === instance.id && selection.model === model.id ? 'i-ph-check' : undefined" color="neutral" variant="ghost" class="picker-model" :aria-pressed="selection?.instanceId === instance.id && selection.model === model.id" @click="selectModel(instance, model.id)" />
                </section>
                <fieldset v-if="selectedModel?.reasoningEfforts?.length" class="picker-options">
                    <legend>{{ t('assistant.reasoningEffort') }}</legend>
                    <label v-for="effort in selectedModel.reasoningEfforts" :key="effort.id" >
                        <input type="radio" :name="`${pickerId}-effort`" :checked="selection?.effort === effort.id" @change="selection && emit('select', { ...selection, effort: effort.id })">
                        {{ effort.label }}
                    </label>
                </fieldset>
                <fieldset v-if="supportsFast" class="picker-options">
                    <legend>{{ t('assistant.speedMode') }}</legend>
                    <label v-for="speed in speeds" :key="speed.id">
                        <input type="radio" :name="`${pickerId}-speed`" :checked="selection?.speedMode === speed.id" @change="selection && emit('select', { ...selection, speedMode: speed.id })">
                        {{ t(speed.key) }}
                    </label>
                </fieldset>
            </div>
        </template>
    </UPopover>
</template>

<script setup lang="ts">
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
const pickerId = useId();
const search = ref('');
const visibleInstances = computed(() => props.instances.filter(instance => instance.enabled && instance.state !== 'disabled'));
const selectedInstance = computed(() => props.instances.find(instance => instance.id === props.selection?.instanceId));
const selectedModel = computed(() => selectedInstance.value?.models.find(model => model.id === props.selection?.model));
const supportsFast = computed(() => selectedModel.value?.serviceTiers?.some(tier => tier.id === 'fast' || tier.id === 'priority'));
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
const selectionLabel = computed(() => [
    selectedInstance.value?.label ?? t('assistant.selectInstance'),
    selectedModel.value?.label ?? props.selection?.model,
    props.selection?.effort,
    t(props.selection?.speedMode === 'fast' ? 'assistant.speedFast' : 'assistant.speedStandard'),
].filter(Boolean).join(' · '));
function selectModel(instance: IAssistantInstanceStatus, model: string) {
    const selection = resolveAssistantSelection({
        instanceId: instance.id,
        model,
        effort: props.selection?.effort ?? '',
        speedMode: props.selection?.speedMode ?? 'standard',
    }, props.instances, null);
    if (selection) emit('select', selection);
}
</script>

<style scoped>
.picker-trigger {
    min-width: 0;
    max-width: 100%;
}

.provider-picker {
    width: var(--app-assistant-picker-width);
    max-width: calc(100vw - var(--app-space-16xl));
    max-height: var(--app-assistant-picker-max-height);
    padding: var(--app-space-3xl);
    overflow: hidden auto;
}

.picker-search {
    width: 100%;
    margin-bottom: var(--app-space-3xl);
}

.picker-group {
    padding-block: var(--app-space-lg);
}

.picker-group header {
    display: flex;
    align-items: center;
    gap: var(--app-space-lg);
    padding: var(--app-space-lg);
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-kicker);
}

.picker-status {
    margin: 0;
    padding: var(--app-space-lg);
    font-size: var(--app-text-size-kicker);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    user-select: text;
}

.picker-model {
    display: flex;
    width: 100%;
    justify-content: flex-start;
}

.picker-options {
    display: flex;
    flex-wrap: wrap;
    gap: var(--app-space-3xl);
    margin-top: var(--app-space-3xl);
    padding: var(--app-space-3xl);
    border-top: 1px solid var(--ui-border);
    font-size: var(--app-text-size-kicker);
}

.picker-options legend {
    color: var(--ui-text-muted);
}

.picker-options label {
    display: flex;
    align-items: center;
    gap: var(--app-space-sm);
    cursor: pointer;
}
</style>
