<template>
    <div
        ref="layerRef"
        class="pdf-annotation-editor-layer"
        :class="{'is-interactive': isInteractive}"
        data-pdf-annotation-editor-surface
        :data-pdf-annotation-editor-ready="editorReady ? 'true' : undefined"
        tabindex="0"
        @mousedown.stop
        @pointerdown.stop="handleSurfacePointerDown"
        @pointermove="handlePointerMove"
        @pointerup="handlePointerUp"
        @pointercancel="handlePointerCancel"
        @click.stop="handleSurfaceClick"
        @contextmenu.prevent.stop="handleSurfaceContextMenu"
        @dblclick.stop="handleSurfaceDblClick"
        @keydown="handleKeydown"
    >
        <svg
            class="pdf-annotation-editor-surface__svg"
            viewBox="0 0 1 1"
            preserveAspectRatio="none"
            aria-hidden="true"
        >
            <PdfTextMarkupAnnotation
                v-for="entity in svgEntities.textMarkup"
                :key="entity.identity.id"
                :entity="entity"
                :selected="isSelected(entity.identity.id)"
            />
            <PdfShapeAnnotation
                v-for="entity in svgEntities.shapes"
                :key="entity.identity.id"
                :entity="entity"
                :selected="isSelected(entity.identity.id)"
            />
            <PdfShapeAnnotation
                v-if="shapeDraftEntity"
                :entity="shapeDraftEntity"
                :selected="false"
            />
        </svg>
        <div class="pdf-annotation-editor-surface__html">
            <PdfTextBoxAnnotation
                v-for="entity in htmlEntities.textBoxes"
                :key="entity.identity.id"
                :ref="element => setTextBoxRef(entity.identity.id, element)"
                :entity="entity"
                :selected="isSelected(entity.identity.id)"
                :editing="editingId === entity.identity.id"
                :display-rect="displayRectFor(entity)"
                @pointer-down="handleTextBoxPointerDown(entity, $event)"
                @edit="beginTextBoxEdit(entity.identity.id)"
                @commit="commitTextBox(entity.identity.id, $event)"
                @cancel="cancelTextBox(entity.identity.id)"
            />
            <PdfNoteAnnotation
                v-for="entity in htmlEntities.notes"
                :key="entity.identity.id"
                :entity="entity"
                :selected="isSelected(entity.identity.id)"
                :display-rect="displayRectForNote(entity)"
                @pointer-down="handleNotePointerDown(entity, $event)"
                @double-click="handleNoteDoubleClick(entity)"
            />
            <PdfStampAnnotation
                v-for="entity in htmlEntities.stamps"
                :key="entity.identity.id"
                :entity="entity"
                :selected="isSelected(entity.identity.id)"
                :display-rect="displayRectForStamp(entity)"
            />
            <div
                v-if="isCreating && pointerGesture.previewRect.value"
                class="pdf-annotation-editor-text-box-preview"
                :style="rectStyle(pointerGesture.previewRect.value)"
                aria-hidden="true"
            />
            <PdfAnnotationSelectionHandles
                :entity="selectedEntity"
                :display-rect="selectedDisplayRect"
                @resize-start="handleResizeStart"
            />
        </div>
    </div>
</template>

