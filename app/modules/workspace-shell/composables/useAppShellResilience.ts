import type { Ref } from 'vue';
import type { IWorkspaceDocumentController } from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import type { useEditorPanesManager } from '@app/modules/workspace-shell/composables/useEditorPanesManager';
import { tryOnScopeDispose } from '@vueuse/core';
import { getSystemCapability } from '@app/utils/getSystemCapability';
import { useWorkspaceCrashCheckpoint } from '@app/modules/workspace-shell/checkpoint/useWorkspaceCrashCheckpoint';
import { useBrowserWorkspaceRecovery } from '@app/modules/workspace-shell/checkpoint/useBrowserWorkspaceRecovery';

interface IAppShellResilienceOptions {
    documentSessionsByTabId: Ref<Record<string, IWorkspaceDocumentController>>;
    editorPanesManager: ReturnType<typeof useEditorPanesManager>;
    enabled: Ref<boolean>;
    browserEnabled: Ref<boolean>;
}

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
    // A quit can arrive inside the checkpoint debounce window, when the newest
    // edit exists only in the renderer. Write it before the shutdown proceeds;
    // the debounced save alone would lose it with the process.
    tryOnScopeDispose(getSystemCapability().onShutdownSaveFlushRequest(async () => {
        if (Object.values(options.documentSessionsByTabId.value).some(session => session.snapshot.value.dirty)) {
            await crashCheckpoint.persistCheckpointNow();
        }
        return {};
    }));
    return crashCheckpoint;
};
