<template>
    <header
        class="toolbar"
        :data-toolbar-layout="toolbarLayout"
        :data-has-document="hasPdf ? 'true' : 'false'"
        role="toolbar"
        :aria-label="t('toolbar.readerToolbar')"
    >
        <span class="toolbar-collapse-probe" aria-hidden="true" />
        <div class="toolbar-section toolbar-left">
            <span class="toolbar-collapsible" data-collapse-at="5">
                <ToolbarButton
                    v-if="isCommandInline('open-file')"
                    :icon="getReaderCommandToolbarIcon('open-file')"
                    :tooltip="t('toolbar.openPdf')"
                    :shortcut="shortcutLabels.openFile"
                    :disabled="isOpeningDocument"
                    :loading="isOpeningDocument"
                    @click="handleToolbarCommand('open-file')"
                />
                <ToolbarButton
                    v-if="isCommandInline('toggle-sidebar')"
                    :icon="getReaderCommandToolbarIcon('toggle-sidebar')"
                    :active="showSidebar"
                    :tooltip="t('toolbar.toggleSidebar')"
                    :shortcut="shortcutLabels.toggleSidebar"
                    :disabled="!hasInteractiveDocument || canToggleSidebar === false"
                    @click="handleToolbarCommand('toggle-sidebar')"
                />
            </span>

            <div
                v-if="(isCommandInline('save') || isCommandInline('print') || isCommandInline('print-current-page'))"
                data-collapse-at="4"
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
                v-if="(isCommandInline('undo') || isCommandInline('redo'))"
                data-collapse-at="4"
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
                />
            </div>

            <div class="toolbar-inline-group">
                <slot
                    v-if="isCommandInline('zoom')"
                    name="zoom-dropdown"
                />
            </div>

            <div data-collapse-at="2" class="toolbar-button-group toolbar-button-group--fit">
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
                <div v-if="isCommandInline('continuous-scroll')" class="toolbar-group-item toolbar-group-item--continuous-scroll">
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

            <div data-collapse-at="3" class="toolbar-separator" />

            <div data-collapse-at="3" class="toolbar-button-group toolbar-button-group--interaction">
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
                v-if="(isCommandInline('capture-region') || isCommandInline('crop'))"
                data-collapse-at="3"
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
                v-if="(isCommandInline('scan-cleanup') || isCommandInline('ocr') || isCommandInline('export-docx'))"
                data-collapse-at="1"
                class="toolbar-cluster"
            >
                <div
                    v-if="isCommandInline('scan-cleanup')"
                    class="toolbar-action toolbar-action--scan-cleanup"
                >
                    <slot
                        name="scan-cleanup"
                    />
                </div>
                <div v-if="isCommandInline('ocr')" class="toolbar-action toolbar-action--ocr">
                    <slot
                        name="ocr"
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

            <div data-collapse-at="1" class="toolbar-separator" />

            <div class="toolbar-cluster">
                <span class="toolbar-collapsible" data-collapse-at="5">
                    <ToolbarButton
                        v-if="isCommandInline('fullscreen')"
                        :icon="isFullscreen ? 'ph:corners-in' : getReaderCommandToolbarIcon('fullscreen')"
                        :tooltip="t('toolbar.fullscreen')"
                        :active="isFullscreen"
                        :disabled="!hasInteractiveDocument || !fullscreenSupported"
                        @click="handleToolbarCommand('toggle-fullscreen')"
                    />
                    <AssistantToolbarToggle />
                    <ToolbarButton
                        v-if="isCommandInline('settings')"
                        :icon="getReaderCommandToolbarIcon('settings')"
                        :tooltip="t('toolbar.settings')"
                        @click="handleToolbarCommand('open-settings')"
                    />
                </span>
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
import { useRuntimeEnvironment } from '@app/composables/useRuntimeEnvironment';
import { useAssistantPanel } from '@app/composables/useAssistantPanel';
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
    documentBusy = false,
    isOpeningDocument = false,
    isFullscreen = false,
    fullscreenSupported = true,
    canPrint = true,
    canSaveAs = true,
    canToggleContinuousScroll = true,
    isAnySaving,
    isHistoryBusy,
    isPreparingPrint = false,
} = defineProps<{
    hasPdf: boolean;
    documentBusy?: boolean;
    isFullscreen?: boolean;
    fullscreenSupported?: boolean;
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
// The toolbar's container queries decide which groups it shows, so the
// prerendered page already has the final layout. The window's More tools
// lists what they hid; it reads the tier those queries set on the probe.
const { isBrowserRuntime } = useRuntimeEnvironment();
const { isEnabled: isAssistantToggleShown } = useAssistantPanel();
const toolbarLayout = computed(() => {
    if (isBrowserRuntime.value) {
        return 'browser';
    }
    return isAssistantToggleShown.value ? 'desktop-assistant' : 'desktop';
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

<style lang="scss" scoped>
@use 'sass:list';

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
    padding-block: var(--app-space-3xl);

    /* The window's row drops the padding of an edge that meets its Menu or More tools cell. */
    padding-inline: var(--toolbar-padding-inline-start, var(--app-space-7xl)) var(--toolbar-padding-inline-end, var(--app-space-7xl));
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

    /* The gap the Menu had before this section's controls inside the toolbar. */
    padding-inline-start: var(--toolbar-menu-gap-start, 0);
}

.toolbar-center {
    margin-inline: auto;
    min-width: max-content;
    gap: var(--toolbar-cluster-gap);
    overflow: visible;
}

.toolbar-right {
    min-width: max-content;

    /* The gap More tools had after this section's controls inside the toolbar. */
    padding-inline-end: var(--toolbar-menu-gap-end, 0);
}

.toolbar-action {
    display: flex;
    align-items: center;
    flex-shrink: 0;
}

.toolbar-action--ocr,
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

/*
 * Collapse tiers
 * ──────────────
 * The toolbar's own width decides which groups it shows, so the prerendered
 * page paints the layout the live page keeps. An element marked
 * data-collapse-at="N" is hidden from tier N on; the probe carries the tier
 * for the window's More tools, which lists what is hidden. Each threshold is the
 * widest content of the tier below it (desktop scan cleanup, the assistant
 * toggle, four-digit page counts) and keeps the tiers in rem, so they follow
 * the UI scale.
 */
.toolbar-collapsible {
    display: contents;
}

.toolbar-collapse-probe {
    position: absolute;
    width: 0;
    height: 0;
    overflow: hidden;
    pointer-events: none;

    --toolbar-collapse-tier: 0;
}

/* Widest content of the tier below each threshold, plus headroom for longer
   locale labels, measured at UI scale 1 with a four-digit page count:
   browser 1281/1190/1070/859/577 px when the toolbar held the Menu (85 px)
   and More tools (36 px), which now sit beside it in the window's row, so
   those widths are subtracted; desktop held only More tools. The sections'
   gaps beside them stay in the toolbar. Scan cleanup at tier 0 measures
   1212 px in the browser. The assistant toggle adds 38 px to tiers 0-4. */
$toolbar-collapse-thresholds: (
    'browser': (77.125rem, 67.9375rem, 60.4375rem, 46.9375rem, 29.9375rem),
    'desktop': (76.25rem, 68.25rem, 60.75rem, 47.25rem, 29.75rem),
    'desktop-assistant': (78.25rem, 70.75rem, 62.75rem, 49.75rem, 32.25rem),
);

@each $layout, $widths in $toolbar-collapse-thresholds {
    @for $tier from 1 through 5 {
        @container (width <= #{list.nth($widths, $tier)}) {
            .toolbar[data-toolbar-layout='#{$layout}'] .toolbar-collapse-probe {
                --toolbar-collapse-tier: #{$tier};
            }

            .toolbar[data-toolbar-layout='#{$layout}'] :deep([data-collapse-at='#{$tier}']) {
                display: none;
            }

            @if $tier == 4 {
                .toolbar[data-toolbar-layout='#{$layout}'] :deep(.zoom-controls) {
                    --zoom-control-display-width: 4.5rem;
                }
            }

            @if $tier == 5 {
                /* Menu and More tools stand alone beside the centre here. */
                .toolbar[data-toolbar-layout='#{$layout}'] .toolbar-left,
                .toolbar[data-toolbar-layout='#{$layout}'] .toolbar-right {
                    padding-inline: 0;
                }

                .toolbar[data-toolbar-layout='#{$layout}'] .toolbar-center {
                    flex: 1 1 auto;
                    flex-wrap: wrap;
                    justify-content: center;
                    min-width: 0;
                }

                /* A phone without a document shows no empty page and zoom
                   fields; they keep their place for the document's values. */
                .toolbar[data-toolbar-layout='#{$layout}'][data-has-document='false'] .toolbar-center {
                    visibility: hidden;
                }
            }
        }
    }
}
</style>
