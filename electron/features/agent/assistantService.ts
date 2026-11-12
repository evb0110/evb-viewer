import {randomUUID} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import electron from 'electron';
import {
    ASSISTANT_MAX_IMAGE_ATTACHMENTS,
    ASSISTANT_MAX_IMAGE_BYTES,
    type IAgentAssistantChatScope,
    type IAgentAssistantImageAttachment,
    type IAgentAssistantModelOption,
    type IAgentCommandSuccessor,
} from '@contracts/agent';
import {
    AGENT_PLATFORM_FEATURE,
    type IAgentEventMap,
} from '@contracts/agentPlatformFeature';
import {
    ASSISTANT_DEFAULT_INSTANCE_IDS,
    assistantSessionKey,
    type IAssistantChat,
    type IAssistantChatRequest,
    type IAssistantEvent,
    type IAssistantInstanceConfig,
    type IAssistantInstanceRequest,
    type IAssistantInstanceStatus,
    type IAssistantItem,
    type IAssistantLoginRequest,
    type IAssistantLoginResult,
    type IAssistantOperationResult,
    type IAssistantSelection,
    type IAssistantSendRequest,
    type IAssistantState,
    type IAssistantStateRequest,
    type IAssistantTurn,
    type TAssistantItemStatus,
} from '@contracts/assistant';
import {
    ASSISTANT_DEFAULT_EFFORT,
    CLAUDE_ASSISTANT_MODELS,
} from '@contracts/agentModels';
import {isRecord} from '@contracts/runtimeGuards';
import {createIsoTimestamp} from '@contracts/timestamps';
import {parseTabId} from '@contracts/windowTabs';
import {
    AssistantChatPersistence,
    type IPersistedAssistantChatSession,
    type IPersistedAssistantMessage,
} from '@electron/features/agent/assistantChatPersistence';
import {createAssistantErrorEnvelope} from '@electron/features/agent/assistantErrorEnvelope';
import {
    assistantInstanceLabel,
    getAssistantInstanceConfigs,
    getAssistantInstanceFingerprints,
    onAssistantInstancesChanged,
    resolveAssistantLaunchContext,
    type IAssistantBinaryResolvers,
} from '@electron/features/agent/assistantInstances';
import {
    clearAssistantMcpSessionScope,
    getActiveAssistantMcpSessionScope,
    setActiveAssistantMcpSessionScope,
    setAssistantTurnSuccessorListener,
} from '@electron/features/agent/assistantMcpSessionScope';
import {normalizeOutgoingMessageRequest} from '@electron/features/agent/assistantOutgoingMessage';
import {resolveAssistantPresetInstructions} from '@electron/features/agent/assistantPresetWorkflows';
import type {IAssistantSessionScopeBinding} from '@electron/features/agent/assistantMcpSessionScope';
import {waitForBoundedAssistantInterrupt} from '@electron/features/agent/waitForBoundedAssistantInterrupt';
import {isCodexAppServerRequestTimeoutError} from '@electron/features/agent/codexAppServerClient';
import {
    ASSISTANT_MCP_SERVER_NAME,
    ASSISTANT_MODEL_CONFIG_DIR,
} from '@electron/features/agent/codexAssistantConfig';
import {
    getCodexCliInfo,
    installManagedCodex,
    resolveCodexCliPath,
} from '@electron/features/agent/codexCli';
import {
    CodexInstanceRuntime,
    type ICodexThreadListener,
} from '@electron/features/agent/codexInstanceRuntime';
import {
    getClaudeAgentSdkInfo, isClaudeAuthErrorMessage,
} from '@electron/features/agent/claudeProviderMetadata';
import type {ClaudeAgentAssistantSession} from '@electron/features/agent/claudeAgentSdkAssistant';
import {
    abortActiveEmbeddedMcpRequests,
    shutdownEmbeddedMcpServer,
    startEmbeddedMcpServer,
} from '@electron/features/agent/mcpServer';
import {loadSettings} from '@electron/settings';
import {te} from '@electron/te';
import {createLogger} from '@electron/utils/createLogger';
import {getErrorMessage} from '@electron/utils/error';
import {sendPlatformEvent} from '@electron/utils/sendPlatformEvent';
import {getAllRegisteredAppWindows} from '@electron/window/registry';

const logger = createLogger('agent-assistant-service');
const MAX_CACHED_SESSIONS = 64;
const TOOL_DETAIL_MAX_LENGTH = 4_000;
const TERMINAL_PHASES = new Set<IAssistantTurn['phase']>([
    'done',
    'failed',
    'cancelled',
]);

export interface IAgentAssistantSendOptions { windowId: number | null; }

interface IInstanceEntry {
    config: IAssistantInstanceConfig;
    status: IAssistantInstanceStatus;
    probe: Promise<void> | null;
    codex: CodexInstanceRuntime | null;
    /** The stored configuration this entry was built from, secrets included as ciphertext. */
    fingerprint: string;
}

interface IChatSession {
    key: string;
    instanceId: string;
    driver: IAssistantInstanceConfig['driver'];
    scope: IAgentAssistantChatScope;
    model: string;
    effort: string;
    speedMode: IAssistantSelection['speedMode'];
    providerThreadId: string | null;
    items: IAssistantItem[];
    lastAccessedAtMs: number;
    turn: IAssistantTurn | null;
    providerTurnId: string | null;
    binding: IAssistantSessionScopeBinding | null;
    claude: ClaudeAgentAssistantSession | null;
    pendingError: string | null;
    /** Resolved when the current turn ends; a steer waits on it. */
    settleWaiters: Array<() => void>;
}

const instances = new Map<string, IInstanceEntry>();
const sessions = new Map<string, IChatSession>();
const persistence = new AssistantChatPersistence({onError: (message, error) => logger.warn(`${message}: ${getErrorMessage(error)}`)});
let installProgress: string | null = null;
let installRunning: Promise<IAssistantOperationResult> | null = null;
let sessionsReady: Promise<void> | null = null;

const binaryResolvers: IAssistantBinaryResolvers = {
    codex: () => resolveCodexCliPath(),
    claude: async env => (await getClaudeAgentSdkInfo({env})).executablePath,
};

function nowIso() {
    return createIsoTimestamp();
}

function publish(event: IAssistantEvent) {
    for (const window of getAllRegisteredAppWindows()) {
        sendPlatformEvent<IAgentEventMap, typeof AGENT_PLATFORM_FEATURE.eventChannels.onAssistantEvent>(
            window,
            AGENT_PLATFORM_FEATURE.eventChannels.onAssistantEvent,
            event,
            error => logger.warn(`Failed to send assistant event: ${getErrorMessage(error)}`),
        );
    }
}

async function isAssistantEnabled() {
    return (await loadSettings()).assistantPanelEnabled === true;
}

function assistantDir(name: string) {
    return join(electron.app.getPath('userData'), ASSISTANT_MODEL_CONFIG_DIR, name);
}

