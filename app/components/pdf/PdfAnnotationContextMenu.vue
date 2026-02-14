<template>
    <div
        v-if="menu.visible"
        class="annotation-context-menu"
        :style="style"
        @click.stop
    >
        <template v-if="menu.comment">
            <p class="annotation-context-menu-section-title">
                <span
                    v-if="menu.comment.color"
                    class="annotation-context-menu-color-swatch"
                    :style="{ background: menu.comment.color }"
                />
                {{ annotationLabel }}
            </p>
            <button type="button" class="annotation-context-menu-action" @click="emit('open-note')">
                {{ t('contextMenu.openPopUpNote') }}
            </button>
            <button
                type="button"
                class="annotation-context-menu-action"
                :disabled="!canCopy"
                @click="emit('copy-text')"
            >
                {{ t('contextMenu.copyTextToClipboard') }}
            </button>
            <button
                type="button"
                class="annotation-context-menu-action annotation-context-menu-action-danger"
                @click="emit('delete')"
            >
                {{ deleteLabel }}
            </button>
            <div class="annotation-context-menu-divider" />
        </template>

        <template v-if="menu.hasSelection">
            <p class="annotation-context-menu-section-title">
                {{ t('contextMenu.markupSelection') }}
            </p>
            <button
                type="button"
                class="annotation-context-menu-action"
                @click="emit('markup', 'highlight')"
            >
                {{ t('contextMenu.highlight') }}
            </button>
            <button
                type="button"
                class="annotation-context-menu-action"
                @click="emit('markup', 'underline')"
            >
                {{ t('contextMenu.underline') }}
            </button>
            <button
                type="button"
                class="annotation-context-menu-action"
                @click="emit('markup', 'strikethrough')"
            >
                {{ t('contextMenu.strikethrough') }}
            </button>
            <div class="annotation-context-menu-divider" />
        </template>

        <p class="annotation-context-menu-section-title">
            {{ t('contextMenu.addNote') }}
        </p>
        <button
            type="button"
            class="annotation-context-menu-action"
            :disabled="!canCreateFree"
            @click="emit('create-free-note')"
        >
            {{ t('contextMenu.addNoteHere') }}
        </button>
        <button
            v-if="menu.hasSelection"
            type="button"
            class="annotation-context-menu-action"
            @click="emit('create-selection-note')"
        >
            {{ t('contextMenu.addNoteToSelection') }}
        </button>
    </div>
</template>

<script setup lang="ts">
import type { TAnnotationTool } from '@app/types/annotations';

interface IContextMenuState {
    visible: boolean;
    comment: {
        stableKey: string;
        text: string;
        color?: string | null;
        source?: string;
    } | null;
    hasSelection: boolean;
    pageNumber: number | null;
    pageX: number | null;
    pageY: number | null;
}

defineProps<{
    menu: IContextMenuState;
    style: Record<string, string>;
    canCopy: boolean;
    canCreateFree: boolean;
    annotationLabel: string;
    deleteLabel: string;
}>();

const emit = defineEmits<{
    'open-note': [];
    'copy-text': [];
    'delete': [];
    'markup': [tool: TAnnotationTool];
    'create-free-note': [];
    'create-selection-note': [];
}>();

const { t } = useTypedI18n();
</script>

<style scoped>
.annotation-context-menu {
    position: fixed;
    z-index: 70;
    min-width: 246px;
    display: grid;
    gap: 1px;
    border: 1px solid var(--ui-border);
    background: var(--ui-border);
    box-shadow:
        0 10px 24px rgb(0 0 0 / 15%),
        0 3px 8px rgb(0 0 0 / 10%);
}

.annotation-context-menu-section-title {
    margin: 0;
    padding: 0.45rem 0.6rem 0.35rem;
    background: var(--ui-bg-muted);
    color: var(--ui-text-dimmed);
    font-size: 0.64rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: 0.35rem;
}

.annotation-context-menu-color-swatch {
    display: inline-block;
    width: 0.55rem;
    height: 0.55rem;
    border-radius: 2px;
    flex-shrink: 0;
    border: 1px solid rgb(0 0 0 / 15%);
}

.annotation-context-menu-divider {
    height: 1px;
    background: var(--ui-border);
}

.annotation-context-menu-action {
    text-align: left;
    border: none;
    background: var(--ui-bg, #fff);
    color: var(--ui-text);
    min-height: 2rem;
    padding: 0 0.6rem;
    cursor: pointer;
}

.annotation-context-menu-action:hover {
    background: color-mix(in oklab, var(--ui-bg, #fff) 93%, var(--ui-primary) 7%);
}

.annotation-context-menu-action:disabled {
    color: var(--ui-text-dimmed);
    cursor: default;
    background: var(--ui-bg-muted);
}

.annotation-context-menu-action-danger {
    color: #b42318;
}
</style>
