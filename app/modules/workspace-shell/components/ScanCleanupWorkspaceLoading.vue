<template>
    <Teleport
        v-if="toolbarActive"
        to="#editor-global-toolbar-host"
        :disabled="!canTeleportToolbar"
    >
        <header
            class="toolbar scan-cleanup-loading-toolbar"
            :aria-label="t('scanCleanup.workspaceTitle')"
            aria-busy="true"
        >
            <div class="scan-cleanup-loading-toolbar-left">
                <span class="scan-cleanup-loading-block is-toolbar-icon" />
                <span class="scan-cleanup-loading-block is-toolbar-title" />
            </div>
            <span class="scan-cleanup-loading-block is-toolbar-status" />
            <span class="scan-cleanup-loading-block is-toolbar-action" />
        </header>
    </Teleport>
    <section
        class="scan-cleanup-loading-surface"
        :aria-label="t('scanCleanup.workspaceTitle')"
        aria-busy="true"
        role="status"
    >
        <span class="sr-only">{{ t('scanCleanup.preview.loading') }}</span>
        <aside class="scan-cleanup-loading-rail is-pages">
            <span class="scan-cleanup-loading-block is-heading" />
            <span
                v-for="index in 3"
                :key="index"
                class="scan-cleanup-loading-block is-thumbnail"
            />
        </aside>
        <main class="scan-cleanup-loading-preview">
            <header class="scan-cleanup-loading-preview-header">
                <span class="scan-cleanup-loading-block is-navigation" />
                <span class="scan-cleanup-loading-block is-controls" />
            </header>
            <div class="scan-cleanup-loading-preview-stage">
                <span class="scan-cleanup-loading-block is-paper" />
            </div>
        </main>
        <aside class="scan-cleanup-loading-rail is-settings">
            <span class="scan-cleanup-loading-block is-heading" />
            <span
                v-for="index in 7"
                :key="index"
                class="scan-cleanup-loading-block is-setting"
            />
        </aside>
    </section>
</template>

<script setup lang="ts">
defineProps<{
    canTeleportToolbar: boolean;
    toolbarActive: boolean;
}>();

const {t} = useTypedI18n();
</script>

<style scoped>
.scan-cleanup-loading-surface {
    grid-area: 1 / 1;
    display: grid;
    min-width: 0;
    min-height: 0;
    flex: 1;
    grid-template-columns:
        minmax(var(--app-scan-page-list-collapsed-width), var(--app-scan-page-list-width))
        minmax(0, 1fr)
        var(--app-scan-dialog-rail-width);
    background: var(--ui-bg);
    overflow: hidden;
}

.scan-cleanup-loading-toolbar {
    justify-content: space-between;
}

.scan-cleanup-loading-toolbar-left {
    display: flex;
    align-items: center;
    gap: var(--app-space-lg);
}

.scan-cleanup-loading-rail,
.scan-cleanup-loading-preview {
    min-width: 0;
    min-height: 0;
}

.scan-cleanup-loading-rail {
    display: flex;
    flex-direction: column;
    gap: var(--app-space-3xl);
    padding: var(--app-space-3xl);
}

.scan-cleanup-loading-rail.is-pages {
    border-inline-end: var(--app-hairline-height) solid var(--ui-border);
}

.scan-cleanup-loading-rail.is-settings {
    border-inline-start: var(--app-hairline-height) solid var(--ui-border);
}

.scan-cleanup-loading-preview {
    display: grid;
    grid-template-rows: var(--app-scan-header-height) minmax(0, 1fr);
}

.scan-cleanup-loading-preview-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding-inline: var(--app-space-3xl);
    border-block-end: var(--app-hairline-height) solid var(--ui-border);
}

.scan-cleanup-loading-preview-stage {
    display: grid;
    min-height: 0;
    place-items: center;
    background: var(--ui-bg-muted);
    margin: var(--app-space-12xl);
}

.scan-cleanup-loading-block {
    display: block;
    border-radius: var(--app-radius-sm);
    background: var(--ui-bg-accented);
}

.scan-cleanup-loading-block.is-toolbar-icon {
    width: var(--app-control-height-sm);
    height: var(--app-control-height-sm);
}

.scan-cleanup-loading-block.is-toolbar-title {
    width: calc(var(--app-control-height-sm) * 3.5);
    height: var(--app-space-lg);
}

.scan-cleanup-loading-block.is-toolbar-status {
    width: calc(var(--app-control-height-sm) * 6);
    height: var(--app-space-lg);
}

.scan-cleanup-loading-block.is-toolbar-action {
    width: calc(var(--app-control-height-sm) * 4);
    height: var(--app-control-height-sm);
}

.scan-cleanup-loading-block.is-heading {
    width: 45%;
    height: var(--app-space-lg);
}

.scan-cleanup-loading-block.is-thumbnail {
    width: 100%;
    aspect-ratio: 3 / 4;
}

.scan-cleanup-loading-block.is-navigation {
    width: calc(var(--app-control-height-sm) * 4);
    height: var(--app-control-height-sm);
}

.scan-cleanup-loading-block.is-controls {
    width: calc(var(--app-control-height-sm) * 6);
    height: var(--app-control-height-sm);
}

.scan-cleanup-loading-block.is-paper {
    width: min(42%, 28rem);
    height: min(78%, 42rem);
    border-radius: var(--app-radius-md);
    background: var(--ui-bg);
    box-shadow: var(--app-document-page-shadow);
}

.scan-cleanup-loading-block.is-setting {
    width: 100%;
    height: var(--app-control-height-sm);
}

@container (width <= 72rem) {
    .scan-cleanup-loading-surface {
        grid-template-columns:
            minmax(var(--app-scan-page-list-collapsed-width), 14rem)
            minmax(0, 1fr)
            minmax(16rem, var(--app-scan-dialog-rail-width));
    }
}
</style>
