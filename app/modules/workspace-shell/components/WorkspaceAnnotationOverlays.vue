<template>
    <div v-show="visible" class="workspace-annotation-overlays-root">
    <PdfAnnotationNoteWindow
        v-for="note in noteWindowItems"
        :key="note.annotationId"
        :annotation-id="note.annotationId"
        :page-number="note.pageNumber"
        :author="note.author"
        :color="note.color"
        :created-at="note.createdAt"
        :modified-at="note.modifiedAt"
        :text="note.text"
        :saving="note.saving"
        :position="note.position"
        :z-index="note.zIndex"
        :pane-bounds="note.paneBounds"
        :page-rect="note.pageRect"
        :marker-rect="note.markerRect"
        @update:text="updateAnnotationNoteText(note.annotationId, $event)"
        @update:position="annotations.updateAnnotationNotePosition(note.annotationId, $event)"
        @position-applied="refreshViewportDom"
        @minimize="handleNoteMinimize(note.annotationId, $event)"
        @delete="annotationActions.handleDeleteAnnotationById(note.annotationId)"
        @focus="bringAnnotationNoteToFront(note.annotationId)"
    />
    <template
        v-for="anchor in minimizedAnchorItems"
        :key="anchor.key"
    >
        <Teleport
            v-if="anchor.target"
            :to="anchor.target"
        >
            <AppTooltip
                :text="anchor.preview"
                :delay-duration="250"
            >
                <button
                    type="button"
                    class="pdf-note-minimized-indicator"
                    :style="anchor.style"
                    :aria-label="t('annotations.openNote')"
                    @mousedown.prevent
                    @focus="traceAnchorInteraction('anchor focused', anchor.note)"
                    @click="handleAnchorClick(anchor.note)"
                >
                    <UIcon name="i-ph-chat" class="size-2.5" />
                </button>
            </AppTooltip>
        </Teleport>
    </template>
    <template
        v-for="anchor in openAnchorItems"
        :key="anchor.key"
    >
        <Teleport
            v-if="anchor.target"
            :to="anchor.target"
        >
            <button
                v-show="anchor.visible"
                type="button"
                class="pdf-note-open-anchor"
                :style="anchor.style"
                :data-annotation-id="anchor.annotationId"
                :aria-label="t('annotations.openNote')"
                @mousedown.prevent
            >
                <UIcon name="i-ph-chat" class="size-2.5" />
            </button>
        </Teleport>
    </template>
    <svg
        v-if="connectorLineItems.length > 0"
        class="pdf-note-connector-svg"
    >
        <path
            v-for="line in connectorLineItems"
            :key="`connector-halo-${line.annotationId}`"
            :d="line.path"
            :style="line.style"
            class="pdf-note-connector-halo"
        />
        <path
            v-for="line in connectorLineItems"
            :key="`connector-${line.annotationId}`"
            :d="line.path"
            :style="line.style"
            class="pdf-note-connector-path"
        />
    </svg>
    <PdfAnnotationContextMenu
        :menu="annotationContextMenu"
        :style="annotationContextMenuStyle"
        :can-copy="annotationContextMenuCanCopy"
        :can-copy-selection="annotationContextMenuCanCopySelection"
        :can-create-free="annotationContextMenuCanCreateFree"
        :can-insert-image="annotationContextMenuCanInsertImage"
        :annotation-label="contextMenuAnnotationLabel"
        :delete-label="contextMenuDeleteActionLabel"
        :is-image-comment="annotationContextMenuIsImage"
        @open-note="annotationActions.openContextMenuNote"
        @copy-text="annotationActions.copyContextMenuNoteText"
        @copy-selection-text="annotationActions.copyContextMenuSelectionText"
        @delete="annotationActions.deleteContextMenuComment"
        @update-color="annotationActions.handleContextTextMarkupColorUpdate"
        @markup="annotationActions.createContextMenuMarkup"
        @create-free-note="annotationActions.createContextMenuFreeNote"
        @create-selection-note="annotationActions.createContextMenuSelectionNote"
        @insert-image-from-file="annotationActions.insertContextMenuImageFromFile"
        @paste-image-from-clipboard="annotationActions.pasteContextMenuImageFromClipboard"
    />
    <PdfPageContextMenu
        :menu="pageContextMenu"
        :style="pageContextMenuStyle"
        :is-operation-in-progress="pageOps.isPageOperationInProgress.value"
        :is-djvu-mode="file.isDjvuMode.value"
        @delete-pages="pageOps.handlePageContextMenuDelete"
        @extract-pages="pageOps.handlePageContextMenuExtract"
        @export-pages="pageOps.handlePageContextMenuExport"
        @rotate-cw="pageOps.handlePageContextMenuRotateCw"
        @rotate-ccw="pageOps.handlePageContextMenuRotateCcw"
        @insert-before="pageOps.handlePageContextMenuInsertBefore"
        @insert-after="pageOps.handlePageContextMenuInsertAfter"
        @select-all="pageOps.handlePageContextMenuSelectAll"
        @invert-selection="pageOps.handlePageContextMenuInvertSelection"
    />
    </div>
