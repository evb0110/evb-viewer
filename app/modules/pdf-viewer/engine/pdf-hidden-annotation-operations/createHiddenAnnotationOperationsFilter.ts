import type {
    IPdfOperatorList,
    IPdfPage,
} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import { normalizePdfJsAnnotationId } from '@app/utils/pdfAnnotationRefs';
import { BrowserLogger } from '@app/utils/browserLogger';
import {
    runCoordinatedPdfPageOperation,
    type TPdfPageOperationSettlementCapture,
} from '@app/modules/pdf-viewer/engine/pdf-page-render-coordinator/coordinatedPdfPageRender';
import { isRenderingCancelledError } from '@app/modules/pdf-viewer/engine/pdf-page-render-pipeline/isRenderingCancelledError';

interface IHiddenAnnotationScanState {
    skippedIndices: Set<number>;
    annotationStack: boolean[];
    hiddenDepth: number;
}

const BEGIN_ANNOTATION_OP = 80;

const END_ANNOTATION_OP = 81;

interface IHiddenAnnotationOperationsFilterOptions {
    owner: string;
    priority: number;
    signal?: AbortSignal | undefined;
    shouldStart?: (() => boolean) | undefined;
    shouldContinue?: (() => boolean) | undefined;
    captureSettlement?: TPdfPageOperationSettlementCapture | undefined;
}

function normalizeAnnotationIdSet(annotationIds: Set<string>) {
    const normalizedIds = new Set<string>();
    annotationIds.forEach((id) => {
        const normalizedId = normalizePdfJsAnnotationId(id);
        if (normalizedId) {
            normalizedIds.add(normalizedId);
        }
    });
    return normalizedIds;
}

function processBeginAnnotationOperator(
    state: IHiddenAnnotationScanState,
    args: unknown,
    index: number,
    hiddenAnnotationIds: Set<string>,
) {
    const annotationId = Array.isArray(args) && typeof args[0] === 'string'
        ? normalizePdfJsAnnotationId(args[0])
        : null;
    const isHidden = annotationId ? hiddenAnnotationIds.has(annotationId) : false;

    if (state.hiddenDepth > 0 || isHidden) {
        state.skippedIndices.add(index);
    }

    state.annotationStack.push(isHidden);
    if (isHidden) {
        state.hiddenDepth += 1;
    }
}

function processEndAnnotationOperator(state: IHiddenAnnotationScanState) {
    const didHideCurrentAnnotation = state.annotationStack.pop() ?? false;
    if (didHideCurrentAnnotation) {
        state.hiddenDepth = Math.max(0, state.hiddenDepth - 1);
    }
}

function collectHiddenAnnotationOperatorIndices(
    operatorList: IPdfOperatorList,
    hiddenAnnotationIds: Set<string>,
) {
    if (hiddenAnnotationIds.size === 0) {
        return new Set<number>();
    }

    const state: IHiddenAnnotationScanState = {
        skippedIndices: new Set<number>(),
        annotationStack: [],
        hiddenDepth: 0,
    };
    for (const [
        index,
        fn,
    ] of operatorList.fnArray.entries()) {
        if (fn === BEGIN_ANNOTATION_OP) {
            processBeginAnnotationOperator(
                state,
                operatorList.argsArray[index],
                index,
                hiddenAnnotationIds,
            );
            continue;
        }

        if (state.hiddenDepth > 0) {
            state.skippedIndices.add(index);
        }

        if (fn === END_ANNOTATION_OP) {
            processEndAnnotationOperator(state);
        }
    }

    return state.skippedIndices;
}

export async function createHiddenAnnotationOperationsFilter(
    pdfPage: IPdfPage,
    annotationMode: number,
    hiddenAnnotationIds?: Set<string>,
    coordination?: IHiddenAnnotationOperationsFilterOptions,
) {
    if (!hiddenAnnotationIds || hiddenAnnotationIds.size === 0) {
        return undefined;
    }

    if (typeof pdfPage.getOperatorList !== 'function') {
        throw new Error(`Cannot suppress managed annotation appearances on page ${pdfPage.pageNumber}: operator list is unavailable`);
    }

    try {
        const normalizedHiddenAnnotationIds = normalizeAnnotationIdSet(hiddenAnnotationIds);
        if (normalizedHiddenAnnotationIds.size === 0) {
            return undefined;
        }

        const operatorList = coordination
            ? await runCoordinatedPdfPageOperation({
                owner: coordination.owner,
                pageNumber: pdfPage.pageNumber,
                pdfPage,
                priority: coordination.priority,
                signal: coordination.signal,
                shouldStart: coordination.shouldStart,
                shouldContinue: coordination.shouldContinue,
                captureSettlement: coordination.captureSettlement,
                operation: () => pdfPage.getOperatorList({ annotationMode }),
            })
            : await pdfPage.getOperatorList({ annotationMode });
        if (coordination?.shouldContinue?.() === false) {
            return undefined;
        }
        const skippedIndices = collectHiddenAnnotationOperatorIndices(
            operatorList,
            normalizedHiddenAnnotationIds,
        );

        if (skippedIndices.size === 0) {
            return undefined;
        }

        return (index: number) => !skippedIndices.has(index);
    } catch (error) {
        if (isRenderingCancelledError(error)) {
            return undefined;
        }
        BrowserLogger.warn(
            'pdf-renderer',
            `Failed to build hidden annotation filter for page ${pdfPage.pageNumber}`,
            error,
        );
        throw error;
    }
}
