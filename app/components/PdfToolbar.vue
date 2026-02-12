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
                <template v-if="!isCollapsed(3)">
                    <UTooltip :text="t('toolbar.save')" :delay-duration="1200">
                        <UButton
                            icon="i-lucide-save"
                            variant="ghost"
                            color="neutral"
                            class="toolbar-icon-button"
                            :disabled="!canSave || isAnySaving || isHistoryBusy"
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
                            :disabled="isAnySaving || isHistoryBusy"
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

                <div v-if="!isCollapsed(3)" class="toolbar-button-group">
                    <div class="toolbar-group-item">
                        <UTooltip :text="t('toolbar.undo')" :delay-duration="1200">
                            <UButton
                                icon="i-lucide-undo-2"
                                variant="ghost"
                                color="neutral"
                                class="toolbar-group-button"
                                :disabled="!canUndo || isHistoryBusy || isAnySaving"
                                :aria-label="t('toolbar.undo')"
                                @click="emit('undo')"
                            />
                        </UTooltip>
                    </div>
                    <div class="toolbar-group-item">
                        <UTooltip :text="t('toolbar.redo')" :delay-duration="1200">
                            <UButton
                                icon="i-lucide-redo-2"
                                variant="ghost"
                                color="neutral"
                                class="toolbar-group-button"
                                :disabled="!canRedo || isHistoryBusy || isAnySaving"
                                :aria-label="t('toolbar.redo')"
                                @click="emit('redo')"
                            />
                        </UTooltip>
                    </div>
                </div>

                <div class="toolbar-separator" />

                <UTooltip :text="t('toolbar.toggleSidebar')" :delay-duration="1200">
                    <UButton
                        icon="i-lucide-panel-left"
                        :variant="showSidebar ? 'soft' : 'ghost'"
                        :color="showSidebar ? 'primary' : 'neutral'"
                        class="toolbar-icon-button"
                        :aria-label="t('toolbar.toggleSidebar')"
                        @click="emit('toggle-sidebar')"
                    />
                </UTooltip>
            </div>

            <div class="toolbar-separator" />

            <div class="toolbar-section toolbar-center">
                <slot name="ocr" />

                <div class="toolbar-separator" />

                <div class="toolbar-inline-group">
                    <slot name="zoom-dropdown" />
                </div>

                <div class="toolbar-separator" />

                <div v-if="!isCollapsed(2)" class="toolbar-button-group">
                    <div class="toolbar-group-item">
                        <UTooltip :text="t('zoom.fitWidth')" :delay-duration="1200">
                            <UButton
                                icon="i-lucide-move-horizontal"
                                :variant="isFitWidthActive ? 'soft' : 'ghost'"
                                :color="isFitWidthActive ? 'primary' : 'neutral'"
                                class="toolbar-group-button"
                                :aria-label="t('zoom.fitWidth')"
                                @click="emit('fit-width')"
                            />
                        </UTooltip>
                    </div>
                    <div class="toolbar-group-item">
                        <UTooltip :text="t('zoom.fitHeight')" :delay-duration="1200">
                            <UButton
                                icon="i-lucide-move-vertical"
                                :variant="isFitHeightActive ? 'soft' : 'ghost'"
                                :color="isFitHeightActive ? 'primary' : 'neutral'"
                                class="toolbar-group-button"
                                :aria-label="t('zoom.fitHeight')"
                                @click="emit('fit-height')"
                            />
                        </UTooltip>
                    </div>
                    <div v-if="!isCollapsed(1)" class="toolbar-group-item">
                        <UTooltip :text="t('zoom.continuousScroll')" :delay-duration="1200">
                            <UButton
                                icon="i-lucide-scroll"
                                :variant="continuousScroll ? 'soft' : 'ghost'"
                                :color="continuousScroll ? 'primary' : 'neutral'"
                                class="toolbar-group-button"
                                :aria-label="t('zoom.continuousScroll')"
                                @click="emit('toggle-continuous-scroll')"
                            />
                        </UTooltip>
                    </div>
                </div>

                <div class="toolbar-separator" />

                <div class="toolbar-inline-group">
                    <slot name="page-dropdown" />
                </div>

                <div class="toolbar-separator" />

                <div v-if="!isCollapsed(2)" class="toolbar-button-group">
                    <div class="toolbar-group-item">
                        <UTooltip :text="t('zoom.handTool')" :delay-duration="1200">
                            <UButton
                                icon="i-lucide-hand"
                                :variant="dragMode ? 'soft' : 'ghost'"
                                :color="dragMode ? 'primary' : 'neutral'"
                                class="toolbar-group-button"
                                :aria-label="t('zoom.handTool')"
                                @click="emit('enable-drag')"
                            />
                        </UTooltip>
                    </div>
                    <div class="toolbar-group-item">
                        <UTooltip :text="t('zoom.textSelect')" :delay-duration="1200">
                            <UButton
                                icon="i-lucide-text-cursor"
                                :variant="!dragMode ? 'soft' : 'ghost'"
                                :color="!dragMode ? 'primary' : 'neutral'"
                                class="toolbar-group-button"
                                :aria-label="t('zoom.textSelect')"
                                @click="emit('disable-drag')"
                            />
                        </UTooltip>
                    </div>
                </div>

                <slot name="overflow-menu" />
            </div>

            <div class="toolbar-separator" />

            <div class="toolbar-section toolbar-right">
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
                <UTooltip :text="t('toolbar.closeFile')" :delay-duration="1200">
                    <UButton
                        icon="i-lucide-x"
                        variant="ghost"
                        color="neutral"
                        class="toolbar-icon-button"
                        :aria-label="t('toolbar.closeFile')"
                        @click="emit('close-file')"
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
}>();

