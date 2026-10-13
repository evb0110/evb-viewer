import type {
    InjectionKey,
    Ref,
} from 'vue';
import type { IWorkspaceDocumentController } from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import type { useEditorPanesManager } from '@app/modules/workspace-shell/composables/useEditorPanesManager';
import { tryOnScopeDispose } from '@vueuse/core';
import { withTimeout } from 'es-toolkit/promise';
import { getSystemCapability } from '@app/utils/getSystemCapability';
import { BrowserLogger } from '@app/utils/browserLogger';
import { useWorkspaceCrashCheckpoint } from '@app/modules/workspace-shell/checkpoint/useWorkspaceCrashCheckpoint';
import { useBrowserWorkspaceRecovery } from '@app/modules/workspace-shell/checkpoint/useBrowserWorkspaceRecovery';

interface IAppShellResilienceOptions {
    documentSessionsByTabId: Ref<Record<string, IWorkspaceDocumentController>>;
    editorPanesManager: ReturnType<typeof useEditorPanesManager>;
    enabled: Ref<boolean>;
    browserEnabled: Ref<boolean>;
}

// The renderer's shutdown flush shares a 2.5 s budget with the other save-flush
// handlers, so this write must return well inside it.
const SHUTDOWN_CHECKPOINT_WRITE_TIMEOUT_MS = 1_000;

/** Writes the crash checkpoint now, for a Save to call before it changes any file. */
export const crashCheckpointBeforeSaveKey: InjectionKey<() => Promise<void>> = Symbol('crashCheckpointBeforeSave');

export const useAppShellResilience = (options: IAppShellResilienceOptions) => {
    const crashCheckpoint = useWorkspaceCrashCheckpoint({
        ...options.editorPanesManager,
        enabled: options.enabled,
        documentSessionsByTabId: options.documentSessionsByTabId,
    });
    useBrowserWorkspaceRecovery({
        ...options.editorPanesManager,
        enabled: options.browserEnabled,
        documentSessionsByTabId: options.documentSessionsByTabId,
    });
    // A termination signal can arrive inside the checkpoint debounce window, when
    // the newest edit exists only in the renderer. Write it before the process
    // exits. A user Quit closes its windows through the Save/Discard decision
    // first, so this flush reaches no renderer then. The write is capped below
    // the renderer flush budget, and a failed write is logged rather than
    // reported as a failed flush, so it never holds the shutdown.
    tryOnScopeDispose(getSystemCapability().onShutdownSaveFlushRequest(async () => {
        try {
            await withTimeout(() => crashCheckpoint.persistCheckpointNow(true), SHUTDOWN_CHECKPOINT_WRITE_TIMEOUT_MS);
        } catch (error) {
            BrowserLogger.error('workspace', 'Failed to write the crash checkpoint during shutdown', {error}, {code: 'RENDERER_WORKSPACE_OPERATION_FAILED'});
        }
        return {};
    }));
    // A Save the app does not live to finish is rolled back at the next start, together with the edits it was writing;
    // the checkpoint a Save writes first holds those edits, so they reopen unsaved instead of being lost.
    provide(crashCheckpointBeforeSaveKey, () => crashCheckpoint.persistCheckpointNow(true));
    return crashCheckpoint;
};
