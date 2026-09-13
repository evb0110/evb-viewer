import type {
    IAgentAssistantChatScope,
    TAgentAssistantProviderId,
} from '@contracts/agent';

export function cloneAssistantScope(scope: IAgentAssistantChatScope): IAgentAssistantChatScope {
    return {
        kind: scope.kind,
        key: scope.key,
        title: scope.title,
        ...(scope.tabId == null ? {} : {tabId: scope.tabId}),
        ...(scope.documentSessionKey == null ? {} : {documentSessionKey: scope.documentSessionKey}),
        ...(scope.documentInstanceId == null ? {} : {documentInstanceId: scope.documentInstanceId}),
        ...(scope.documentRef == null ? {} : {documentRef: scope.documentRef}),
        ...(scope.documentBackend === undefined ? {} : {documentBackend: scope.documentBackend}),
        ...(scope.documentIdentity == null ? {} : {documentIdentity: {...scope.documentIdentity}}),
        ...(scope.commandTarget === undefined ? {} : {commandTarget: {...scope.commandTarget}}),
    };
}

export function getAgentAssistantScopeRevisionToken(scope: IAgentAssistantChatScope | null | undefined) {
    return scope?.commandTarget?.documentRevisionToken
        ?? scope?.documentIdentity?.token
        ?? null;
}

export function buildAgentAssistantScopeFingerprint(
    provider: TAgentAssistantProviderId,
    scope: IAgentAssistantChatScope | null | undefined,
) {
    return JSON.stringify({
        provider,
        scopeKey: scope?.key ?? null,
        tabId: scope?.tabId ?? null,
        documentSessionKey: scope?.documentSessionKey ?? scope?.key ?? null,
        documentInstanceId: scope?.documentInstanceId ?? scope?.commandTarget?.documentInstanceId ?? null,
        documentRef: scope?.documentRef ?? scope?.commandTarget?.documentRef ?? null,
        documentRevisionToken: getAgentAssistantScopeRevisionToken(scope),
    });
}
