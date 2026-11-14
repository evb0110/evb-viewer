import type {
    IAgentAssistantChatScope,
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
