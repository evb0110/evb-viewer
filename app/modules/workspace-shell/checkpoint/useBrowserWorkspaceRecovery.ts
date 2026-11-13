import type { Ref } from 'vue';
import { useEventListener } from '@vueuse/core';
import type {
    IEditorPaneState,
    TEditorLayoutNode,
} from '@contracts/editorPanes';
import type { ITab } from '@app/types/tabs';
import type { IWorkspaceDocumentController } from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import { buildWorkspaceCheckpoint } from '@app/modules/workspace-shell/checkpoint/buildWorkspaceCheckpoint';
import { buildWorkspaceCheckpointChangeSignature } from '@app/modules/workspace-shell/checkpoint/buildWorkspaceCheckpointChangeSignature';
import { getWindowTabsCapability } from '@app/utils/platformWindowTabs';
import { BrowserLogger } from '@app/utils/browserLogger';

interface IUseBrowserWorkspaceRecoveryOptions {
    enabled: Ref<boolean>;
    panes: Ref<IEditorPaneState[]>;
    tabs: Ref<ITab[]>;
    layout: Ref<TEditorLayoutNode | null>;
    activePaneId: Ref<string | null>;
    activeTabId: Ref<string | null>;
    documentSessionsByTabId: Ref<Record<string, IWorkspaceDocumentController>>;
    getPaneByTabId(tabId: string): IEditorPaneState | null;
}

const RECOVERY_DEBOUNCE_MS = 750;

/**
 * Records the browser window's layout and unsaved annotations shortly after each change: the annotations go
 * into each document's store directory as drafts. The window's checkpoint already names every directory the
 * window holds, written when it opened, so a crash before this record still finds the document's bytes.
 */
export const useBrowserWorkspaceRecovery = (options: IUseBrowserWorkspaceRecoveryOptions) => {
    const recovery = getWindowTabsCapability().browserRecovery;
    if (!recovery) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight: Promise<void> | null = null;
    let changedSinceRecord = false;
    let disposed = false;

    // One record at a time, so an older capture never lands after a newer one.
    function record() {
        if (timer) clearTimeout(timer);
        timer = null;
        if (disposed || !options.enabled.value) return;
        if (inFlight) {
            changedSinceRecord = true;
            return;
        }
        changedSinceRecord = false;
        inFlight = recovery!.save(buildWorkspaceCheckpoint(options))
            .catch((error: unknown) => BrowserLogger.warn('workspace-recovery', 'Failed to record browser recovery state', error))
            .finally(() => {
                inFlight = null;
                if (changedSinceRecord) record();
            });
    }

    const stop = watch(
        // The cheap change signature keeps this watcher from rebuilding the checkpoint on every reactive tick.
        () => options.enabled.value ? buildWorkspaceCheckpointChangeSignature(options).workspace : null,
        () => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(record, RECOVERY_DEBOUNCE_MS);
        },
        {immediate: true, flush: 'sync'},
    );

    useEventListener(typeof window === 'undefined' ? undefined : window, 'pagehide', record);
    useEventListener(typeof document === 'undefined' ? undefined : document, 'visibilitychange', () => {
        if (document.visibilityState === 'hidden') record();
    });

    onBeforeUnmount(() => {
        disposed = true;
        stop();
        if (timer) clearTimeout(timer);
    });
};
