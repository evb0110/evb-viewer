<template>
    <div class="pdf-bookmarks-toolbar">
        <div
            class="pdf-bookmarks-view-modes"
            role="group"
            aria-label="Bookmark controls"
        >
            <UTooltip
                v-for="option in displayModeOptions"
                :key="option.id"
                :text="option.title"
                :delay-duration="800"
            >
                <button
                    type="button"
                    class="pdf-bookmarks-view-mode-button"
                    :class="{ 'is-active': displayMode === option.id }"
                    :title="option.title"
                    :aria-label="option.title"
                    @click="emit('set-display-mode', option.id)"
                >
                    <UIcon
                        :name="option.icon"
                        class="size-4"
                    />
                </button>
            </UTooltip>
            <UTooltip
                :text="isEditMode ? t('bookmarks.exitEditMode') : t('bookmarks.enterEditMode')"
                :delay-duration="800"
            >
                <button
                    type="button"
                    class="pdf-bookmarks-view-mode-button"
                    :class="{ 'is-active': isEditMode }"
                    :title="isEditMode ? t('bookmarks.exitEditMode') : t('bookmarks.enterEditMode')"
                    :aria-label="isEditMode ? t('bookmarks.exitEditMode') : t('bookmarks.enterEditMode')"
                    @click="emit('toggle-edit-mode')"
                >
                    <UIcon
                        :name="isEditMode ? 'i-lucide-square-pen' : 'i-lucide-pencil'"
                        class="size-4"
                    />
                </button>
            </UTooltip>
        </div>

        <div class="pdf-bookmarks-toolbar-actions">
            <UTooltip
                v-if="isEditMode"
                :text="t('bookmarks.addTopLevel')"
                :delay-duration="800"
            >
                <button
                    type="button"
                    class="pdf-bookmarks-icon-button"
                    :title="t('bookmarks.addTopLevel')"
                    :aria-label="t('bookmarks.addTopLevel')"
                    @click="emit('add-root-bookmark')"
                >
                    <UIcon
                        name="i-lucide-plus"
                        class="size-4"
                    />
                </button>
            </UTooltip>
        </div>
    </div>
</template>

<script setup lang="ts">
import type { TBookmarkDisplayMode } from '@app/types/pdf-outline';

interface IProps {
    displayMode: TBookmarkDisplayMode;
    isEditMode: boolean;
}

defineProps<IProps>();

const emit = defineEmits<{
    (e: 'set-display-mode', mode: TBookmarkDisplayMode): void;
    (e: 'toggle-edit-mode'): void;
    (e: 'add-root-bookmark'): void;
}>();

const { t } = useI18n();

const displayModeOptions = [
    {
        id: 'top-level',
        title: 'Top level only',
        icon: 'i-lucide-list',
    },
    {
        id: 'all-expanded',
        title: 'Expand all bookmarks',
        icon: 'i-lucide-chevrons-down',
    },
    {
        id: 'current-expanded',
        title: 'Expand current bookmark path',
        icon: 'i-lucide-eye',
    },
] satisfies Array<{
    id: TBookmarkDisplayMode;
    title: string;
    icon: string 
}>;
</script>

<style scoped>
.pdf-bookmarks-toolbar {
    display: grid;
    grid-template-columns: 1fr auto;
    align-items: center;
    gap: 6px;
}

.pdf-bookmarks-view-modes {
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
}

.pdf-bookmarks-view-mode-button,
.pdf-bookmarks-icon-button {
    border: 1px solid var(--ui-border);
    border-radius: 6px;
    background: var(--ui-bg);
    color: var(--ui-text-muted);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    cursor: pointer;
}

.pdf-bookmarks-view-mode-button:hover,
.pdf-bookmarks-icon-button:hover {
    background: var(--ui-bg-muted);
    color: var(--ui-text-highlighted);
}

.pdf-bookmarks-view-mode-button.is-active {
    border-color: color-mix(in srgb, var(--ui-primary) 45%, var(--ui-border) 55%);
    color: var(--ui-primary);
    background: color-mix(in srgb, var(--ui-primary) 8%, var(--ui-bg) 92%);
}

.pdf-bookmarks-toolbar-actions {
    display: inline-flex;
    gap: 4px;
}

@media (width <= 780px) {
    .pdf-bookmarks-toolbar {
        grid-template-columns: 1fr;
    }

    .pdf-bookmarks-toolbar-actions {
        justify-content: flex-end;
    }
}
</style>
