<template>
    <div
        ref="root"
        class="document-thumbnail-rail app-scrollbar app-scroll-region--balanced"
        :class="{'is-scroll-suppressed': scrollSuppressed}"
        data-document-thumbnail-rail
    >
        <slot />
    </div>
</template>

<script setup lang="ts">
const {
    scrollSuppressed = false,
    setRoot = undefined,
} = defineProps<{
    scrollSuppressed?: boolean;
    setRoot?: ((element: HTMLElement | null) => void) | undefined;
}>();
const root = useTemplateRef<HTMLElement>('root');

watch(root, element => setRoot?.(element), {
    immediate: true,
    flush: 'post',
});
onBeforeUnmount(() => setRoot?.(null));
</script>

<style scoped>
.document-thumbnail-rail {
    position: relative;
    box-sizing: border-box;
    height: 100%;
    min-height: 0;
    overflow: auto;
    overflow-anchor: none;
    padding: var(--app-sidebar-content-padding);
    background: var(--app-document-thumbnails-background);
}

.document-thumbnail-rail.is-scroll-suppressed {
    overflow: hidden;
}
</style>
