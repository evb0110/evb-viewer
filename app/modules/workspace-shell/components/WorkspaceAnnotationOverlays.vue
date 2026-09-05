<template>
    <div v-show="visible" class="workspace-annotation-overlays-root">
    <PdfAnnotationNoteWindow
        v-for="note in visibleAnnotationNoteWindows"
        :key="note.annotationId"
        :annotation-id="note.annotationId"
        :page-number="note.pageNumber"
        :author="note.author"
        :created-at="note.createdAt"
        :modified-at="note.modifiedAt"
        :text="note.draftText"
        :saving="note.saving"
        :error="note.error"
        :position="annotationNotePositions[note.annotationId] ?? null"
        :z-index="NOTE_WINDOW.ACTIVE_Z_INDEX_BASE + Math.min(
            Math.max(0, note.order),
            NOTE_WINDOW.ACTIVE_Z_INDEX_SLOTS - 1,
        )"
        :bounds-root="annotationViewportRoot ?? null"
        @update:text="emit('update-note-text', note.annotationId, $event)"
        @update:position="handleNotePositionUpdate(note.annotationId, $event)"
        @minimize="emit('minimize-note', note.annotationId)"
        @delete="emit('delete-annotation', note.annotationId)"
        @focus="emit('focus-note', note.annotationId)"
    />
    <template
        v-for="note in anchoredAnnotationNoteWindows"
        :key="`anchor-${note.annotationId}`"
    >
        <Teleport
            v-if="minimizedIndicatorTargets[note.annotationId]"
            :to="minimizedIndicatorTargets[note.annotationId]"
        >
                <AppTooltip
                    :text="getMinimizedNotePreview(note)"
                    :delay-duration="250"
                >
                <button
                    type="button"
                    class="pdf-note-minimized-indicator"
                    :style="getMinimizedIndicatorStyle(note)"
                    :aria-label="t('annotations.openNote')"
                    @mousedown.prevent
                    @focus="traceAnchorInteraction('anchor focused', note)"
                    @click="handleAnchorClick(note)"
                >
                    <UIcon name="i-ph-chat" class="size-2.5" />
                </button>
            </AppTooltip>
        </Teleport>
    </template>
    <template
        v-for="note in openNoteAnchors"
        :key="`open-anchor-${note.annotationId}`"
    >
        <Teleport
            v-if="openNoteAnchorTargets[note.annotationId]"
            :to="openNoteAnchorTargets[note.annotationId]"
        >
            <button
                v-show="!openAnchorHiddenKeys.has(note.annotationId)"
                type="button"
                class="pdf-note-open-anchor"
                :style="getMinimizedIndicatorStyle(note)"
                :data-annotation-id="note.annotationId"
                :aria-label="t('annotations.openNote')"
                @mousedown.prevent
            >
                <UIcon name="i-ph-chat" class="size-2.5" />
            </button>
        </Teleport>
    </template>
    <svg
        v-if="connectorLines.length > 0"
        class="pdf-note-connector-svg"
        :style="{ pointerEvents: 'none' }"
    >
        <path
            v-for="line in connectorLines"
            :key="`connector-halo-${line.annotationId}`"
            :d="line.path"
            class="pdf-note-connector-halo"
        />
        <path
            v-for="line in connectorLines"
            :key="`connector-${line.annotationId}`"
            :d="line.path"
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
        @open-note="emit('context-open-note')"
        @copy-text="emit('context-copy-text')"
        @copy-selection-text="emit('context-copy-selection-text')"
        @delete="emit('context-delete')"
        @update-color="emit('context-update-color', $event)"
        @markup="emit('context-markup', $event)"
        @create-free-note="emit('context-create-free-note')"
        @create-selection-note="emit('context-create-selection-note')"
        @insert-image-from-file="emit('context-insert-image-from-file')"
        @paste-image-from-clipboard="emit('context-paste-image-from-clipboard')"
    />
    <PdfPageContextMenu
        :menu="pageContextMenu"
        :style="pageContextMenuStyle"
        :is-operation-in-progress="isPageOperationInProgress"
        :is-djvu-mode="isDjvuMode"
        @delete-pages="emit('page-delete')"
        @extract-pages="emit('page-extract')"
        @export-pages="emit('page-export')"
        @rotate-cw="emit('page-rotate-cw')"
        @rotate-ccw="emit('page-rotate-ccw')"
        @insert-before="emit('page-insert-before')"
        @insert-after="emit('page-insert-after')"
        @select-all="emit('page-select-all')"
        @invert-selection="emit('page-invert-selection')"
    />
    <PdfAnnotationProperties
        :shape="selectedShapeForProperties"
        :x="shapePropertiesX"
        :y="shapePropertiesY"
        @update="emit('shape-update', $event)"
        @close="emit('shape-close')"
        @delete="emit('shape-delete')"
    />
    <PdfTextMarkupAnnotationProperties
        :markup="selectedTextMarkupForProperties"
        :x="textMarkupPropertiesX"
        :y="textMarkupPropertiesY"
        @update-color="emit('text-markup-color-update', $event)"
        @update-opacity="emit('text-markup-opacity-update', $event)"
        @close="emit('text-markup-close')"
    />
    </div>
