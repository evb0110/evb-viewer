<template>
    <component
        :is="tag"
        v-bind="$attrs"
        class="document-thumbnail-item"
        data-document-thumbnail-item
        :class="{
            'is-current': current,
            'is-disabled': disabled,
            'is-selected': selected,
        }"
        :disabled="tag === 'button' ? disabled : undefined"
        :type="tag === 'button' ? 'button' : undefined"
        :aria-current="current ? 'page' : undefined"
    >
        <slot name="overlay" />
        <span
            class="document-thumbnail-item__frame"
            :class="frameClass"
            data-document-thumbnail-frame
            :style="frameStyle"
        >
            <slot />
        </span>
        <span
            class="document-thumbnail-item__label"
            :class="labelClass"
            data-document-thumbnail-label
        >
            <slot name="label" />
        </span>
    </component>
</template>

<script setup lang="ts">
import type {CSSProperties} from 'vue';

defineOptions({inheritAttrs: false});

const {
    current = false,
    frameStyle = undefined,
    frameClass = undefined,
    labelClass = undefined,
    selected = false,
    tag = 'button',
    disabled = false,
} = defineProps<{
    current?: boolean | undefined;
    frameStyle?: CSSProperties | undefined;
    frameClass?: string | undefined;
    labelClass?: string | undefined;
    selected?: boolean | undefined;
    tag?: 'button' | 'div' | undefined;
    disabled?: boolean | undefined;
}>();
</script>

<style scoped>
.document-thumbnail-item {
    position: relative;
    display: flex;
    box-sizing: border-box;
    width: 100%;
    flex-direction: column;
    gap: var(--app-thumbnail-row-gap);
    align-items: center;
    padding: var(--app-sidebar-row-padding-block);
    border: 1px solid transparent;
    border-radius: var(--app-thumbnail-row-radius);
    cursor: pointer;
    contain: layout paint;
    transition:
        background-color 0.15s,
        border-color 0.15s;
}

.document-thumbnail-item:hover { background: var(--app-sidebar-control-hover-bg); }

.document-thumbnail-item.is-disabled {
    cursor: default;
    pointer-events: none;
}

.document-thumbnail-item.is-disabled:not(.is-selected):hover {
    background: transparent;
}

.document-thumbnail-item.is-selected {
    background: color-mix(in oklab, var(--ui-bg) 65%, var(--ui-primary) 12%);
}

.document-thumbnail-item__frame {
    display: grid;

    /* Size the cell from the slot, not the raster's intrinsic dimensions. */
    grid-template: minmax(0, 1fr) / minmax(0, 1fr);
    box-sizing: border-box;
    width: 100%;
    min-height: 0;
    flex: 0 0 auto;
    place-items: center;
    overflow: hidden;
    padding: var(--app-thumbnail-frame-inset);
    border: 1px solid var(--ui-border);
    border-radius: var(--app-space-3xs);
    background: var(--ui-bg-accented);
    box-shadow: var(--app-document-page-shadow);

    /* box-shadow stays untransitioned: animating it repaints every frame. */
    transition: border-color 0.15s ease;
}

.document-thumbnail-item.is-current .document-thumbnail-item__frame {
    border-color: var(--ui-text);
    box-shadow:
        0 0 0 1px var(--ui-text),
        var(--app-document-page-shadow);
}

.document-thumbnail-item.is-selected .document-thumbnail-item__frame {
    border-color: var(--ui-primary);
    box-shadow:
        0 0 0 1px var(--ui-primary),
        var(--app-document-page-shadow);
}

.document-thumbnail-item__frame :deep(img),
.document-thumbnail-item__frame :deep(canvas),
.document-thumbnail-item__frame :deep(.document-thumbnail-list__canvas-host) {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: contain;
}

.document-thumbnail-item__label {
    display: block;
    min-height: var(--app-thumbnail-min-label-height);
    flex: 0 0 auto;
    color: var(--ui-text-muted);
    white-space: nowrap;
    font-size: var(--app-sidebar-caption-font-size);
    line-height: var(--app-thumbnail-min-label-height);
    font-variant-numeric: tabular-nums;
}

.document-thumbnail-item.is-current .document-thumbnail-item__label,
.document-thumbnail-item.is-selected .document-thumbnail-item__label {
    color: var(--ui-text);
}

.document-thumbnail-item.is-current .document-thumbnail-item__label { font-weight: 600; }
</style>
