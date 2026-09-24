import type { Ref } from 'vue';
import type { IWorkspaceDocumentController } from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import type { useEditorPanesManager } from '@app/modules/workspace-shell/composables/useEditorPanesManager';
import { useWorkspaceCrashCheckpoint } from '@app/modules/workspace-shell/checkpoint/useWorkspaceCrashCheckpoint';
import { useBrowserWorkspaceRecovery } from '@app/modules/workspace-shell/checkpoint/useBrowserWorkspaceRecovery';

interface IAppShellResilienceOptions {
    documentSessionsByTabId: Ref<Record<string, IWorkspaceDocumentController>>;
    editorPanesManager: ReturnType<typeof useEditorPanesManager>;
    enabled: Ref<boolean>;
    browserEnabled: Ref<boolean>;
}

export const useAppShellResilience = (options: IAppShellResilienceOptions) => {
    useWorkspaceCrashCheckpoint({
        ...options.editorPanesManager,
        enabled: options.enabled,
        documentSessionsByTabId: options.documentSessionsByTabId,
    });
    useBrowserWorkspaceRecovery({
        ...options.editorPanesManager,
        enabled: options.browserEnabled,
        documentSessionsByTabId: options.documentSessionsByTabId,
    });
};
