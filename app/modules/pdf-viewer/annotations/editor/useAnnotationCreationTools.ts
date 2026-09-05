import type {
    IPlacedImageEntity,
    INoteEntity,
    IShapeEntity,
    ITextBoxEntity,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import {asAnnotationId} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import type { IAnnotationEditorSurface } from '@app/modules/pdf-viewer/runtime/annotations/usePdfAnnotationEditorSurface';
import type {
    IAnnotationMarkerRect,
    IShapeAnnotation,
    TAnnotationTool,
    TDrawableShapeType,
} from '@app/types/annotations';
import {DEFAULT_ANNOTATION_SETTINGS} from '@app/constants/annotationDefaults';
import {
    createDrawingShape,
    isDrawableFinishedShape,
    updateDrawingShapeForPoint,
} from '@app/modules/pdf-viewer/tools/annotationShapeDrawing';
import {toCanonicalShapeEntity} from '@app/modules/pdf-viewer/annotations/annotationApplication';

interface IUseAnnotationCreationToolsOptions {surface: IAnnotationEditorSurface;}

export interface IAnnotationCreationTools {
    create(
        tool: TAnnotationTool,
        pageIndex: number,
        rect: IAnnotationMarkerRect,
        stampImage?: IPlacedImageEntity['image'],
    ): ITextBoxEntity | INoteEntity | IPlacedImageEntity | null;
    beginShape(pageIndex: number, tool: TDrawableShapeType, point: {
        x: number;
        y: number
    }): IShapeAnnotation | null;
    updateShape(draft: IShapeAnnotation, point: {
        x: number;
        y: number
    }): IShapeAnnotation;
    finishShape(draft: IShapeAnnotation): IShapeEntity | null;
}

export const useAnnotationCreationTools = (
    options: IUseAnnotationCreationToolsOptions,
): IAnnotationCreationTools => ({
    create(tool, pageIndex, rect, stampImage) {
        if (tool === 'text') {
            const entity = options.surface.createTextBoxAt(pageIndex, rect);
            options.surface.select([entity.identity.id]);
            return entity;
        }

        if (tool === 'note') {
            const entity = options.surface.createNoteAt(pageIndex, rect);
            options.surface.select([entity.identity.id]);
            return entity;
        }

        if (tool === 'stamp' && stampImage) {
            const entity = options.surface.createStampAt(pageIndex, rect, stampImage);
            options.surface.select([entity.identity.id]);
            return entity;
        }

        return null;
    },
    beginShape(pageIndex, tool, point) {
        const settings = options.surface.settings.value ?? DEFAULT_ANNOTATION_SETTINGS;
        return createDrawingShape(pageIndex, tool, point.x, point.y, settings);
    },
    updateShape(draft, point) {
        const rawDraft = toRaw(draft);
        return updateDrawingShapeForPoint(rawDraft, {
            x: rawDraft.x,
            y: rawDraft.y,
        }, point.x, point.y);
    },
    finishShape(draft) {
        if (!isDrawableFinishedShape(draft)) {
            return null;
        }
        return toCanonicalShapeEntity(toRaw(draft), asAnnotationId(draft.id));
    },
});
