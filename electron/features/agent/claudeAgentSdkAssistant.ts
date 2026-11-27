import {randomUUID} from 'node:crypto';
import {readdir} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {app} from 'electron';
import {
    query,
    type AccountInfo,
    type CanUseTool,
    type EffortLevel,
    type Query,
    type SDKMessage,
    type SDKPartialAssistantMessage,
    type SDKResultMessage,
    type SDKSystemMessage,
    type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type {
    IAgentAssistantImageAttachment,
    IAgentAssistantModelOption,
    IAgentAssistantTokenUsage,
    TAgentAssistantEffort,
    TAgentAssistantKnownEffort,
    TAgentAssistantSpeedMode,
} from '@contracts/agent';
import {
    ASSISTANT_KNOWN_EFFORTS,
    createAssistantEffortOptions,
    normalizeAssistantEffortId,
} from '@contracts/agentModels';
import {
    isOneOf,
    isRecord,
} from '@contracts/runtimeGuards';
import { createClaudeContextUnavailableError } from '@electron/features/agent/createClaudeContextUnavailableError';
import {waitForBoundedOperation} from '@node-runtime/waitForBoundedOperation';
import {
    ASSISTANT_IMAGE_ONLY_PROMPT,
    ASSISTANT_MCP_TOOLS,
    ASSISTANT_MCP_TOKEN_ENV,
    ASSISTANT_MCP_TOOL_TIMEOUT_SECONDS,
    ASSISTANT_ROLE_PROMPT,
} from '@electron/features/agent/codexAssistantConfig';
import {te} from '@electron/te';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';
import {
    extractClaudeMessageItems,
    extractClaudeTokenUsage,
    type IClaudeAssistantToolActivity,
} from '@electron/features/agent/claudeAssistantStreamPresentation';

import {resolveClaudeSdkExecutablePath} from '@electron/features/agent/claudeProviderMetadata';
import {describeManifestModel} from '@electron/features/agent/assistantModelManifest';
import {sanitizeAssistantProviderText} from '@electron/features/agent/assistantErrorEnvelope';
const logger = createLogger('agent-claude-assistant');
const CLAUDE_EFFORT_LEVEL_BY_ASSISTANT_EFFORT = {
    low: 'low',
    medium: 'medium',
    high: 'high',
    xhigh: 'xhigh',
    max: 'max',
} as const satisfies Record<TAgentAssistantKnownEffort, EffortLevel>;
type TClaudeImageMimeType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

export {shouldRefuseClaudeContextContinuation} from '@electron/features/agent/claudeProviderMetadata';

export interface IClaudeAgentAssistantInit {
    sessionId: string | null;
    model: string | null;
    toolCount: number;
    account: AccountInfo | null;
    models?: readonly IAgentAssistantModelOption[];
}

export interface IClaudeAgentAssistantCallbacks {
    onInitialized(info: IClaudeAgentAssistantInit): void;
    onTurnStarted(turnId: string): void;
    onReasoningDelta(turnId: string | null, delta: string): void;
    onToolActivity(turnId: string | null, activity: IClaudeAssistantToolActivity): void;
    onUsage(turnId: string | null, usage: IAgentAssistantTokenUsage): void;
    onAssistantMessage(turnId: string | null, messageId: string, text: string): void;
    onTurnCompleted(turnId: string | null): void;
    onError(turnId: string | null, message: unknown): void;
}

export interface IClaudeAgentAssistantSessionOptions {
    cwd: string;
    model: string;
    effort: TAgentAssistantEffort;
    speedMode: TAgentAssistantSpeedMode;
    resumeSessionId?: string | null;
    mcpServerName: string;
    mcpServerUrl: string;
    mcpToken: string;
    executablePath: string | null;
    /** The instance's environment, including its CLAUDE_CONFIG_DIR. */
    env: NodeJS.ProcessEnv;
    /** The instance's own launch flags, already checked against EVB's restrictions. */
    extraArgs?: Record<string, string | null>;
    modelOptions?: readonly IAgentAssistantModelOption[];
    callbacks: IClaudeAgentAssistantCallbacks;
}

const CLAUDE_METADATA_TIMEOUT_MS = 15_000;
const CLAUDE_CONTROL_TIMEOUT_MS = 10_000;
const CLAUDE_INTERRUPT_TIMEOUT_MS = 5_000;

function waitForClaudeInterrupt(operation: Promise<unknown>) {
    return waitForBoundedOperation(operation, {
        timeoutMs: CLAUDE_INTERRUPT_TIMEOUT_MS,
        timeoutError: () => new Error('Assistant interrupt timed out.'),
    });
}

/**
 * Whether a Claude session transcript exists in this instance's config
 * directory. The SDK's own lookup reads the process-wide CLAUDE_CONFIG_DIR,
 * which would check the wrong account for a custom-home instance.
 */
export async function hasClaudeSessionTranscript(env: NodeJS.ProcessEnv, sessionId: string) {
    // An empty CLAUDE_CONFIG_DIR means the default, as Claude Code treats it.
    const configDir = [env.CLAUDE_CONFIG_DIR?.trim() ?? ''].find(dir => dir.length > 0) ?? join(homedir(), '.claude');
    const projectsDir = join(configDir, 'projects');
    let projects: string[];
    try {
        projects = await readdir(projectsDir);
    } catch {
        return false;
    }
    for (const project of projects) {
        try {
            if ((await readdir(join(projectsDir, project))).includes(`${sessionId}.jsonl`)) {
                return true;
            }
        } catch {
            // Not a directory.
        }
    }
    return false;
}

class ClaudePromptQueue implements AsyncIterable<SDKUserMessage, undefined> {
    private readonly items: SDKUserMessage[] = [];
    private readonly resolvers: Array<(value: IteratorResult<SDKUserMessage, undefined>) => void> = [];
    private closed = false;

    push(message: SDKUserMessage) {
        if (this.closed) {
            throw new Error('Claude assistant session is closed.');
        }

        const resolver = this.resolvers.shift();
        if (resolver) {
            resolver({
                value: message,
                done: false,
            });
            return;
        }

        this.items.push(message);
    }

    close() {
        this.closed = true;
        for (const resolver of this.resolvers.splice(0)) {
            resolver({
                value: undefined,
                done: true,
            });
        }
    }

    [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage, undefined> {
        return {next: () => {
            const nextItem = this.items.shift();
            if (nextItem) {
                return Promise.resolve({
                    value: nextItem,
                    done: false,
                });
            }
            if (this.closed) {
                return Promise.resolve({
                    value: undefined,
                    done: true,
                });
            }
            return new Promise<IteratorResult<SDKUserMessage, undefined>>(resolve => this.resolvers.push(resolve));
        }};
    }
}

const CLAUDE_RESOLVED_MODEL_PATTERN = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:\[[^\]]*\])?$/u;

