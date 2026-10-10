import type { ShallowRef } from 'vue';
import type { IPdfSemanticAnchor } from '@contracts/recentReadingView';
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
    readonly readingAnchor: Readonly<ShallowRef<IPdfSemanticAnchor | null>>;
    readonly mountedWorkspace: Readonly<ShallowRef<IWorkspaceExpose | null>>;
    publishToolbarSnapshot(snapshot: IWorkspaceToolbarSnapshot): void;
    applyViewState(state: ITabViewSessionState): void;
    /** The mounted workspace, or null once the document has failed or the view was removed. */
    whenMounted(): Promise<IWorkspaceExpose | null>;
}

export interface IWorkspaceDocumentViewSeed {
    toolbarSnapshot: IWorkspaceToolbarSnapshot;
    viewState: ITabViewSessionState;
}

/** The controller's handle on a view: mounting and settling its waiters. */
export interface IWorkspaceDocumentViewRecord extends IWorkspaceDocumentView {
    mount(workspace: IWorkspaceExpose): void;
    /** Clears the mount if it is this workspace; reports whether it was. */
    unmount(workspace: IWorkspaceExpose): boolean;
    settleMountWaiters(workspace: IWorkspaceExpose | null): void;
    /** Ends the view: it drops its workspace, answers every waiter with null and takes no new mount. */
    retire(): void;
}

export function createWorkspaceDocumentView(tabId: string, options: {
    /** A failed document resolves mount waiters with null instead of waiting. */
    isDocumentFailed: () => boolean;
    /** A view of a document another view already shows starts from that view. */
    seed?: IWorkspaceDocumentViewSeed | undefined;
}): IWorkspaceDocumentViewRecord {
    const toolbarSnapshot = shallowRef(options.seed?.toolbarSnapshot ?? createDefaultWorkspaceToolbarSnapshot());
    const viewState = shallowRef(options.seed?.viewState ?? createTabViewSessionState(toolbarSnapshot.value));
    const readingAnchor = shallowRef<IPdfSemanticAnchor | null>(null);
    const mountedWorkspace = shallowRef<IWorkspaceExpose | null>(null);
    const mountWaiters = new Set<(workspace: IWorkspaceExpose | null) => void>();
    let retired = false;

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
        readingAnchor,
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
            if (retired || options.isDocumentFailed()) {
                return Promise.resolve(null);
            }
            return new Promise<IWorkspaceExpose | null>((resolve) => {
                mountWaiters.add(resolve);
            });
        },
        mount(workspace) {
            if (retired) {
                return;
            }
            mountedWorkspace.value = workspace;
            settleMountWaiters(workspace);
        },
        unmount(workspace) {
            if (mountedWorkspace.value !== workspace) {
                return false;
            }
            readingAnchor.value = workspace.captureReadingAnchor?.() ?? null;
            mountedWorkspace.value = null;
            return true;
        },
        settleMountWaiters,
        retire() {
            retired = true;
            readingAnchor.value = null;
            mountedWorkspace.value = null;
            settleMountWaiters(null);
        },
    };
}