const emit = defineEmits<{
    'open-file': [];
    'open-settings': [];
    'save': [];
    'save-as': [];
    'export-docx': [];
    'undo': [];
    'redo': [];
    'close-file': [];
    'toggle-sidebar': [];
    'fit-width': [];
    'fit-height': [];
    'toggle-continuous-scroll': [];
    'enable-drag': [];
    'disable-drag': [];
}>();

const { t } = useI18n();

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
    box-shadow: 0 1px 3px 0 rgb(0 0 0 / 0.04), 0 1px 2px -1px rgb(0 0 0 / 0.04);
    background: var(--ui-bg);
    white-space: nowrap;
    overflow: hidden;
    position: relative;
    z-index: 10;
    transition: background-color 0.15s ease, border-color 0.15s ease;

    --toolbar-control-height: 2.25rem;
    --toolbar-icon-size: 18px;
}

.toolbar :deep(.u-button) {
    border-radius: 0 !important;
}

.toolbar :deep(.u-button::before),
.toolbar :deep(.u-button::after) {
    border-radius: 0 !important;
}

.toolbar-section {
    display: flex;
    align-items: center;
    gap: 0.25rem;
}

.toolbar-left {
    flex-shrink: 0;
}

.toolbar-center {
    flex: 1;
    justify-content: center;
    gap: 0.25rem;
}

.toolbar-right {
    flex-shrink: 0;
}

.toolbar-separator {
    width: 1px;
    height: 1rem;
    background: var(--ui-border);
    flex-shrink: 0;
}

.toolbar-separator:first-child,
.toolbar-separator:last-child,
.toolbar-separator + .toolbar-separator {
    display: none;
}

.toolbar-button-group {
    display: flex;
    align-items: center;
    border: 1px solid var(--ui-border);
    border-radius: 0.375rem;
    overflow: hidden;
}

.toolbar-group-item {
    display: flex;
    border-radius: 0;
}

.toolbar-group-item + .toolbar-group-item {
    border-left: 1px solid var(--ui-border);
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
    border-radius: 0 !important;
    font-size: var(--toolbar-icon-size);
    transition: background-color 0.1s ease, color 0.1s ease;
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
}
</style>
