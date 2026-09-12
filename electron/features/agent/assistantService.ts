import { config } from '@electron/config';
import type {
    IAgentAssistantChatScope,
    IAgentAssistantEvent,
    IAgentAssistantModelOption,
    IAgentAssistantScopedRequest,
    IAgentAssistantSendMessageRequest,
    IAgentAssistantSendMessageResult,
    IAgentAssistantState,
    IAgentAssistantStateRequest,
    IAgentAssistantStatus,
    TAgentAssistantEffort,
    TAgentAssistantProviderId,
    TAgentAssistantSpeedMode,
} from '@contracts/agent';
import { buildAgentAssistantScopeFingerprint } from '@contracts/agent';
import { isRecord } from '@contracts/runtimeGuards';
import {
    ASSISTANT_DEFAULT_EFFORT,
    ASSISTANT_DEFAULT_SPEED_MODE,
    CODEX_ASSISTANT_FALLBACK_MODELS,
} from '@contracts/agentModels';
import {
    CLAUDE_AGENT_MODELS,
    isClaudeAuthErrorMessage,
    getClaudeAgentSdkInfo,
    detectClaudeAuthState,
    shouldRefuseClaudeContextContinuation,
    shouldUseClaudeAssistantFastMode,
    normalizeClaudeAssistantModel,
} from '@electron/features/agent/claudeProviderMetadata';
import type { IClaudeAssistantProviderInfo } from '@electron/features/agent/claudeProviderMetadata';
import type {
    IClaudeAgentAssistantInit,
    IClaudeAgentAssistantSessionOptions,
} from '@electron/features/agent/claudeAgentSdkAssistant';
import { createClaudeTurnPresentationCallbacks } from '@electron/features/agent/createClaudeTurnPresentationCallbacks';
import {
    ASSISTANT_IMAGE_ONLY_PROMPT,
    ASSISTANT_MCP_SERVER_NAME,
} from '@electron/features/agent/codexAssistantConfig';
import {isCodexAppServerRequestTimeoutError} from '@electron/features/agent/codexAppServerClient';
import type { TCodexAssistantModelOption } from '@electron/features/agent/assistantModelCatalog';
import {
    codexDefaultModelId,
    normalizeAssistantEffort,
    normalizeAssistantSpeedMode,
    normalizeCodexAssistantModel,
    resolveAssistantSelection,
    resolveCodexServiceTier,
    type IAssistantSelection,
} from '@electron/features/agent/assistantProviderStatus';
import {
    createAssistantProviderRuntimeStates,
    getAssistantProviderRuntimeState,
} from '@electron/features/agent/assistantProviderState';
import { normalizeClaudeAssistantAccount } from '@electron/features/agent/assistantProviderAccounts';
import { withAssistantErrorEnvelope } from '@electron/features/agent/assistantErrorEnvelope';
import { normalizeOutgoingMessageRequest } from '@electron/features/agent/assistantOutgoingMessage';
import {
    createAssistantChatSessionStore,
    normalizeAssistantScope,
    type IAssistantChatSession,
} from '@electron/features/agent/assistantChatSessionStore';
import {
    createAssistantFeatureLifecycle,
    createAssistantRuntimeLifecycle,
    createBaseAssistantMcpStatus,
    ensureAssistantCwd,
} from '@electron/features/agent/assistantRuntimeLifecycle';
import {
    buildAssistantSessionScopeBindingFingerprint,
    getAssistantTurnProviderTurnId,
    getAssistantTurnScope,
    isAssistantTurnActive,
    matchesProviderTurn,
} from '@electron/features/agent/assistantTurnLifecycle';
import { getActiveAssistantMcpSessionScope } from '@electron/features/agent/assistantMcpSessionScope';
import { buildAgentAssistantStateSnapshot } from '@electron/features/agent/buildAgentAssistantStateSnapshot';
import { createAssistantSessionTurnCoordinator } from '@electron/features/agent/createAssistantSessionTurnCoordinator';
import {
    createAssistantHeartbeatController,
    waitForBoundedAssistantInterrupt,
} from '@electron/features/agent/assistantTurnLiveness';
import { runAssistantShutdownStep } from '@electron/features/agent/runAssistantShutdownStep';
import {
    createAssistantBusyResult,
    createAssistantDisabledError,
    createAssistantDisabledResult,
    getAssistantTurnBusyError,
} from '@electron/features/agent/assistantResultHelpers';
import { createAssistantAppServerNotificationController } from '@electron/features/agent/createAssistantAppServerNotificationController';
import { createAssistantEventPublisher } from '@electron/features/agent/createAssistantEventPublisher';
import { resolveAssistantPresetInstructions } from '@electron/features/agent/assistantPresetWorkflows';
import type { TAssistantReturnWindow } from '@electron/features/agent/assistantReturnWindow';
import { createCodexAssistantAdapter } from '@electron/features/agent/createCodexAssistantAdapter';
import {
    abortActiveEmbeddedMcpRequests,
    shutdownEmbeddedMcpServer,
    startEmbeddedMcpServer,
} from '@electron/features/agent/mcpServer';
import { loadSettings } from '@electron/settings';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';
const logger = createLogger('agent-assistant-service');
const ASSISTANT_TURN_CANCELLED_ERROR = 'Assistant turn was canceled before provider setup completed.';
const CLAUDE_CONTEXT_UNAVAILABLE_ERROR = 'Claude cannot continue this chat because its provider context is unavailable. Start a new chat to continue.';

class AssistantTurnSupersededError extends Error {
    readonly subsystem = 'agent';

    constructor() {
        super(ASSISTANT_TURN_CANCELLED_ERROR);
    }
}
export interface IAgentAssistantSendMessageOptions { windowId?: number | null; }
let codexAssistantModels: readonly TCodexAssistantModelOption[] = CODEX_ASSISTANT_FALLBACK_MODELS;
let claudeAssistantModels: readonly IAgentAssistantModelOption[] = CLAUDE_AGENT_MODELS;
const providerRuntimeStates = createAssistantProviderRuntimeStates();
const codexProviderRuntime = getAssistantProviderRuntimeState(providerRuntimeStates, 'codex');
const claudeProviderRuntime = getAssistantProviderRuntimeState(providerRuntimeStates, 'claude');
let claudeInfoCache: IClaudeAssistantProviderInfo | null = null;
let pendingLoginId: string | null = null;
let authReturnWindow: TAssistantReturnWindow = null;
interface IClaudeRuntimeModule {ClaudeAgentAssistantSession: new (options: IClaudeAgentAssistantSessionOptions) => NonNullable<IAssistantChatSession['claudeSession']>;}
let claudeRuntimeModulePromise: Promise<IClaudeRuntimeModule> | null = null;
async function loadClaudeRuntimeModule() {
    claudeRuntimeModulePromise ??= import('@electron/features/agent/claudeAgentSdkAssistant') as Promise<IClaudeRuntimeModule>;
    return claudeRuntimeModulePromise;
}

