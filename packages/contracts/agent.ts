import type {
    TEditorLayoutNode,
    TPaneId,
} from '@contracts/editorPanes';
import type {
    TDocumentBackend,
    TDocumentRef,
} from '@contracts/documentRef';
import {parseDocumentRef} from '@contracts/documentRef';
import type {
    IDocumentRevisionInfo,
    TDocumentRevisionToken,
} from '@contracts/documentRevision';
import {
    isDocumentRevisionInfo,
    parseDocumentRevisionToken,
} from '@contracts/documentRevision';
import type { TDocumentInstanceId } from '@contracts/documentInstanceId';
import {parseDocumentInstanceId} from '@contracts/documentInstanceId';
import type {
    TRequestId,
    TSessionId,
} from '@contracts/shared';
import {
    parseRequestId,
    parseSessionId,
} from '@contracts/shared';
import type {
    TEpochMs,
    TIsoTimestamp,
} from '@contracts/timestamps';
import {
    parseEpochMs,
    parseIsoTimestamp,
} from '@contracts/timestamps';
import type {TTabId} from '@contracts/windowTabs';
import {parseTabId} from '@contracts/windowTabs';
import * as v from 'valibot';
import {isAgentWorkspaceSnapshot} from '@contracts/isAgentWorkspaceSnapshot';

export type TAgentDocumentKind = 'empty' | 'pdf' | 'djvu' | 'image' | 'unknown';
export type TAgentDocumentReadinessStatus = 'ready' | 'needs-preparation' | 'unknown' | 'empty';
export type TAgentOcrCoverageStatus = 'complete' | 'partial' | 'none' | 'unknown';
export type TAgentRecommendationId = 'convert_to_pdf' | 'ocr_all_pages';
export const AGENT_CAPABILITY_DOMAINS = [
    'workspace',
    'document',
    'annotation',
    'toc',
    'page_labels',
    'bookmarks',
    'ocr',
    'ui',
    'view',
    'file',
    'export',
    'page_ops',
    'history',
] as const;
export const AGENT_CAPABILITY_RISKS = [
    'read',
    'navigate',
    'write',
    'destructive',
    'longRunning',
] as const;
export type TAgentCapabilityDomain = typeof AGENT_CAPABILITY_DOMAINS[number];
export type TAgentCapabilityRisk = typeof AGENT_CAPABILITY_RISKS[number];
export const AGENT_ASSISTANT_TURN_PHASES = [
    'idle',
    'queued',
    'thinking',
    'streaming',
    'tool-running',
    'finalizing',
    'done',
    'failed',
    'cancelled',
    'stalled',
    'interrupting',
] as const;
export const AGENT_ASSISTANT_MESSAGE_ROLES = [
    'user',
    'assistant',
    'system',
] as const;
export const AGENT_ASSISTANT_EVENT_TYPES = [
    'state',
    'message',
    'message-delta',
    'reasoning-delta',
    'heartbeat',
    'turn-started',
    'turn-progress',
    'turn-completed',
    'install-progress',
    'error',
] as const;
export const ASSISTANT_PROVIDER_IDS = [
    'codex',
    'claude',
] as const;
export const ASSISTANT_KNOWN_EFFORTS = [
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
] as const;
export type TAgentWorkspaceMode = 'empty-workspace' | 'open-document' | 'documents-open-no-active-document';

export interface IAgentDocumentOcrState {
    readonly status: TAgentOcrCoverageStatus;
    readonly pageCount: number;
    readonly textPageCount?: number;
    readonly missingTextPages?: readonly number[];
    readonly coverage?: number;
}

export interface IAgentDocumentRecommendation {
    readonly id: TAgentRecommendationId;
    readonly title: string;
    readonly reason: string;
    readonly toolName?: string;
}

export interface IAgentCapabilityAvailability {
    readonly available: boolean;
    readonly reason?: string;
}

export interface IAgentCapabilityPolicy {
    readonly internal: 'allow' | 'confirm' | 'deny';
    readonly external: 'allow' | 'confirm' | 'deny';
}

export interface IAgentCapabilityDescriptor {
    readonly id: string;
    readonly domain: TAgentCapabilityDomain;
    readonly title: string;
    readonly summary: string;
    readonly risk: TAgentCapabilityRisk;
    readonly inputSchema: Readonly<Record<string, unknown>>;
    readonly outputSchema?: Readonly<Record<string, unknown>>;
    readonly availability: IAgentCapabilityAvailability;
    readonly policy: IAgentCapabilityPolicy;
    readonly resourceTemplates?: readonly string[];
}

export interface IAgentCompactCapabilityDescriptor extends Omit<IAgentCapabilityDescriptor, 'inputSchema' | 'outputSchema' | 'resourceTemplates'> {
    readonly hasInputSchema: boolean;
    readonly hasOutputSchema: boolean;
    readonly hasResourceTemplates: boolean;
}

export interface IAgentDocumentReadiness {
    readonly status: TAgentDocumentReadinessStatus;
    readonly reasons: readonly string[];
    readonly ocr?: IAgentDocumentOcrState;
    readonly recommendations: readonly IAgentDocumentRecommendation[];
}

export interface IAgentPaneSnapshot {
    readonly paneId: TPaneId;
    readonly tabIds: readonly TTabId[];
    readonly activeTabId: TTabId | null;
}