<script setup lang="ts">
import type { ComponentPublicInstance } from 'vue';
import {
    asAnnotationId,
    toLegacyShapeAnnotation,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import type {
    AnnotationId,
    IPlacedImageEntity,
    INoteEntity,
    IShapeEntity,
    ITextBoxEntity,
    ITextMarkupEntity,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import {
    annotationEditorSurfaceKey,
    type IAnnotationEditorSurface,
} from '@app/modules/pdf-viewer/runtime/annotations/usePdfAnnotationEditorSurface';
import PdfAnnotationSelectionHandles from '@app/modules/pdf-viewer/components/PdfAnnotationSelectionHandles.vue';
import PdfNoteAnnotation from '@app/modules/pdf-viewer/components/PdfNoteAnnotation.vue';
import PdfShapeAnnotation from '@app/modules/pdf-viewer/components/PdfShapeAnnotation.vue';
import PdfStampAnnotation from '@app/modules/pdf-viewer/components/PdfStampAnnotation.vue';
import PdfTextBoxAnnotation from '@app/modules/pdf-viewer/components/PdfTextBoxAnnotation.vue';
import PdfTextMarkupAnnotation from '@app/modules/pdf-viewer/components/PdfTextMarkupAnnotation.vue';
import {annotationIdFromEditorEvent} from '@app/modules/pdf-viewer/engine/annotations/annotationIdFromEditorEvent';
import {
    annotationRectsEqual,
    annotationRectContainsPoint,
    createDefaultTextBoxRect,
    moveAnnotationRect,
    type IAnnotationEditorPoint,
    type TAnnotationResizeHandle,
} from '@app/modules/pdf-viewer/engine/annotation-editor-geometry/annotationEditorGeometry';
import { markerRectFromPoint } from '@app/modules/pdf-viewer/engine/annotations/pdf-page-point-resolver/markerRectFromPoint';
import { useAnnotationCreationTools } from '@app/modules/pdf-viewer/annotations/editor/useAnnotationCreationTools';
import {
    rectForMovableEntity,
    useAnnotationPointerGesture,
} from '@app/modules/pdf-viewer/annotations/editor/useAnnotationPointerGesture';
import { useAnnotationKeyboardCommands } from '@app/modules/pdf-viewer/annotations/editor/useAnnotationKeyboardCommands';
import type {
    IShapeAnnotation,
    TAnnotationTool,
} from '@app/types/annotations';
import {toCanonicalShapeEntity} from '@app/modules/pdf-viewer/annotations/annotationApplication';
import {getShapeBounds} from '@app/modules/pdf-viewer/engine/pdf-shape-resize/getShapeBounds';
import {resizeShapeToBounds} from '@app/modules/pdf-viewer/engine/pdf-shape-resize/resizeShapeToBounds';
import {isShapeTool} from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/isShapeTool';

const props = defineProps<{pageIndex: number;}>();

const injectedSurface = inject<IAnnotationEditorSurface>(annotationEditorSurfaceKey);
if (!injectedSurface) {
    throw new Error('PdfAnnotationEditorLayer requires an annotation editor surface');
}
const surface: IAnnotationEditorSurface = injectedSurface;
const layerRef = ref<HTMLElement | null>(null);
const editorReady = ref(false);
const editingId = ref<AnnotationId | null>(null);
const draggedAnnotationId = ref<AnnotationId | null>(null);
const isCreating = ref(false);
const creatingTool = ref<Extract<TAnnotationTool, 'text' | 'note' | 'draw' | 'rectangle' | 'circle' | 'line' | 'arrow'> | null>(null);
const shapeDraft = ref<IShapeAnnotation | null>(null);
const newTextBoxIds = new Set<AnnotationId>();
interface IPdfTextBoxAnnotationExpose {commitDraft: () => void;}
const textBoxRefs = new Map<AnnotationId, IPdfTextBoxAnnotationExpose>();
let suppressNextClick = false;
let suppressClickTimer: ReturnType<typeof setTimeout> | null = null;
let capturedClickAnnotationId: AnnotationId | null = null;

onMounted(() => {
    editorReady.value = true;
});

const pointerGesture = useAnnotationPointerGesture({
    surface,
    pageIndex: props.pageIndex,
});
const creationTools = useAnnotationCreationTools({surface});
const keyboardCommands = useAnnotationKeyboardCommands({
    surface,
    pageView: () => surface.getPageGeometry(props.pageIndex)?.pageView ?? null,
    pageRotation: () => surface.getPageGeometry(props.pageIndex)?.rotation ?? 0,
});
const isInteractive = computed(() => (
    surface.activeTool.value === 'select'
    || surface.activeTool.value === 'none'
    || surface.activeTool.value === 'text'
    || surface.activeTool.value === 'note'
    || isShapeTool(surface.activeTool.value)
    || pointerGesture.isActive.value
));
const entities = computed(() => surface.getEntitiesForPage(props.pageIndex));
const selectedIds = computed(() => surface.selectedIds.value);
const selectedEntity = computed(() => {
    const selectedId = [...selectedIds.value][0];
    return entities.value.find(entity => entity.identity.id === selectedId) ?? null;
});
const moveDelta = computed(() => {
    const draggedEntity = entities.value.find(entity => entity.identity.id === draggedAnnotationId.value);
    const anchor = draggedEntity ? rectForMovableEntity(draggedEntity) : null;
    const preview = pointerGesture.previewRect.value;
    return anchor && preview && pointerGesture.isActive.value
        ? {
            x: preview.left - anchor.left,
            y: preview.top - anchor.top,
        }
        : null;
});
const selectedDisplayRect = computed(() => {
    const entity = selectedEntity.value;
    if (
        !entity
        || draggedAnnotationId.value !== entity.identity.id
        || (entity.kind !== 'text-box' && entity.kind !== 'shape' && entity.kind !== 'placed-image')
    ) {
        return undefined;
    }
    return pointerGesture.previewRect.value ?? undefined;
});
const isSelected = (id: AnnotationId) => selectedIds.value.has(id);
function handleKeydown(event: KeyboardEvent) {
    keyboardCommands.handleKeydown(event);
}

const svgEntities = computed(() => {
    return {
        textMarkup: entities.value
            .filter((entity): entity is ITextMarkupEntity => entity.kind === 'text-markup')
            .map(entity => {
                const delta = moveDelta.value;
                return delta && selectedIds.value.has(entity.identity.id)
                    ? {
                        ...entity,
                        quadPoints: entity.quadPoints.map(rect => moveAnnotationRect(rect, delta.x, delta.y)),
                    }
                    : entity;
            }),
        shapes: entities.value
            .filter((entity): entity is IShapeEntity => entity.kind === 'shape')
            .map(shapeForRender),
    };
});

function shapeForRender(entity: IShapeEntity) {
    const delta = moveDelta.value;
    if (delta && surface.selectedIds.value.has(entity.identity.id)) {
        return toCanonicalShapeEntity(translateLegacyShape(toLegacyShapeAnnotation(entity), delta.x, delta.y), entity.identity.id);
    }
    if (draggedAnnotationId.value !== entity.identity.id || !pointerGesture.previewRect.value) {
        return entity;
    }
    const previewRect = pointerGesture.previewRect.value;
    const legacy = toLegacyShapeAnnotation(entity);
    const deltaX = previewRect.left - entity.rect.left;
    const deltaY = previewRect.top - entity.rect.top;
    const next = pointerGesture.isActive.value
        && entity.identity.id === draggedAnnotationId.value
        && previewRect.width === entity.rect.width
        && previewRect.height === entity.rect.height
        ? translateLegacyShape(legacy, deltaX, deltaY)
        : resizeShapeToBounds(legacy, getShapeBounds(legacy), {
            minX: previewRect.left,
            minY: previewRect.top,
            maxX: previewRect.left + previewRect.width,
            maxY: previewRect.top + previewRect.height,
        });
    return toCanonicalShapeEntity(next, entity.identity.id);
}

function translateLegacyShape(shape: IShapeAnnotation, deltaX: number, deltaY: number): IShapeAnnotation {
    return {
        ...shape,
        x: shape.x + deltaX,
        y: shape.y + deltaY,
        ...(shape.x2 === undefined ? {} : {x2: shape.x2 + deltaX}),
        ...(shape.y2 === undefined ? {} : {y2: shape.y2 + deltaY}),
        ...(shape.points === undefined ? {} : {points: shape.points.map(point => ({
            x: point.x + deltaX,
            y: point.y + deltaY,
        }))}),
        ...(shape.strokes === undefined ? {} : {strokes: shape.strokes.map(stroke => stroke.map(point => ({
            x: point.x + deltaX,
            y: point.y + deltaY,
        })))}),
    };
}
const shapeDraftEntity = computed(() => {
    const draft = shapeDraft.value;
    if (!draft) {
        return null;
    }
    const linePoints = draft.type === 'line' || draft.type === 'arrow'
        ? [
            {
                x: draft.x,
                y: draft.y,
            },
            {
                x: draft.x2 ?? draft.x + draft.width,
                y: draft.y2 ?? draft.y + draft.height,
            },
        ]
        : undefined;
    const points = draft.points ?? linePoints;
    const left = draft.type === 'line' || draft.type === 'arrow'
        ? Math.min(draft.x, draft.x2 ?? draft.x + draft.width)
        : draft.x;
    const top = draft.type === 'line' || draft.type === 'arrow'
        ? Math.min(draft.y, draft.y2 ?? draft.y + draft.height)
        : draft.y;
    const right = draft.type === 'line' || draft.type === 'arrow'
        ? Math.max(draft.x, draft.x2 ?? draft.x + draft.width)
        : draft.x + draft.width;
    const bottom = draft.type === 'line' || draft.type === 'arrow'
        ? Math.max(draft.y, draft.y2 ?? draft.y + draft.height)
        : draft.y + draft.height;
    return {
        kind: 'shape',
        identity: {id: asAnnotationId(draft.id)},
        pageIndex: draft.pageIndex,
        revision: 0,
        persistedRevision: -1,
        deleted: false,
        createdAt: draft.createdAt ?? null,
        modifiedAt: draft.modifiedAt ?? null,
        author: null,
        tool: draft.type === 'polyline' || draft.type === 'polygon' ? 'draw' : draft.type,
        rect: {
            left,
            top,
            width: right - left,
            height: bottom - top,
        },
        ...(points === undefined ? {} : {points}),
        ...(draft.strokes === undefined ? {} : {strokes: draft.strokes}),
        strokeColor: draft.color,
        strokeWidth: draft.strokeWidth,
        fill: draft.fillColor ?? null,
        opacity: draft.opacity,
    } satisfies IShapeEntity;
});
const htmlEntities = computed(() => ({
    textBoxes: entities.value.filter((entity): entity is ITextBoxEntity => entity.kind === 'text-box'),
    notes: entities.value.filter((entity): entity is INoteEntity => entity.kind === 'note'),
    stamps: entities.value.filter((entity): entity is IPlacedImageEntity => entity.kind === 'placed-image'),
}));

function displayRectForStamp(entity: IPlacedImageEntity) {
    const delta = moveDelta.value;
    return delta && surface.selectedIds.value.has(entity.identity.id)
        ? moveAnnotationRect(entity.rect, delta.x, delta.y)
        : undefined;
}

function setTextBoxRef(
    annotationId: AnnotationId,
    element: Element | ComponentPublicInstance | null,
) {
    if (
        element
        && 'commitDraft' in element
        && typeof element.commitDraft === 'function'
    ) {
        textBoxRefs.set(annotationId, element as IPdfTextBoxAnnotationExpose);
        return;
    }
    textBoxRefs.delete(annotationId);
}

function entityIdFromEvent(event: MouseEvent | PointerEvent) {
    return annotationIdFromEditorEvent(event);
}

function pointFromEvent(event: Pick<PointerEvent, 'clientX' | 'clientY'>): IAnnotationEditorPoint | null {
    const layerRect = layerRef.value?.getBoundingClientRect();
    if (!layerRect || layerRect.width <= 0 || layerRect.height <= 0) {
        return null;
    }
    return {
        x: (event.clientX - layerRect.left) / layerRect.width,
        y: (event.clientY - layerRect.top) / layerRect.height,
    };
}

function capturePointer(event: PointerEvent) {
    if (event.pointerId >= 0) {
        layerRef.value?.setPointerCapture?.(event.pointerId);
    }
}

function focusLayer() {
    layerRef.value?.focus({preventScroll: true});
}

function releasePointer(event: PointerEvent) {
    if (event.pointerId >= 0 && layerRef.value?.hasPointerCapture?.(event.pointerId)) {
        layerRef.value.releasePointerCapture(event.pointerId);
    }
}

function rectStyle(rect: {
    left: number;
    top: number;
    width: number;
    height: number
}) {
    return {
        left: String(rect.left * 100) + '%',
        top: String(rect.top * 100) + '%',
        width: String(rect.width * 100) + '%',
        height: String(rect.height * 100) + '%',
    };
}

function displayRectFor(entity: ITextBoxEntity) {
    const delta = moveDelta.value;
    if (delta && surface.selectedIds.value.has(entity.identity.id)) {
        return moveAnnotationRect(entity.rect, delta.x, delta.y);
    }
    if (draggedAnnotationId.value !== entity.identity.id) {
        return undefined;
    }
    return pointerGesture.previewRect.value ?? undefined;
}

function displayRectForNote(entity: INoteEntity) {
    const delta = moveDelta.value;
    if (delta && surface.selectedIds.value.has(entity.identity.id)) {
        return moveAnnotationRect(entity.position, delta.x, delta.y);
    }
    if (draggedAnnotationId.value !== entity.identity.id) {
        return undefined;
    }
    return pointerGesture.previewRect.value ?? undefined;
}

function textBoxIdAtPoint(event: Pick<MouseEvent, 'clientX' | 'clientY'>) {
    const point = pointFromEvent(event);
    if (!point) {
        return null;
    }
    return [...htmlEntities.value.textBoxes].reverse().find(entity => (
        annotationRectContainsPoint(entity.rect, point)
    ))?.identity.id ?? null;
}

function beginTextBoxEdit(annotationId: AnnotationId) {
    surface.select([annotationId]);
    editingId.value = annotationId;
}

function handleTextBoxPointerDown(entity: ITextBoxEntity, event: PointerEvent) {
    if (event.button !== 0 || editingId.value === entity.identity.id) {
        return;
    }
    focusLayer();
    const point = pointFromEvent(event);
    if (!point) {
        return;
    }
    const wasSelected = surface.selectedIds.value.has(entity.identity.id);
    if (!wasSelected || event.shiftKey) {
        surface.select([entity.identity.id], {additive: event.shiftKey});
    }
    if (event.shiftKey || (surface.activeTool.value !== 'select' && surface.activeTool.value !== 'none')) {
        return;
    }
    if (pointerGesture.beginMove(entity.identity.id, point, event)) {
        draggedAnnotationId.value = entity.identity.id;
        event.preventDefault();
        capturePointer(event);
    }
}

function handleNotePointerDown(entity: INoteEntity, event: PointerEvent) {
    if (event.button !== 0) {
        return;
    }
    focusLayer();
    const point = pointFromEvent(event);
    if (!point) {
        return;
    }
    const wasSelected = surface.selectedIds.value.has(entity.identity.id);
    if (!wasSelected || event.shiftKey) {
        surface.select([entity.identity.id], {additive: event.shiftKey});
    }
    if (event.shiftKey || (surface.activeTool.value !== 'select' && surface.activeTool.value !== 'none')) {
        return;
    }
    if (pointerGesture.beginMove(entity.identity.id, point, event)) {
        draggedAnnotationId.value = entity.identity.id;
        event.preventDefault();
        capturePointer(event);
    }
}

function handleNoteDoubleClick(entity: INoteEntity) {
    surface.select([entity.identity.id]);
    surface.openNote(entity.identity.id);
}

function handleResizeStart(handle: TAnnotationResizeHandle, event: PointerEvent) {
    const entity = selectedEntity.value;
    if (
        (!entity || (entity.kind !== 'text-box' && entity.kind !== 'shape' && entity.kind !== 'placed-image'))
        || editingId.value === entity.identity.id
    ) {
        return;
    }
    const point = pointFromEvent(event);
    if (!point) {
        return;
    }
    if (pointerGesture.beginResize(entity.identity.id, handle, point, event)) {
        draggedAnnotationId.value = entity.identity.id;
        surface.select([entity.identity.id]);
        event.preventDefault();
        capturePointer(event);
    }
}

function handleSurfacePointerDown(event: PointerEvent) {
    if (event.button !== 0) {
        return;
    }
    focusLayer();
    const id = entityIdFromEvent(event);
    capturedClickAnnotationId = id;
    if (id) {
        const wasSelected = surface.selectedIds.value.has(id);
        if (!wasSelected || event.shiftKey) {
            surface.select([id], {additive: event.shiftKey});
        }
        if (!event.shiftKey && (surface.activeTool.value === 'select' || surface.activeTool.value === 'none')) {
            const point = pointFromEvent(event);
            if (point && pointerGesture.beginMove(id, point, event)) {
                draggedAnnotationId.value = id;
                event.preventDefault();
                capturePointer(event);
            }
        }
        return;
    }
    if (
        surface.activeTool.value !== 'text'
        && surface.activeTool.value !== 'note'
        && !isShapeTool(surface.activeTool.value)
    ) {
        surface.clearSelection();
        return;
    }
    const point = pointFromEvent(event);
    const tool = surface.activeTool.value;
    const draft = point && isShapeTool(tool)
        ? creationTools.beginShape(props.pageIndex, tool, point)
        : null;
    if (!point || (isShapeTool(tool) && !draft) || !pointerGesture.beginCreate(point, event)) {
        return;
    }
    isCreating.value = true;
    creatingTool.value = tool;
    shapeDraft.value = draft;
    event.preventDefault();
    capturePointer(event);
}

function handlePointerMove(event: PointerEvent) {
    if (!pointerGesture.isActive.value) {
        return;
    }
    const point = pointFromEvent(event);
    if (!point) {
        return;
    }
    if (!pointerGesture.update(point, event)) {
        return;
    }
    if (shapeDraft.value) {
        shapeDraft.value = creationTools.updateShape(shapeDraft.value, point);
    }
    event.preventDefault();
}

function markClickSuppressed() {
    suppressNextClick = true;
    if (suppressClickTimer !== null) {
        clearTimeout(suppressClickTimer);
    }
    suppressClickTimer = setTimeout(() => {
        suppressNextClick = false;
        suppressClickTimer = null;
    });
}

function handlePointerUp(event: PointerEvent) {
    if (!pointerGesture.isActiveForPointer(event.pointerId)) {
        return;
    }
    const point = pointFromEvent(event);
    const completion = point ? pointerGesture.finish(point, event) : null;
    releasePointer(event);
    isCreating.value = false;
    draggedAnnotationId.value = null;
    const draft = shapeDraft.value;
    shapeDraft.value = null;
    const tool = creatingTool.value;
    creatingTool.value = null;
    if (!completion) {
        pointerGesture.cancel();
        return;
    }
    if (completion.hasMoved) {
        markClickSuppressed();
    }
    if (completion.mode === 'create') {
        if (!tool) {
            return;
        }
        if (isShapeTool(tool)) {
            const completedDraft = draft && point
                ? creationTools.updateShape(draft, point)
                : draft;
            const created = completedDraft ? creationTools.finishShape(completedDraft) : null;
            if (created) {
                surface.createShape(created);
            }
            return;
        }
        const rect = tool === 'note'
            ? completion.hasMoved
                ? completion.rect
                : markerRectFromPoint(completion.start.x, completion.start.y)
            : completion.hasMoved
                ? completion.rect
                : createDefaultTextBoxRect(completion.start);
        if (!rect) {
            return;
        }
        const created = creationTools.create(tool, completion.pageIndex, rect);
        if (created) {
            if (created.kind === 'text-box') {
                newTextBoxIds.add(created.identity.id);
                editingId.value = created.identity.id;
            } else {
                surface.openNote(created.identity.id);
            }
        }
        return;
    }
    if (!completion.hasMoved || !completion.gesture) {
        return;
    }
    if (completion.mode === 'move' && surface.selectedIds.value.size > 1) {
        const anchor = rectForMovableEntity(completion.gesture.entity);
        if (anchor) {
            surface.moveSelection(completion.rect.left - anchor.left, completion.rect.top - anchor.top);
            return;
        }
    }
    const originalRect = rectForMovableEntity(completion.gesture.entity);
    if (!originalRect || annotationRectsEqual(originalRect, completion.rect)) {
        return;
    }
    if (completion.gesture.entity.kind === 'shape') {
        const legacy = toLegacyShapeAnnotation(completion.gesture.entity);
        const baselineBounds = getShapeBounds(legacy);
        const nextBounds = {
            minX: completion.rect.left,
            minY: completion.rect.top,
            maxX: completion.rect.left + completion.rect.width,
            maxY: completion.rect.top + completion.rect.height,
        };
        const deltaX = completion.rect.left - originalRect.left;
        const deltaY = completion.rect.top - originalRect.top;
        const next = completion.mode === 'move'
            ? translateLegacyShape(legacy, deltaX, deltaY)
            : resizeShapeToBounds(legacy, baselineBounds, nextBounds);
        const canonical = toCanonicalShapeEntity(next, completion.gesture.annotationId);
        surface.commitGesture(completion.gesture, {
            rect: canonical.rect,
            ...(canonical.points === undefined ? {} : {points: canonical.points}),
            ...(canonical.strokes === undefined ? {} : {strokes: canonical.strokes}),
        });
        return;
    }
    if (completion.gesture.entity.kind === 'note') {
        surface.commitGesture(completion.gesture, {position: completion.rect});
    } else if (completion.gesture.entity.kind === 'text-markup') {
        const deltaX = completion.rect.left - originalRect.left;
        const deltaY = completion.rect.top - originalRect.top;
        surface.commitGesture(completion.gesture, {quadPoints: completion.gesture.entity.quadPoints.map(rect => ({
            ...rect,
            left: rect.left + deltaX,
            top: rect.top + deltaY,
        }))});
    } else {
        surface.commitGesture(completion.gesture, {rect: completion.rect});
    }
}

function handlePointerCancel(event: PointerEvent) {
    if (!pointerGesture.isActiveForPointer(event.pointerId)) {
        return;
    }
    releasePointer(event);
    pointerGesture.cancel();
    isCreating.value = false;
    draggedAnnotationId.value = null;
    creatingTool.value = null;
    shapeDraft.value = null;
}

function handleSurfaceClick(event: MouseEvent) {
    if (suppressNextClick) {
        suppressNextClick = false;
        capturedClickAnnotationId = null;
        return;
    }
    const id = entityIdFromEvent(event) ?? capturedClickAnnotationId ?? textBoxIdAtPoint(event);
    capturedClickAnnotationId = null;
    if (!id) {
        surface.clearSelection();
        return;
    }
    surface.select([id], {additive: event.shiftKey});
}

function handleSurfaceContextMenu(event: MouseEvent) {
    const id = entityIdFromEvent(event);
    if (!id) {
        return;
    }
    surface.select([id], {additive: event.shiftKey});
    surface.openShapeContextMenu({
        shapeId: id,
        clientX: event.clientX,
        clientY: event.clientY,
    });
}

function handleSurfaceDblClick(event: MouseEvent) {
    const id = entityIdFromEvent(event) ?? textBoxIdAtPoint(event);
    if (id) {
        const entity = entities.value.find(candidate => candidate.identity.id === id);
        if (entity?.kind === 'text-box') {
            beginTextBoxEdit(id);
        } else {
            surface.openNote(id);
        }
    }
}

function currentTextBox(annotationId: AnnotationId) {
    return entities.value.find((entity): entity is ITextBoxEntity => (
        entity.kind === 'text-box' && entity.identity.id === annotationId
    )) ?? null;
}

function commitTextBox(annotationId: AnnotationId, text: string) {
    if (editingId.value !== annotationId) {
        return;
    }
    const entity = currentTextBox(annotationId);
    if (!entity) {
        editingId.value = null;
        return;
    }
    if (newTextBoxIds.has(annotationId) && text.trim().length === 0) {
        surface.discardUnsavedAnnotation(annotationId);
    } else if (entity.text !== text) {
        surface.commitGesture(annotationId, {text});
    }
    newTextBoxIds.delete(annotationId);
    editingId.value = null;
}

function cancelTextBox(annotationId: AnnotationId) {
    if (editingId.value !== annotationId) {
        return;
    }
    const entity = currentTextBox(annotationId);
    if (entity && newTextBoxIds.has(annotationId)) {
        surface.discardUnsavedAnnotation(annotationId);
    }
    newTextBoxIds.delete(annotationId);
    editingId.value = null;
}

onBeforeUnmount(() => {
    if (suppressClickTimer !== null) {
        clearTimeout(suppressClickTimer);
    }
    if (editingId.value !== null) {
        textBoxRefs.get(editingId.value)?.commitDraft();
    }
    newTextBoxIds.forEach(annotationId => surface.discardUnsavedAnnotation(annotationId));
    newTextBoxIds.clear();
    textBoxRefs.clear();
    editingId.value = null;
    pointerGesture.cancel();
});
</script>
