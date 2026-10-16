import type {TDocumentRevisionToken} from '@contracts/documentRevision';
import type {
    IPdfAnnotationParseResult, TPdfAnnotationParseEntity,
} from '@contracts/pdfAnnotationParseTypes';
import type {AnnotationStore} from '@app/modules/pdf-viewer/annotations/domain/annotationStore';
import {
    mapPdfAnnotationParseEntity,
    mapPdfAnnotationParseForeign,
    pdfAnnotationRefKey,
} from '@app/modules/pdf-viewer/runtime/sessions/mapPdfAnnotationParseEntity';

export interface ICommitPdfAnnotationParseToStoreOptions {
    result: IPdfAnnotationParseResult;
    isTransitionCurrent: () => boolean;
    targetStore: AnnotationStore;
    currentStore: AnnotationStore;
    targetStoreMutationEpoch: number;
    expectedRevisionToken: TDocumentRevisionToken;
    currentRevisionToken: TDocumentRevisionToken | null;
    selectedTextByPdfRef?: ReadonlyMap<string, string | null>;
}

export function applyParsedHighlightTextToStore(options: {
    targetStore: AnnotationStore;
    selectedTextByPdfRef: ReadonlyMap<string, string | null>;
    parsedEntities: readonly TPdfAnnotationParseEntity[];
}) {
    options.targetStore.batch(() => options.selectedTextByPdfRef.forEach((selectedText, pdfRef) => {
        const id = options.targetStore.resolveExternal({pdfRef});
        const parsed = options.parsedEntities.find(entry => entry.kind === 'highlight'
            && pdfAnnotationRefKey(entry.objectNumber, entry.generationNumber) === pdfRef);
        const expectedQuadPoints = parsed?.kind === 'highlight' ? parsed.quadPoints : undefined;
        if (id && expectedQuadPoints) {
            options.targetStore.updateTextMarkupSelectedText(id, selectedText, expectedQuadPoints);
        }
    }));
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
        !options.isTransitionCurrent()
        || options.targetStore !== options.currentStore
        || options.targetStore.mutationEpoch !== options.targetStoreMutationEpoch
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
