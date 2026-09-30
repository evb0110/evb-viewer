import type { ShallowRef } from 'vue';
import { isEqual } from 'es-toolkit/predicate';
import {
    createDefaultWorkspaceToolbarSnapshot,
    type IWorkspaceExpose,
    type IWorkspaceToolbarSnapshot,
} from '@app/types/workspaceExpose';
import type { ITabViewSessionState } from '@app/modules/workspace-shell/tabs/tabSessionStoreTypes';
import { createTabViewSessionState } from '@app/modules/workspace-shell/tabs/createTabViewSessionState';

/**
 * One tab's view of a document: what its workspace shows (toolbar projection,
 * page, zoom and panels) and the workspace mounted for it. The document
 * controller owns the views; a tab reads and writes only its own.
 */
export interface IWorkspaceDocumentView {
    readonly tabId: string;
    readonly toolbarSnapshot: Readonly<ShallowRef<IWorkspaceToolbarSnapshot>>;
    readonly viewState: Readonly<ShallowRef<ITabViewSessionState>>;
    readonly mountedWorkspace: Readonly<ShallowRef<IWorkspaceExpose | null>>;
    publishToolbarSnapshot(snapshot: IWorkspaceToolbarSnapshot): void;
    applyViewState(state: ITabViewSessionState): void;
    /** The mounted workspace, or null once the document has failed or the view is gone. */
    whenMounted(): Promise<IWorkspaceExpose | null>;
}

/** The controller's handle on a view: mounting and settling its waiters. */
export interface IWorkspaceDocumentViewRecord extends IWorkspaceDocumentView {
    mount(workspace: IWorkspaceExpose): void;
    /** Clears the mount if it is this workspace; reports whether it was. */
    unmount(workspace: IWorkspaceExpose): boolean;
    settleMountWaiters(workspace: IWorkspaceExpose | null): void;
}

export function createWorkspaceDocumentView(tabId: string, options: {
    /** A failed document resolves mount waiters with null instead of waiting. */
    isDocumentFailed: () => boolean;
    viewState?: ITabViewSessionState | undefined;
}): IWorkspaceDocumentViewRecord {
    const toolbarSnapshot = shallowRef(createDefaultWorkspaceToolbarSnapshot());
    const viewState = shallowRef(options.viewState ?? createTabViewSessionState(toolbarSnapshot.value));
    const mountedWorkspace = shallowRef<IWorkspaceExpose | null>(null);
    const mountWaiters = new Set<(workspace: IWorkspaceExpose | null) => void>();

    function settleMountWaiters(workspace: IWorkspaceExpose | null) {
        for (const resolve of mountWaiters) {
            resolve(workspace);
        }
        mountWaiters.clear();
    }

    return {
        tabId,
        toolbarSnapshot,
        viewState,
        mountedWorkspace,
        publishToolbarSnapshot(next) {
            if (!isEqual(toolbarSnapshot.value, next)) {
                toolbarSnapshot.value = next;
            }
        },
        applyViewState(state) {
            if (!isEqual(viewState.value, state)) {
                viewState.value = state;
            }
        },
        whenMounted() {
            if (mountedWorkspace.value) {
                return Promise.resolve(mountedWorkspace.value);
            }
            if (options.isDocumentFailed()) {
                return Promise.resolve(null);
            }
            return new Promise<IWorkspaceExpose | null>((resolve) => {
                mountWaiters.add(resolve);
            });
        },
        mount(workspace) {
            mountedWorkspace.value = workspace;
            settleMountWaiters(workspace);
        },
        unmount(workspace) {
            if (mountedWorkspace.value !== workspace) {
                return false;
            }
            mountedWorkspace.value = null;
            return true;
        },
        settleMountWaiters,
    };
}