</template>

<script setup lang="ts">
import { PdfAnnotationContextMenu } from '@app/modules/pdf-viewer/public/component-exports/pdfAnnotationContextMenu';
import { PdfAnnotationNoteWindow } from '@app/modules/pdf-viewer/public/component-exports/pdfAnnotationNoteWindow';
import { PdfAnnotationProperties } from '@app/modules/pdf-viewer/public/component-exports/pdfAnnotationProperties';
import { PdfPageContextMenu } from '@app/modules/pdf-viewer/public/component-exports/pdfPageContextMenu';
import { PdfTextMarkupAnnotationProperties } from '@app/modules/pdf-viewer/public/component-exports/pdfTextMarkupAnnotationProperties';
import type {
    IAnnotationContextMenuState,
    IPageContextMenuState,
} from '@app/types/pdfContextMenu';
import type {
    IShapeAnnotation,
    ITextMarkupAnnotationProperties,
    TAnnotationTool,
    TShapeAnnotationPatch,
} from '@app/types/annotations';
import type { IAnnotationNotePosition } from '@app/types/annotationNoteWindow';
import { NOTE_WINDOW } from '@app/constants/pdfLayout';
import type { IAnnotationNoteWindowEntry } from '@app/modules/workspace-shell/annotations/annotationNoteWindowEntry';
import { createAnnotationOverlayRuntime } from '@app/modules/workspace-shell/annotations/createAnnotationOverlayRuntime';

const {
    annotationNotePositions,
    annotationViewportRoot = undefined,
    annotationZoom = undefined,
    sortedAnnotationNoteWindows,
    visible,
} = defineProps<{
    visible: boolean;
    sortedAnnotationNoteWindows: IAnnotationNoteWindowEntry[];
    annotationNotePositions: Record<string, IAnnotationNotePosition>;
    annotationViewportRoot?: HTMLElement | null;
    annotationZoom?: number;
    annotationContextMenu: IAnnotationContextMenuState;
    annotationContextMenuStyle: Record<string, string>;
    annotationContextMenuCanCopy: boolean;
    annotationContextMenuCanCopySelection: boolean;
    annotationContextMenuCanCreateFree: boolean;
    annotationContextMenuCanInsertImage: boolean;
    contextMenuAnnotationLabel: string;
    contextMenuDeleteActionLabel: string;
    annotationContextMenuIsImage: boolean;
    pageContextMenu: IPageContextMenuState;
    pageContextMenuStyle: Record<string, string>;
    isPageOperationInProgress: boolean;
    isDjvuMode: boolean;
    selectedShapeForProperties: IShapeAnnotation | null;
    shapePropertiesX: number;
    shapePropertiesY: number;
    selectedTextMarkupForProperties: ITextMarkupAnnotationProperties | null;
    textMarkupPropertiesX: number;
    textMarkupPropertiesY: number;
}>();