// SDK display names are bare families ("Opus", "Opus (1M context)"); the
// resolved model id carries the version, so a new release labels itself.
function labelClaudeSdkModel(id: string, resolvedModel: string, displayName: string) {
    const qualifier = /\s(\([^)]*\))$/u.exec(displayName)?.[1];
    const match = CLAUDE_RESOLVED_MODEL_PATTERN.exec(resolvedModel);
    if (!match) {
        return {short: displayName || id, full: displayName || id};
    }
    const [
        , family = '',
        major = '',
        minor,
    ] = match;
    const name = `${family.slice(0, 1).toUpperCase()}${family.slice(1)} ${minor === undefined ? major : `${major}.${minor}`}`;
    const short = qualifier ? `${name} ${qualifier}` : name;
    return {short, full: `Claude ${short}`};
}

function normalizeClaudeSdkModelInfo(rawModel: unknown): IAgentAssistantModelOption | null {
    if (!isRecord(rawModel)) {
        return null;
    }

    const id = typeof rawModel.value === 'string' ? rawModel.value.trim() : '';
    if (!id) {
        return null;
    }

    const resolvedModel = typeof rawModel.resolvedModel === 'string' ? rawModel.resolvedModel.trim() : '';
    const displayName = typeof rawModel.displayName === 'string' ? rawModel.displayName.trim() : '';
    const label = labelClaudeSdkModel(id, resolvedModel, displayName);
    // The resolved id names the version; an alias such as `opus` would name whichever release the catalog lists.
    const known = describeManifestModel('claude', [resolvedModel || id]);
    const supportedEfforts = rawModel.supportsEffort !== false && Array.isArray(rawModel.supportedEffortLevels)
        ? createAssistantEffortOptions(rawModel.supportedEffortLevels.flatMap(value => {
            const effort = normalizeAssistantEffortId(value);
            return effort ? [effort] : [];
        }), known?.defaultEffort ?? null)
        : undefined;
    return {
        id,
        // "Claude Opus 5.5", as in T3 Code's catalog; the trigger keeps "Opus 5.5".
        label: label.full,
        shortLabel: label.short,
        ...(known?.isLegacy ? {isLegacy: true} : {}),
        ...(resolvedModel ? {resolvedModel} : {}),
        ...(supportedEfforts ? {reasoningEfforts: supportedEfforts} : {}),
        ...(rawModel.supportsFastMode === true ? {serviceTiers: [{id: 'fast', label: 'Fast'}]} : {}),
    };
}

