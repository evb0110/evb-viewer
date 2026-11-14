import * as v from 'valibot';
import {
    AGENT_ASSISTANT_ACCOUNT_SCHEMA,
    AGENT_ASSISTANT_CHAT_SCOPE_SCHEMA,
    AGENT_ASSISTANT_ERROR_ENVELOPE_SCHEMA,
    AGENT_ASSISTANT_IMAGE_ATTACHMENT_SCHEMA,
    AGENT_ASSISTANT_MODEL_OPTION_SCHEMA,
    AGENT_ASSISTANT_PRESET_SCHEMA,
    AGENT_ASSISTANT_REQUEST_IMAGE_ATTACHMENTS_SCHEMA,
    AGENT_ASSISTANT_TOKEN_USAGE_SCHEMA,
    AGENT_ASSISTANT_TURN_PHASE_SCHEMA,
    AGENT_ISO_TIMESTAMP_SCHEMA,
} from '@contracts/agent';

/**
 * The in-app assistant runs one of several configured provider instances.
 * An instance is one way of running a driver: its executable, home directory,
 * launch arguments and environment. Two Codex instances can use different
 * accounts or a proxy, exactly as T3 Code's provider instances do.
 */
export const ASSISTANT_DRIVERS = [
    'codex',
    'claude',
] as const;
export const ASSISTANT_DEFAULT_INSTANCE_IDS = {
    codex: 'codex',
    claude: 'claude',
} as const;
export const ASSISTANT_INSTANCE_STATES = [
    'checking',
    'ready',
    'warning',
    'error',
    'disabled',
    'missing',
] as const;
export const ASSISTANT_AUTH_STATES = [
    'authenticated',
    'unauthenticated',
    'unknown',
] as const;
export const ASSISTANT_SPEED_MODES = [
    'fast',
    'standard',
] as const;
export const ASSISTANT_ITEM_KINDS = [
    'user',
    'assistant',
    'reasoning',
    'tool',
    'system',
] as const;
export const ASSISTANT_ITEM_STATUSES = [
    'streaming',
    'completed',
    'interrupted',
    'failed',
] as const;
export const ASSISTANT_INSTANCE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/u;

const instanceIdSchema = v.pipe(
    v.string(),
    v.regex(ASSISTANT_INSTANCE_ID_PATTERN, 'assistant instance id must be a lowercase slug'),
);
const driverSchema = v.picklist(ASSISTANT_DRIVERS);
const speedModeSchema = v.picklist(ASSISTANT_SPEED_MODES);
const nonBlankString = v.pipe(v.string(), v.trim(), v.nonEmpty());

/**
 * One environment row of an instance. A secret row never travels to the
 * renderer with its value: reads return `value: ''` and `configured`, and a
 * save with an empty secret value keeps the stored one.
 */
const environmentEntrySchema = v.object({
    name: v.pipe(v.string(), v.regex(/^[A-Za-z_][A-Za-z0-9_]*$/u, 'invalid environment variable name')),
    value: v.string(),
    secret: v.boolean(),
    configured: v.optional(v.boolean()),
});

const instanceConfigSchema = v.object({
    id: instanceIdSchema,
    driver: driverSchema,
    displayName: nonBlankString,
    enabled: v.boolean(),
    binaryPath: v.optional(v.string()),
    homePath: v.optional(v.string()),
    shadowHomePath: v.optional(v.string()),
    launchArgs: v.optional(v.string()),
    launchArgsSecret: v.optional(v.boolean()),
    launchArgsConfigured: v.optional(v.boolean()),
    environment: v.optional(v.array(environmentEntrySchema)),
    importedFrom: v.optional(v.literal('t3code')),
});

const instancesSchema = v.pipe(
    v.array(instanceConfigSchema),
    v.check(list => new Set(list.map(instance => instance.id)).size === list.length, 'assistant instance ids must be unique'),
);

