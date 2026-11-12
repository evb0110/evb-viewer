import {
    BrowserWindow,
    type IpcMainInvokeEvent,
} from 'electron';
import {
    AGENT_PLATFORM_FEATURE, type IAgentEventMap,
} from '@contracts/agentPlatformFeature';
import type { TFeatureMainBindings } from '@contracts/platformFeature';
import {
    cancelAgentAssistantLogin,
    getAgentAssistantState,
    installAgentAssistantCodex,
    interruptAgentAssistant,
    resetAgentAssistantChat,
    sendAgentAssistantMessage,
    shutdownAgentAssistantIfLoaded,
    startAgentAssistantLogin,
} from '@electron/features/agent/lazyAgentAssistant';
import {
    getAgentMcpIntegrationStatus,
    setAgentMcpIntegrationEnabled,
} from '@electron/features/agent/codexMcpIntegration';
import {
    getAssistantInstanceConfigs,
    importAssistantInstancesFromT3,
    saveAssistantInstanceConfigs,
} from '@electron/features/agent/assistantInstances';
import {
    submitAgentCommandResponse,
    submitAgentWorkspaceSnapshotResponse,
} from '@electron/features/agent/workspaceBridge';

import {getAllRegisteredAppWindows} from '@electron/window/registry';
import {sendPlatformEvent} from '@electron/utils/sendPlatformEvent';
import {createLogger} from '@electron/utils/createLogger';
import {createKeyedSerialQueue} from '@electron/utils/createKeyedSerialQueue';
import type {IAgentMcpIntegrationStatus} from '@contracts/agent';

export function createAgentService() {
    const runMcpLifecycle = createKeyedSerialQueue();
    function publishMcpStatus(status: IAgentMcpIntegrationStatus) {
        for (const window of getAllRegisteredAppWindows()) {
            sendPlatformEvent<IAgentEventMap, typeof AGENT_PLATFORM_FEATURE.eventChannels.onMcpIntegrationChanged>(
                window,
                AGENT_PLATFORM_FEATURE.eventChannels.onMcpIntegrationChanged,
                status,
                error => createLogger('agent').warn(`Failed to send MCP runtime status: ${String(error)}`),
            );
        }
    }
    return {
        getMcpIntegrationStatus: () => runMcpLifecycle('mcp', async () => {
            const status = await getAgentMcpIntegrationStatus();
            publishMcpStatus(status);
            return status;
        }),
        setMcpIntegrationEnabled: (context, enabled) => runMcpLifecycle('mcp', async () => {
            const result = await setAgentMcpIntegrationEnabled(enabled, BrowserWindow.fromWebContents(context.sender));
            publishMcpStatus(result.status);
            return result;
        }),
        getAssistantState: (_context, request) => getAgentAssistantState(request),
        installAssistantCodex: () => installAgentAssistantCodex(),
        startAssistantLogin: (_context, request) => startAgentAssistantLogin(request),
        cancelAssistantLogin: (_context, request) => cancelAgentAssistantLogin(request),
        sendAssistantMessage: (context, request) =>
            sendAgentAssistantMessage(request, {windowId: BrowserWindow.fromWebContents(context.sender)?.id ?? null}),
        interruptAssistant: (_context, request) => interruptAgentAssistant(request),
        resetAssistantChat: (_context, request) => resetAgentAssistantChat(request),
        getAssistantInstances: async () => ({
            ok: true,
            instances: await getAssistantInstanceConfigs(),
            notices: [],
        }),
        saveAssistantInstances: (_context, instances) => saveAssistantInstanceConfigs(instances),
        importAssistantInstancesFromT3: () => importAssistantInstancesFromT3(),
        submitWorkspaceSnapshot: (context, response) =>
            Promise.resolve(submitAgentWorkspaceSnapshotResponse(context, response)),
        submitCommandResponse: (context, response) =>
            Promise.resolve(submitAgentCommandResponse(context, response)),
        shutdownAssistant: () => shutdownAgentAssistantIfLoaded(),
    } satisfies TFeatureMainBindings<typeof AGENT_PLATFORM_FEATURE, IpcMainInvokeEvent>
        & {shutdownAssistant: () => Promise<void>};
}

export type TAgentService = ReturnType<typeof createAgentService>;
