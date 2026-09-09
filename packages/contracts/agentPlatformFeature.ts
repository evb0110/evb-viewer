import type {
    IAgentAssistantAccount,
    IAgentAssistantChatScope,
    IAgentAssistantChatMessage,
    IAgentAssistantEffortOption,
    IAgentAssistantErrorEnvelope,
    IAgentAssistantEvent,
    IAgentAssistantImageAttachment,
    IAgentAssistantInstallResult,
    IAgentAssistantLoginRequest,
    IAgentAssistantLoginResult,
    IAgentAssistantMcpStatus,
    IAgentAssistantModelOption,
    IAgentAssistantProviderStatus,
    IAgentAssistantScopedRequest,
    IAgentAssistantSendMessageRequest,
    IAgentAssistantSendMessageResult,
    IAgentAssistantServiceTierOption,
    IAgentAssistantStateRequest,
    IAgentCommandCancelRequest,
    IAgentCommandExecutionScope,
    IAgentCommandRequest,
    IAgentCommandResponse,
    IAgentMcpIntegrationStatus,
    IAgentMcpIntegrationUpdateResult,
    IAgentRendererAck,
    IAgentAssistantState,
    IAgentAssistantStatus,
    IAgentAssistantTurnState,
    IAgentWorkspaceSnapshotRequest,
    IAgentWorkspaceSnapshotResponse,
    TAgentCommand,
    TAgentWorkspaceCommandTarget,
} from '@contracts/agent';
import {
    AGENT_ASSISTANT_ERROR_CODES,
    AGENT_ASSISTANT_EVENT_TYPES,
    AGENT_ASSISTANT_MESSAGE_ROLES,
    AGENT_ASSISTANT_PRESET_IDS,
    AGENT_ASSISTANT_TURN_PHASES,
    ASSISTANT_MAX_IMAGE_ATTACHMENTS,
    ASSISTANT_MAX_IMAGE_BYTES,
    ASSISTANT_PROVIDER_IDS,
} from '@contracts/agent';
import { isAgentWorkspaceSnapshot } from '@contracts/isAgentWorkspaceSnapshot';
import {
    parseDocumentRef,
    type TDocumentBackend,
} from '@contracts/documentRef';
import {
    isDocumentRevisionInfo,
    parseDocumentRevisionToken,
} from '@contracts/documentRevision';
import { parseDocumentInstanceId } from '@contracts/documentInstanceId';
import {
    parseRequestId,
    parseSessionId,
} from '@contracts/shared';
import {parseTabId} from '@contracts/windowTabs';
import {
    parseEpochMs,
    parseIsoTimestamp,
    requireEpochMs,
    requireIsoTimestamp,
} from '@contracts/timestamps';
import type {TTabId} from '@contracts/windowTabs';
import {
    isOneOf,
    isRecord,
} from '@contracts/runtimeGuards';
import {
    argsSchema,
    definePlatformFeature,
    resultSchema,
    runtimeSchema as s,
    type IRuntimeSchema,
    type TFeatureCapability,
    type TFeatureEventMap,
    type TFeatureInvokeMap,
} from '@contracts/platformFeature';

const AGENT_ASSISTANT_INSTALL_STATES = [
    'installed',
    'missing',
    'unsupported',
] as const;
const AGENT_ASSISTANT_AUTH_STATES = [
    'signed-in',
    'signed-out',
    'login-pending',
    'unknown',
] as const;
const AGENT_ASSISTANT_RUNTIME_STATES = [
    'stopped',
    'starting',
    'ready',
    'busy',
    'error',
] as const;
const AGENT_ASSISTANT_MODEL_SWITCH_MODES = [
    'none',
    'in-session',
] as const;
const AGENT_ASSISTANT_SPEED_MODES = [
    'fast',
    'standard',
] as const;
const ASSISTANT_MAX_IMAGE_DATA_URL_LENGTH = Math.ceil(ASSISTANT_MAX_IMAGE_BYTES / 3) * 4 + 128;
const ASSISTANT_IMAGE_DATA_URL_PREFIX_RE = /^data:image\/[a-z0-9.+-]+(?:;[a-z0-9.+-]+=[a-z0-9.+/-]+)*;base64,/iu;

function requireArgs(args: readonly unknown[], count: number | {
    min: number;
    max: number;
}) {
    const min = typeof count === 'number' ? count : count.min;
    const max = typeof count === 'number' ? count : count.max;
    if (args.length < min || args.length > max) {
        const expected = min === max ? String(min) : `${min}-${max}`;
        throw new Error(`expected ${expected} arguments, received ${args.length}`);
    }
    return args;
}

function decodeOptionalSelection(
    value: Record<PropertyKey, unknown>,
): Pick<IAgentAssistantStateRequest, 'provider' | 'model' | 'effort' | 'speedMode'> {
    if (
        value.provider !== undefined && !isOneOf(ASSISTANT_PROVIDER_IDS, value.provider)
        || value.model !== undefined && typeof value.model !== 'string'
        || value.effort !== undefined && typeof value.effort !== 'string'
        || value.speedMode !== undefined && value.speedMode !== 'fast' && value.speedMode !== 'standard'
    ) {
        throw new Error('invalid assistant selection');
    }
    return {
        ...(value.provider === undefined ? {} : {provider: value.provider}),
        ...(value.model === undefined ? {} : {model: value.model}),
        ...(value.effort === undefined ? {} : {effort: value.effort}),
        ...(value.speedMode === undefined ? {} : {speedMode: value.speedMode}),
    };
}

function decodeOptionalScope(value: unknown) {
    if (value === undefined || value === null) {
        return value;
    }
    const scope = decodeAgentAssistantChatScope(value);
    if (scope === null) {
        throw new Error('invalid assistant scope');
    }
    return scope;
}

function decodeAssistantStateRequest(value: unknown): IAgentAssistantStateRequest | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }
    if (!isRecord(value)) {
        throw new Error('assistant state request must be an object');
    }
    const scope = decodeOptionalScope(value.scope);
    return {
        ...decodeOptionalSelection(value),
        ...(scope === undefined ? {} : {scope}),
    };
}

function decodeAssistantSendMessageRequest(value: unknown): IAgentAssistantSendMessageRequest {
    if (!isRecord(value) || typeof value.text !== 'string') {
        throw new Error('assistant message request must include text');
    }
    const scope = decodeOptionalScope(value.scope);
    let attachments;
    if (value.attachments !== undefined) {
        if (!Array.isArray(value.attachments)) {
            throw new Error('assistant attachments must be an array');
        }
        if (value.attachments.length > ASSISTANT_MAX_IMAGE_ATTACHMENTS) {
            throw new Error(
                `assistant attachments exceeds maximum item count (${ASSISTANT_MAX_IMAGE_ATTACHMENTS})`,
            );
        }
        attachments = value.attachments.map((attachment) => {
            const decoded = decodeAgentAssistantImageAttachment(attachment);
            if (
                decoded === null
                || !decoded.mimeType.toLowerCase().startsWith('image/')
                || decoded.sizeBytes > ASSISTANT_MAX_IMAGE_BYTES
                || decoded.dataUrl.length > ASSISTANT_MAX_IMAGE_DATA_URL_LENGTH
                || !ASSISTANT_IMAGE_DATA_URL_PREFIX_RE.test(decoded.dataUrl)
            ) {
                throw new Error('invalid assistant image attachment');
            }
            return decoded;
        });
    }
    if (value.presetId !== undefined && !isOneOf(AGENT_ASSISTANT_PRESET_IDS, value.presetId)) {
        throw new Error('invalid assistant preset');
    }
    return {
        text: value.text,
        ...decodeOptionalSelection(value),
        ...(scope === undefined ? {} : {scope}),
        ...(attachments === undefined ? {} : {attachments}),
        ...(value.presetId === undefined ? {} : {presetId: value.presetId}),
    };
}

