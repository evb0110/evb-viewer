import { randomUUID } from 'crypto';
import type { SetOptional } from 'type-fest';
import type {
    IAgentAssistantChatMessage,
    IAgentAssistantChatScope,
    IAgentAssistantEvent,
    IAgentAssistantImageAttachment,
    IAgentAssistantScopedRequest,
    IAgentAssistantStateRequest,
    IAgentAssistantTurnState,
    TAgentAssistantEffort,
    TAgentAssistantProviderId,
    TAgentAssistantSpeedMode,
    TAgentAssistantTurnPhase,
    IAgentAssistantToolActivity,
} from '@contracts/agent';
import {cloneAssistantScope} from '@contracts/agent';
import {
    ASSISTANT_DEFAULT_EFFORT,
    ASSISTANT_DEFAULT_SPEED_MODE,
    CODEX_ASSISTANT_DEFAULT_MODEL,
} from '@contracts/agentModels';
import { isDocumentRevisionInfo } from '@contracts/documentRevision';
import { parseDocumentInstanceId } from '@contracts/documentInstanceId';
import {parseDocumentRef} from '@contracts/documentRef';
import {parseTabId} from '@contracts/windowTabs';
import {createIsoTimestamp} from '@contracts/timestamps';
import type { ClaudeAgentAssistantSession } from '@electron/features/agent/claudeAgentSdkAssistant';
import { withAssistantErrorEnvelope } from '@electron/features/agent/assistantErrorEnvelope';
import type { IAssistantSelection } from '@electron/features/agent/assistantProviderStatus';
import {
    createInitialAssistantTurnOwner,
    isAssistantTurnActive,
    type IAssistantSessionScopeBinding,
    type TAssistantTurnOwnerState,
} from '@electron/features/agent/assistantTurnLifecycle';
import {
    AssistantChatPersistence,
    readBoundedIntegerEnv,
} from '@electron/features/agent/assistantChatPersistence';

export interface IAssistantChatSession {
    provider: TAgentAssistantProviderId;
    scope: IAgentAssistantChatScope;
    model: string;
    effort: TAgentAssistantEffort;
    speedMode: TAgentAssistantSpeedMode;
    providerThreadId: string | null;
    lastSenderWindowId: number | null;
    turnOwner: TAssistantTurnOwnerState;
    sendInFlight: Promise<unknown> | null;
    scopeBinding: IAssistantSessionScopeBinding | null;
    messages: IAgentAssistantChatMessage[];
    lastAccessedAtMs: number;
    turnPresentation: {
        phase: TAgentAssistantTurnPhase;
        reasoning: string;
        toolActivity: IAgentAssistantToolActivity[];
        lastEventAtMs: number | null;
        usage: IAgentAssistantTurnState['usage'];
    };
    claudeSession: ClaudeAgentAssistantSession | undefined;
    lastError?: string;
}

interface IAssistantChatSessionStoreOptions {
    maxEntries?: number;
    ttlMs?: number;
    persistence?: AssistantChatPersistence | false;
    onSessionDeleted?: (session: IAssistantChatSession, reason: string) => void;
    onSessionMessageEvent?: (event: IAgentAssistantEvent, session: IAssistantChatSession) => void;
}

type TAssistantMessageInput = SetOptional<Omit<IAgentAssistantChatMessage, 'createdAt'>, 'id'>;

const DEFAULT_SELECTION = {
    provider: 'codex',
    model: CODEX_ASSISTANT_DEFAULT_MODEL,
    effort: ASSISTANT_DEFAULT_EFFORT,
    speedMode: ASSISTANT_DEFAULT_SPEED_MODE,
} as const satisfies IAssistantSelection;

function readAssistantChatSessionMaxEntries() {
    return readBoundedIntegerEnv('EVB_ASSISTANT_CHAT_SESSION_MAX_ENTRIES', 32, 1, 512);
}

function readAssistantChatSessionTtlMs() {
    // Session retention is bounded by maxEntries, not by wall-clock inactivity.
    // A backgrounded window must not turn a visible conversation into a new one.
    const configured = process.env.EVB_ASSISTANT_CHAT_SESSION_TTL_MS;
    if (configured === undefined || configured.trim() === '') {
        return Number.POSITIVE_INFINITY;
    }
    return readBoundedIntegerEnv('EVB_ASSISTANT_CHAT_SESSION_TTL_MS', Number.POSITIVE_INFINITY, 60_000);
}

