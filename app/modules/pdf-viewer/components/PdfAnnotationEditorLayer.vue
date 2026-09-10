<template>
    <div
        ref="layerRef"
        class="pdf-annotation-editor-layer"
        :class="{'is-interactive': isInteractive}"
        data-pdf-annotation-editor-surface
        :data-view-rotation="viewRotation"
        :data-pdf-annotation-editor-ready="editorReady ? 'true' : undefined"
        tabindex="0"
        @mousedown.stop
        @pointerdown.stop="handleSurfacePointerDown"
        @pointermove="handlePointerMove"
        @pointerup="handlePointerUp"
        @pointercancel="handlePointerCancel"
        @lostpointercapture="handleLostPointerCapture"
        @click.stop="handleSurfaceClick"
        @contextmenu.prevent="handleSurfaceContextMenu"
        @dblclick.stop="handleSurfaceDblClick"
        @keydown.capture="clearClickSuppression"
        @keydown="handleKeydown"
    >
        <div
            v-if="isInteractive"
            class="pdf-annotation-editor-surface__background"
            aria-hidden="true"
        />
        <svg
            class="pdf-annotation-editor-surface__svg"
            viewBox="0 0 1 1"
            preserveAspectRatio="none"
            :style="planeStyle"
            aria-hidden="true"
        >
            <PdfTextMarkupAnnotation
                v-for="entity in svgEntities.textMarkup"
                :key="entity.identity.id"
                :page-rotation="surface.getPageGeometry(pageIndex)?.rotation ?? 0"
                :entity="entity"
                :highlight-paint-quads="highlightPaintQuads.get(entity.identity.id)"
                :selected="isSelected(entity.identity.id)"
                :page-size="pageDimensions"
            />
            <PdfShapeAnnotation
                v-for="entity in svgEntities.shapes"
                :key="entity.identity.id"
                :entity="entity"
                :selected="isSelected(entity.identity.id)"
                :page-size="pageDimensions"
            />
            <PdfShapeAnnotation
                v-if="shapeDraftEntity"
                :entity="shapeDraftEntity"
                :page-size="pageDimensions"
                :selected="false"
            />
        </svg>
        <div class="pdf-annotation-editor-surface__html" :style="planeStyle">
            <PdfTextBoxAnnotation
                v-for="entity in htmlEntities.textBoxes"
                :key="entity.identity.id"
                :ref="element => setTextBoxRef(entity.identity.id, element)"
                :entity="entity"
                :selected="isSelected(entity.identity.id)"
                :editing="editingId === entity.identity.id"
                :caret-point="surface.textEditPoint.value"
                :auto-size-draft="autoSizeTextBoxIds.has(entity.identity.id)"
                :display-rect="displayRectFor(entity)"
                :display-font-size="displayFontSizeFor(entity)"
                @pointer-down="handleTextBoxPointerDown(entity, $event)"
                @edit="beginTextBoxEdit(entity.identity.id, $event)"
                @draft-change="surface.setTextBoxDraftPending(entity.identity.id, $event)"
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
                @activate="handleNoteActivate(entity)"
            />
            <PdfStampAnnotation
                v-for="entity in htmlEntities.stamps"
                :key="entity.identity.id"
                :entity="entity"
                :selected="isSelected(entity.identity.id)"
                :display-rect="displayRectForStamp(entity)"
            />
            <div
                v-if="textPlacementPreview"
                class="pdf-annotation-editor-text-box-preview"
                :style="{...rectStyle(textPlacementPreview!), transform: `rotate(${(360 - viewRotation) % 360}deg)`}"
                aria-hidden="true"
            />
            <PdfAnnotationSelectionHandles
                :entity="selectedEntity"
                :display-rect="selectedDisplayRect"
                :view-rotation="viewRotation"
                @resize-start="handleResizeStart"
                @move-start="handleMoveStart"
            />
        </div>
    </div>
</template>