function decodeWorkspaceSnapshotResponse(value: unknown): IAgentWorkspaceSnapshotResponse {
    const requestId = isRecord(value) ? parseRequestId(value.requestId) : null;
    if (
        !isRecord(value)
        || requestId === null
        || typeof value.ok !== 'boolean'
        || (value.windowId !== undefined && (typeof value.windowId !== 'number' || !Number.isSafeInteger(value.windowId)))
        || (value.revision !== undefined && (typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision)))
        || (value.unchanged !== undefined && typeof value.unchanged !== 'boolean')
        || (value.snapshot !== undefined && !isAgentWorkspaceSnapshot(value.snapshot))
        || (value.error !== undefined && typeof value.error !== 'string')
    ) {
        throw new Error('invalid workspace snapshot response');
    }
    return {
        requestId,
        ok: value.ok,
        ...(value.windowId === undefined ? {} : {windowId: value.windowId}),
        ...(value.snapshot === undefined ? {} : {snapshot: value.snapshot}),
        ...(value.revision === undefined ? {} : {revision: value.revision}),
        ...(value.unchanged === undefined ? {} : {unchanged: value.unchanged}),
        ...(value.error === undefined ? {} : {error: value.error}),
    };
}

function decodeCommandResponse(value: unknown): IAgentCommandResponse {
    const requestId = isRecord(value) ? parseRequestId(value.requestId) : null;
    if (
        !isRecord(value)
        || requestId === null
        || typeof value.ok !== 'boolean'
        || (value.windowId !== undefined && (typeof value.windowId !== 'number' || !Number.isSafeInteger(value.windowId)))
        || (value.result !== undefined && !isRecord(value.result))
        || (value.error !== undefined && typeof value.error !== 'string')
    ) {
        throw new Error('invalid agent command response');
    }
    return {
        requestId,
        ok: value.ok,
        ...(value.windowId === undefined ? {} : {windowId: value.windowId}),
        ...(value.result === undefined ? {} : {result: value.result}),
        ...(value.error === undefined ? {} : {error: value.error}),
    };
}

function decodeMcpStatus(value: unknown): IAgentMcpIntegrationStatus {
    const lastCheckedAt = isRecord(value) ? parseIsoTimestamp(value.lastCheckedAt) : null;
    if (
        !isRecord(value)
        || typeof value.enabled !== 'boolean'
        || typeof value.serverName !== 'string'
        || typeof value.serverUrl !== 'string'
        || typeof value.serverRunning !== 'boolean'
        || typeof value.codexInstalled !== 'boolean'
        || (value.codexPath !== null && typeof value.codexPath !== 'string')
        || typeof value.codexConfigured !== 'boolean'
        || (
            value.codexRegistrationState !== 'configured'
            && value.codexRegistrationState !== 'missing'
            && value.codexRegistrationState !== 'mismatched'
            && value.codexRegistrationState !== 'unknown'
        )
        || typeof value.installUrl !== 'string'
        || lastCheckedAt === null
        || (value.error !== undefined && typeof value.error !== 'string')
    ) {
        throw new Error('invalid agent MCP status');
    }
    const setupSnippets = value.setupSnippets;
    let decodedSetupSnippets: IAgentMcpIntegrationStatus['setupSnippets'];
    if (
        setupSnippets !== undefined
        && (
            !isRecord(setupSnippets)
            || typeof setupSnippets.codex !== 'string'
            || typeof setupSnippets.claude !== 'string'
            || typeof setupSnippets.cursor !== 'string'
        )
    ) {
        throw new Error('invalid agent MCP setup snippets');
    }
    if (
        isRecord(setupSnippets)
        && typeof setupSnippets.codex === 'string'
        && typeof setupSnippets.claude === 'string'
        && typeof setupSnippets.cursor === 'string'
    ) {
        decodedSetupSnippets = {
            codex: setupSnippets.codex,
            claude: setupSnippets.claude,
            cursor: setupSnippets.cursor,
        };
    }
    return {
        enabled: value.enabled,
        serverName: value.serverName,
        serverUrl: value.serverUrl,
        serverRunning: value.serverRunning,
        codexInstalled: value.codexInstalled,
        codexPath: value.codexPath,
        codexConfigured: value.codexConfigured,
        codexRegistrationState: value.codexRegistrationState,
        installUrl: value.installUrl,
        lastCheckedAt,
        ...(decodedSetupSnippets === undefined ? {} : {setupSnippets: decodedSetupSnippets}),
        ...(value.error === undefined ? {} : {error: value.error}),
    };
}

function decodeMcpUpdateResult(value: unknown): IAgentMcpIntegrationUpdateResult {
    if (
        !isRecord(value)
        || typeof value.ok !== 'boolean'
        || (value.cancelled !== undefined && typeof value.cancelled !== 'boolean')
        || (value.error !== undefined && typeof value.error !== 'string')
    ) {
        throw new Error('invalid agent MCP update result');
    }
    return {
        ok: value.ok,
        ...(value.cancelled === undefined ? {} : {cancelled: value.cancelled}),
        status: decodeMcpStatus(value.status),
        ...(value.error === undefined ? {} : {error: value.error}),
    };
}

function decodeRendererAck(value: unknown): IAgentRendererAck {
    if (
        !isRecord(value)
        || typeof value.accepted !== 'boolean'
        || (
            value.reason !== undefined
            && value.reason !== 'invalid-payload'
            && value.reason !== 'unexpected-sender'
            && value.reason !== 'unknown-request'
        )
    ) {
        throw new Error('invalid agent renderer acknowledgement');
    }
    const reason: IAgentRendererAck['reason'] = value.reason;
    return {
        accepted: value.accepted,
        ...(reason === undefined ? {} : {reason}),
    };
}

function normalizeNonEmptyString(value: unknown) {
    if (typeof value !== 'string') {
        return null;
    }
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
}

function normalizeOptionalWindowId(value: unknown) {
    if (value === undefined) {
        return undefined;
    }
    return typeof value === 'number' && Number.isInteger(value) && value >= 0
        ? value
        : null;
}

function normalizeOptionalRevision(value: unknown) {
    if (value === undefined) {
        return undefined;
    }
    return typeof value === 'number' && Number.isInteger(value) && value >= 0
        ? value
        : null;
}

function normalizeOptionalTabId(value: unknown) {
    if (value === undefined || value === null) {
        return undefined;
    }
    return parseTabId(value);
}

function normalizeOptionalDocumentRef(value: unknown) {
    if (value === undefined || value === null) {
        return null;
    }
    return parseDocumentRef(value);
}

function normalizeNullableDocumentRef(value: unknown) {
    if (value === null) {
        return null;
    }

    return parseDocumentRef(value);
}

function normalizeRequiredTabId(value: unknown): TTabId | null {
    return parseTabId(value);
}

function normalizeOptionalDocumentBackend(value: unknown): TDocumentBackend | null | undefined {
    if (value === undefined) {
        return undefined;
    }
    return value === 'browser' || value === 'electron'
        ? value
        : null;
}

function normalizeOptionalDocumentRevisionToken(value: unknown) {
    if (value === undefined) {
        return undefined;
    }

    return parseDocumentRevisionToken(value);
}

function normalizeOptionalDocumentInstanceId(value: unknown) {
    if (value === undefined || value === null) {
        return null;
    }

    return parseDocumentInstanceId(value);
}