export interface IAgentTabSnapshot {
    readonly tabId: TTabId;
    readonly paneId: TPaneId | null;
    readonly fileName: string | null;
    readonly originalPath: TDocumentRef | null;
    readonly originalBackend?: TDocumentBackend;
    readonly documentSessionKey?: string | null;
    readonly documentInstanceId?: TDocumentInstanceId | null;
    readonly documentIdentity?: IDocumentRevisionInfo | null;
    readonly commandTarget?: TAgentWorkspaceCommandTarget;
    readonly isDirty: boolean;
    readonly kind: TAgentDocumentKind;
    readonly workspaceAttached: boolean;
    readonly hasPdf: boolean;
    readonly isDjvu: boolean;
    readonly isOpeningDocument: boolean;
    readonly hasOpenError: boolean;
    readonly currentPage: number | null;
    readonly totalPages: number | null;
    readonly readiness: IAgentDocumentReadiness;
}

export interface IAgentDocumentReference {
    readonly tabId: TTabId;
    readonly paneId: TPaneId | null;
    readonly fileName: string | null;
    readonly originalPath: TDocumentRef | null;
    readonly originalBackend?: TDocumentBackend;
    readonly documentSessionKey?: string | null;
    readonly documentInstanceId?: TDocumentInstanceId | null;
    readonly documentIdentity?: IDocumentRevisionInfo | null;
    readonly commandTarget?: TAgentWorkspaceCommandTarget;
    readonly kind: TAgentDocumentKind;
}

const agentTabIdSchema = v.custom<TTabId>(value => parseTabId(value) !== null, 'invalid agent tab id');
const agentSessionIdSchema = v.custom<TSessionId>(value => parseSessionId(value) !== null, 'invalid agent session id');
const agentDocumentRefSchema = v.custom<TDocumentRef>(value => parseDocumentRef(value) !== null, 'invalid agent document reference');
const agentDocumentInstanceIdSchema = v.custom<TDocumentInstanceId>(value => parseDocumentInstanceId(value) !== null, 'invalid agent document instance id');
const agentDocumentRevisionTokenSchema = v.custom<TDocumentRevisionToken>(value => parseDocumentRevisionToken(value) !== null, 'invalid agent document revision token');
const agentWorkspaceCommandTargetBase = {
    tabId: agentTabIdSchema,
    sessionId: agentSessionIdSchema,
    documentRef: v.nullable(agentDocumentRefSchema),
    documentBackend: v.optional(v.picklist([
        'browser',
        'electron',
    ])),
    documentInstanceId: v.optional(v.nullable(agentDocumentInstanceIdSchema), null),
    documentRevisionToken: v.optional(agentDocumentRevisionTokenSchema),
};
const agentWorkspaceCommandTargetSchema = v.pipe(
    v.variant('kind', [
        v.object({
            ...agentWorkspaceCommandTargetBase,
            kind: v.literal('transaction'),
            transactionId: v.pipe(v.string(), v.trim(), v.nonEmpty('transaction id must not be empty')),
        }),
        v.object({
            ...agentWorkspaceCommandTargetBase,
            kind: v.literal('revision'),
            sessionRevision: v.pipe(v.number(), v.integer(), v.minValue(0)),
        }),
    ]),
    v.readonly(),
);

export type TAgentWorkspaceCommandTarget = v.InferOutput<typeof agentWorkspaceCommandTargetSchema>;

export interface IAgentRecentFileSnapshot {
    readonly fileName: string;
    readonly originalPath: TDocumentRef;
    readonly backend?: TDocumentBackend;
    readonly kind: TAgentDocumentKind;
    // Agent API keeps ISO text for its renderer and server wire format.
    readonly openedAt: TIsoTimestamp;
    readonly fileSize?: number;
}

export interface IAgentWorkspaceSummary {
    readonly mode: TAgentWorkspaceMode;
    readonly activeDocument: IAgentDocumentReference | null;
    readonly documentCount: number;
    readonly recentFileCount: number;
    readonly recentFilesResolved: boolean;
}

export interface IAgentWorkspaceSnapshot {
    // Agent API keeps ISO text for its renderer and server wire format.
    readonly capturedAt: TIsoTimestamp;
    readonly activePaneId: TPaneId | null;
    readonly activeTabId: TTabId | null;
    readonly summary: IAgentWorkspaceSummary;
    readonly panes: readonly IAgentPaneSnapshot[];
    readonly tabs: readonly IAgentTabSnapshot[];
    readonly recentFiles: readonly IAgentRecentFileSnapshot[];
    readonly layout: TEditorLayoutNode | null;
}

