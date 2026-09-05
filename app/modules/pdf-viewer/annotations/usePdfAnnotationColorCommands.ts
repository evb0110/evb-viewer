import type {ShallowRef} from 'vue';
import type {
    IAnnotationCommentSummary,
    ITextMarkupAnnotationProperties,
} from '@app/types/annotations';
import { computeSummaryStableKey } from '@app/modules/pdf-viewer/engine/annotations/domain/annotationSummaryIdentity';
import type { usePdfAnnotationCommentModel } from '@app/modules/pdf-viewer/annotations/usePdfAnnotationCommentModel';
import type { AnnotationApplication } from '@app/modules/pdf-viewer/annotations/annotationApplication';
import type { ITextMarkupEntity } from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';

type TAnnotationCommentModel = ReturnType<typeof usePdfAnnotationCommentModel>;

interface IUsePdfAnnotationColorCommandsOptions {
    annotationApplication: ShallowRef<AnnotationApplication>;
    annotationCommentModel: TAnnotationCommentModel;
    emitForcedAnnotationMutation: (options?: { scheduleCommentSync?: boolean }) => void;
}

export interface ITextMarkupColorMutationResult {
    updated: boolean;
    shouldScheduleCommentSync: boolean;
    shouldRefreshPage: boolean;
    shouldApplyTextMarkupColor: boolean;
    comment: IAnnotationCommentSummary | null;
    sourceColor: string | null;
}

