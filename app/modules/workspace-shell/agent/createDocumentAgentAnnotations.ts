import type {Ref} from 'vue';
import type {IAnnotationCommentSummary} from '@app/types/annotations';
import type {TAgentTextMarkupKind} from '@app/modules/pdf-viewer/public';
import {markerRectFromPoint, normalizeMarkerRect} from '@app/modules/pdf-viewer/public';
import {
    getAgentBooleanInput,
    getAgentNumberInput,
    getAgentNullableStringInput,
    getAgentPointArrayInput,
    getAgentStringInput,
    getAgentStrokeArrayInput,
    isAgentShapeTool,
    isAgentTextMarkupKind,
} from '@app/modules/workspace-shell/agent/documentWorkspaceAgentInputs';

interface ICreateDocumentAgentAnnotationsOptions {
    annotationComments: Ref<IAnnotationCommentSummary[]>;
    currentPage: Ref<number>;
}

export function createDocumentAgentAnnotations(options: ICreateDocumentAgentAnnotationsOptions) {
    const {annotationComments, currentPage} = options;

    function getAgentTextMarkupCreateOptions(input: Record<string, unknown>) {
        const text =
            getAgentStringInput(input, 'text') ?? getAgentStringInput(input, 'query') ?? getAgentStringInput(input, 'selectionText');
        if (!text) {
            throw new Error('annotation.create_text_markup requires input.text.');
        }

        const pageNumber = getAgentNumberInput(input, 'page') ?? getAgentNumberInput(input, 'pageNumber') ?? currentPage.value;
        const occurrence = getAgentNumberInput(input, 'occurrence') ?? getAgentNumberInput(input, 'matchIndex') ?? 1;
        const markup = getAgentStringInput(input, 'markup') ?? getAgentStringInput(input, 'tool') ?? getAgentStringInput(input, 'kind');
        const withNote = getAgentBooleanInput(input, 'withNote') ?? getAgentBooleanInput(input, 'openNote') ?? false;
        const caseSensitive = getAgentBooleanInput(input, 'caseSensitive') ?? getAgentBooleanInput(input, 'matchCase') ?? false;
        const wholeWord = getAgentBooleanInput(input, 'wholeWord') ?? false;

        if (!isAgentTextMarkupKind(markup ?? 'highlight')) {
            throw new Error('annotation.create_text_markup requires input.markup: highlight, underline, strikethrough, or squiggly.');
        }

        return {
            pageNumber,
            text,
            occurrence,
            markup: (markup ?? 'highlight') as TAgentTextMarkupKind,
            caseSensitive,
            wholeWord,
            withNote,
        };
    }

    function getAgentPointNoteCreateOptions(input: Record<string, unknown>) {
        const pageNumber = getAgentNumberInput(input, 'page') ?? getAgentNumberInput(input, 'pageNumber') ?? currentPage.value;
        const pageX = getAgentNumberInput(input, 'pageX') ?? getAgentNumberInput(input, 'x');
        const pageY = getAgentNumberInput(input, 'pageY') ?? getAgentNumberInput(input, 'y');
        if (pageX === null || pageY === null) {
            throw new Error('annotation.create_note_at_point requires input.pageX and input.pageY.');
        }

        return {
            pageNumber,
            pageX,
            pageY,
            preferTextAnchor: getAgentBooleanInput(input, 'preferTextAnchor') ?? true,
        };
    }

    function patchLatestAgentPointNoteMarkerRect(options: ReturnType<typeof getAgentPointNoteCreateOptions>) {
        const markerRect = markerRectFromPoint(options.pageX, options.pageY);
        if (!markerRect) {
            return null;
        }
        return markerRect;
    }

    function getAgentShapeCreateOptions(input: Record<string, unknown>) {
        const tool = getAgentStringInput(input, 'shape') ?? getAgentStringInput(input, 'tool') ?? getAgentStringInput(input, 'kind');
        if (!isAgentShapeTool(tool)) {
            throw new Error('annotation.create_shape requires input.shape: draw, rectangle, circle, line, or arrow.');
        }

        const points = getAgentPointArrayInput(input, 'points');
        const strokes = getAgentStrokeArrayInput(input, 'strokes');
        const firstPoint = points?.[0] ?? strokes?.[0]?.[0] ?? null;
        const x = getAgentNumberInput(input, 'x') ?? getAgentNumberInput(input, 'pageX') ?? firstPoint?.x ?? null;
        const y = getAgentNumberInput(input, 'y') ?? getAgentNumberInput(input, 'pageY') ?? firstPoint?.y ?? null;
        if (x === null || y === null) {
            throw new Error('annotation.create_shape requires normalized input.x and input.y coordinates.');
        }

        return {
            pageNumber: getAgentNumberInput(input, 'page') ?? getAgentNumberInput(input, 'pageNumber') ?? currentPage.value,
            tool,
            x,
            y,
            width: getAgentNumberInput(input, 'width') ?? undefined,
            height: getAgentNumberInput(input, 'height') ?? undefined,
            x2: getAgentNumberInput(input, 'x2') ?? getAgentNumberInput(input, 'endX') ?? undefined,
            y2: getAgentNumberInput(input, 'y2') ?? getAgentNumberInput(input, 'endY') ?? undefined,
            points,
            strokes,
            color: getAgentStringInput(input, 'color') ?? undefined,
            fillColor: getAgentNullableStringInput(input, 'fillColor'),
            opacity: getAgentNumberInput(input, 'opacity') ?? undefined,
            strokeWidth: getAgentNumberInput(input, 'strokeWidth') ?? undefined,
        };
    }

    function normalizeAgentAnnotationComment(comment: IAnnotationCommentSummary) {
        return {
            id: comment.id,
            stableKey: comment.stableKey,
            pageIndex: comment.pageIndex,
            pageNumber: comment.pageNumber,
            text: comment.text,
            displayText: comment.displayText ?? null,
            previewText: comment.previewText ?? null,
            kindLabel: comment.kindLabel ?? null,
            subtype: comment.subtype ?? null,
            author: comment.author,
            createdAt: comment.createdAt ?? null,
            modifiedAt: comment.modifiedAt,
            color: comment.color,
            fillColor: comment.fillColor ?? null,
            opacity: comment.opacity ?? null,
            strokeWidth: comment.strokeWidth ?? null,
            uid: comment.uid,
            annotationId: comment.annotationId,
            source: comment.source,
            hasNote: comment.hasNote === true,
            markerRect: normalizeMarkerRect(comment.markerRect),
        };
    }

    function findAgentAnnotationComment(input: Record<string, unknown> | undefined) {
        const stableKey = getAgentStringInput(input, 'stableKey');
        const annotationId = getAgentStringInput(input, 'annotationId');
        const id = getAgentStringInput(input, 'id');
        const comment = annotationComments.value.find(
            (candidate) =>
                (stableKey !== null && candidate.stableKey === stableKey) ||
                (annotationId !== null && candidate.annotationId === annotationId) ||
                (id !== null && candidate.id === id),
        );
        if (!comment) {
            throw new Error('Annotation comment was not found. Use evb://document/{tabId}/annotations to get stable keys.');
        }
        return comment;
    }

    return {
        findAgentAnnotationComment,
        getAgentPointNoteCreateOptions,
        getAgentShapeCreateOptions,
        getAgentTextMarkupCreateOptions,
        normalizeAgentAnnotationComment,
        patchLatestAgentPointNoteMarkerRect,
    };
}