const agentRequestIdSchema = v.custom<TRequestId>(value => parseRequestId(value) !== null, 'invalid agent request id');
const agentIsoTimestampSchema = v.custom<TIsoTimestamp>(value => parseIsoTimestamp(value) !== null, 'invalid agent timestamp');
const agentEpochTimestampSchema = v.custom<TEpochMs>(value => parseEpochMs(value) !== null, 'invalid agent timestamp');
const agentPositiveEpochTimestampSchema = v.custom<TEpochMs>(value =>
    typeof value === 'number' && value > 0 && parseEpochMs(value) !== null,
'invalid agent timestamp',
);
const agentSafeIntegerSchema = v.pipe(v.number(), v.safeInteger());
const agentWindowIdSchema = v.pipe(v.number(), v.integer(), v.minValue(0));
const agentRevisionSchema = v.pipe(v.number(), v.integer(), v.minValue(0));
const agentCommandExecutionScopeBase = {
    windowId: agentWindowIdSchema,
    tabId: agentTabIdSchema,
    documentRef: v.optional(v.nullable(agentDocumentRefSchema), null),
    documentBackend: v.optional(v.picklist([
        'browser',
        'electron',
    ])),
    documentInstanceId: v.optional(v.nullable(agentDocumentInstanceIdSchema), null),
    documentIdentity: v.optional(v.nullable(v.custom<IDocumentRevisionInfo>(isDocumentRevisionInfo)), null),
};
const agentScopeCommandTargetSchema = v.optional(agentWorkspaceCommandTargetSchema);

export const AGENT_ASSISTANT_ERROR_CODES = [
    'AUTH_REQUIRED',
    'INSTALL_MISSING',
    'LOGIN_CANCELLED',
    'USER_INTERRUPTED',
    'MODEL_UNAVAILABLE',
    'RUNTIME_UNAVAILABLE',
    'PROVIDER_RATE_LIMITED',
    'INTERNAL',
] as const;
export const AGENT_ASSISTANT_PRESET_IDS = [
    'add-bookmarks',
    'number-pages',
    'check-ocr-readiness',
] as const;
export const ASSISTANT_MAX_IMAGE_ATTACHMENTS = 8;
export const ASSISTANT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const ASSISTANT_MAX_IMAGE_DATA_URL_LENGTH = Math.ceil(ASSISTANT_MAX_IMAGE_BYTES / 3) * 4 + 128;
const ASSISTANT_IMAGE_DATA_URL_PREFIX_RE = /^data:image\/[a-z0-9.+-]+(?:;[a-z0-9.+-]+=[a-z0-9.+/-]+)*;base64,/iu;
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