/**
 * Adapted from T3 Code ClaudeModelCatalog.ts claudeReportedModels (0b6f482dc5), MIT:
 * `default` is Claude Code's pointer at its own default model, not a model, so
 * it marks the model it resolves to instead of listing that model twice.
 */
export function normalizeClaudeSdkModelList(rawModels: unknown): IAgentAssistantModelOption[] {
    if (!Array.isArray(rawModels)) {
        return [];
    }

    const seen = new Set<string>();
    const models: IAgentAssistantModelOption[] = [];
    let pointer: IAgentAssistantModelOption | null = null;
    for (const rawModel of rawModels) {
        const model = normalizeClaudeSdkModelInfo(rawModel);
        if (!model || seen.has(model.id)) {
            continue;
        }
        seen.add(model.id);
        if (model.id === 'default') {
            pointer = model;
            continue;
        }
        models.push(model);
    }
    if (pointer) {
        const target = pointer.resolvedModel ? models.find(model => model.resolvedModel === pointer.resolvedModel) : undefined;
        if (target) {target.isDefault = true;}
        else {models.unshift({...pointer, isDefault: true});}
    }
    return models;
}

// Ask only for metadata. The empty prompt queue never submits a model turn.
export async function discoverClaudeAssistantModels(
    cwd: string,
    executablePath: string | null,
    env: NodeJS.ProcessEnv,
    extraArgs: Record<string, string | null> = {},
    budgetMs = CLAUDE_METADATA_TIMEOUT_MS,
) {
    if (!executablePath) {throw new Error(te('dialogs.agentAssistant.claudeMissing'));}
    const prompts = new ClaudePromptQueue();
    const metadata = query({
        prompt: prompts,
        options: {
            cwd,
            env,
            extraArgs,
            pathToClaudeCodeExecutable: resolveClaudeSdkExecutablePath(executablePath),
            tools: [],
            mcpServers: {},
            strictMcpConfig: true,
            settingSources: [],
            persistSession: false,
            permissionMode: 'dontAsk',
        },
    });
    try {
        // Adapted from T3 Code ClaudeProvider.ts (0b6f482dc5), MIT:
        // initializationResult uses a never-yielding prompt, with no inference.
        const initialization = await waitForBoundedOperation(metadata.initializationResult(), {
            timeoutMs: budgetMs,
            timeoutError: () => new Error(te('dialogs.agentAssistant.statusTimeout', {
                provider: 'Claude',
                seconds: CLAUDE_METADATA_TIMEOUT_MS / 1000,
            })),
        });
        return {
            models: normalizeClaudeSdkModelList(initialization.models),
            account: initialization.account ?? null,
        };
    } finally {
        prompts.close();
        metadata.close();
    }
}