export function normalizeAssistantScope(scope: IAgentAssistantChatScope | null | undefined) {
    if (!scope) {
        return null;
    }

    const key = scope.key.trim();
    if (!key) {
        return null;
    }

    const title = scope.title?.trim();
    const documentSessionKey = scope.documentSessionKey?.trim();
    const documentInstanceId = parseDocumentInstanceId(scope.documentInstanceId);
    const tabId = scope.tabId === undefined || scope.tabId === null
        ? undefined
        : parseTabId(scope.tabId);
    const documentRef = scope.documentRef === undefined || scope.documentRef === null
        ? undefined
        : parseDocumentRef(scope.documentRef);
    if (scope.tabId != null && tabId === null || scope.documentRef != null && documentRef === null) {
        return null;
    }
    return {
        kind: 'document',
        key,
        title: title && title.length > 0 ? title : null,
        ...(tabId === undefined ? {} : {tabId}),
        ...(documentSessionKey ? { documentSessionKey } : {}),
        ...(documentInstanceId === null ? {} : { documentInstanceId }),
        ...(documentRef === undefined ? {} : {documentRef}),
        ...(scope.documentBackend === 'browser' || scope.documentBackend === 'electron'
            ? {documentBackend: scope.documentBackend}
            : {}),
        ...(isDocumentRevisionInfo(scope.documentIdentity) ? { documentIdentity: { ...scope.documentIdentity } } : {}),
        ...(scope.commandTarget === undefined ? {} : {commandTarget: {...scope.commandTarget}}),
    } satisfies IAgentAssistantChatScope;
}

function createChatSessionKey(provider: TAgentAssistantProviderId, scopeKey: string) {
    return `${provider}:${scopeKey}`;
}

function cloneAssistantAttachment(attachment: IAgentAssistantImageAttachment) {
    return { ...attachment };
}

function cloneAssistantMessage(message: IAgentAssistantChatMessage): IAgentAssistantChatMessage {
    return withAssistantErrorEnvelope({
        ...message,
        ...(message.attachments === undefined
            ? {}
            : { attachments: message.attachments.map(cloneAssistantAttachment) }),
    });
}

function isEvictableChatSession(session: IAssistantChatSession) {
    return !isAssistantTurnActive(session.turnOwner);
}

function normalizeRecoveredLastAccessedAt(value: number, now = Date.now()) {
    return Number.isFinite(value)
        ? Math.min(value, now)
        : now;
}