async function assistantCwd() {
    const cwd = assistantDir('cwd');
    await mkdir(cwd, {recursive: true});
    return cwd;
}

async function embeddedMcp() {
    const {
        descriptor,
        token,
    } = await startEmbeddedMcpServer();
    return {
        url: descriptor.url,
        token,
    };
}

// ---------------------------------------------------------------------------
// Instance status
// ---------------------------------------------------------------------------

function initialStatus(config: IAssistantInstanceConfig, previous?: IAssistantInstanceStatus): IAssistantInstanceStatus {
    return {
        id: config.id,
        driver: config.driver,
        label: assistantInstanceLabel(config),
        enabled: config.enabled,
        state: config.enabled ? (previous?.state ?? 'checking') : 'disabled',
        auth: previous?.auth ?? 'unknown',
        ...(config.enabled && previous?.message ? {message: previous.message} : {}),
        binaryPath: previous?.binaryPath ?? null,
        version: previous?.version ?? null,
        homePath: previous?.homePath ?? null,
        customEndpoint: previous?.customEndpoint ?? false,
        account: previous?.account ?? null,
        models: previous?.models ?? (config.driver === 'claude' ? [...CLAUDE_ASSISTANT_MODELS] : []),
        defaultModel: previous?.defaultModel ?? null,
        checkedAt: previous?.checkedAt ?? null,
        canInstall: false,
        canSignIn: config.driver === 'codex',
        loginPending: false,
    };
}

function publishInstances() {
    publish({
        type: 'instances',
        instances: instanceStatuses(),
    });
}

function instanceStatuses() {
    return [...instances.values()].map(entry => ({
        ...entry.status,
        loginPending: entry.codex?.isLoginPending() ?? false,
    }));
}

function updateStatus(entry: IInstanceEntry, patch: Partial<IAssistantInstanceStatus>) {
    const next = {
        ...entry.status,
        ...patch,
    };
    if (patch.message === undefined && 'message' in patch) {
        delete next.message;
    }
    entry.status = next;
    publishInstances();
}

/**
 * Stops an instance whose configuration changed or went away. Its processes
 * stop first; only then do its turns end and release the document grant.
 */
async function retireInstance(entry: IInstanceEntry) {
    const affected = [...sessions.values()].filter(session => session.instanceId === entry.config.id);
    await Promise.all([
        entry.codex?.shutdown().catch(() => undefined),
        ...affected.map(async session => {
            const claude = session.claude;
            session.claude = null;
            await claude?.retire('after its instance changed');
        }),
    ]);
    for (const session of affected) {
        if (isTurnActive(session)) {
            finishTurn(session, 'cancelled');
        }
    }
}

let instanceSync: Promise<void> = Promise.resolve();

/** Brings instance entries in line with the stored configuration, one sync at a time. */
function syncInstances() {
    const next = instanceSync.then(syncInstancesNow, syncInstancesNow);
    instanceSync = next.catch(() => undefined);
    return next;
}

async function syncInstancesNow() {
    const configs = await getAssistantInstanceConfigs();
    const fingerprints = await getAssistantInstanceFingerprints();
    for (const [
        id,
        entry,
    ] of instances) {
        if (!fingerprints.has(id)) {
            instances.delete(id);
            await retireInstance(entry);
        }
    }
    for (const config of configs) {
        const fingerprint = fingerprints.get(config.id) ?? JSON.stringify(config);
        const existing = instances.get(config.id);
        if (existing?.fingerprint === fingerprint) {
            continue;
        }
        if (existing) {
            await retireInstance(existing);
        }
        const entry: IInstanceEntry = {
            config,
            status: initialStatus(config),
            probe: null,
            codex: null,
            fingerprint,
        };
        if (config.driver === 'codex') {
            entry.codex = new CodexInstanceRuntime({
                resolveContext: () => resolveAssistantLaunchContext(config.id, binaryResolvers),
                cwd: assistantCwd,
                embeddedMcp,
                onLoginFinished: error => {
                    if (error) {
                        updateStatus(entry, {message: error});
                    }
                    startProbe(entry, true);
                },
            });
        }
        instances.set(config.id, entry);
    }
}

function defaultModelOf(models: readonly IAgentAssistantModelOption[], declared: string | null) {
    return declared && models.some(model => model.id === declared) ? declared : (models[0]?.id ?? null);
}

async function probeEntry(entry: IInstanceEntry) {
    const {config} = entry;
    if (!config.enabled) {
        updateStatus(entry, {
            state: 'disabled',
            message: undefined,
        });
        return;
    }
    updateStatus(entry, {state: 'checking'});
    let context;
    try {
        context = await resolveAssistantLaunchContext(config.id, binaryResolvers);
    } catch (error) {
        updateStatus(entry, {
            state: 'error',
            message: getErrorMessage(error),
            checkedAt: nowIso(),
        });
        return;
    }
    const isDefaultCodex = config.driver === 'codex' && config.id === ASSISTANT_DEFAULT_INSTANCE_IDS.codex && !config.binaryPath;
    updateStatus(entry, {
        binaryPath: context.binaryPath,
        homePath: context.homePath,
        customEndpoint: context.customEndpoint,
        canInstall: isDefaultCodex && !context.binaryPath,
    });
    if (!context.binaryPath) {
        updateStatus(entry, {
            state: 'missing',
            auth: 'unknown',
            message: te(config.driver === 'codex' ? 'dialogs.agentAssistant.codexMissing' : 'dialogs.agentAssistant.claudeMissing'),
            checkedAt: nowIso(),
        });
        return;
    }
    try {
        if (config.driver === 'codex' && entry.codex) {
            const version = isDefaultCodex ? (await getCodexCliInfo()).version : null;
            const result = await entry.codex.probe();
            updateStatus(entry, {
                state: result.auth === 'unauthenticated' ? 'error' : (result.warning ? 'warning' : 'ready'),
                auth: result.auth,
                account: result.account,
                version,
                message: result.auth === 'unauthenticated'
                    ? te('dialogs.agentAssistant.codexSignIn')
                    : result.warning,
                ...(result.models.length > 0
                    ? {
                        models: result.models,
                        defaultModel: defaultModelOf(result.models, result.models.find(model => model.isDefault)?.id ?? null),
                    }
                    : {}),
                checkedAt: nowIso(),
            });
            return;
        }
        const {discoverClaudeAssistantModels} = await import('@electron/features/agent/claudeAgentSdkAssistant');
        const result = await discoverClaudeAssistantModels(await assistantCwd(), context.binaryPath, context.env, context.claudeExtraArgs);
        const models = result.models.length > 0 ? result.models : [...CLAUDE_ASSISTANT_MODELS];
        updateStatus(entry, {
            state: 'ready',
            auth: result.account ? 'authenticated' : 'unknown',
            account: result.account?.email ? {
                type: 'other',
                email: result.account.email,
            } : null,
            message: undefined,
            models,
            defaultModel: defaultModelOf(models, null),
            checkedAt: nowIso(),
        });
    } catch (error) {
        const message = getErrorMessage(error);
        updateStatus(entry, {
            state: 'error',
            auth: config.driver === 'claude' && isClaudeAuthErrorMessage(message) ? 'unauthenticated' : entry.status.auth,
            message,
            checkedAt: nowIso(),
        });
    }
}