const sessionStore = createAssistantChatSessionStore({
    onSessionDeleted: (session: IAssistantChatSession, reason: string) => {
        const currentRuntime = runtimeLifecycle.getRuntime();
        if (session.provider === 'codex' && currentRuntime && session.providerThreadId) {
            void currentRuntime.client.request('thread/archive', { threadId: session.providerThreadId }).catch((error: unknown) => {
                logger.warn(`Failed to archive ${reason} assistant thread: ${getErrorMessage(error)}`);
            });
        }
        if (session.provider === 'claude' && session.claudeSession) {
            void session.claudeSession.close().catch((error: unknown) => {
                logger.warn(`Failed to close ${reason} Claude assistant session: ${getErrorMessage(error)}`);
            });
        }
    },
    onSessionMessageEvent: (event: IAgentAssistantEvent, session: IAssistantChatSession) => {
        publishAssistantEvent(event, session.scope, session);
    },
});
const runtimeLifecycle = createAssistantRuntimeLifecycle({
    providerRuntime: codexProviderRuntime,
    sessionStore,
    getCodexModels: () => codexAssistantModels,
    setCodexModels: (models: readonly TCodexAssistantModelOption[]) => {
        codexAssistantModels = models;
    },
    isAssistantFeatureEnabled,
    createAssistantDisabledError,
    shutdownAssistant: () => shutdownAgentAssistant(),
    settleCodexTurn: (session, reason) => {
        abortActiveEmbeddedMcpRequests(
            session.scopeBinding ?? getAssistantTurnScope(session.turnOwner),
            reason,
        );
        for (const message of session.messages) {
            if (message.role === 'assistant' && message.pending) {
                message.pending = false;
            }
        }
        supersedeSessionTurn(session);
        sessionStore.recordSessionSnapshot(session);
        publishAssistantEvent({type: 'turn-completed'}, session.scope, session);
    },
    publishCodexState: (
        scope: IAgentAssistantChatScope | null | undefined,
        selection: IAssistantSelection | undefined,
    ) => publishState(
        scope === undefined ? sessionStore.getRememberedScope() : scope,
        selection ?? currentCodexSelection(),
    ),
    handleNotification: notification => appServerNotifications.handleNotification(notification),
    handleExit: message => appServerNotifications.handleExit(message),
    logger,
});
const assistantFeatureLifecycle = createAssistantFeatureLifecycle({
    isEnabled: isAssistantFeatureEnabled,
    createDisabledError: createAssistantDisabledError,
});
let syncAssistantHeartbeat = () => {};
const {
    claimSessionTurn,
    completeSessionTurn,
    errorSessionTurn,
    interruptSessionTurn,
    markSessionTurnRunning,
    rememberStateScope,
    releaseClaimedSessionTurn,
    supersedeSessionTurn,
    supersedeSessionTurnWithError,
} = createAssistantSessionTurnCoordinator({
    sessionStore,
    onTurnStateChanged: () => syncAssistantHeartbeat(),
});
async function isAssistantFeatureEnabled() {
    const settings = await loadSettings();
    return settings.assistantPanelEnabled;
}

async function stopAssistantForDisabledFeature() {
    await shutdownAgentAssistant();
    const error = createAssistantDisabledError();
    codexProviderRuntime.lastError = error;
    codexProviderRuntime.runtimeState = 'stopped';
    return error;
}

async function shutdownClaudeAssistantRuntime(options: { shutdownMcp?: boolean } = {}) {
    const closePromises: Array<Promise<void>> = [];
    for (const session of sessionStore.listSessions()) {
        if (session.provider !== 'claude') {
            continue;
        }
        if (session.claudeSession) {
            closePromises.push(session.claudeSession.close());
        }
        session.claudeSession = undefined;
        session.providerThreadId = null;
    }
    await Promise.allSettled(closePromises);
    claudeProviderRuntime.runtimeState = 'stopped';
    claudeMcpToolCount = 0;
    sessionStore.clearActiveSessionForProvider('claude');
    if (options.shutdownMcp === true) {
        await shutdownEmbeddedMcpServer();
    }
}

function hasConflictingAssistantMcpSessionScope(session: IAssistantChatSession) {
    const activeScope = getActiveAssistantMcpSessionScope();
    return activeScope !== null && activeScope.sessionKey !== sessionStore.keyForSession(session);
}
function getRequestChatSession(request?: IAgentAssistantStateRequest | IAgentAssistantScopedRequest | null) {
    const scope = sessionStore.resolveRequestedScope(request);
    const selection = resolveAssistantSelection(codexAssistantModels, request);
    rememberStateScope(scope, selection);
    return scope ? sessionStore.getSession(scope, selection, { create: true }) : null;
}
function currentCodexSelection(): IAssistantSelection {
    const selection = sessionStore.getRememberedSelection();
    const model = selection.provider === 'codex' ? selection.model : codexDefaultModelId(codexAssistantModels);
    return {
        provider: 'codex',
        model,
        effort: normalizeAssistantEffort(
            codexAssistantModels,
            'codex',
            model,
            selection.provider === 'codex' ? selection.effort : ASSISTANT_DEFAULT_EFFORT,
        ),
        speedMode: normalizeAssistantSpeedMode(
            codexAssistantModels,
            'codex',
            model,
            selection.provider === 'codex' ? selection.speedMode : ASSISTANT_DEFAULT_SPEED_MODE,
        ),
    };
}
function currentState(
    scope: IAgentAssistantChatScope | null = sessionStore.getRememberedScope(),
    selection: IAssistantSelection = sessionStore.getRememberedSelection(),
): IAgentAssistantState {
    return buildAgentAssistantStateSnapshot({
        claudeInfo: claudeInfoCache,
        claudeModels: claudeAssistantModels,
        codexInfo: runtimeLifecycle.getCodexInfo(),
        codexModels: codexAssistantModels,
        createMcpStatus: createBaseMcpStatusWithToolCount,
        getSessionForStatus: (requestedScope, requestedSelection) =>
            sessionStore.getSession(requestedScope, requestedSelection),
        isAssistantTurnActiveForScope,
        messages: sessionStore.getMessages(scope, selection),
        platform: process.platform,
        providerRuntimeStates,
        scope,
        selection,
    });
}