const agentMcpCodexRegistrationStateSchema = v.picklist([
    'configured',
    'missing',
    'mismatched',
    'unknown',
]);
const agentAssistantProviderIdSchema = v.picklist(ASSISTANT_PROVIDER_IDS);
const agentAssistantInstallStateSchema = v.picklist(AGENT_ASSISTANT_INSTALL_STATES);
const agentAssistantAuthStateSchema = v.picklist(AGENT_ASSISTANT_AUTH_STATES);
const agentAssistantRuntimeStateSchema = v.picklist(AGENT_ASSISTANT_RUNTIME_STATES);
const agentAssistantModelSwitchModeSchema = v.picklist(AGENT_ASSISTANT_MODEL_SWITCH_MODES);
const agentAssistantSpeedModeSchema = v.picklist(AGENT_ASSISTANT_SPEED_MODES);
const agentAssistantTurnPhaseSchema = v.picklist(AGENT_ASSISTANT_TURN_PHASES);
const agentAssistantMessageRoleSchema = v.picklist(AGENT_ASSISTANT_MESSAGE_ROLES);
const agentAssistantEventTypeSchema = v.picklist(AGENT_ASSISTANT_EVENT_TYPES);
const agentAssistantErrorCodeSchema = v.picklist(AGENT_ASSISTANT_ERROR_CODES);
const agentAssistantPresetSchema = v.picklist(AGENT_ASSISTANT_PRESET_IDS);
const agentAssistantErrorEnvelopeSchema = v.pipe(
    v.object({
        code: agentAssistantErrorCodeSchema,
        message: v.string(),
        retryable: v.boolean(),
        timestamp: agentEpochTimestampSchema,
    }),
    v.readonly(),
);
const agentMcpSetupSnippetsSchema = v.pipe(
    v.object({
        codex: v.string(),
        claude: v.string(),
        cursor: v.string(),
    }),
    v.readonly(),
);
const agentMcpIntegrationStatusSchema = v.pipe(
    v.object({
        enabled: v.boolean(),
        serverName: v.string(),
        serverUrl: v.string(),
        serverRunning: v.boolean(),
        codexInstalled: v.boolean(),
        codexPath: v.nullable(v.string()),
        codexConfigured: v.boolean(),
        codexRegistrationState: agentMcpCodexRegistrationStateSchema,
        installUrl: v.string(),
        lastCheckedAt: agentIsoTimestampSchema,
        setupSnippets: v.optional(agentMcpSetupSnippetsSchema),
        error: v.optional(v.string()),
    }),
    v.readonly(),
);
const agentMcpIntegrationUpdateResultSchema = v.pipe(
    v.object({
        ok: v.boolean(),
        cancelled: v.optional(v.boolean()),
        status: agentMcpIntegrationStatusSchema,
        error: v.optional(v.string()),
    }),
    v.readonly(),
);
const agentAssistantAccountSchema = v.object({
    type: v.picklist([
        'chatgpt',
        'apiKey',
        'other',
    ]),
    email: v.optional(v.string()),
    planType: v.optional(v.string()),
});
const agentAssistantMcpStatusSchema = v.object({
    serverName: v.string(),
    serverUrl: v.string(),
    serverRunning: v.boolean(),
    toolCount: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
});
const agentAssistantEffortOptionSchema = v.object({
    id: v.string(),
    label: v.string(),
    description: v.optional(v.string()),
    isDefault: v.optional(v.boolean()),
});
const agentAssistantServiceTierOptionSchema = v.object({
    id: v.string(),
    label: v.string(),
    description: v.optional(v.string()),
    isDefault: v.optional(v.boolean()),
});
const agentAssistantModelOptionSchema = v.object({
    id: v.string(),
    label: v.string(),
    reasoningEfforts: v.optional(v.pipe(v.array(agentAssistantEffortOptionSchema), v.readonly())),
    defaultReasoningEffort: v.optional(v.nullable(v.string())),
    serviceTiers: v.optional(v.pipe(v.array(agentAssistantServiceTierOptionSchema), v.readonly())),
    defaultServiceTier: v.optional(v.nullable(v.string())),
});
const agentAssistantProviderStatusSchema = v.object({
    id: agentAssistantProviderIdSchema,
    label: v.string(),
    installState: agentAssistantInstallStateSchema,
    authState: agentAssistantAuthStateSchema,
    runtimeState: agentAssistantRuntimeStateSchema,
    models: v.pipe(v.array(agentAssistantModelOptionSchema), v.readonly()),
    defaultModel: v.string(),
    activeModel: v.string(),
    modelSwitchMode: agentAssistantModelSwitchModeSchema,
    availableEfforts: v.pipe(v.array(v.string()), v.readonly()),
    defaultEffort: v.string(),
    activeEffort: v.string(),
    availableSpeedModes: v.pipe(v.array(agentAssistantSpeedModeSchema), v.readonly()),
    defaultSpeedMode: agentAssistantSpeedModeSchema,
    activeSpeedMode: agentAssistantSpeedModeSchema,
    path: v.nullable(v.string()),
    version: v.nullable(v.string()),
    minimumVersion: v.nullable(v.string()),
    versionSupported: v.boolean(),
    installUrl: v.string(),
    account: v.nullable(agentAssistantAccountSchema),
    error: v.optional(v.string()),
    errorEnvelope: v.optional(agentAssistantErrorEnvelopeSchema),
});
const agentDocumentRevisionInfoSchema = v.pipe(
    v.object({
        version: v.literal(1),
        token: agentDocumentRevisionTokenSchema,
        documentRef: agentDocumentRefSchema,
        authority: v.picklist([
            'electron-working-copy',
            'browser-document-store',
        ]),
        contentRevision: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
        mintedAt: agentPositiveEpochTimestampSchema,
    }),
    v.guard(isDocumentRevisionInfo),
    v.readonly(),
);
const agentAssistantChatScopeSchema = v.object({
    kind: v.literal('document'),
    key: v.pipe(v.string(), v.check(value => value.trim().length > 0, 'assistant scope key must not be empty')),
    title: v.nullable(v.string()),
    tabId: v.optional(v.nullable(agentTabIdSchema)),
    documentSessionKey: v.optional(v.nullable(v.string())),
    documentInstanceId: v.optional(v.nullable(agentDocumentInstanceIdSchema)),
    documentRef: v.optional(v.nullable(agentDocumentRefSchema)),
    documentBackend: v.optional(v.picklist([
        'browser',
        'electron',
    ])),
    documentIdentity: v.optional(v.nullable(agentDocumentRevisionInfoSchema)),
    commandTarget: v.optional(agentWorkspaceCommandTargetSchema),
});
const agentAssistantTurnToolActivitySchema = v.object({
    toolId: v.string(),
    name: v.string(),
    phase: v.picklist([
        'running',
        'completed',
        'failed',
    ]),
    startedAtMs: v.pipe(v.number(), v.finite()),
    completedAtMs: v.optional(v.pipe(v.number(), v.finite())),
});
const agentAssistantTokenUsageSchema = v.object({
    inputTokens: v.number(),
    outputTokens: v.number(),
    cachedInputTokens: v.optional(v.number()),
});
const agentAssistantTurnStateSchema = v.object({
    id: v.nullable(v.string()),
    phase: agentAssistantTurnPhaseSchema,
    reasoning: v.string(),
    toolActivity: v.array(agentAssistantTurnToolActivitySchema),
    lastEventAtMs: v.nullable(v.pipe(v.number(), v.finite())),
    usage: v.nullable(agentAssistantTokenUsageSchema),
});
const agentAssistantImageAttachmentSchema = v.object({
    type: v.literal('image'),
    id: v.string(),
    name: v.string(),
    mimeType: v.string(),
    sizeBytes: v.pipe(v.number(), v.finite(), v.gtValue(0)),
    dataUrl: v.string(),
});
const agentAssistantRequestImageAttachmentSchema = v.pipe(
    agentAssistantImageAttachmentSchema,
    v.check(attachment => attachment.mimeType.toLowerCase().startsWith('image/')
        && attachment.sizeBytes <= ASSISTANT_MAX_IMAGE_BYTES
        && attachment.dataUrl.length <= ASSISTANT_MAX_IMAGE_DATA_URL_LENGTH
        && ASSISTANT_IMAGE_DATA_URL_PREFIX_RE.test(attachment.dataUrl), 'invalid assistant image attachment'),
);
const agentAssistantChatMessageSchema = v.object({
    id: v.string(),
    role: agentAssistantMessageRoleSchema,
    text: v.string(),
    createdAt: agentIsoTimestampSchema,
    attachments: v.optional(v.array(agentAssistantImageAttachmentSchema)),
    pending: v.optional(v.boolean()),
    error: v.optional(v.string()),
    errorEnvelope: v.optional(agentAssistantErrorEnvelopeSchema),
});
const agentAssistantStatusSchema = v.object({
    supported: v.boolean(),
    platform: v.string(),
    provider: agentAssistantProviderIdSchema,
    providerLabel: v.string(),
    providers: v.pipe(v.array(agentAssistantProviderStatusSchema), v.readonly()),
    model: v.string(),
    modelLabel: v.string(),
    models: v.pipe(v.array(agentAssistantModelOptionSchema), v.readonly()),
    modelSwitchMode: agentAssistantModelSwitchModeSchema,
    effort: v.string(),
    availableEfforts: v.pipe(v.array(v.string()), v.readonly()),
    speedMode: agentAssistantSpeedModeSchema,
    availableSpeedModes: v.pipe(v.array(agentAssistantSpeedModeSchema), v.readonly()),
    installState: agentAssistantInstallStateSchema,
    codexInstalled: v.boolean(),
    codexPath: v.nullable(v.string()),
    codexVersion: v.nullable(v.string()),
    minimumCodexVersion: v.string(),
    codexVersionSupported: v.boolean(),
    installUrl: v.string(),
    installScriptUrl: v.string(),
    managedInstallDir: v.string(),
    authState: agentAssistantAuthStateSchema,
    account: v.nullable(agentAssistantAccountSchema),
    runtimeState: agentAssistantRuntimeStateSchema,
    mcp: agentAssistantMcpStatusSchema,
    turn: agentAssistantTurnStateSchema,
    lastCheckedAt: agentIsoTimestampSchema,
    error: v.optional(v.string()),
    errorEnvelope: v.optional(agentAssistantErrorEnvelopeSchema),
});
const agentAssistantStateSchema = v.object({
    scope: v.nullable(agentAssistantChatScopeSchema),
    status: agentAssistantStatusSchema,
    messages: v.array(agentAssistantChatMessageSchema),
});
const agentAssistantStateRequestSchema = v.object({
    scope: v.optional(v.nullable(agentAssistantChatScopeSchema)),
    provider: v.optional(agentAssistantProviderIdSchema),
    model: v.optional(v.string()),
    effort: v.optional(v.string()),
    speedMode: v.optional(agentAssistantSpeedModeSchema),
});
const agentAssistantSendMessageRequestSchema = v.object({
    text: v.string(),
    scope: v.optional(v.nullable(agentAssistantChatScopeSchema)),
    provider: v.optional(agentAssistantProviderIdSchema),
    model: v.optional(v.string()),
    effort: v.optional(v.string()),
    speedMode: v.optional(agentAssistantSpeedModeSchema),
    attachments: v.optional(v.pipe(
        v.array(v.unknown()),
        v.maxLength(ASSISTANT_MAX_IMAGE_ATTACHMENTS, `assistant attachments exceeds maximum item count (${ASSISTANT_MAX_IMAGE_ATTACHMENTS})`),
        v.transform(attachments => attachments.map(attachment => v.parse(
            agentAssistantRequestImageAttachmentSchema,
            attachment,
            {abortEarly: true},
        ))),
    )),
    presetId: v.optional(agentAssistantPresetSchema),
});
const agentAssistantOperationResultSchema = v.object({
    ok: v.boolean(),
    state: agentAssistantStateSchema,
    error: v.optional(v.string()),
    errorEnvelope: v.optional(agentAssistantErrorEnvelopeSchema),
});
const agentAssistantInstallResultSchema = v.pipe(agentAssistantOperationResultSchema, v.readonly());
const agentAssistantLoginResultSchema = v.pipe(
    v.object({
        ok: v.boolean(),
        state: agentAssistantStateSchema,
        loginId: v.optional(v.string()),
        authUrl: v.optional(v.string()),
        verificationUrl: v.optional(v.string()),
        userCode: v.optional(v.string()),
        error: v.optional(v.string()),
        errorEnvelope: v.optional(agentAssistantErrorEnvelopeSchema),
    }),
    v.readonly(),
);
const agentAssistantSendMessageResultSchema = v.pipe(agentAssistantOperationResultSchema, v.readonly());
const agentAssistantLoginRequestSchema = v.object({mode: v.picklist([
    'chatgpt',
    'device-code',
])});
const agentAssistantEventBindingSchema = v.pipe(
    v.object({
        scopeFingerprint: v.string(),
        sessionKey: v.string(),
        turnGeneration: v.pipe(v.number(), v.integer(), v.minValue(0)),
        windowId: v.pipe(v.number(), v.integer(), v.minValue(0)),
    }),
    v.readonly(),
);
const agentAssistantEventSchema = v.pipe(
    v.object({
        type: agentAssistantEventTypeSchema,
        state: v.optional(agentAssistantStateSchema),
        message: v.optional(agentAssistantChatMessageSchema),
        messageId: v.optional(v.pipe(v.string(), v.trim(), v.nonEmpty('message id must not be empty'))),
        delta: v.optional(v.string()),
        reasoningDelta: v.optional(v.string()),
        turnId: v.optional(v.pipe(v.string(), v.trim(), v.nonEmpty('turn id must not be empty'))),
        phase: v.optional(agentAssistantTurnPhaseSchema),
        toolActivity: v.optional(agentAssistantTurnToolActivitySchema),
        lastEventAtMs: v.optional(v.pipe(v.number(), v.finite())),
        progress: v.optional(v.string()),
        error: v.optional(v.string()),
        errorEnvelope: v.optional(agentAssistantErrorEnvelopeSchema),
        binding: v.optional(agentAssistantEventBindingSchema),
    }),
    v.check(event => event.binding !== undefined || event.state !== undefined, 'invalid agent assistant event'),
    v.readonly(),
);
const agentCommandExecutionScopeSchemaWithTarget = v.object({
    ...agentCommandExecutionScopeBase,
    commandTarget: agentScopeCommandTargetSchema,
});
const agentCommandSchema = v.union([
    v.object({
        name: v.literal('activate_tab'),
        arguments: v.object({tabId: agentTabIdSchema}),
    }),
    v.pipe(
        v.object({
            name: v.literal('go_to_page'),
            arguments: v.object({
                page: v.pipe(v.number(), v.finite(), v.gtValue(0)),
                tabId: v.optional(v.nullable(agentTabIdSchema)),
            }),
        }),
        v.transform(({
            arguments: args, ...command
        }) => ({
            ...command,
            arguments: {
                page: args.page,
                ...(args.tabId == null ? {} : {tabId: args.tabId}),
            },
        })),
    ),
    v.pipe(
        v.object({
            name: v.literal('run_action'),
            arguments: v.object({
                id: v.pipe(v.string(), v.trim(), v.nonEmpty('action id must not be empty')),
                tabId: v.optional(v.nullable(agentTabIdSchema)),
                input: v.optional(v.record(v.string(), v.unknown())),
                dryRun: v.optional(v.boolean()),
            }),
        }),
        v.transform(({
            arguments: args, ...command
        }) => ({
            ...command,
            arguments: {
                id: args.id,
                ...(args.tabId == null ? {} : {tabId: args.tabId}),
                ...(args.input === undefined ? {} : {input: args.input}),
                ...(args.dryRun === undefined ? {} : {dryRun: args.dryRun}),
            },
        })),
    ),
    v.pipe(
        v.object({
            name: v.literal('read_resource'),
            arguments: v.object({
                uri: v.pipe(v.string(), v.trim(), v.nonEmpty('resource uri must not be empty')),
                tabId: v.optional(v.nullable(agentTabIdSchema)),
            }),
        }),
        v.transform(({
            arguments: args, ...command
        }) => ({
            ...command,
            arguments: {
                uri: args.uri,
                ...(args.tabId == null ? {} : {tabId: args.tabId}),
            },
        })),
    ),
]);
const agentCommandExecutionScopeSchema = agentCommandExecutionScopeSchemaWithTarget;
const agentWorkspaceSnapshotRequestSchemaWithoutScope = v.object({
    requestId: agentRequestIdSchema,
    windowId: v.optional(agentWindowIdSchema),
    lastSeenRevision: v.optional(agentRevisionSchema),
    scope: v.optional(v.nullable(agentCommandExecutionScopeSchemaWithTarget)),
});
type TAgentWorkspaceSnapshotRequestInput = v.InferOutput<typeof agentWorkspaceSnapshotRequestSchemaWithoutScope>;
type TAgentWorkspaceSnapshotRequestOutput = Omit<TAgentWorkspaceSnapshotRequestInput, 'scope'> & {scope?: Exclude<TAgentWorkspaceSnapshotRequestInput['scope'], null | undefined>;};
const agentWorkspaceSnapshotRequestSchema = v.pipe(
    agentWorkspaceSnapshotRequestSchemaWithoutScope,
    v.transform((request): TAgentWorkspaceSnapshotRequestOutput => {
        const {
            scope, ...rest
        } = request;
        return scope == null ? rest : {
            ...rest,
            scope,
        };
    }),
);
const agentCommandRequestSchemaInput = v.object({
    requestId: agentRequestIdSchema,
    windowId: v.optional(agentWindowIdSchema),
    scope: v.optional(v.nullable(agentCommandExecutionScopeSchemaWithTarget)),
    command: agentCommandSchema,
});
type TAgentCommandRequestInput = v.InferOutput<typeof agentCommandRequestSchemaInput>;
type TAgentCommandRequestOutput = Omit<TAgentCommandRequestInput, 'scope'> & {scope?: Exclude<TAgentCommandRequestInput['scope'], null | undefined>;};
const agentCommandRequestSchema = v.pipe(
    agentCommandRequestSchemaInput,
    v.transform((request): TAgentCommandRequestOutput => {
        const {
            scope, ...rest
        } = request;
        return scope == null ? rest : {
            ...rest,
            scope,
        };
    }),
);
const agentCommandCancelRequestSchema = v.object({
    requestId: agentRequestIdSchema,
    windowId: v.optional(agentWindowIdSchema),
});
const agentWorkspaceSnapshotResponseSchema = v.object({
    requestId: agentRequestIdSchema,
    windowId: v.optional(agentSafeIntegerSchema),
    ok: v.boolean(),
    snapshot: v.optional(v.custom<IAgentWorkspaceSnapshot>(isAgentWorkspaceSnapshot)),
    revision: v.optional(agentSafeIntegerSchema),
    unchanged: v.optional(v.boolean()),
    error: v.optional(v.string()),
});
const agentCommandResponseSchema = v.object({
    requestId: agentRequestIdSchema,
    windowId: v.optional(agentSafeIntegerSchema),
    ok: v.boolean(),
    result: v.optional(v.record(v.string(), v.unknown())),
    error: v.optional(v.string()),
});
const agentRendererAckSchema = v.pipe(
    v.object({
        accepted: v.boolean(),
        reason: v.optional(v.picklist([
            'invalid-payload',
            'unexpected-sender',
            'unknown-request',
        ])),
    }),
    v.readonly(),
);

