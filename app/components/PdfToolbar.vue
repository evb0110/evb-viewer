<template>
    <header ref="toolbarRef" class="toolbar">
        <template v-if="!hasPdf">
            <UTooltip :text="t('toolbar.openPdf')" :delay-duration="1200">
                <UButton
                    icon="i-lucide-folder-open"
                    variant="ghost"
                    color="neutral"
                    class="toolbar-icon-button"
                    :aria-label="t('toolbar.openPdf')"
                    @click="emit('open-file')"
                />
            </UTooltip>
            <div class="flex-1" />
            <UTooltip :text="t('toolbar.settings')" :delay-duration="1200">
                <UButton
                    icon="i-lucide-settings"
                    variant="ghost"
                    color="neutral"
                    class="toolbar-icon-button"
                    :aria-label="t('toolbar.settings')"
                    @click="emit('open-settings')"
                />
            </UTooltip>
        </template>

        <template v-if="hasPdf">
            <div class="toolbar-section toolbar-left">
                <ToolbarToggleButton
                    icon="lucide:panel-left"
                    :active="showSidebar"
                    :tooltip="t('toolbar.toggleSidebar')"
                    @click="emit('toggle-sidebar')"
                />

                <slot name="ocr" />

                <div class="toolbar-separator" />

                <template v-if="!isCollapsed(3)">
                    <UTooltip :text="t('toolbar.save')" :delay-duration="1200">
                        <UButton
                            icon="i-lucide-save"
                            variant="ghost"
                            color="neutral"
                            class="toolbar-icon-button"
                            :disabled="!canSave || isAnySaving || isHistoryBusy || isDjvuMode"
                            :loading="isSaving"
                            :aria-label="t('toolbar.save')"
                            @click="emit('save')"
                        />
                    </UTooltip>
                    <UTooltip :text="t('toolbar.saveAs')" :delay-duration="1200">
                        <UButton
                            icon="i-lucide-save-all"
                            variant="ghost"
                            color="neutral"
                            class="toolbar-icon-button"
                            :disabled="isAnySaving || isHistoryBusy || isDjvuMode"
                            :loading="isSavingAs"
                            :aria-label="t('toolbar.saveAs')"
                            @click="emit('save-as')"
                        />
                    </UTooltip>
                </template>
                <UTooltip v-if="!isCollapsed(1)" :text="t('toolbar.exportDocx')" :delay-duration="1200">
                    <UButton
                        icon="i-lucide-file-text"
                        variant="ghost"
                        color="neutral"
                        class="toolbar-icon-button"
                        :disabled="!canExportDocx || isAnySaving || isHistoryBusy || isExportingDocx"
                        :loading="isExportingDocx"
                        :aria-label="t('toolbar.exportDocx')"
                        @click="emit('export-docx')"
                    />
                </UTooltip>

                <div class="toolbar-separator" />

                <template v-if="!isCollapsed(3)">
                    <UTooltip :text="t('toolbar.undo')" :delay-duration="1200">
                        <UButton
                            icon="i-lucide-undo-2"
                            variant="ghost"
                            color="neutral"
                            class="toolbar-icon-button"
                            :disabled="!canUndo || isHistoryBusy || isAnySaving || isDjvuMode"
                            :aria-label="t('toolbar.undo')"
                            @click="emit('undo')"
                        />
                    </UTooltip>
                    <UTooltip :text="t('toolbar.redo')" :delay-duration="1200">
                        <UButton
                            icon="i-lucide-redo-2"
                            variant="ghost"
                            color="neutral"
                            class="toolbar-icon-button"
                            :disabled="!canRedo || isHistoryBusy || isAnySaving || isDjvuMode"
                            :aria-label="t('toolbar.redo')"
                            @click="emit('redo')"
                        />
                    </UTooltip>
                </template>

                <div class="toolbar-separator" />
            </div>

            <div class="toolbar-separator" />

            <div :class="['toolbar-section', 'toolbar-center', { 'toolbar-center-collapsed': hasOverflowItems }]">
                <div class="toolbar-inline-group">
                    <slot name="zoom-dropdown" />
                </div>

                <div class="toolbar-separator" />

                <div v-if="!isCollapsed(2)" class="toolbar-button-group">
                    <div class="toolbar-group-item">
                        <ToolbarToggleButton
                            icon="lucide:move-horizontal"
                            :active="isFitWidthActive"
                            :tooltip="t('zoom.fitWidth')"
                            grouped
                            @click="emit('fit-width')"
                        />
                    </div>
                    <div class="toolbar-group-item">
                        <ToolbarToggleButton
                            icon="lucide:move-vertical"
                            :active="isFitHeightActive"
                            :tooltip="t('zoom.fitHeight')"
                            grouped
                            @click="emit('fit-height')"
                        />
                    </div>
                    <div v-if="!isCollapsed(1)" class="toolbar-group-item">
                        <ToolbarToggleButton
                            icon="lucide:scroll"
                            :active="continuousScroll"
                            :tooltip="t('zoom.continuousScroll')"
                            grouped
                            @click="emit('toggle-continuous-scroll')"
                        />
                    </div>
                </div>

                <div class="toolbar-separator" />

                <div class="toolbar-inline-group">
                    <slot name="page-dropdown" />
                </div>

                <div class="toolbar-separator" />

                <div v-if="!isCollapsed(2)" class="toolbar-button-group">
                    <div class="toolbar-group-item">
                        <ToolbarToggleButton
                            icon="lucide:hand"
                            :active="dragMode"
                            :tooltip="t('zoom.handTool')"
                            grouped
                            @click="emit('enable-drag')"
                        />
                    </div>
                    <div class="toolbar-group-item">
                        <ToolbarToggleButton
                            icon="lucide:text-cursor"
                            :active="!dragMode"
                            :tooltip="t('zoom.textSelect')"
                            grouped
                            @click="emit('disable-drag')"
                        />
                    </div>
                </div>

            </div>

            <div class="toolbar-separator" />

            <div class="toolbar-section toolbar-right">
                <slot name="overflow-menu" />
                <UTooltip :text="t('toolbar.settings')" :delay-duration="1200">
                    <UButton
                        icon="i-lucide-settings"
                        variant="ghost"
                        color="neutral"
                        class="toolbar-icon-button"
                        :aria-label="t('toolbar.settings')"
                        @click="emit('open-settings')"
                    />
                </UTooltip>
            </div>
        </template>
    </header>
