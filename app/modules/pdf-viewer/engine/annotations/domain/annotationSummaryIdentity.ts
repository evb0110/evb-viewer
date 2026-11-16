import type {
    IAnnotationCommentSummary,
    TAnnotationStableKey,
} from '@app/types/annotations';
import {
    asAnnotationId,
    deriveAnnotationId,
    type AnnotationEntity,
    type AnnotationId,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';

export interface IComputeSummaryStableKeyParams {
    pageIndex: number;
    id: string;
    source: IAnnotationCommentSummary['source'];
    uid?: string | null;
    annotationId?: string | null;
    annotationName?: string | null;
}

type TAnnotationCommentMatchInput = Pick<
    IAnnotationCommentSummary,
    'appAnnotationId' | 'stableKey' | 'annotationName' | 'annotationId' | 'uid' | 'id' | 'pageIndex' | 'source'
>;

/**
 * Origin follows the canonical PDF binding. A bound edit the working bytes do
 * not yet hold is still the existing PDF object, never a new editor annotation.
 */
export function summarySourceForEntity(entity: Pick<AnnotationEntity, 'kind' | 'identity'>): IAnnotationCommentSummary['source'] {
    return entity.kind === 'shape' ? 'shape' : entity.identity.pdfRef ? 'pdf' : 'editor';
}

export function computeSummaryStableKey(params: IComputeSummaryStableKeyParams): TAnnotationStableKey {
    const annotationName = params.annotationName?.trim();
    if (annotationName) {
        return `nm:${annotationName}`;
    }
    // The canonical identity has one external binding. Keep summary keys in
    // the same two-arm shape even while PDF.js still exposes its legacy ids.
    const annotationId = params.annotationId?.trim();
    const uid = params.uid?.trim();
    const externalId = annotationId?.length
        ? annotationId
        : uid?.length
            ? uid
            : `${params.source}:${params.id}`;
    return `ann:${params.pageIndex}:${externalId}`;
}

/** Canonical command/UI identity. Stable keys remain serializer/DOM bindings. */
export function annotationIdForSummary(summary: TAnnotationCommentMatchInput): AnnotationId {
    if (summary.appAnnotationId) {
        return asAnnotationId(summary.appAnnotationId);
    }
    const explicitExternalIdentity = summary.annotationName
        ?? summary.annotationId
        ?? summary.uid
        ?? summary.id;
    return deriveAnnotationId(
        'legacy-annotation-summary-binding',
        `${summary.source}:${summary.pageIndex}:${explicitExternalIdentity}`,
    );
}
