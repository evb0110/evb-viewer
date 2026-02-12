<template>
    <section class="notes-section notes-tools">
        <header class="notes-section-header">
            <h3 class="notes-section-title">{{ t('annotations.create') }}</h3>
            <p class="notes-section-description">{{ t('annotations.createDescription') }}</p>
        </header>

        <div class="grid grid-cols-2 gap-1.5">
            <button
                v-for="toolItem in toolItems"
                :key="toolItem.id"
                type="button"
                class="tool-button"
                :class="{ 'is-active': tool === toolItem.id }"
                @click="emit('set-tool', tool === toolItem.id ? 'none' : toolItem.id)"
            >
                <UIcon :name="toolItem.icon" class="tool-button-icon" />
                <span class="tool-button-label">{{ toolItem.label }}</span>
            </button>
        </div>

        <label class="keep-active-toggle">
            <input
                type="checkbox"
                :checked="keepActive"
                @change="emit('update:keep-active', ($event.target as HTMLInputElement).checked)"
            />
            {{ t('annotations.keepActive') }}
        </label>
    </section>
</template>

<script setup lang="ts">
import type { TAnnotationTool } from '@app/types/annotations';

interface IToolItem {
    id: TAnnotationTool;
    label: string;
    icon: string;
    hint: string;
}

interface IProps {
    tool: TAnnotationTool;
    keepActive: boolean;
}

const { t } = useI18n();

const props = defineProps<IProps>();

const emit = defineEmits<{
    (e: 'set-tool', tool: TAnnotationTool): void;
    (e: 'update:keep-active', value: boolean): void;
}>();

const tool = computed(() => props.tool);
const keepActive = computed(() => props.keepActive);

const toolItems = computed<IToolItem[]>(() => [
    {
        id: 'draw',
        label: t('annotations.draw'),
        icon: 'i-lucide-pen-tool',
        hint: 'Freehand pen or pencil drawing',
    },
    {
        id: 'text',
        label: t('annotations.text'),
        icon: 'i-lucide-type',
        hint: 'Place free text on the page',
    },
    {
        id: 'highlight',
        label: t('annotations.highlight'),
        icon: 'i-lucide-highlighter',
        hint: 'Highlight text selection',
    },
    {
        id: 'underline',
        label: t('annotations.underline'),
        icon: 'i-lucide-underline',
        hint: 'Underline text selection',
    },
    {
        id: 'strikethrough',
        label: t('annotations.strikethrough'),
        icon: 'i-lucide-strikethrough',
        hint: 'Cross out text selection',
    },
    {
        id: 'rectangle',
        label: t('annotations.rectangle'),
        icon: 'i-lucide-square',
        hint: 'Draw rectangle shapes',
    },
    {
        id: 'circle',
        label: t('annotations.circle'),
        icon: 'i-lucide-circle',
        hint: 'Draw circle shapes',
    },
    {
        id: 'line',
        label: t('annotations.line'),
        icon: 'i-lucide-minus',
        hint: 'Draw straight lines',
    },
    {
        id: 'arrow',
        label: t('annotations.arrow'),
        icon: 'i-lucide-arrow-up-right',
        hint: 'Draw arrows',
    },
]);
</script>

<style scoped>
.notes-section {
    border: 1px solid var(--ui-border-muted);
    border-radius: 0.7rem;
    background: var(--ui-bg);
    padding: 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    box-shadow: 0 1px 2px rgb(0 0 0 / 0.04);
}

.notes-section-header {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
}

.notes-section-title {
    margin: 0;
    font-size: 0.82rem;
    line-height: 1.2;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--ui-text-highlighted);
}

.notes-section-description {
    margin: 0;
    font-size: 0.8rem;
    line-height: 1.35;
    color: var(--ui-text-muted);
}

.tool-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.35rem;
    border: 1px solid var(--ui-border);
    border-radius: 0.5rem;
    background: var(--ui-bg);
    color: var(--ui-text-muted);
    font-size: 0.8rem;
    font-weight: 600;
    min-height: 2.1rem;
    cursor: pointer;
}

.tool-button:hover {
    border-color: color-mix(in srgb, var(--ui-primary) 40%, var(--ui-border) 60%);
    color: var(--ui-text-highlighted);
}

.tool-button.is-active {
    border-color: color-mix(in srgb, var(--ui-primary) 60%, var(--ui-border) 40%);
    background: color-mix(in srgb, var(--ui-primary) 18%, var(--ui-bg) 82%);
    color: var(--ui-text-highlighted);
}

.tool-button-icon {
    font-size: 0.95rem;
}

.tool-button-label {
    white-space: nowrap;
}

.keep-active-toggle {
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
    font-size: 0.82rem;
    color: var(--ui-text-muted);
    cursor: pointer;
}

.keep-active-toggle input[type="checkbox"] {
    accent-color: var(--ui-primary);
}
</style>