function createAssistantErrorResult(
    error: string,
    scope: IAgentAssistantChatScope | null = sessionStore.getRememberedScope(),
    selection: IAssistantSelection = sessionStore.getRememberedSelection(),
) {
    return withAssistantErrorEnvelope({
        ok: false,
        state: currentState(scope, selection),
        error,
    });
}

function createAssistantSuccessResult(session: IAssistantChatSession) {
    return {
        ok: true as const,
        state: currentState(session.scope, session),
    };
}

function addUserMessageAndPublish(
    session: IAssistantChatSession,
    text: string,
    attachments: NonNullable<IAgentAssistantSendMessageRequest['attachments']>,
) {
    sessionStore.addMessage(session, {
        role: 'user',
        text,
        ...(attachments.length > 0 ? {attachments} : {}),
    });
    publishState(session.scope, session);
}

function setProviderError(provider: TAgentAssistantProviderId, error: string) {
    (provider === 'claude' ? claudeProviderRuntime : codexProviderRuntime).lastError = error;
}

const {
    publishAssistantEvent,
    publishState,
} = createAssistantEventPublisher({
    currentState,
    getDefaultScope: sessionStore.getRememberedScope,
    getDefaultSelection: sessionStore.getRememberedSelection,
});

const codexAssistantAdapter = createCodexAssistantAdapter({
    featureLifecycle: assistantFeatureLifecycle,
    runtimeLifecycle,
    providerRuntime: codexProviderRuntime,
    getState: () => currentState(),
    publishState: () => publishState(),
    publishEvent: event => publishAssistantEvent(event),
    createDisabledResult: state => createAssistantDisabledResult(state),
    stopForDisabledFeature: stopAssistantForDisabledFeature,
    getPendingLoginId: () => pendingLoginId,
    setPendingLoginId: value => { pendingLoginId = value; },
    setAuthReturnWindow: value => { authReturnWindow = value; },
    logger,
});

const appServerNotifications = createAssistantAppServerNotificationController({
    addMessage: sessionStore.addMessage,
    appendAssistantDelta: sessionStore.appendAssistantDelta,
    clearLoginState: () => {
        authReturnWindow = null;
        pendingLoginId = null;
    },
    clearRuntimeForExit: () => runtimeLifecycle.clearRuntimeForExit(),
    codexProviderRuntime,
    completeSessionTurn,
    currentCodexSelection,
    getPendingLoginId: () => pendingLoginId,
    errorSessionTurn,
    getActiveChatSession: () => sessionStore.getActiveSession('codex'),
    getAuthReturnWindow: () => authReturnWindow,
    getChatSessionByThreadId: candidateThreadId => sessionStore.getSessionByThreadId(candidateThreadId),
    getRememberedScope: () => sessionStore.getRememberedScope(),
    logger,
    markSessionTurnRunning,
    noFocus: config.automation.noFocus,
    publishAssistantEvent,
    publishState,
    reconcileFailedTurnMessages,
    refreshAuthStateAndRuntimeAvailability: runtimeLifecycle.refreshAuthStateAndRuntimeAvailability,
    sessionStore,
    supersedeSessionTurn,
    upsertAssistantMessage: sessionStore.upsertAssistantMessage,
});

let assistantHeartbeatTimer: ReturnType<typeof createAssistantHeartbeatController> | null = null;

export function initializeAgentAssistantRuntime() {
    assistantHeartbeatTimer ??= createAssistantHeartbeatController({
        sessions: sessionStore.listSessions,
        isActive: session => isAssistantTurnActive(session.turnOwner),
        recordBoundary: sessionStore.recordTurnBoundary,
        publish: (event, session) => publishAssistantEvent(event, session.scope, session),
    });
    syncAssistantHeartbeat = assistantHeartbeatTimer.sync;
}

async function refreshClaudeInfo() {
    claudeInfoCache = await getClaudeAgentSdkInfo();
    if (claudeInfoCache.installed) {
        const hasActiveSession = sessionStore.listSessions().some(session => session.provider === 'claude' && session.claudeSession);
        if (!(hasActiveSession && claudeProviderRuntime.authState === 'signed-in')) {
            const detected = await detectClaudeAuthState();
            // A 'signed-out' demotion (from a real auth failure) is sticky: an
            // inconclusive 'unknown' must not silently re-mark the account as usable.
            // Only positive evidence ('signed-in') clears it.
            if (detected === 'signed-in' || claudeProviderRuntime.authState !== 'signed-out') {
                claudeProviderRuntime.authState = detected;
            }
        }
        claudeProviderRuntime.runtimeState = claudeProviderRuntime.runtimeState === 'stopped'
            ? 'ready'
            : claudeProviderRuntime.runtimeState;
        if (claudeProviderRuntime.authState !== 'signed-out') {
            delete claudeProviderRuntime.lastError;
        }
    } else {
        claudeProviderRuntime.authState = 'unknown';
        claudeProviderRuntime.runtimeState = 'stopped';
        claudeProviderRuntime.account = null;
        if (claudeInfoCache.error) {
            claudeProviderRuntime.lastError = claudeInfoCache.error;
        } else {
            delete claudeProviderRuntime.lastError;
        }
    }
    return claudeInfoCache;
}

let claudeMcpToolCount = 0;

function createBaseMcpStatusWithToolCount(
    provider: TAgentAssistantProviderId = sessionStore.getRememberedSelection().provider,
): IAgentAssistantStatus['mcp'] {
    const base = createBaseAssistantMcpStatus();
    return {
        ...base,
        toolCount: provider === 'claude' ? claudeMcpToolCount : runtimeLifecycle.getMcpToolCount(),
    };
}

function requestBestEffortCodexTurnCleanup(
    currentRuntime: NonNullable<ReturnType<typeof runtimeLifecycle.getRuntime>>,
    threadId: string,
    turnId: string | null,
    reason: string,
) {
    if (turnId) {
        void currentRuntime.client.request('turn/interrupt', {
            threadId,
            turnId,
        }).catch((error: unknown) => {
            logger.warn(`Failed to interrupt ${reason} assistant turn: ${getErrorMessage(error)}`);
        });
    }
    void currentRuntime.client.request('thread/archive', { threadId }).catch((error: unknown) => {
        logger.warn(`Failed to archive ${reason} assistant thread: ${getErrorMessage(error)}`);
    });
}