export const AGENT_MCP_CODEX_REGISTRATION_STATE_SCHEMA = agentMcpCodexRegistrationStateSchema;
export const AGENT_MCP_INTEGRATION_STATUS_SCHEMA = agentMcpIntegrationStatusSchema;
export const AGENT_MCP_INTEGRATION_UPDATE_RESULT_SCHEMA = agentMcpIntegrationUpdateResultSchema;
export const AGENT_COMMAND_EXECUTION_SCOPE_SCHEMA = agentCommandExecutionScopeSchema;
export const AGENT_WORKSPACE_SNAPSHOT_REQUEST_SCHEMA = agentWorkspaceSnapshotRequestSchema;
export const AGENT_WORKSPACE_SNAPSHOT_RESPONSE_SCHEMA = v.message(agentWorkspaceSnapshotResponseSchema, 'invalid workspace snapshot response');
export const AGENT_COMMAND_SCHEMA = agentCommandSchema;
export const AGENT_COMMAND_REQUEST_SCHEMA = v.message(agentCommandRequestSchema, 'invalid agent command request');
export const AGENT_COMMAND_CANCEL_REQUEST_SCHEMA = v.message(agentCommandCancelRequestSchema, 'invalid agent command cancellation request');
export const AGENT_COMMAND_RESPONSE_SCHEMA = v.message(agentCommandResponseSchema, 'invalid agent command response');
export const AGENT_RENDERER_ACK_SCHEMA = v.message(agentRendererAckSchema, 'invalid agent renderer acknowledgement');
export const AGENT_ASSISTANT_ERROR_ENVELOPE_SCHEMA = agentAssistantErrorEnvelopeSchema;
export const AGENT_ASSISTANT_STATE_SCHEMA = v.message(agentAssistantStateSchema, 'invalid assistant state');
export const AGENT_ASSISTANT_STATE_REQUEST_SCHEMA = agentAssistantStateRequestSchema;
export const AGENT_ASSISTANT_SEND_MESSAGE_REQUEST_SCHEMA = agentAssistantSendMessageRequestSchema;
export const AGENT_ASSISTANT_INSTALL_RESULT_SCHEMA = v.message(agentAssistantInstallResultSchema, 'invalid assistant install');
export const AGENT_ASSISTANT_LOGIN_REQUEST_SCHEMA = agentAssistantLoginRequestSchema;
export const AGENT_ASSISTANT_LOGIN_RESULT_SCHEMA = v.message(agentAssistantLoginResultSchema, 'invalid assistant login');
export const AGENT_ASSISTANT_SEND_MESSAGE_RESULT_SCHEMA = v.message(agentAssistantSendMessageResultSchema, 'invalid assistant message');
export const AGENT_ASSISTANT_EVENT_SCHEMA = v.message(agentAssistantEventSchema, 'invalid agent assistant event');

