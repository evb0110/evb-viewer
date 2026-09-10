import type {
    IAgentAssistantChatScope,
    IAgentAssistantEvent,
    IAgentAssistantStatus,
} from '@contracts/agent';
import { buildAgentAssistantScopeFingerprint } from '@contracts/agent';
import { isRecord } from '@contracts/runtimeGuards';
import type {
    IAssistantChatSession,
    TAssistantChatSessionStore,
} from '@electron/features/agent/assistantChatSessionStore';
import type { IAssistantProviderRuntimeState } from '@electron/features/agent/assistantProviderState';
import type { IAssistantSelection } from '@electron/features/agent/assistantProviderStatus';
import {
    canCompleteAssistantTurnWithoutProviderTurn,
    buildAssistantSessionScopeBindingFingerprint,
    getAssistantTurnPhase,
    getAssistantTurnProviderTurnId,
    getAssistantTurnScope,
    type ICompleteAssistantTurnOptions,
    isAssistantTurnActive,
} from '@electron/features/agent/assistantTurnLifecycle';
import type { ICodexAppServerNotification } from '@electron/features/agent/codexAppServerClient';
import {
    focusAssistantReturnWindow,
    type TAssistantReturnWindow,
} from '@electron/features/agent/assistantReturnWindow';

interface IAssistantAppServerNotificationsLogger { info(message: string): void; }

interface IAssistantAppServerNotificationsOptions {
    addMessage: (
        session: IAssistantChatSession,
        message: Parameters<TAssistantChatSessionStore['addMessage']>[1],
    ) => unknown;
    appendAssistantDelta: (session: IAssistantChatSession, messageId: string, delta: string) => void;
    clearLoginState: () => void;
    clearRuntimeForExit: () => void;
    codexProviderRuntime: IAssistantProviderRuntimeState;
    completeSessionTurn: (
        session: IAssistantChatSession,
        generation: number,
        providerTurnId?: string | null,
        completeOptions?: ICompleteAssistantTurnOptions,
    ) => boolean;
    currentCodexSelection: () => IAssistantSelection;
    getPendingLoginId: () => string | null;
    errorSessionTurn: (
        session: IAssistantChatSession,
        generation: number,
        error: string,
        providerTurnId?: string | null,
    ) => boolean;
    getActiveChatSession: () => IAssistantChatSession | null;
    getAuthReturnWindow: () => TAssistantReturnWindow;
    getChatSessionByThreadId: (threadId: string | null) => IAssistantChatSession | null;
    getRememberedScope: () => IAgentAssistantChatScope | null;
    logger: IAssistantAppServerNotificationsLogger;
    markSessionTurnRunning: (
        session: IAssistantChatSession,
        generation: number,
        providerTurnId: string | null,
    ) => boolean;
    noFocus: boolean;
    publishAssistantEvent: (
        event: IAgentAssistantEvent,
        scope?: IAgentAssistantChatScope | null,
        selection?: IAssistantSelection,
    ) => void;
    publishState: (scope?: IAgentAssistantChatScope | null, selection?: IAssistantSelection) => void;
    reconcileFailedTurnMessages: (session: IAssistantChatSession, errorMessage: string) => void;
    refreshAuthStateAndRuntimeAvailability: (options?: { recoverFromError?: boolean }) => Promise<void>;
    sessionStore: Pick<TAssistantChatSessionStore, 'listSessions' | 'recordSessionSnapshot' | 'setActiveSession'>;
    supersedeSessionTurn: (session: IAssistantChatSession) => void;
    upsertAssistantMessage: (
        session: IAssistantChatSession,
        id: string,
        patch: Parameters<TAssistantChatSessionStore['upsertAssistantMessage']>[2],
    ) => unknown;
}

function getStringParam(params: unknown, key: string) {
    return isRecord(params) && typeof params[key] === 'string'
        ? params[key]
        : null;
}

function getThreadItem(params: unknown) {
    return isRecord(params) && isRecord(params.item) ? params.item : null;
}

function getNotificationThreadId(params: unknown) {
    if (!isRecord(params)) {
        return null;
    }
    if (typeof params.threadId === 'string') {
        return params.threadId;
    }
    if (isRecord(params.thread) && typeof params.thread.id === 'string') {
        return params.thread.id;
    }
    return null;
}

