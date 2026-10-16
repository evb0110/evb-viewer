import type { ComputedRef } from 'vue';
import type { AnnotationId } from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import type {
    IAnnotationGesture,
    IAnnotationEditorSurface,
} from '@app/modules/pdf-viewer/runtime/annotations/usePdfAnnotationEditorSurface';
import type { IAnnotationMarkerRect } from '@app/types/annotations';
import {
    annotationPageDimensions,
    clampAnnotationMoveDelta,
    resizeRotatedAnnotationRect,
    rotatedAnnotationBounds,
    createAnnotationRectFromPoints,

} from '@app/modules/pdf-viewer/engine/annotation-editor-geometry/annotationEditorGeometry';
import type {
    IAnnotationEditorPoint,
    TAnnotationResizeHandle,
} from '@app/modules/pdf-viewer/engine/annotation-editor-geometry/annotationEditorGeometry';
import { hasPointerMovedPastThreshold } from '@app/modules/pdf-viewer/engine/pdf-shape-overlay-interactions/hasPointerMovedPastThreshold';

interface IAnnotationPointerEvent {
    clientX: number;
    clientY: number;
    pointerId: number;
    pointerType?: string;
}

type TAnnotationPointerGestureMode = 'create' | 'move' | 'resize';

interface IActiveAnnotationPointerGesture {
    mode: TAnnotationPointerGestureMode;
    pageIndex: number;
    pointerId: number | null;
    start: IAnnotationEditorPoint;
    current: IAnnotationEditorPoint;
    startClient: IAnnotationPointerEvent;
    hasMoved: boolean;
    gesture?: IAnnotationGesture;
    handle?: TAnnotationResizeHandle;
    moveBounds?: ReadonlyArray<{
        id: AnnotationId;
        bounds: IAnnotationMarkerRect
    }>;
}

export interface IAnnotationPointerGestureCompletion {
    readonly mode: TAnnotationPointerGestureMode;
    readonly pageIndex: number;
    readonly pointerId: number;
    readonly start: IAnnotationEditorPoint;
    readonly current: IAnnotationEditorPoint;
    readonly gesture?: IAnnotationGesture;
    readonly rect: IAnnotationMarkerRect;
    readonly hasMoved: boolean;
}

export interface ITextSelectionPointerGesture {
    readonly start: IAnnotationPointerEvent;
    readonly hasMoved: boolean;
}

export interface IAnnotationPointerGesture {
    readonly isActive: ComputedRef<boolean>;
    readonly isTextSelecting: ComputedRef<boolean>;
    readonly textSelectionTouchAction: ComputedRef<'auto' | 'pan-x pinch-zoom' | 'pan-y pinch-zoom'>;
    readonly mode: ComputedRef<TAnnotationPointerGestureMode | null>;
    readonly resizeHandle: ComputedRef<TAnnotationResizeHandle | null>;
    readonly start: ComputedRef<IAnnotationEditorPoint | null>;
    readonly current: ComputedRef<IAnnotationEditorPoint | null>;
    readonly hasMoved: ComputedRef<boolean>;
    readonly previewRect: ComputedRef<IAnnotationMarkerRect | null>;
    readonly movingIds: ComputedRef<ReadonlySet<AnnotationId>>;
    readonly entity: IAnnotationGesture['entity'] | null;
    beginCreate(point: IAnnotationEditorPoint, event: IAnnotationPointerEvent): boolean;
    beginMove(annotationId: AnnotationId, point: IAnnotationEditorPoint, event: IAnnotationPointerEvent): boolean;
    beginResize(
        annotationId: AnnotationId,
        handle: TAnnotationResizeHandle,
        point: IAnnotationEditorPoint,
        event: IAnnotationPointerEvent,
    ): boolean;
    beginTextSelection(event: IAnnotationPointerEvent): boolean;
    updateTextSelection(event: IAnnotationPointerEvent): ITextSelectionPointerGesture | null;
    finishTextSelection(event: IAnnotationPointerEvent): ITextSelectionPointerGesture | null;
    update(point: IAnnotationEditorPoint, event: IAnnotationPointerEvent): boolean;
    isActiveForPointer(pointerId: number): boolean;
    finish(point: IAnnotationEditorPoint, event: IAnnotationPointerEvent): IAnnotationPointerGestureCompletion | null;
    cancel(gesture?: IAnnotationGesture): boolean;
}