async function interruptStaleSessionTurn(
    session: IAssistantChatSession,
    reason: string,
) {
    if (session.provider === 'claude') {
        if (!session.claudeSession || !isAssistantTurnActive(session.turnOwner)) {
            return;
        }
        await waitForBoundedAssistantInterrupt(session.claudeSession.interrupt()).catch((error: unknown) => {
            logger.warn(`Failed to interrupt ${reason} Claude assistant turn: ${getErrorMessage(error)}`);
        });
        if (isAssistantTurnActive(session.turnOwner)) {
            supersedeSessionTurn(session);
        }
        return;
    }

    const currentRuntime = runtimeLifecycle.getRuntime();
    const activeTurnId = getAssistantTurnProviderTurnId(session.turnOwner);
    if (!currentRuntime || !session.providerThreadId || !activeTurnId) {
        return;
    }

    await currentRuntime.client.request('turn/interrupt', {
        threadId: session.providerThreadId,
        turnId: activeTurnId,
    }).catch((error: unknown) => {
        logger.warn(`Failed to interrupt ${reason} assistant turn: ${getErrorMessage(error)}`);
    });
}

function failCodexTurnAndFence(
    session: IAssistantChatSession,
    generation: number,
    reason: string,
    options: {
        currentRuntime: NonNullable<ReturnType<typeof runtimeLifecycle.getRuntime>>;
        threadId: string;
    },
) {
    const turnId = getAssistantTurnProviderTurnId(session.turnOwner);
    const ownsGeneration = session.turnOwner.generation === generation;
    if (ownsGeneration) {
        if (session.providerThreadId === options.threadId) {
            session.providerThreadId = null;
        }
        codexProviderRuntime.lastError = reason;
        codexProviderRuntime.runtimeState = 'error';
        session.lastError = reason;
        supersedeSessionTurnWithError(session, reason);
    }
    requestBestEffortCodexTurnCleanup(options.currentRuntime, options.threadId, turnId, 'timed-out');
    return ownsGeneration;
}

function markClaudeTurnCompleted(session: IAssistantChatSession, turnId: string | null) {
    if (turnId && !matchesProviderTurn(session.turnOwner, turnId)) {
        return;
    }

    if (!completeSessionTurn(session, session.turnOwner.generation, turnId)) {
        return;
    }
    claudeProviderRuntime.runtimeState = 'ready';
    clearPendingAssistantMessages(session);
    sessionStore.recordSessionSnapshot(session);
    publishAssistantEvent({ type: 'turn-completed' }, session.scope, session);
}

function reconcileFailedTurnMessages(session: IAssistantChatSession, errorMessage: string) {
    const normalizedError = errorMessage.trim();
    session.messages = session.messages.filter(message => {
        if (message.role !== 'assistant' || !message.pending) {
            return true;
        }
        const text = message.text.trim();
        // Drop the incomplete streaming bubble when it is empty or just echoes the error
        // (e.g. an unavailable-model notice), so the failure is not shown twice.
        return text.length > 0
            && !normalizedError.includes(text)
            && !text.includes(normalizedError);
    });
    clearPendingAssistantMessages(session);
}

function clearPendingAssistantMessages(session: IAssistantChatSession) {
    session.messages.filter(message => message.role === 'assistant' && message.pending).forEach(message => { message.pending = false; });
}

function markClaudeTurnError(
    session: IAssistantChatSession,
    turnId: string | null,
    message: string,
    options: {idleProviderFailure?: boolean} = {},
) {
    claudeProviderRuntime.lastError = message;
    claudeProviderRuntime.runtimeState = 'error';
    if (isClaudeAuthErrorMessage(message)) {
        claudeProviderRuntime.authState = 'signed-out';
    }
    if (turnId === null && options.idleProviderFailure === true) {
        publishState(session.scope, session);
        return;
    }
    errorSessionTurn(session, session.turnOwner.generation, message);
    session.lastError = message;
    reconcileFailedTurnMessages(session, message);
    sessionStore.addMessage(session, {
        role: 'system',
        text: message,
        error: message,
    });
    publishAssistantEvent({
        type: 'error',
        error: message,
    }, session.scope, session);
}

function resetAssistantSession(
    session: IAssistantChatSession,
    providerRuntime: typeof claudeProviderRuntime,
    runtimeState: typeof claudeProviderRuntime.runtimeState,
) {
    session.providerThreadId = null;
    supersedeSessionTurn(session);
    session.messages.length = 0;
    delete session.lastError;
    sessionStore.clearActiveSessionIfMatches(session);
    sessionStore.resetSessionTranscript(session, 'reset');
    delete providerRuntime.lastError;
    providerRuntime.runtimeState = runtimeState;
    publishState(session.scope, session);
    return currentState(session.scope, session);
}

function isActiveTurnScopeCurrent(session: IAssistantChatSession) {
    const turnScope = getAssistantTurnScope(session.turnOwner);
    return !turnScope
        || buildAssistantSessionScopeBindingFingerprint(turnScope)
            === buildAgentAssistantScopeFingerprint(session.provider, session.scope);
}

function isAssistantTurnActiveForScope(
    session: IAssistantChatSession,
    scope: IAgentAssistantChatScope | null,
) {
    const turnScope = getAssistantTurnScope(session.turnOwner);
    return Boolean(turnScope)
        && buildAssistantSessionScopeBindingFingerprint(turnScope)
            === buildAgentAssistantScopeFingerprint(session.provider, scope ?? session.scope);
}

