import type { IAgentAssistantChatScope } from '@contracts/agent';
import type {
    IAssistantChatSession,
    TAssistantChatSessionStore,
} from '@electron/features/agent/assistantChatSessionStore';
import {
    claimAssistantTurn,
    completeAssistantTurn,
    errorAssistantTurn,
    getAssistantTurnScope,
    isAssistantTurnActive,
    markAssistantTurnInterrupting,
    markAssistantTurnRunning,
    supersedeAssistantTurn,
    type ICompleteAssistantTurnOptions,
    type IAssistantSessionScopeBinding,
} from '@electron/features/agent/assistantTurnLifecycle';
import { syncAssistantMcpSessionScope } from '@electron/features/agent/assistantMcpSessionScope';
import {requireTabId} from '@contracts/windowTabs';

interface IAssistantSessionTurnCoordinatorOptions {
    sessionStore: TAssistantChatSessionStore;
    onTurnStateChanged?: () => void;
}

export function createAssistantSessionTurnCoordinator(options: IAssistantSessionTurnCoordinatorOptions) {
    function createAssistantSessionScopeBinding(
        session: IAssistantChatSession,
    ): Omit<IAssistantSessionScopeBinding, 'turnGeneration'> {
        const tabId = session.scope.tabId;
        if (tabId === undefined || tabId === null) {
            throw new Error('Assistant turns require a bound document tab.');
        }
        return {
            sessionKey: options.sessionStore.keyForSession(session),
            scopeKey: session.scope.key,
            provider: session.provider,
            windowId: session.lastSenderWindowId ?? -1,
            tabId: requireTabId(tabId),
            documentSessionKey: session.scope.documentSessionKey ?? null,
            documentRef: session.scope.documentRef ?? null,
            ...(session.scope.documentBackend === undefined ? {} : {documentBackend: session.scope.documentBackend}),
            documentInstanceId: session.scope.documentInstanceId ?? null,
            documentIdentity: session.scope.documentIdentity ?? null,
            ...(session.scope.commandTarget === undefined ? {} : {commandTarget: {...session.scope.commandTarget}}),
        };
    }

    function syncSessionTurnScope(session: IAssistantChatSession) {
        session.scopeBinding = getAssistantTurnScope(session.turnOwner);
        syncAssistantMcpSessionScope(options.sessionStore.keyForSession(session), session.scopeBinding);
    }

    function claimSessionTurn(session: IAssistantChatSession) {
        session.turnOwner = claimAssistantTurn(session.turnOwner, createAssistantSessionScopeBinding(session));
        session.turnPresentation = {
            phase: 'queued',
            reasoning: '',
            toolActivity: [],
            lastEventAtMs: Date.now(),
            usage: null,
        };
        syncSessionTurnScope(session);
        options.sessionStore.recordTurnBoundary(session);
        options.onTurnStateChanged?.();
        return session.turnOwner.generation;
    }

    function markSessionTurnRunning(
        session: IAssistantChatSession,
        generation: number,
        providerTurnId: string | null,
    ) {
        const previousOwner = session.turnOwner;
        session.turnOwner = markAssistantTurnRunning(session.turnOwner, generation, providerTurnId);
        syncSessionTurnScope(session);
        if (session.turnOwner !== previousOwner) {
            options.sessionStore.recordTurnBoundary(session);
            options.onTurnStateChanged?.();
        }
        return session.turnOwner !== previousOwner;
    }

    function settleSessionTurn(
        session: IAssistantChatSession,
        nextOwner: IAssistantChatSession['turnOwner'],
        phase: 'done' | 'failed',
    ) {
        const previousOwner = session.turnOwner;
        session.turnOwner = nextOwner;
        if (session.turnOwner !== previousOwner) {
            session.turnPresentation.phase = phase;
            session.turnPresentation.lastEventAtMs = Date.now();
        }
        syncSessionTurnScope(session);
        if (session.turnOwner !== previousOwner) {
            options.sessionStore.recordTurnBoundary(session);
            options.onTurnStateChanged?.();
        }
        return session.turnOwner !== previousOwner;
    }

    function completeSessionTurn(
        session: IAssistantChatSession,
        generation: number,
        providerTurnId?: string | null,
        completeOptions?: ICompleteAssistantTurnOptions,
    ) {
        return settleSessionTurn(
            session,
            completeAssistantTurn(session.turnOwner, generation, providerTurnId, completeOptions),
            'done',
        );
    }

    function errorSessionTurn(
        session: IAssistantChatSession,
        generation: number,
        error: string,
        providerTurnId?: string | null,
    ) {
        return settleSessionTurn(
            session,
            errorAssistantTurn(session.turnOwner, generation, error, providerTurnId),
            'failed',
        );
    }

    function supersedeSessionTurnWithError(session: IAssistantChatSession, error: string) {
        const supersededOwner = supersedeAssistantTurn(session.turnOwner);
        session.turnOwner = errorAssistantTurn(supersededOwner, supersededOwner.generation, error);
        syncSessionTurnScope(session);
        options.sessionStore.recordTurnBoundary(session);
        options.onTurnStateChanged?.();
    }

    function transitionSessionTurn(
        session: IAssistantChatSession,
        nextOwner: IAssistantChatSession['turnOwner'],
        phase: 'interrupting' | 'cancelled',
    ) {
        const previousOwner = session.turnOwner;
        session.turnOwner = nextOwner;
        session.turnPresentation.phase = phase;
        session.turnPresentation.lastEventAtMs = Date.now();
        syncSessionTurnScope(session);
        options.sessionStore.recordTurnBoundary(session);
        if (session.turnOwner !== previousOwner) {
            options.onTurnStateChanged?.();
        }
    }

    function interruptSessionTurn(session: IAssistantChatSession) {
        transitionSessionTurn(session, markAssistantTurnInterrupting(session.turnOwner), 'interrupting');
    }

    function supersedeSessionTurn(session: IAssistantChatSession) {
        transitionSessionTurn(session, supersedeAssistantTurn(session.turnOwner), 'cancelled');
    }

    function releaseClaimedSessionTurn(session: IAssistantChatSession, generation: number) {
        if (session.turnOwner.generation !== generation || !isAssistantTurnActive(session.turnOwner)) {
            return;
        }
        supersedeSessionTurn(session);
    }

    function rememberStateScope(
        scope: IAgentAssistantChatScope | null,
        selection = options.sessionStore.getRememberedSelection(),
    ) {
        options.sessionStore.rememberStateScope(scope, selection);
    }

    return {
        claimSessionTurn,
        completeSessionTurn,
        errorSessionTurn,
        interruptSessionTurn,
        markSessionTurnRunning,
        rememberStateScope,
        releaseClaimedSessionTurn,
        supersedeSessionTurn,
        supersedeSessionTurnWithError,
    };
}
