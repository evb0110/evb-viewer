import type {TDocumentRevisionToken} from '@contracts/documentRevision';
import type {IPdfAnnotationParseResult} from '@contracts/pdfAnnotationParseTypes';
import type {AnnotationStore} from '@app/modules/pdf-viewer/annotations/domain/annotationStore';
import {
    mapPdfAnnotationParseEntity,
    mapPdfAnnotationParseForeign,
    pdfAnnotationRefKey,
} from '@app/modules/pdf-viewer/runtime/sessions/mapPdfAnnotationParseEntity';

export interface ICommitPdfAnnotationParseToStoreOptions {
    result: IPdfAnnotationParseResult;
    request: number;
    currentRequest: number;
    isTransitionCurrent: () => boolean;
    targetStore: AnnotationStore;
    currentStore: AnnotationStore;
    targetStoreMutationEpoch: number;
    workingCopyPath: string;
    currentWorkingCopyPath: string | null;
    expectedRevisionToken: TDocumentRevisionToken;
    currentRevisionToken: TDocumentRevisionToken | null;
    selectedTextByPdfRef?: ReadonlyMap<string, string | null>;
}

/**
 * Commit one writer parse only while every document and store fence still
 * points at the request that started it. The parse result is a saved baseline,
 * while foreign records remain inert store metadata.
 */
export function commitPdfAnnotationParseToStore(
    options: ICommitPdfAnnotationParseToStoreOptions,
) {
    if (
        options.request !== options.currentRequest
        || !options.isTransitionCurrent()
        || options.targetStore !== options.currentStore
        || options.targetStore.mutationEpoch !== options.targetStoreMutationEpoch
        || options.currentWorkingCopyPath !== options.workingCopyPath
        || options.currentRevisionToken !== options.expectedRevisionToken
        || options.result.documentRevisionToken !== options.expectedRevisionToken
    ) {
        return false;
    }

    options.targetStore.replaceFromDocument(
        options.result.entities.map((entry) => mapPdfAnnotationParseEntity(
            entry,
            options.selectedTextByPdfRef?.get(pdfAnnotationRefKey(entry.objectNumber, entry.generationNumber)),
        )),
        options.result.foreign.map(mapPdfAnnotationParseForeign),
    );
    return true;
}