function decodeCommandTargetBase(value: Record<PropertyKey, unknown>) {
    const tabId = normalizeRequiredTabId(value.tabId);
    const sessionId = parseSessionId(value.sessionId);
    const documentRef = normalizeNullableDocumentRef(value.documentRef);
    const documentBackend = normalizeOptionalDocumentBackend(value.documentBackend);
    const documentInstanceId = normalizeOptionalDocumentInstanceId(value.documentInstanceId);
    const documentRevisionToken = normalizeOptionalDocumentRevisionToken(value.documentRevisionToken);
    if (
        tabId === null
        || sessionId === null
        || documentRef === null && value.documentRef !== null
        || documentBackend === null
        || documentInstanceId === null && value.documentInstanceId !== null && value.documentInstanceId !== undefined
        || documentRevisionToken === null
    ) {
        return null;
    }

    return {
        tabId,
        sessionId,
        documentRef,
        ...(documentBackend === undefined ? {} : {documentBackend}),
        documentInstanceId,
        ...(documentRevisionToken === undefined ? {} : {documentRevisionToken}),
    };
}

function decodeWorkspaceCommandTarget(value: unknown): TAgentWorkspaceCommandTarget | null | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }
    if (!isRecord(value)) {
        return null;
    }

    const base = decodeCommandTargetBase(value);
    if (!base) {
        return null;
    }

    if (value.kind === 'transaction') {
        const transactionId = normalizeNonEmptyString(value.transactionId);
        return transactionId === null
            ? null
            : {
                kind: 'transaction',
                ...base,
                transactionId,
            };
    }

    if (value.kind === 'revision') {
        const sessionRevision = normalizeOptionalRevision(value.sessionRevision);
        return sessionRevision === undefined || sessionRevision === null
            ? null
            : {
                kind: 'revision',
                ...base,
                sessionRevision,
            };
    }

    return null;
}

function decodeCommandExecutionScope(value: unknown): IAgentCommandExecutionScope | null | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }
    if (!isRecord(value)) {
        return null;
    }

    const windowId = normalizeOptionalWindowId(value.windowId);
    const tabId = normalizeRequiredTabId(value.tabId);
    const documentRef = normalizeOptionalDocumentRef(value.documentRef);
    const documentBackend = normalizeOptionalDocumentBackend(value.documentBackend);
    const documentInstanceId = normalizeOptionalDocumentInstanceId(value.documentInstanceId);
    const documentIdentity = value.documentIdentity === undefined || value.documentIdentity === null
        ? null
        : isDocumentRevisionInfo(value.documentIdentity)
            ? value.documentIdentity
            : undefined;
    const commandTarget = decodeWorkspaceCommandTarget(value.commandTarget);
    if (
        windowId === undefined
        || windowId === null
        || tabId === null
        || documentRef === null
        || documentBackend === null
        || documentInstanceId === null && value.documentInstanceId !== null && value.documentInstanceId !== undefined
        || documentIdentity === undefined
        || commandTarget === null
    ) {
        return null;
    }

    return {
        windowId,
        tabId,
        documentRef,
        ...(documentBackend === undefined ? {} : {documentBackend}),
        documentInstanceId,
        documentIdentity,
        ...(commandTarget === undefined ? {} : {commandTarget}),
    };
}

function decodeAgentCommand(value: unknown): TAgentCommand | null {
    if (!isRecord(value) || !isRecord(value.arguments)) {
        return null;
    }

    if (value.name === 'activate_tab') {
        const tabId = normalizeRequiredTabId(value.arguments.tabId);
        return tabId === null
            ? null
            : {
                name: 'activate_tab',
                arguments: {tabId},
            };
    }

    if (value.name === 'go_to_page') {
        const page = value.arguments.page;
        const tabId = normalizeOptionalTabId(value.arguments.tabId);
        if (
            typeof page !== 'number'
            || !Number.isFinite(page)
            || page <= 0
            || tabId === null
        ) {
            return null;
        }
        return {
            name: 'go_to_page',
            arguments: {
                page,
                ...(tabId === undefined ? {} : {tabId}),
            },
        };
    }

    if (value.name === 'run_action') {
        const id = normalizeNonEmptyString(value.arguments.id);
        const tabId = normalizeOptionalTabId(value.arguments.tabId);
        const input = value.arguments.input;
        const dryRun = value.arguments.dryRun;
        if (
            id === null
            || tabId === null
            || (input !== undefined && !isRecord(input))
            || (dryRun !== undefined && typeof dryRun !== 'boolean')
        ) {
            return null;
        }
        return {
            name: 'run_action',
            arguments: {
                id,
                ...(tabId === undefined ? {} : {tabId}),
                ...(input === undefined ? {} : {input}),
                ...(dryRun === undefined ? {} : {dryRun}),
            },
        };
    }

    if (value.name === 'read_resource') {
        const uri = normalizeNonEmptyString(value.arguments.uri);
        const tabId = normalizeOptionalTabId(value.arguments.tabId);
        if (uri === null || tabId === null) {
            return null;
        }
        return {
            name: 'read_resource',
            arguments: {
                uri,
                ...(tabId === undefined ? {} : {tabId}),
            },
        };
    }

    return null;
}

function isAssistantEventType(value: unknown): value is typeof AGENT_ASSISTANT_EVENT_TYPES[number] {
    return isOneOf(AGENT_ASSISTANT_EVENT_TYPES, value);
}

function isAssistantMessageRole(value: unknown): value is typeof AGENT_ASSISTANT_MESSAGE_ROLES[number] {
    return isOneOf(AGENT_ASSISTANT_MESSAGE_ROLES, value);
}

function isAssistantErrorCode(value: unknown): value is typeof AGENT_ASSISTANT_ERROR_CODES[number] {
    return isOneOf(AGENT_ASSISTANT_ERROR_CODES, value);
}

function decodeArray<T>(value: unknown, decode: (item: unknown) => T | null): T[] | null {
    if (!Array.isArray(value)) {
        return null;
    }
    const decoded: T[] = [];
    for (const item of value) {
        const result = decode(item);
        if (result === null) {
            return null;
        }
        decoded.push(result);
    }
    return decoded;
}

function decodeStringArray(value: unknown) {
    return Array.isArray(value) && value.every(item => typeof item === 'string')
        ? [...value]
        : null;
}

function decodeAssistantErrorEnvelope(value: unknown): IAgentAssistantErrorEnvelope | null {
    const timestamp = isRecord(value) ? parseEpochMs(value.timestamp) : null;
    if (
        !isRecord(value)
        || !isAssistantErrorCode(value.code)
        || typeof value.message !== 'string'
        || typeof value.retryable !== 'boolean'
        || timestamp === null
    ) {
        return null;
    }

    return {
        code: value.code,
        message: value.message,
        retryable: value.retryable,
        timestamp,
    };
}

function decodeAgentAssistantImageAttachment(value: unknown): IAgentAssistantImageAttachment | null {
    if (
        !isRecord(value)
        || value.type !== 'image'
        || typeof value.id !== 'string'
        || typeof value.name !== 'string'
        || typeof value.mimeType !== 'string'
        || typeof value.dataUrl !== 'string'
        || typeof value.sizeBytes !== 'number'
        || !Number.isFinite(value.sizeBytes)
        || value.sizeBytes <= 0
    ) {
        return null;
    }

    return {
        type: 'image',
        id: value.id,
        name: value.name,
        mimeType: value.mimeType,
        sizeBytes: value.sizeBytes,
        dataUrl: value.dataUrl,
    };
}

