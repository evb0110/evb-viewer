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
import type { ITab } from '@app/types/tabs';
import type { IWorkspaceExpose } from '@app/types/workspaceExpose';
import type { IWorkspaceDocumentController } from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import { BrowserLogger } from '@app/utils/browserLogger';
import { getSystemCapability } from '@app/utils/getSystemCapability';

type TReadableRef<T> = ComputedRef<T> | Ref<T>;

interface IUseNativeWindowCloseHandshakeOptions {
    documentSessionsByTabId: TReadableRef<Record<string, IWorkspaceDocumentController>>;
    requestDirtyCloseConfirmation: () => Promise<TWindowCloseDecision>;
    flushSettings?: () => Promise<boolean>;
    systemCapability?: Pick<ISystemCapability, 'onWindowCloseRequest'>;
    tabs: TReadableRef<ITab[]>;
    workspaceWaitTimeoutMs?: number;
}

const DEFAULT_WORKSPACE_WAIT_TIMEOUT_MS = 2_000;

export const useNativeWindowCloseHandshake = (
    options: IUseNativeWindowCloseHandshakeOptions,
) => {
    const systemCapability = options.systemCapability ?? getSystemCapability();
    const workspaceWaitTimeoutMs = options.workspaceWaitTimeoutMs ?? DEFAULT_WORKSPACE_WAIT_TIMEOUT_MS;
    let closeRequestInFlight = false;

    function getDirtyTabs() {
        return options.tabs.value.filter((tab) => {
            const session = options.documentSessionsByTabId.value[tab.id];
            return session?.snapshot.value.dirty ?? tab.isDirty;
        });
    }

    async function saveTab(tab: ITab) {
        const session = options.documentSessionsByTabId.value[tab.id];
        if (!session) {
            return false;
        }

        let workspace: IWorkspaceExpose | null = session.mountedWorkspace.value;
        workspace ??= await session.waitForWorkspace(
            session.createCommandTarget(),
            workspaceWaitTimeoutMs,
        );
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

            for (const tab of dirtyTabs) {
                if (!await saveTab(tab)) {
                    return 'cancel';
                }
            }

            if (options.flushSettings && !await options.flushSettings()) {
                return 'cancel';
            }

            return getDirtyTabs().length === 0 ? 'save' : 'cancel';
        } catch (error) {
            BrowserLogger.error('workspace', 'Native window close save failed', {error}, {
                code: 'RENDERER_WORKSPACE_OPERATION_FAILED',
                context: {},
            });
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
