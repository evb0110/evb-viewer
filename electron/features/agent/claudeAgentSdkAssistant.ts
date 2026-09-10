import {randomUUID} from 'node:crypto';
import {app} from 'electron';
import {
    query,
    type AccountInfo,
    type CanUseTool,
    type EffortLevel,
    type Query,
    type SDKAssistantMessage,
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
import { ASSISTANT_KNOWN_EFFORTS } from '@contracts/agent';
import {
    isOneOf,
    isRecord,
} from '@contracts/runtimeGuards';
import {
    ASSISTANT_IMAGE_ONLY_PROMPT,
    ASSISTANT_MCP_TOOLS,
    ASSISTANT_MCP_TOKEN_ENV,
    ASSISTANT_MCP_TOOL_TIMEOUT_SECONDS,
    ASSISTANT_ROLE_PROMPT,
} from '@electron/features/agent/codexAssistantConfig';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';
import {
    extractAssistantToolUses,
    extractClaudeTokenUsage,
    type IClaudeAssistantToolActivity,
} from '@electron/features/agent/claudeAssistantStreamPresentation';

import {
    getClaudeAssistantModelLabel,
    normalizeClaudeAssistantModel,
    shouldUseClaudeAssistantFastMode,
} from '@electron/features/agent/claudeProviderMetadata';
const logger = createLogger('agent-claude-assistant');
const CLAUDE_EFFORT_LEVEL_BY_ASSISTANT_EFFORT = {
    low: 'low',
    medium: 'medium',
    high: 'high',
    xhigh: 'xhigh',
    max: 'max',
} as const satisfies Record<TAgentAssistantKnownEffort, EffortLevel>;
type TClaudeImageMimeType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

export function shouldRefuseClaudeContextContinuation(messageCount: number, providerThreadId: string | null) {
    return messageCount > 0 && !providerThreadId;
}

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
    onAssistantDelta(turnId: string | null, messageId: string, delta: string): void;
    onReasoningDelta(turnId: string | null, delta: string): void;
    onToolActivity(turnId: string | null, activity: IClaudeAssistantToolActivity): void;
    onUsage(turnId: string | null, usage: IAgentAssistantTokenUsage): void;
    onAssistantMessage(turnId: string | null, messageId: string, text: string, pending: boolean): void;
    onTurnCompleted(turnId: string | null): void;
    onError(turnId: string | null, message: string): void;
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
    callbacks: IClaudeAgentAssistantCallbacks;
}

class ClaudePromptQueue implements AsyncIterable<SDKUserMessage> {
    private readonly items: SDKUserMessage[] = [];
    private readonly resolvers: Array<(value: IteratorResult<SDKUserMessage>) => void> = [];
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
                value: undefined as never,
                done: true,
            });
        }
    }

    [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
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
                    value: undefined as never,
                    done: true,
                });
            }
            return new Promise<IteratorResult<SDKUserMessage>>(resolve => this.resolvers.push(resolve));
        }};
    }
}

function getClaudeSdkModel(model: string) {
    return normalizeClaudeAssistantModel(model);
}

function normalizeClaudeSdkModelInfo(rawModel: unknown): IAgentAssistantModelOption | null {
    if (!isRecord(rawModel)) {
        return null;
    }

    const id = typeof rawModel.value === 'string' ? rawModel.value.trim() : '';
    if (!id) {
        return null;
    }

    const label = typeof rawModel.displayName === 'string' && rawModel.displayName.trim()
        ? rawModel.displayName.trim()
        : getClaudeAssistantModelLabel(id);
    return {
        id,
        label,
    };
}

