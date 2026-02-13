<template>
    <PdfAnnotationNoteWindow
        v-for="note in sortedAnnotationNoteWindows"
        :key="note.comment.stableKey"
        :comment="note.comment"
        :text="note.text"
        :saving="note.saving"
        :error="note.error"
        :position="annotationNotePositions[note.comment.stableKey] ?? null"
        :z-index="90 + note.order"
        @update:text="$emit('update-note-text', note.comment.stableKey, $event)"
        @update:position="$emit('update-note-position', note.comment.stableKey, $event)"
        @close="$emit('close-note', note.comment.stableKey)"
        @delete="$emit('delete-comment', note.comment)"
        @focus="$emit('focus-note', note.comment.stableKey)"
    />
    <PdfAnnotationContextMenu
        :menu="annotationContextMenu"
        :style="annotationContextMenuStyle"
        :can-copy="annotationContextMenuCanCopy"
        :can-create-free="annotationContextMenuCanCreateFree"
        :annotation-label="contextMenuAnnotationLabel"
        :delete-label="contextMenuDeleteActionLabel"
        @open-note="$emit('context-open-note')"
        @copy-text="$emit('context-copy-text')"
        @delete="$emit('context-delete')"
        @markup="(tool: TAnnotationTool) => $emit('context-markup', tool)"
        @create-free-note="$emit('context-create-free-note')"
        @create-selection-note="$emit('context-create-selection-note')"
    />
    <PdfPageContextMenu
        :menu="pageContextMenu"
        :style="pageContextMenuStyle"
        :is-operation-in-progress="isPageOperationInProgress"
        :is-djvu-mode="isDjvuMode"
        @delete-pages="$emit('page-delete')"
        @extract-pages="$emit('page-extract')"
        @rotate-cw="$emit('page-rotate-cw')"
        @rotate-ccw="$emit('page-rotate-ccw')"
        @insert-before="$emit('page-insert-before')"
        @insert-after="$emit('page-insert-after')"
        @select-all="$emit('page-select-all')"
        @invert-selection="$emit('page-invert-selection')"
    />
    <PdfAnnotationProperties
        :shape="selectedShapeForProperties"
        :x="shapePropertiesX"
        :y="shapePropertiesY"
        @update="(updates: Partial<IShapeAnnotation>) => $emit('shape-update', updates)"
        @close="$emit('shape-close')"
    />
</template>

<script setup lang="ts">
import type {
    IAnnotationCommentSummary,
    IShapeAnnotation,
    TAnnotationTool,
} from '@app/types/annotations';
import type { IAnnotationNotePosition } from '@app/composables/pdf/useAnnotationNoteWindows';

interface IAnnotationNoteWindowEntry {
    comment: IAnnotationCommentSummary;
    text: string;
    saving: boolean;
    error: string | null;
    order: number;
}

interface IContextMenuState {
    visible: boolean;
    x: number;
    y: number;
    comment: IAnnotationCommentSummary | null;
    hasSelection: boolean;
    pageNumber: number | null;
    pageX: number | null;
    pageY: number | null;
}

interface IPageContextMenuState {
    visible: boolean;
    x: number;
    y: number;
    pages: number[];
}

defineProps<{
    sortedAnnotationNoteWindows: IAnnotationNoteWindowEntry[];
    annotationNotePositions: Record<string, IAnnotationNotePosition>;
    annotationContextMenu: IContextMenuState;
    annotationContextMenuStyle: Record<string, string>;
    annotationContextMenuCanCopy: boolean;
    annotationContextMenuCanCreateFree: boolean;
    contextMenuAnnotationLabel: string;
    contextMenuDeleteActionLabel: string;
    pageContextMenu: IPageContextMenuState;
    pageContextMenuStyle: Record<string, string>;
    isPageOperationInProgress: boolean;
    isDjvuMode: boolean;
    selectedShapeForProperties: IShapeAnnotation | null;
    shapePropertiesX: number;
    shapePropertiesY: number;
}>();

defineEmits<{
    'update-note-text': [stableKey: string, text: string];
    'update-note-position': [stableKey: string, position: IAnnotationNotePosition];
    'close-note': [stableKey: string];
    'delete-comment': [comment: IAnnotationCommentSummary];
    'focus-note': [stableKey: string];
    'context-open-note': [];
    'context-copy-text': [];
    'context-delete': [];
    'context-markup': [tool: TAnnotationTool];
    'context-create-free-note': [];
    'context-create-selection-note': [];
    'page-delete': [];
    'page-extract': [];
    'page-rotate-cw': [];
    'page-rotate-ccw': [];
    'page-insert-before': [];
    'page-insert-after': [];
    'page-select-all': [];
    'page-invert-selection': [];
    'shape-update': [updates: Partial<IShapeAnnotation>];
    'shape-close': [];
}>();
</script>
