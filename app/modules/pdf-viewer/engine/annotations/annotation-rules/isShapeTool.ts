import {DRAWABLE_SHAPE_TOOLS, type TAnnotationTool, type TDrawableShapeType} from '@app/types/annotations';
import {isOneOf} from '@contracts/runtimeGuards';

export function isShapeTool(tool: TAnnotationTool): tool is TDrawableShapeType {
    return isOneOf(DRAWABLE_SHAPE_TOOLS, tool);
}
