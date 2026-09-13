import {
    resolveInactiveViewerResidencyState,
    resolvePostReclaimResidencyState,
    shouldReclaimViewerResidencyState,
    type TViewerResidencyState,
} from '@app/modules/document-viewer/public';

export interface IResolvePdfViewerResidencyDecisionOptions {
    isActive: boolean;
    isAnySaving: boolean;
    hasReclaimableDocumentCaches: boolean;
    previousState?: TViewerResidencyState | undefined;
}

export interface IPdfViewerResidencyDecision {
    state: TViewerResidencyState;
    shouldCleanupDocumentCaches: boolean;
}

export function resolvePdfViewerResidencyDecision(
    options: IResolvePdfViewerResidencyDecisionOptions,
): IPdfViewerResidencyDecision {
    if (options.isActive) {
        return {
            state: 'active',
            shouldCleanupDocumentCaches: false,
        };
    }

    const state = resolveInactiveViewerResidencyState({
        previousState: options.previousState,
        canReclaimNow: !options.isAnySaving,
        hasReclaimableState: options.hasReclaimableDocumentCaches,
    });

    return {
        state,
        shouldCleanupDocumentCaches: shouldReclaimViewerResidencyState(state),
    };
}

export {
    resolvePostReclaimResidencyState,
    type TViewerResidencyState,
};
