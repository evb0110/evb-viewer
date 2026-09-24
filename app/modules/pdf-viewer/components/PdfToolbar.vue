<template>
    <header
        ref="toolbarRef"
        :class="['toolbar', `toolbar--${variant}`, {'toolbar--has-ocr-action': hasOcrAction}]"
        :data-collapse-tier="collapseTier"
        role="toolbar"
        :aria-label="t('toolbar.readerToolbar')"
    >
        <div class="toolbar-section toolbar-left">
            <slot
                v-if="isCommandInline('app-menu')"
                name="app-menu"
                :collapse-tier="collapseTier"
                :has-overflow-items="hasOverflowItems"
                :is-collapsed="isCollapsed"
            />
            <ToolbarButton
                v-if="isCommandInline('open-file') && !isCollapsed(5)"
                :icon="getReaderCommandToolbarIcon('open-file')"
                :tooltip="t('toolbar.openPdf')"
                :shortcut="shortcutLabels.openFile"
                :disabled="isOpeningDocument"
                :loading="isOpeningDocument"
                @click="handleToolbarCommand('open-file')"
            />
            <ToolbarButton
                v-if="isCommandInline('toggle-sidebar') && !isCollapsed(5)"
                :icon="getReaderCommandToolbarIcon('toggle-sidebar')"
                :active="showSidebar"
                :tooltip="t('toolbar.toggleSidebar')"
                :shortcut="shortcutLabels.toggleSidebar"
                :disabled="!hasInteractiveDocument || canToggleSidebar === false"
                @click="handleToolbarCommand('toggle-sidebar')"
            />

            <div
                v-if="!isCollapsed(4) && (isCommandInline('save') || isCommandInline('print') || isCommandInline('print-current-page'))"
                class="toolbar-cluster"
            >
                <div class="toolbar-action toolbar-action--save">
                    <ToolbarSaveSplitButton
                        v-if="isCommandInline('save')"
                        :save-tooltip="t('toolbar.save')"
                        :save-shortcut="shortcutLabels.save"
                        :save-as-shortcut="shortcutLabels.saveAs"
                        :save-disabled="!hasInteractiveDocument || !canSave || isAnySaving || isHistoryBusy || isDjvuMode"
                        :save-as-disabled="!hasInteractiveDocument || !canSaveAs || isAnySaving || isHistoryBusy || isDjvuMode"
                        :is-saving="isSaving"
                        :is-saving-as="isSavingAs"
                        @save="handleToolbarCommand('save')"
                        @save-as="handleToolbarCommand('save-as')"
                    />
                </div>
                <div class="toolbar-action toolbar-action--print">
                    <ToolbarButton
                        v-if="isCommandInline('print')"
                        :icon="getReaderCommandToolbarIcon('print')"
                        :tooltip="t('toolbar.print')"
                        :shortcut="shortcutLabels.print"
                        :disabled="isPrintCommandDisabled"
                        :loading="isPreparingPrint && !isPreparingCurrentPagePrint"
                        @click="handleToolbarCommand('print')"
                    />
                </div>
                <div class="toolbar-action toolbar-action--print-current-page">
                    <ToolbarButton
                        v-if="isCommandInline('print-current-page')"
                        icon="ph:printer"
                        :tooltip="t('toolbar.printCurrentPage')"
                        :disabled="isPrintCommandDisabled"
                        :loading="isPreparingCurrentPagePrint"
                        @click="handleToolbarCommand('print-current-page')"
                    >
                        <PrintCurrentPageIcon class="size-full" />
                    </ToolbarButton>
                </div>
            </div>

            <div
                v-if="!isCollapsed(4) && (isCommandInline('undo') || isCommandInline('redo'))"
                class="toolbar-cluster"
            >
                <div class="toolbar-action toolbar-action--undo">
                    <ToolbarButton
                        v-if="isCommandInline('undo')"
                        :icon="getReaderCommandToolbarIcon('undo')"
                        :tooltip="t('toolbar.undo')"
                        :shortcut="shortcutLabels.undo"
                        :disabled="!hasInteractiveDocument || !canUndo || isHistoryBusy || isAnySaving || isDjvuMode"
                        @click="handleToolbarCommand('undo')"
                    />
                </div>
                <div class="toolbar-action toolbar-action--redo">
                    <ToolbarButton
                        v-if="isCommandInline('redo')"
                        :icon="getReaderCommandToolbarIcon('redo')"
                        :tooltip="t('toolbar.redo')"
                        :shortcut="shortcutLabels.redo"
                        :disabled="!hasInteractiveDocument || !canRedo || isHistoryBusy || isAnySaving || isDjvuMode"
                        @click="handleToolbarCommand('redo')"
                    />
                </div>
            </div>
        </div>

        <div class="toolbar-section toolbar-center">
            <div class="toolbar-inline-group">
                <slot
                    v-if="isCommandInline('page-navigation')"
                    name="page-dropdown"
                    :collapse-tier="collapseTier"
                    :compact-level="pageCompactLevel"
                    :has-overflow-items="hasOverflowItems"
                    :is-collapsed="isCollapsed"
                />
            </div>

            <div class="toolbar-inline-group">
                <slot
                    v-if="isCommandInline('zoom')"
                    name="zoom-dropdown"
                    :collapse-tier="collapseTier"
                    :compact-level="zoomCompactLevel"
                    :has-overflow-items="hasOverflowItems"
                    :is-collapsed="isCollapsed"
                />
            </div>

            <div v-if="!isCollapsed(2)" class="toolbar-button-group toolbar-button-group--fit">
                <div v-if="isCommandInline('fit-width')" class="toolbar-group-item">
                    <ToolbarButton
                        :icon="getReaderCommandToolbarIcon('fit-width')"
                        :active="isFitWidthActive"
                        :tooltip="t('zoom.fitWidth')"
                        :shortcut="shortcutLabels.fitWidth"
                        :disabled="!hasInteractiveDocument"
                        grouped
                        @click="handleToolbarCommand('fit-width')"
                    />
                </div>
                <div v-if="isCommandInline('fit-height')" class="toolbar-group-item">
                    <ToolbarButton
                        :icon="getReaderCommandToolbarIcon('fit-height')"
                        :active="isFitHeightActive"
                        :tooltip="t('zoom.fitHeight')"
                        :shortcut="shortcutLabels.fitHeight"
                        :disabled="!hasInteractiveDocument"
                        grouped
                        @click="handleToolbarCommand('fit-height')"
                    />
                </div>
                <div v-if="isCommandInline('continuous-scroll') && !isCollapsed(2)" class="toolbar-group-item toolbar-group-item--continuous-scroll">
                    <ToolbarButton
                        :icon="getReaderCommandToolbarIcon('continuous-scroll')"
                        :active="continuousScroll"
                        :tooltip="t('zoom.continuousScroll')"
                        :disabled="!hasInteractiveDocument || !canToggleContinuousScroll"
                        grouped
                        @click="handleToolbarCommand('toggle-continuous-scroll')"
                    />
                </div>
            </div>

            <div v-if="!isCollapsed(3)" class="toolbar-separator" />

            <div v-if="!isCollapsed(3)" class="toolbar-button-group toolbar-button-group--interaction">
                <div v-if="isCommandInline('quick-note')" class="toolbar-group-item toolbar-group-item--quick-note">
                    <ToolbarButton
                        :icon="getReaderCommandToolbarIcon('quick-note')"
                        :active="isPlacingPageNote"
                        :tooltip="isPlacingPageNote ? t('annotations.placeHint') : t('annotations.stickyDescription')"
                        :disabled="!hasInteractiveDocument || isDjvuMode"
                        grouped
                        @click="handleToolbarCommand('quick-note')"
                    />
                </div>
                <div v-if="isCommandInline('drag-mode')" class="toolbar-group-item toolbar-group-item--drag-mode">
                    <ToolbarButton
                        :icon="getReaderCommandToolbarIcon('drag-mode')"
                        :active="dragMode && !isPlacingPageNote"
                        :tooltip="t('zoom.handTool')"
                        :disabled="!hasInteractiveDocument"
                        grouped
                        @click="handleToolbarCommand('enable-drag')"
                    />
                </div>
                <div v-if="isCommandInline('text-select')" class="toolbar-group-item toolbar-group-item--text-select">
                    <ToolbarButton
                        :icon="getReaderCommandToolbarIcon('text-select')"
                        :active="!dragMode && !isPlacingPageNote"
                        :tooltip="t('zoom.textSelect')"
                        :disabled="!hasInteractiveDocument"
                        grouped
                        @click="handleToolbarCommand('disable-drag')"
                    />
                </div>
            </div>
        </div>

        <div class="toolbar-section toolbar-right">
            <div
                v-if="!isCollapsed(3) && (isCommandInline('capture-region') || isCommandInline('crop'))"
                class="toolbar-cluster"
            >
                <div class="toolbar-action toolbar-action--capture-region">
                    <ToolbarButton
                        v-if="isCommandInline('capture-region')"
                        :icon="getReaderCommandToolbarIcon('capture-region')"
                        :active="isCapturingRegion"
                        :tooltip="t('toolbar.captureRegion')"
                        :disabled="!hasInteractiveDocument || isDjvuMode"
                        @click="handleToolbarCommand('capture-region')"
                    />
                </div>
                <div class="toolbar-action toolbar-action--crop">
                    <ToolbarButton
                        v-if="isCommandInline('crop')"
                        :icon="getReaderCommandToolbarIcon('crop')"
                        :active="isCropSelecting"
                        :tooltip="t('toolbar.crop')"
                        :disabled="!hasInteractiveDocument || isDjvuMode"
                        @click="handleToolbarCommand('crop')"
                    />
                </div>
            </div>

            <div
                v-if="!isCollapsed(1) && (hasScanCleanupAction || isCommandInline('ocr') || isCommandInline('export-docx'))"
                class="toolbar-cluster"
            >
                <div
                    v-if="hasScanCleanupAction"
                    class="toolbar-action toolbar-action--scan-cleanup"
                >
                    <slot
                        name="scan-cleanup"
                        :collapse-tier="collapseTier"
                        :has-overflow-items="hasOverflowItems"
                        :is-collapsed="isCollapsed"
                    />
                </div>
                <div class="toolbar-action toolbar-action--ocr">
                    <slot
                        v-if="isCommandInline('ocr')"
                        name="ocr"
                        :collapse-tier="collapseTier"
                        :has-overflow-items="hasOverflowItems"
                        :is-collapsed="isCollapsed"
                    />
                </div>
                <div class="toolbar-action toolbar-action--export-docx">
                    <ToolbarButton
                        v-if="isCommandInline('export-docx')"
                        :icon="isExportingDocx ? 'ph:stop' : getReaderCommandToolbarIcon('export-docx')"
                        :tooltip="isExportingDocx ? t('ocr.cancel') : t('toolbar.exportDocx')"
                        :shortcut="shortcutLabels.exportDocx"
                        :disabled="!isExportingDocx && (!hasInteractiveDocument || !canExportDocx || isAnySaving || isHistoryBusy)"
                        @click="handleToolbarCommand('export-docx')"
                    />
                </div>
            </div>

            <div v-if="!isCollapsed(1)" class="toolbar-separator" />

            <div class="toolbar-cluster">
                <slot
                    v-if="isCommandInline('overflow-menu')"
                    name="overflow-menu"
                    :collapse-tier="collapseTier"
                    :has-overflow-items="hasOverflowItems"
                    :is-collapsed="isCollapsed"
                />
                <ToolbarButton
                    v-if="isCommandInline('fullscreen') && !isCollapsed(5)"
                    :icon="isFullscreen ? 'ph:corners-in' : getReaderCommandToolbarIcon('fullscreen')"
                    :tooltip="t('toolbar.fullscreen')"
                    :active="isFullscreen"
                    :disabled="!hasInteractiveDocument || !fullscreenSupported"
                    @click="handleToolbarCommand('toggle-fullscreen')"
                />
                <AssistantToolbarToggle v-if="!isCollapsed(5)" />
                <ToolbarButton
                    v-if="isCommandInline('settings') && !isCollapsed(5)"
                    :icon="getReaderCommandToolbarIcon('settings')"
                    :tooltip="t('toolbar.settings')"
                    @click="handleToolbarCommand('open-settings')"
                />
            </div>
        </div>
        <slot name="persistent-actions" />
    </header>
