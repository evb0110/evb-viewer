import type {TDocumentRef} from '@contracts/documentRef';
import type {
    IPostSaveReloadWaiter,
    ISaveCompletionPolicy,
    TWorkspaceSaveExecutionResult,
} from '@app/modules/workspace-shell/composables/file-operations/workspaceSaveExecutionResult';
import type {
    IWorkspaceSerializedSaveBody,
    IWorkspaceSaveBaseline,
    TWorkspaceSavePlan,
} from '@app/modules/workspace-shell/composables/file-operations/workspaceSavePolicy';

export interface IWorkspaceSaveExecutionSupportDependencies {
    document: {
        sessionKey: {value: string | null};
        originalPath: {value: TDocumentRef | null};
        workingCopyPath: {value: TDocumentRef | null};
    };
    lifecycle: {preparePostSaveReload?: () => IPostSaveReloadWaiter;};
}

export function isTargetCurrent(
    plan: TWorkspaceSavePlan,
    deps: IWorkspaceSaveExecutionSupportDependencies,
) {
    return deps.document.sessionKey.value === plan.target.expectedDocumentSessionKey
        && deps.document.originalPath.value === plan.target.expectedOriginalPath
        && deps.document.workingCopyPath.value === plan.target.expectedWorkingPath;
}

export function createReloadWaiter(
    body: IWorkspaceSerializedSaveBody,
    deps: IWorkspaceSaveExecutionSupportDependencies,
) {
    return body.preserveLoadedSource ? null : deps.lifecycle.preparePostSaveReload?.() ?? null;
}

export async function withReloadWaiter<T>(
    reloadWaiter: IPostSaveReloadWaiter | null,
    operation: () => Promise<T>,
) {
    try {
        return await operation();
    } catch (error) {
        reloadWaiter?.cancel();
        throw error;
    }
}

export interface IWorkspaceSaveCompletionDependencies {
    annotations: {
        markSaved: () => void;
        getSaveStateToken?: () => unknown;
    };
    metadata: {
        markPageLabelsSaved: () => void;
        getPageLabelsSaveStateToken?: () => unknown;
        markBookmarksSaved: () => void;
        getBookmarksSaveStateToken?: () => unknown;
    };
    shapes: {markSaved?: (prepared?: unknown) => void;};
}

export function getCompletionBaseline(
    plan: TWorkspaceSavePlan,
    result: Extract<TWorkspaceSaveExecutionResult, {status: 'saved'}>,
    deps: IWorkspaceSaveCompletionDependencies,
): IWorkspaceSaveBaseline {
    if (result.annotationMaterializationBaseline === undefined) {
        result.commitAnnotationSave?.(result.persisted.materializedIdentityBindings);
        return plan.baseline;
    }

    const saveFrontierIsStillCurrent = !deps.annotations.getSaveStateToken
        || Object.is(
            deps.annotations.getSaveStateToken(),
            result.annotationMaterializationBaseline,
        );
    result.commitAnnotationSave?.(result.persisted.materializedIdentityBindings);
    return {
        ...plan.baseline,
        annotations: saveFrontierIsStillCurrent
            ? deps.annotations.getSaveStateToken?.()
            : result.annotationMaterializationBaseline,
    };
}

export function completeSuccessfulSaveState(
    baseline: IWorkspaceSaveBaseline,
    policy: ISaveCompletionPolicy,
    deps: IWorkspaceSaveCompletionDependencies,
    preparedShapeState?: unknown,
) {
    const annotationUnchanged = !deps.annotations.getSaveStateToken
        || Object.is(deps.annotations.getSaveStateToken(), baseline.annotations);
    if (policy.markAnnotationStateSaved
        && (annotationUnchanged || policy.allowAnnotationSaveStateRefresh === true)) {
        deps.annotations.markSaved();
    }

    const pageLabelsUnchanged = !deps.metadata.getPageLabelsSaveStateToken
        || Object.is(deps.metadata.getPageLabelsSaveStateToken(), baseline.pageLabels);
    if (policy.markPageLabelsStateSaved
        && (pageLabelsUnchanged || policy.allowPageLabelsSaveStateRefresh === true)) {
        deps.metadata.markPageLabelsSaved();
    }

    const bookmarksUnchanged = !deps.metadata.getBookmarksSaveStateToken
        || Object.is(deps.metadata.getBookmarksSaveStateToken(), baseline.bookmarks);
    if (policy.markBookmarksStateSaved
        && (bookmarksUnchanged || policy.allowBookmarksSaveStateRefresh === true)) {
        deps.metadata.markBookmarksSaved();
    }

    if (policy.markShapeStateSaved) {
        // The prepared token names the store and save frontier this save primed.
        // Passing it makes the clean mark refusable when a replacement store
        // now owns the viewer.
        deps.shapes.markSaved?.(preparedShapeState);
    }
}
