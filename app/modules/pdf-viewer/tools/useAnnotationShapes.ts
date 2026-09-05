import type {
    ComputedRef,
    Ref,
    ShallowRef,
} from 'vue';
import type {
    IAnnotationSettings,
    IShapeAnnotation,
    TDrawableShapeType,
    TShapeResizeHandle,
} from '@app/types/annotations';
import type { AnnotationApplication } from '@app/modules/pdf-viewer/annotations/annotationApplication';
import {toLegacyShapeAnnotation} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import type { IShapeEntity } from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import { cloneShape } from '@app/modules/pdf-viewer/engine/shapes/cloneShape';
import {
    buildShapeAnnotation,
    createDrawingShape,
    isDrawableFinishedShape,
    updateDrawingShapeForPoint,
} from '@app/modules/pdf-viewer/tools/annotationShapeDrawing';

export interface IShapeContextProvide {
    selectedShapeId: Ref<string | null>;
    focusedShapeId: Ref<string | null>;
    drawingShape: Ref<IShapeAnnotation | null>;
    isShapeToolActive: ComputedRef<boolean>;
    isAnyAnnotationToolActive: ComputedRef<boolean>;
    isSelectionToolActive: ComputedRef<boolean>;
    activeShapeTool: ComputedRef<TDrawableShapeType | null>;
    settings: Ref<IAnnotationSettings>;
    getShapesForPage: (pageIndex: number) => IShapeAnnotation[];
    handleStartDrawing: (pageIndex: number, coords: {
        x: number;
        y: number
    }) => void;
    handleContinueDrawing: (coords: {
        x: number;
        y: number
    }) => void;
    handleFinishDrawing: () => void;
    handleSelectShape: (id: string | null) => void;
    handleStartDraggingShape: (shapeId: string, coords: {
        x: number;
        y: number
    }) => void;
    handleContinueDraggingShape: (coords: {
        x: number;
        y: number
    }) => void;
    handleFinishDraggingShape: () => void;
    handleStartResizingShape: (shapeId: string, handle: TShapeResizeHandle, coords: {
        x: number;
        y: number
    }) => void;
    handleContinueResizingShape: (coords: {
        x: number;
        y: number
    }) => void;
    handleFinishResizingShape: () => void;
    handleShapeContextMenu: (payload: {
        shapeId: string;
        clientX: number;
        clientY: number;
    }) => void;
}

interface IUseAnnotationShapesOptions {annotationApplication: ShallowRef<AnnotationApplication>;}

/**
 * Renders the canonical shapes `AnnotationStore` owns and forwards drawing and
 * import intents back to it. It holds no shape map, tombstone set or saved
 * baseline of its own: the only state here is transient drawing/selection UI,
 * plus a cache of the last store emission so Vue can depend on it.
 */