<script setup lang="ts">
import type { ComponentPublicInstance } from 'vue';
import { requirePageIndex } from '@contracts/pageNumbers';
import {asAnnotationId} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import type {
    AnnotationId,
    IPlacedImageEntity,
    AnnotationEntity,
    INoteEntity,
    IShapeEntity,
    ITextBoxEntity,
    ITextMarkupEntity,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import {parseEpochMs} from '@contracts/timestamps';
import {
    annotationEditorSurfaceKey,
    type IAnnotationEditorSurface,
} from '@app/modules/pdf-viewer/runtime/annotations/usePdfAnnotationEditorSurface';
import PdfAnnotationSelectionHandles from '@app/modules/pdf-viewer/components/PdfAnnotationSelectionHandles.vue';
import PdfNoteAnnotation from '@app/modules/pdf-viewer/components/PdfNoteAnnotation.vue';
import PdfShapeAnnotation from '@app/modules/pdf-viewer/components/PdfShapeAnnotation.vue';
import PdfStampAnnotation from '@app/modules/pdf-viewer/components/PdfStampAnnotation.vue';
import { resizeTextAnnotation } from '@app/modules/pdf-viewer/engine/annotation-editor-geometry/resizeTextAnnotation';
import PdfTextBoxAnnotation from '@app/modules/pdf-viewer/components/PdfTextBoxAnnotation.vue';
import PdfTextMarkupAnnotation from '@app/modules/pdf-viewer/components/PdfTextMarkupAnnotation.vue';
import {annotationIdFromEditorEvent} from '@app/modules/pdf-viewer/engine/annotations/annotationIdFromEditorEvent';
import {
    annotationRectsEqual,
    transformShapeToRect,
    annotationPageDimensions,
    rotateAnnotationPoint,
    unrotateAnnotationPlacementRect,
    rotateAnnotationPointAround,
    annotationRectContainsPoint,
    createDefaultTextBoxRect,
    type IAnnotationEditorPoint,
    type TAnnotationResizeHandle,
} from '@app/modules/pdf-viewer/engine/annotation-editor-geometry/annotationEditorGeometry';
import { markerRectFromPoint } from '@app/modules/pdf-viewer/engine/annotations/pdf-page-point-resolver/markerRectFromPoint';
import { useAnnotationCreationTools } from '@app/modules/pdf-viewer/annotations/editor/useAnnotationCreationTools';
import { isReleasedMouseCapture } from '@app/modules/pdf-viewer/annotations/editor/isReleasedMouseCapture';
import {
    rectForMovableEntity,
    useAnnotationPointerGesture,
} from '@app/modules/pdf-viewer/annotations/editor/useAnnotationPointerGesture';
import { useAnnotationKeyboardCommands } from '@app/modules/pdf-viewer/annotations/editor/useAnnotationKeyboardCommands';
import type {
    IAnnotationMarkerRect,
    IShapeAnnotation,
    TAnnotationTool,
} from '@app/types/annotations';
import {isShapeTool} from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/isShapeTool';

const props = defineProps<{pageIndex: number;}>();

const injectedSurface = inject<IAnnotationEditorSurface>(annotationEditorSurfaceKey);
if (!injectedSurface) {
    throw new Error('PdfAnnotationEditorLayer requires an annotation editor surface');
}
const surface: IAnnotationEditorSurface = injectedSurface;
const layerRef = ref<HTMLElement | null>(null);
const editorReady = ref(false);
const editingId = surface.editingId;
const pageDimensions = computed(() => {
    const geometry = surface.getPageGeometry(props.pageIndex);
    return annotationPageDimensions(geometry?.pageView, geometry?.rotation ?? 0);
});
const viewRotation = computed(() => surface.getPageGeometry(props.pageIndex)?.viewRotation ?? 0);
const planeStyle = computed(() => {
    const swapped = viewRotation.value === 90 || viewRotation.value === 270;
    const page = pageDimensions.value;
    return {
        left: '50%',
        top: '50%',
        width: swapped ? `${page.width / page.height * 100}%` : '100%',
        height: swapped ? `${page.height / page.width * 100}%` : '100%',
        transform: `translate(-50%, -50%) rotate(${viewRotation.value}deg)`,
        '--annotation-view-rotation': `${viewRotation.value}deg`,
    };
});
const draggedAnnotationId = ref<AnnotationId | null>(null);
const isCreating = ref(false);
const creatingTool = ref<Extract<TAnnotationTool, 'text' | 'note' | 'draw' | 'rectangle' | 'circle' | 'line' | 'arrow'> | null>(null);
const shapeDraft = ref<IShapeAnnotation | null>(null);
const newTextBoxIds = new Set<AnnotationId>();
const autoSizeTextBoxIds = reactive(new Set<AnnotationId>());
interface IPdfTextBoxAnnotationExpose {
    commitDraft: () => void;
    getDraftRect: () => IAnnotationMarkerRect;
    getDraftText: () => string;
    fitRectToContent?: (rect: IAnnotationMarkerRect, handle?: TAnnotationResizeHandle, fontSize?: number) => IAnnotationMarkerRect | null;
}
const textBoxRefs = shallowReactive(new Map<AnnotationId, IPdfTextBoxAnnotationExpose>());
let suppressNextClick = false;
let capturedPointerId: number | null = null;
let capturedClickAnnotationId: AnnotationId | null = null;
let unregisterPageInteraction: (() => void) | null = null;

onMounted(() => {
    editorReady.value = true;
    unregisterPageInteraction = surface.registerPageInteraction(props.pageIndex, {
        commitTextDraft: commitActiveTextBoxDraftForSave,
        cancelTextDraft: () => { if (editingId.value !== null) { cancelTextBox(editingId.value); } },
        cancelPointerGesture: cancelPointerGesture,
        focus: focusLayer,
        getTextBoxDraftRect: annotationId => textBoxRefs.get(annotationId)?.getDraftRect() ?? null,
        prepareGeometryChange: prepareTextBoxGeometryChange,
        fitTextBox: entity => {
            const fit = textBoxRefs.get(entity.identity.id)?.fitRectToContent;
            return fit ? fit(entity.rect, undefined, entity.fontSize) : entity.rect;
        },
    });
});

const pointerGesture = useAnnotationPointerGesture({
    surface,
    pageIndex: props.pageIndex,
});
watch(viewRotation, cancelPointerGesture);
const creationTools = useAnnotationCreationTools({surface});
const keyboardCommands = useAnnotationKeyboardCommands({
    surface,
    pageView: () => surface.getPageGeometry(props.pageIndex)?.pageView ?? null,
    pageRotation: () => surface.getPageGeometry(props.pageIndex)?.rotation ?? 0,
    placeTextBox: event => {
        if (event.target !== layerRef.value
            || surface.activeTool.value !== 'text'
            || editingId.value !== null
            || !layerRef.value) {
            return false;
        }
        const layerRect = visibleLayerRect(layerRef.value);
        if (!layerRect || layerRect.width <= 0 || layerRect.height <= 0) {
            return false;
        }
        const point = pointFromVisibleCenter(layerRect);
        const rect = textPlacementRect(point, point, false);
        const created = creationTools.create(
            'text',
            props.pageIndex,
            rect,
            undefined,
            (360 - viewRotation.value) % 360 as ITextBoxEntity['rotation'],
        );
        if (!created || created.kind !== 'text-box') {
            return false;
        }
        newTextBoxIds.add(created.identity.id);
        autoSizeTextBoxIds.add(created.identity.id);
        surface.beginTextEditing(created.identity.id);
        return true;
    },
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
const gestureMoveDelta = computed(() => {
    const draggedEntity = entities.value.find(entity => entity.identity.id === draggedAnnotationId.value);
    const anchor = draggedEntity ? rectForMovableEntity(draggedEntity) : null;
    const preview = pointerGesture.previewRect.value;
    return anchor && preview && pointerGesture.mode.value === 'move'
        ? {
            x: preview.left - anchor.left,
            y: preview.top - anchor.top,
        }
        : null;
});
watch(gestureMoveDelta, delta => surface.setSelectionMoveDelta(delta), {flush: 'sync'});
const moveDelta = surface.selectionMoveDelta;
const selectedDisplayRect = computed(() => {
    const entity = selectedEntity.value;
    if (entity?.kind === 'text-box' && editingId.value === entity.identity.id && draggedAnnotationId.value !== entity.identity.id) {
        return textBoxRefs.get(entity.identity.id)?.getDraftRect();
    }
    if (
        !entity
        || draggedAnnotationId.value !== entity.identity.id
        || (entity.kind !== 'text-box' && entity.kind !== 'shape' && entity.kind !== 'placed-image')
    ) {
        return undefined;
    }
    const rect = pointerGesture.previewRect.value;
    return rect ? fitTextBoxRect(entity, rect) : undefined;
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
                        quadPoints: entity.quadPoints.map(rect => translateRect(rect, delta.x, delta.y)),
                    }
                    : entity;
            }),
        shapes: entities.value
            .filter((entity): entity is IShapeEntity => entity.kind === 'shape')
            .map(shapeForRender),
    };
});

