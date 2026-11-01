<template>
    <WorkspacePdfToolbarView
        :snapshot="snapshot"
        :has-pdf="hasPdf"
        :is-opening-document="isOpeningDocument"
        :ocr-document-revision="ocrDocumentRevision"
        :ocr-working-copy-path="ocrWorkingCopyPath"
        :can-use-ocr="canUseOcr"
        :is-fullscreen="isFullscreen"
        :fullscreen-supported="fullscreenSupported"
        :ocr-popup-open="ocrPopupOpen"
        :zoom-dropdown-open="zoomDropdownOpen"
        :page-dropdown-open="pageDropdownOpen"
        @update:ocr-popup-open="emit('update:ocrPopupOpen', $event)"
        @update:zoom-dropdown-open="emit('update:zoomDropdownOpen', $event)"
        @update:page-dropdown-open="emit('update:pageDropdownOpen', $event)"
        @update:zoom="emit('update:zoom', $event)"
        @update:zoom-mode="emit('update:zoomMode', $event)"
        @update:fit-mode="emit('update:fitMode', $event)"
        @update:view-mode="emit('update:viewMode', $event)"
        @open-file="emit('open-file')"
        @open-settings="emit('open-settings')"
        @save="emit('save')"
        @save-as="emit('save-as')"
        @print="emit('print')"
        @print-current-page="emit('print-current-page')"
        @export-docx="emit('export-docx')"
        @ocr-export-docx="emit('export-docx')"
        @undo="emit('undo')"
        @redo="emit('redo')"
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
        @go-to-page="emit('go-to-page', $event)"
    />
</template>

<script setup lang="ts">
import type { TDocumentRef } from '@contracts/documentRef';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type { IWorkspaceToolbarSnapshot } from '@app/types/workspaceExpose';
import WorkspacePdfToolbarView from '@app/modules/workspace-shell/components/WorkspacePdfToolbarView.vue';
import { useCanUseOcr } from '@app/composables/useCanUseOcr';

const {
    hasPdf,
    isOpeningDocument,
    ocrDocumentRevision = null,
    ocrWorkingCopyPath = null,
    snapshot,
} = defineProps<{
    snapshot: IWorkspaceToolbarSnapshot;
    hasPdf: boolean;
    isOpeningDocument: boolean;
    ocrDocumentRevision?: TDocumentRevisionToken | null;
    ocrWorkingCopyPath?: TDocumentRef | null;
    ocrPopupOpen: boolean;
    zoomDropdownOpen: boolean;
    pageDropdownOpen: boolean;
    isFullscreen: boolean;
    fullscreenSupported: boolean;
}>();

const canUseOcr = useCanUseOcr();

const emit = defineEmits<{
    'update:ocrPopupOpen': [open: boolean];
    'update:zoomDropdownOpen': [open: boolean];
    'update:pageDropdownOpen': [open: boolean];
    'update:zoom': [zoom: number];
    'update:zoomMode': [mode: IWorkspaceToolbarSnapshot['zoomMode']];
    'update:fitMode': [mode: IWorkspaceToolbarSnapshot['fitMode']];
    'update:viewMode': [mode: IWorkspaceToolbarSnapshot['viewMode']];
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
    'go-to-page': [page: number];
}>();
</script>