function extractDataUrlBase64(dataUrl: string) {
    const commaIndex = dataUrl.indexOf(',');
    return commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : '';
}

function normalizeClaudeImageMimeType(mimeType: string): TClaudeImageMimeType {
    const normalized = mimeType.toLowerCase();
    if (
        normalized === 'image/jpeg'
        || normalized === 'image/png'
        || normalized === 'image/gif'
        || normalized === 'image/webp'
    ) {
        return normalized;
    }

    throw new Error('Claude Assistant accepts PNG, JPEG, GIF, or WebP images.');
}

function buildClaudeUserMessage(
    text: string,
    attachments: IAgentAssistantImageAttachment[],
): SDKUserMessage {
    const content = [
        {
            type: 'text' as const,
            text: text || ASSISTANT_IMAGE_ONLY_PROMPT,
        },
        ...attachments.map(attachment => ({
            type: 'image' as const,
            source: {
                type: 'base64' as const,
                media_type: normalizeClaudeImageMimeType(attachment.mimeType),
                data: extractDataUrlBase64(attachment.dataUrl),
            },
        })),
    ];
    return {
        type: 'user',
        parent_tool_use_id: null,
        message: {
            role: 'user',
            content,
        },
    };
}

function extractThinkingDelta(message: SDKPartialAssistantMessage) {
    const event = message.event;
    if (!isRecord(event) || event.type !== 'content_block_delta' || !isRecord(event.delta)) {
        return '';
    }
    return event.delta.type === 'thinking_delta' && typeof event.delta.thinking === 'string'
        ? event.delta.thinking
        : '';
}

function getResultErrorsText(message: SDKResultMessage) {
    return 'errors' in message && Array.isArray(message.errors)
        ? message.errors.join(' ').toLowerCase()
        : '';
}

function isInterruptedResult(message: SDKResultMessage) {
    if (message.subtype === 'success') {
        return false;
    }

    const errors = getResultErrorsText(message);
    if (errors.includes('interrupt')) {
        return true;
    }

    return (
        message.subtype === 'error_during_execution'
        && message.is_error === false
        && (
            errors.includes('request was aborted')
            || errors.includes('interrupted by user')
            || errors.includes('aborted')
        )
    );
}

function isInterruptedErrorMessage(text: string) {
    const normalized = text.toLowerCase();
    return (
        normalized.includes('request was aborted')
        || normalized.includes('interrupted by user')
        || normalized.includes('aborted')
        || normalized.includes('aborterror')
    );
}

function getResultErrorMessage(message: SDKResultMessage) {
    if (message.subtype === 'success' && message.is_error === false) {
        return null;
    }

    if (isInterruptedResult(message)) {
        return null;
    }

    const result = 'result' in message && typeof message.result === 'string' ? message.result.trim() : '';
    if (result) {
        return result;
    }

    if ('errors' in message && message.errors.length) {return message.errors.join('\n');}

    const apiErrorStatus = 'api_error_status' in message && message.api_error_status
        ? ` (${message.api_error_status})`
        : '';
    return `Claude assistant turn failed${apiErrorStatus}.`;
}

function normalizeClaudeAccount(account: AccountInfo | null): AccountInfo | null {
    if (!account) {
        return null;
    }

    return {
        ...(account.email ? { email: account.email } : {}),
        ...(account.organization ? { organization: account.organization } : {}),
        ...(account.subscriptionType ? { subscriptionType: account.subscriptionType } : {}),
        ...(account.tokenSource ? { tokenSource: account.tokenSource } : {}),
        ...(account.apiKeySource ? { apiKeySource: account.apiKeySource } : {}),
        ...(account.apiProvider ? { apiProvider: account.apiProvider } : {}),
    };
}

function toClaudeEffortLevel(effort: TAgentAssistantEffort): EffortLevel {
    return isOneOf(ASSISTANT_KNOWN_EFFORTS, effort)
        ? CLAUDE_EFFORT_LEVEL_BY_ASSISTANT_EFFORT[effort]
        : 'low';
}