const highlightPaintQuads = computed(() => {
    const groups = new Map<string, IAnnotationMarkerRect[]>();
    const byAnnotation = new Map<AnnotationId, readonly IAnnotationMarkerRect[]>();
    for (const entity of svgEntities.value.textMarkup) {
        if (entity.subtype !== 'Highlight') continue;
        const key = `${entity.color?.toLowerCase() ?? 'default'}:${entity.opacity ?? 0.45}`;
        const group = groups.get(key);
        if (group) {
            group.push(...entity.quadPoints);
            byAnnotation.set(entity.identity.id, []);
        } else {
            const quads = [...entity.quadPoints];
            groups.set(key, quads);
            byAnnotation.set(entity.identity.id, quads);
        }
    }
    return byAnnotation;
});

function shapeForRender(entity: IShapeEntity) {
    const delta = moveDelta.value;
    if (delta && surface.selectedIds.value.has(entity.identity.id)) {
        return transformShapeToRect(entity, translateRect(entity.rect, delta.x, delta.y), 'move');
    }
    const preview = pointerGesture.previewRect.value;
    return draggedAnnotationId.value === entity.identity.id && preview
        ? transformShapeToRect(entity, preview, 'resize')
        : entity;
}

function translateRect(rect: IAnnotationMarkerRect, x: number, y: number): IAnnotationMarkerRect {
    return {
        ...rect,
        left: rect.left + x,
        top: rect.top + y,
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
        pageIndex: requirePageIndex(draft.pageIndex),
        revision: 0,
        persistedRevision: -1,
        deleted: false,
        createdAt: parseEpochMs(draft.createdAt),
        modifiedAt: parseEpochMs(draft.modifiedAt),
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
        ? translateRect(entity.rect, delta.x, delta.y)
        : draggedAnnotationId.value === entity.identity.id ? pointerGesture.previewRect.value ?? undefined : undefined;
}

function setTextBoxRef(
    annotationId: AnnotationId,
    element: Element | ComponentPublicInstance | null,
) {
    if (
        element
        && 'commitDraft' in element
        && typeof element.commitDraft === 'function'
        && 'getDraftRect' in element
        && typeof element.getDraftRect === 'function'
        && 'getDraftText' in element
        && typeof element.getDraftText === 'function'
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
    return rotateAnnotationPoint({
        x: (event.clientX - layerRect.left) / layerRect.width,
        y: (event.clientY - layerRect.top) / layerRect.height,
    }, -viewRotation.value);
}

function visibleLayerRect(layer: HTMLElement) {
    const layerRect = layer.getBoundingClientRect();
    const viewport = {
        left: 0,
        top: 0,
        right: window.innerWidth > 0 ? window.innerWidth : layerRect.right,
        bottom: window.innerHeight > 0 ? window.innerHeight : layerRect.bottom,
    };
    const visible = {
        left: Math.max(layerRect.left, viewport.left),
        top: Math.max(layerRect.top, viewport.top),
        right: Math.min(layerRect.right, viewport.right),
        bottom: Math.min(layerRect.bottom, viewport.bottom),
    };
    for (let parent = layer.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if (!/(auto|clip|hidden|scroll)/.test(`${style.overflow}${style.overflowX}${style.overflowY}`)) {
            continue;
        }
        const parentRect = parent.getBoundingClientRect();
        visible.left = Math.max(visible.left, parentRect.left);
        visible.top = Math.max(visible.top, parentRect.top);
        visible.right = Math.min(visible.right, parentRect.right);
        visible.bottom = Math.min(visible.bottom, parentRect.bottom);
    }
    return {
        left: visible.left,
        top: visible.top,
        width: visible.right - visible.left,
        height: visible.bottom - visible.top,
    };
}

function pointFromVisibleCenter(rect: {
    left: number;
    top: number;
    width: number;
    height: number
}) {
    const layerRect = layerRef.value!.getBoundingClientRect();
    return rotateAnnotationPoint({
        x: (rect.left + rect.width / 2 - layerRect.left) / layerRect.width,
        y: (rect.top + rect.height / 2 - layerRect.top) / layerRect.height,
    }, -viewRotation.value);
}

function capturePointer(event: PointerEvent) {
    if (event.pointerId >= 0) {
        layerRef.value?.setPointerCapture?.(event.pointerId);
        capturedPointerId = event.pointerId;
    }
}

function focusLayer() {
    layerRef.value?.focus({preventScroll: true});
}

function releasePointer(event: PointerEvent) {
    if (event.pointerId >= 0 && layerRef.value?.hasPointerCapture?.(event.pointerId)) {
        layerRef.value.releasePointerCapture(event.pointerId);
    }
    capturedPointerId = null;
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

function textResizeProposal(entity: ITextBoxEntity, rect: IAnnotationMarkerRect, handle = pointerGesture.resizeHandle.value, point = pointerGesture.current.value) {
    if (!handle || !point) {
        return {
            rect,
            fontSize: entity.fontSize,
        };
    }
    const proposal = resizeTextAnnotation(entity.rect, entity.fontSize, handle, point, entity.rotation, pageDimensions.value);
    if (handle.length === 1) {
        const fitted = textBoxRefs.get(entity.identity.id)?.fitRectToContent?.(proposal.rect, handle, proposal.fontSize);
        if (fitted === null) {
            return {
                rect: entity.rect,
                fontSize: entity.fontSize,
            };
        }
        proposal.rect = fitted ?? proposal.rect;
    }
    return proposal;
}

function fitTextBoxRect(entity: AnnotationEntity, rect: IAnnotationMarkerRect) {
    return entity.kind === 'text-box' && pointerGesture.mode.value === 'resize'
        ? textResizeProposal(entity, rect).rect
        : rect;
}

function displayFontSizeFor(entity: ITextBoxEntity) {
    return draggedAnnotationId.value === entity.identity.id && pointerGesture.mode.value === 'resize'
        ? textResizeProposal(entity, entity.rect).fontSize
        : undefined;
}

function textPlacementRect(start: IAnnotationEditorPoint, current: IAnnotationEditorPoint, hasMoved: boolean) {
    const pageGeometry = surface.getPageGeometry(props.pageIndex);
    const displayedStart = rotateAnnotationPoint(start, viewRotation.value);
    const defaultRect = createDefaultTextBoxRect(displayedStart, {
        pageView: pageGeometry?.pageView,
        pageRotation: ((pageGeometry?.rotation ?? 0) + viewRotation.value) % 360 as 0 | 90 | 180 | 270,
        fontSize: surface.settings.value?.textSize,
    });
    const displayedEnd = rotateAnnotationPoint(current, viewRotation.value);
    const width = hasMoved ? Math.max(defaultRect.width, Math.abs(displayedEnd.x - displayedStart.x)) : defaultRect.width;
    const left = hasMoved && displayedEnd.x < displayedStart.x ? displayedStart.x - width : displayedStart.x;
    return unrotateAnnotationPlacementRect({
        ...defaultRect,
        width,
        left: Math.max(0, Math.min(left, 1 - width)),
    }, viewRotation.value, pageDimensions.value);
}

const textPlacementPreview = computed(() => {
    const start = pointerGesture.start.value;
    const current = pointerGesture.current.value;
    return isCreating.value && creatingTool.value === 'text' && start && current
        ? textPlacementRect(start, current, pointerGesture.hasMoved.value)
        : null;
});

function displayRectFor(entity: ITextBoxEntity) {
    const delta = moveDelta.value;
    if (delta && surface.selectedIds.value.has(entity.identity.id)) {
        return translateRect(entity.rect, delta.x, delta.y);
    }
    if (draggedAnnotationId.value !== entity.identity.id) {
        return undefined;
    }
    const rect = pointerGesture.previewRect.value;
    return rect ? fitTextBoxRect(entity, rect) : undefined;
}

function displayRectForNote(entity: INoteEntity) {
    const delta = moveDelta.value;
    if (delta && surface.selectedIds.value.has(entity.identity.id)) {
        return translateRect(entity.position, delta.x, delta.y);
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
        annotationRectContainsPoint(entity.rect, rotateAnnotationPointAround(point, {
            x: entity.rect.left + entity.rect.width / 2,
            y: entity.rect.top + entity.rect.height / 2,
        }, -entity.rotation, pageDimensions.value))
    ))?.identity.id ?? null;
}

function beginTextBoxEdit(annotationId: AnnotationId, point?: {
    clientX: number;
    clientY: number
}) {
    surface.beginTextEditing(annotationId, point);
}

function commitActiveTextBoxDraftForSave() {
    const annotationId = editingId.value;
    if (annotationId === null || !currentTextBox(annotationId)) {
        return;
    }
    const textBox = textBoxRefs.get(annotationId);
    if (textBox) {
        textBox.commitDraft();
    } else {
        // The entity may have been deleted while its editor was still open.
        // Do not leave the workspace dirty forever for a DOM editor that no
        // longer exists.
        surface.clearTextBoxDraftPending(annotationId);
        surface.endTextEditing(annotationId, {restoreFocus: false});
    }
}

function handleTextBoxPointerDown(entity: ITextBoxEntity, event: PointerEvent, allowEditing = false) {
    clearClickSuppression();
    if (event.button !== 0 || (editingId.value === entity.identity.id && !allowEditing)) {
        return;
    }
    // The child stops pointerdown so text editing controls do not trigger the
    // surface handler. A click delivered after layer pointer capture still
    // needs the child identity for the surface's selection fallback.
    capturedClickAnnotationId = entity.identity.id;
    if (editingId.value !== entity.identity.id) focusLayer();
    const point = pointFromEvent(event);
    if (!point) {
        return;
    }
    const wasSelected = surface.selectedIds.value.has(entity.identity.id);
    if (!wasSelected || event.shiftKey) {
        surface.select([entity.identity.id], {additive: event.shiftKey});
    }
    if (event.shiftKey) {
        return;
    }
    if (pointerGesture.beginMove(entity.identity.id, point, event)) {
        surface.beginPointerInteraction(props.pageIndex);
        draggedAnnotationId.value = entity.identity.id;
        event.preventDefault();
        capturePointer(event);
    }
}

function handleNotePointerDown(entity: INoteEntity, event: PointerEvent) {
    clearClickSuppression();
    if (event.button !== 0) {
        return;
    }
    // The child stops pointerdown and the move gesture captures the pointer on
    // the layer. Preserve the identity for the captured follow-up click.
    capturedClickAnnotationId = entity.identity.id;
    focusLayer();
    const point = pointFromEvent(event);
    if (!point) {
        return;
    }
    const wasSelected = surface.selectedIds.value.has(entity.identity.id);
    if (!wasSelected || event.shiftKey) {
        surface.select([entity.identity.id], {additive: event.shiftKey});
    }
    if (event.shiftKey) {
        return;
    }
    if (pointerGesture.beginMove(entity.identity.id, point, event)) {
        surface.beginPointerInteraction(props.pageIndex);
        draggedAnnotationId.value = entity.identity.id;
        event.preventDefault();
        capturePointer(event);
    }
}

function handleNoteActivate(entity: INoteEntity) {
    if (suppressNextClick) {
        suppressNextClick = false;
        capturedClickAnnotationId = null;
        return;
    }
    surface.select([entity.identity.id]);
    surface.openNote(entity.identity.id);
}

function prepareTextBoxGeometryChange() {
    const id = editingId.value;
    if (id && newTextBoxIds.has(id) && textBoxRefs.get(id)?.getDraftText().trim().length === 0) {
        return;
    }
    commitActiveTextBoxDraftForSave();
}

function handleMoveStart(event: PointerEvent) {
    if (event.button !== 0) {
        return;
    }
    prepareTextBoxGeometryChange();
    const entity = selectedEntity.value;
    if (entity?.kind === 'text-box') {
        handleTextBoxPointerDown(entity, event, true);
    }
}

function handleResizeStart(handle: TAnnotationResizeHandle, event: PointerEvent) {
    clearClickSuppression();
    if (event.button !== 0) {
        return;
    }
    prepareTextBoxGeometryChange();
    const entity = selectedEntity.value;
    if (!entity || (entity.kind !== 'text-box' && entity.kind !== 'shape' && entity.kind !== 'placed-image')) {
        return;
    }
    if (editingId.value !== entity.identity.id) focusLayer();
    const point = pointFromEvent(event);
    if (!point) {
        return;
    }
    if (pointerGesture.beginResize(entity.identity.id, handle, point, event)) {
        surface.beginPointerInteraction(props.pageIndex);
        draggedAnnotationId.value = entity.identity.id;
        surface.select([entity.identity.id]);
        event.preventDefault();
        capturePointer(event);
    }
}

function handleSurfacePointerDown(event: PointerEvent) {
    clearClickSuppression();
    if (event.button !== 0) {
        return;
    }
    const wasEditingText = editingId.value !== null;
    focusLayer();
    const id = entityIdFromEvent(event);
    capturedClickAnnotationId = id;
    if (id) {
        const wasSelected = surface.selectedIds.value.has(id);
        if (!wasSelected || event.shiftKey) {
            surface.select([id], {additive: event.shiftKey});
        }
        if (!event.shiftKey) {
            const point = pointFromEvent(event);
            if (point && pointerGesture.beginMove(id, point, event)) {
                surface.beginPointerInteraction(props.pageIndex);
                draggedAnnotationId.value = id;
                event.preventDefault();
                capturePointer(event);
            }
        }
        return;
    }
    // A click outside the editor finishes the current text. Creation settings
    // can reset through a parent prop on the next render, so this same press
    // must not start another box with the previous tool value.
    if (wasEditingText) {
        surface.clearSelection();
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
    surface.beginPointerInteraction(props.pageIndex);
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
    if (shapeDraft.value && pointerGesture.start.value) {
        shapeDraft.value = creationTools.updateShape(shapeDraft.value, point, pointerGesture.start.value);
    }
    event.preventDefault();
}

function clearClickSuppression() {
    suppressNextClick = false;
}

function markClickSuppressed() {
    // The captured pointer sequence already completed the operation. Consume
    // its generated click once, even when Vue focuses the new editor first.
    // A new pointer or keyboard action clears this state before its handler.
    suppressNextClick = true;
}

function handlePointerUp(event: PointerEvent) {
    if (!pointerGesture.isActiveForPointer(event.pointerId)) {
        return;
    }
    const point = pointFromEvent(event);
    const resizeHandle = pointerGesture.resizeHandle.value;
    const completion = point ? pointerGesture.finish(point, event) : null;
    surface.endPointerInteraction(props.pageIndex);
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
    if (completion.hasMoved || completion.mode === 'create') {
        markClickSuppressed();
    }
    if (completion.mode === 'create') {
        if (!tool) {
            return;
        }
        if (isShapeTool(tool)) {
            const completedDraft = draft && point
                ? creationTools.updateShape(draft, point, completion.start)
                : draft;
            const created = completedDraft ? creationTools.finishShape(completedDraft) : null;
            if (created) {
                surface.createShape(created);
                // A completed shape remains unselected. Selecting it here makes
                // the pointer-up click reopen selection handles over the new
                // stroke, which breaks draw-tool repeat/delete flows.
                surface.completeCreation(tool);
            }
            return;
        }
        const rect = tool === 'note'
            ? completion.hasMoved ? completion.rect : markerRectFromPoint(completion.start.x, completion.start.y)
            : textPlacementRect(completion.start, completion.current, completion.hasMoved);
        if (!rect) {
            return;
        }
        const created = creationTools.create(tool, completion.pageIndex, rect, undefined, (360 - viewRotation.value) % 360 as ITextBoxEntity['rotation']);
        if (created) {
            if (created.kind === 'text-box') {
                newTextBoxIds.add(created.identity.id);
                if (!completion.hasMoved) {
                    autoSizeTextBoxIds.add(created.identity.id);
                }
                surface.beginTextEditing(created.identity.id);
            } else {
                surface.openNote(created.identity.id);
                surface.completeCreation(tool);
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
        const canonical = transformShapeToRect(completion.gesture.entity, completion.rect, completion.mode);
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
        const patch = completion.gesture.entity.kind === 'text-box' && completion.mode === 'resize'
            ? textResizeProposal(completion.gesture.entity, completion.rect, resizeHandle, completion.current)
            : {rect: completion.rect};
        if (
            completion.gesture.entity.kind === 'text-box'
            && annotationRectsEqual(completion.gesture.entity.rect, patch.rect)
            && (!('fontSize' in patch) || patch.fontSize === completion.gesture.entity.fontSize)
        ) {
            return;
        }
        if (completion.gesture.entity.kind === 'text-box' && completion.mode === 'resize') {
            autoSizeTextBoxIds.delete(completion.gesture.entity.identity.id);
        }
        surface.commitGesture(completion.gesture, patch);
    }
}

function handleLostPointerCapture(event: PointerEvent) {
    if (isReleasedMouseCapture(event)) {
        handlePointerUp(event);
    } else {
        handlePointerCancel(event);
    }
}

function handlePointerCancel(event: PointerEvent) {
    if (!pointerGesture.isActiveForPointer(event.pointerId)) {
        return;
    }
    releasePointer(event);
    cancelPointerGesture();
}

function cancelPointerGesture() {
    if (capturedPointerId !== null && layerRef.value?.hasPointerCapture?.(capturedPointerId)) {
        layerRef.value.releasePointerCapture(capturedPointerId);
    }
    capturedPointerId = null;
    pointerGesture.cancel();
    surface.endPointerInteraction(props.pageIndex);
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
    if (!id) {
        capturedClickAnnotationId = null;
        surface.clearSelection();
        return;
    }
    // A double-click may follow a pointer-captured click whose event target is
    // this layer rather than the child entity. Keep the identity until the
    // double-click handler consumes it or the next pointerdown replaces it.
    capturedClickAnnotationId = id;
    surface.select([id], {additive: event.shiftKey});
    const entity = entities.value.find(candidate => candidate.identity.id === id);
    if (entity?.kind === 'note') {
        if (suppressNextClick) {
            suppressNextClick = false;
            capturedClickAnnotationId = null;
            return;
        }
        surface.openNote(id);
    }
}

function handleSurfaceContextMenu(event: MouseEvent) {
    const id = entityIdFromEvent(event);
    if (!id) {
        return;
    }
    const entity = entities.value.find(candidate => candidate.identity.id === id);
    if (entity?.kind !== 'shape') {
        // Let the viewer's canonical comment handler build the context menu
        // for notes, text boxes, and markups. Shapes keep their dedicated
        // properties menu at this layer.
        return;
    }
    event.stopPropagation();
    surface.select([id], {additive: event.shiftKey});
    surface.openShapeContextMenu({
        shapeId: id,
        clientX: event.clientX,
        clientY: event.clientY,
    });
}

function handleSurfaceDblClick(event: MouseEvent) {
    const id = entityIdFromEvent(event) ?? textBoxIdAtPoint(event);
    const resolvedId = id ?? capturedClickAnnotationId;
    capturedClickAnnotationId = null;
    if (resolvedId) {
        const entity = entities.value.find(candidate => candidate.identity.id === resolvedId);
        if (entity?.kind === 'text-box') {
            beginTextBoxEdit(resolvedId, event);
        } else {
            surface.openNote(resolvedId);
        }
    }
}

function currentTextBox(annotationId: AnnotationId) {
    return entities.value.find((entity): entity is ITextBoxEntity => (
        entity.kind === 'text-box' && entity.identity.id === annotationId
    )) ?? null;
}

function commitTextBox(
    annotationId: AnnotationId,
    draft: {
        text: string;
        rect?: IAnnotationMarkerRect;
        restoreFocus?: boolean;
    },
) {
    if (editingId.value !== annotationId) {
        return;
    }
    const entity = currentTextBox(annotationId);
    if (!entity) {
        surface.clearTextBoxDraftPending(annotationId);
        newTextBoxIds.delete(annotationId);
        autoSizeTextBoxIds.delete(annotationId);
        surface.endTextEditing(annotationId, {restoreFocus: false});
        return;
    }
    if (newTextBoxIds.has(annotationId) && draft.text.trim().length === 0) {
        surface.discardUnsavedAnnotation(annotationId);
    } else {
        const rect = draft.rect;
        const textChanged = entity.text !== draft.text;
        const rectChanged = rect !== undefined && !annotationRectsEqual(entity.rect, rect);
        if (textChanged || rectChanged) {
            surface.commitGesture(annotationId, {
                ...(textChanged ? {text: draft.text} : {}),
                ...(rectChanged ? {rect} : {}),
            });
        }
    }
    const created = newTextBoxIds.has(annotationId) && draft.text.trim().length > 0;
    surface.clearTextBoxDraftPending(annotationId);
    newTextBoxIds.delete(annotationId);
    autoSizeTextBoxIds.delete(annotationId);
    surface.endTextEditing(annotationId, {
        created,
        restoreFocus: draft.restoreFocus ?? false,
    });
}

function cancelTextBox(annotationId: AnnotationId) {
    if (editingId.value !== annotationId) {
        return;
    }
    const entity = currentTextBox(annotationId);
    if (entity && newTextBoxIds.has(annotationId)) {
        surface.discardUnsavedAnnotation(annotationId);
    }
    surface.clearTextBoxDraftPending(annotationId);
    newTextBoxIds.delete(annotationId);
    autoSizeTextBoxIds.delete(annotationId);
    surface.endTextEditing(annotationId, {cancelled: true});
}

onBeforeUnmount(() => {
    if (editingId.value !== null) {
        textBoxRefs.get(editingId.value)?.commitDraft();
    }
    unregisterPageInteraction?.();
    unregisterPageInteraction = null;
    newTextBoxIds.forEach(annotationId => surface.discardUnsavedAnnotation(annotationId));
    newTextBoxIds.clear();
    autoSizeTextBoxIds.clear();
    textBoxRefs.clear();
    pointerGesture.cancel();
});
</script>