function shouldDropClaudeCallback(session: IAssistantChatSession, turnId: string | null) {
    return turnId === null
        || !matchesProviderTurn(session.turnOwner, turnId)
        || !isActiveTurnScopeCurrent(session);
}
function createClaudeCallbacks(session: IAssistantChatSession) {
    const presentationCallbacks = createClaudeTurnPresentationCallbacks({
        session,
        shouldDrop: turnId => shouldDropClaudeCallback(session, turnId),
        publish: event => publishAssistantEvent(event, session.scope, session),
    });
    return {
        onInitialized: (info: IClaudeAgentAssistantInit) => {
            session.providerThreadId = info.sessionId;
            session.model = normalizeClaudeAssistantModel(info.model ?? session.model);
            if (info.models && info.models.length > 0) {
                claudeAssistantModels = info.models;
                session.model = normalizeClaudeAssistantModel(session.model);
            }
            claudeMcpToolCount = Math.max(claudeMcpToolCount, info.toolCount);
            claudeProviderRuntime.account = normalizeClaudeAssistantAccount(info.account);
            claudeProviderRuntime.authState = 'signed-in';
            if (claudeProviderRuntime.runtimeState !== 'busy') {
                claudeProviderRuntime.runtimeState = 'ready';
            }
            sessionStore.recordSessionSnapshot(session);
            publishState(session.scope, session);
        },
        onTurnStarted: (turnId: string) => {
            if (!isActiveTurnScopeCurrent(session)) {
                return;
            }
            sessionStore.setActiveSession(session);
            markSessionTurnRunning(session, session.turnOwner.generation, turnId);
            claudeProviderRuntime.runtimeState = 'busy';
            session.turnPresentation.phase = 'thinking';
            session.turnPresentation.lastEventAtMs = Date.now();
            publishAssistantEvent({
                type: 'turn-started',
                turnId,
            }, session.scope, session);
        },
        onAssistantDelta: (turnId: string | null, messageId: string, delta: string) => {
            if (shouldDropClaudeCallback(session, turnId)) {
                return;
            }
            if (claudeProviderRuntime.runtimeState === 'busy') {
                markSessionTurnRunning(session, session.turnOwner.generation, getAssistantTurnProviderTurnId(session.turnOwner));
            }
            session.turnPresentation.phase = 'streaming';
            session.turnPresentation.lastEventAtMs = Date.now();
            sessionStore.appendAssistantDelta(session, messageId, delta);
        },
        onReasoningDelta: (turnId: string | null, delta: string) => {
            if (shouldDropClaudeCallback(session, turnId)) {
                return;
            }
            session.turnPresentation.phase = 'thinking';
            session.turnPresentation.reasoning += delta;
            session.turnPresentation.lastEventAtMs = Date.now();
            publishAssistantEvent({
                type: 'reasoning-delta',
                reasoningDelta: delta,
                phase: 'thinking',
                lastEventAtMs: session.turnPresentation.lastEventAtMs,
            }, session.scope, session);
        },
        ...presentationCallbacks,
        onAssistantMessage: (turnId: string | null, messageId: string, text: string, pending: boolean) => {
            if (shouldDropClaudeCallback(session, turnId)) {
                return;
            }
            sessionStore.upsertAssistantMessage(session, messageId, {
                text,
                pending,
            });
        },
        onTurnCompleted: (turnId: string | null) => {
            markClaudeTurnCompleted(session, turnId);
        },
        onError: (turnId: string | null, message: string) => {
            // A null turn ID is meaningful here. It reports an idle provider
            // stream failure, which must invalidate the provider without
            // inventing a failed chat turn.
            if (turnId !== null && shouldDropClaudeCallback(session, turnId)) {
                return;
            }
            markClaudeTurnError(session, turnId, message, {idleProviderFailure: true});
        },
    };
}
async function ensureClaudeAssistantSession(
    session: IAssistantChatSession,
    model: string,
    effort: TAgentAssistantEffort,
    speedMode: TAgentAssistantSpeedMode,
    generation: number,
    isClaimCurrent: () => boolean,
) {
    await assistantFeatureLifecycle.assertEnabled(generation);
    const claudeInfo = await refreshClaudeInfo();
    await assistantFeatureLifecycle.assertEnabled(generation);
    if (!claudeInfo.installed || !claudeInfo.executablePath) {
        const error = claudeInfo.error ?? 'Claude Agent SDK is not available.';
        claudeProviderRuntime.lastError = error;
        claudeProviderRuntime.runtimeState = 'stopped';
        publishState(session.scope, session);
        throw new Error(error);
    }
    const normalizedModel = normalizeClaudeAssistantModel(model);
    const normalizedEffort = normalizeAssistantEffort(codexAssistantModels, 'claude', normalizedModel, effort);
    const normalizedSpeedMode = normalizeAssistantSpeedMode(codexAssistantModels, 'claude', normalizedModel, speedMode);
    const desiredFastMode = shouldUseClaudeAssistantFastMode(normalizedModel, normalizedSpeedMode);
    if (session.claudeSession) {
        if (session.claudeSession.isRetiring) {
            throw new Error('Claude is still retiring the previous turn. Try sending again after cancellation finishes.');
        }
        // The model can change in-session (setModel), but effort and flag settings
        // are fixed at query() start. Keep local message history and rebuild only
        // when the SDK session configuration would differ.
        if (
            session.claudeSession.isUsable
            && session.claudeSession.effort === normalizedEffort
            && session.claudeSession.fastMode === desiredFastMode
        ) {
            session.model = normalizedModel;
            session.effort = normalizedEffort;
            session.speedMode = normalizedSpeedMode;
            sessionStore.recordSessionSnapshot(session);
            return {
                session: session.claudeSession,
                created: false,
            };
        }
        const closingClaudeSession = session.claudeSession;
        await waitForBoundedAssistantInterrupt(closingClaudeSession.close()).catch((error: unknown) => {
            logger.warn(`Failed to close Claude assistant session for settings change: ${getErrorMessage(error)}`);
        });
        if (closingClaudeSession.isRetiring) {
            throw new Error('Claude is still retiring the previous session. Try again after cleanup finishes.');
        }
        session.claudeSession = undefined;
    }
    if (shouldRefuseClaudeContextContinuation(session.messages.length, session.providerThreadId)) {
        // Display history alone cannot recreate hidden preset instructions,
        // assistant turns, tool history, or image content for Claude.
        throw new Error(CLAUDE_CONTEXT_UNAVAILABLE_ERROR);
    }
    claudeProviderRuntime.runtimeState = 'starting';
    delete claudeProviderRuntime.lastError;
    publishState(session.scope, session);
    const cwd = await ensureAssistantCwd();
    await assistantFeatureLifecycle.assertEnabled(generation);
    if (!isClaimCurrent()) {
        throw new AssistantTurnSupersededError();
    }
    const {
        descriptor,
        token: mcpToken,
    } = await startEmbeddedMcpServer();
    await assistantFeatureLifecycle.assertEnabled(generation);
    if (!isClaimCurrent()) {
        throw new AssistantTurnSupersededError();
    }
    session.model = normalizedModel;
    session.effort = normalizedEffort;
    session.speedMode = normalizedSpeedMode;
    sessionStore.recordSessionSnapshot(session);
    const {ClaudeAgentAssistantSession} = await loadClaudeRuntimeModule();
    await assistantFeatureLifecycle.assertEnabled(generation);
    if (!isClaimCurrent()) {
        throw new AssistantTurnSupersededError();
    }
    const claudeSession = new ClaudeAgentAssistantSession({
        cwd,
        model: session.model,
        effort: session.effort,
        speedMode: session.speedMode,
        resumeSessionId: session.providerThreadId,
        mcpServerName: ASSISTANT_MCP_SERVER_NAME,
        mcpServerUrl: descriptor.url,
        mcpToken,
        executablePath: claudeInfo.executablePath,
        callbacks: createClaudeCallbacks(session),
    });
    if (!isClaimCurrent()) {
        await claudeSession.close().catch((error: unknown) => {
            logger.warn(`Failed to close canceled Claude assistant session: ${getErrorMessage(error)}`);
        });
        throw new AssistantTurnSupersededError();
    }
    session.claudeSession = claudeSession;
    claudeProviderRuntime.runtimeState = 'ready';
    publishState(session.scope, session);
    return {
        session: claudeSession,
        created: true,
    };
}
export async function getAgentAssistantState(
    request?: IAgentAssistantStateRequest,
): Promise<IAgentAssistantState> {
    await assistantFeatureLifecycle.waitForShutdown();
    const session = getRequestChatSession(request);
    const scope = session?.scope ?? null;
    const selection = resolveAssistantSelection(codexAssistantModels, request);
    if (!(await isAssistantFeatureEnabled())) {
        await shutdownAgentAssistant();
        return currentState(scope, selection);
    }
    // State reads may inspect cached provider metadata, but never start a
    // provider runtime. A first send/login/install operation owns startup.
    if (selection.provider === 'codex') {
        await runtimeLifecycle.refreshCodexInfo();
        await runtimeLifecycle.refreshCodexAuthStateWithoutRuntime();
        if (codexProviderRuntime.authState === 'signed-out' && codexProviderRuntime.runtimeState === 'error') {
            codexProviderRuntime.runtimeState = 'stopped';
        }
    } else {
        await refreshClaudeInfo();
    }
    return currentState(scope, selection);
}
export const installAgentAssistantCodex = codexAssistantAdapter.install;
export const startAgentAssistantLogin = codexAssistantAdapter.startLogin;
export const cancelAgentAssistantLogin = codexAssistantAdapter.cancelLogin;