export class ClaudeAgentAssistantSession {
    private promptQueue: ClaudePromptQueue | null = null;
    private query: Query | null = null;
    private consumeStreamPromise: Promise<void> | null = null;
    private retirementPromise: Promise<void> | null = null;
    private closing = false;
    private interrupting = false;
    private currentTurnId: string | null = null;
    private currentModel: string;
    private readonly currentEffort: EffortLevel | undefined;
    private readonly currentSpeedMode: TAgentAssistantSpeedMode;
    private readonly queryFastMode: boolean;
    private startupGeneration = 0;
    private sessionId: string | null = null;
    private account: AccountInfo | null = null;
    private modelOptions: readonly IAgentAssistantModelOption[] | null = null;
    private toolCount = 0;
    private readonly activeToolNames = new Map<string, string>();

    constructor(private readonly options: IClaudeAgentAssistantSessionOptions) {
        this.currentModel = options.model;
        this.currentEffort = this.compileEffort(options.model, options.effort);
        this.currentSpeedMode = options.speedMode;
        this.queryFastMode = this.supportsFastMode(this.currentModel, this.currentSpeedMode);
    }

    private compileEffort(model: string, effort: TAgentAssistantEffort, models = this.options.modelOptions) {
        return models?.find(option => option.id === model)?.reasoningEfforts?.some(option => option.id === effort)
            ? toClaudeEffortLevel(effort) : undefined;
    }

    // Adapted from T3 Code claudeModelOptions.ts (0b6f482dc5), MIT.
    // Compile only options the selected setup reported, without a manifest union.
    private supportsFastMode(model: string, speed: TAgentAssistantSpeedMode, models = this.options.modelOptions) {
        return speed === 'fast' && models?.find(option => option.id === model)?.serviceTiers?.some(tier => tier.id === 'fast') === true;
    }

    get model() {
        return this.currentModel;
    }

    get effort() {
        return this.currentEffort;
    }

    get speedMode() {
        return this.currentSpeedMode;
    }

    get fastMode() {
        return this.queryFastMode;
    }

    get isUsable() {
        return this.query !== null
            && this.promptQueue !== null
            && this.consumeStreamPromise !== null
            && !this.closing
            && !this.interrupting;
    }

    get isRetiring() {
        return this.retirementPromise !== null;
    }

    async prepareForSettings(model: string, effort: TAgentAssistantEffort, speedMode: TAgentAssistantSpeedMode, models = this.options.modelOptions) {
        if (this.isRetiring) {
            throw new Error('Claude is still retiring the previous turn. Try sending again after cancellation finishes.');
        }
        // setModel can change a live query's model, but effort and Fast are
        // fixed at query creation. Reuse only a compatible SDK query.
        if (this.isUsable && this.effort === this.compileEffort(model, effort, models) && this.fastMode === this.supportsFastMode(model, speedMode, models)) {
            return true;
        }
        if (!(await this.retire('for settings change'))) {
            throw new Error('Claude is still retiring the previous session. Try again after cleanup finishes.');
        }
        return false;
    }

    async retire(reason: string) {
        await waitForClaudeInterrupt(this.close()).catch((error: unknown) => {
            logger.warn(`Failed to close Claude assistant session ${reason}: ${sanitizeAssistantProviderText(getErrorMessage(error))}`);
        });
        return !this.isRetiring;
    }

    async sendMessage(
        text: string,
        attachments: IAgentAssistantImageAttachment[],
        model: string,
    ) {
        const startupGeneration = this.startupGeneration;
        if (this.retirementPromise) {
            throw new Error('Claude assistant session is still retiring a previous turn.');
        }
        await this.ensureStarted();
        await this.setModel(model);
        if (
            this.closing
            || this.interrupting
            || startupGeneration !== this.startupGeneration
        ) {
            throw new Error('Claude assistant session is closed.');
        }
        const promptQueue = this.promptQueue;
        if (!promptQueue) {
            throw new Error('Claude assistant query is unavailable.');
        }
        const turnId = randomUUID();
        this.currentTurnId = turnId;
        this.options.callbacks.onTurnStarted(turnId);
        promptQueue.push(buildClaudeUserMessage(text, attachments));
        return turnId;
    }

