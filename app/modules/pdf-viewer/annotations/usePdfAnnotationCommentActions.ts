import { requirePageNumber } from '@contracts/pageNumbers';
import type { TPageNumber } from '@contracts/pageNumbers';

import type { Ref } from 'vue';
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import { annotationIdForSummary } from '@app/modules/pdf-viewer/engine/annotations/domain/annotationSummaryIdentity';
import type { usePdfAnnotationCommentModel } from '@app/modules/pdf-viewer/annotations/usePdfAnnotationCommentModel';
import type { usePdfShapeTool } from '@app/modules/pdf-viewer/tools/public';

type TPdfAnnotationCommentModel = ReturnType<typeof usePdfAnnotationCommentModel>;
type TPdfShapeTool = ReturnType<typeof usePdfShapeTool>;

interface IUsePdfAnnotationCommentActionsOptions {
    numPages: Ref<number>;
    activeCommentStableKey: Ref<string | null>;
    annotationCommentsCache: Ref<IAnnotationCommentSummary[]>;
    annotationCommentModel: TPdfAnnotationCommentModel;
    shapeTool: TPdfShapeTool;
    shapeComposable: {focusShape: (shapeId: string | null) => void;};
    selectedShapeCommands: {deleteShapeById: (shapeId: string) => boolean;};
    commentCrud: {
        focusAnnotationComment: (comment: IAnnotationCommentSummary) => Promise<void>;
        deleteAnnotationComment: (comment: IAnnotationCommentSummary) => Promise<boolean>;
    };
    scrollToPage: (pageNumber: TPageNumber, options?: { markerRect?: IAnnotationCommentSummary['markerRect'] }) => void;
    emitForcedAnnotationMutation: () => void;
}

export const usePdfAnnotationCommentActions = (options: IUsePdfAnnotationCommentActionsOptions) => {
    const {
        numPages,
        activeCommentStableKey,
        annotationCommentsCache,
        annotationCommentModel,
        shapeTool,
        shapeComposable,
        selectedShapeCommands,
        commentCrud,
        scrollToPage,
        emitForcedAnnotationMutation,
    } = options;

    function focusShapeAnnotationComment(comment: IAnnotationCommentSummary) {
        const shape = shapeTool.findShapeForAnnotationComment(comment);
        if (!shape) {
            return;
        }

        activeCommentStableKey.value = annotationIdForSummary(comment);
        shapeComposable.focusShape(shape.id);

        const pageNumber = requirePageNumber(Math.min(
            Math.max(comment.pageNumber, 1),
            Math.max(1, numPages.value),
        ), numPages.value);
        // Navigation owns target hydration and raster demand for every
        // annotation kind, including shapes. A second render here can replace
        // a newer navigation's demand while the original one is still pending.
        scrollToPage(pageNumber, { markerRect: comment.markerRect });
    }

    async function focusAnnotationComment(comment: IAnnotationCommentSummary) {
        if (comment.source === 'shape') {
            focusShapeAnnotationComment(comment);
            return;
        }

        shapeComposable.focusShape(null);
        await commentCrud.focusAnnotationComment(comment);
    }

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
        focusAnnotationComment,
        deleteAnnotationComment,
    };
};