const emit = defineEmits<{
    'update-note-text': [annotationId: string, text: string];
    'update-note-position': [annotationId: string, position: IAnnotationNotePosition];
    'minimize-note': [annotationId: string];
    'restore-note': [annotationId: string];
    'delete-annotation': [annotationId: string];
    'focus-note': [annotationId: string];
    'context-open-note': [];
    'context-copy-text': [];
    'context-copy-selection-text': [];
    'context-delete': [];
    'context-update-color': [color: string];
    'context-markup': [tool: TAnnotationTool];
    'context-create-free-note': [];
    'context-create-selection-note': [];
    'context-insert-image-from-file': [];
    'context-paste-image-from-clipboard': [];
    'page-delete': [];
    'page-extract': [];
    'page-export': [];
    'page-rotate-cw': [];
    'page-rotate-ccw': [];
    'page-insert-before': [];
    'page-insert-after': [];
    'page-select-all': [];
    'page-invert-selection': [];
    'shape-update': [updates: TShapeAnnotationPatch];
    'shape-close': [];
    'shape-delete': [];
    'text-markup-color-update': [color: string];
    'text-markup-opacity-update': [opacity: number];
    'text-markup-close': [];
}>();

const { t } = useTypedI18n();

const {
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
    scheduleConnectorRefreshBurst,
} = createAnnotationOverlayRuntime({
    getNoteWindows: () => sortedAnnotationNoteWindows,
    getNotePositions: () => annotationNotePositions,
    getWorkspaceRoot: () => annotationViewportRoot?.closest<HTMLElement>('.workspace-host')
        ?? annotationViewportRoot
        ?? null,
    getViewportRoot: () => annotationViewportRoot ?? null,
    getZoom: () => annotationZoom,
    getEmptyNoteLabel: () => t('annotations.emptyNote'),
});

function handleNotePositionUpdate(annotationId: string, position: IAnnotationNotePosition) {
    emit('update-note-position', annotationId, position);
    scheduleConnectorRefreshBurst(2);
}

function handleAnchorClick(note: IAnnotationNoteWindowEntry) {
    traceAnchorInteraction('anchor clicked', note);
    emit('restore-note', note.annotationId);
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
    border: 1px solid color-mix(in srgb, var(--ui-warning) 62%, var(--ui-border) 38%);
    background: color-mix(in srgb, var(--ui-warning) 20%, var(--ui-bg) 80%);
    color: color-mix(in srgb, var(--ui-warning) 58%, var(--ui-text) 42%);
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
    background: color-mix(in srgb, var(--ui-warning) 30%, var(--ui-bg) 70%);
    border-color: color-mix(in srgb, var(--ui-warning) 75%, var(--ui-border) 25%);
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
    border: 1.5px solid color-mix(in srgb, var(--ui-warning) 75%, var(--ui-border) 25%);
    background: color-mix(in srgb, var(--ui-warning) 30%, var(--ui-bg) 70%);
    color: color-mix(in srgb, var(--ui-warning) 65%, var(--ui-text) 35%);
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
}

.pdf-note-connector-halo {
    fill: none;
    stroke: color-mix(in srgb, var(--ui-bg) 88%, var(--ui-warning) 12%);
    stroke-width: 3.5;
    stroke-linecap: round;
    stroke-dasharray: 6 4;
    opacity: 0.6;
}

.pdf-note-connector-path {
    fill: none;
    stroke: color-mix(in srgb, var(--ui-warning) 72%, var(--ui-text) 28%);
    stroke-width: 1.75;
    stroke-linecap: round;
    stroke-dasharray: 6 4;
    opacity: 0.82;
}

</style>
