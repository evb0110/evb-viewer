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
    // Live until the commit: an explicit command that joins replaces its intent.
    create: (
        request: IAnnotationSelectionCreationRequest & {range: Range},
        isRequestCurrent: () => boolean,
    ) => Promise<TAnnotationCreationOutcome>;
    consumeSelection: (selection: IAnnotationTextSelectionSnapshot) => void;
}

/**
 * Serializes creation for one selection and tool epoch while allowing a newer
 * selection or reactivation to proceed. A second caller for the same request
 * receives the first promise, whichever of tool activation and an explicit
 * context-menu command came first, so the two create the markup once.
 */
export const createAnnotationSelectionLifecycle = (
    options: ICreateAnnotationSelectionLifecycleOptions,
) => {
    const pending = new Map<string, {
        request: IAnnotationSelectionCreationRequest & {range: Range};
        outcome: Promise<TAnnotationCreationOutcome>;
    }>();
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
        const existing = pending.get(key) ?? pending.get(requestKey({
            ...request,
            requireActiveTool: !request.requireActiveTool,
        }, requestEpoch));
        if (existing?.request.requireActiveTool && !request.requireActiveTool) {
            // An explicit command takes over the activation it joins; under its
            // key no tool change cancels it and later requests still join it.
            pending.delete(requestKey(existing.request, requestEpoch));
            pending.set(key, existing);
            Object.assign(existing.request, request);
        }
        if (existing) {
            return existing.outcome;
        }

        const live = {
            ...request,
            range: request.selection.range,
        };
        const isRequestCurrent = () => !live.requireActiveTool
            || (options.getActiveTool() === request.tool && requestEpoch === toolEpoch);
        const outcome = (async () => {
            if (!isRequestCurrent()) {
                return {status: 'cancelled'} as const;
            }
            const result = await options.create(live, isRequestCurrent);
            // `create` checks the request before the canonical transaction.
            // It may then auto-reset the tool synchronously, so checking the
            // live tool again here would leave the successful selection in
            // the cache whenever Keep active is disabled.
            if (result.status === 'created') {
                options.consumeSelection(live.selection);
            }
            return result;
        })();
        pending.set(key, {
            request: live,
            outcome,
        });
        const forget = () => {
            const current = requestKey(live, requestEpoch);
            if (pending.get(current)?.outcome === outcome) pending.delete(current);
        };
        outcome.then(forget, forget);
        return outcome;
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
