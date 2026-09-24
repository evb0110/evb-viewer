<template>
    <div class="workspace-viewer-host">
        <!-- The document chassis stays laid out under Start so an open can
        present its first frame at the final geometry. -->
        <div
            class="workspace-viewer-host__document"
            :aria-hidden="!hasDocument ? 'true' : undefined"
        >
            <slot name="document" />
        </div>
        <div v-if="!hasDocument && !suppressEmptyState" class="workspace-viewer-host__empty">
            <slot name="empty" />
        </div>
    </div>
</template>

<script setup lang="ts">
defineProps<{
    hasDocument: boolean;
    suppressEmptyState: boolean;
}>();
</script>

<style scoped>
.workspace-viewer-host {
    position: relative;
    width: 100%;
    height: 100%;
}

.workspace-viewer-host__document {
    width: 100%;
    height: 100%;
}

.workspace-viewer-host__empty {
    position: absolute;
    inset: 0;
    z-index: var(--app-workspace-transition-overlay-z-index);
    display: flex;
    min-width: 0;
    min-height: 0;
    background: var(--app-window-bg);
}
</style>