function decodeAssistantMessage(value: unknown): IAgentAssistantChatMessage | null {
    if (!isRecord(value)) {
        return null;
    }

    const errorEnvelope = value.errorEnvelope === undefined
        ? undefined
        : decodeAssistantErrorEnvelope(value.errorEnvelope);
    const createdAt = parseIsoTimestamp(value.createdAt);
    if (
        typeof value.id !== 'string'
        || !isAssistantMessageRole(value.role)
        || typeof value.text !== 'string'
        || createdAt === null
        || (value.pending !== undefined && typeof value.pending !== 'boolean')
        || (value.error !== undefined && typeof value.error !== 'string')
        || (value.errorEnvelope !== undefined && errorEnvelope === null)
    ) {
        return null;
    }

    let attachments: IAgentAssistantImageAttachment[] | undefined;
    if (value.attachments !== undefined) {
        if (!Array.isArray(value.attachments)) {
            return null;
        }
        attachments = [];
        for (const attachment of value.attachments) {
            const decoded = decodeAgentAssistantImageAttachment(attachment);
            if (decoded === null) {
                return null;
            }
            attachments.push(decoded);
        }
    }

    const message: IAgentAssistantChatMessage = {
        id: value.id,
        role: value.role,
        text: value.text,
        createdAt,
    };
    if (attachments !== undefined) {
        message.attachments = attachments;
    }
    if (value.pending !== undefined) {
        message.pending = value.pending;
    }
    if (value.error !== undefined) {
        message.error = value.error;
    }
    if (errorEnvelope !== undefined && errorEnvelope !== null) {
        message.errorEnvelope = errorEnvelope;
    }
    return message;
}

function decodeAssistantAccount(value: unknown): IAgentAssistantAccount | null {
    if (
        !isRecord(value)
        || (value.type !== 'chatgpt' && value.type !== 'apiKey' && value.type !== 'other')
        || (value.email !== undefined && typeof value.email !== 'string')
        || (value.planType !== undefined && typeof value.planType !== 'string')
    ) {
        return null;
    }
    return {
        type: value.type,
        ...(value.email === undefined ? {} : {email: value.email}),
        ...(value.planType === undefined ? {} : {planType: value.planType}),
    };
}

function decodeAssistantEffortOption(value: unknown): IAgentAssistantEffortOption | null {
    if (
        !isRecord(value)
        || typeof value.id !== 'string'
        || typeof value.label !== 'string'
        || (value.description !== undefined && typeof value.description !== 'string')
        || (value.isDefault !== undefined && typeof value.isDefault !== 'boolean')
    ) {
        return null;
    }
    return {
        id: value.id,
        label: value.label,
        ...(value.description === undefined ? {} : {description: value.description}),
        ...(value.isDefault === undefined ? {} : {isDefault: value.isDefault}),
    };
}

function decodeAssistantServiceTierOption(value: unknown): IAgentAssistantServiceTierOption | null {
    if (
        !isRecord(value)
        || typeof value.id !== 'string'
        || typeof value.label !== 'string'
        || (value.description !== undefined && typeof value.description !== 'string')
        || (value.isDefault !== undefined && typeof value.isDefault !== 'boolean')
    ) {
        return null;
    }
    return {
        id: value.id,
        label: value.label,
        ...(value.description === undefined ? {} : {description: value.description}),
        ...(value.isDefault === undefined ? {} : {isDefault: value.isDefault}),
    };
}

function decodeAssistantModelOption(value: unknown): IAgentAssistantModelOption | null {
    if (!isRecord(value) || typeof value.id !== 'string' || typeof value.label !== 'string') {
        return null;
    }
    const reasoningEfforts = value.reasoningEfforts === undefined
        ? undefined
        : decodeArray(value.reasoningEfforts, decodeAssistantEffortOption);
    const serviceTiers = value.serviceTiers === undefined
        ? undefined
        : decodeArray(value.serviceTiers, decodeAssistantServiceTierOption);
    if (
        reasoningEfforts === null
        || serviceTiers === null
        || (
            value.defaultReasoningEffort !== undefined
            && value.defaultReasoningEffort !== null
            && typeof value.defaultReasoningEffort !== 'string'
        )
        || (
            value.defaultServiceTier !== undefined
            && value.defaultServiceTier !== null
            && typeof value.defaultServiceTier !== 'string'
        )
    ) {
        return null;
    }
    return {
        id: value.id,
        label: value.label,
        ...(reasoningEfforts === undefined ? {} : {reasoningEfforts}),
        ...(value.defaultReasoningEffort === undefined
            ? {}
            : {defaultReasoningEffort: value.defaultReasoningEffort}),
        ...(serviceTiers === undefined ? {} : {serviceTiers}),
        ...(value.defaultServiceTier === undefined
            ? {}
            : {defaultServiceTier: value.defaultServiceTier}),
    };
}

function decodeAssistantMcpStatus(value: unknown): IAgentAssistantMcpStatus | null {
    if (
        !isRecord(value)
        || typeof value.serverName !== 'string'
        || typeof value.serverUrl !== 'string'
        || typeof value.serverRunning !== 'boolean'
        || typeof value.toolCount !== 'number'
        || !Number.isSafeInteger(value.toolCount)
        || value.toolCount < 0
    ) {
        return null;
    }
    return {
        serverName: value.serverName,
        serverUrl: value.serverUrl,
        serverRunning: value.serverRunning,
        toolCount: value.toolCount,
    };
}

function decodeAssistantTurnState(value: unknown): IAgentAssistantTurnState | null {
    const usage = value && isRecord(value) && value.usage !== null
        ? decodeAssistantTokenUsage(value.usage)
        : null;
    if (
        !isRecord(value)
        || (value.id !== null && typeof value.id !== 'string')
        || !isOneOf(AGENT_ASSISTANT_TURN_PHASES, value.phase)
        || typeof value.reasoning !== 'string'
        || !Array.isArray(value.toolActivity)
        || !value.toolActivity.every(isAssistantToolActivity)
        || (value.lastEventAtMs !== null && (typeof value.lastEventAtMs !== 'number' || !Number.isFinite(value.lastEventAtMs)))
        || usage === null && value.usage !== null
    ) {
        return null;
    }
    return {
        id: value.id,
        phase: value.phase,
        reasoning: value.reasoning,
        toolActivity: value.toolActivity,
        lastEventAtMs: value.lastEventAtMs,
        usage,
    };
}

function decodeAssistantTokenUsage(value: unknown): IAgentAssistantTurnState['usage'] {
    if (!isRecord(value)
        || typeof value.inputTokens !== 'number'
        || typeof value.outputTokens !== 'number'
        || (value.cachedInputTokens !== undefined && typeof value.cachedInputTokens !== 'number')) {
        return null;
    }
    return {
        inputTokens: value.inputTokens,
        outputTokens: value.outputTokens,
        ...(value.cachedInputTokens === undefined ? {} : {cachedInputTokens: value.cachedInputTokens}),
    };
}

function isAssistantToolActivity(value: unknown): value is IAgentAssistantTurnState['toolActivity'][number] {
    return isRecord(value)
        && typeof value.toolId === 'string'
        && typeof value.name === 'string'
        && (value.phase === 'running' || value.phase === 'completed' || value.phase === 'failed')
        && typeof value.startedAtMs === 'number'
        && Number.isFinite(value.startedAtMs)
        && (value.completedAtMs === undefined
            || typeof value.completedAtMs === 'number' && Number.isFinite(value.completedAtMs));
}

function decodeDocumentRevisionInfo(value: unknown) {
    if (!isDocumentRevisionInfo(value)) {
        return null;
    }
    const token = parseDocumentRevisionToken(value.token);
    if (token === null) {
        return null;
    }
    return {
        version: 1 as const,
        token,
        documentRef: value.documentRef,
        authority: value.authority,
        contentRevision: value.contentRevision,
        mintedAt: value.mintedAt,
    };
}