</template>

<script setup lang="ts">
import ToolbarButton from '@app/components/ToolbarButton.vue';
import ToolbarSaveSplitButton from '@app/components/toolbar/ToolbarSaveSplitButton.vue';
import { AssistantToolbarToggle } from '@app/modules/agent-panel/public/component-exports/assistantToolbarToggle';
import PrintCurrentPageIcon from '@app/components/icons/PrintCurrentPageIcon.vue';
import { useShortcutLabels } from '@app/constants/shortcuts';
import { getReaderCommandToolbarIcon } from '@app/utils/readerCommandIcons';
import { isReaderPrintCommandDisabled } from '@app/utils/isReaderPrintCommandDisabled';
import {
    isReaderCommandInline,
    type TReaderCommandId,
    type IReaderCommandSurface,
} from '@app/utils/readerCommandSurface';

const {
    hasPdf,
    surface = undefined,
    variant = 'editor',
    documentBusy = false,
    isOpeningDocument = false,
    isFullscreen = false,
    fullscreenSupported = true,
    hasScanCleanupAction = false,
    canPrint = true,
    canSaveAs = true,
    canToggleContinuousScroll = true,
    isAnySaving,
    isHistoryBusy,
    isPreparingPrint = false,
} = defineProps<{
    hasPdf: boolean;
    variant?: 'editor' | 'reader';
    documentBusy?: boolean;
    isFullscreen?: boolean;
    fullscreenSupported?: boolean;
    hasOcrAction?: boolean;
    hasScanCleanupAction?: boolean;
    canToggleSidebar?: boolean;
    canPrint?: boolean;
    canSaveAs?: boolean;
    canToggleContinuousScroll?: boolean;
    canSave: boolean;
    canUndo: boolean;
    canRedo: boolean;
    canExportDocx: boolean;
    isSaving: boolean;
    isSavingAs: boolean;
    isAnySaving: boolean;
    isHistoryBusy: boolean;
    isExportingDocx: boolean;
    isOpeningDocument?: boolean;
    isPreparingPrint?: boolean;
    isPreparingCurrentPagePrint?: boolean;
    isFitWidthActive: boolean;
    isFitHeightActive: boolean;
    showSidebar: boolean;
    dragMode: boolean;
    isCapturingRegion: boolean;
    isCropSelecting: boolean;
    isPlacingPageNote: boolean;
    continuousScroll: boolean;
    isDjvuMode?: boolean;
    surface?: IReaderCommandSurface;
}>();