const instanceStatusSchema = v.object({
    id: instanceIdSchema,
    driver: driverSchema,
    label: v.string(),
    enabled: v.boolean(),
    state: v.picklist(ASSISTANT_INSTANCE_STATES),
    auth: v.picklist(ASSISTANT_AUTH_STATES),
    // The instance's own words: the probe or startup failure, never a
    // generic placeholder. Present for warning, error and missing states.
    message: v.optional(v.string()),
    binaryPath: v.nullable(v.string()),
    version: v.nullable(v.string()),
    homePath: v.nullable(v.string()),
    customEndpoint: v.boolean(),
    account: v.nullable(AGENT_ASSISTANT_ACCOUNT_SCHEMA),
    models: v.array(AGENT_ASSISTANT_MODEL_OPTION_SCHEMA),
    defaultModel: v.nullable(v.string()),
    checkedAt: v.nullable(AGENT_ISO_TIMESTAMP_SCHEMA),
    canInstall: v.boolean(),
    canSignIn: v.boolean(),
    loginPending: v.boolean(),
});

const selectionSchema = v.object({
    instanceId: instanceIdSchema,
    model: v.string(),
    effort: v.string(),
    speedMode: speedModeSchema,
});

const itemSchema = v.object({
    id: nonBlankString,
    kind: v.picklist(ASSISTANT_ITEM_KINDS),
    turnId: v.nullable(v.string()),
    createdAt: AGENT_ISO_TIMESTAMP_SCHEMA,
    text: v.string(),
    status: v.picklist(ASSISTANT_ITEM_STATUSES),
    attachments: v.optional(v.array(AGENT_ASSISTANT_IMAGE_ATTACHMENT_SCHEMA)),
    toolName: v.optional(v.string()),
    toolDetail: v.optional(v.string()),
    completedAt: v.optional(AGENT_ISO_TIMESTAMP_SCHEMA),
    errorEnvelope: v.optional(AGENT_ASSISTANT_ERROR_ENVELOPE_SCHEMA),
});

const turnSchema = v.object({
    id: nonBlankString,
    phase: AGENT_ASSISTANT_TURN_PHASE_SCHEMA,
    startedAtMs: v.pipe(v.number(), v.finite()),
    usage: v.nullable(AGENT_ASSISTANT_TOKEN_USAGE_SCHEMA),
});

const chatSchema = v.object({
    sessionKey: nonBlankString,
    scope: AGENT_ASSISTANT_CHAT_SCOPE_SCHEMA,
    instanceId: instanceIdSchema,
    model: v.string(),
    items: v.array(itemSchema),
    turn: v.nullable(turnSchema),
});

const stateSchema = v.object({
    supported: v.boolean(),
    enabled: v.boolean(),
    instances: v.array(instanceStatusSchema),
    selection: v.nullable(selectionSchema),
    chat: v.nullable(chatSchema),
    installProgress: v.nullable(v.string()),
});

const stateRequestSchema = v.object({
    scope: v.optional(v.nullable(AGENT_ASSISTANT_CHAT_SCOPE_SCHEMA)),
    selection: v.optional(selectionSchema),
    probe: v.optional(v.boolean()),
});

const sendRequestSchema = v.object({
    text: v.string(),
    scope: AGENT_ASSISTANT_CHAT_SCOPE_SCHEMA,
    selection: selectionSchema,
    attachments: v.optional(AGENT_ASSISTANT_REQUEST_IMAGE_ATTACHMENTS_SCHEMA),
    presetId: v.optional(AGENT_ASSISTANT_PRESET_SCHEMA),
});

const chatRequestSchema = v.object({
    scope: AGENT_ASSISTANT_CHAT_SCOPE_SCHEMA,
    instanceId: instanceIdSchema,
});

const instanceRequestSchema = v.object({instanceId: instanceIdSchema});

const loginRequestSchema = v.object({
    instanceId: instanceIdSchema,
    mode: v.picklist([
        'chatgpt',
        'device-code',
    ]),
});

const operationResultSchema = v.object({
    ok: v.boolean(),
    state: stateSchema,
    error: v.optional(AGENT_ASSISTANT_ERROR_ENVELOPE_SCHEMA),
});

const loginResultSchema = v.object({
    ok: v.boolean(),
    state: stateSchema,
    authUrl: v.optional(v.string()),
    verificationUrl: v.optional(v.string()),
    userCode: v.optional(v.string()),
    error: v.optional(AGENT_ASSISTANT_ERROR_ENVELOPE_SCHEMA),
});