export function normalizeClaudeSdkModelList(rawModels: unknown): IAgentAssistantModelOption[] {
    if (!Array.isArray(rawModels)) {
        return [];
    }

    const seen = new Set<string>();
    const models: IAgentAssistantModelOption[] = [];
    for (const rawModel of rawModels) {
        const model = normalizeClaudeSdkModelInfo(rawModel);
        if (!model || seen.has(model.id)) {
            continue;
        }
        seen.add(model.id);
        models.push(model);
    }
    return models;
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

function extractAssistantText(message: SDKAssistantMessage) {
    const content = message.message.content;
    if (!Array.isArray(content)) {
        return '';
    }

    return content
        .flatMap((block) => (
            isRecord(block) && block.type === 'text' && typeof block.text === 'string'
                ? [block.text]
                : []
        ))
        .join('\n\n');
}

function extractTextDelta(message: SDKPartialAssistantMessage) {
    const event = message.event;
    if (!isRecord(event) || event.type !== 'content_block_delta' || !isRecord(event.delta)) {
        return '';
    }
    return event.delta.type === 'text_delta' && typeof event.delta.text === 'string'
        ? event.delta.text
        : '';
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
    private currentAssistantMessageId: string | null = null;
    private currentModel: string;
    private readonly currentEffort: EffortLevel;
    private readonly currentSpeedMode: TAgentAssistantSpeedMode;
    private readonly queryFastMode: boolean;
    private sessionId: string | null = null;
    private account: AccountInfo | null = null;
    private modelOptions: readonly IAgentAssistantModelOption[] | null = null;
    private toolCount = 0;
    private readonly activeToolNames = new Map<string, string>();

    constructor(private readonly options: IClaudeAgentAssistantSessionOptions) {
        this.currentModel = normalizeClaudeAssistantModel(options.model);
        this.currentEffort = toClaudeEffortLevel(options.effort);
        this.currentSpeedMode = options.speedMode;
        this.queryFastMode = shouldUseClaudeAssistantFastMode(this.currentModel, this.currentSpeedMode);
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

    async sendMessage(
        text: string,
        attachments: IAgentAssistantImageAttachment[],
        model: string,
    ) {
        if (this.retirementPromise) {
            throw new Error('Claude assistant session is still retiring a previous turn.');
        }
        this.ensureStarted();
        await this.setModel(model);
        const promptQueue = this.promptQueue;
        if (!promptQueue) {
            throw new Error('Claude assistant query is unavailable.');
        }
        const turnId = randomUUID();
        this.currentTurnId = turnId;
        this.currentAssistantMessageId = randomUUID();
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
        this.currentAssistantMessageId = null;
        const retirement = (async () => {
            try {
                await queryToRetire.interrupt();
            } catch (error) {
                logger.warn(`Failed to interrupt Claude assistant turn: ${getErrorMessage(error)}`);
            } finally {
                try {
                    queryToRetire.close();
                } catch (error) {
                    logger.warn(`Failed to close retired Claude assistant query: ${getErrorMessage(error)}`);
                }
                await streamToRetire;
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

        this.closing = true;
        this.promptQueue?.close();
        this.promptQueue = null;
        try {
            this.query?.close();
        } catch (error) {
            logger.warn(`Failed to close Claude assistant session: ${getErrorMessage(error)}`);
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

    private ensureStarted() {
        if (this.query) {
            return;
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
        const sdkModel = getClaudeSdkModel(this.currentModel);
        const promptQueue = new ClaudePromptQueue();
        const claudeQuery = query({
            prompt: promptQueue,
            options: {
                cwd: this.options.cwd,
                ...(sdkModel ? { model: sdkModel } : {}),
                effort: this.currentEffort,
                ...(this.queryFastMode ? { settings: { fastMode: true } } : {}),
                ...(this.options.executablePath ? { pathToClaudeCodeExecutable: this.options.executablePath } : {}),
                ...(this.options.resumeSessionId ? { resume: this.options.resumeSessionId } : {}),
                env: {
                    ...process.env,
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
                stderr: message => logger.info(`[sdk] ${message.trim()}`),
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
        const normalized = normalizeClaudeAssistantModel(model);
        if (normalized === this.currentModel) {
            return;
        }

        if (this.query) {
            await this.query.setModel(getClaudeSdkModel(normalized));
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
            logger.warn(`Failed to read Claude account info: ${getErrorMessage(error)}`);
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
            logger.warn(`Failed to read Claude model list: ${getErrorMessage(error)}`);
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
            this.retireUnexpectedQuery(queryToConsume, getErrorMessage(error));
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

        if (message.type === 'stream_event') {
            const thinkingDelta = extractThinkingDelta(message);
            if (thinkingDelta) {
                this.options.callbacks.onReasoningDelta(this.currentTurnId, thinkingDelta);
            }
            const delta = extractTextDelta(message);
            if (delta && this.currentAssistantMessageId) {
                this.options.callbacks.onAssistantDelta(this.currentTurnId, this.currentAssistantMessageId, delta);
            }
            return;
        }

        if (message.type === 'tool_progress') {
            this.activeToolNames.set(message.tool_use_id, message.tool_name);
            this.options.callbacks.onToolActivity(this.currentTurnId, {
                toolId: message.tool_use_id,
                name: message.tool_name,
                phase: 'running',
            });
            return;
        }

        if (message.type === 'tool_use_summary') {
            for (const toolId of message.preceding_tool_use_ids) {
                this.options.callbacks.onToolActivity(this.currentTurnId, {
                    toolId,
                    name: this.activeToolNames.get(toolId) ?? 'tool',
                    phase: 'completed',
                });
                this.activeToolNames.delete(toolId);
            }
            return;
        }

        if (message.type === 'assistant') {
            for (const activity of extractAssistantToolUses(message)) {
                this.activeToolNames.set(activity.toolId, activity.name);
                this.options.callbacks.onToolActivity(this.currentTurnId, activity);
            }
            const text = extractAssistantText(message);
            if (text && this.currentAssistantMessageId) {
                this.options.callbacks.onAssistantMessage(this.currentTurnId, this.currentAssistantMessageId, text, true);
            }
            return;
        }

        if (message.type === 'result') {
            const failed = getResultErrorMessage(message) !== null;
            for (const [
                toolId,
                name,
            ] of this.activeToolNames) {
                this.options.callbacks.onToolActivity(this.currentTurnId, {
                    toolId,
                    name,
                    phase: failed ? 'failed' : 'completed',
                });
            }
            this.activeToolNames.clear();
            this.options.callbacks.onUsage(this.currentTurnId, extractClaudeTokenUsage(message));
            const error = getResultErrorMessage(message);
            if (error) {
                this.retireUnexpectedQuery(queryToConsume, error);
                return;
            }
            this.completeTurn();
        }
    }

    private retireUnexpectedQuery(queryToRetire: Query, error: string) {
        if (this.query !== queryToRetire) {
            return;
        }

        const failedTurnId = this.currentTurnId;
        this.query = null;
        this.promptQueue?.close();
        this.promptQueue = null;
        this.currentTurnId = null;
        this.currentAssistantMessageId = null;
        this.activeToolNames.clear();
        try {
            queryToRetire.close();
        } catch (closeError) {
            logger.warn(`Failed to close unusable Claude assistant query: ${getErrorMessage(closeError)}`);
        }
        this.options.callbacks.onError(failedTurnId, error);
    }

    private handleInitMessage(message: SDKSystemMessage) {
        this.sessionId = message.session_id;
        if (message.model) {
            this.currentModel = normalizeClaudeAssistantModel(message.model);
        }
        this.toolCount = message.tools.filter(tool => tool.startsWith(`mcp__${this.options.mcpServerName}__`)).length;
        this.publishInitialized();
    }

    private publishInitialized() {
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
        this.currentAssistantMessageId = null;
        this.options.callbacks.onTurnCompleted(turnId);
    }
}
