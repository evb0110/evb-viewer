import type {
    IAgentCommandExecutionScope,
    IAgentTabSnapshot,
    IAgentWorkspaceSnapshot,
    TAgentWorkspaceCommandTarget,
} from '@contracts/agent';
import type { IAssistantSessionScopeBinding } from '@electron/features/agent/assistantTurnLifecycle';

let activeAssistantMcpSessionScope: IAssistantSessionScopeBinding | null = null;

function cloneAssistantSessionScopeBinding(
    binding: IAssistantSessionScopeBinding,
): IAssistantSessionScopeBinding {
    return {
        ...binding,
        ...(binding.documentIdentity === null ? {} : { documentIdentity: { ...binding.documentIdentity } }),
        ...(binding.commandTarget === undefined ? {} : {commandTarget: {...binding.commandTarget}}),
    };
}

export function getActiveAssistantMcpSessionScope() {
    return activeAssistantMcpSessionScope
        ? cloneAssistantSessionScopeBinding(activeAssistantMcpSessionScope)
        : null;
}

export function setActiveAssistantMcpSessionScope(binding: IAssistantSessionScopeBinding) {
    activeAssistantMcpSessionScope = cloneAssistantSessionScopeBinding(binding);
}

export function clearAssistantMcpSessionScope(sessionKey?: string) {
    if (sessionKey === undefined || activeAssistantMcpSessionScope?.sessionKey === sessionKey) {
        activeAssistantMcpSessionScope = null;
    }
}

export function syncAssistantMcpSessionScope(
    sessionKey: string,
    binding: IAssistantSessionScopeBinding | null,
) {
    if (binding) {
        setActiveAssistantMcpSessionScope(binding);
        return;
    }
    clearAssistantMcpSessionScope(sessionKey);
}

export function resolveAssistantMcpSessionScope(explicitWindowId?: number) {
    const binding = getActiveAssistantMcpSessionScope();
    if (!binding) {
        throw new Error('No active assistant turn is bound to the internal EVB MCP session.');
    }
    if (explicitWindowId !== undefined && explicitWindowId !== binding.windowId) {
        throw new Error('Internal EVB MCP request targeted a different window than the active assistant turn.');
    }
    return binding;
}

function getSnapshotBindingTab(
    snapshot: IAgentWorkspaceSnapshot,
    binding: IAssistantSessionScopeBinding,
): IAgentTabSnapshot {
    const tab = snapshot.tabs.find(candidate => candidate.tabId === binding.tabId);
    if (!tab) {
        throw new Error('The active assistant document tab is no longer open.');
    }
    return tab;
}

export function assertAssistantMcpSnapshotMatchesScope(
    snapshot: IAgentWorkspaceSnapshot,
    binding: IAssistantSessionScopeBinding,
) {
    const tab = getSnapshotBindingTab(snapshot, binding);
    assertAssistantMcpTabMatchesBinding(tab, binding);
}

export function assertAssistantMcpTabMatchesBinding(
    tab: IAgentTabSnapshot,
    binding: IAssistantSessionScopeBinding,
    options: {tabIdAlreadyResolved?: boolean} = {},
) {
    if (options.tabIdAlreadyResolved !== true && tab.tabId !== binding.tabId) {
        throw new Error('Internal EVB MCP request targeted a different tab than the active assistant turn.');
    }
    if (
        binding.commandTarget
        && !commandTargetsMatch(binding.commandTarget, tab.commandTarget)
    ) {
        throw new Error('The active assistant document changed before the internal EVB MCP request completed.');
    }
    if ((binding.documentInstanceId ?? null) !== (tab.documentInstanceId ?? null)) {
        throw new Error('The active assistant document changed before the internal EVB MCP request completed.');
    }
    if (binding.documentIdentity === null) {
        return;
    }
    if (
        tab.documentIdentity?.token !== binding.documentIdentity.token
        || tab.documentIdentity.documentRef !== binding.documentIdentity.documentRef
    ) {
        throw new Error('The active assistant document changed before the internal EVB MCP request completed.');
    }
}

export function createAssistantCommandExecutionScope(
    binding: IAssistantSessionScopeBinding,
): IAgentCommandExecutionScope {
    return {
        windowId: binding.windowId,
        tabId: binding.tabId,
        documentRef: binding.documentRef,
        ...(binding.documentBackend === undefined ? {} : {documentBackend: binding.documentBackend}),
        documentInstanceId: binding.documentInstanceId ?? null,
        documentIdentity: binding.documentIdentity,
        ...(binding.commandTarget === undefined ? {} : {commandTarget: {...binding.commandTarget}}),
    };
}

function commandTargetsMatch(
    expected: TAgentWorkspaceCommandTarget,
    actual: TAgentWorkspaceCommandTarget | undefined,
) {
    if (!actual) {
        return false;
    }

    if (
        expected.kind !== actual.kind
        || expected.tabId !== actual.tabId
        || expected.sessionId !== actual.sessionId
        || expected.documentRef !== actual.documentRef
        || expected.documentBackend !== actual.documentBackend
        || (expected.documentInstanceId ?? null) !== (actual.documentInstanceId ?? null)
        || expected.documentRevisionToken !== actual.documentRevisionToken
    ) {
        return false;
    }

    return expected.kind === 'transaction'
        ? actual.kind === 'transaction' && expected.transactionId === actual.transactionId
        : actual.kind === 'revision' && expected.sessionRevision === actual.sessionRevision;
}
