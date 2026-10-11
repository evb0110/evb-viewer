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
    submitAgentCommandResponse,
    submitAgentWorkspaceSnapshotResponse,
} from '@electron/features/agent/workspaceBridge';

import {getAllRegisteredAppWindows} from '@electron/window/registry';
import {sendPlatformEvent} from '@electron/utils/sendPlatformEvent';
import {createLogger} from '@electron/utils/createLogger';

export function createAgentService() {
    return {
        getMcpIntegrationStatus: () => getAgentMcpIntegrationStatus(),
        async setMcpIntegrationEnabled(context, enabled) {
            const result = await setAgentMcpIntegrationEnabled(enabled, BrowserWindow.fromWebContents(context.sender));
            // The settings commit precedes server/registration work. Runtime details
            // become observable only when that operation (including rollback) finishes.
            for (const window of getAllRegisteredAppWindows()) {
                sendPlatformEvent<IAgentEventMap, typeof AGENT_PLATFORM_FEATURE.eventChannels.onMcpIntegrationChanged>(
                    window,
                    AGENT_PLATFORM_FEATURE.eventChannels.onMcpIntegrationChanged,
                    result.status,
                    error => createLogger('agent').warn(`Failed to send MCP runtime status: ${String(error)}`),
                );
            }
            return result;
        },
        getAssistantState: (_context, request) =>
            getAgentAssistantState(request),
        installAssistantCodex: () => installAgentAssistantCodex(),
        startAssistantLogin: (context, request) =>
            startAgentAssistantLogin(
                request,
                BrowserWindow.fromWebContents(context.sender),
            ),
        cancelAssistantLogin: () => cancelAgentAssistantLogin(),
        sendAssistantMessage: (context, request) =>
            sendAgentAssistantMessage(request, {windowId: BrowserWindow.fromWebContents(context.sender)?.id ?? null}),
        interruptAssistant: (_context, request) =>
            interruptAgentAssistant(request),
        resetAssistantChat: (_context, request) =>
            resetAgentAssistantChat(request),
        submitWorkspaceSnapshot: (context, response) =>
            Promise.resolve(submitAgentWorkspaceSnapshotResponse(context, response)),
        submitCommandResponse: (context, response) =>
            Promise.resolve(submitAgentCommandResponse(context, response)),
        shutdownAssistant: () => shutdownAgentAssistantIfLoaded(),
    } satisfies TFeatureMainBindings<typeof AGENT_PLATFORM_FEATURE, IpcMainInvokeEvent>
        & {shutdownAssistant: () => Promise<void>};
}

export type TAgentService = ReturnType<typeof createAgentService>;