function getNotificationTurnId(params: unknown) {
    if (!isRecord(params)) {
        return null;
    }
    if (typeof params.turnId === 'string') {
        return params.turnId;
    }
    if (isRecord(params.turn) && typeof params.turn.id === 'string') {
        return params.turn.id;
    }
    if (isRecord(params.item) && typeof params.item.turnId === 'string') {
        return params.item.turnId;
    }
    return null;
}

function isCodexTurnNotification(method: string) {
    return method === 'turn/started'
        || method === 'turn/completed'
        || method === 'item/created'
        || method === 'item/updated'
        || method === 'item/agentMessage/delta'
        || method.includes('reasoning')
        || method === 'item/completed'
        || method === 'error';
}

function getNotificationDelta(params: unknown) {
    return getStringParam(params, 'delta')
        ?? getStringParam(params, 'textDelta')
        ?? getStringParam(params, 'summaryTextDelta');
}

function getNestedString(value: unknown, path: readonly string[]) {
    let current = value;
    for (const key of path) {
        if (!isRecord(current)) {
            return null;
        }
        current = current[key];
    }
    return typeof current === 'string' && current.trim().length > 0
        ? current.trim()
        : null;
}

function getNestedNumber(value: unknown, path: readonly string[]) {
    let current = value;
    for (const key of path) {
        if (!isRecord(current)) {
            return null;
        }
        current = current[key];
    }
    return typeof current === 'number' && Number.isFinite(current) ? current : null;
}

function getThreadItemType(item: Record<string, unknown>) {
    const type = typeof item.type === 'string' ? item.type.trim() : '';
    return type.length > 0 ? type : null;
}

function getThreadItemToolName(item: Record<string, unknown>) {
    return getNestedString(item, ['name'])
        ?? getNestedString(item, ['toolName'])
        ?? getNestedString(item, ['title'])
        ?? getNestedString(item, [
            'tool',
            'name',
        ])
        ?? getNestedString(item, [
            'call',
            'name',
        ])
        ?? getNestedString(item, [
            'function',
            'name',
        ]);
}

function formatAssistantToolActivity(toolName: string | null, completed: boolean) {
    const suffix = completed ? 'completed' : 'running';
    return toolName
        ? `Tool ${toolName} ${suffix}`
        : `Tool ${suffix}`;
}

function getSafeAssistantTurnProgress(method: string, params: unknown) {
    const item = getThreadItem(params);
    if (!item) {
        return null;
    }

    const itemType = getThreadItemType(item);
    if (itemType === 'agentMessage') {
        return null;
    }

    const completed = method === 'item/completed';
    const normalizedType = itemType?.toLowerCase() ?? '';
    if (normalizedType.includes('tool') || normalizedType.includes('call')) {
        return formatAssistantToolActivity(getThreadItemToolName(item), completed);
    }
    if (normalizedType.includes('reason')) {
        return null;
    }
    if (normalizedType.includes('mcp')) {
        return formatAssistantToolActivity(getThreadItemToolName(item), completed);
    }
    return completed ? 'Assistant is continuing' : 'Assistant is still working';
}

