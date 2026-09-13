import type {
    TEditorLayoutNode,
    TPaneId,
} from '@contracts/editorPanes';
import type {
    TDocumentBackend,
    TDocumentRef,
} from '@contracts/documentRef';
import type {
    IDocumentRevisionInfo,
    TDocumentRevisionToken,
} from '@contracts/documentRevision';
import type { TDocumentInstanceId } from '@contracts/documentInstanceId';
import type {
    TRequestId,
    TSessionId,
} from '@contracts/shared';
import type {
    TEpochMs,
    TIsoTimestamp,
} from '@contracts/timestamps';
import type {TTabId} from '@contracts/windowTabs';

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
export type TAgentCommandName = 'activate_tab' | 'go_to_page' | 'run_action' | 'read_resource';
export type TAgentMcpCodexRegistrationState = 'configured' | 'missing' | 'mismatched' | 'unknown';
export type TAgentAssistantInstallState = 'installed' | 'missing' | 'unsupported';
export type TAgentAssistantAuthState = 'signed-in' | 'signed-out' | 'login-pending' | 'unknown';
export type TAgentAssistantRuntimeState = 'stopped' | 'starting' | 'ready' | 'busy' | 'error';
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
export type TAgentAssistantTurnPhase = typeof AGENT_ASSISTANT_TURN_PHASES[number];
export type TAgentAssistantLoginMode = 'chatgpt' | 'device-code';
export const AGENT_ASSISTANT_MESSAGE_ROLES = [
    'user',
    'assistant',
    'system',
] as const;
export type TAgentAssistantMessageRole = typeof AGENT_ASSISTANT_MESSAGE_ROLES[number];
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
export type TAgentAssistantEventType = typeof AGENT_ASSISTANT_EVENT_TYPES[number];
export type TAgentAssistantChatScopeKind = 'document';
export const ASSISTANT_PROVIDER_IDS = [
    'codex',
    'claude',
] as const;
export type TAgentAssistantProviderId = typeof ASSISTANT_PROVIDER_IDS[number];
export type TAgentAssistantModelSwitchMode = 'none' | 'in-session';
export const ASSISTANT_KNOWN_EFFORTS = [
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
] as const;
export type TAgentAssistantKnownEffort = typeof ASSISTANT_KNOWN_EFFORTS[number];
export type TAgentAssistantEffort = TAgentAssistantKnownEffort | (string & {});
export type TAgentAssistantSpeedMode = 'fast' | 'standard';
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

export type TAgentWorkspaceCommandTarget =
    | {
        readonly kind: 'transaction';
        readonly tabId: TTabId;
        readonly sessionId: TSessionId;
        readonly documentRef: TDocumentRef | null;
        readonly documentBackend?: TDocumentBackend;
        readonly documentInstanceId?: TDocumentInstanceId | null;
        readonly transactionId: string;
        readonly documentRevisionToken?: TDocumentRevisionToken;
    }
    | {
        readonly kind: 'revision';
        readonly tabId: TTabId;
        readonly sessionId: TSessionId;
        readonly documentRef: TDocumentRef | null;
        readonly documentBackend?: TDocumentBackend;
        readonly documentInstanceId?: TDocumentInstanceId | null;
        readonly sessionRevision: number;
        readonly documentRevisionToken?: TDocumentRevisionToken;
    };

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

export interface IAgentCommandExecutionScope {
    windowId: number;
    tabId: TTabId;
    documentRef: TDocumentRef | null;
    documentBackend?: TDocumentBackend;
    documentInstanceId?: TDocumentInstanceId | null;
    documentIdentity: IDocumentRevisionInfo | null;
    commandTarget?: TAgentWorkspaceCommandTarget;
}

export interface IAgentWorkspaceSnapshotRequest {
    requestId: TRequestId;
    windowId?: number;
    lastSeenRevision?: number;
    scope?: IAgentCommandExecutionScope;
}

export interface IAgentWorkspaceSnapshotResponse {
    requestId: TRequestId;
    windowId?: number;
    ok: boolean;
    snapshot?: IAgentWorkspaceSnapshot;
    revision?: number;
    unchanged?: boolean;
    error?: string;
}

export interface IAgentActivateTabCommand {
    name: 'activate_tab';
    arguments: {tabId: TTabId;};
}

export interface IAgentGoToPageCommand {
    name: 'go_to_page';
    arguments: {
        page: number;
        tabId?: TTabId;
    };
}

export interface IAgentRunActionCommand {
    name: 'run_action';
    arguments: {
        id: string;
        tabId?: TTabId;
        input?: Record<string, unknown>;
        dryRun?: boolean;
    };
}

export interface IAgentReadResourceCommand {
    name: 'read_resource';
    arguments: {
        uri: string;
        tabId?: TTabId;
    };
}

export type TAgentCommand =
    | IAgentActivateTabCommand
    | IAgentGoToPageCommand
    | IAgentRunActionCommand
    | IAgentReadResourceCommand;

export interface IAgentCommandRequest {
    requestId: TRequestId;
    windowId?: number;
    scope?: IAgentCommandExecutionScope;
    command: TAgentCommand;
}