export async function sendAgentAssistantMessage(
    request: IAgentAssistantSendMessageRequest,
    options: IAgentAssistantSendMessageOptions = {},
): Promise<IAgentAssistantSendMessageResult> {
    await assistantFeatureLifecycle.waitForShutdown();
    if (!(await isAssistantFeatureEnabled())) {
        const error = await stopAssistantForDisabledFeature();
        return createAssistantErrorResult(error);
    }
    const operationGeneration = assistantFeatureLifecycle.captureGeneration();
    const selection = resolveAssistantSelection(codexAssistantModels, request);
    const scope = normalizeAssistantScope(request.scope);
    rememberStateScope(scope, selection);
    if (!scope) {
        const error = 'Open a document before starting an EVB Assistant chat.';
        setProviderError(selection.provider, error);
        return createAssistantErrorResult(error, null, selection);
    }
    const session = sessionStore.getSession(scope, selection, { create: true });
    session.lastSenderWindowId = options.windowId ?? null;
    if (hasConflictingAssistantMcpSessionScope(session)) {
        return createAssistantBusyResult(() => currentState(session.scope, session));
    }
    if (session.sendInFlight) {
        return createAssistantBusyResult(() => currentState(session.scope, session));
    }
    if (isAssistantTurnActive(session.turnOwner)) {
        if (!isAssistantTurnActiveForScope(session, session.scope)) {
            interruptSessionTurn(session);
            publishState(session.scope, session);
            await interruptStaleSessionTurn(session, 'stale-scope');
        }
        return createAssistantBusyResult(() => currentState(session.scope, session));
    }

    const sendInFlight = Promise.resolve();
    session.sendInFlight = sendInFlight;
    try {
        let normalizedRequest: ReturnType<typeof normalizeOutgoingMessageRequest>;
        try {
            normalizedRequest = normalizeOutgoingMessageRequest(request);
        } catch (error) {
            const message = getErrorMessage(error);
            setProviderError(selection.provider, message);
            session.lastError = message;
            return createAssistantErrorResult(message, session.scope, session);
        }
        const {
            text,
            attachments,
        } = normalizedRequest;
        // Preset chips send a short visible label as `text` and carry the detailed,
        // edge-case-aware workflow as hidden instructions. The transcript records the
        // short label, while the model receives the label plus the full workflow.
        const presetInstructions = resolveAssistantPresetInstructions(request.presetId);
        const modelText = presetInstructions
            ? (text ? `${text}\n\n${presetInstructions}` : presetInstructions)
            : text;
        if (!text && attachments.length === 0 && !presetInstructions) {
            return createAssistantErrorResult('Message is empty.', session.scope, session);
        }

        // Reserve the session before any provider setup can yield. This makes
        // the session turn and its MCP scope the transaction owner while a
        // thread/query is being created, not only after it has started.
        sessionStore.setActiveSession(session);
        const claimedTurnGeneration = claimSessionTurn(session);
        const isClaimCurrent = () => session.turnOwner.generation === claimedTurnGeneration
            && isActiveTurnScopeCurrent(session);
        const assertClaimCurrent = async () => {
            await assistantFeatureLifecycle.assertEnabled(operationGeneration);
            if (!isClaimCurrent()) {
                throw new AssistantTurnSupersededError();
            }
        };

        if (selection.provider === 'claude') {
            let claudeSession: NonNullable<IAssistantChatSession['claudeSession']> | null = null;
            let createdClaudeSession = false;
            try {
                const ensuredClaudeSession = await ensureClaudeAssistantSession(
                    session,
                    selection.model,
                    selection.effort,
                    selection.speedMode,
                    operationGeneration,
                    isClaimCurrent,
                );
                claudeSession = ensuredClaudeSession.session;
                createdClaudeSession = ensuredClaudeSession.created;
                await assertClaimCurrent();
                if (session.claudeSession !== claudeSession) {
                    throw new AssistantTurnSupersededError();
                }
                claudeProviderRuntime.runtimeState = 'busy';
                delete session.lastError;
                addUserMessageAndPublish(session, text, attachments);
                await claudeSession.sendMessage(modelText, attachments, selection.model);
                await assertClaimCurrent();
                publishState(session.scope, session);
                return createAssistantSuccessResult(session);
            } catch (error) {
                if (createdClaudeSession && claudeSession && session.claudeSession === claudeSession) {
                    await waitForBoundedAssistantInterrupt(claudeSession.close()).catch((closeError: unknown) => {
                        logger.warn(`Failed to close superseded Claude assistant session: ${getErrorMessage(closeError)}`);
                    });
                    session.claudeSession = undefined;
                }
                if (error instanceof AssistantTurnSupersededError) {
                    releaseClaimedSessionTurn(session, claimedTurnGeneration);
                    return createAssistantErrorResult(ASSISTANT_TURN_CANCELLED_ERROR, session.scope, session);
                }
                if (!(await assistantFeatureLifecycle.isEnabled(operationGeneration))) {
                    releaseClaimedSessionTurn(session, claimedTurnGeneration);
                    return createAssistantDisabledResult(currentState(session.scope, session));
                }
                const message = getErrorMessage(error);
                markClaudeTurnError(session, null, message);
                return createAssistantErrorResult(message, session.scope, session);
            }
        }
        let currentThreadId: string | null = null;
        let createdThread = false;
        let providerTurnId: string | null = null;
        const turnGeneration = claimedTurnGeneration;
        try {
            const currentRuntime = await runtimeLifecycle.ensureRuntime();
            await assertClaimCurrent();
            await runtimeLifecycle.assertRuntimeEnabled(currentRuntime);
            const codexModel = normalizeCodexAssistantModel(codexAssistantModels, selection.model);
            const codexServiceTier = resolveCodexServiceTier(codexAssistantModels, selection.model, selection.speedMode);
            session.model = normalizeCodexAssistantModel(codexAssistantModels, selection.model);
            session.effort = selection.effort;
            session.speedMode = selection.speedMode;
            const ensuredThread = await runtimeLifecycle.ensureThread(session);
            currentThreadId = ensuredThread.threadId;
            createdThread = ensuredThread.created;
            await assertClaimCurrent();
            await runtimeLifecycle.assertRuntimeEnabled(currentRuntime);
            session.providerThreadId = currentThreadId;
            sessionStore.setActiveSession(session);
            codexProviderRuntime.runtimeState = 'busy';
            delete session.lastError;
            addUserMessageAndPublish(session, text, attachments);
            const response = await currentRuntime.client.requestDecoded('turn/start', {
                threadId: currentThreadId,
                input: [
                    {
                        type: 'text',
                        text: modelText || ASSISTANT_IMAGE_ONLY_PROMPT,
                        text_elements: [],
                    },
                    ...attachments.map((attachment: NonNullable<IAgentAssistantSendMessageRequest['attachments']>[number]) => ({
                        type: 'image',
                        url: attachment.dataUrl,
                    })),
                ],
                ...(codexModel ? { model: codexModel } : {}),
                effort: selection.effort,
                ...(codexServiceTier ? { serviceTier: codexServiceTier } : {}),
                cwd: currentRuntime.cwd,
                approvalPolicy: 'never',
                sandboxPolicy: {
                    type: 'readOnly',
                    networkAccess: false,
                },
                personality: 'friendly',
            }, value => isRecord(value) ? value : null);
            providerTurnId = isRecord(response.turn) && typeof response.turn.id === 'string'
                ? response.turn.id
                : null;
            await assertClaimCurrent();
            await runtimeLifecycle.assertRuntimeEnabled(currentRuntime);
            if (!providerTurnId || providerTurnId.trim() === '') {
                throw new Error('Codex returned an invalid turn/start response.');
            }
            session.model = normalizeCodexAssistantModel(codexAssistantModels, selection.model);
            if (session.providerThreadId !== currentThreadId) {
                releaseClaimedSessionTurn(session, turnGeneration);
                return createAssistantSuccessResult(session);
            }
            if (!isActiveTurnScopeCurrent(session)) {
                interruptSessionTurn(session);
                publishState(session.scope, session);
                await interruptStaleSessionTurn(session, 'stale-scope');
                releaseClaimedSessionTurn(session, turnGeneration);
                return createAssistantErrorResult(getAssistantTurnBusyError(), session.scope, session);
            }
            markSessionTurnRunning(session, turnGeneration, providerTurnId);
            publishState(session.scope, session);
            return createAssistantSuccessResult(session);
        } catch (error) {
            if (error instanceof AssistantTurnSupersededError) {
                const cleanupRuntime = runtimeLifecycle.getRuntime();
                if (cleanupRuntime && currentThreadId) {
                    requestBestEffortCodexTurnCleanup(
                        cleanupRuntime,
                        currentThreadId,
                        providerTurnId,
                        'superseded',
                    );
                }
                if (createdThread && session.providerThreadId === currentThreadId) {
                    session.providerThreadId = null;
                }
                releaseClaimedSessionTurn(session, turnGeneration);
                return createAssistantErrorResult(ASSISTANT_TURN_CANCELLED_ERROR, session.scope, session);
            }
            if (!(await assistantFeatureLifecycle.isEnabled(operationGeneration))) {
                const cleanupRuntime = runtimeLifecycle.getRuntime();
                if (cleanupRuntime && currentThreadId) {
                    requestBestEffortCodexTurnCleanup(cleanupRuntime, currentThreadId, providerTurnId, 'disabled');
                }
                if (createdThread && session.providerThreadId === currentThreadId) {
                    session.providerThreadId = null;
                }
                releaseClaimedSessionTurn(session, turnGeneration);
                return createAssistantDisabledResult(currentState(session.scope, session));
            }
            if (currentThreadId && session.providerThreadId !== currentThreadId) {
                releaseClaimedSessionTurn(session, turnGeneration);
                return createAssistantErrorResult(getErrorMessage(error), session.scope, session);
            }
            const providerError = codexProviderRuntime.lastError;
            codexProviderRuntime.lastError = providerError?.startsWith('Could not verify Codex authentication')
                ? providerError
                : getErrorMessage(error);
            session.lastError = codexProviderRuntime.lastError;
            const cleanupRuntime = runtimeLifecycle.getRuntime();
            if (
                isCodexAppServerRequestTimeoutError(error)
            && currentThreadId
            && cleanupRuntime
            ) {
                const fenced = failCodexTurnAndFence(session, turnGeneration, codexProviderRuntime.lastError, {
                    currentRuntime: cleanupRuntime,
                    threadId: currentThreadId,
                });
                if (fenced) {
                    reconcileFailedTurnMessages(session, codexProviderRuntime.lastError);
                    sessionStore.addMessage(session, {
                        role: 'system',
                        text: codexProviderRuntime.lastError,
                        error: codexProviderRuntime.lastError,
                    });
                }
                return createAssistantErrorResult(codexProviderRuntime.lastError, session.scope, session);
            }
            codexProviderRuntime.runtimeState = 'error';
            errorSessionTurn(
                session,
                turnGeneration,
                codexProviderRuntime.lastError,
            );
            sessionStore.addMessage(session, {
                role: 'system',
                text: codexProviderRuntime.lastError,
                error: codexProviderRuntime.lastError,
            });
            return createAssistantErrorResult(codexProviderRuntime.lastError, session.scope, session);
        }
    } finally {
        if (session.sendInFlight === sendInFlight) {
            session.sendInFlight = null;
        }
    }
}

