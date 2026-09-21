<template>
    <WorkspacePdfToolbarView
        :snapshot="snapshot"
        :has-pdf="hasPdf"
        :ocr-document-revision="ocrDocumentRevision"
        :ocr-working-copy-path="ocrWorkingCopyPath"
        :can-use-ocr="canUseOcr"
        :is-desktop-runtime="isDesktopRuntime"
        :surface="toolbarSurface"
        :is-fullscreen="isFullscreen"
        :fullscreen-supported="fullscreenSupported"
        :document-busy="shellDocumentBusy"
        :controls-disabled="shellControlsDisabled"
        :ocr-popup-open="ocrPopupOpen"
        :zoom-dropdown-open="zoomDropdownOpen"
        :page-dropdown-open="pageDropdownOpen"
        :overflow-menu-open="overflowMenuOpen"
        :app-menu-open="appMenuOpen"
        @update:ocr-popup-open="emit('update:ocrPopupOpen', $event)"
        @update:zoom-dropdown-open="emit('update:zoomDropdownOpen', $event)"
        @update:page-dropdown-open="emit('update:pageDropdownOpen', $event)"
        @update:overflow-menu-open="emit('update:overflowMenuOpen', $event)"
        @update:app-menu-open="emit('update:appMenuOpen', $event)"
        @update:zoom="emit('update:zoom', $event)"
        @update:effective-zoom="emit('update:effectiveZoom', $event)"
        @update:zoom-mode="emit('update:zoomMode', $event)"
        @update:fit-mode="emit('update:fitMode', $event)"
        @update:view-mode="emit('update:viewMode', $event)"
        @open-file="emit('open-file')"
        @open-settings="emit('open-settings')"
        @save="emit('save')"
        @repair-save="emit('repair-save')"
        @optimize-pdf-for-interaction="emit('optimize-pdf-for-interaction')"
        @save-as="emit('save-as')"
        @print="emit('print')"
        @print-current-page="emit('print-current-page')"
        @combine-files="emit('combine-files')"
        @export-docx="emit('export-docx')"
        @ocr-export-docx="emit('export-docx')"
        @export-images="emit('export-images')"
        @export-multi-page-tiff="emit('export-multi-page-tiff')"
        @convert-to-pdf="emit('convert-to-pdf')"
        @undo="emit('undo')"
        @redo="emit('redo')"
        @insert-image-from-file="emit('insert-image-from-file')"
        @paste-image-from-clipboard="emit('paste-image-from-clipboard')"
        @delete-pages="emit('delete-pages')"
        @extract-pages="emit('extract-pages')"
        @rotate-cw="emit('rotate-cw')"
        @rotate-ccw="emit('rotate-ccw')"
        @insert-pages="emit('insert-pages')"
        @toggle-sidebar="emit('toggle-sidebar')"
        @fit-width="emit('fit-width')"
        @fit-height="emit('fit-height')"
        @toggle-continuous-scroll="emit('toggle-continuous-scroll')"
        @enable-drag="emit('enable-drag')"
        @disable-drag="emit('disable-drag')"
        @capture-region="emit('capture-region')"
        @crop="emit('crop')"
        @quick-note="emit('quick-note')"
        @toggle-fullscreen="emit('toggle-fullscreen')"
        @set-view-mode="emit('set-view-mode', $event)"
        @go-to-page="emit('go-to-page', $event)"
        @ocr-complete="emit('ocr-complete', $event)"
    />
</template>

<script setup lang="ts">
import type { TDocumentRef } from '@contracts/documentRef';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type { TPdfViewMode } from '@contracts/shared';
import type { IWorkspaceToolbarSnapshot } from '@app/types/workspaceExpose';
import WorkspacePdfToolbarView from '@app/modules/workspace-shell/components/WorkspacePdfToolbarView.vue';
import { useRuntimeEnvironment } from '@app/composables/useRuntimeEnvironment';
import { DESKTOP_EDITOR_READER_COMMAND_SURFACE } from '@app/utils/readerCommandSurface';

const {
    hasPdf,
    ocrDocumentRevision = null,
    ocrWorkingCopyPath = null,
    snapshot,
} = defineProps<{
    snapshot: IWorkspaceToolbarSnapshot;
    hasPdf: boolean;
    ocrDocumentRevision?: TDocumentRevisionToken | null;
    ocrWorkingCopyPath?: TDocumentRef | null;
    ocrPopupOpen: boolean;
    zoomDropdownOpen: boolean;
    pageDropdownOpen: boolean;
    overflowMenuOpen: boolean;
    appMenuOpen: boolean;
    isFullscreen: boolean;
    fullscreenSupported: boolean;
}>();

const { isDesktopRuntime } = useRuntimeEnvironment();
const canUseOcr = computed(() => isDesktopRuntime.value);
const toolbarSurface = DESKTOP_EDITOR_READER_COMMAND_SURFACE;
const shellDocumentBusy = computed(() => snapshot.isOpeningDocument);
const shellControlsDisabled = computed(() => !hasPdf || shellDocumentBusy.value || snapshot.totalPages <= 0);

const emit = defineEmits<{
    'update:ocrPopupOpen': [open: boolean];
    'update:zoomDropdownOpen': [open: boolean];
    'update:pageDropdownOpen': [open: boolean];
    'update:overflowMenuOpen': [open: boolean];
    'update:appMenuOpen': [open: boolean];
    'update:zoom': [zoom: number];
    'update:effectiveZoom': [zoom: number];
    'update:zoomMode': [mode: IWorkspaceToolbarSnapshot['zoomMode']];
    'update:fitMode': [mode: IWorkspaceToolbarSnapshot['fitMode']];
    'update:viewMode': [mode: IWorkspaceToolbarSnapshot['viewMode']];
    'open-file': [];
    'open-settings': [];
    'save': [];
    'repair-save': [];
    'optimize-pdf-for-interaction': [];
    'save-as': [];
    'print': [];
    'print-current-page': [];
    'combine-files': [];
    'export-docx': [];
    'export-images': [];
    'export-multi-page-tiff': [];
    'convert-to-pdf': [];
    'undo': [];
    'redo': [];
    'insert-image-from-file': [];
    'paste-image-from-clipboard': [];
    'delete-pages': [];
    'extract-pages': [];
    'rotate-cw': [];
    'rotate-ccw': [];
    'insert-pages': [];
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
    'set-view-mode': [mode: TPdfViewMode];
    'go-to-page': [page: number];
    'ocr-complete': [payload: unknown];
}>();
</script>