/** One probe per instance at a time; each publishes its own result. */
function startProbe(entry: IInstanceEntry, force = false) {
    if (entry.probe || (!force && entry.status.checkedAt !== null)) {
        return;
    }
    const probe = probeEntry(entry)
        .catch((error: unknown) => logger.warn(`Assistant instance ${entry.config.id} probe failed: ${getErrorMessage(error)}`))
        .finally(() => {
            if (entry.probe === probe) {
                entry.probe = null;
            }
        });
    entry.probe = probe;
}

// ---------------------------------------------------------------------------
// Chat sessions
// ---------------------------------------------------------------------------

function toItem(message: IPersistedAssistantMessage): IAssistantItem {
    const status: TAssistantItemStatus = message.status
        ?? (message.error ? 'failed' : message.pending ? 'interrupted' : 'completed');
    const errorEnvelope = message.errorEnvelope ?? (message.role === 'system' && message.error
        ? createAssistantErrorEnvelope(message.error)
        : undefined);
    return {
        id: message.id,
        kind: message.role,
        turnId: message.turnId ?? null,
        createdAt: message.createdAt,
        text: message.text,
        status,
        ...(message.attachments ? {attachments: message.attachments} : {}),
        ...(message.toolName ? {toolName: message.toolName} : {}),
        ...(message.toolDetail ? {toolDetail: message.toolDetail} : {}),
        ...(message.completedAt ? {completedAt: message.completedAt} : {}),
        ...(errorEnvelope ? {errorEnvelope} : {}),
    };
}

function toMessage(item: IAssistantItem): IPersistedAssistantMessage {
    return {
        id: item.id,
        role: item.kind,
        text: item.text,
        createdAt: item.createdAt,
        turnId: item.turnId,
        status: item.status,
        ...(item.attachments ? {attachments: item.attachments} : {}),
        ...(item.toolName ? {toolName: item.toolName} : {}),
        ...(item.toolDetail ? {toolDetail: item.toolDetail} : {}),
        ...(item.completedAt ? {completedAt: item.completedAt} : {}),
        ...(item.errorEnvelope ? {errorEnvelope: item.errorEnvelope} : {}),
    };
}

function persistedSession(session: IChatSession): IPersistedAssistantChatSession {
    return {
        provider: session.driver,
        ...(session.instanceId === session.driver ? {} : {instanceId: session.instanceId}),
        scope: session.scope,
        model: session.model,
        effort: session.effort,
        speedMode: session.speedMode,
        providerThreadId: session.providerThreadId,
        turnOwner: {
            phase: 'idle',
            generation: 0,
            turnId: null,
            localTurnId: null,
        },
        messages: session.items.map(toMessage),
        lastAccessedAtMs: session.lastAccessedAtMs,
    };
}

/**
 * Keeps the newest items within the persistence budgets: text within the
 * session byte cap and images within one message's worth of attachments.
 * The newest item always stays.
 */
function boundItems(session: IChatSession) {
    const maxTextBytes = persistence.getMaxSessionBytes();
    const maxImageBytes = ASSISTANT_MAX_IMAGE_ATTACHMENTS * ASSISTANT_MAX_IMAGE_BYTES;
    let textBytes = 0;
    let imageBytes = 0;
    let keepFrom = session.items.length;
    for (let index = session.items.length - 1; index >= 0; index -= 1) {
        const item = session.items[index];
        if (!item) {
            continue;
        }
        const itemText = Buffer.byteLength(item.text, 'utf8') + Buffer.byteLength(item.toolDetail ?? '', 'utf8') + 256;
        const itemImages = item.attachments?.reduce((total, attachment) => total + attachment.sizeBytes, 0) ?? 0;
        if (keepFrom < session.items.length && (textBytes + itemText > maxTextBytes || imageBytes + itemImages > maxImageBytes)) {
            break;
        }
        textBytes += itemText;
        imageBytes += itemImages;
        keepFrom = index;
    }
    if (keepFrom > 0) {
        session.items = session.items.slice(keepFrom);
    }
}

function save(session: IChatSession) {
    boundItems(session);
    persistence.recordSessionSnapshot(session.key, persistedSession(session));
}

function chatOf(session: IChatSession): IAssistantChat {
    return {
        sessionKey: session.key,
        scope: session.scope,
        instanceId: session.instanceId,
        model: session.model,
        items: session.items,
        turn: session.turn,
    };
}

function ensureSessionsReady() {
    sessionsReady ??= persistence.recoverSessions().then(recovered => {
        for (const entry of recovered.slice(-MAX_CACHED_SESSIONS)) {
            const session = fromPersisted(entry.key, entry.session);
            if (session) {
                sessions.set(session.key, session);
            }
        }
    }).catch((error: unknown) => {
        logger.warn(`Assistant chats could not be recovered: ${getErrorMessage(error)}`);
    });
    return sessionsReady;
}

function fromPersisted(key: string, stored: IPersistedAssistantChatSession): IChatSession | null {
    const instanceId = stored.instanceId ?? stored.provider;
    if (key !== assistantSessionKey(instanceId, stored.scope.key)) {
        return null;
    }
    return {
        key,
        instanceId,
        driver: stored.provider,
        scope: stored.scope,
        model: stored.model,
        effort: stored.effort,
        speedMode: stored.speedMode,
        providerThreadId: stored.providerThreadId,
        items: stored.messages.map(toItem),
        lastAccessedAtMs: stored.lastAccessedAtMs,
        turn: null,
        providerTurnId: null,
        binding: null,
        claude: null,
        pendingError: null,
        settleWaiters: [],
    };
}

function isTurnActive(session: IChatSession) {
    return session.turn !== null && !TERMINAL_PHASES.has(session.turn.phase);
}

function evictSessions() {
    if (sessions.size <= MAX_CACHED_SESSIONS) {
        return;
    }
    const idle = [...sessions.values()]
        .filter(session => !isTurnActive(session))
        .sort((left, right) => left.lastAccessedAtMs - right.lastAccessedAtMs);
    for (const session of idle.slice(0, sessions.size - MAX_CACHED_SESSIONS)) {
        sessions.delete(session.key);
        void session.claude?.retire('after eviction');
    }
}

