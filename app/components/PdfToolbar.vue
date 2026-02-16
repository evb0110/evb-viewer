<template>
    <header ref="toolbarRef" class="toolbar">
        <template v-if="!hasPdf">
            <ToolbarButton
                icon="lucide:folder-open"
                :tooltip="t('toolbar.openPdf')"
                @click="emit('open-file')"
            />
            <div class="flex-1" />
            <ToolbarButton
                icon="lucide:settings"
                :tooltip="t('toolbar.settings')"
                @click="emit('open-settings')"
            />
        </template>

        <template v-if="hasPdf">
            <div class="toolbar-section toolbar-left">
                <ToolbarButton
                    icon="lucide:panel-left"
                    :active="showSidebar"
                    :tooltip="t('toolbar.toggleSidebar')"
                    @click="emit('toggle-sidebar')"
                />

                <slot
                    name="ocr"
                    :collapse-tier="collapseTier"
                    :has-overflow-items="hasOverflowItems"
                    :is-collapsed="isCollapsed"
                />

                <div class="toolbar-separator" />

                <template v-if="!isCollapsed(3)">
                    <ToolbarButton
                        icon="lucide:save"
                        :tooltip="t('toolbar.save')"
                        :disabled="!canSave || isAnySaving || isHistoryBusy || isDjvuMode"
                        :loading="isSaving"
                        @click="emit('save')"
                    />
                    <ToolbarButton
                        icon="lucide:save-all"
                        :tooltip="t('toolbar.saveAs')"
                        :disabled="isAnySaving || isHistoryBusy || isDjvuMode"
                        :loading="isSavingAs"
                        @click="emit('save-as')"
                    />
                </template>
                <ToolbarButton
                    v-if="!isCollapsed(1)"
                    icon="lucide:file-text"
                    :tooltip="t('toolbar.exportDocx')"
                    :disabled="!canExportDocx || isAnySaving || isHistoryBusy || isExportingDocx"
                    :loading="isExportingDocx"
                    @click="emit('export-docx')"
                />

                <div class="toolbar-separator" />

                <template v-if="!isCollapsed(3)">
                    <ToolbarButton
                        icon="lucide:undo-2"
                        :tooltip="t('toolbar.undo')"
                        :disabled="!canUndo || isHistoryBusy || isAnySaving || isDjvuMode"
                        @click="emit('undo')"
                    />
                    <ToolbarButton
                        icon="lucide:redo-2"
                        :tooltip="t('toolbar.redo')"
                        :disabled="!canRedo || isHistoryBusy || isAnySaving || isDjvuMode"
                        @click="emit('redo')"
                    />
                </template>
                <ToolbarButton
                    icon="lucide:scan"
                    :active="isCapturingRegion"
                    :tooltip="t('toolbar.captureRegion')"
                    @click="emit('capture-region')"
                />

                <div class="toolbar-separator" />
            </div>

            <div class="toolbar-separator" />

            <div :class="['toolbar-section', 'toolbar-center', { 'toolbar-center-collapsed': hasOverflowItems }]">
                <div class="toolbar-inline-group">
                    <slot
                        name="zoom-dropdown"
                        :collapse-tier="collapseTier"
                        :has-overflow-items="hasOverflowItems"
                        :is-collapsed="isCollapsed"
                    />
                </div>

                <div class="toolbar-separator" />

                <div v-if="!isCollapsed(2)" class="toolbar-button-group">
                    <div class="toolbar-group-item">
                        <ToolbarButton
                            icon="lucide:move-horizontal"
                            :active="isFitWidthActive"
                            :tooltip="t('zoom.fitWidth')"
                            grouped
                            @click="emit('fit-width')"
                        />
                    </div>
                    <div class="toolbar-group-item">
                        <ToolbarButton
                            icon="lucide:move-vertical"
                            :active="isFitHeightActive"
                            :tooltip="t('zoom.fitHeight')"
                            grouped
                            @click="emit('fit-height')"
                        />
                    </div>
                    <div v-if="!isCollapsed(1)" class="toolbar-group-item">
                        <ToolbarButton
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
                    <slot
                        name="page-dropdown"
                        :collapse-tier="collapseTier"
                        :has-overflow-items="hasOverflowItems"
                        :is-collapsed="isCollapsed"
                    />
                </div>

                <div class="toolbar-separator" />

                <div v-if="!isCollapsed(2)" class="toolbar-button-group">
                    <div class="toolbar-group-item">
                        <ToolbarButton
                            icon="lucide:hand"
                            :active="dragMode"
                            :tooltip="t('zoom.handTool')"
                            grouped
                            @click="emit('enable-drag')"
                        />
                    </div>
                    <div class="toolbar-group-item">
                        <ToolbarButton
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
                <slot
                    name="overflow-menu"
                    :collapse-tier="collapseTier"
                    :has-overflow-items="hasOverflowItems"
                    :is-collapsed="isCollapsed"
                />
                <ToolbarButton
                    icon="lucide:settings"
                    :tooltip="t('toolbar.settings')"
                    @click="emit('open-settings')"
                />
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
    isCapturingRegion: boolean;
    continuousScroll: boolean;
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
    'capture-region': [];
}>();

const { t } = useTypedI18n();

const {
    toolbarRef,
    collapseTier,
    hasOverflowItems,
    isCollapsed,
} = useToolbarOverflow();
</script>

<style scoped>
/*
 * Toolbar layout
 * ──────────────
 * All interactive controls share --toolbar-control-height (2.25rem / 36px).
 *
 * Two button types:
 *   1. ToolbarButton  — native <button> with <Icon>. Handles sizing, hover, disabled,
 *      focus, toggle (active), loading, and grouped states internally via scoped CSS.
 *   2. Zoom/Page controls — composite widgets in their own components, using
 *      ToolbarButton for icon buttons and native elements for displays/inputs.
 */
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

.toolbar-inline-group {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    flex-shrink: 0;
    min-width: max-content;
}
</style>
