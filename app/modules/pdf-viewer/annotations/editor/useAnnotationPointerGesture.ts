import type { ComputedRef } from 'vue';
import type {
    AnnotationId,
    INoteEntity,
    ITextBoxEntity,
    IShapeEntity,
    IPlacedImageEntity,
    ITextMarkupEntity,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import type {
    IAnnotationGesture,
    IAnnotationEditorSurface,
} from '@app/modules/pdf-viewer/runtime/annotations/usePdfAnnotationEditorSurface';
import type { IAnnotationMarkerRect } from '@app/types/annotations';
import {
    applyAnnotationHandleResize,
    createAnnotationRectFromPoints,
    moveAnnotationRect,
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
}

type TAnnotationPointerGestureMode = 'create' | 'move' | 'resize';

interface IActiveAnnotationPointerGesture {
    mode: TAnnotationPointerGestureMode;
    pageIndex: number;
    pointerId: number;
    start: IAnnotationEditorPoint;
    current: IAnnotationEditorPoint;
    startClient: IAnnotationPointerEvent;
    gesture?: IAnnotationGesture;
    handle?: TAnnotationResizeHandle;
}

export interface IAnnotationPointerGestureCompletion {
    readonly mode: TAnnotationPointerGestureMode;
    readonly pageIndex: number;
    readonly pointerId: number;
    readonly start: IAnnotationEditorPoint;
    readonly gesture?: IAnnotationGesture;
    readonly rect: IAnnotationMarkerRect;
    readonly hasMoved: boolean;
}

export interface IAnnotationPointerGesture {
    readonly isActive: ComputedRef<boolean>;
    readonly previewRect: ComputedRef<IAnnotationMarkerRect | null>;
    beginCreate(point: IAnnotationEditorPoint, event: IAnnotationPointerEvent): boolean;
    beginMove(annotationId: AnnotationId, point: IAnnotationEditorPoint, event: IAnnotationPointerEvent): boolean;
    beginResize(
        annotationId: AnnotationId,
        handle: TAnnotationResizeHandle,
        point: IAnnotationEditorPoint,
        event: IAnnotationPointerEvent,
    ): boolean;
    update(point: IAnnotationEditorPoint, event: IAnnotationPointerEvent): boolean;
    isActiveForPointer(pointerId: number): boolean;
    finish(point: IAnnotationEditorPoint, event: IAnnotationPointerEvent): IAnnotationPointerGestureCompletion | null;
    cancel(): void;
}

interface IUseAnnotationPointerGestureOptions {
    surface: IAnnotationEditorSurface;
    pageIndex: number;
}

function isMovableEntity(
    entity: IAnnotationGesture['entity'],
): entity is ITextBoxEntity | INoteEntity | IShapeEntity | IPlacedImageEntity | ITextMarkupEntity {
    return entity.kind === 'text-box' || entity.kind === 'note' || entity.kind === 'shape'
        || entity.kind === 'placed-image' || entity.kind === 'text-markup';
}

export function rectForMovableEntity(entity: IAnnotationGesture['entity']): IAnnotationMarkerRect | null {
    if (entity.kind === 'text-box') {
        return entity.rect;
    }
    if (entity.kind === 'note') {
        return entity.position;
    }
    if (entity.kind === 'shape') {
        return entity.rect;
    }
    if (entity.kind === 'placed-image') {
        return entity.rect;
    }
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
    return null;
}

export const useAnnotationPointerGesture = (
    options: IUseAnnotationPointerGestureOptions,
): IAnnotationPointerGesture => {
    const active = shallowRef<IActiveAnnotationPointerGesture | null>(null);
    const isActive = computed(() => active.value !== null);
    const previewRect = computed(() => {
        const interaction = active.value;
        if (!interaction) {
            return null;
        }
        if (interaction.mode === 'create') {
            return createAnnotationRectFromPoints(interaction.start, interaction.current);
        }
        const rect = interaction.gesture && isMovableEntity(interaction.gesture.entity)
            ? rectForMovableEntity(interaction.gesture.entity)
            : null;
        if (!rect) {
            return null;
        }
        if (interaction.mode === 'move') {
            return moveAnnotationRect(
                rect,
                interaction.current.x - interaction.start.x,
                interaction.current.y - interaction.start.y,
            );
        }
        return interaction.handle
            ? applyAnnotationHandleResize(rect, interaction.handle, interaction.current)
            : rect;
    });

    function matchesPointer(event: IAnnotationPointerEvent) {
        return active.value?.pointerId === event.pointerId;
    }

    function beginCreate(point: IAnnotationEditorPoint, event: IAnnotationPointerEvent) {
        if (active.value) {
            return false;
        }
        active.value = {
            mode: 'create',
            pageIndex: options.pageIndex,
            pointerId: event.pointerId,
            start: point,
            current: point,
            startClient: event,
        };
        return true;
    }

    function beginMove(annotationId: AnnotationId, point: IAnnotationEditorPoint, event: IAnnotationPointerEvent) {
        if (active.value) {
            return false;
        }
        const gesture = options.surface.beginMove(annotationId);
        if (!gesture || !isMovableEntity(gesture.entity)) {
            return false;
        }
        active.value = {
            mode: 'move',
            pageIndex: options.pageIndex,
            pointerId: event.pointerId,
            start: point,
            current: point,
            startClient: event,
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
        if (active.value) {
            return false;
        }
        const gesture = options.surface.beginResize(annotationId);
        if (!gesture || !isMovableEntity(gesture.entity)) {
            return false;
        }
        active.value = {
            mode: 'resize',
            pageIndex: options.pageIndex,
            pointerId: event.pointerId,
            start: point,
            current: point,
            startClient: event,
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
        };
        return true;
    }

    function finish(point: IAnnotationEditorPoint, event: IAnnotationPointerEvent) {
        if (!matchesPointer(event)) {
            return null;
        }
        update(point, event);
        const interaction = active.value;
        if (!interaction) {
            return null;
        }
        const rect = previewRect.value;
        if (!rect) {
            active.value = null;
            return null;
        }
        const completion: IAnnotationPointerGestureCompletion = {
            mode: interaction.mode,
            pageIndex: interaction.pageIndex,
            pointerId: interaction.pointerId,
            start: interaction.start,
            rect,
            hasMoved: hasPointerMovedPastThreshold(interaction.startClient, event, 6),
            ...(interaction.gesture ? {gesture: interaction.gesture} : {}),
        };
        active.value = null;
        return completion;
    }

    function cancel() {
        active.value = null;
    }

    onScopeDispose(cancel);

    return {
        isActive,
        previewRect,
        beginCreate,
        beginMove,
        beginResize,
        update,
        isActiveForPointer: pointerId => active.value?.pointerId === pointerId,
        finish,
        cancel,
    };
};
