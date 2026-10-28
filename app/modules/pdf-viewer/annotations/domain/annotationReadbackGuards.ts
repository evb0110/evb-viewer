import {normalizePdfJsAnnotationId} from '@app/utils/pdfAnnotationRefs';
import type {AnnotationEntity} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';

/** A native deletion proof permits precisely those missing reply refs. */
export function keepsReplies(parsed: AnnotationEntity, current: AnnotationEntity, deleted: ReadonlySet<string>) {
    const replyKey = (reply: {
        objectNumber: number;
        generationNumber: number
    }) => `${reply.objectNumber} ${reply.generationNumber} R`;
    const parsedReplies = new Set((parsed.replies ?? []).map(replyKey));
    return (current.replies ?? []).every(reply => parsedReplies.has(replyKey(reply)) || deleted.has(replyKey(reply)));
}

export function admitsAnnotationReadback(
    entities: readonly AnnotationEntity[],
    foreign: ReadonlyArray<{pageIndex: number}>,
    scope: ReadonlySet<number> | null,
    readWholeDocument: boolean,
    expectedUpserts: ReadonlyArray<Pick<AnnotationEntity, 'identity' | 'kind'>>,
) {
    const inScope = (entry: {pageIndex: number}) => scope === null || scope.has(entry.pageIndex);
    if (!entities.every(inScope) || !foreign.every(inScope) || (scope && !readWholeDocument)) return false;
    if (!scope) return true;
    const recognized = new Map(entities.map(entity => [
        normalizePdfJsAnnotationId(entity.identity.pdfRef),
        entity.kind,
    ]));
    return expectedUpserts.every(expected => {
        const ref = normalizePdfJsAnnotationId(expected.identity.pdfRef);
        return ref && recognized.get(ref) === expected.kind;
    });
}