export interface IAgentCommandCancelRequest {
    requestId: TRequestId;
    windowId?: number;
}

export interface IAgentCommandResponse {
    requestId: TRequestId;
    windowId?: number;
    ok: boolean;
    result?: Record<string, unknown>;
    error?: string;
}

export type TAgentRendererAckReason =
    | 'invalid-payload'
    | 'unexpected-sender'
    | 'unknown-request';

export interface IAgentRendererAck {
    readonly accepted: boolean;
    readonly reason?: TAgentRendererAckReason;
}

export interface IAgentMcpSetupSnippets {
    readonly codex: string;
    readonly claude: string;
    readonly cursor: string;
}

export interface IAgentMcpIntegrationStatus {
    readonly enabled: boolean;
    readonly serverName: string;
    readonly serverUrl: string;
    readonly serverRunning: boolean;
    readonly codexInstalled: boolean;
    readonly codexPath: string | null;
    readonly codexConfigured: boolean;
    readonly codexRegistrationState: TAgentMcpCodexRegistrationState;
    readonly installUrl: string;
    // Agent API keeps ISO text for its renderer and server wire format.
    readonly lastCheckedAt: TIsoTimestamp;
    readonly setupSnippets?: IAgentMcpSetupSnippets;
    readonly error?: string;
}

export interface IAgentMcpIntegrationUpdateResult {
    readonly ok: boolean;
    readonly cancelled?: boolean;
    readonly status: IAgentMcpIntegrationStatus;
    readonly error?: string;
}

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
export type TAgentAssistantErrorCode = typeof AGENT_ASSISTANT_ERROR_CODES[number];

export interface IAgentAssistantErrorEnvelope {
    readonly code: TAgentAssistantErrorCode;
    readonly message: string;
    readonly retryable: boolean;
    readonly timestamp: TEpochMs;
}

export interface IAgentAssistantAccount {
    type: 'chatgpt' | 'apiKey' | 'other';
    email?: string;
    planType?: string;
}

export interface IAgentAssistantMcpStatus {
    serverName: string;
    serverUrl: string;
    serverRunning: boolean;
    toolCount: number;
}

export interface IAgentAssistantModelOption {
    id: string;
    label: string;
    reasoningEfforts?: readonly IAgentAssistantEffortOption[];
    defaultReasoningEffort?: TAgentAssistantEffort | null;
    serviceTiers?: readonly IAgentAssistantServiceTierOption[];
    defaultServiceTier?: string | null;
}

export interface IAgentAssistantEffortOption {
    id: TAgentAssistantEffort;
    label: string;
    description?: string;
    isDefault?: boolean;
}

export interface IAgentAssistantServiceTierOption {
    id: string;
    label: string;
    description?: string;
    isDefault?: boolean;
}

export interface IAgentAssistantProviderStatus {
    id: TAgentAssistantProviderId;
    label: string;
    installState: TAgentAssistantInstallState;
    authState: TAgentAssistantAuthState;
    runtimeState: TAgentAssistantRuntimeState;
    models: readonly IAgentAssistantModelOption[];
    defaultModel: string;
    activeModel: string;
    modelSwitchMode: TAgentAssistantModelSwitchMode;
    availableEfforts: readonly TAgentAssistantEffort[];
    defaultEffort: TAgentAssistantEffort;
    activeEffort: TAgentAssistantEffort;
    availableSpeedModes: readonly TAgentAssistantSpeedMode[];
    defaultSpeedMode: TAgentAssistantSpeedMode;
    activeSpeedMode: TAgentAssistantSpeedMode;
    path: string | null;
    version: string | null;
    minimumVersion: string | null;
    versionSupported: boolean;
    installUrl: string;
    account: IAgentAssistantAccount | null;
    error?: string;
    errorEnvelope?: IAgentAssistantErrorEnvelope;
}

export interface IAgentAssistantChatScope {
    kind: TAgentAssistantChatScopeKind;
    key: string;
    title: string | null;
    tabId?: TTabId | null;
    documentSessionKey?: string | null;
    documentInstanceId?: TDocumentInstanceId | null;
    documentRef?: TDocumentRef | null;
    documentBackend?: TDocumentBackend;
    documentIdentity?: IDocumentRevisionInfo | null;
    commandTarget?: TAgentWorkspaceCommandTarget;
}

export interface IAgentAssistantStatus {
    supported: boolean;
    platform: string;
    provider: TAgentAssistantProviderId;
    providerLabel: string;
    providers: readonly IAgentAssistantProviderStatus[];
    model: string;
    modelLabel: string;
    models: readonly IAgentAssistantModelOption[];
    modelSwitchMode: TAgentAssistantModelSwitchMode;
    effort: TAgentAssistantEffort;
    availableEfforts: readonly TAgentAssistantEffort[];
    speedMode: TAgentAssistantSpeedMode;
    availableSpeedModes: readonly TAgentAssistantSpeedMode[];
    installState: TAgentAssistantInstallState;
    codexInstalled: boolean;
    codexPath: string | null;
    codexVersion: string | null;
    minimumCodexVersion: string;
    codexVersionSupported: boolean;
    installUrl: string;
    installScriptUrl: string;
    managedInstallDir: string;
    authState: TAgentAssistantAuthState;
    account: IAgentAssistantAccount | null;
    runtimeState: TAgentAssistantRuntimeState;
    mcp: IAgentAssistantMcpStatus;
    turn: IAgentAssistantTurnState;
    // Agent API keeps ISO text for its renderer and server wire format.
    lastCheckedAt: TIsoTimestamp;
    error?: string;
    errorEnvelope?: IAgentAssistantErrorEnvelope;
}