function decodeAgentAssistantChatScope(value: unknown): IAgentAssistantChatScope | null {
    if (
        !isRecord(value)
        || value.kind !== 'document'
        || typeof value.key !== 'string'
        || value.key.trim().length === 0
        || (value.title !== null && typeof value.title !== 'string')
        || (value.tabId !== undefined && value.tabId !== null && typeof value.tabId !== 'string')
        || (
            value.documentSessionKey !== undefined
            && value.documentSessionKey !== null
            && typeof value.documentSessionKey !== 'string'
        )
        || (value.documentRef !== undefined && value.documentRef !== null && typeof value.documentRef !== 'string')
        || (
            value.documentBackend !== undefined
            && value.documentBackend !== 'browser'
            && value.documentBackend !== 'electron'
        )
    ) {
        return null;
    }
    const tabId = value.tabId === undefined || value.tabId === null
        ? value.tabId
        : parseTabId(value.tabId);
    const documentRef = value.documentRef === undefined || value.documentRef === null
        ? value.documentRef
        : parseDocumentRef(value.documentRef);
    if (tabId === null && value.tabId !== null || documentRef === null && value.documentRef !== null) {
        return null;
    }
    const documentInstanceId = value.documentInstanceId === undefined || value.documentInstanceId === null
        ? value.documentInstanceId
        : parseDocumentInstanceId(value.documentInstanceId);
    const documentIdentity = value.documentIdentity === undefined || value.documentIdentity === null
        ? value.documentIdentity
        : decodeDocumentRevisionInfo(value.documentIdentity);
    const commandTarget = decodeWorkspaceCommandTarget(value.commandTarget);
    if (
        documentInstanceId === null && value.documentInstanceId !== null
        || documentIdentity === null && value.documentIdentity !== null
        || commandTarget === null
        || value.commandTarget === null
    ) {
        return null;
    }
    return {
        kind: 'document',
        key: value.key,
        title: value.title,
        ...(tabId === undefined ? {} : {tabId}),
        ...(value.documentSessionKey === undefined ? {} : {documentSessionKey: value.documentSessionKey}),
        ...(documentInstanceId === undefined ? {} : {documentInstanceId}),
        ...(documentRef === undefined ? {} : {documentRef}),
        ...(value.documentBackend === undefined ? {} : {documentBackend: value.documentBackend}),
        ...(documentIdentity === undefined ? {} : {documentIdentity}),
        ...(commandTarget === undefined ? {} : {commandTarget}),
    };
}

function decodeAssistantCommonStatusFields(value: Record<string, unknown>) {
    const models = decodeArray(value.models, decodeAssistantModelOption);
    const availableEfforts = decodeStringArray(value.availableEfforts);
    const availableSpeedModes = Array.isArray(value.availableSpeedModes)
        && value.availableSpeedModes.every(mode => isOneOf(AGENT_ASSISTANT_SPEED_MODES, mode))
        ? [...value.availableSpeedModes]
        : null;
    const account = value.account === null ? null : decodeAssistantAccount(value.account);
    const errorEnvelope = value.errorEnvelope === undefined
        ? undefined
        : decodeAssistantErrorEnvelope(value.errorEnvelope);
    return {
        models,
        availableEfforts,
        availableSpeedModes,
        account,
        errorEnvelope,
    };
}

function decodeAssistantProviderStatus(value: unknown): IAgentAssistantProviderStatus | null {
    if (!isRecord(value)) {
        return null;
    }
    const {
        models,
        availableEfforts,
        availableSpeedModes,
        account,
        errorEnvelope,
    } = decodeAssistantCommonStatusFields(value);
    if (
        !isOneOf(ASSISTANT_PROVIDER_IDS, value.id)
        || typeof value.label !== 'string'
        || !isOneOf(AGENT_ASSISTANT_INSTALL_STATES, value.installState)
        || !isOneOf(AGENT_ASSISTANT_AUTH_STATES, value.authState)
        || !isOneOf(AGENT_ASSISTANT_RUNTIME_STATES, value.runtimeState)
        || models === null
        || typeof value.defaultModel !== 'string'
        || typeof value.activeModel !== 'string'
        || !isOneOf(AGENT_ASSISTANT_MODEL_SWITCH_MODES, value.modelSwitchMode)
        || availableEfforts === null
        || typeof value.defaultEffort !== 'string'
        || typeof value.activeEffort !== 'string'
        || availableSpeedModes === null
        || !isOneOf(AGENT_ASSISTANT_SPEED_MODES, value.defaultSpeedMode)
        || !isOneOf(AGENT_ASSISTANT_SPEED_MODES, value.activeSpeedMode)
        || (value.path !== null && typeof value.path !== 'string')
        || (value.version !== null && typeof value.version !== 'string')
        || (value.minimumVersion !== null && typeof value.minimumVersion !== 'string')
        || typeof value.versionSupported !== 'boolean'
        || typeof value.installUrl !== 'string'
        || account === null && value.account !== null
        || (value.error !== undefined && typeof value.error !== 'string')
        || errorEnvelope === null
    ) {
        return null;
    }
    return {
        id: value.id,
        label: value.label,
        installState: value.installState,
        authState: value.authState,
        runtimeState: value.runtimeState,
        models,
        defaultModel: value.defaultModel,
        activeModel: value.activeModel,
        modelSwitchMode: value.modelSwitchMode,
        availableEfforts,
        defaultEffort: value.defaultEffort,
        activeEffort: value.activeEffort,
        availableSpeedModes,
        defaultSpeedMode: value.defaultSpeedMode,
        activeSpeedMode: value.activeSpeedMode,
        path: value.path,
        version: value.version,
        minimumVersion: value.minimumVersion,
        versionSupported: value.versionSupported,
        installUrl: value.installUrl,
        account,
        ...(value.error === undefined ? {} : {error: value.error}),
        ...(errorEnvelope === undefined ? {} : {errorEnvelope}),
    };
}

function decodeAgentAssistantStatus(value: unknown): IAgentAssistantStatus | null {
    if (!isRecord(value)) {
        return null;
    }
    const providers = decodeArray(value.providers, decodeAssistantProviderStatus);
    const {
        models,
        availableEfforts,
        availableSpeedModes,
        account,
        errorEnvelope,
    } = decodeAssistantCommonStatusFields(value);
    const mcp = decodeAssistantMcpStatus(value.mcp);
    const turn = decodeAssistantTurnState(value.turn);
    const lastCheckedAt = parseIsoTimestamp(value.lastCheckedAt);
    if (
        typeof value.supported !== 'boolean'
        || typeof value.platform !== 'string'
        || !isOneOf(ASSISTANT_PROVIDER_IDS, value.provider)
        || typeof value.providerLabel !== 'string'
        || providers === null
        || typeof value.model !== 'string'
        || typeof value.modelLabel !== 'string'
        || models === null
        || !isOneOf(AGENT_ASSISTANT_MODEL_SWITCH_MODES, value.modelSwitchMode)
        || typeof value.effort !== 'string'
        || availableEfforts === null
        || !isOneOf(AGENT_ASSISTANT_SPEED_MODES, value.speedMode)
        || availableSpeedModes === null
        || !isOneOf(AGENT_ASSISTANT_INSTALL_STATES, value.installState)
        || typeof value.codexInstalled !== 'boolean'
        || (value.codexPath !== null && typeof value.codexPath !== 'string')
        || (value.codexVersion !== null && typeof value.codexVersion !== 'string')
        || typeof value.minimumCodexVersion !== 'string'
        || typeof value.codexVersionSupported !== 'boolean'
        || typeof value.installUrl !== 'string'
        || typeof value.installScriptUrl !== 'string'
        || typeof value.managedInstallDir !== 'string'
        || !isOneOf(AGENT_ASSISTANT_AUTH_STATES, value.authState)
        || account === null && value.account !== null
        || !isOneOf(AGENT_ASSISTANT_RUNTIME_STATES, value.runtimeState)
        || mcp === null
        || turn === null
        || lastCheckedAt === null
        || (value.error !== undefined && typeof value.error !== 'string')
        || errorEnvelope === null
    ) {
        return null;
    }
    return {
        supported: value.supported,
        platform: value.platform,
        provider: value.provider,
        providerLabel: value.providerLabel,
        providers,
        model: value.model,
        modelLabel: value.modelLabel,
        models,
        modelSwitchMode: value.modelSwitchMode,
        effort: value.effort,
        availableEfforts,
        speedMode: value.speedMode,
        availableSpeedModes,
        installState: value.installState,
        codexInstalled: value.codexInstalled,
        codexPath: value.codexPath,
        codexVersion: value.codexVersion,
        minimumCodexVersion: value.minimumCodexVersion,
        codexVersionSupported: value.codexVersionSupported,
        installUrl: value.installUrl,
        installScriptUrl: value.installScriptUrl,
        managedInstallDir: value.managedInstallDir,
        authState: value.authState,
        account,
        runtimeState: value.runtimeState,
        mcp,
        turn,
        lastCheckedAt,
        ...(value.error === undefined ? {} : {error: value.error}),
        ...(errorEnvelope === undefined ? {} : {errorEnvelope}),
    };
}