export function createAssistantAppServerNotificationController(options: IAssistantAppServerNotificationsOptions) {
    function recordTurnEvent(session: IAssistantChatSession) {
        session.turnPresentation.lastEventAtMs = Date.now();
    }

    function shouldIgnoreThreadNotification(method: string, params: unknown) {
        const notificationThreadId = getNotificationThreadId(params);
        if (!notificationThreadId) {
            return false;
        }
        if (method === 'thread/started') {
            return false;
        }
        return !options.getChatSessionByThreadId(notificationThreadId);
    }

    function getNotificationChatSession(params: unknown) {
        return options.getChatSessionByThreadId(getNotificationThreadId(params));
    }

    function shouldDropNotificationForTurn(
        session: IAssistantChatSession,
        params: unknown,
        bindOptions: Parameters<typeof bindNotificationTurn>[2] = {},
    ) {
        const turnId = getNotificationTurnId(params);
        return !bindNotificationTurn(session, turnId, bindOptions);
    }

    function isActiveTurnScopeCurrent(session: IAssistantChatSession) {
        const turnScope = getAssistantTurnScope(session.turnOwner);
        return !turnScope
            || buildAssistantSessionScopeBindingFingerprint(turnScope)
                === buildAgentAssistantScopeFingerprint(session.provider, session.scope);
    }

    function bindNotificationTurn(
        session: IAssistantChatSession,
        turnId: string | null,
        optionsOverride: {
            emitStartedEvent?: boolean;
            allowStaleScope?: boolean;
        } = {},
    ) {
        const allowStaleScope = optionsOverride.allowStaleScope ?? false;
        if (turnId === null) {
            return isAssistantTurnActive(session.turnOwner)
                && (allowStaleScope || isActiveTurnScopeCurrent(session));
        }

        const activeProviderTurnId = getAssistantTurnProviderTurnId(session.turnOwner);
        if (activeProviderTurnId === turnId) {
            return allowStaleScope || isActiveTurnScopeCurrent(session);
        }
        if (activeProviderTurnId !== null || !isAssistantTurnActive(session.turnOwner)) {
            return false;
        }
        if (!isActiveTurnScopeCurrent(session)) {
            return false;
        }

        const generation = session.turnOwner.generation;
        if (!options.markSessionTurnRunning(session, generation, turnId)) {
            return getAssistantTurnProviderTurnId(session.turnOwner) === turnId;
        }

        options.sessionStore.setActiveSession(session);
        options.codexProviderRuntime.runtimeState = 'busy';
        if (optionsOverride.emitStartedEvent ?? true) {
            options.publishAssistantEvent({
                type: 'turn-started',
                turnId,
            }, session.scope, session);
        }
        return true;
    }

    function handleNotification(notification: ICodexAppServerNotification) {
        const method = typeof notification.method === 'string' ? notification.method : '';
        const params = notification.params;
        if (shouldIgnoreThreadNotification(method, params)) {
            options.logger.info(`Ignoring stale assistant notification for inactive thread: ${method}`);
            return;
        }

        if (method === 'account/login/completed') {
            const loginId = getStringParam(params, 'loginId');
            const pendingLoginId = options.getPendingLoginId();
            if (pendingLoginId === null || loginId !== pendingLoginId) {
                options.logger.info('Ignoring assistant login completion for a non-current login attempt.');
                return;
            }
            const success = isRecord(params) && params.success === true;
            const error = isRecord(params) && typeof params.error === 'string' ? params.error : null;
            if (success) {
                focusAssistantReturnWindow(options.getAuthReturnWindow(), { noFocus: options.noFocus });
            }
            options.clearLoginState();
            options.codexProviderRuntime.authState = success ? 'signed-in' : 'signed-out';
            if (success) {
                delete options.codexProviderRuntime.lastError;
            } else {
                options.codexProviderRuntime.lastError = error ?? 'ChatGPT sign-in failed.';
            }
            void options.refreshAuthStateAndRuntimeAvailability({ recoverFromError: success }).finally(options.publishState);
            return;
        }

        if (method === 'account/updated') {
            void options.refreshAuthStateAndRuntimeAvailability().finally(options.publishState);
            return;
        }

        if (isCodexTurnNotification(method) && !getNotificationThreadId(params)) {
            options.logger.info(`Ignoring assistant notification without thread id: ${method}`);
            return;
        }

        if (method === 'turn/started') {
            const session = getNotificationChatSession(params);
            if (!session) {
                return;
            }
            const turnId = getNotificationTurnId(params);
            const turnAlreadyBound = turnId !== null && getAssistantTurnProviderTurnId(session.turnOwner) === turnId;
            if (!bindNotificationTurn(session, turnId, { emitStartedEvent: false })) {
                options.logger.info(`Ignoring stale assistant turn start: ${method}`);
                return;
            }
            options.sessionStore.setActiveSession(session);
            options.codexProviderRuntime.runtimeState = 'busy';
            session.turnPresentation.phase = 'thinking';
            recordTurnEvent(session);
            if (!turnAlreadyBound) {
                options.publishAssistantEvent({
                    type: 'turn-started',
                    ...(turnId ? { turnId } : {}),
                }, session.scope, session);
            }
            return;
        }

        if (method === 'turn/completed') {
            const session = getNotificationChatSession(params);
            if (!session) {
                return;
            }
            const turnId = getNotificationTurnId(params);
            const inputTokens = getNestedNumber(params, [
                'turn',
                'usage',
                'inputTokens',
            ])
                ?? getNestedNumber(params, [
                    'usage',
                    'inputTokens',
                ]);
            const outputTokens = getNestedNumber(params, [
                'turn',
                'usage',
                'outputTokens',
            ])
                ?? getNestedNumber(params, [
                    'usage',
                    'outputTokens',
                ]);
            const usage = inputTokens !== null && outputTokens !== null
                ? (() => {
                    const cachedInputTokens = getNestedNumber(params, [
                        'turn',
                        'usage',
                        'cachedInputTokens',
                    ])
                        ?? getNestedNumber(params, [
                            'usage',
                            'cachedInputTokens',
                        ]);
                    return {
                        inputTokens,
                        outputTokens,
                        ...(cachedInputTokens === null ? {} : {cachedInputTokens}),
                    };
                })()
                : null;
            if (!bindNotificationTurn(session, turnId, {allowStaleScope: true})) {
                options.logger.info('Ignoring stale assistant turn completion.');
                return;
            }
            const allowStartingWithoutProviderTurn = turnId === null
                && getAssistantTurnProviderTurnId(session.turnOwner) === null
                && getAssistantTurnPhase(session.turnOwner) === 'queued';
            if (
                turnId === null
                && !allowStartingWithoutProviderTurn
                && !canCompleteAssistantTurnWithoutProviderTurn(session.turnOwner)
            ) {
                options.logger.info('Ignoring assistant turn completion without active running turn.');
                return;
            }
            if (!options.completeSessionTurn(
                session,
                session.turnOwner.generation,
                turnId,
                {allowStartingWithoutProviderTurn},
            )) {
                options.logger.info('Ignoring stale assistant turn completion.');
                return;
            }
            if (usage) {
                session.turnPresentation.usage = usage;
            }
            options.codexProviderRuntime.runtimeState = 'ready';
            for (const message of session.messages) {
                if (message.role === 'assistant' && message.pending) {
                    message.pending = false;
                }
            }
            options.sessionStore.recordSessionSnapshot(session);
            options.publishAssistantEvent({ type: 'turn-completed' }, session.scope, session);
            return;
        }

        if (method.includes('reasoning') && method.toLowerCase().includes('delta')) {
            const session = getNotificationChatSession(params);
            if (!session || shouldDropNotificationForTurn(session, params)) {
                return;
            }
            const reasoningDelta = getNotificationDelta(params);
            if (!reasoningDelta) {
                return;
            }
            session.turnPresentation.phase = 'thinking';
            session.turnPresentation.reasoning += reasoningDelta;
            recordTurnEvent(session);
            options.publishAssistantEvent({
                type: 'reasoning-delta',
                reasoningDelta,
                phase: 'thinking',
                ...(session.turnPresentation.lastEventAtMs === null
                    ? {}
                    : {lastEventAtMs: session.turnPresentation.lastEventAtMs}),
            }, session.scope, session);
            return;
        }

        if (method === 'item/agentMessage/delta') {
            const session = getNotificationChatSession(params);
            if (!session) {
                return;
            }
            if (shouldDropNotificationForTurn(session, params)) {
                options.logger.info('Ignoring stale assistant message delta.');
                return;
            }
            const itemId = getStringParam(params, 'itemId');
            const delta = getStringParam(params, 'delta');
            if (options.codexProviderRuntime.runtimeState === 'busy') {
                options.markSessionTurnRunning(session, session.turnOwner.generation, getAssistantTurnProviderTurnId(session.turnOwner));
            }
            session.turnPresentation.phase = 'streaming';
            recordTurnEvent(session);
            options.publishAssistantEvent({
                type: 'turn-progress',
                progress: 'Receiving assistant response',
            }, session.scope, session);
            if (itemId && delta) {
                options.appendAssistantDelta(session, itemId, delta);
            }
            return;
        }

        if (method === 'item/created' || method === 'item/updated') {
            const session = getNotificationChatSession(params);
            if (!session) {
                return;
            }
            if (shouldDropNotificationForTurn(session, params)) {
                options.logger.info('Ignoring stale assistant item progress.');
                return;
            }
            const progress = getSafeAssistantTurnProgress(method, params);
            const item = getThreadItem(params);
            const itemType = item ? getThreadItemType(item)?.toLowerCase() ?? '' : '';
            if (item && (itemType.includes('tool') || itemType.includes('call') || itemType.includes('mcp'))) {
                const name = getThreadItemToolName(item) ?? 'tool';
                const toolId = typeof item.id === 'string' ? item.id : `${name}:${session.turnOwner.generation}`;
                const activity = {
                    toolId,
                    name,
                    phase: 'running' as const,
                    startedAtMs: Date.now(),
                };
                const existing = session.turnPresentation.toolActivity.findIndex(value => value.toolId === toolId);
                if (existing >= 0) {
                    session.turnPresentation.toolActivity[existing] = activity;
                } else {
                    session.turnPresentation.toolActivity.push(activity);
                }
                session.turnPresentation.phase = 'tool-running';
                recordTurnEvent(session);
                options.publishAssistantEvent({
                    type: 'turn-progress',
                    phase: 'tool-running',
                    toolActivity: activity,
                }, session.scope, session);
            }
            if (progress) {
                options.publishAssistantEvent({
                    type: 'turn-progress',
                    progress,
                }, session.scope, session);
            }
            return;
        }

        if (method === 'item/completed') {
            const session = getNotificationChatSession(params);
            if (!session) {
                return;
            }
            if (shouldDropNotificationForTurn(session, params)) {
                options.logger.info('Ignoring stale assistant message completion.');
                return;
            }
            const item = getThreadItem(params);
            if (item?.type === 'agentMessage' && typeof item.id === 'string' && typeof item.text === 'string') {
                options.upsertAssistantMessage(session, item.id, {
                    text: item.text,
                    pending: false,
                });
            } else {
                const name = item ? getThreadItemToolName(item) ?? 'tool' : 'tool';
                const toolId = item && typeof item.id === 'string' ? item.id : `${name}:${session.turnOwner.generation}`;
                const existing = session.turnPresentation.toolActivity.find(value => value.toolId === toolId);
                if (existing) {
                    existing.phase = 'completed';
                    existing.completedAtMs = Date.now();
                }
                session.turnPresentation.phase = 'finalizing';
                recordTurnEvent(session);
                const progress = getSafeAssistantTurnProgress(method, params);
                if (progress) {
                    options.publishAssistantEvent({
                        type: 'turn-progress',
                        progress,
                    }, session.scope, session);
                }
            }
            return;
        }

        if (method === 'error') {
            const session = getNotificationChatSession(params);
            const errorMessage = isRecord(params) && isRecord(params.error) && typeof params.error.message === 'string'
                && params.error.message.trim().length > 0
                ? params.error.message.trim()
                : 'Codex assistant turn failed.';
            if (session) {
                if (shouldDropNotificationForTurn(session, params, {allowStaleScope: true})) {
                    options.logger.info('Ignoring stale assistant error notification.');
                    return;
                }
                options.codexProviderRuntime.lastError = errorMessage;
                session.lastError = errorMessage;
                options.errorSessionTurn(
                    session,
                    session.turnOwner.generation,
                    errorMessage,
                    getNotificationTurnId(params),
                );
            } else {
                options.codexProviderRuntime.lastError = errorMessage;
            }
            options.codexProviderRuntime.runtimeState = 'error';
            if (session) {
                options.reconcileFailedTurnMessages(session, errorMessage);
                options.addMessage(session, {
                    role: 'system',
                    text: errorMessage,
                    error: errorMessage,
                });
            }
            options.publishAssistantEvent({
                type: 'error',
                error: errorMessage,
            }, session?.scope ?? options.getRememberedScope(), session ?? options.currentCodexSelection());
        }
    }

    function handleExit(message: string) {
        const session = options.getActiveChatSession();
        options.clearRuntimeForExit();
        options.codexProviderRuntime.runtimeState = 'error';
        for (const chatSession of options.sessionStore.listSessions()) {
            if (chatSession.provider !== 'codex') {
                continue;
            }
            options.supersedeSessionTurn(chatSession);
        }
        options.codexProviderRuntime.runtimeState = 'error';
        if (session) {
            options.errorSessionTurn(session, session.turnOwner.generation, message);
            session.lastError = message;
            options.sessionStore.recordSessionSnapshot(session);
        }
        options.codexProviderRuntime.lastError = message;
        options.publishAssistantEvent({
            type: 'error',
            error: message,
        }, session?.scope ?? options.getRememberedScope(), session ?? options.currentCodexSelection());
    }

    function createBaseMcpStatusWithToolCount(
        provider: IAssistantSelection['provider'],
        base: IAgentAssistantStatus['mcp'],
        codexToolCount: number,
        claudeToolCount: number,
    ) {
        return {
            ...base,
            toolCount: provider === 'claude' ? claudeToolCount : codexToolCount,
        };
    }

    return {
        createBaseMcpStatusWithToolCount,
        handleExit,
        handleNotification,
    };
}