async function findSession(scope: IAgentAssistantChatScope, instanceId: string) {
    await ensureSessionsReady();
    const key = assistantSessionKey(instanceId, scope.key);
    let session = sessions.get(key);
    if (!session) {
        // A recovery failure surfaces to the caller; a blank chat must not
        // replace history that is only temporarily unreadable.
        const recovered = await persistence.recoverSession(key);
        session = recovered ? fromPersisted(key, recovered.session) ?? undefined : undefined;
        if (session) {
            sessions.set(key, session);
        }
    }
    if (session) {
        // The live document identity always comes from the renderer.
        session.scope = scope;
    }
    return session ?? null;
}

async function openSession(scope: IAgentAssistantChatScope, entry: IInstanceEntry, selection: IAssistantSelection) {
    const existing = await findSession(scope, entry.config.id);
    if (existing) {
        existing.lastAccessedAtMs = Date.now();
        return existing;
    }
    const session: IChatSession = {
        key: assistantSessionKey(entry.config.id, scope.key),
        instanceId: entry.config.id,
        driver: entry.config.driver,
        scope,
        model: selection.model,
        effort: selection.effort,
        speedMode: selection.speedMode,
        providerThreadId: null,
        items: [],
        lastAccessedAtMs: Date.now(),
        turn: null,
        providerTurnId: null,
        binding: null,
        claude: null,
        pendingError: null,
        settleWaiters: [],
    };
    sessions.set(session.key, session);
    evictSessions();
    return session;
}

function upsertItem(session: IChatSession, item: IAssistantItem) {
    const index = session.items.findIndex(candidate => candidate.id === item.id);
    if (index < 0) {
        session.items.push(item);
    } else {
        session.items[index] = item;
    }
    publish({
        type: 'item',
        sessionKey: session.key,
        item,
    });
}

function appendToItem(session: IChatSession, base: Omit<IAssistantItem, 'text' | 'status' | 'createdAt'>, delta: string) {
    const existing = session.items.find(candidate => candidate.id === base.id);
    if (!existing) {
        upsertItem(session, {
            ...base,
            createdAt: nowIso(),
            text: delta,
            status: 'streaming',
        });
        return;
    }
    existing.text += delta;
    publish({
        type: 'item-delta',
        sessionKey: session.key,
        itemId: existing.id,
        delta,
    });
}

function setTurn(session: IChatSession, turn: IAssistantTurn | null) {
    session.turn = turn;
    publish({
        type: 'turn',
        sessionKey: session.key,
        turn,
    });
}

function setPhase(session: IChatSession, phase: IAssistantTurn['phase']) {
    if (session.turn && session.turn.phase !== phase && !TERMINAL_PHASES.has(session.turn.phase)) {
        setTurn(session, {
            ...session.turn,
            phase,
        });
    }
}

function addSystemItem(session: IChatSession, message: string, turnId: string | null) {
    upsertItem(session, {
        id: randomUUID(),
        kind: 'system',
        turnId,
        createdAt: nowIso(),
        text: message,
        status: 'failed',
        errorEnvelope: createAssistantErrorEnvelope(message),
    });
}

/**
 * Ends the session's turn once. Streaming items settle with the turn, the
 * MCP grant is withdrawn, and the transcript is saved.
 */
function finishTurn(session: IChatSession, requestedPhase: 'done' | 'failed' | 'cancelled', error?: string) {
    if (!session.turn || TERMINAL_PHASES.has(session.turn.phase)) {
        return;
    }
    // A provider may report an interrupted turn as completed.
    const phase = requestedPhase === 'done' && session.turn.phase === 'interrupting' ? 'cancelled' : requestedPhase;
    const turnId = session.turn.id;
    const itemStatus: TAssistantItemStatus = phase === 'done' ? 'completed' : phase === 'cancelled' ? 'interrupted' : 'failed';
    for (const item of session.items) {
        if (item.turnId === turnId && item.status === 'streaming') {
            item.status = itemStatus;
            item.completedAt = nowIso();
            publish({
                type: 'item',
                sessionKey: session.key,
                item,
            });
        }
    }
    if (error) {
        addSystemItem(session, error, turnId);
    }
    session.providerTurnId = null;
    session.pendingError = null;
    if (session.binding) {
        if (phase !== 'done') {
            abortActiveEmbeddedMcpRequests(session.binding);
        }
        clearAssistantMcpSessionScope(session.key);
        session.binding = null;
    }
    setTurn(session, {
        ...session.turn,
        phase,
    });
    save(session);
    for (const resolve of session.settleWaiters.splice(0)) {
        resolve();
    }
}

function createBinding(session: IChatSession, windowId: number): IAssistantSessionScopeBinding {
    const tabId = parseTabId(session.scope.tabId);
    if (tabId === null) {
        throw new Error(te('dialogs.agentAssistant.noDocumentTab'));
    }
    return {
        sessionKey: session.key,
        scopeKey: session.scope.key,
        provider: session.driver,
        turnGeneration: 0,
        windowId,
        tabId,
        documentSessionKey: session.scope.documentSessionKey ?? null,
        documentRef: session.scope.documentRef ?? null,
        ...(session.scope.documentBackend === undefined ? {} : {documentBackend: session.scope.documentBackend}),
        documentInstanceId: session.scope.documentInstanceId ?? null,
        documentIdentity: session.scope.documentIdentity ?? null,
        ...(session.scope.commandTarget === undefined ? {} : {commandTarget: {...session.scope.commandTarget}}),
    };
}

// A write the turn's own command committed moves the turn to the new revision.
setAssistantTurnSuccessorListener((binding, successor: IAgentCommandSuccessor) => {
    const session = sessions.get(binding.sessionKey);
    const current = session?.binding;
    if (!session || !current || current.commandTarget?.tabId !== successor.commandTarget.tabId
        || current.commandTarget.documentRef !== successor.commandTarget.documentRef
        || (current.commandTarget.documentInstanceId ?? null) !== (successor.commandTarget.documentInstanceId ?? null)) {
        return false;
    }
    session.binding = {
        ...current,
        commandTarget: {...successor.commandTarget},
        documentIdentity: successor.documentIdentity && {...successor.documentIdentity},
    };
    session.scope = {
        ...session.scope,
        commandTarget: {...successor.commandTarget},
        documentIdentity: successor.documentIdentity && {...successor.documentIdentity},
    };
    setActiveAssistantMcpSessionScope(session.binding);
    return true;
});

// ---------------------------------------------------------------------------
// Provider event mapping
// ---------------------------------------------------------------------------

function truncate(text: string) {
    return text.length > TOOL_DETAIL_MAX_LENGTH ? `${text.slice(0, TOOL_DETAIL_MAX_LENGTH)}…` : text;
}

function describeToolDetail(item: Record<string, unknown>) {
    const parts: string[] = [];
    if (item.arguments !== undefined && item.arguments !== null) {
        parts.push(truncate(JSON.stringify(item.arguments, null, 2)));
    }
    if (isRecord(item.error) && typeof item.error.message === 'string') {
        parts.push(item.error.message);
    } else if (isRecord(item.result) && Array.isArray(item.result.content)) {
        const text = item.result.content
            .map(block => isRecord(block) && typeof block.text === 'string' ? block.text : '')
            .filter(Boolean)
            .join('\n');
        if (text) {
            parts.push(truncate(text));
        }
    }
    return parts.join('\n\n');
}

