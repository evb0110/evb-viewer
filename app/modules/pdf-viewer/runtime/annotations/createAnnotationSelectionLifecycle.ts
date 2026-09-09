import type {
    TAnnotationTool,
    TMarkupSubtype,
} from '@app/types/annotations';
import type {IAnnotationTextSelectionSnapshot} from '@app/modules/pdf-viewer/runtime/annotations/useAnnotationTextSelectionCache';
import type {TAnnotationCreationOutcome} from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/annotationCreationOutcome.types';

export interface IAnnotationMarkupStyle {
    color: string | null;
    opacity: number | null;
}

export interface IAnnotationSelectionCreationRequest {
    selection: IAnnotationTextSelectionSnapshot;
    tool: TAnnotationTool;
    subtype: TMarkupSubtype;
    style: IAnnotationMarkupStyle;
    withNote: boolean;
    requireActiveTool: boolean;
}

interface ICreateAnnotationSelectionLifecycleOptions {
    getActiveTool: () => TAnnotationTool;
    create: (
        request: IAnnotationSelectionCreationRequest,
        isRequestCurrent: () => boolean,
    ) => Promise<TAnnotationCreationOutcome>;
    consumeSelection: (selection: IAnnotationTextSelectionSnapshot) => void;
}

/**
 * Serializes creation for one selection and tool epoch while allowing a newer
 * selection or reactivation to proceed. A second caller for the same request
 * receives the first promise, which keeps tool activation and an explicit
 * context-menu command from creating the same markup twice.
 */
export const createAnnotationSelectionLifecycle = (
    options: ICreateAnnotationSelectionLifecycleOptions,
) => {
    const pending = new Map<string, Promise<TAnnotationCreationOutcome>>();
    let toolEpoch = 0;

    function requestKey(request: IAnnotationSelectionCreationRequest, toolEpoch: number) {
        return [
            request.selection.revision,
            request.subtype,
            request.withNote ? 'note' : 'markup',
            request.requireActiveTool ? `tool:${toolEpoch}` : 'explicit',
        ].join(':');
    }

    function requestCreation(request: IAnnotationSelectionCreationRequest) {
        const requestEpoch = toolEpoch;
        const key = requestKey(request, requestEpoch);
        const existing = pending.get(key);
        if (existing) {
            return existing;
        }

        const isRequestCurrent = () => !request.requireActiveTool
            || (options.getActiveTool() === request.tool && requestEpoch === toolEpoch);
        const promise = (async () => {
            if (!isRequestCurrent()) {
                return {status: 'cancelled'} as const;
            }
            const outcome = await options.create(request, isRequestCurrent);
            // `create` checks the request before the canonical transaction.
            // It may then auto-reset the tool synchronously, so checking the
            // live tool again here would leave the successful selection in
            // the cache whenever Keep active is disabled.
            if (outcome.status === 'created') {
                options.consumeSelection(request.selection);
            }
            return outcome;
        })();
        pending.set(key, promise);
        promise.then(
            () => {
                if (pending.get(key) === promise) pending.delete(key);
            },
            () => {
                if (pending.get(key) === promise) pending.delete(key);
            },
        );
        return promise;
    }

    function invalidateActiveRequests() {
        toolEpoch += 1;
    }

    function activate(request: Omit<IAnnotationSelectionCreationRequest, 'requireActiveTool'>) {
        return requestCreation({
            ...request,
            requireActiveTool: true,
        });
    }

    return {
        invalidateActiveRequests,
        activate,
        request: requestCreation,
    };
};
