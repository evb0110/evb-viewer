import type {IPdfRenderTask} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import { normalizePdfJsAnnotationId } from '@app/utils/pdfAnnotationRefs';

const BEGIN_ANNOTATION_OP = 80;
const END_ANNOTATION_OP = 81;

interface IRuntimeOperatorList {
    fnArray: ArrayLike<number>;
    argsArray: ArrayLike<unknown>;
}

function resolveRuntimeOperatorList(task: IPdfRenderTask | null): IRuntimeOperatorList | null {
    if (!task || typeof task !== 'object') {
        return null;
    }
    const internalTask: unknown = Reflect.get(task, '_internalRenderTask');
    if (!internalTask || typeof internalTask !== 'object') {
        return null;
    }
    const operatorList: unknown = Reflect.get(internalTask, 'operatorList');
    if (!operatorList || typeof operatorList !== 'object') {
        return null;
    }
    const fnArray: unknown = Reflect.get(operatorList, 'fnArray');
    const argsArray: unknown = Reflect.get(operatorList, 'argsArray');
    if (!Array.isArray(fnArray) || !Array.isArray(argsArray)) {
        return null;
    }
    return {
        fnArray,
        argsArray,
    };
}

export function createRenderTaskHiddenAnnotationOperationsFilter(hiddenAnnotationIds: ReadonlySet<string>) {
    const normalizedHiddenIds = new Set<string>();
    hiddenAnnotationIds.forEach((id) => {
        const normalizedId = normalizePdfJsAnnotationId(id);
        if (normalizedId) {
            normalizedHiddenIds.add(normalizedId);
        }
    });
    let operatorList: IRuntimeOperatorList | null = null;
    const annotationStack: boolean[] = [];
    let hiddenDepth = 0;

    return {
        bindTask(task: IPdfRenderTask) {
            // pdf.js grows the render task's operator list in place, so the private
            // arrays resolved here stay valid for the whole render.
            operatorList = resolveRuntimeOperatorList(task);
            return operatorList !== null;
        },
        filter(index: number) {
            if (!operatorList) {
                return true;
            }
            const fn = operatorList.fnArray[index];
            if (fn === BEGIN_ANNOTATION_OP) {
                const args = operatorList.argsArray[index];
                const annotationId = Array.isArray(args) && typeof args[0] === 'string'
                    ? normalizePdfJsAnnotationId(args[0])
                    : null;
                const isHidden = Boolean(annotationId && normalizedHiddenIds.has(annotationId));
                annotationStack.push(isHidden);
                if (isHidden) {
                    hiddenDepth += 1;
                }
                return hiddenDepth === 0;
            }
            const shouldInclude = hiddenDepth === 0;
            if (fn === END_ANNOTATION_OP) {
                const wasHidden = annotationStack.pop() ?? false;
                if (wasHidden) {
                    hiddenDepth = Math.max(0, hiddenDepth - 1);
                }
            }
            return shouldInclude;
        },
    };
}
