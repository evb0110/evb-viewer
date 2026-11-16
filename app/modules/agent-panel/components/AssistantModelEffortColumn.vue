<template>
    <div ref="column" class="effort-column" data-model-picker-effort @keydown="handleKeydown">
        <div class="effort-header">
            <span>{{ t('assistant.reasoning') }}</span>
            <span class="effort-model">{{ modelLabel }}</span>
        </div>
        <div v-if="efforts.length" class="effort-rows app-scrollbar" role="radiogroup" :aria-label="t('assistant.reasoning')">
            <button
                v-for="(option, index) in efforts"
                :key="option.id"
                type="button"
                role="radio"
                class="effort-row"
                data-effort-level
                :aria-checked="option.id === effort"
                :tabindex="(shown ? option.id === effort : index === 0) ? 0 : -1"
                :title="option.description"
                @click="emit('pick', option.id)"
            >
                <span class="effort-label">{{ option.label }}</span>
                <UIcon v-if="option.id === effort" name="i-ph-check" class="effort-check" />
                <span v-else-if="option.isDefault" class="effort-default">{{ t('assistant.effortDefault') }}</span>
            </button>
        </div>
        <p v-else class="effort-empty">{{ t('assistant.noEffortLevels') }}</p>
    </div>
</template>

<script setup lang="ts">
import type { IAgentAssistantModelOption } from '@contracts/agent';
import { useTypedI18n } from '@app/composables/useTypedI18n';

const props = defineProps<{
    model: IAgentAssistantModelOption | undefined;
    modelLabel: string;
    effort: string;
}>();
const emit = defineEmits<{
    pick: [effort: string];
    back: [];
}>();
const { t } = useTypedI18n();
const column = ref<HTMLElement | null>(null);
const efforts = computed(() => props.model?.reasoningEfforts ?? []);
const shown = computed(() => efforts.value.some(option => option.id === props.effort));

/** Focuses the selected level, else the first; false when the model has none. */
function focusLevel() {
    const rows = column.value?.querySelectorAll<HTMLElement>('[data-effort-level]');
    const row = column.value?.querySelector<HTMLElement>('[data-effort-level][aria-checked="true"]') ?? rows?.[0];
    row?.focus({ preventScroll: true });
    row?.scrollIntoView({ block: 'nearest' });
    return Boolean(row);
}

function handleKeydown(event: KeyboardEvent) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'ArrowLeft') {
        event.preventDefault();
        emit('back');
        return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const rows = Array.from(column.value?.querySelectorAll<HTMLElement>('[data-effort-level]') ?? []);
    const index = rows.findIndex(row => row === document.activeElement);
    const next = rows[Math.min(rows.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)))];
    event.preventDefault();
    next?.focus();
    next?.scrollIntoView({ block: 'nearest' });
}

defineExpose({ focusLevel });
</script>

<style scoped>
.effort-column {
    display: flex;
    width: var(--app-assistant-picker-effort-width);
    min-height: 0;
    flex: 0 0 auto;
    flex-direction: column;
    border-left: 1px solid var(--ui-border);
    background: color-mix(in oklab, var(--ui-bg-muted) 40%, transparent);
}

.effort-header {
    display: flex;
    align-items: center;
    gap: var(--app-space-3xl);
    margin: var(--app-space-6xl) var(--app-space-9xl) 0;
    padding-bottom: var(--app-space-lg);
    border-bottom: 1px solid var(--ui-border);
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-body);
}

.effort-model {
    min-width: 0;
    margin-left: auto;
    overflow: hidden;
    font-size: var(--app-text-size-caption);
    text-overflow: ellipsis;
    white-space: nowrap;
}

.effort-rows {
    display: flex;
    min-height: 0;
    flex: 1 1 auto;
    flex-direction: column;
    gap: var(--app-space-3xs);
    padding: var(--app-space-lg) var(--app-space-3xl);
    overflow: hidden auto;
    overscroll-behavior: contain;
}

.effort-row {
    display: flex;
    min-height: var(--app-assistant-picker-row-height);
    flex: 0 0 auto;
    align-items: center;
    gap: var(--app-space-3xl);
    padding: 0 var(--app-space-3xl);
    border-radius: var(--app-radius-xs);
    color: var(--ui-text);
    cursor: pointer;
    font-size: var(--app-text-size-body);
    text-align: left;
}

.effort-row:hover,
.effort-row:focus-visible {
    outline: none;
    background: color-mix(in oklab, var(--ui-text) 9%, transparent);
}

.effort-label {
    min-width: 0;
    flex: 1 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.effort-check {
    flex: 0 0 auto;
}

.effort-default {
    color: var(--ui-text-dimmed);
    font-size: var(--app-text-size-caption);
}

.effort-empty {
    margin: 0;
    padding: var(--app-space-3xl) var(--app-space-9xl);
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-body);
}
</style>