function codexItemStatus(raw: unknown, completed: boolean): TAssistantItemStatus {
    if (raw === 'failed') {
        return 'failed';
    }
    return completed || raw === 'completed' ? 'completed' : 'streaming';
}

function applyCodexItem(session: IChatSession, turnId: string, item: Record<string, unknown>, completed: boolean) {
    const id = typeof item.id === 'string' ? item.id : null;
    if (!id) {
        return;
    }
    const existing = session.items.find(candidate => candidate.id === id);
    const base = {
        id,
        turnId,
        createdAt: existing?.createdAt ?? nowIso(),
        ...(completed ? {completedAt: nowIso()} : {}),
    };
    switch (item.type) {
        case 'agentMessage':
            setPhase(session, 'streaming');
            upsertItem(session, {
                ...base,
                kind: 'assistant',
                text: typeof item.text === 'string' && (completed || !existing) ? item.text : (existing?.text ?? ''),
                status: completed ? 'completed' : 'streaming',
            });
            return;
        case 'reasoning': {
            const summary = Array.isArray(item.summary) ? item.summary.filter(part => typeof part === 'string').join('\n\n') : '';
            const content = Array.isArray(item.content) ? item.content.filter(part => typeof part === 'string').join('\n\n') : '';
            const text = [
                summary,
                content,
                existing?.text ?? '',
            ].find(part => part.length > 0) ?? '';
            setPhase(session, 'thinking');
            upsertItem(session, {
                ...base,
                kind: 'reasoning',
                text,
                status: completed ? 'completed' : 'streaming',
            });
            return;
        }
        case 'mcpToolCall':
        case 'dynamicToolCall':
        case 'commandExecution':
        case 'webSearch':
        case 'fileChange':
        case 'imageView': {
            setPhase(session, completed ? 'thinking' : 'tool-running');
            const toolName = typeof item.tool === 'string'
                ? item.tool
                : typeof item.command === 'string' ? item.command : String(item.type);
            upsertItem(session, {
                ...base,
                kind: 'tool',
                text: '',
                toolName,
                toolDetail: describeToolDetail(item),
                status: codexItemStatus(item.status, completed),
            });
            return;
        }
        default:
    }
}

function codexListener(session: IChatSession): ICodexThreadListener {
    return {
        onNotification(method, params) {
            const turnId = session.turn?.id;
            if (!turnId || !isTurnActive(session)) {
                return;
            }
            const providerTurnId = typeof params.turnId === 'string'
                ? params.turnId
                : isRecord(params.turn) && typeof params.turn.id === 'string' ? params.turn.id : null;
            if (session.providerTurnId && providerTurnId && providerTurnId !== session.providerTurnId) {
                return;
            }
            switch (method) {
                case 'turn/started':
                    setPhase(session, 'thinking');
                    return;
                case 'item/started':
                case 'item/completed':
                    if (isRecord(params.item)) {
                        applyCodexItem(session, turnId, params.item, method === 'item/completed');
                    }
                    return;
                case 'item/agentMessage/delta':
                    if (typeof params.itemId === 'string' && typeof params.delta === 'string') {
                        setPhase(session, 'streaming');
                        appendToItem(session, {
                            id: params.itemId,
                            kind: 'assistant',
                            turnId,
                        }, params.delta);
                    }
                    return;
                case 'item/reasoning/summaryTextDelta':
                case 'item/reasoning/textDelta':
                    if (typeof params.itemId === 'string' && typeof params.delta === 'string') {
                        appendToItem(session, {
                            id: params.itemId,
                            kind: 'reasoning',
                            turnId,
                        }, params.delta);
                    }
                    return;
                case 'thread/tokenUsage/updated': {
                    const last = isRecord(params.tokenUsage) && isRecord(params.tokenUsage.last) ? params.tokenUsage.last : null;
                    if (last && session.turn && typeof last.inputTokens === 'number' && typeof last.outputTokens === 'number') {
                        setTurn(session, {
                            ...session.turn,
                            usage: {
                                inputTokens: last.inputTokens,
                                outputTokens: last.outputTokens,
                                ...(typeof last.cachedInputTokens === 'number' ? {cachedInputTokens: last.cachedInputTokens} : {}),
                            },
                        });
                    }
                    return;
                }
                case 'error':
                    if (params.willRetry !== true && isRecord(params.error) && typeof params.error.message === 'string') {
                        session.pendingError = params.error.message;
                    }
                    return;
                case 'turn/completed': {
                    const turn = isRecord(params.turn) ? params.turn : {};
                    const turnError = isRecord(turn.error) && typeof turn.error.message === 'string' ? turn.error.message : null;
                    if (turn.status === 'interrupted') {
                        finishTurn(session, 'cancelled');
                    } else if (turn.status === 'failed') {
                        finishTurn(session, 'failed', turnError ?? session.pendingError ?? te('dialogs.agentAssistant.replyFailed', {provider: 'Codex'}));
                    } else {
                        finishTurn(session, 'done');
                    }
                    return;
                }
                default:
            }
        },
        onExit(message) {
            if (isTurnActive(session)) {
                finishTurn(session, 'failed', te('dialogs.agentAssistant.providerStopped', {
                    provider: 'Codex',
                    reason: message,
                }));
            }
        },
    };
}