</template>

<script setup lang="ts">
import { requirePageNumber } from '@contracts/pageNumbers';
import { PdfAnnotationContextMenu } from '@app/modules/pdf-viewer/public/component-exports/pdfAnnotationContextMenu';
import { PdfAnnotationNoteWindow } from '@app/modules/pdf-viewer/public/component-exports/pdfAnnotationNoteWindow';
import { PdfPageContextMenu } from '@app/modules/pdf-viewer/public/component-exports/pdfPageContextMenu';
import { NOTE_WINDOW } from '@app/constants/pdfLayout';
import type { IAnnotationNoteWindowEntry } from '@app/modules/workspace-shell/annotations/annotationNoteWindowEntry';
import { createAnnotationOverlayRuntime } from '@app/modules/workspace-shell/annotations/createAnnotationOverlayRuntime';
import { useDocumentContext } from '@app/modules/workspace-shell/documentContext';
import { useDocumentViewContext } from '@app/modules/workspace-shell/documentViewContext';

const { visible } = defineProps<{visible: boolean;}>();
const {
    annotations,
    file,
} = useDocumentContext();
const {
    tabId,
    pageOps,
    annotationActions,
    annotationContextMenu: {
        annotationContextMenu,
        annotationContextMenuStyle,
        annotationContextMenuCanCopy,
        annotationContextMenuCanCopySelection,
        annotationContextMenuCanCreateFree,
        annotationContextMenuCanInsertImage,
        annotationContextMenuIsImage,
        contextMenuAnnotationLabel,
        contextMenuDeleteActionLabel,
    },
    pageContextMenu: {
        pageContextMenu,
        pageContextMenuStyle,
    },
    view,
} = useDocumentViewContext();
const {
    sortedAnnotationNoteWindows,
    annotationNotePositions,
    updateAnnotationNoteText,
    bringAnnotationNoteToFront,
} = annotations;
const annotationViewportRoot = computed(() => view.pdfViewerRef.value?.getViewerContainer?.() ?? null);

const { t } = useTypedI18n();

const {
    viewportDomSnapshot,
    visibleAnnotationNoteWindows,
    anchoredAnnotationNoteWindows,
    openNoteAnchors,
    openAnchorHiddenKeys,
    minimizedIndicatorTargets,
    openNoteAnchorTargets,
    connectorLines,
    getMinimizedIndicatorStyle,
    getMinimizedNotePreview,
    traceAnchorInteraction,
    refreshViewportDom,
} = createAnnotationOverlayRuntime({
    // An open note's editor shows in the view that opened it; every view
    // shows the markers of minimized notes.
    getNoteWindows: () => sortedAnnotationNoteWindows.value.filter(note => (
        note.isMinimized || note.ownerViewId === null || note.ownerViewId === tabId
    )),
    getNotePositions: () => annotationNotePositions.value,
    getWorkspaceRoot: () => annotationViewportRoot.value?.closest<HTMLElement>('.workspace-host')
        ?? annotationViewportRoot.value,
    getViewportRoot: () => annotationViewportRoot.value,
    getZoom: () => view.effectiveZoom.value,
    getEmptyNoteLabel: () => t('annotations.emptyNote'),
    paintsPage: pageIndex => view.pdfViewerRef.value?.paintsAnnotationPage?.(pageIndex) !== false,
});

const noteWindowItems = computed(() => {
    const snapshot = viewportDomSnapshot.value;
    const paneBounds = snapshot?.bounds ?? null;
    const positions = annotationNotePositions.value;
    return visibleAnnotationNoteWindows.value.map((note, noteIndex) => ({
        annotationId: note.annotationId,
        pageNumber: requirePageNumber(note.pageNumber),
        author: note.author,
        color: note.color ?? null,
        createdAt: note.createdAt,
        modifiedAt: note.modifiedAt,
        text: note.draftText,
        saving: note.saving,
        position: positions[note.annotationId] ?? null,
        zIndex: NOTE_WINDOW.ACTIVE_Z_INDEX_BASE + Math.min(
            noteIndex,
            NOTE_WINDOW.ACTIVE_Z_INDEX_SLOTS - 1,
        ),
        paneBounds,
        pageRect: snapshot?.pageContainers.get(note.pageNumber)?.rect ?? null,
        markerRect: note.markerRect ?? null,
    }));
});

