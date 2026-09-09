import type {
    TAnnotationTool,
    TMarkupSubtype,
} from '@app/types/annotations';
import type {TAnnotationCreationOutcome} from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/annotationCreationOutcome.types';
import type {IHighlightPageGeometry} from '@app/modules/pdf-viewer/engine/annotation-highlight-geometry/buildHighlightQuadsFromSelection';
import type {IAnnotationMarkupStyle} from '@app/modules/pdf-viewer/runtime/annotations/createAnnotationSelectionLifecycle';
import type {TSelectionGeometryResolution} from '@app/modules/pdf-viewer/runtime/sessions/resolvePdfAnnotationSelectionGeometry';
import type {AnnotationId} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';

export interface ICreatePdfAnnotationSelectionMarkupRequest {
    range: Range;
    tool: TAnnotationTool;
    subtype: TMarkupSubtype;
    style: IAnnotationMarkupStyle;
    withNote: boolean;
    requireActiveTool: boolean;
}

interface ICreatePdfAnnotationSelectionMarkupOptions {
    resolveGeometry: (range: Range) => Promise<TSelectionGeometryResolution>;
    createHighlights: (
        pages: readonly IHighlightPageGeometry[],
        request: ICreatePdfAnnotationSelectionMarkupRequest,
    ) => readonly AnnotationId[];
    completeCreation: (tool: TAnnotationTool) => void;
    selectCreated: (ids: readonly AnnotationId[]) => void;
    emitModified: () => void;
    onCreated: (annotationId: string, withNote: boolean) => void;
    getActiveTool: () => TAnnotationTool;
}

export const createPdfAnnotationSelectionMarkup = (
    options: ICreatePdfAnnotationSelectionMarkupOptions,
) => async (
    request: ICreatePdfAnnotationSelectionMarkupRequest,
    isRequestCurrent: () => boolean = () => true,
): Promise<TAnnotationCreationOutcome> => {
    if (request.requireActiveTool && !isRequestCurrent()) {
        return {status: 'cancelled'};
    }
    const geometry = await options.resolveGeometry(request.range);
    if (geometry.status === 'stale') {
        return {status: 'cancelled'};
    }
    if (geometry.status === 'failed') {
        return {
            status: 'failed',
            reason: geometry.reason,
        };
    }
    if (!isRequestCurrent()) {
        return {status: 'cancelled'};
    }
    const createdIds = options.createHighlights(geometry.pages, request);
    const firstCreatedId = createdIds[0];
    if (!firstCreatedId) {
        return {
            status: 'failed',
            reason: 'selection-not-in-text-layer',
        };
    }
    if (options.getActiveTool() === request.tool) {
        options.completeCreation(request.tool);
    }
    options.selectCreated(createdIds);
    options.emitModified();
    options.onCreated(firstCreatedId, request.withNote);
    return {
        status: 'created',
        annotationId: firstCreatedId,
    };
};