function claudeCallbacks(session: IChatSession) {
    let reasoningItemId: string | null = null;
    // Claude names its own turns; a callback from an earlier, interrupted
    // turn must not touch the current one.
    const currentTurn = (providerTurnId: string | null = null) => (
        isTurnActive(session)
        && (providerTurnId === null || session.providerTurnId === null || providerTurnId === session.providerTurnId)
            ? session.turn?.id ?? null
            : null
    );
    return {
        onInitialized: () => undefined,
        onTurnStarted: (providerTurnId: string) => {
            if (isTurnActive(session)) {
                session.providerTurnId = providerTurnId;
                setPhase(session, 'thinking');
            }
        },
        onAssistantDelta: (providerTurnId: string | null, messageId: string, delta: string) => {
            const turnId = currentTurn(providerTurnId);
            if (!turnId) {
                return;
            }
            reasoningItemId = null;
            setPhase(session, 'streaming');
            appendToItem(session, {
                id: messageId,
                kind: 'assistant',
                turnId,
            }, delta);
        },
        onReasoningDelta: (providerTurnId: string | null, delta: string) => {
            const turnId = currentTurn(providerTurnId);
            if (!turnId) {
                return;
            }
            reasoningItemId ??= randomUUID();
            setPhase(session, 'thinking');
            appendToItem(session, {
                id: reasoningItemId,
                kind: 'reasoning',
                turnId,
            }, delta);
        },
        onToolActivity: (providerTurnId: string | null, activity: {
            toolId: string;
            name: string;
            phase: 'running' | 'completed' | 'failed'
        }) => {
            const turnId = currentTurn(providerTurnId);
            if (!turnId) {
                return;
            }
            reasoningItemId = null;
            setPhase(session, activity.phase === 'running' ? 'tool-running' : 'thinking');
            const existing = session.items.find(candidate => candidate.id === activity.toolId);
            upsertItem(session, {
                id: activity.toolId,
                kind: 'tool',
                turnId,
                createdAt: existing?.createdAt ?? nowIso(),
                text: '',
                toolName: activity.name.replace(`mcp__${ASSISTANT_MCP_SERVER_NAME}__`, ''),
                status: activity.phase === 'running' ? 'streaming' : activity.phase,
            });
        },
        onUsage: (providerTurnId: string | null, usage: NonNullable<IAssistantTurn['usage']>) => {
            if (session.turn && currentTurn(providerTurnId)) {
                setTurn(session, {
                    ...session.turn,
                    usage,
                });
            }
        },
        onAssistantMessage: (providerTurnId: string | null, messageId: string, text: string, pending: boolean) => {
            const turnId = currentTurn(providerTurnId);
            if (!turnId) {
                return;
            }
            const existing = session.items.find(candidate => candidate.id === messageId);
            upsertItem(session, {
                id: messageId,
                kind: 'assistant',
                turnId,
                createdAt: existing?.createdAt ?? nowIso(),
                text,
                status: pending ? 'streaming' : 'completed',
            });
        },
        onTurnCompleted: (providerTurnId: string | null) => {
            if (currentTurn(providerTurnId)) {
                finishTurn(session, 'done');
            }
        },
        onError: (providerTurnId: string | null, message: string) => {
            if (isClaudeAuthErrorMessage(message)) {
                const entry = instances.get(session.instanceId);
                if (entry) {
                    updateStatus(entry, {
                        state: 'error',
                        auth: 'unauthenticated',
                        message,
                    });
                }
            }
            if (currentTurn(providerTurnId)) {
                finishTurn(session, 'failed', message);
            } else if (!isTurnActive(session)) {
                addSystemItem(session, message, null);
                save(session);
            }
        },
    };
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

function resolveSelection(requested: IAssistantSelection | undefined): IAssistantSelection | null {
    const enabled = [...instances.values()].filter(entry => entry.config.enabled);
    const entry = (requested && enabled.find(candidate => candidate.config.id === requested.instanceId)) ?? enabled[0];
    if (!entry) {
        return null;
    }
    const {models} = entry.status;
    const model = requested && requested.instanceId === entry.config.id && (models.length === 0 || models.some(candidate => candidate.id === requested.model))
        ? requested.model
        : entry.status.defaultModel ?? models[0]?.id ?? '';
    const option = models.find(candidate => candidate.id === model);
    const efforts = option?.reasoningEfforts?.map(effort => effort.id) ?? [];
    const requestedEffort = requested?.effort ?? ASSISTANT_DEFAULT_EFFORT;
    const effort = efforts.length === 0 || efforts.includes(requestedEffort)
        ? requestedEffort
        : option?.defaultReasoningEffort ?? efforts[0] ?? ASSISTANT_DEFAULT_EFFORT;
    return {
        instanceId: entry.config.id,
        model,
        effort,
        speedMode: requested?.speedMode ?? 'standard',
    };
}

function codexServiceTier(entry: IInstanceEntry, selection: IAssistantSelection) {
    if (selection.speedMode !== 'fast') {
        return null;
    }
    const tiers = entry.status.models.find(model => model.id === selection.model)?.serviceTiers ?? [];
    return tiers.find(tier => tier.id === 'priority' || tier.id === 'fast')?.id ?? null;
}

// ---------------------------------------------------------------------------
// Public operations
// ---------------------------------------------------------------------------

async function buildState(scope: IAgentAssistantChatScope | null | undefined, requested: IAssistantSelection | undefined): Promise<IAssistantState> {
    const selection = resolveSelection(requested);
    const session = scope && selection ? await findSession(scope, selection.instanceId) : null;
    return {
        supported: true,
        enabled: true,
        instances: instanceStatuses(),
        selection,
        chat: session
            ? chatOf(session)
            : scope && selection
                ? {
                    sessionKey: assistantSessionKey(selection.instanceId, scope.key),
                    scope,
                    instanceId: selection.instanceId,
                    model: selection.model,
                    items: [],
                    turn: null,
                }
                : null,
        installProgress,
    };
}

function disabledState(): IAssistantState {
    return {
        supported: true,
        enabled: false,
        instances: instanceStatuses(),
        selection: null,
        chat: null,
        installProgress: null,
    };
}

let instancesListenerInstalled = false;

function ensureInstancesListener() {
    if (instancesListenerInstalled) {
        return;
    }
    instancesListenerInstalled = true;
    onAssistantInstancesChanged(() => {
        void isAssistantEnabled().then(async enabled => {
            if (!enabled) {
                return;
            }
            await syncInstances();
            for (const entry of instances.values()) {
                startProbe(entry);
            }
            publishInstances();
        });
    });
}

/**
 * Returns cached instance statuses at once. A probe request starts each
 * enabled instance's status check in the background; every check publishes
 * its own result, so a slow instance never holds back another.
 */
export async function getAgentAssistantState(request?: IAssistantStateRequest): Promise<IAssistantState> {
    if (!(await isAssistantEnabled())) {
        await shutdownAgentAssistant();
        return disabledState();
    }
    ensureInstancesListener();
    await syncInstances();
    for (const entry of instances.values()) {
        if (entry.config.enabled) {
            startProbe(entry, request?.probe === true);
        } else if (entry.status.state !== 'disabled') {
            updateStatus(entry, {state: 'disabled'});
        }
    }
    return buildState(request?.scope, request?.selection);
}

function errorResult(state: IAssistantState, message: string): IAssistantOperationResult {
    return {
        ok: false,
        state,
        error: createAssistantErrorEnvelope(message),
    };
}

const INTERRUPT_TIMEOUT_MS = 12_000;

/**
 * Stops the session's running turn and returns once it has ended, so a late
 * completion of the old turn cannot end the next one. A provider that does
 * not confirm in time is treated as stopped.
 */
async function interruptActiveTurn(session: IChatSession) {
    if (!session.turn || !isTurnActive(session)) {
        return;
    }
    const turnId = session.turn.id;
    const stillOwns = () => session.turn?.id === turnId && isTurnActive(session);
    const entry = instances.get(session.instanceId);
    const codexTurn = session.driver === 'codex' && entry?.codex && session.providerThreadId && session.providerTurnId
        ? {
            runtime: entry.codex,
            threadId: session.providerThreadId,
            providerTurnId: session.providerTurnId,
        }
        : null;
    const claude = session.driver === 'claude' ? session.claude : null;
    setPhase(session, 'interrupting');
    if (!codexTurn && !claude) {
        // Still starting: the start sees the turn has ended and submits nothing.
        finishTurn(session, 'cancelled');
        return;
    }
    const settled = new Promise<void>(resolve => session.settleWaiters.push(resolve));
    const request = codexTurn
        ? codexTurn.runtime.interrupt(codexTurn.threadId, codexTurn.providerTurnId)
        : claude?.interrupt();
    try {
        // One deadline for the request and the provider's terminal event.
        await waitForBoundedAssistantInterrupt(Promise.all([
            request,
            settled,
        ]), INTERRUPT_TIMEOUT_MS);
    } catch (error) {
        if (!stillOwns()) {
            return;
        }
        // An unconfirmed stop ends the provider process before the document
        // grant is released, so old work cannot continue under a new grant.
        logger.warn(`Assistant interrupt was not confirmed; stopping the provider: ${getErrorMessage(error)}`);
        if (codexTurn) {
            await codexTurn.runtime.shutdown().catch(() => undefined);
        } else if (claude) {
            await claude.retire('after an unconfirmed interrupt');
            if (session.claude === claude) {
                session.claude = null;
            }
        }
    }
    // A stop that finishes after its turn ended must not touch a newer turn.
    if (stillOwns()) {
        finishTurn(session, 'cancelled');
    }
}

/** Thrown when the turn a start belongs to has already ended (stopped or replaced). */
class TurnEndedError extends Error {}

async function startCodexTurn(
    session: IChatSession,
    entry: IInstanceEntry,
    selection: IAssistantSelection,
    text: string,
    attachments: IAgentAssistantImageAttachment[],
    owns: () => boolean,
) {
    const runtime = entry.codex;
    if (!runtime) {
        throw new Error(te('dialogs.agentAssistant.instanceNotAvailable'));
    }
    // A thread from another home (such as EVB's former private Codex home)
    // fails to resume, and the runtime starts a fresh one.
    const opened = await runtime.openThread(session.providerThreadId, selection.model, codexListener(session));
    if (!owns()) {
        throw new TurnEndedError();
    }
    if (session.items.some(item => item.kind === 'assistant') && !opened.resumed) {
        addSystemNotice(session, te('dialogs.agentAssistant.freshContext', {provider: 'Codex'}));
    }
    session.providerThreadId = opened.threadId;
    let providerTurnId: string;
    try {
        providerTurnId = await runtime.startTurn({
            threadId: opened.threadId,
            text,
            attachments,
            model: selection.model,
            effort: selection.effort,
            serviceTier: codexServiceTier(entry, selection),
        });
    } catch (error) {
        // A start without a reply may still be running in Codex; only stopping
        // the process makes it safe to release the document grant.
        if (isCodexAppServerRequestTimeoutError(error)) {
            await runtime.shutdown().catch(() => undefined);
        }
        throw error;
    }
    if (!owns()) {
        // Accepted after the turn was stopped or replaced: end the work for certain.
        await runtime.shutdown().catch(() => undefined);
        throw new TurnEndedError();
    }
    session.providerTurnId = providerTurnId;
    setPhase(session, 'thinking');
}

function addSystemNotice(session: IChatSession, text: string) {
    upsertItem(session, {
        id: randomUUID(),
        kind: 'system',
        turnId: session.turn?.id ?? null,
        createdAt: nowIso(),
        text,
        status: 'completed',
    });
}

async function startClaudeTurn(
    session: IChatSession,
    entry: IInstanceEntry,
    selection: IAssistantSelection,
    text: string,
    attachments: IAgentAssistantImageAttachment[],
    owns: () => boolean,
) {
    const context = await resolveAssistantLaunchContext(entry.config.id, binaryResolvers);
    if (!context.binaryPath) {
        throw new Error(te('dialogs.agentAssistant.claudeMissing'));
    }
    if (session.claude && !(await session.claude.prepareForSettings(selection.model, selection.effort, selection.speedMode))) {
        session.claude = null;
    }
    if (!session.claude) {
        const {
            ClaudeAgentAssistantSession,
            hasClaudeSessionTranscript,
        } = await import('@electron/features/agent/claudeAgentSdkAssistant');
        const mcp = await embeddedMcp();
        const resumable = session.providerThreadId !== null
            && await hasClaudeSessionTranscript(context.env, session.providerThreadId);
        if (!resumable && session.items.some(item => item.kind === 'assistant')) {
            addSystemNotice(session, te('dialogs.agentAssistant.freshContext', {provider: 'Claude'}));
        }
        const claude = new ClaudeAgentAssistantSession({
            cwd: await assistantCwd(),
            model: selection.model,
            effort: selection.effort,
            speedMode: selection.speedMode,
            resumeSessionId: resumable ? session.providerThreadId : null,
            mcpServerName: ASSISTANT_MCP_SERVER_NAME,
            mcpServerUrl: mcp.url,
            mcpToken: mcp.token,
            executablePath: context.binaryPath,
            env: context.env,
            extraArgs: context.claudeExtraArgs,
            callbacks: {
                ...claudeCallbacks(session),
                onInitialized: info => {
                    if (info.sessionId) {
                        session.providerThreadId = info.sessionId;
                        save(session);
                    }
                },
            },
        });
        session.claude = claude;
    }
    if (!owns()) {
        throw new TurnEndedError();
    }
    const claude = session.claude;
    try {
        await claude.sendMessage(text, attachments, selection.model);
    } catch (error) {
        await claude.retire('after a failed send');
        if (session.claude === claude) {
            session.claude = null;
        }
        throw error;
    }
    if (!owns()) {
        await claude.retire('after its turn ended during startup');
        if (session.claude === claude) {
            session.claude = null;
        }
        throw new TurnEndedError();
    }
}

let admission: Promise<unknown> = Promise.resolve();

/**
 * Runs turn admission one send at a time, from the grant check to the
 * provider's acceptance of the turn, so two sends never share or swap the
 * single document grant. Stop does not wait here.
 */
function admit<T>(work: () => Promise<T>) {
    const next = admission.then(work, work);
    admission = next.catch(() => undefined);
    return next;
}

/**
 * Sends one message. A running turn in this chat is interrupted first, so a
 * message typed while the assistant works steers it. Another chat's running
 * turn keeps the shared document tools, so that send is refused.
 */
export function sendAgentAssistantMessage(
    request: IAssistantSendRequest,
    options: IAgentAssistantSendOptions,
): Promise<IAssistantOperationResult> {
    return admit(() => sendAdmitted(request, options));
}

async function sendAdmitted(
    request: IAssistantSendRequest,
    options: IAgentAssistantSendOptions,
): Promise<IAssistantOperationResult> {
    if (!(await isAssistantEnabled())) {
        await shutdownAgentAssistant();
        return errorResult(disabledState(), te('dialogs.agentAssistant.disabledMessage'));
    }
    await syncInstances();
    const entry = instances.get(request.selection.instanceId);
    const fallbackState = () => buildState(request.scope, request.selection);
    if (!entry || !entry.config.enabled) {
        return errorResult(await fallbackState(), te('dialogs.agentAssistant.instanceUnavailable'));
    }
    const selection = resolveSelection(request.selection) ?? request.selection;
    let normalized: ReturnType<typeof normalizeOutgoingMessageRequest>;
    try {
        normalized = normalizeOutgoingMessageRequest(request);
    } catch (error) {
        return errorResult(await fallbackState(), getErrorMessage(error));
    }
    const presetInstructions = resolveAssistantPresetInstructions(request.presetId);
    const modelText = presetInstructions
        ? (normalized.text ? `${normalized.text}\n\n${presetInstructions}` : presetInstructions)
        : normalized.text;
    if (!normalized.text && normalized.attachments.length === 0 && !presetInstructions) {
        return errorResult(await fallbackState(), te('dialogs.agentAssistant.emptyMessage'));
    }
    const session = await openSession(request.scope, entry, selection);
    const activeBinding = getActiveAssistantMcpSessionScope();
    if (activeBinding && activeBinding.sessionKey !== session.key) {
        const other = sessions.get(activeBinding.sessionKey);
        if (other && isTurnActive(other)) {
            return errorResult(await buildState(request.scope, selection), te('dialogs.agentAssistant.otherDocumentBusy'));
        }
        clearAssistantMcpSessionScope(activeBinding.sessionKey);
    }
    await interruptActiveTurn(session);
    session.model = selection.model;
    session.effort = selection.effort;
    session.speedMode = selection.speedMode;
    session.lastAccessedAtMs = Date.now();
    const turnId = randomUUID();
    upsertItem(session, {
        id: randomUUID(),
        kind: 'user',
        turnId,
        createdAt: nowIso(),
        text: normalized.text,
        status: 'completed',
        ...(normalized.attachments.length > 0 ? {attachments: normalized.attachments} : {}),
    });
    setTurn(session, {
        id: turnId,
        phase: 'queued',
        startedAtMs: Date.now(),
        usage: null,
    });
    const owns = () => session.turn?.id === turnId && isTurnActive(session);
    try {
        session.binding = createBinding(session, options.windowId ?? -1);
        setActiveAssistantMcpSessionScope(session.binding);
        if (entry.config.driver === 'codex') {
            await startCodexTurn(session, entry, selection, modelText, normalized.attachments, owns);
        } else {
            await startClaudeTurn(session, entry, selection, modelText, normalized.attachments, owns);
        }
        save(session);
        return {
            ok: true,
            state: await buildState(request.scope, selection),
        };
    } catch (error) {
        if (error instanceof TurnEndedError || !owns()) {
            // Stopped or replaced while starting; the stop already settled the turn.
            return {
                ok: true,
                state: await buildState(request.scope, selection),
            };
        }
        const message = getErrorMessage(error);
        finishTurn(session, 'failed', message);
        if (entry.status.state === 'ready' || entry.status.state === 'checking' || entry.status.state === 'warning') {
            updateStatus(entry, {
                state: 'error',
                message,
            });
        }
        return errorResult(await buildState(request.scope, selection), message);
    }
}

export async function interruptAgentAssistant(request: IAssistantChatRequest) {
    const session = await findSession(request.scope, request.instanceId);
    if (session) {
        await interruptActiveTurn(session);
    }
    return buildState(request.scope, session ? {
        instanceId: session.instanceId,
        model: session.model,
        effort: session.effort,
        speedMode: session.speedMode,
    } : undefined);
}

export async function resetAgentAssistantChat(request: IAssistantChatRequest) {
    const session = await findSession(request.scope, request.instanceId);
    if (session) {
        await interruptActiveTurn(session);
        await session.claude?.retire('after a chat reset');
        if (session.providerThreadId && session.driver === 'codex') {
            instances.get(session.instanceId)?.codex?.releaseThread(session.providerThreadId);
        }
        persistence.archiveSession(session.key, 'reset');
        sessions.delete(session.key);
        publish({
            type: 'chat',
            chat: {
                sessionKey: session.key,
                scope: request.scope,
                instanceId: session.instanceId,
                model: session.model,
                items: [],
                turn: null,
            },
        });
    }
    return buildState(request.scope, session ? {
        instanceId: session.instanceId,
        model: session.model,
        effort: session.effort,
        speedMode: session.speedMode,
    } : undefined);
}

export async function startAgentAssistantLogin(request: IAssistantLoginRequest): Promise<IAssistantLoginResult> {
    await syncInstances();
    const entry = instances.get(request.instanceId);
    if (!entry?.codex) {
        return {
            ok: false,
            state: await buildState(null, undefined),
            error: createAssistantErrorEnvelope(te('dialogs.agentAssistant.claudeSignIn')),
        };
    }
    try {
        const urls = await entry.codex.startLogin(request.mode);
        publishInstances();
        return {
            ok: true,
            state: await buildState(null, undefined),
            ...urls,
        };
    } catch (error) {
        return {
            ok: false,
            state: await buildState(null, undefined),
            error: createAssistantErrorEnvelope(getErrorMessage(error)),
        };
    }
}

export async function cancelAgentAssistantLogin(request: IAssistantInstanceRequest) {
    await instances.get(request.instanceId)?.codex?.cancelLogin();
    publishInstances();
    return buildState(null, undefined);
}

/** Installs the pinned Codex release for the default Codex instance. */
export function installAgentAssistantCodex(): Promise<IAssistantOperationResult> {
    installRunning ??= (async () => {
        try {
            const setProgress = (progress: string | null) => {
                installProgress = progress;
                publish({
                    type: 'install-progress',
                    progress,
                });
            };
            setProgress('Downloading Codex…');
            await installManagedCodex({onProgress: setProgress});
            setProgress(null);
            await syncInstances();
            const entry = instances.get(ASSISTANT_DEFAULT_INSTANCE_IDS.codex);
            if (entry) {
                startProbe(entry, true);
            }
            return {
                ok: true,
                state: await buildState(null, undefined),
            };
        } catch (error) {
            installProgress = null;
            publish({
                type: 'install-progress',
                progress: null,
            });
            return errorResult(await buildState(null, undefined), getErrorMessage(error));
        } finally {
            installRunning = null;
        }
    })();
    return installRunning;
}

/** Stops every assistant process. Saved chats stay. */
export async function shutdownAgentAssistant() {
    // Processes stop before any turn ends, because ending a turn releases the document grant.
    await Promise.all([...instances.values()].map(entry => retireInstance(entry)));
    clearAssistantMcpSessionScope();
    await shutdownEmbeddedMcpServer().catch(() => undefined);
}

export async function preserveAssistantStateForShutdown() {
    for (const session of sessions.values()) {
        save(session);
    }
    await persistence.flush();
}