function decodeAgentAssistantState(value: unknown): IAgentAssistantState | null {
    if (!isRecord(value)) {
        return null;
    }
    const scope = value.scope === null ? null : decodeAgentAssistantChatScope(value.scope);
    const status = decodeAgentAssistantStatus(value.status);
    const messages = decodeArray(value.messages, decodeAssistantMessage);
    if (scope === null && value.scope !== null || status === null || messages === null) {
        return null;
    }
    return {
        scope,
        status,
        messages,
    };
}

function decodeAssistantOperationResult(
    value: unknown,
): Pick<IAgentAssistantInstallResult, 'ok' | 'state' | 'error' | 'errorEnvelope'> | null {
    if (!isRecord(value) || typeof value.ok !== 'boolean') {
        return null;
    }
    const state = decodeAgentAssistantState(value.state);
    const errorEnvelope = value.errorEnvelope === undefined
        ? undefined
        : decodeAssistantErrorEnvelope(value.errorEnvelope);
    if (
        state === null
        || (value.error !== undefined && typeof value.error !== 'string')
        || errorEnvelope === null
    ) {
        return null;
    }
    return {
        ok: value.ok,
        state,
        ...(value.error === undefined ? {} : {error: value.error}),
        ...(errorEnvelope === undefined ? {} : {errorEnvelope}),
    };
}

function decodeAgentAssistantInstallResult(value: unknown): IAgentAssistantInstallResult | null {
    return decodeAssistantOperationResult(value);
}

function decodeAgentAssistantSendMessageResult(value: unknown): IAgentAssistantSendMessageResult | null {
    return decodeAssistantOperationResult(value);
}

function decodeAgentAssistantLoginResult(value: unknown): IAgentAssistantLoginResult | null {
    const result = decodeAssistantOperationResult(value);
    if (
        result === null
        || !isRecord(value)
        || (value.loginId !== undefined && typeof value.loginId !== 'string')
        || (value.authUrl !== undefined && typeof value.authUrl !== 'string')
        || (value.verificationUrl !== undefined && typeof value.verificationUrl !== 'string')
        || (value.userCode !== undefined && typeof value.userCode !== 'string')
    ) {
        return null;
    }
    return {
        ...result,
        ...(value.loginId === undefined ? {} : {loginId: value.loginId}),
        ...(value.authUrl === undefined ? {} : {authUrl: value.authUrl}),
        ...(value.verificationUrl === undefined ? {} : {verificationUrl: value.verificationUrl}),
        ...(value.userCode === undefined ? {} : {userCode: value.userCode}),
    };
}

function decodeAgentWorkspaceSnapshotRequest(value: unknown): IAgentWorkspaceSnapshotRequest | null {
    if (!isRecord(value)) {
        return null;
    }

    const requestId = parseRequestId(value.requestId);
    const windowId = normalizeOptionalWindowId(value.windowId);
    const lastSeenRevision = normalizeOptionalRevision(value.lastSeenRevision);
    const scope = decodeCommandExecutionScope(value.scope);
    if (requestId === null || windowId === null || lastSeenRevision === null || scope === null) {
        return null;
    }

    return {
        requestId,
        ...(windowId === undefined ? {} : {windowId}),
        ...(lastSeenRevision === undefined ? {} : {lastSeenRevision}),
        ...(scope === undefined ? {} : {scope}),
    };
}

function decodeAgentCommandRequest(value: unknown): IAgentCommandRequest | null {
    if (!isRecord(value)) {
        return null;
    }

    const requestId = parseRequestId(value.requestId);
    const windowId = normalizeOptionalWindowId(value.windowId);
    const scope = decodeCommandExecutionScope(value.scope);
    const command = decodeAgentCommand(value.command);
    if (requestId === null || windowId === null || scope === null || command === null) {
        return null;
    }

    return {
        requestId,
        ...(windowId === undefined ? {} : {windowId}),
        ...(scope === undefined ? {} : {scope}),
        command,
    };
}

function decodeAgentCommandCancelRequest(
    value: unknown,
): IAgentCommandCancelRequest | null {
    if (!isRecord(value)) {
        return null;
    }

    const requestId = parseRequestId(value.requestId);
    const windowId = normalizeOptionalWindowId(value.windowId);
    if (requestId === null || windowId === null) {
        return null;
    }

    return {
        requestId,
        ...(windowId === undefined ? {} : {windowId}),
    };
}

type TMutableAgentAssistantEvent = {
    -readonly [TKey in keyof IAgentAssistantEvent]: IAgentAssistantEvent[TKey];
};

