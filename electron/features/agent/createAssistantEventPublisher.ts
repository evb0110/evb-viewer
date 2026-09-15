import { BrowserWindow } from 'electron';
import type {
    IAgentAssistantChatScope,
    IAgentAssistantEvent,
    IAgentAssistantState,
} from '@contracts/agent';
import { buildAgentAssistantScopeFingerprint } from '@agent-core/assistantScope';
import { withAssistantErrorEnvelope } from '@electron/features/agent/assistantErrorEnvelope';
import type { IAssistantSelection } from '@electron/features/agent/assistantProviderStatus';
import { sendAgentAssistantEvent } from '@electron/features/agent/main/agentRendererEvents';
import type { IAssistantChatSession } from '@electron/features/agent/assistantChatSessionStore';

function shouldAttachState(event: IAgentAssistantEvent) {
    return event.state !== undefined || [
        'state',
        'message',
        'turn-started',
        'turn-completed',
        'install-progress',
        'error',
    ].includes(event.type);
}

function isChatSession(value: IAssistantSelection | IAssistantChatSession): value is IAssistantChatSession {
    return 'turnOwner' in value;
}

export function createAssistantEventPublisher(options: {
    currentState: (scope: IAgentAssistantChatScope | null, selection: IAssistantSelection) => IAgentAssistantState;
    getDefaultScope: () => IAgentAssistantChatScope | null;
    getDefaultSelection: () => IAssistantSelection;
}) {
    function publishAssistantEvent(
        event: IAgentAssistantEvent,
        scope = options.getDefaultScope(),
        selection: IAssistantSelection | IAssistantChatSession = options.getDefaultSelection(),
    ) {
        const eventBinding = isChatSession(selection) && selection.lastSenderWindowId !== null
            ? {
                scopeFingerprint: buildAgentAssistantScopeFingerprint(selection.provider, scope),
                sessionKey: `${selection.provider}:${selection.scope.key}`,
                turnGeneration: selection.turnOwner.generation,
                windowId: selection.lastSenderWindowId,
            }
            : undefined;
        const normalizedEvent = withAssistantErrorEnvelope({
            ...event,
            ...(event.binding === undefined && eventBinding ? {binding: eventBinding} : {}),
        });
        const payload: IAgentAssistantEvent = {
            ...normalizedEvent,
            ...(shouldAttachState(normalizedEvent)
                ? {state: normalizedEvent.state ?? options.currentState(scope, selection)}
                : {}),
        };
        const windows = normalizedEvent.binding
            ? [BrowserWindow.fromId(normalizedEvent.binding.windowId)].filter((window): window is BrowserWindow => window !== null)
            : BrowserWindow.getAllWindows();
        for (const window of windows) {
            if (!window.isDestroyed() && !window.webContents.isDestroyed()) sendAgentAssistantEvent(window, payload);
        }
    }

    function publishState(
        scope = options.getDefaultScope(),
        selection: IAssistantSelection | IAssistantChatSession = options.getDefaultSelection(),
    ) {
        publishAssistantEvent({
            type: 'state',
            state: options.currentState(scope, selection),
        }, scope, selection);
    }
    return {
        publishAssistantEvent,
        publishState,
    };
}