export type TAgentMcpCodexRegistrationState = v.InferOutput<typeof AGENT_MCP_CODEX_REGISTRATION_STATE_SCHEMA>;
export type TAgentCommandName = v.InferOutput<typeof AGENT_COMMAND_SCHEMA>['name'];
export type IAgentCommandExecutionScope = v.InferOutput<typeof AGENT_COMMAND_EXECUTION_SCOPE_SCHEMA>;
export type IAgentWorkspaceSnapshotRequest = v.InferOutput<typeof AGENT_WORKSPACE_SNAPSHOT_REQUEST_SCHEMA>;
export type IAgentWorkspaceSnapshotResponse = v.InferOutput<typeof AGENT_WORKSPACE_SNAPSHOT_RESPONSE_SCHEMA>;
export type IAgentActivateTabCommand = Extract<v.InferOutput<typeof AGENT_COMMAND_SCHEMA>, {name: 'activate_tab'}>;
export type IAgentGoToPageCommand = Extract<v.InferOutput<typeof AGENT_COMMAND_SCHEMA>, {name: 'go_to_page'}>;
export type IAgentRunActionCommand = Extract<v.InferOutput<typeof AGENT_COMMAND_SCHEMA>, {name: 'run_action'}>;
export type IAgentReadResourceCommand = Extract<v.InferOutput<typeof AGENT_COMMAND_SCHEMA>, {name: 'read_resource'}>;
export type TAgentCommand = v.InferOutput<typeof AGENT_COMMAND_SCHEMA>;
export type IAgentCommandRequest = v.InferOutput<typeof AGENT_COMMAND_REQUEST_SCHEMA>;
export type IAgentCommandCancelRequest = v.InferOutput<typeof AGENT_COMMAND_CANCEL_REQUEST_SCHEMA>;
export type IAgentCommandResponse = v.InferOutput<typeof AGENT_COMMAND_RESPONSE_SCHEMA>;
export type TAgentRendererAckReason = v.InferOutput<typeof AGENT_RENDERER_ACK_SCHEMA>['reason'];
export type IAgentRendererAck = v.InferOutput<typeof AGENT_RENDERER_ACK_SCHEMA>;
export type IAgentMcpSetupSnippets = v.InferOutput<typeof agentMcpSetupSnippetsSchema>;
export type IAgentMcpIntegrationStatus = v.InferOutput<typeof AGENT_MCP_INTEGRATION_STATUS_SCHEMA>;
export type IAgentMcpIntegrationUpdateResult = v.InferOutput<typeof AGENT_MCP_INTEGRATION_UPDATE_RESULT_SCHEMA>;
export type TAgentAssistantErrorCode = v.InferOutput<typeof agentAssistantErrorCodeSchema>;
export type IAgentAssistantErrorEnvelope = v.InferOutput<typeof AGENT_ASSISTANT_ERROR_ENVELOPE_SCHEMA>;
export type IAgentAssistantAccount = v.InferOutput<typeof agentAssistantAccountSchema>;
export type IAgentAssistantMcpStatus = v.InferOutput<typeof agentAssistantMcpStatusSchema>;
export type IAgentAssistantModelOption = v.InferOutput<typeof agentAssistantModelOptionSchema>;
export type IAgentAssistantEffortOption = v.InferOutput<typeof agentAssistantEffortOptionSchema>;
export type IAgentAssistantServiceTierOption = v.InferOutput<typeof agentAssistantServiceTierOptionSchema>;
export type IAgentAssistantProviderStatus = v.InferOutput<typeof agentAssistantProviderStatusSchema>;
export type IAgentAssistantChatScope = v.InferOutput<typeof agentAssistantChatScopeSchema>;
export type IAgentAssistantStatus = v.InferOutput<typeof agentAssistantStatusSchema>;
export type IAgentAssistantTurnState = v.InferOutput<typeof agentAssistantTurnStateSchema>;
export type IAgentAssistantTokenUsage = v.InferOutput<typeof agentAssistantTokenUsageSchema>;
export type IAgentAssistantToolActivity = v.InferOutput<typeof agentAssistantTurnToolActivitySchema>;
export type IAgentAssistantChatMessage = v.InferOutput<typeof agentAssistantChatMessageSchema>;
export type IAgentAssistantImageAttachment = v.InferOutput<typeof agentAssistantImageAttachmentSchema>;
export type IAgentAssistantState = v.InferOutput<typeof AGENT_ASSISTANT_STATE_SCHEMA>;
export type IAgentAssistantStateRequest = v.InferOutput<typeof AGENT_ASSISTANT_STATE_REQUEST_SCHEMA>;
export type IAgentAssistantInstallResult = v.InferOutput<typeof AGENT_ASSISTANT_INSTALL_RESULT_SCHEMA>;
export type IAgentAssistantLoginRequest = v.InferOutput<typeof AGENT_ASSISTANT_LOGIN_REQUEST_SCHEMA>;
export type IAgentAssistantLoginResult = v.InferOutput<typeof AGENT_ASSISTANT_LOGIN_RESULT_SCHEMA>;
export type TAgentAssistantPresetId = v.InferOutput<typeof agentAssistantPresetSchema>;
export type IAgentAssistantSendMessageRequest = v.InferOutput<typeof AGENT_ASSISTANT_SEND_MESSAGE_REQUEST_SCHEMA>;
export type IAgentAssistantSendMessageResult = v.InferOutput<typeof AGENT_ASSISTANT_SEND_MESSAGE_RESULT_SCHEMA>;
export type IAgentAssistantScopedRequest = v.InferOutput<typeof AGENT_ASSISTANT_STATE_REQUEST_SCHEMA>;
export type IAgentAssistantEvent = v.InferOutput<typeof AGENT_ASSISTANT_EVENT_SCHEMA>;
export type IAgentAssistantEventBinding = v.InferOutput<typeof agentAssistantEventBindingSchema>;
export type TAgentAssistantInstallState = v.InferOutput<typeof agentAssistantInstallStateSchema>;
export type TAgentAssistantAuthState = v.InferOutput<typeof agentAssistantAuthStateSchema>;
export type TAgentAssistantRuntimeState = v.InferOutput<typeof agentAssistantRuntimeStateSchema>;
export type TAgentAssistantModelSwitchMode = v.InferOutput<typeof agentAssistantModelSwitchModeSchema>;
export type TAgentAssistantTurnPhase = v.InferOutput<typeof agentAssistantTurnPhaseSchema>;
export type TAgentAssistantLoginMode = v.InferOutput<typeof AGENT_ASSISTANT_LOGIN_REQUEST_SCHEMA>['mode'];
export type TAgentAssistantMessageRole = v.InferOutput<typeof agentAssistantMessageRoleSchema>;
export type TAgentAssistantEventType = v.InferOutput<typeof agentAssistantEventTypeSchema>;
export type TAgentAssistantChatScopeKind = v.InferOutput<typeof agentAssistantChatScopeSchema>['kind'];
export type TAgentAssistantProviderId = v.InferOutput<typeof agentAssistantProviderIdSchema>;
export type TAgentAssistantKnownEffort = typeof ASSISTANT_KNOWN_EFFORTS[number];
export type TAgentAssistantEffort = string;
export type TAgentAssistantSpeedMode = v.InferOutput<typeof agentAssistantSpeedModeSchema>;