</template>

<script setup lang="ts">
defineProps<{
    hasPdf: boolean;
    canSave: boolean;
    canUndo: boolean;
    canRedo: boolean;
    canExportDocx: boolean;
    isSaving: boolean;
    isSavingAs: boolean;
    isAnySaving: boolean;
    isHistoryBusy: boolean;
    isExportingDocx: boolean;
    isFitWidthActive: boolean;
    isFitHeightActive: boolean;
    showSidebar: boolean;
    dragMode: boolean;
    continuousScroll: boolean;
    collapseTier: number;
    hasOverflowItems: boolean;
    isCollapsed: (tier: number) => boolean;
    isDjvuMode?: boolean;
}>();

const emit = defineEmits<{
    'open-file': [];
    'open-settings': [];
    'save': [];
    'save-as': [];
    'export-docx': [];
    'undo': [];
    'redo': [];
    'toggle-sidebar': [];
    'fit-width': [];
    'fit-height': [];
    'toggle-continuous-scroll': [];
    'enable-drag': [];
    'disable-drag': [];
}>();

const { t } = useTypedI18n();

const toolbarRef = ref<HTMLElement | null>(null);

defineExpose({toolbarRef});
</script>

<style scoped>
.toolbar {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.5rem;
    border-bottom: 1px solid var(--ui-border);
    box-shadow: 0 1px 3px 0 rgb(0 0 0 / 0.08), 0 1px 2px -1px rgb(0 0 0 / 0.06);
    background: var(--app-chrome);
    white-space: nowrap;
    overflow: hidden;
    position: relative;
    z-index: 10;
    transition: background-color 0.15s ease, border-color 0.15s ease;

    --toolbar-control-height: 2.25rem;
    --toolbar-icon-size: 18px;
}

.toolbar :deep(.u-button) {
    border-radius: 3px !important;
}