    async interrupt() {
        if (this.retirementPromise) {
            await this.retirementPromise;
            return;
        }

        if (!this.query || !this.currentTurnId) {
            this.startupGeneration += 1;
            return;
        }

        const queryToRetire = this.query;
        const streamToRetire = this.consumeStreamPromise;
        this.interrupting = true;
        this.query = null;
        this.promptQueue?.close();
        this.promptQueue = null;
        const turnId = this.currentTurnId;
        this.currentTurnId = null;
        this.activeToolNames.clear();
        const retirement = (async () => {
            try {
                // The SDK's interrupt request has no deadline of its own.
                await waitForClaudeInterrupt(queryToRetire.interrupt());
            } catch (error) {
                logger.warn(`Failed to interrupt Claude assistant turn: ${sanitizeAssistantProviderText(getErrorMessage(error))}`);
            } finally {
                try {
                    queryToRetire.close();
                } catch (error) {
                    logger.warn(`Failed to close retired Claude assistant query: ${sanitizeAssistantProviderText(getErrorMessage(error))}`);
                }
                await waitForClaudeInterrupt(streamToRetire ?? Promise.resolve()).catch((error: unknown) => {
                    logger.warn(`Retired Claude assistant stream did not end: ${sanitizeAssistantProviderText(getErrorMessage(error))}`);
                });
                this.options.callbacks.onTurnCompleted(turnId);
                this.interrupting = false;
            }
        })();
        const retirementPromise = retirement.finally(() => {
            if (this.retirementPromise === retirementPromise) {
                this.retirementPromise = null;
            }
        });
        this.retirementPromise = retirementPromise;
        await retirementPromise;
    }

    close(): Promise<void> {
        if (this.retirementPromise) {
            return this.retirementPromise;
        }

        this.startupGeneration += 1;
        this.closing = true;
        this.promptQueue?.close();
        this.promptQueue = null;
        try {
            this.query?.close();
        } catch (error) {
            logger.warn(`Failed to close Claude assistant session: ${sanitizeAssistantProviderText(getErrorMessage(error))}`);
        }
        const retirement = this.consumeStreamPromise ?? Promise.resolve();
        const retirementPromise = retirement.finally(() => {
            if (this.retirementPromise === retirementPromise) {
                this.retirementPromise = null;
            }
        });
        this.retirementPromise = retirementPromise;
        return retirementPromise;
    }

