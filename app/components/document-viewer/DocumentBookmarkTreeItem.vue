<template>
    <div
        class="document-bookmark-item__row"
        :class="{'is-active': isActive}"
        :data-bookmark-id="item.id"
        :style="rowStyle"
        tabindex="0"
        role="button"
        :aria-current="isActive ? 'location' : undefined"
        @click="emit('activate', item.id)"
        @keydown.enter.prevent="emit('activate', item.id)"
        @keydown.space.prevent="emit('activate', item.id)"
    >
        <button
            v-if="item.children.length > 0"
            type="button"
            class="document-bookmark-item__toggle"
            :aria-label="isExpanded ? t('bookmarks.collapse') : t('bookmarks.expand')"
            :aria-expanded="isExpanded"
            @click.stop="emit('toggle-expand', item.id)"
            @keydown.enter.stop
            @keydown.space.stop
        ><UIcon :name="isExpanded ? 'i-ph-caret-down' : 'i-ph-caret-right'" class="size-4" /></button>
        <span v-else class="document-bookmark-item__spacer" />
        <span
            class="document-bookmark-item__title"
            :style="titleStyle"
        >{{ item.title || t('bookmarks.untitled') }}</span>
    </div>
</template>

<script setup lang="ts">
import type {IDocumentBookmarkTreeItem} from '@app/modules/document-viewer/public';

const props = defineProps<{
    item: IDocumentBookmarkTreeItem;
    depth: number;
    isExpanded: boolean;
    isActive: boolean;
}>();
const emit = defineEmits<{
    activate: [id: string];
    'toggle-expand': [id: string];
}>();
const {t} = useTypedI18n();
const rowStyle = computed(() => ({marginInlineStart: `calc(${String(props.depth)} * var(--app-sidebar-outline-depth-indent))`}));
const titleStyle = computed(() => ({
    color: props.item.color ?? undefined,
    fontWeight: props.item.bold ? '600' : '500',
    fontStyle: props.item.italic ? 'italic' : 'normal',
}));

</script>

<style scoped>
.document-bookmark-item__row {
    display: flex;
    box-sizing: border-box;

    /* Fixed height keyed to BOOKMARK_ROW_HEIGHT_PX in DocumentBookmarkTree.vue. */
    height: calc(var(--app-sidebar-action-size) + 2 * var(--app-sidebar-row-padding-block) + 2px);
    align-items: center;
    gap: var(--app-sidebar-row-gap);
    padding: var(--app-sidebar-row-padding-block) var(--app-sidebar-row-padding-inline);
    border: 1px solid transparent;
    border-radius: var(--app-outline-row-radius);
    cursor: pointer;
    user-select: none;
    outline: none;
    transition: background-color 0.15s, border-color 0.15s, color 0.15s;
}

.document-bookmark-item__row:hover {
    background: var(--app-sidebar-control-hover-bg);
}

.document-bookmark-item__row:focus-visible {
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--ui-primary) 35%, transparent 65%);
}

.document-bookmark-item__row.is-active {
    border-color: var(--app-control-active-border);
    background: var(--app-control-active-bg);
    color: var(--ui-text);
}

.document-bookmark-item__toggle {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: var(--app-sidebar-action-size);
    height: var(--app-sidebar-action-size);
    padding: 0;
    border: none;
    border-radius: var(--app-outline-action-radius);
    background: none;
    color: var(--ui-text-muted);
    cursor: pointer;
}

.document-bookmark-item__toggle:hover {
    background: var(--ui-bg-elevated);
}

.document-bookmark-item__spacer {
    width: var(--app-sidebar-action-size);
    flex-shrink: 0;
}

.document-bookmark-item__title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    font-size: var(--app-sidebar-row-font-size);
    line-height: 1.4;
    text-overflow: ellipsis;
    white-space: nowrap;
}
</style>
