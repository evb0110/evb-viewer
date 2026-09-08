<template>
    <div class="annotation-toolbar" role="group" :aria-label="t('annotations.annotations')">
        <div class="tool-grid">
            <AppTooltip
                v-for="toolItem in toolItems"
                :key="toolItem.id"
                :text="toolItem.label"
                :delay-duration="400"
            >
                <button
                    type="button"
                    class="tool-button"
                    :class="{ 'is-active': tool === toolItem.id }"
                    :data-tool="toolItem.id"
                    :aria-label="toolItem.label"
                    :aria-pressed="tool === toolItem.id"
                    @click="setTool(toolItem.id)"
                >
                    <UIcon :name="toolItem.icon" class="tool-button-icon" />
                </button>
            </AppTooltip>
        </div>
    </div>
</template>

<script setup lang="ts">
import type { TAnnotationTool } from '@app/types/annotations';

interface IToolItem {
    id: TAnnotationTool;
    label: string;
    icon: string;
}

interface IProps {tool: TAnnotationTool;}


const { t } = useTypedI18n();

const {tool: toolProp} = defineProps<IProps>();

const emit = defineEmits<{ 'set-tool': [tool: TAnnotationTool] }>();

const tool = computed(() => toolProp);

const toolItems = computed<IToolItem[]>(() => [
    {
        id: 'select',
        label: t('annotations.select'),
        icon: 'i-ph-scan',
    },
    {
        id: 'draw',
        label: t('annotations.draw'),
        icon: 'i-ph-pen-nib',
    },
    {
        id: 'text',
        label: t('annotations.text'),
        icon: 'i-ph-text-t',
    },
    {
        id: 'note',
        label: t('annotations.stickyNoteLabel'),
        icon: 'i-ph-chat-circle-dots',
    },
    {
        id: 'highlight',
        label: t('annotations.highlight'),
        icon: 'i-ph-highlighter',
    },
    {
        id: 'underline',
        label: t('annotations.underline'),
        icon: 'i-ph-text-underline',
    },
    {
        id: 'strikethrough',
        label: t('annotations.strikethrough'),
        icon: 'i-ph-text-strikethrough',
    },
    {
        id: 'squiggly',
        label: t('annotations.squiggly'),
        icon: 'i-ph-waves',
    },
    {
        id: 'rectangle',
        label: t('annotations.rectangle'),
        icon: 'i-ph-square',
    },
    {
        id: 'circle',
        label: t('annotations.circle'),
        icon: 'i-ph-circle',
    },
    {
        id: 'line',
        label: t('annotations.line'),
        icon: 'i-ph-minus',
    },
    {
        id: 'arrow',
        label: t('annotations.arrow'),
        icon: 'i-ph-arrow-up-right',
    },
]);

function setTool(toolId: TAnnotationTool) {
    emit('set-tool', toolId);
}

</script>

<style scoped>
.annotation-toolbar {
    display: block;
}

.tool-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
}

.tool-button {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid transparent;
    border-radius: var(--app-radius-md);
    background: transparent;
    color: var(--ui-text-muted);
    flex: 0 0 var(--app-control-height-lg);
    width: var(--app-control-height-lg);
    height: var(--app-control-height-lg);
    cursor: pointer;
    transition:
        background-color 0.12s ease,
        border-color 0.12s ease,
        color 0.12s ease;
}

.tool-button:focus-visible {
    outline: 2px solid var(--app-toolbar-focus-ring);
    outline-offset: 2px;
}

.tool-button:hover {
    background: var(--app-sidebar-control-hover-bg);
    color: var(--ui-text);
}

.tool-button.is-active {
    border-color: var(--app-control-active-border);
    background: var(--app-control-active-bg);
    color: var(--ui-text);
}

.tool-button-icon {
    font-size: var(--app-text-size-control);
}

</style>
