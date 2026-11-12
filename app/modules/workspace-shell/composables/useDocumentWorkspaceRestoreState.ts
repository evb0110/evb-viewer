import type { ComputedRef } from 'vue';
import type { IWorkspaceRestoreTrackerLike } from '@app/modules/workspace-shell/composables/useWorkspaceRestoreTracker';

interface IUseDocumentWorkspaceRestoreStateOptions {
    tabId: string;
    workspaceRestoreTracker: IWorkspaceRestoreTrackerLike;
    initFromStorage: () => void;
    cleanupSidebarResizeListeners: () => void;
}

/**
 * A workspace mount's restore state: whether a cross-window transfer is still
 * restoring into this tab. Where the view is belongs to its open surface.
 */
export const useDocumentWorkspaceRestoreState = (options: IUseDocumentWorkspaceRestoreStateOptions): {isExternallyRestoring: ComputedRef<boolean>} => {
    const isExternallyRestoring = computed(() => options.workspaceRestoreTracker.has(options.tabId));

    onMounted(() => {
        options.initFromStorage();
    });

    onUnmounted(() => {
        options.cleanupSidebarResizeListeners();
    });

    return {isExternallyRestoring};
};