const emit = defineEmits<{
    'open-file': [];
    'open-settings': [];
    'save': [];
    'save-as': [];
    'print': [];
    'print-current-page': [];
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
    'crop': [];
    'quick-note': [];
    'toggle-fullscreen': [];
}>();

type TToolbarCommand =
    | 'open-file'
    | 'open-settings'
    | 'save'
    | 'save-as'
    | 'print'
    | 'print-current-page'
    | 'export-docx'
    | 'undo'
    | 'redo'
    | 'toggle-sidebar'
    | 'fit-width'
    | 'fit-height'
    | 'toggle-continuous-scroll'
    | 'enable-drag'
    | 'disable-drag'
    | 'capture-region'
    | 'crop'
    | 'quick-note'
    | 'toggle-fullscreen';

const { t } = useTypedI18n();

const shortcutLabels = useShortcutLabels();
const hasInteractiveDocument = computed(() => hasPdf && !documentBusy && !isOpeningDocument);
const isPrintCommandDisabled = computed(() => isReaderPrintCommandDisabled({
    hasInteractiveDocument: hasInteractiveDocument.value,
    canPrint,
    isPreparingPrint,
    isAnySaving,
    isHistoryBusy,
}));
const {
    toolbarRef,
    collapseTier,
    hasOverflowItems: hasMeasuredOverflowItems,
    isCollapsed,
} = useToolbarOverflow();
const hasOverflowItems = computed(() => hasMeasuredOverflowItems.value || isCommandInline('overflow-menu'));
const pageCompactLevel = computed(() => {
    if (collapseTier.value >= 4) {
        return 3;
    }
    if (collapseTier.value >= 2) {
        return 2;
    }
    if (collapseTier.value >= 1) {
        return 1;
    }
    return 0;
});
const zoomCompactLevel = computed(() => {
    if (collapseTier.value >= 4) {
        return 2;
    }
    if (collapseTier.value >= 1) {
        return 1;
    }
    return 0;
});