export const usePdfAnnotationColorCommands = (options: IUsePdfAnnotationColorCommandsOptions) => {
    const {
        annotationApplication,
        annotationCommentModel,
        emitForcedAnnotationMutation,
    } = options;

    const noopColorMutationResult: ITextMarkupColorMutationResult = {
        updated: false,
        shouldScheduleCommentSync: false,
        shouldRefreshPage: false,
        shouldApplyTextMarkupColor: false,
        comment: null,
        sourceColor: null,
    };

    function updateCachedAnnotationCommentColor(
        comment: IAnnotationCommentSummary,
        color: string,
        options: { colorEdited?: boolean } = {},
    ) {
        annotationCommentModel.updateCachedColor(comment, color, options);
    }

    function getTextMarkupEntity(comment: IAnnotationCommentSummary) {
        const application = annotationApplication.value;
        const annotationId = application.annotationIdForSummary(comment);
        const entity = annotationId ? application.store.get(annotationId) : null;
        return entity?.kind === 'text-markup' && !entity.deleted ? entity : null;
    }

    function getNoteEntity(comment: IAnnotationCommentSummary) {
        const application = annotationApplication.value;
        const annotationId = application.annotationIdForSummary(comment);
        const entity = annotationId ? application.store.get(annotationId) : null;
        return entity?.kind === 'note' && !entity.deleted ? entity : null;
    }

    function toTextMarkupProperties(entity: ITextMarkupEntity): ITextMarkupAnnotationProperties {
        return {
            id: entity.identity.id,
            pageIndex: entity.pageIndex,
            subtype: entity.subtype,
            color: entity.color ?? '',
            markerRect: entity.quadPoints[0] ?? null,
            opacity: entity.opacity,
            contents: entity.contents,
        };
    }

    function updateTextMarkupEntityColor(entity: ITextMarkupEntity, color: string) {
        const updated = annotationApplication.value.store.updateTextMarkup(
            entity.identity.id,
            {color},
        );
        return Boolean(updated);
    }

    function createColorMutationResult(
        comment: IAnnotationCommentSummary,
        color: string,
        options: {
            updated: boolean;
            shouldScheduleCommentSync: boolean;
            shouldRefreshPage: boolean;
            shouldApplyTextMarkupColor: boolean;
            sourceColor: string | null;
            colorEdited?: boolean;
        },
    ): ITextMarkupColorMutationResult {
        return {
            updated: options.updated,
            shouldScheduleCommentSync: options.shouldScheduleCommentSync,
            shouldRefreshPage: options.shouldRefreshPage,
            shouldApplyTextMarkupColor: options.shouldApplyTextMarkupColor,
            comment: {
                ...comment,
                color,
                colorEdited: options.colorEdited ?? comment.colorEdited,
            },
            sourceColor: options.sourceColor,
        };
    }

    function updateSelectedTextMarkupAnnotationColor(color: string) {
        const selectedEntity = [...annotationApplication.value.store.selectedIds]
            .map(id => annotationApplication.value.store.get(id))
            .find((entity): entity is ITextMarkupEntity => entity?.kind === 'text-markup' && !entity.deleted);
        const selectedMarkup = selectedEntity ? toTextMarkupProperties(selectedEntity) : null;
        const didUpdate = selectedEntity ? updateTextMarkupEntityColor(selectedEntity, color) : false;
        if (didUpdate && selectedEntity) {
            const selectedComment = selectedMarkup ? toSelectedTextMarkupComment(selectedMarkup) : null;
            if (selectedComment) {
                updateCachedAnnotationCommentColor(selectedComment, color);
            }
            if (selectedComment) {
                emitForcedAnnotationMutation({ scheduleCommentSync: true });
                return createColorMutationResult(selectedComment, color, {
                    updated: true,
                    shouldScheduleCommentSync: true,
                    shouldRefreshPage: true,
                    shouldApplyTextMarkupColor: Boolean(selectedMarkup?.subtype && selectedMarkup.subtype !== 'Highlight'),
                    sourceColor: selectedMarkup?.color ?? null,
                });
            }
            emitForcedAnnotationMutation({ scheduleCommentSync: true });
        }
        return didUpdate
            ? {
                ...noopColorMutationResult,
                updated: true,
                shouldScheduleCommentSync: true,
            }
            : noopColorMutationResult;
    }

    function updateTextMarkupAnnotationColor(comment: IAnnotationCommentSummary, color: string) {
        const note = getNoteEntity(comment);
        if (note) {
            const sourceColor = note.color;
            const updated = annotationApplication.value.store.updateNote(note.identity.id, {color});
            if (!updated) {
                return noopColorMutationResult;
            }
            emitForcedAnnotationMutation({scheduleCommentSync: true});
            return createColorMutationResult(comment, color, {
                updated: true,
                shouldScheduleCommentSync: true,
                shouldRefreshPage: false,
                shouldApplyTextMarkupColor: false,
                sourceColor,
                colorEdited: true,
            });
        }
        const subtype = annotationCommentModel.toTextMarkupSubtype(comment);
        const entity = getTextMarkupEntity(comment);
        if (!subtype) {
            return noopColorMutationResult;
        }
        const sourceColor = comment.color ?? null;
        const didUpdate = entity ? updateTextMarkupEntityColor(entity, color) : false;
        if (!entity || !didUpdate) {
            return noopColorMutationResult;
        }
        updateCachedAnnotationCommentColor(comment, color, { colorEdited: comment.colorEdited !== false });
        emitForcedAnnotationMutation({ scheduleCommentSync: true });
        return createColorMutationResult(comment, color, {
            updated: true,
            shouldScheduleCommentSync: true,
            shouldRefreshPage: false,
            shouldApplyTextMarkupColor: false,
            sourceColor,
            colorEdited: comment.colorEdited !== false,
        });
    }

    return {
        updateSelectedTextMarkupAnnotationColor,
        updateTextMarkupAnnotationColor,
    };
};

export function toSelectedTextMarkupComment(markup: ITextMarkupAnnotationProperties): IAnnotationCommentSummary {
    return {
        appAnnotationId: markup.id,
        id: markup.id,
        stableKey: computeSummaryStableKey({
            id: markup.id,
            pageIndex: markup.pageIndex,
            source: 'editor',
            annotationId: markup.id,
        }),
        pageIndex: markup.pageIndex,
        pageNumber: markup.pageIndex + 1,
        text: markup.contents ?? '',
        author: null,
        modifiedAt: null,
        color: markup.color,
        uid: null,
        annotationId: markup.id,
        source: 'editor',
        subtype: markup.subtype,
        markerRect: markup.markerRect,
    };
}
