import type {
    IAgentAssistantChatScope,
    IAgentAssistantEvent,
    IAgentAssistantState,
    TAgentAssistantProviderId,
} from '@contracts/agent';
import { buildAgentAssistantScopeFingerprint } from '@agent-core/assistantScope';

export function shouldAcceptAssistantEvent(
    event: IAgentAssistantEvent,
    provider: TAgentAssistantProviderId,
    scope: IAgentAssistantChatScope | null,
    latestGenerationBySession: Map<string, number>,
) {
    if (!event.binding) {
        return event.state !== undefined;
    }
    if (event.binding.scopeFingerprint !== buildAgentAssistantScopeFingerprint(provider, scope)) {
        return false;
    }
    const latestGeneration = latestGenerationBySession.get(event.binding.sessionKey) ?? -1;
    if (event.binding.turnGeneration < latestGeneration) {
        return false;
    }
    if (event.binding.turnGeneration > latestGeneration) {
        latestGenerationBySession.set(event.binding.sessionKey, event.binding.turnGeneration);
    }
    return true;
}

export function createAssistantEventFence() {
    const generations = new Map<string, number>();
    return (
        event: IAgentAssistantEvent,
        provider: TAgentAssistantProviderId,
        scope: IAgentAssistantChatScope | null,
    ) => shouldAcceptAssistantEvent(event, provider, scope, generations);
}

export function isAssistantStateCurrent(
    state: IAgentAssistantState,
    provider: TAgentAssistantProviderId,
    scope: IAgentAssistantChatScope | null,
) {
    return buildAgentAssistantScopeFingerprint(state.status.provider, state.scope)
        === buildAgentAssistantScopeFingerprint(provider, scope);
}
