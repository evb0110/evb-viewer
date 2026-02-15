import {
    ref,
    computed,
} from 'vue';
import type {
    Ref,
    ComputedRef,
} from 'vue';
import type {
    IShapeAnnotation,
    TShapeType,
    TAnnotationTool,
    IAnnotationSettings,
} from '@app/types/annotations';

let shapeIdCounter = 0;

function generateShapeId() {
    shapeIdCounter += 1;
    return `shape-${Date.now()}-${shapeIdCounter}`;
}

export function isShapeTool(tool: TAnnotationTool): tool is TShapeType {
    return tool === 'rectangle' || tool === 'circle' || tool === 'line' || tool === 'arrow';
}

export interface IShapeContextProvide {
    selectedShapeId: Ref<string | null>;
    drawingShape: Ref<IShapeAnnotation | null>;
    isShapeToolActive: ComputedRef<boolean>;
    activeShapeTool: ComputedRef<TShapeType | null>;
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
    handleShapeContextMenu: (payload: {
        shapeId: string;
        clientX: number;
        clientY: number;
    }) => void;
}

export const useAnnotationShapes = () => {
    const shapes = ref<Map<number, IShapeAnnotation[]>>(new Map());
    const selectedShapeId = ref<string | null>(null);
    const drawingShape = ref<IShapeAnnotation | null>(null);
    const isDrawing = ref(false);
    let drawOrigin: {
        x: number;
        y: number 
    } | null = null;

    function getShapesForPage(pageIndex: number) {
        return shapes.value.get(pageIndex) ?? [];
    }

    function getAllShapes() {
        const all: IShapeAnnotation[] = [];
        for (const pageShapes of shapes.value.values()) {
            all.push(...pageShapes);
        }
        return all;
    }

    function getShapeById(id: string) {
        for (const pageShapes of shapes.value.values()) {
            const shape = pageShapes.find(s => s.id === id);
            if (shape) {
                return shape;
            }
        }
        return null;
    }

    function addShape(shape: IShapeAnnotation) {
        const pageShapes = shapes.value.get(shape.pageIndex) ?? [];
        pageShapes.push(shape);
        shapes.value.set(shape.pageIndex, pageShapes);
        shapes.value = new Map(shapes.value);
    }

    function updateShape(id: string, updates: Partial<IShapeAnnotation>) {
        for (const [
            pageIndex,
            pageShapes,
        ] of shapes.value.entries()) {
            const index = pageShapes.findIndex(s => s.id === id);
            if (index !== -1) {
                pageShapes[index] = {
                    ...pageShapes[index]!,
                    ...updates, 
                };
                shapes.value.set(pageIndex, [...pageShapes]);
                shapes.value = new Map(shapes.value);
                return;
            }
        }
    }

    function deleteShape(id: string) {
        for (const [
            pageIndex,
            pageShapes,
        ] of shapes.value.entries()) {
            const index = pageShapes.findIndex(s => s.id === id);
            if (index !== -1) {
                pageShapes.splice(index, 1);
                shapes.value.set(pageIndex, [...pageShapes]);
                shapes.value = new Map(shapes.value);
                if (selectedShapeId.value === id) {
                    selectedShapeId.value = null;
                }
                return;
            }
        }
    }

    function deleteSelectedShape() {
        if (selectedShapeId.value) {
            deleteShape(selectedShapeId.value);
        }
    }

    function selectShape(id: string | null) {
        selectedShapeId.value = id;
    }

    function clearShapes() {
        shapes.value = new Map();
        selectedShapeId.value = null;
        drawingShape.value = null;
        isDrawing.value = false;
        drawOrigin = null;
    }

    function loadShapes(loaded: IShapeAnnotation[]) {
        const grouped = new Map<number, IShapeAnnotation[]>();
        for (const shape of loaded) {
            const pageShapes = grouped.get(shape.pageIndex) ?? [];
            pageShapes.push(shape);
            grouped.set(shape.pageIndex, pageShapes);
        }
        shapes.value = grouped;
    }

    function startDrawing(
        pageIndex: number,
        tool: TShapeType,
        x: number,
        y: number,
        settings: IAnnotationSettings,
    ) {
        selectedShapeId.value = null;
        drawOrigin = {
            x,
            y, 
        };
        const shape: IShapeAnnotation = {
            id: generateShapeId(),
            type: tool,
            pageIndex,
            x,
            y,
            width: 0,
            height: 0,
            x2: tool === 'line' || tool === 'arrow' ? x : undefined,
            y2: tool === 'line' || tool === 'arrow' ? y : undefined,
            color: settings.shapeColor,
            fillColor: settings.shapeFillColor === 'transparent' ? undefined : settings.shapeFillColor,
            opacity: settings.shapeOpacity,
            strokeWidth: settings.shapeStrokeWidth,
            lineEndStyle: tool === 'arrow' ? 'closedArrow' : undefined,
        };
        drawingShape.value = shape;
        isDrawing.value = true;
    }

    function continueDrawing(x: number, y: number) {
        if (!drawingShape.value || !isDrawing.value || !drawOrigin) {
            return;
        }

        const shape = drawingShape.value;
        if (shape.type === 'line' || shape.type === 'arrow') {
            drawingShape.value = {
                ...shape,
                x2: x,
                y2: y, 
            };
        } else {
            const minX = Math.min(drawOrigin.x, x);
            const minY = Math.min(drawOrigin.y, y);
            const maxX = Math.max(drawOrigin.x, x);
            const maxY = Math.max(drawOrigin.y, y);
            drawingShape.value = {
                ...shape,
                x: minX,
                y: minY,
                width: maxX - minX,
                height: maxY - minY,
            };
        }
    }

    function finishDrawing() {
        if (!drawingShape.value || !isDrawing.value) {
            return null;
        }

        const shape = drawingShape.value;
        isDrawing.value = false;
        drawingShape.value = null;
        drawOrigin = null;

        const isLineLike = shape.type === 'line' || shape.type === 'arrow';
        if (isLineLike) {
            const dx = (shape.x2 ?? shape.x) - shape.x;
            const dy = (shape.y2 ?? shape.y) - shape.y;
            if (Math.hypot(dx, dy) < 0.005) {
                return null;
            }
        } else {
            if (shape.width < 0.005 || shape.height < 0.005) {
                return null;
            }
        }

        addShape(shape);
        selectedShapeId.value = shape.id;
        return shape;
    }

    function cancelDrawing() {
        isDrawing.value = false;
        drawingShape.value = null;
        drawOrigin = null;
    }

    const hasShapes = computed(() => {
        for (const pageShapes of shapes.value.values()) {
            if (pageShapes.length > 0) {
                return true;
            }
        }
        return false;
    });

    return {
        shapes,
        selectedShapeId,
        drawingShape,
        isDrawing,
        hasShapes,
        isShapeTool,
        getShapesForPage,
        getAllShapes,
        getShapeById,
        addShape,
        updateShape,
        deleteShape,
        deleteSelectedShape,
        selectShape,
        clearShapes,
        loadShapes,
        startDrawing,
        continueDrawing,
        finishDrawing,
        cancelDrawing,
    };
};

export type TUseAnnotationShapesReturn = ReturnType<typeof useAnnotationShapes>;