export const useAnnotationShapes = ({annotationApplication}: IUseAnnotationShapesOptions) => {
    const selectedShapeId = ref<string | null>(null);
    const focusedShapeId = ref<string | null>(null);
    const drawingShape = ref<IShapeAnnotation | null>(null);
    const isDrawing = ref(false);
    const shapeEntities = shallowRef<readonly IShapeEntity[]>([]);
    let drawOrigin: {
        x: number;
        y: number
    } | null = null;

    function projectCanonicalShapes() {
        const entities = annotationApplication.value.store.list({includeDeleted: true})
            .filter((entity): entity is IShapeEntity => entity.kind === 'shape');
        shapeEntities.value = entities;
        const liveIds = new Set(entities.filter(entity => !entity.deleted).map(entity => projectShape(entity).id));
        if (selectedShapeId.value && !liveIds.has(selectedShapeId.value)) {
            selectedShapeId.value = null;
        }
        if (focusedShapeId.value && !liveIds.has(focusedShapeId.value)) {
            focusedShapeId.value = null;
        }
    }

    let stopProjection: (() => void) | null = null;
    watch(annotationApplication, (application) => {
        stopProjection?.();
        stopProjection = application.store.subscribe(projectCanonicalShapes);
    }, {
        immediate: true,
        flush: 'sync',
    });
    onScopeDispose(() => stopProjection?.());

    function projectShape(entity: IShapeEntity) {
        const shape = toLegacyShapeAnnotation(entity);
        return entity.identity.pdfRef
            ? {
                ...shape,
                source: 'embedded' as const,
            }
            : {
                ...shape,
                source: 'local' as const,
            };
    }

    const liveShapes = computed(() => shapeEntities.value
        .filter(entity => !entity.deleted)
        .map(projectShape));
    const tombstones = computed(() => shapeEntities.value
        .filter(entity => entity.deleted)
        .filter(entity => entity.identity.pdfRef !== undefined || entity.materialized === true)
        .map(projectShape));

    const shapesByPage = computed(() => {
        const byPage = new Map<number, IShapeAnnotation[]>();
        liveShapes.value.forEach((shape) => {
            const pageShapes = byPage.get(shape.pageIndex);
            if (pageShapes) {
                pageShapes.push(shape);
                return;
            }
            byPage.set(shape.pageIndex, [shape]);
        });
        return byPage;
    });

    const deletedEmbeddedAnnotationIds = computed(() => new Set(
        tombstones.value
            .map(shape => shape.annotationId)
            .filter((annotationId): annotationId is string => Boolean(annotationId)),
    ));
    const deletedEmbeddedShapeStableKeys = computed(() => new Set(
        tombstones.value
            .map(shape => shape.stableKey)
            .filter((stableKey): stableKey is string => Boolean(stableKey)),
    ));
    const hasShapes = computed(() => shapeEntities.value.some(entity => !entity.deleted));

    function getShapesForPage(pageIndex: number): IShapeAnnotation[] {
        return shapesByPage.value.get(pageIndex) ?? [];
    }

    function getAllShapes(): IShapeAnnotation[] {
        return liveShapes.value.map(shape => structuredClone(shape));
    }

    function getShapeById(id: string): IShapeAnnotation | null {
        return liveShapes.value.find(shape => shape.id === id) ?? null;
    }

    function getDeletedEmbeddedAnnotationIds() {
        return [...deletedEmbeddedAnnotationIds.value];
    }

    function getDeletedEmbeddedShapeStableKeys() {
        return [...deletedEmbeddedShapeStableKeys.value];
    }

    function clearShapes() {
        selectedShapeId.value = null;
        focusedShapeId.value = null;
        resetDrawingState();
    }

    function selectShape(id: string | null) {
        selectedShapeId.value = id;
        focusedShapeId.value = null;
    }

    function focusShape(id: string | null) {
        focusedShapeId.value = id && getShapeById(id) ? id : null;
        selectedShapeId.value = null;
    }

    function resetDrawingState() {
        isDrawing.value = false;
        drawingShape.value = null;
        drawOrigin = null;
    }

    function startDrawing(
        pageIndex: number,
        tool: TDrawableShapeType,
        x: number,
        y: number,
        settings: IAnnotationSettings,
    ) {
        selectedShapeId.value = null;
        focusedShapeId.value = null;
        drawOrigin = {
            x,
            y,
        };
        drawingShape.value = createDrawingShape(pageIndex, tool, x, y, settings);
        isDrawing.value = true;
    }

    function continueDrawing(x: number, y: number) {
        if (!drawingShape.value || !isDrawing.value || !drawOrigin) {
            return;
        }

        drawingShape.value = updateDrawingShapeForPoint(drawingShape.value, drawOrigin, x, y);
    }

    /** Returns the finished draft; the shape enters the store through its creator. */
    function finishDrawing() {
        if (!drawingShape.value || !isDrawing.value) {
            return null;
        }

        const shape = cloneShape({
            ...drawingShape.value,
            modifiedAt: Date.now(),
        });
        resetDrawingState();
        return isDrawableFinishedShape(shape) ? shape : null;
    }

    return {
        selectedShapeId,
        focusedShapeId,
        drawingShape,
        hasShapes,
        getShapesForPage,
        getAllShapes,
        getShapeById,
        getDeletedEmbeddedAnnotationIds,
        getDeletedEmbeddedShapeStableKeys,
        deletedEmbeddedShapeStableKeys,
        selectShape,
        focusShape,
        clearShapes,
        buildShapeAnnotation,
        startDrawing,
        continueDrawing,
        finishDrawing,
    };
};

export type TUseAnnotationShapesReturn = ReturnType<typeof useAnnotationShapes>;