    private async ensureStarted() {
        if (this.query) {
            return;
        }
        if (this.closing || this.interrupting) {
            throw new Error('Claude assistant session is closed.');
        }

        const resumeSessionId = this.options.resumeSessionId?.trim() ?? '';
        const startupGeneration = this.startupGeneration;
        const isStartupCanceled = () => this.closing
            || this.interrupting
            || startupGeneration !== this.startupGeneration;
        if (resumeSessionId) {
            const exists = await hasClaudeSessionTranscript(this.options.env, resumeSessionId);
            if (isStartupCanceled()) {
                throw new Error('Claude assistant session is closed.');
            }
            if (!exists) {
                throw new Error(createClaudeContextUnavailableError());
            }
        }

        const allowedMcpTools = ASSISTANT_MCP_TOOLS.map(tool => `mcp__${this.options.mcpServerName}__${tool}`);
        const canUseTool = ((toolName) => {
            if (allowedMcpTools.includes(toolName)) {
                return Promise.resolve({ behavior: 'allow' });
            }
            return Promise.resolve({
                behavior: 'deny',
                message: 'EVB Assistant may only use EVB Viewer MCP tools.',
            });
        }) satisfies CanUseTool;
        if (isStartupCanceled()) {
            throw new Error('Claude assistant session is closed.');
        }
        if (!this.options.executablePath) {throw new Error(te('dialogs.agentAssistant.claudeMissing'));}
        const promptQueue = new ClaudePromptQueue();
        const claudeQuery = query({
            prompt: promptQueue,
            options: {
                cwd: this.options.cwd,
                model: this.currentModel,
                ...(this.currentEffort ? {effort: this.currentEffort} : {}),
                ...(this.queryFastMode ? { settings: { fastMode: true } } : {}),
                pathToClaudeCodeExecutable: resolveClaudeSdkExecutablePath(this.options.executablePath),
                ...(this.options.extraArgs ? { extraArgs: this.options.extraArgs } : {}),
                ...(resumeSessionId ? { resume: resumeSessionId } : {}),
                env: {
                    ...this.options.env,
                    CLAUDE_AGENT_SDK_CLIENT_APP: `evb-viewer/${app.getVersion()}`,
                    [ASSISTANT_MCP_TOKEN_ENV]: this.options.mcpToken,
                    NO_COLOR: '1',
                },
                tools: [],
                allowedTools: [`mcp__${this.options.mcpServerName}__*`],
                mcpServers: {[this.options.mcpServerName]: {
                    type: 'http',
                    url: this.options.mcpServerUrl,
                    headers: { Authorization: `Bearer ${this.options.mcpToken}` },
                    timeout: ASSISTANT_MCP_TOOL_TIMEOUT_SECONDS * 1000,
                }},
                permissionMode: 'dontAsk',
                systemPrompt: {
                    type: 'preset',
                    preset: 'claude_code',
                    append: ASSISTANT_ROLE_PROMPT,
                },
                settingSources: [],
                includePartialMessages: true,
                // The provider-owned transcript is the only lossless way to carry
                // hidden preset instructions, assistant replies, tool history, and
                // images into a replacement query or a process restart.
                persistSession: true,
                strictMcpConfig: true,
                canUseTool,
                stderr: message => logger.info(`[sdk] ${sanitizeAssistantProviderText(message)}`),
            },
        });
        this.promptQueue = promptQueue;
        this.query = claudeQuery;
        const consumeStreamPromise = this.consumeStream(claudeQuery);
        this.consumeStreamPromise = consumeStreamPromise;
        void consumeStreamPromise.then(
            () => {
                if (this.consumeStreamPromise === consumeStreamPromise) {
                    this.consumeStreamPromise = null;
                }
            },
            () => {
                if (this.consumeStreamPromise === consumeStreamPromise) {
                    this.consumeStreamPromise = null;
                }
            },
        );
        void this.refreshAccountInfo();
        void this.refreshModelInfo();
    }

    private async setModel(model: string) {
        const normalized = model.trim();
        if (normalized === this.currentModel) {
            return;
        }

        if (this.query) {
            // The SDK's control request has no deadline of its own; a send must not wait forever.
            await waitForBoundedOperation(this.query.setModel(normalized), {
                timeoutMs: CLAUDE_CONTROL_TIMEOUT_MS,
                timeoutError: () => new Error(te('dialogs.agentAssistant.claudeModelChangeTimeout', {seconds: CLAUDE_CONTROL_TIMEOUT_MS / 1000})),
            });
        }
        this.currentModel = normalized;
    }

    private async refreshAccountInfo() {
        if (!this.query) {
            return;
        }

        try {
            this.account = normalizeClaudeAccount(await this.query.accountInfo());
            this.publishInitialized();
        } catch (error) {
            logger.warn(`Failed to read Claude account info: ${sanitizeAssistantProviderText(getErrorMessage(error))}`);
        }
    }

    private async refreshModelInfo() {
        if (!this.query) {
            return;
        }

        try {
            const models = normalizeClaudeSdkModelList(await this.query.supportedModels());
            if (models.length > 0) {
                this.modelOptions = models;
                this.publishInitialized();
            }
        } catch (error) {
            logger.warn(`Failed to read Claude model list: ${sanitizeAssistantProviderText(getErrorMessage(error))}`);
        }
    }

    private async consumeStream(queryToConsume: Query) {
        try {
            for await (const message of queryToConsume) {
                this.handleMessage(message, queryToConsume);
            }

            if (!this.closing && !this.interrupting) {
                this.retireUnexpectedQuery(queryToConsume, 'Claude assistant session ended.');
            }
        } catch (error) {
            if (this.closing || this.interrupting || isInterruptedErrorMessage(getErrorMessage(error))) {
                this.completeTurn();
                return;
            }
            this.retireUnexpectedQuery(queryToConsume, error);
        }
    }

