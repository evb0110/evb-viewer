import type { TDocumentRef } from '@contracts/documentRef';
import type { IDocumentSourceCapabilities } from '@app/utils/document-viewer/source/documentPageSource';

type TDocumentSessionSourceKind = 'pdf' | 'djvu' | null;

export interface IDocumentSourceActivation {
    generation: number;
    kind: Exclude<TDocumentSessionSourceKind, null>;
    documentRef: TDocumentRef;
}

const DJVU_SOURCE_CAPABILITIES: IDocumentSourceCapabilities = {
    annotations: false,
    directImageExport: true,
    outline: false,
    pageEdits: false,
    search: false,
    text: false,
};

const EMPTY_SOURCE_CAPABILITIES: IDocumentSourceCapabilities = {
    annotations: false,
    directImageExport: false,
    outline: false,
    pageEdits: false,
    search: false,
    text: false,
};

const SOURCE_CAPABILITIES_BY_KIND: Record<Exclude<TDocumentSessionSourceKind, null>, IDocumentSourceCapabilities> = {
    pdf: EMPTY_SOURCE_CAPABILITIES,
    djvu: DJVU_SOURCE_CAPABILITIES,
};

/** Source identity owned by the document session rather than a format mode flag. */
export const useDocumentSourceSession = () => {
    const sourceKind = ref<TDocumentSessionSourceKind>(null);
    const sourceRef = ref<TDocumentRef | null>(null);
    const projectionRef = ref<TDocumentRef | null>(null);
    const sourceGeneration = ref(0);
    let activeActivation: IDocumentSourceActivation | null = null;
    const capabilities = computed<IDocumentSourceCapabilities>(() => (
        sourceKind.value === null ? EMPTY_SOURCE_CAPABILITIES : SOURCE_CAPABILITIES_BY_KIND[sourceKind.value]
    ));

    function activateDocumentSource(
        kind: Exclude<TDocumentSessionSourceKind, null>,
        documentRef: TDocumentRef,
        pdfProjectionRef: TDocumentRef | null = null,
    ) {
        const activation: IDocumentSourceActivation = {
            generation: sourceGeneration.value + 1,
            kind,
            documentRef,
        };
        sourceGeneration.value = activation.generation;
        activeActivation = activation;
        sourceKind.value = kind;
        sourceRef.value = documentRef;
        projectionRef.value = pdfProjectionRef;
        return activation;
    }

    function captureDocumentSourceActivation(): IDocumentSourceActivation | null {
        return activeActivation ? {...activeActivation} : null;
    }

    function clearDocumentSource(expectedActivation?: IDocumentSourceActivation) {
        if (
            expectedActivation
            && (
                activeActivation?.generation !== expectedActivation.generation
                || activeActivation.kind !== expectedActivation.kind
                || activeActivation.documentRef !== expectedActivation.documentRef
            )
        ) {
            return false;
        }
        sourceGeneration.value += 1;
        activeActivation = null;
        sourceKind.value = null;
        sourceRef.value = null;
        projectionRef.value = null;
        return true;
    }

    return {
        sourceKind,
        sourceRef,
        projectionRef,
        sourceGeneration,
        capabilities,
        isDjvuSource: computed(() => capabilities.value === DJVU_SOURCE_CAPABILITIES),
        activateDocumentSource,
        captureDocumentSourceActivation,
        clearDocumentSource,
    };
};
