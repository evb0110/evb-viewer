import {
    computed,
    provide,
    type ComputedRef,
} from 'vue';
import type {
    IAnnotationSettings,
    TAnnotationTool,
    TShapeType,
} from '@app/types/annotations';
import {
    isShapeTool,
    type IShapeContextProvide,
    type TUseAnnotationShapesReturn,
} from '@app/composables/pdf/useAnnotationShapes';
import { DEFAULT_ANNOTATION_SETTINGS } from '@app/constants/annotation-defaults';

interface IShapeContextMenuPayload {
    shapeId: string;
    clientX: number;
    clientY: number;
}

interface IUsePdfShapeContextDeps {
    shapeComposable: TUseAnnotationShapesReturn;
    annotationTool: ComputedRef<TAnnotationTool>;
    annotationSettings: ComputedRef<IAnnotationSettings | null>;
    onAnnotationModified: () => void;
    onShapeContextMenu: (payload: IShapeContextMenuPayload) => void;
}

export const usePdfShapeContext = (deps: IUsePdfShapeContextDeps) => {
    const {
        shapeComposable,
        annotationTool,
        annotationSettings,
        onAnnotationModified,
        onShapeContextMenu,
    } = deps;

    const isShapeToolActive = computed(() => isShapeTool(annotationTool.value));
    const activeShapeTool = computed<TShapeType | null>(() => isShapeTool(annotationTool.value) ? annotationTool.value : null);

    provide<IShapeContextProvide>('shapeContext', {
        selectedShapeId: shapeComposable.selectedShapeId,
        drawingShape: shapeComposable.drawingShape,
        isShapeToolActive,
        activeShapeTool,
        settings: computed(() => annotationSettings.value ?? DEFAULT_ANNOTATION_SETTINGS),
        getShapesForPage: shapeComposable.getShapesForPage,
        handleStartDrawing(pageIndex: number, coords: {
            x: number;
            y: number
        }) {
            const tool = activeShapeTool.value;
            if (!tool) {
                return;
            }
            const settings = annotationSettings.value;
            if (!settings) {
                return;
            }
            shapeComposable.startDrawing(pageIndex, tool, coords.x, coords.y, settings);
        },
        handleContinueDrawing(coords: {
            x: number;
            y: number
        }) {
            shapeComposable.continueDrawing(coords.x, coords.y);
        },
        handleFinishDrawing() {
            const shape = shapeComposable.finishDrawing();
            if (shape) {
                onAnnotationModified();
            }
        },
        handleSelectShape(id: string | null) {
            shapeComposable.selectShape(id);
        },
        handleShapeContextMenu(payload: IShapeContextMenuPayload) {
            shapeComposable.selectShape(payload.shapeId);
            onShapeContextMenu(payload);
        },
    });

    return {
        isShapeToolActive,
        activeShapeTool,
    };
};
