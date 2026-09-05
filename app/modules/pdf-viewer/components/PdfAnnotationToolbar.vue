<template>
    <div class="annotation-toolbar">
        <div class="tool-grid">
            <AppTooltip
                v-for="toolItem in toolItems"
                :key="toolItem.id"
                :text="toolItem.label"
                :delay-duration="400"
            >
                <button
                    :ref="(element) => setToolButtonRef(toolItem.id, element)"
                    type="button"
                    class="tool-button"
                    :class="{ 'is-active': tool === toolItem.id }"
                    :data-tool="toolItem.id"
                    :aria-label="toolItem.label"
                    :aria-pressed="tool === toolItem.id"
                    :aria-haspopup="toolItem.hasStyleControls ? 'dialog' : undefined"
                    :aria-expanded="toolItem.hasStyleControls && tool === toolItem.id ? stylePopoverOpen : undefined"
                    @click="setTool(toolItem.id)"
                >
                    <UIcon :name="toolItem.icon" class="tool-button-icon" />
                </button>
            </AppTooltip>
        </div>
    </div>
</template>

<script setup lang="ts">
import type { ComponentPublicInstance } from 'vue';
import type { TAnnotationTool } from '@app/types/annotations';

interface IToolItem {
    id: TAnnotationTool;
    label: string;
    icon: string;
    hasStyleControls: boolean;
}

interface IProps {
    tool: TAnnotationTool;
    stylePopoverOpen?: boolean;
}

interface IPdfAnnotationToolbarExpose {getButtonEl: (toolId: TAnnotationTool) => HTMLElement | null;}

const { t } = useTypedI18n();

const {
    stylePopoverOpen = false,
    tool: toolProp,
} = defineProps<IProps>();

const emit = defineEmits<{ 'set-tool': [tool: TAnnotationTool] }>();

const tool = computed(() => toolProp);

const toolItems = computed<IToolItem[]>(() => [
    {
        id: 'select',
        label: t('annotations.select'),
        icon: 'i-ph-scan',
        hasStyleControls: false,
    },
    {
        id: 'draw',
        label: t('annotations.draw'),
        icon: 'i-ph-pen-nib',
        hasStyleControls: true,
    },
    {
        id: 'text',
        label: t('annotations.text'),
        icon: 'i-ph-text-t',
        hasStyleControls: true,
    },
    {
        id: 'note',
        label: t('annotations.stickyNoteLabel'),
        icon: 'i-ph-chat-circle-dots',
        hasStyleControls: true,
    },
    {
        id: 'highlight',
        label: t('annotations.highlight'),
        icon: 'i-ph-highlighter',
        hasStyleControls: true,
    },
    {
        id: 'underline',
        label: t('annotations.underline'),
        icon: 'i-ph-text-underline',
        hasStyleControls: true,
    },
    {
        id: 'strikethrough',
        label: t('annotations.strikethrough'),
        icon: 'i-ph-text-strikethrough',
        hasStyleControls: true,
    },
    {
        id: 'squiggly',
        label: t('annotations.squiggly'),
        icon: 'i-ph-waves',
        hasStyleControls: true,
    },
    {
        id: 'rectangle',
        label: t('annotations.rectangle'),
        icon: 'i-ph-square',
        hasStyleControls: true,
    },
    {
        id: 'circle',
        label: t('annotations.circle'),
        icon: 'i-ph-circle',
        hasStyleControls: true,
    },
    {
        id: 'line',
        label: t('annotations.line'),
        icon: 'i-ph-minus',
        hasStyleControls: true,
    },
    {
        id: 'arrow',
        label: t('annotations.arrow'),
        icon: 'i-ph-arrow-up-right',
        hasStyleControls: true,
    },
]);

function setTool(toolId: TAnnotationTool) {
    emit('set-tool', toolId);
}

const toolButtonRefs = new Map<TAnnotationTool, HTMLElement>();

function setToolButtonRef(toolId: TAnnotationTool, element: Element | ComponentPublicInstance | null) {
    if (element instanceof HTMLElement) {
        toolButtonRefs.set(toolId, element);
        return;
    }

    toolButtonRefs.delete(toolId);
}

function getButtonEl(toolId: TAnnotationTool) {
    return toolButtonRefs.get(toolId) ?? null;
}

defineExpose<IPdfAnnotationToolbarExpose>({ getButtonEl });

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