const instancesResultSchema = v.object({
    ok: v.boolean(),
    instances: v.array(instanceConfigSchema),
    notices: v.array(v.string()),
    error: v.optional(v.string()),
});

/**
 * Events carry what changed. `instances` replaces every instance status.
 * `chat` replaces one session's chat; `item` upserts one timeline item and
 * `item-delta` appends text to it; `turn` replaces the session's turn. A
 * renderer applies session events only for the session key it shows.
 */
const eventSchema = v.variant('type', [
    v.object({
        type: v.literal('instances'),
        instances: v.array(instanceStatusSchema),
    }),
    v.object({
        type: v.literal('chat'),
        chat: chatSchema,
    }),
    v.object({
        type: v.literal('item'),
        sessionKey: nonBlankString,
        item: itemSchema,
    }),
    v.object({
        type: v.literal('item-delta'),
        sessionKey: nonBlankString,
        itemId: nonBlankString,
        delta: v.string(),
    }),
    v.object({
        type: v.literal('turn'),
        sessionKey: nonBlankString,
        turn: v.nullable(turnSchema),
    }),
    v.object({
        type: v.literal('install-progress'),
        progress: v.nullable(v.string()),
    }),
]);
export const ASSISTANT_INSTANCES_SCHEMA = v.message(instancesSchema, 'invalid assistant provider instances');
export const ASSISTANT_SELECTION_SCHEMA = selectionSchema;
export const ASSISTANT_STATE_SCHEMA = v.message(stateSchema, 'invalid assistant state');
export const ASSISTANT_STATE_REQUEST_SCHEMA = stateRequestSchema;
export const ASSISTANT_SEND_REQUEST_SCHEMA = sendRequestSchema;
export const ASSISTANT_CHAT_REQUEST_SCHEMA = chatRequestSchema;
export const ASSISTANT_INSTANCE_REQUEST_SCHEMA = instanceRequestSchema;
export const ASSISTANT_LOGIN_REQUEST_SCHEMA = loginRequestSchema;
export const ASSISTANT_OPERATION_RESULT_SCHEMA = v.message(operationResultSchema, 'invalid assistant result');
export const ASSISTANT_LOGIN_RESULT_SCHEMA = v.message(loginResultSchema, 'invalid assistant login result');
export const ASSISTANT_INSTANCES_RESULT_SCHEMA = v.message(instancesResultSchema, 'invalid assistant instances result');
export const ASSISTANT_EVENT_SCHEMA = v.message(eventSchema, 'invalid assistant event');

export type TAssistantDriver = typeof ASSISTANT_DRIVERS[number];
export type TAssistantItemStatus = typeof ASSISTANT_ITEM_STATUSES[number];
export type IAssistantEnvironmentEntry = v.InferOutput<typeof environmentEntrySchema>;
export type IAssistantInstanceConfig = v.InferOutput<typeof instanceConfigSchema>;
export type IAssistantInstanceStatus = v.InferOutput<typeof instanceStatusSchema>;
export type IAssistantSelection = v.InferOutput<typeof selectionSchema>;
export type IAssistantItem = v.InferOutput<typeof itemSchema>;
export type IAssistantTurn = v.InferOutput<typeof turnSchema>;
export type IAssistantChat = v.InferOutput<typeof chatSchema>;
export type IAssistantState = v.InferOutput<typeof stateSchema>;
export type IAssistantStateRequest = v.InferOutput<typeof stateRequestSchema>;
export type IAssistantSendRequest = v.InferOutput<typeof sendRequestSchema>;
export type IAssistantChatRequest = v.InferOutput<typeof chatRequestSchema>;
export type IAssistantInstanceRequest = v.InferOutput<typeof instanceRequestSchema>;
export type IAssistantLoginRequest = v.InferOutput<typeof loginRequestSchema>;
export type IAssistantOperationResult = v.InferOutput<typeof operationResultSchema>;
export type IAssistantLoginResult = v.InferOutput<typeof loginResultSchema>;
export type IAssistantInstancesResult = v.InferOutput<typeof instancesResultSchema>;
export type IAssistantEvent = v.InferOutput<typeof eventSchema>;

export function assistantSessionKey(instanceId: string, scopeKey: string) {
    return `${instanceId}:${scopeKey}`;
}