export function createAssistantChatSessionStore(options: IAssistantChatSessionStoreOptions = {}) {
    const maxEntries = options.maxEntries ?? readAssistantChatSessionMaxEntries();
    const ttlMs = options.ttlMs ?? readAssistantChatSessionTtlMs();
    const persistence = options.persistence === false
        ? null
        : options.persistence ?? new AssistantChatPersistence();
    const chatSessions = new Map<string, IAssistantChatSession>();
    let activeChatKey: string | null = null;
    let lastStateScope: IAgentAssistantChatScope | null = null;
    let lastSelection: IAssistantSelection = DEFAULT_SELECTION;

    for (const recovered of persistence?.recoverSessions() ?? []) {
        chatSessions.set(recovered.key, {
            provider: recovered.session.provider,
            scope: recovered.session.scope,
            model: recovered.session.model,
            effort: recovered.session.effort,
            speedMode: recovered.session.speedMode,
            providerThreadId: recovered.session.providerThreadId,
            lastSenderWindowId: recovered.session.lastSenderWindowId,
            turnOwner: recovered.session.turnOwner,
            sendInFlight: null,
            scopeBinding: recovered.session.scopeBinding,
            messages: recovered.session.messages,
            lastAccessedAtMs: normalizeRecoveredLastAccessedAt(recovered.session.lastAccessedAtMs),
            turnPresentation: {
                phase: 'idle',
                reasoning: '',
                toolActivity: [],
                lastEventAtMs: null,
                usage: null,
            },
            claudeSession: undefined,
            ...(recovered.session.lastError === undefined ? {} : { lastError: recovered.session.lastError }),
        });
    }

    function getRememberedScope() {
        return lastStateScope;
    }

    function getRememberedSelection() {
        return lastSelection;
    }

    function rememberStateScope(
        scope: IAgentAssistantChatScope | null,
        selection: IAssistantSelection = lastSelection,
    ) {
        lastStateScope = scope ? cloneAssistantScope(scope) : null;
        lastSelection = selection;
    }

    function updateRememberedSelection(patch: Partial<IAssistantSelection>) {
        lastSelection = {
            ...lastSelection,
            ...patch,
        };
    }

    function resolveRequestedScope(request?: IAgentAssistantStateRequest | IAgentAssistantScopedRequest | null) {
        return normalizeAssistantScope(request?.scope);
    }

    function touchSession(session: IAssistantChatSession, now = Date.now()) {
        session.lastAccessedAtMs = now;
        return session;
    }

    function keyForSession(session: IAssistantChatSession) {
        return createChatSessionKey(session.provider, session.scope.key);
    }

    function clearActiveSession() {
        activeChatKey = null;
    }

    function clearActiveSessionForProvider(provider: TAgentAssistantProviderId) {
        if (activeChatKey && chatSessions.get(activeChatKey)?.provider === provider) {
            activeChatKey = null;
        }
    }

    function clearActiveSessionIfMatches(session: IAssistantChatSession) {
        if (activeChatKey === keyForSession(session)) {
            activeChatKey = null;
        }
    }

    function setActiveSession(session: IAssistantChatSession) {
        activeChatKey = keyForSession(session);
        persistence?.recordSessionSnapshot(activeChatKey, session);
    }

    function deleteSession(key: string, reason: string) {
        const session = chatSessions.get(key);
        if (!session) {
            return;
        }

        chatSessions.delete(key);
        if (activeChatKey === key) {
            activeChatKey = null;
        }
        if (lastStateScope?.key === session.scope.key && lastSelection.provider === session.provider) {
            lastStateScope = null;
        }

        options.onSessionDeleted?.(session, reason);
        persistence?.archiveSession(key, reason);
    }

    function pruneSessions(now = Date.now()) {
        for (const [
            key,
            session,
        ] of chatSessions.entries()) {
            if (isEvictableChatSession(session) && Number.isFinite(ttlMs) && now - session.lastAccessedAtMs > ttlMs) {
                deleteSession(key, 'expired');
            }
        }

        if (chatSessions.size <= maxEntries) {
            return;
        }

        const evictableSessions = [...chatSessions.entries()]
            .filter((entry) => isEvictableChatSession(entry[1]))
            .sort((left, right) => Math.min(left[1].lastAccessedAtMs, now) - Math.min(right[1].lastAccessedAtMs, now));
        const overflowCount = chatSessions.size - maxEntries;
        for (let index = 0; index < overflowCount; index += 1) {
            const entry = evictableSessions[index];
            if (!entry) {
                break;
            }
            deleteSession(entry[0], 'evicted');
        }
    }

    function getSession(scope: IAgentAssistantChatScope, selection: IAssistantSelection, getOptions: { create: true }): IAssistantChatSession;
    function getSession(scope: IAgentAssistantChatScope | null, selection?: IAssistantSelection, getOptions?: { create?: false }): IAssistantChatSession | null;
    function getSession(
        scope: IAgentAssistantChatScope | null,
        selection: IAssistantSelection = lastSelection,
        getOptions: { create?: boolean } = {},
    ) {
        const now = Date.now();
        pruneSessions(now);
        if (!scope) {
            return null;
        }

        const normalizedScope = normalizeAssistantScope(scope);
        if (!normalizedScope) {
            return null;
        }

        const sessionKey = createChatSessionKey(selection.provider, normalizedScope.key);
        const existing = chatSessions.get(sessionKey);
        if (existing) {
            existing.scope = normalizedScope;
            existing.model = selection.model;
            existing.effort = selection.effort;
            existing.speedMode = selection.speedMode;
            touchSession(existing, now);
            persistence?.recordSessionSnapshot(sessionKey, existing);
            return existing;
        }

        if (!getOptions.create) {
            return null;
        }

        const session = {
            provider: selection.provider,
            scope: normalizedScope,
            model: selection.model,
            effort: selection.effort,
            speedMode: selection.speedMode,
            providerThreadId: null,
            lastSenderWindowId: null,
            turnOwner: createInitialAssistantTurnOwner(),
            sendInFlight: null,
            scopeBinding: null,
            messages: [],
            lastAccessedAtMs: now,
            turnPresentation: {
                phase: 'idle',
                reasoning: '',
                toolActivity: [],
                lastEventAtMs: null,
                usage: null,
            },
            claudeSession: undefined,
        } satisfies IAssistantChatSession;
        chatSessions.set(sessionKey, session);
        persistence?.recordSessionSnapshot(sessionKey, session);
        pruneSessions(now);
        return session;
    }

    function getActiveSession(provider?: TAgentAssistantProviderId) {
        const session = activeChatKey ? chatSessions.get(activeChatKey) ?? null : null;
        if (provider && session?.provider !== provider) {
            return null;
        }
        return session ? touchSession(session) : null;
    }

    function getSessionByThreadId(candidateThreadId: string | null) {
        if (!candidateThreadId) {
            return null;
        }

        const session = Array.from(chatSessions.values())
            .find(candidate => candidate.provider === 'codex' && candidate.providerThreadId === candidateThreadId) ?? null;
        return session ? touchSession(session) : null;
    }

    function getMessages(scope: IAgentAssistantChatScope | null = lastStateScope, selection: IAssistantSelection = lastSelection) {
        return getSession(scope, selection)?.messages.map(cloneAssistantMessage) ?? [];
    }

    function listSessions() {
        return [...chatSessions.values()];
    }

    function addMessage(session: IAssistantChatSession, message: TAssistantMessageInput) {
        touchSession(session);
        const nextMessage = {
            id: message.id ?? randomUUID(),
            role: message.role,
            text: message.text,
            createdAt: createIsoTimestamp(),
            ...(message.attachments === undefined
                ? {}
                : { attachments: message.attachments.map(cloneAssistantAttachment) }),
            ...(message.pending === undefined ? {} : { pending: message.pending }),
            ...(message.error === undefined ? {} : { error: message.error }),
        } satisfies IAgentAssistantChatMessage;
        session.messages.push(nextMessage);
        options.onSessionMessageEvent?.({
            type: 'message',
            message: nextMessage,
        }, session);
        persistence?.recordSessionSnapshot(keyForSession(session), session);
        return nextMessage;
    }

    function upsertAssistantMessage(
        session: IAssistantChatSession,
        id: string,
        patch: Partial<IAgentAssistantChatMessage>,
    ) {
        touchSession(session);
        const existing = session.messages.find(message => message.id === id);
        if (existing) {
            Object.assign(existing, patch);
            options.onSessionMessageEvent?.({
                type: 'message',
                message: cloneAssistantMessage(existing),
            }, session);
            persistence?.recordSessionSnapshot(keyForSession(session), session);
            return existing;
        }

        return addMessage(session, {
            id,
            role: 'assistant',
            text: patch.text ?? '',
            ...(patch.attachments === undefined ? {} : { attachments: patch.attachments }),
            ...(patch.pending === undefined ? {} : { pending: patch.pending }),
            ...(patch.error === undefined ? {} : { error: patch.error }),
        });
    }

    function appendAssistantDelta(session: IAssistantChatSession, messageId: string, delta: string) {
        touchSession(session);
        const message = session.messages.find(candidate => candidate.id === messageId)
            ?? addMessage(session, {
                id: messageId,
                role: 'assistant',
                text: '',
                pending: true,
            });
        message.pending = true;
        message.text += delta;
        options.onSessionMessageEvent?.({
            type: 'message-delta',
            messageId,
            delta,
        }, session);
        persistence?.recordAssistantDelta(keyForSession(session), session);
    }

    function recordSessionSnapshot(session: IAssistantChatSession) {
        persistence?.recordSessionSnapshot(keyForSession(session), session);
    }

    function recordTurnBoundary(session: IAssistantChatSession) {
        persistence?.recordTurnBoundary(keyForSession(session), session);
    }

    function resetSessionTranscript(session: IAssistantChatSession, reason = 'reset') {
        persistence?.archiveSession(keyForSession(session), reason);
        persistence?.recordSessionSnapshot(keyForSession(session), session);
    }

    function flushPersistenceForTests() {
        return persistence?.flushForTests() ?? Promise.resolve([]);
    }

    function flushPersistence() {
        return persistence?.flush() ?? Promise.resolve([]);
    }

    return {
        addMessage,
        appendAssistantDelta,
        clearActiveSession,
        clearActiveSessionForProvider,
        clearActiveSessionIfMatches,
        deleteSession,
        getActiveSession,
        getMessages,
        getRememberedScope,
        getRememberedSelection,
        getSession,
        getSessionByThreadId,
        flushPersistenceForTests,
        flushPersistence,
        keyForSession,
        listSessions,
        rememberStateScope,
        recordSessionSnapshot,
        recordTurnBoundary,
        resolveRequestedScope,
        resetSessionTranscript,
        setActiveSession,
        touchSession,
        updateRememberedSelection,
        upsertAssistantMessage,
    };
}

export type TAssistantChatSessionStore = ReturnType<typeof createAssistantChatSessionStore>;