const minimizedAnchorItems = computed(() => anchoredAnnotationNoteWindows.value.map(note => ({
    key: `anchor-${note.annotationId}`,
    note,
    target: minimizedIndicatorTargets.value[note.annotationId] ?? null,
    preview: getMinimizedNotePreview(note),
    style: getMinimizedIndicatorStyle(note),
})));

const openAnchorItems = computed(() => openNoteAnchors.value.map(note => ({
    key: `open-anchor-${note.annotationId}`,
    annotationId: note.annotationId,
    target: openNoteAnchorTargets.value[note.annotationId] ?? null,
    visible: !openAnchorHiddenKeys.value.has(note.annotationId),
    style: getMinimizedIndicatorStyle(note),
})));

const connectorLineItems = computed(() => connectorLines.value.map(line => ({
    annotationId: line.annotationId,
    path: line.path,
    style: {'--annotation-note-color': line.color ?? 'var(--ui-warning)'},
})));

async function handleNoteMinimize(annotationId: string, focusDocument: Document | null) {
    annotations.minimizeAnnotationNote(annotationId);
    await nextTick();
    if (
        visible
        && focusDocument
        && focusDocument.activeElement === focusDocument.body
        && sortedAnnotationNoteWindows.value.some(note => note.annotationId === annotationId && note.isMinimized)
    ) {
        view.pdfViewerRef.value?.focusSelectedAnnotation?.(annotationId);
    }
}

function handleAnchorClick(note: IAnnotationNoteWindowEntry) {
    traceAnchorInteraction('anchor clicked', note);
    annotations.restoreAnnotationNote(note.annotationId, tabId);
}
</script>

<style scoped>
.workspace-annotation-overlays-root {
    display: contents;
}

.pdf-note-minimized-indicator {
    position: absolute;
    width: var(--app-note-anchor-size);
    height: var(--app-note-anchor-size);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--app-radius-full);
    border: 1px solid color-mix(in srgb, var(--annotation-note-color) 62%, var(--ui-border) 38%);
    background: color-mix(in srgb, var(--annotation-note-color) 20%, var(--ui-bg) 80%);
    color: color-mix(in srgb, var(--annotation-note-color) 58%, var(--ui-text) 42%);
    cursor: pointer;
    transform: translate(-50%, -50%);
    opacity: 0.82;
    transition:
        background-color var(--app-transition-standard),
        border-color var(--app-transition-standard),
        transform var(--app-transition-standard),
        opacity var(--app-transition-standard);
}

.pdf-note-minimized-indicator:hover {
    background: color-mix(in srgb, var(--annotation-note-color) 30%, var(--ui-bg) 70%);
    border-color: color-mix(in srgb, var(--annotation-note-color) 75%, var(--ui-border) 25%);
    transform: translate(-50%, calc(-50% - 1px));
    opacity: 0.95;
}

.pdf-note-minimized-indicator:focus-visible {
    outline: 1px solid var(--ui-primary);
    outline-offset: 1px;
}

.pdf-note-open-anchor {
    position: absolute;
    width: var(--app-note-anchor-size);
    height: var(--app-note-anchor-size);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--app-radius-full);
    border: 1.5px solid color-mix(in srgb, var(--annotation-note-color) 75%, var(--ui-border) 25%);
    background: color-mix(in srgb, var(--annotation-note-color) 30%, var(--ui-bg) 70%);
    color: color-mix(in srgb, var(--annotation-note-color) 65%, var(--ui-text) 35%);
    cursor: default;
    transform: translate(-50%, -50%);
    opacity: 0.92;
    pointer-events: none;
    z-index: var(--app-note-anchor-z-index);
}

.pdf-note-connector-svg {
    position: fixed;
    inset: 0;
    width: 100vw;
    height: 100vh;
    z-index: var(--app-note-connector-z-index);
    overflow: visible;
    pointer-events: none;
}

.pdf-note-connector-halo {
    fill: none;
    stroke: color-mix(in srgb, var(--ui-bg) 88%, var(--annotation-note-color) 12%);
    stroke-width: 3.5;
    stroke-linecap: round;
    stroke-dasharray: 6 4;
    opacity: 0.6;
}

.pdf-note-connector-path {
    fill: none;
    stroke: color-mix(in srgb, var(--annotation-note-color) 72%, var(--ui-text) 28%);
    stroke-width: 1.75;
    stroke-linecap: round;
    stroke-dasharray: 6 4;
    opacity: 0.82;
}

</style>