export interface IAgentAssistantTurnState {
    id: string | null;
    phase: TAgentAssistantTurnPhase;
    reasoning: string;
    toolActivity: IAgentAssistantToolActivity[];
    lastEventAtMs: number | null;
    usage: IAgentAssistantTokenUsage | null;
}

export interface IAgentAssistantTokenUsage {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
}

export interface IAgentAssistantToolActivity {
    toolId: string;
    name: string;
    phase: 'running' | 'completed' | 'failed';
    startedAtMs: number;
    completedAtMs?: number;
}

export interface IAgentAssistantChatMessage {
    id: string;
    role: TAgentAssistantMessageRole;
    text: string;
    // Agent API keeps ISO text for its renderer and server wire format.
    createdAt: TIsoTimestamp;
    attachments?: IAgentAssistantImageAttachment[];
    pending?: boolean;
    error?: string;
    errorEnvelope?: IAgentAssistantErrorEnvelope;
}

export interface IAgentAssistantImageAttachment {
    type: 'image';
    id: string;
    name: string;
    mimeType: string;
    sizeBytes: number;
    dataUrl: string;
    previewDataUrl?: string;
}

export interface IAgentAssistantState {
    scope: IAgentAssistantChatScope | null;
    status: IAgentAssistantStatus;
    messages: IAgentAssistantChatMessage[];
}

export interface IAgentAssistantStateRequest {
    scope?: IAgentAssistantChatScope | null;
    provider?: TAgentAssistantProviderId;
    model?: string;
    effort?: TAgentAssistantEffort;
    speedMode?: TAgentAssistantSpeedMode;
}

export interface IAgentAssistantInstallResult {
    readonly ok: boolean;
    readonly state: IAgentAssistantState;
    readonly error?: string;
    readonly errorEnvelope?: IAgentAssistantErrorEnvelope;
}

export interface IAgentAssistantLoginRequest {mode: TAgentAssistantLoginMode;}

export interface IAgentAssistantLoginResult {
    readonly ok: boolean;
    readonly state: IAgentAssistantState;
    readonly loginId?: string;
    readonly authUrl?: string;
    readonly verificationUrl?: string;
    readonly userCode?: string;
    readonly error?: string;
    readonly errorEnvelope?: IAgentAssistantErrorEnvelope;
}

export const AGENT_ASSISTANT_PRESET_IDS = [
    'add-bookmarks',
    'number-pages',
    'check-ocr-readiness',
] as const;
export const ASSISTANT_MAX_IMAGE_ATTACHMENTS = 8;
export const ASSISTANT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export type TAgentAssistantPresetId = typeof AGENT_ASSISTANT_PRESET_IDS[number];

export interface IAgentAssistantSendMessageRequest {
    text: string;
    scope?: IAgentAssistantChatScope | null;
    provider?: TAgentAssistantProviderId;
    model?: string;
    effort?: TAgentAssistantEffort;
    speedMode?: TAgentAssistantSpeedMode;
    attachments?: IAgentAssistantImageAttachment[];
    presetId?: TAgentAssistantPresetId;
}

export interface IAgentAssistantSendMessageResult {
    readonly ok: boolean;
    readonly state: IAgentAssistantState;
    readonly error?: string;
    readonly errorEnvelope?: IAgentAssistantErrorEnvelope;
}

export interface IAgentAssistantScopedRequest {
    scope?: IAgentAssistantChatScope | null;
    provider?: TAgentAssistantProviderId;
    model?: string;
    effort?: TAgentAssistantEffort;
    speedMode?: TAgentAssistantSpeedMode;
}

export interface IAgentAssistantEvent {
    readonly type: TAgentAssistantEventType;
    readonly state?: IAgentAssistantState;
    readonly message?: IAgentAssistantChatMessage;
    readonly messageId?: string;
    readonly delta?: string;
    readonly reasoningDelta?: string;
    readonly turnId?: string;
    readonly phase?: TAgentAssistantTurnPhase;
    readonly toolActivity?: IAgentAssistantToolActivity;
    readonly lastEventAtMs?: number;
    readonly progress?: string;
    readonly error?: string;
    readonly errorEnvelope?: IAgentAssistantErrorEnvelope;
    /** Immutable identity of the document-bound turn that produced this event. */
    readonly binding?: IAgentAssistantEventBinding;
}

export interface IAgentAssistantEventBinding {
    readonly scopeFingerprint: string;
    readonly sessionKey: string;
    readonly turnGeneration: number;
    readonly windowId: number;
}
