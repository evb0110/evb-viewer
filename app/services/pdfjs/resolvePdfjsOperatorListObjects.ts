import type {
    IPdfOperatorList,
    IPdfPage,
} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import pdfjsRuntime from '@app/services/pdfjs/runtimeLib';

interface IPdfjsObjectPool {get(id: string, callback: (value: unknown) => void): unknown;}

function isPdfjsObjectPool(value: unknown): value is IPdfjsObjectPool {
    return typeof value === 'object' && value !== null
        && 'get' in value && typeof value.get === 'function';
}

/** Operator-list completion does not wait for the worker's image decoders. */
export function resolvePdfjsOperatorListObjects(
    page: IPdfPage,
    operatorList: IPdfOperatorList,
    signal: AbortSignal,
): Promise<ReadonlyMap<string, unknown>> {
    const ids = new Set<string>();
    for (let index = 0; index < operatorList.fnArray.length; index += 1) {
        if (operatorList.fnArray[index] !== pdfjsRuntime.OPS.dependency) continue;
        for (const id of operatorList.argsArray[index] ?? []) {
            if (typeof id === 'string') ids.add(id);
        }
    }
    // The renderer adapter owns this PDF.js-only callback API. Consumers get
    // resolved values rather than access to either mutable object pool.
    return new Promise((resolve, reject) => {
        const objects = new Map<string, unknown>();
        let settled = false;
        function fail(error: unknown) {
            if (settled) {
                return;
            }
            settled = true;
            signal.removeEventListener('abort', onAbort);
            reject(error);
        }
        function onAbort() {
            fail(signal.reason);
        }
        function complete() {
            if (settled) {
                return;
            }
            settled = true;
            signal.removeEventListener('abort', onAbort);
            resolve(objects);
        }
        if (signal.aborted) {
            onAbort();
            return;
        }
        signal.addEventListener('abort', onAbort, {once: true});
        if (ids.size === 0) {
            complete();
            return;
        }
        try {
            for (const id of ids) {
                const pool = id.startsWith('g_')
                    ? 'commonObjs' in page ? page.commonObjs : undefined
                    : page.objs;
                if (!isPdfjsObjectPool(pool)) {
                    throw new Error('PDF.js dependency object pool is unavailable');
                }
                pool.get(id, (value: unknown) => {
                    if (settled) {
                        return;
                    }
                    objects.set(id, value);
                    if (objects.size === ids.size) complete();
                });
            }
        } catch (error) {
            fail(error);
        }
    });
}