function decodeAgentAssistantEvent(value: unknown): IAgentAssistantEvent | null {
    if (!isRecord(value) || !isAssistantEventType(value.type)) {
        return null;
    }

    const event: TMutableAgentAssistantEvent = {type: value.type};
    if (value.state !== undefined) {
        const state = decodeAgentAssistantState(value.state);
        if (state === null) {
            return null;
        }
        event.state = state;
    }
    if (value.message !== undefined) {
        const message = decodeAssistantMessage(value.message);
        if (message === null) {
            return null;
        }
        event.message = message;
    }
    if (value.messageId !== undefined) {
        const messageId = normalizeNonEmptyString(value.messageId);
        if (messageId === null) {
            return null;
        }
        event.messageId = messageId;
    }
    if (value.delta !== undefined) {
        if (typeof value.delta !== 'string') {
            return null;
        }
        event.delta = value.delta;
    }
    if (value.reasoningDelta !== undefined) {
        if (typeof value.reasoningDelta !== 'string') {
            return null;
        }
        event.reasoningDelta = value.reasoningDelta;
    }
    if (
        isRecord(value.binding)
        && typeof value.binding.scopeFingerprint === 'string'
        && typeof value.binding.sessionKey === 'string'
        && typeof value.binding.turnGeneration === 'number'
        && Number.isInteger(value.binding.turnGeneration)
        && value.binding.turnGeneration >= 0
        && typeof value.binding.windowId === 'number'
        && Number.isInteger(value.binding.windowId)
        && value.binding.windowId >= 0
    ) {
        event.binding = {
            scopeFingerprint: value.binding.scopeFingerprint,
            sessionKey: value.binding.sessionKey,
            turnGeneration: value.binding.turnGeneration,
            windowId: value.binding.windowId,
        };
    } else if (value.binding !== undefined) {
        return null;
    }
    if (value.turnId !== undefined) {
        const turnId = normalizeNonEmptyString(value.turnId);
        if (turnId === null) {
            return null;
        }
        event.turnId = turnId;
    }
    if (value.phase !== undefined) {
        if (!isOneOf(AGENT_ASSISTANT_TURN_PHASES, value.phase)) {
            return null;
        }
        event.phase = value.phase;
    }
    if (value.toolActivity !== undefined) {
        if (!isAssistantToolActivity(value.toolActivity)) {
            return null;
        }
        event.toolActivity = value.toolActivity;
    }
    if (value.lastEventAtMs !== undefined) {
        if (typeof value.lastEventAtMs !== 'number' || !Number.isFinite(value.lastEventAtMs)) {
            return null;
        }
        event.lastEventAtMs = value.lastEventAtMs;
    }
    if (value.progress !== undefined) {
        if (typeof value.progress !== 'string') {
            return null;
        }
        event.progress = value.progress;
    }
    if (value.error !== undefined) {
        if (typeof value.error !== 'string') {
            return null;
        }
        event.error = value.error;
    }
    if (value.errorEnvelope !== undefined) {
        const errorEnvelope = decodeAssistantErrorEnvelope(value.errorEnvelope);
        if (errorEnvelope === null) {
            return null;
        }
        event.errorEnvelope = errorEnvelope;
    }

    if (event.binding === undefined && event.state === undefined) {
        return null;
    }

    return event;
}

function nullableResultSchema<TResult>(
    decode: (value: unknown) => TResult | null,
    label: string,
    example: () => TResult,
) {
    return s.declared<TResult>()(s.fromNullableDecoder(decode, label, example));
}

function decodeOptionalRequestArgs<T>(
    args: readonly unknown[],
    decode: (value: unknown) => T | undefined,
): [request?: T] {
    requireArgs(args, {
        min: 0,
        max: 1,
    });
    const request = decode(args[0]);
    return request === undefined ? [] : [request];
}

const noArgs = s.tuple([]);
const enabledArgs = argsSchema<[boolean]>(
    args => {
        requireArgs(args, 1);
        if (typeof args[0] !== 'boolean') {
            throw new Error('enabled must be a boolean');
        }
        return [args[0]];
    },
    () => [true],
);
const assistantStateArgs = argsSchema<[request?: IAgentAssistantStateRequest]>(
    args => decodeOptionalRequestArgs(args, decodeAssistantStateRequest),
    () => [],
);
const assistantLoginArgs = argsSchema<[IAgentAssistantLoginRequest]>(
    args => {
        requireArgs(args, 1);
        if (!isRecord(args[0]) || (args[0].mode !== 'chatgpt' && args[0].mode !== 'device-code')) {
            throw new Error('invalid assistant login request');
        }
        return [{mode: args[0].mode}];
    },
    () => [{mode: 'chatgpt'}],
);
const assistantMessageArgs = argsSchema<[IAgentAssistantSendMessageRequest]>(
    args => {
        requireArgs(args, 1);
        return [decodeAssistantSendMessageRequest(args[0])];
    },
    () => [{text: 'Summarize this document'}],
);
const assistantScopedArgs = argsSchema<[request?: IAgentAssistantScopedRequest]>(
    args => decodeOptionalRequestArgs(args, decodeAssistantStateRequest),
    () => [],
);
const workspaceSnapshotResponseArgs = argsSchema<[IAgentWorkspaceSnapshotResponse]>(
    args => {
        requireArgs(args, 1);
        return [decodeWorkspaceSnapshotResponse(args[0])];
    },
    () => [{
        requestId: parseRequestId('snapshot-1') ?? (() => { throw new TypeError('invalid request ID fixture'); })(),
        ok: false,
        error: 'Snapshot unavailable',
    }],
);
const commandResponseArgs = argsSchema<[IAgentCommandResponse]>(
    args => {
        requireArgs(args, 1);
        return [decodeCommandResponse(args[0])];
    },
    () => [{
        requestId: parseRequestId('command-1') ?? (() => { throw new TypeError('invalid request ID fixture'); })(),
        ok: true,
        result: {},
    }],
);

function createMcpStatusExample(): IAgentMcpIntegrationStatus {
    return {
        enabled: true,
        serverName: 'evb-viewer',
        serverUrl: 'http://127.0.0.1:3000',
        serverRunning: true,
        codexInstalled: true,
        codexPath: '/usr/local/bin/codex',
        codexConfigured: true,
        codexRegistrationState: 'configured',
        installUrl: 'https://example.test/install',
        lastCheckedAt: requireIsoTimestamp('2026-07-23T00:00:00.000Z'),
    };
}

function createAssistantStateExample(): IAgentAssistantState {
    const model = {
        id: 'gpt-5',
        label: 'GPT-5',
        reasoningEfforts: [{
            id: 'high',
            label: 'High',
            isDefault: true,
        }],
        defaultReasoningEffort: 'high',
        serviceTiers: [{
            id: 'fast',
            label: 'Fast',
        }],
        defaultServiceTier: 'fast',
    };
    const account = {
        type: 'chatgpt',
        email: 'reader@example.test',
    } as const;
    const provider: IAgentAssistantProviderStatus = {
        id: 'codex',
        label: 'Codex',
        installState: 'installed',
        authState: 'signed-in',
        runtimeState: 'ready',
        models: [model],
        defaultModel: model.id,
        activeModel: model.id,
        modelSwitchMode: 'in-session',
        availableEfforts: ['high'],
        defaultEffort: 'high',
        activeEffort: 'high',
        availableSpeedModes: [
            'fast',
            'standard',
        ],
        defaultSpeedMode: 'fast',
        activeSpeedMode: 'fast',
        path: '/usr/local/bin/codex',
        version: '1.0.0',
        minimumVersion: '0.133.0',
        versionSupported: true,
        installUrl: 'https://example.test/install',
        account,
    };
    return {
        scope: null,
        status: {
            supported: true,
            platform: 'darwin',
            provider: provider.id,
            providerLabel: provider.label,
            providers: [provider],
            model: model.id,
            modelLabel: model.label,
            models: [model],
            modelSwitchMode: 'in-session',
            effort: 'high',
            availableEfforts: ['high'],
            speedMode: 'fast',
            availableSpeedModes: [
                'fast',
                'standard',
            ],
            installState: 'installed',
            codexInstalled: true,
            codexPath: provider.path,
            codexVersion: provider.version,
            minimumCodexVersion: '0.133.0',
            codexVersionSupported: true,
            installUrl: provider.installUrl,
            installScriptUrl: 'https://example.test/install.sh',
            managedInstallDir: '/tmp/codex',
            authState: provider.authState,
            account,
            runtimeState: provider.runtimeState,
            mcp: {
                serverName: 'evb-viewer',
                serverUrl: 'http://127.0.0.1:3000',
                serverRunning: true,
                toolCount: 4,
            },
            turn: {
                id: null,
                phase: 'idle',
                reasoning: '',
                toolActivity: [],
                lastEventAtMs: null,
                usage: null,
            },
            lastCheckedAt: requireIsoTimestamp('2026-07-23T00:00:00.000Z'),
        },
        messages: [],
    };
}