interface IUseAnnotationPointerGestureOptions {
    surface: IAnnotationEditorSurface;
    pageIndex: number;
}

export function rectForMovableEntity(entity: IAnnotationGesture['entity']): IAnnotationMarkerRect | null {
    if (entity.kind === 'text-markup') {
        const left = Math.min(...entity.quadPoints.map(rect => rect.left));
        const top = Math.min(...entity.quadPoints.map(rect => rect.top));
        const right = Math.max(...entity.quadPoints.map(rect => rect.left + rect.width));
        const bottom = Math.max(...entity.quadPoints.map(rect => rect.top + rect.height));
        return {
            left,
            top,
            width: right - left,
            height: bottom - top,
        };
    }
    return entity.kind === 'note' ? entity.position : entity.rect;
}

export const useAnnotationPointerGesture = (
    options: IUseAnnotationPointerGestureOptions,
): IAnnotationPointerGesture => {
    const active = shallowRef<IActiveAnnotationPointerGesture | null>(null);
    const textSelection = shallowRef<{
        start: IAnnotationPointerEvent;
        hasMoved: boolean
    } | null>(null);
    const isTextSelecting = computed(() => textSelection.value !== null);
    const isVerticalText = computed(() => {
        const geometry = options.surface.getPageGeometry(options.pageIndex);
        return ((geometry?.rotation ?? 0) + (geometry?.viewRotation ?? 0)) % 180 !== 0;
    });
    // Chromium decides native touch ownership before pointerdown. Keep pan
    // across the text line and pinch available, reserving along-line drags.
    const textSelectionTouchAction = computed(() => options.surface.activeTool.value === 'none'
        ? isVerticalText.value ? 'pan-x pinch-zoom' : 'pan-y pinch-zoom'
        : 'auto');
    const isActive = computed(() => active.value?.pointerId != null);
    const mode = computed(() => active.value?.mode ?? null);
    const resizeHandle = computed(() => active.value?.handle ?? null);
    const start = computed(() => active.value?.start ?? null);
    const current = computed(() => active.value?.current ?? null);
    const hasMoved = computed(() => active.value?.hasMoved ?? false);
    const movingIds = computed(() => new Set(active.value?.moveBounds?.map(entry => entry.id)));
    function pageDimensions(pageIndex = options.pageIndex) {
        const geometry = options.surface.getPageGeometry(pageIndex);
        return annotationPageDimensions(geometry?.pageView, geometry?.rotation ?? 0);
    }
    const previewRect = computed(() => {
        const interaction = active.value;
        if (!interaction) {
            return null;
        }
        if (interaction.mode === 'create') {
            return createAnnotationRectFromPoints(interaction.start, interaction.current);
        }
        const rect = interaction.gesture
            ? rectForMovableEntity(interaction.gesture.entity)
            : null;
        if (!rect) {
            return null;
        }
        if (interaction.mode === 'move') {
            const delta = clampAnnotationMoveDelta(interaction.moveBounds?.map(entry => entry.bounds) ?? [rect], {
                x: interaction.current.x - interaction.start.x,
                y: interaction.current.y - interaction.start.y,
            });
            return {
                ...rect,
                left: rect.left + delta.x,
                top: rect.top + delta.y,
            };
        }
        return interaction.handle
            ? resizeRotatedAnnotationRect(rect, interaction.handle, interaction.current,
                interaction.gesture && 'rotation' in interaction.gesture.entity ? interaction.gesture.entity.rotation : 0, pageDimensions())
            : rect;
    });

    function matchesPointer(event: IAnnotationPointerEvent) {
        return active.value?.pointerId === event.pointerId;
    }

    function beginCreate(point: IAnnotationEditorPoint, event: IAnnotationPointerEvent) {
        if (isActive.value) {
            return false;
        }
        active.value = {
            mode: 'create',
            pageIndex: options.pageIndex,
            pointerId: event.pointerId,
            start: point,
            current: point,
            startClient: event,
            hasMoved: false,
        };
        return true;
    }

    function beginMove(annotationId: AnnotationId, point: IAnnotationEditorPoint, event: IAnnotationPointerEvent) {
        if (isActive.value) {
            return false;
        }
        const gesture = options.surface.beginMove(annotationId);
        if (!gesture) {
            return false;
        }
        active.value = {
            moveBounds: [...options.surface.entitiesByPage.value.values()].flat().filter(entity => options.surface.movingIds.value.has(entity.identity.id) || entity.identity.id === annotationId).flatMap(entity => {
                const bounds = rectForMovableEntity(options.surface.beginMove(entity.identity.id)?.entity ?? entity);
                return bounds ? [{
                    id: entity.identity.id,
                    bounds: rotatedAnnotationBounds(bounds, 'rotation' in entity ? entity.rotation : 0, pageDimensions(entity.pageIndex)),
                }] : [];
            }),
            mode: 'move',
            pageIndex: options.pageIndex,
            pointerId: event.pointerId,
            start: point,
            current: point,
            startClient: event,
            hasMoved: false,
            gesture,
        };
        return true;
    }

    function beginResize(
        annotationId: AnnotationId,
        handle: TAnnotationResizeHandle,
        point: IAnnotationEditorPoint,
        event: IAnnotationPointerEvent,
    ) {
        if (isActive.value) {
            return false;
        }
        const gesture = options.surface.beginResize(annotationId);
        if (!gesture) {
            return false;
        }
        active.value = {
            mode: 'resize',
            pageIndex: options.pageIndex,
            pointerId: event.pointerId,
            start: point,
            current: point,
            startClient: event,
            hasMoved: false,
            gesture,
            handle,
        };
        return true;
    }

    function update(point: IAnnotationEditorPoint, event: IAnnotationPointerEvent) {
        if (!matchesPointer(event)) {
            return false;
        }
        active.value = {
            ...active.value!,
            current: point,
            hasMoved: active.value!.hasMoved || hasPointerMovedPastThreshold(active.value!.startClient, event, 6),
        };
        return true;
    }

    function beginTextSelection(event: IAnnotationPointerEvent) {
        if (isActive.value || textSelection.value) {
            return false;
        }
        textSelection.value = {
            start: event,
            hasMoved: false,
        };
        return true;
    }

    function updateTextSelection(event: IAnnotationPointerEvent): ITextSelectionPointerGesture | null {
        if (textSelection.value?.start.pointerId !== event.pointerId) {
            return null;
        }
        const start = textSelection.value.start;
        const dx = Math.abs(event.clientX - start.clientX);
        const dy = Math.abs(event.clientY - start.clientY);
        textSelection.value.hasMoved ||= hasPointerMovedPastThreshold(start, event, 6)
            && (start.pointerType !== 'touch' || (isVerticalText.value ? dy > dx : dx > dy));
        return {
            start: textSelection.value.start,
            hasMoved: textSelection.value.hasMoved,
        };
    }

    function finishTextSelection(event: IAnnotationPointerEvent): ITextSelectionPointerGesture | null {
        const gesture = updateTextSelection(event);
        if (gesture) textSelection.value = null;
        return gesture;
    }

    function finish(point: IAnnotationEditorPoint, event: IAnnotationPointerEvent) {
        if (!matchesPointer(event)) {
            return null;
        }
        update(point, event);
        const interaction = active.value!;
        const rect = previewRect.value;
        if (!rect) {
            active.value = null;
            return null;
        }
        const completion: IAnnotationPointerGestureCompletion = {
            mode: interaction.mode,
            pageIndex: interaction.pageIndex,
            pointerId: event.pointerId,
            start: interaction.start,
            current: interaction.current,
            rect,
            hasMoved: interaction.hasMoved,
            ...(interaction.gesture ? {gesture: interaction.gesture} : {}),
        };
        active.value = interaction.gesture ? {
            ...interaction,
            pointerId: null,
        } : null;
        return completion;
    }

    function cancel(gesture?: IAnnotationGesture) {
        if (gesture && active.value?.gesture !== gesture) return false;
        active.value = null;
        if (!gesture) textSelection.value = null;
        return true;
    }

    onScopeDispose(cancel);

    return {
        isActive,
        isTextSelecting,
        textSelectionTouchAction,
        mode,
        resizeHandle,
        start,
        current,
        hasMoved,
        previewRect,
        movingIds,
        get entity() {return active.value?.gesture?.entity ?? null;},
        beginCreate,
        beginMove,
        beginResize,
        beginTextSelection,
        updateTextSelection,
        finishTextSelection,
        update,
        isActiveForPointer: pointerId => active.value?.pointerId === pointerId,
        finish,
        cancel,
    };
};
