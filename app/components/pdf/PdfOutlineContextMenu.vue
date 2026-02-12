<template>
    <div
        v-if="visible && bookmark"
        class="bookmarks-context-menu"
        :style="menuStyle"
        @click.stop
    >
        <button
            type="button"
            class="bookmarks-context-menu-action"
            :title="t('bookmarks.editBookmark')"
            @click="emit('edit', bookmark.id)"
        >
            {{ t('bookmarks.editBookmark') }}
        </button>
        <button
            type="button"
            class="bookmarks-context-menu-action"
            :title="t('bookmarks.addSiblingAbove')"
            @click="emit('add-sibling-above', bookmark.id)"
        >
            {{ t('bookmarks.addSiblingAbove') }}
        </button>
        <button
            type="button"
            class="bookmarks-context-menu-action"
            :title="t('bookmarks.addSiblingBelow')"
            @click="emit('add-sibling-below', bookmark.id)"
        >
            {{ t('bookmarks.addSiblingBelow') }}
        </button>
        <button
            type="button"
            class="bookmarks-context-menu-action"
            :title="t('bookmarks.addChild')"
            @click="emit('add-child', bookmark.id)"
        >
            {{ t('bookmarks.addChild') }}
        </button>
        <div class="bookmarks-context-menu-divider" />

        <div class="bookmarks-context-menu-style-block">
            <div class="bookmarks-context-menu-style-row">
                <button
                    type="button"
                    class="bookmarks-style-toggle"
                    :class="{ 'is-active': bookmark.bold }"
                    :title="bookmark.bold ? t('bookmarks.disableBold') : t('bookmarks.enableBold')"
                    @click="emit('toggle-bold', bookmark.id)"
                >
                    B
                </button>
                <button
                    type="button"
                    class="bookmarks-style-toggle"
                    :class="{ 'is-active': bookmark.italic }"
                    :title="bookmark.italic ? t('bookmarks.disableItalic') : t('bookmarks.enableItalic')"
                    @click="emit('toggle-italic', bookmark.id)"
                >
                    I
                </button>
                <button
                    type="button"
                    class="bookmarks-style-toggle"
                    :class="{ 'is-active': !bookmark.color }"
                    :title="t('bookmarks.defaultColor')"
                    @click="emit('set-color', { id: bookmark.id, color: null })"
                >
                    A
                </button>
            </div>
            <div class="bookmarks-context-menu-color-row">
                <button
                    v-for="preset in colorPresets"
                    :key="preset"
                    type="button"
                    class="bookmarks-color-swatch"
                    :class="{ 'is-active': bookmark.color === preset }"
                    :style="{ background: preset }"
                    :title="`Set color ${preset}`"
                    @click="emit('set-color', { id: bookmark.id, color: preset })"
                />
            </div>
        </div>

        <div class="bookmarks-context-menu-divider" />
        <button
            type="button"
            class="bookmarks-context-menu-action"
            :title="t('bookmarks.setStyleStart')"
            @click="emit('set-style-range-start', bookmark.id)"
        >
            {{ bookmark.id === styleRangeStartId ? 'Range start set' : t('bookmarks.setStyleStart') }}
        </button>
        <button
            type="button"
            class="bookmarks-context-menu-action"
            :disabled="!canApplyStyleRange"
            :title="applyStyleRangeLabel"
            @click="emit('apply-style-to-range')"
        >
            {{ applyStyleRangeLabel }}
        </button>

        <div class="bookmarks-context-menu-divider" />
        <button
            type="button"
            class="bookmarks-context-menu-action is-danger"
            :title="t('bookmarks.removeBookmark')"
            @click="emit('remove', bookmark.id)"
        >
            {{ t('bookmarks.removeBookmark') }}
        </button>
    </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { IBookmarkItem } from '@app/types/pdf-outline';
import { BOOKMARK_COLOR_PRESETS } from '@app/constants/pdf-colors';

interface IProps {
    visible: boolean;
    x: number;
    y: number;
    bookmark: IBookmarkItem | null;
    styleRangeStartId: string | null;
    canApplyStyleRange: boolean;
    applyStyleRangeLabel: string;
}

const props = defineProps<IProps>();

const emit = defineEmits<{
    (e: 'edit', id: string): void;
    (e: 'add-sibling-above', id: string): void;
    (e: 'add-sibling-below', id: string): void;
    (e: 'add-child', id: string): void;
    (e: 'toggle-bold', id: string): void;
    (e: 'toggle-italic', id: string): void;
    (e: 'set-color', payload: {
        id: string;
        color: string | null 
    }): void;
    (e: 'set-style-range-start', id: string): void;
    (e: 'apply-style-to-range'): void;
    (e: 'remove', id: string): void;
}>();

const { t } = useI18n();

const colorPresets = BOOKMARK_COLOR_PRESETS;

const menuStyle = computed(() => ({
    left: `${props.x}px`,
    top: `${props.y}px`,
}));
</script>

<style scoped>
.bookmarks-context-menu {
    position: fixed;
    z-index: 1400;
    min-width: 210px;
    border: 1px solid var(--ui-border);
    border-radius: 10px;
    background: var(--ui-bg);
    box-shadow: 0 14px 30px color-mix(in srgb, var(--ui-bg-inverted) 20%, transparent 80%);
    padding: 5px;
    display: flex;
    flex-direction: column;
    gap: 2px;
}

.bookmarks-context-menu-action {
    border: 1px solid transparent;
    border-radius: 6px;
    background: transparent;
    color: var(--ui-text-highlighted);
    font-size: 12px;
    text-align: left;
    padding: 6px 8px;
    cursor: pointer;
}

.bookmarks-context-menu-action:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}

.bookmarks-context-menu-action:hover:not(:disabled) {
    border-color: var(--ui-border);
    background: color-mix(in srgb, var(--ui-bg-muted) 55%, var(--ui-bg) 45%);
}

.bookmarks-context-menu-action.is-danger {
    color: color-mix(in srgb, var(--ui-error) 68%, var(--ui-text-highlighted) 32%);
}

.bookmarks-context-menu-divider {
    height: 1px;
    background: var(--ui-border);
    margin: 3px 2px;
}

.bookmarks-context-menu-style-block {
    padding: 3px 4px;
    display: flex;
    flex-direction: column;
    gap: 6px;
}

.bookmarks-context-menu-style-row {
    display: flex;
    gap: 6px;
}

.bookmarks-style-toggle {
    width: 24px;
    height: 24px;
    border: 1px solid var(--ui-border);
    border-radius: 5px;
    background: var(--ui-bg);
    color: var(--ui-text-muted);
    font-size: 12px;
    font-weight: 700;
    cursor: pointer;
}

.bookmarks-style-toggle:nth-child(2) {
    font-style: italic;
}

.bookmarks-style-toggle.is-active {
    border-color: color-mix(in srgb, var(--ui-primary) 50%, var(--ui-border) 50%);
    color: var(--ui-primary);
    background: color-mix(in srgb, var(--ui-primary) 9%, var(--ui-bg) 91%);
}

.bookmarks-context-menu-color-row {
    display: flex;
    gap: 6px;
}

.bookmarks-color-swatch {
    width: 18px;
    height: 18px;
    border-radius: 999px;
    border: 1px solid color-mix(in srgb, var(--ui-bg-inverted) 16%, transparent 84%);
    cursor: pointer;
}

.bookmarks-color-swatch.is-active {
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--ui-primary) 45%, transparent 55%);
}
</style>