const assistantErrorEnvelope = s.declared<IAgentAssistantErrorEnvelope>()(
    s.fromNullableDecoder(decodeAssistantErrorEnvelope, 'assistant error envelope', () => ({
        code: 'INTERNAL',
        message: 'Assistant unavailable',
        retryable: true,
        timestamp: requireEpochMs(0),
    })),
);
const mcpStatusResult = resultSchema<IAgentMcpIntegrationStatus>(
    decodeMcpStatus,
    createMcpStatusExample,
);
const mcpUpdateResult = resultSchema<IAgentMcpIntegrationUpdateResult>(decodeMcpUpdateResult, () => ({
    ok: true,
    status: createMcpStatusExample(),
}));
const assistantStateResult = nullableResultSchema(
    decodeAgentAssistantState,
    'assistant state',
    createAssistantStateExample,
);
const assistantInstallResult = nullableResultSchema(
    decodeAgentAssistantInstallResult,
    'assistant install',
    () => ({
        ok: false,
        state: createAssistantStateExample(),
        errorEnvelope: assistantErrorEnvelope.example(),
    }),
);
const assistantLoginResult = nullableResultSchema(
    decodeAgentAssistantLoginResult,
    'assistant login',
    () => ({
        ok: true,
        state: createAssistantStateExample(),
        loginId: 'login-1',
    }),
);
const assistantMessageResult = nullableResultSchema<IAgentAssistantSendMessageResult>(
    decodeAgentAssistantSendMessageResult,
    'assistant message',
    () => ({
        ok: true,
        state: createAssistantStateExample(),
    }),
);
const rendererAckResult = resultSchema<IAgentRendererAck>(
    decodeRendererAck,
    () => ({accepted: true}),
);
const workspaceSnapshotRequest = s.declared<IAgentWorkspaceSnapshotRequest>()(
    s.fromNullableDecoder(
        decodeAgentWorkspaceSnapshotRequest,
        'agent workspace snapshot request',
        () => ({requestId: parseRequestId('snapshot-1') ?? (() => { throw new TypeError('invalid request ID fixture'); })()}),
    ),
);
const commandRequest = s.declared<IAgentCommandRequest>()(
    s.fromNullableDecoder(
        decodeAgentCommandRequest,
        'agent command request',
        () => ({
            requestId: parseRequestId('command-1') ?? (() => { throw new TypeError('invalid request ID fixture'); })(),
            command: {
                name: 'activate_tab',
                arguments: {tabId: parseTabId('tab-1') ?? (() => { throw new TypeError('invalid tab ID fixture'); })()},
            },
        }),
    ),
);
const commandCancelRequest = s.declared<IAgentCommandCancelRequest>()(
    s.fromNullableDecoder(
        decodeAgentCommandCancelRequest,
        'agent command cancellation request',
        () => ({requestId: parseRequestId('command-1') ?? (() => { throw new TypeError('invalid request ID fixture'); })()}),
    ),
);
const assistantEvent = s.declared<IAgentAssistantEvent>()(
    s.fromNullableDecoder(
        decodeAgentAssistantEvent,
        'agent assistant event',
        () => ({
            type: 'heartbeat',
            binding: {
                scopeFingerprint: 'scope',
                sessionKey: 'codex:scope',
                turnGeneration: 1,
                windowId: 1,
            },
        }),
    ),
);

function defineAgentMethod<
    const TName extends string,
    const TChannel extends string,
    const TArgs extends IRuntimeSchema<unknown[]>,
    const TResult extends IRuntimeSchema<unknown>,
>(definition: {
    name: TName;
    channel: TChannel;
    args: TArgs;
    result: TResult;
}) {
    return {
        kind: 'async',
        channel: definition.channel,
        ipc: {
            args: definition.args,
            result: definition.result,
        },
        main: {
            method: definition.name,
            context: 'sender',
        },
        browser: {method: definition.name},
        lazy: 'forwarded',
    } as const;
}

export const AGENT_PLATFORM_FEATURE = definePlatformFeature({
    path: ['agent'],
    required: {
        browser: true,
        electron: true,
    },
    manifestPath: ['agent'],
    methods: {
        getMcpIntegrationStatus: defineAgentMethod({
            name: 'getMcpIntegrationStatus',
            channel: 'agent:getMcpIntegrationStatus',
            args: noArgs,
            result: mcpStatusResult,
        }),
        setMcpIntegrationEnabled: defineAgentMethod({
            name: 'setMcpIntegrationEnabled',
            channel: 'agent:setMcpIntegrationEnabled',
            args: enabledArgs,
            result: mcpUpdateResult,
        }),
        getAssistantState: defineAgentMethod({
            name: 'getAssistantState',
            channel: 'agent:getAssistantState',
            args: assistantStateArgs,
            result: assistantStateResult,
        }),
        installAssistantCodex: defineAgentMethod({
            name: 'installAssistantCodex',
            channel: 'agent:installAssistantCodex',
            args: noArgs,
            result: assistantInstallResult,
        }),
        startAssistantLogin: defineAgentMethod({
            name: 'startAssistantLogin',
            channel: 'agent:startAssistantLogin',
            args: assistantLoginArgs,
            result: assistantLoginResult,
        }),
        cancelAssistantLogin: defineAgentMethod({
            name: 'cancelAssistantLogin',
            channel: 'agent:cancelAssistantLogin',
            args: noArgs,
            result: assistantStateResult,
        }),
        sendAssistantMessage: defineAgentMethod({
            name: 'sendAssistantMessage',
            channel: 'agent:sendAssistantMessage',
            args: assistantMessageArgs,
            result: assistantMessageResult,
        }),
        interruptAssistant: defineAgentMethod({
            name: 'interruptAssistant',
            channel: 'agent:interruptAssistant',
            args: assistantScopedArgs,
            result: assistantStateResult,
        }),
        resetAssistantChat: defineAgentMethod({
            name: 'resetAssistantChat',
            channel: 'agent:resetAssistantChat',
            args: assistantScopedArgs,
            result: assistantStateResult,
        }),
        submitWorkspaceSnapshot: defineAgentMethod({
            name: 'submitWorkspaceSnapshot',
            channel: 'agent:submitWorkspaceSnapshot',
            args: workspaceSnapshotResponseArgs,
            result: rendererAckResult,
        }),
        submitCommandResponse: defineAgentMethod({
            name: 'submitCommandResponse',
            channel: 'agent:submitCommandResponse',
            args: commandResponseArgs,
            result: rendererAckResult,
        }),
    },
    events: {
        onAssistantEvent: {
            kind: 'event',
            channel: 'agent:assistantEvent',
            payload: assistantEvent,
            browser: {method: 'onAssistantEvent'},
            lazy: 'forwarded',
        },
        onWorkspaceSnapshotRequest: {
            kind: 'event',
            channel: 'agent:workspaceSnapshotRequest',
            payload: workspaceSnapshotRequest,
            browser: {method: 'onWorkspaceSnapshotRequest'},
            lazy: 'forwarded',
        },
        onCommandCancelRequest: {
            kind: 'event',
            channel: 'agent:commandCancelRequest',
            payload: commandCancelRequest,
            browser: {method: 'onCommandCancelRequest'},
            lazy: 'forwarded',
        },
        onCommandRequest: {
            kind: 'event',
            channel: 'agent:commandRequest',
            payload: commandRequest,
            browser: {method: 'onCommandRequest'},
            lazy: 'forwarded',
        },
    },
});

export type IAgentCapability = TFeatureCapability<typeof AGENT_PLATFORM_FEATURE>;
export type IAgentInvokeMap = TFeatureInvokeMap<typeof AGENT_PLATFORM_FEATURE>;
export type IAgentEventMap = TFeatureEventMap<typeof AGENT_PLATFORM_FEATURE>;