.toolbar :deep(.u-button::before),
.toolbar :deep(.u-button::after) {
    border-radius: 3px !important;
}

.toolbar :deep(.toolbar-icon-button),
.toolbar :deep(.toolbar-group-button),
.toolbar :deep(.zoom-controls-button),
.toolbar :deep(.page-controls-button) {
    border: 1px solid transparent !important;
    background: transparent !important;
    color: var(--ui-text) !important;
    transition: background-color 0.1s ease, color 0.1s ease, box-shadow 0.1s ease, opacity 0.1s ease;
}

.toolbar :deep(.toolbar-icon-button:hover:not(:disabled)),
.toolbar :deep(.toolbar-group-button:hover:not(:disabled)),
.toolbar :deep(.zoom-controls-button:hover:not(:disabled)),
.toolbar :deep(.page-controls-button:hover:not(:disabled)) {
    background: var(--app-toolbar-control-hover-bg) !important;
    color: var(--ui-text) !important;
}

.toolbar :deep(.toolbar-icon-button:disabled),
.toolbar :deep(.toolbar-group-button:disabled),
.toolbar :deep(.zoom-controls-button:disabled),
.toolbar :deep(.page-controls-button:disabled) {
    opacity: 0.4 !important;
    cursor: not-allowed !important;
}

.toolbar :deep(.toolbar-icon-button:focus),
.toolbar :deep(.toolbar-group-button:focus),
.toolbar :deep(.zoom-controls-button:focus),
.toolbar :deep(.page-controls-button:focus) {
    outline: none;
}

.toolbar :deep(.toolbar-icon-button:focus-visible),
.toolbar :deep(.toolbar-group-button:focus-visible),
.toolbar :deep(.zoom-controls-button:focus-visible),
.toolbar :deep(.page-controls-button:focus-visible) {
    box-shadow: inset 0 0 0 1px var(--app-toolbar-focus-ring) !important;
}

.toolbar-section {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    min-width: 0;
}

.toolbar-left {
    flex-shrink: 0;
}

.toolbar-center {
    flex: 1;
    min-width: 0;
    justify-content: center;
    gap: 0.25rem;
    overflow: hidden;
}

.toolbar-center-collapsed {
    justify-content: flex-start;
}

.toolbar-right {
    flex-shrink: 0;
}

.toolbar-separator {
    width: 1px;
    height: 0.875rem;
    background: color-mix(in oklab, var(--ui-border) 45%, transparent 55%);
    flex-shrink: 0;
    margin: 0 0.125rem;
}

.toolbar-separator:first-child,
.toolbar-separator:last-child,
.toolbar-separator + .toolbar-separator {
    display: none;
}

.toolbar-button-group {
    display: flex;
    align-items: center;
    border: 1px solid var(--app-toolbar-group-border);
    border-radius: 0.375rem;
    overflow: hidden;
    flex-shrink: 0;
    min-width: max-content;
}

.toolbar-group-item {
    display: flex;
    border-radius: 0;
}

.toolbar-group-item + .toolbar-group-item {
    border-left: 1px solid var(--app-toolbar-group-border);
}

.toolbar-button-group :deep(button),
.toolbar-button-group :deep(.u-button) {
    border-radius: 0 !important;
}

.toolbar-icon-button {
    width: var(--toolbar-control-height);
    height: var(--toolbar-control-height);
    padding: 0.25rem;
    justify-content: center;
    border-radius: 3px !important;
    font-size: var(--toolbar-icon-size);
    transition: background-color 0.1s ease, color 0.1s ease, box-shadow 0.1s ease;
}

.toolbar-group-button {
    border-radius: 0 !important;
    height: var(--toolbar-control-height);
    min-width: var(--toolbar-control-height);
    padding: 0.25rem;
    font-size: var(--toolbar-icon-size);
    transition: background-color 0.1s ease, color 0.1s ease;
}

.toolbar :deep(.toolbar-icon-button svg),
.toolbar :deep(.toolbar-group-button svg) {
    width: 1.1rem;
    height: 1.1rem;
}

.toolbar-inline-group {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    flex-shrink: 0;
    min-width: max-content;
}

</style>
