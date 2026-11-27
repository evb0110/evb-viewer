import type {IShapePoint, TDrawableShapeType} from '@app/types/annotations';

export interface IShapeAnnotationConstructionOptions {
    tool: TDrawableShapeType;
    x: number;
    y: number;
    width?: number | undefined;
    height?: number | undefined;
    x2?: number | undefined;
    y2?: number | undefined;
    points?: IShapePoint[] | undefined;
    strokes?: IShapePoint[][] | undefined;
    color?: string | undefined;
    fillColor?: string | null | undefined;
    opacity?: number | undefined;
    strokeWidth?: number | undefined;
}
