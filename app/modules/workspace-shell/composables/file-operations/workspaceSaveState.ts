import type {Ref} from 'vue';
import type {
    IWorkspaceSaveBaseline,
    IWorkspaceSaveDirtyState,
} from '@app/modules/workspace-shell/composables/file-operations/workspaceSavePolicy';

export interface IWorkspaceSaveStateDependencies {
    annotations: {
        dirty: Ref<boolean>;
        hasChanges: () => boolean;
        hasPendingDeletes?: () => boolean;
        getSaveStateToken?: () => unknown;
    };
    metadata: {
        pageLabelsDirty: Ref<boolean>;
        bookmarksDirty: Ref<boolean>;
        getPageLabelsSaveStateToken?: () => unknown;
        getBookmarksSaveStateToken?: () => unknown;
    };
    shapes: {hasChanges: () => boolean;};
}

export function collectDirtyState(deps: IWorkspaceSaveStateDependencies): IWorkspaceSaveDirtyState {
    return {
        annotationDirty: deps.annotations.dirty.value,
        annotationChanges: deps.annotations.hasChanges(),
        bookmarks: deps.metadata.bookmarksDirty.value,
        pageLabels: deps.metadata.pageLabelsDirty.value,
        pendingDeletes: deps.annotations.hasPendingDeletes?.() ?? false,
        shapes: deps.shapes.hasChanges(),
    };
}

export function captureBaseline(deps: IWorkspaceSaveStateDependencies): IWorkspaceSaveBaseline {
    return {
        annotations: deps.annotations.getSaveStateToken?.(),
        pageLabels: deps.metadata.getPageLabelsSaveStateToken?.(),
        bookmarks: deps.metadata.getBookmarksSaveStateToken?.(),
    };
}

export function resolveOperationKind(request: {kind: string}) {
    if (request.kind === 'save-as') {
        return 'save-as' as const;
    }
    if (request.kind === 'repair') {
        return 'repair-save' as const;
    }
    if (request.kind === 'optimize' || request.kind === 'optimize-copy') {
        return 'optimize-pdf' as const;
    }
    return 'save' as const;
}

export function isSaveAsRequest(request: {kind: string}) {
    return request.kind === 'save-as' || request.kind === 'optimize-copy';
}