const toolbarCommandHandlers = {
    'open-file': () => emit('open-file'),
    'open-settings': () => emit('open-settings'),
    'save': () => emit('save'),
    'save-as': () => emit('save-as'),
    'print': () => emit('print'),
    'print-current-page': () => emit('print-current-page'),
    'export-docx': () => emit('export-docx'),
    'undo': () => emit('undo'),
    'redo': () => emit('redo'),
    'toggle-sidebar': () => emit('toggle-sidebar'),
    'fit-width': () => emit('fit-width'),
    'fit-height': () => emit('fit-height'),
    'toggle-continuous-scroll': () => emit('toggle-continuous-scroll'),
    'enable-drag': () => emit('enable-drag'),
    'disable-drag': () => emit('disable-drag'),
    'capture-region': () => emit('capture-region'),
    'crop': () => emit('crop'),
    'quick-note': () => emit('quick-note'),
    'toggle-fullscreen': () => emit('toggle-fullscreen'),
} satisfies Record<TToolbarCommand, () => void>;

function isCommandInline(command: TReaderCommandId) {
    return isReaderCommandInline(surface, command);
}

function handleToolbarCommand(command: TToolbarCommand) {
    toolbarCommandHandlers[command]();
}

</script>

<style scoped>
/*
 * Toolbar layout
 * ──────────────
 * All interactive controls share --toolbar-control-height (2rem / 32px).
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
    padding: var(--app-space-3xl) var(--app-space-7xl);
    border-bottom: 1px solid var(--app-toolbar-border);
    border-top: 1px solid var(--app-toolbar-border);
    background: var(--app-toolbar-bg);
    white-space: nowrap;
    overflow: visible;
    position: relative;
    z-index: var(--app-z-local-sticky);
    transition:
        background-color var(--app-transition-standard),
        border-color var(--app-transition-standard);
    container-type: inline-size;

    --toolbar-control-height: var(--app-toolbar-control-size, 2.25rem);
    --toolbar-micro-gap: var(--app-toolbar-group-gap);
    --toolbar-cluster-gap: var(--app-toolbar-section-gap);
}

.toolbar-section {
    display: flex;
    align-items: center;
    gap: var(--toolbar-cluster-gap);
    min-width: max-content;
}

.toolbar-left {
    min-width: max-content;
}

.toolbar-center {
    margin-inline: auto;
    min-width: max-content;
    gap: var(--toolbar-cluster-gap);
    overflow: visible;
}

.toolbar-right {
    min-width: max-content;
}

.toolbar-action {
    display: flex;
    align-items: center;
    flex-shrink: 0;
}

.toolbar--has-ocr-action .toolbar-action--ocr {
    inline-size: var(--toolbar-control-height, var(--app-toolbar-control-size));
    min-inline-size: var(--toolbar-control-height, var(--app-toolbar-control-size));
}

.toolbar-action--scan-cleanup {
    inline-size: var(--toolbar-control-height, var(--app-toolbar-control-size));
    min-inline-size: var(--toolbar-control-height, var(--app-toolbar-control-size));
}

.toolbar-separator {
    width: var(--app-divider-width);
    height: var(--app-space-15xl);
    background: var(--app-toolbar-separator);
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
    gap: var(--toolbar-micro-gap);
    flex-shrink: 0;
    min-width: max-content;
}

.toolbar-cluster {
    display: flex;
    align-items: center;
    gap: var(--toolbar-micro-gap);
    flex-shrink: 0;
    min-width: max-content;
}

.toolbar-group-item {
    display: flex;
}

.toolbar-inline-group {
    display: flex;
    align-items: center;
    gap: var(--toolbar-micro-gap);
    flex-shrink: 0;
    min-width: max-content;
}

.toolbar--reader {
    gap: var(--app-space-3xl);
    padding: var(--app-space-3xl) var(--app-space-6xl);
}

.toolbar--reader .toolbar-separator {
    display: none;
}

.toolbar--reader .toolbar-left,
.toolbar--reader .toolbar-center,
.toolbar--reader .toolbar-right {
    gap: var(--app-space-3xl);
}

.toolbar--reader .toolbar-center {
    flex: 0 1 auto;
}

.toolbar--reader .toolbar-left,
.toolbar--reader .toolbar-right {
    min-width: max-content;
}

.toolbar[data-collapse-tier='5'] {
    overflow: hidden;
}

.toolbar[data-collapse-tier='5'] .toolbar-center {
    min-width: 0;
    flex: 1 1 auto;
    overflow: hidden;
}

.toolbar[data-collapse-tier='5'] .toolbar-section,
.toolbar[data-collapse-tier='5'] .toolbar-left,
.toolbar[data-collapse-tier='5'] .toolbar-right,
.toolbar[data-collapse-tier='5'] .toolbar-cluster,
.toolbar[data-collapse-tier='5'] .toolbar-button-group {
    min-width: 0;
}

.toolbar[data-collapse-tier='5'] .toolbar-left,
.toolbar[data-collapse-tier='5'] .toolbar-right {
    flex: 0 1 auto;
    overflow: hidden;
}

.toolbar[data-collapse-tier='5'] .toolbar-center {
    overflow-x: auto;
    scrollbar-width: none;
}

.toolbar[data-collapse-tier='5'] .toolbar-center::-webkit-scrollbar {
    display: none;
}

.toolbar[data-collapse-tier='5'] .toolbar-inline-group {
    min-width: 0;
    flex: 1 1 auto;
}
</style>
