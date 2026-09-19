import type { Ref } from 'vue';
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import type { usePdfAnnotationCommentModel } from '@app/modules/pdf-viewer/annotations/usePdfAnnotationCommentModel';
import type { usePdfShapeTool } from '@app/modules/pdf-viewer/tools/public';

type TPdfAnnotationCommentModel = ReturnType<typeof usePdfAnnotationCommentModel>;
type TPdfShapeTool = ReturnType<typeof usePdfShapeTool>;

interface IUsePdfAnnotationCommentActionsOptions {
    annotationCommentsCache: Ref<IAnnotationCommentSummary[]>;
    annotationCommentModel: TPdfAnnotationCommentModel;
    shapeTool: TPdfShapeTool;
    selectedShapeCommands: {deleteShapeById: (shapeId: string) => boolean;};
    commentCrud: {
        focusAnnotationComment: (comment: IAnnotationCommentSummary) => Promise<void>;
        deleteAnnotationComment: (comment: IAnnotationCommentSummary) => Promise<boolean>;
    };
    emitForcedAnnotationMutation: () => void;
}

export const usePdfAnnotationCommentActions = (options: IUsePdfAnnotationCommentActionsOptions) => {
    const {
        annotationCommentsCache,
        annotationCommentModel,
        shapeTool,
        selectedShapeCommands,
        commentCrud,
        emitForcedAnnotationMutation,
    } = options;

    async function deleteAnnotationComment(comment: IAnnotationCommentSummary) {
        if (comment.source === 'shape') {
            const shape = shapeTool.findShapeForAnnotationComment(comment);
            if (!shape) {
                return false;
            }
            if (!selectedShapeCommands.deleteShapeById(shape.id)) {
                return false;
            }
            annotationCommentModel.emitCommentsForSidebar(annotationCommentsCache.value);
            return true;
        }

        if (annotationCommentModel.isGracePreservedEditorOnlyComment(comment)) {
            annotationCommentModel.markLocallyDeleted(comment);
            emitForcedAnnotationMutation();
            return true;
        }

        const deleted = await commentCrud.deleteAnnotationComment(comment);
        if (deleted) {
            annotationCommentModel.markLocallyDeleted(comment);
        }
        return deleted;
    }

    return {
        focusAnnotationComment: commentCrud.focusAnnotationComment,
        deleteAnnotationComment,
    };
};
