<template>
    <div
        ref="root"
        v-bind="$attrs"
        class="document-thumbnail-rail app-scrollbar app-scroll-region--balanced"
        data-document-thumbnail-rail
    >
        <slot />
    </div>
</template>

<script setup lang="ts">
defineOptions({inheritAttrs: false});

const {setRoot = undefined} = defineProps<{setRoot?: ((element: HTMLElement | null) => void) | undefined;}>();
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
</style>