    private handleMessage(message: SDKMessage, queryToConsume: Query) {
        if (this.query !== queryToConsume) {
            return;
        }

        if (message.type === 'system' && message.subtype === 'init') {
            this.handleInitMessage(message);
            return;
        }

        if (!this.currentTurnId) {return;}

        if (message.type === 'stream_event') {
            const thinkingDelta = extractThinkingDelta(message);
            if (thinkingDelta) {
                this.options.callbacks.onReasoningDelta(this.currentTurnId, thinkingDelta);
            }
            return;
        }

        if (message.type === 'tool_progress' && this.activeToolNames.has(message.tool_use_id)) {
            this.options.callbacks.onToolActivity(this.currentTurnId, {
                toolId: message.tool_use_id,
                name: this.activeToolNames.get(message.tool_use_id) ?? message.tool_name,
                phase: 'running',
            });
            return;
        }

        if (message.type === 'assistant' || message.type === 'user') {
            for (const item of extractClaudeMessageItems(message)) {
                if ('text' in item) {
                    // T3 emitAssistantTextArtifacts: a completed SDK snapshot is one completed item.
                    this.options.callbacks.onAssistantMessage(this.currentTurnId, item.messageId, item.text);
                } else {
                    // T3 settleToolCall: correlate and remove only this native call.
                    const name = this.activeToolNames.get(item.toolId) ?? item.name;
                    if (item.phase === 'running') {this.activeToolNames.set(item.toolId, name);}
                    else if (!this.activeToolNames.delete(item.toolId)) {continue;}
                    this.options.callbacks.onToolActivity(this.currentTurnId, {...item, name});
                }
            }
            return;
        }

        if (message.type === 'result') {
            this.options.callbacks.onUsage(this.currentTurnId, extractClaudeTokenUsage(message));
            const error = getResultErrorMessage(message);
            if (error) {
                // Adapted from T3 Code ClaudeAdapterV2 providerFailureFromResult (0b6f482dc5), MIT.
                const status = 'api_error_status' in message ? message.api_error_status : undefined;
                this.retireUnexpectedQuery(queryToConsume, typeof status === 'number'
                    ? {message: error, status, code: `api_error_${status}`} : error);
                return;
            }
            this.completeTurn();
        }
    }

    private retireUnexpectedQuery(queryToRetire: Query, error: unknown) {
        if (this.query !== queryToRetire) {
            return;
        }

        const failedTurnId = this.currentTurnId;
        this.query = null;
        this.promptQueue?.close();
        this.promptQueue = null;
        this.currentTurnId = null;
        this.activeToolNames.clear();
        try {
            queryToRetire.close();
        } catch (closeError) {
            logger.warn(`Failed to close unusable Claude assistant query: ${sanitizeAssistantProviderText(getErrorMessage(closeError))}`);
        }
        this.options.callbacks.onError(failedTurnId, error);
    }

    private handleInitMessage(message: SDKSystemMessage) {
        this.sessionId = message.session_id;
        if (message.model) {
            this.currentModel = message.model;
        }
        this.toolCount = message.tools.filter(tool => tool.startsWith(`mcp__${this.options.mcpServerName}__`)).length;
        this.publishInitialized();
    }

    private publishInitialized() {
        if (this.closing || this.interrupting) {
            return;
        }
        this.options.callbacks.onInitialized({
            sessionId: this.sessionId,
            model: this.currentModel,
            toolCount: this.toolCount,
            account: this.account,
            ...(this.modelOptions ? {models: this.modelOptions} : {}),
        });
    }

    private completeTurn() {
        if (!this.currentTurnId) {
            return;
        }

        const turnId = this.currentTurnId;
        this.currentTurnId = null;
        this.activeToolNames.clear();
        this.options.callbacks.onTurnCompleted(turnId);
    }
}
