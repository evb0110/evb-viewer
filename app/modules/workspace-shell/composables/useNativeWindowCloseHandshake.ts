import type {
    ComputedRef,
    Ref,
} from 'vue';
import { tryOnScopeDispose } from '@vueuse/core';
import type {
    IWindowCloseRequest,
    ISystemCapability,
    TWindowCloseDecision,
} from '@contracts/systemPlatformFeature';
import type { IWorkspaceDocumentController } from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import { BrowserLogger } from '@app/utils/browserLogger';
import { getSystemCapability } from '@app/utils/getSystemCapability';

type TReadableRef<T> = ComputedRef<T> | Ref<T>;

interface IUseNativeWindowCloseHandshakeOptions {
    documentSessionsByTabId: TReadableRef<Record<string, IWorkspaceDocumentController>>;
    requestDirtyCloseConfirmation: () => Promise<TWindowCloseDecision>;
    flushSettings?: () => Promise<boolean>;
    systemCapability?: Pick<ISystemCapability, 'onWindowCloseRequest'>;
}

export const useNativeWindowCloseHandshake = (
    options: IUseNativeWindowCloseHandshakeOptions,
) => {
    const systemCapability = options.systemCapability ?? getSystemCapability();
    let closeRequestInFlight = false;

    function getDirtyTabs() {
        return Object.values(options.documentSessionsByTabId.value)
            .filter(session => session.snapshot.value.dirty);
    }

    // Dirty tabs are save-protected, so their workspaces stay mounted.
    async function saveTab(session: IWorkspaceDocumentController) {
        const workspace = session.mountedWorkspace.value;
        if (!workspace) {
            return false;
        }

        if (await workspace.handleSave() !== true) {
            return false;
        }
        await nextTick();
        return workspace.getAutomationStateSnapshot().dirtyState?.fileDirty !== true;
    }

    async function handleWindowClose(_request: IWindowCloseRequest): Promise<TWindowCloseDecision> {
        if (closeRequestInFlight) {
            return 'cancel';
        }

        closeRequestInFlight = true;
        try {
            if (options.flushSettings && !await options.flushSettings()) {
                return 'cancel';
            }
            const dirtyTabs = getDirtyTabs();
            if (dirtyTabs.length === 0) {
                await nextTick();
                return getDirtyTabs().length === 0 ? 'save' : 'cancel';
            }

            const decision = await options.requestDirtyCloseConfirmation();
            if (decision !== 'save') {
                return decision;
            }

            for (const session of dirtyTabs) {
                if (!await saveTab(session)) {
                    return 'cancel';
                }
            }

            if (options.flushSettings && !await options.flushSettings()) {
                return 'cancel';
            }

            return getDirtyTabs().length === 0 ? 'save' : 'cancel';
        } catch (error) {
            BrowserLogger.error('workspace', 'Native window close save failed', {error}, {code: 'RENDERER_WORKSPACE_OPERATION_FAILED'});
            return 'cancel';
        } finally {
            closeRequestInFlight = false;
        }
    }

    const subscribe = systemCapability.onWindowCloseRequest;
    if (!subscribe) {
        return;
    }

    const unsubscribe = subscribe(handleWindowClose);
    tryOnScopeDispose(unsubscribe);
    return unsubscribe;
};