export async function interruptAgentAssistant(
    request?: IAgentAssistantScopedRequest,
): Promise<IAgentAssistantState> {
    const requestedSession = getRequestChatSession(request);
    const selection = resolveAssistantSelection(codexAssistantModels, request);
    const session = requestedSession ?? sessionStore.getActiveSession(selection.provider);
    abortActiveEmbeddedMcpRequests(session?.scopeBinding ?? null, 'Assistant turn interrupted by the user.');
    if (session?.provider === 'claude') {
        if (session.claudeSession && isAssistantTurnActive(session.turnOwner)) {
            claudeProviderRuntime.runtimeState = 'busy';
            interruptSessionTurn(session);
            publishState(session.scope, session);
            await waitForBoundedAssistantInterrupt(session.claudeSession.interrupt()).catch((error: unknown) => {
                logger.warn(`Failed to interrupt Claude assistant turn: ${getErrorMessage(error)}`);
                session.turnPresentation.phase = 'stalled';
                session.turnPresentation.lastEventAtMs = Date.now();
            });
            // interrupt() -> completeTurn() -> markClaudeTurnCompleted already resets
            // runtimeState and emits the turn-completed event.
            return currentState(session.scope, session);
        }
        supersedeSessionTurn(session);
        if (claudeProviderRuntime.runtimeState !== 'busy') {
            claudeProviderRuntime.runtimeState = 'ready';
        }
        publishState(session.scope, session);
        return currentState(session.scope, session);
    }

    const currentRuntime = runtimeLifecycle.getRuntime();
    const activeTurnId = session ? getAssistantTurnProviderTurnId(session.turnOwner) : null;
    let codexInterruptRequested = false;
    if (currentRuntime && session?.providerThreadId && activeTurnId) {
        codexInterruptRequested = true;
        interruptSessionTurn(session);
        codexProviderRuntime.runtimeState = 'busy';
        publishState(session.scope, session);
        try {
            await waitForBoundedAssistantInterrupt(currentRuntime.client.request('turn/interrupt', {
                threadId: session.providerThreadId,
                turnId: activeTurnId,
            }));
        } catch (error) {
            const message = getErrorMessage(error);
            logger.warn(`Failed to interrupt assistant turn: ${message}`);
            codexProviderRuntime.lastError = message;
            session.lastError = message;
            session.turnPresentation.phase = 'stalled';
            session.turnPresentation.lastEventAtMs = Date.now();
        }
    }
    if (session && codexInterruptRequested) {
        codexProviderRuntime.runtimeState = 'busy';
        publishState(session.scope, session);
        return currentState(session.scope, session);
    }
    if (session) {
        supersedeSessionTurn(session);
    }
    codexProviderRuntime.runtimeState = codexProviderRuntime.authState === 'signed-in' ? 'ready' : 'stopped';
    publishState(session?.scope ?? null, session ?? selection);
    return currentState(session?.scope ?? null, session ?? selection);
}

export async function resetAgentAssistantChat(
    request?: IAgentAssistantScopedRequest,
): Promise<IAgentAssistantState> {
    const session = getRequestChatSession(request);
    const selection = resolveAssistantSelection(codexAssistantModels, request);
    abortActiveEmbeddedMcpRequests(
        session?.scopeBinding ?? (session ? getAssistantTurnScope(session.turnOwner) : null),
        'Assistant chat reset by the user.',
    );
    if (!session) {
        return currentState(null, selection);
    }

    if (session.provider === 'claude') {
        if (session.claudeSession && isAssistantTurnActive(session.turnOwner)) {
            claudeProviderRuntime.runtimeState = 'busy';
            interruptSessionTurn(session);
            publishState(session.scope, session);
            await waitForBoundedAssistantInterrupt(session.claudeSession.interrupt()).catch((error: unknown) => {
                logger.warn(`Failed to interrupt Claude assistant turn during reset: ${getErrorMessage(error)}`);
            });
        }
        if (session.claudeSession) {
            await waitForBoundedAssistantInterrupt(session.claudeSession.close()).catch((error: unknown) => {
                logger.warn(`Failed to close reset Claude assistant session: ${getErrorMessage(error)}`);
            });
        }
        session.claudeSession = undefined;
        return resetAssistantSession(
            session,
            claudeProviderRuntime,
            claudeInfoCache?.installed ? 'ready' : 'stopped',
        );
    }

    const previousThreadId = session.providerThreadId;
    const previousTurnId = getAssistantTurnProviderTurnId(session.turnOwner);
    const currentRuntime = runtimeLifecycle.getRuntime();
    if (currentRuntime && previousThreadId && previousTurnId) {
        interruptSessionTurn(session);
        publishState(session.scope, session);
        await currentRuntime.client.request('turn/interrupt', {
            threadId: previousThreadId,
            turnId: previousTurnId,
        }).catch((error: unknown) => {
            logger.warn(`Failed to interrupt assistant turn during reset: ${getErrorMessage(error)}`);
        });
    }

    if (currentRuntime && previousThreadId) {
        void currentRuntime.client.request('thread/archive', { threadId: previousThreadId }).catch((error: unknown) => {
            logger.warn(`Failed to archive reset assistant thread: ${getErrorMessage(error)}`);
        });
    }

    return resetAssistantSession(
        session,
        codexProviderRuntime,
        codexProviderRuntime.authState === 'signed-in' ? 'ready' : 'stopped',
    );
}

async function stopAssistantRuntimeForShutdown() {
    assistantHeartbeatTimer?.dispose();
    assistantHeartbeatTimer = null;
    syncAssistantHeartbeat = () => {};
    authReturnWindow = null;
    pendingLoginId = null;
    await runAssistantShutdownStep('Codex runtime', () => runtimeLifecycle.shutdownCodexRuntime({shutdownMcp: false}), logger);
    await runAssistantShutdownStep('Claude runtime', () => shutdownClaudeAssistantRuntime({shutdownMcp: false}), logger);
}

export function preserveAssistantStateForShutdown() {
    return assistantFeatureLifecycle.shutdown(async () => {
        await stopAssistantRuntimeForShutdown();
        await sessionStore.flushPersistence();
    });
}

export function shutdownAgentAssistant() {
    return assistantFeatureLifecycle.shutdown(async () => {
        await stopAssistantRuntimeForShutdown();
        await runAssistantShutdownStep('assistant session persistence', () => sessionStore.flushPersistence(), logger);
        await runAssistantShutdownStep('active assistant session', () => sessionStore.clearActiveSession(), logger);
        await runAssistantShutdownStep('embedded MCP server', () => shutdownEmbeddedMcpServer(), logger);
    });
}
