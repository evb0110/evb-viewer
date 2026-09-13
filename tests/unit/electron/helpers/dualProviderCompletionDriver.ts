import type {
    IAgentAssistantChatScope,
    IAgentAssistantImageAttachment,
    IAgentAssistantSendMessageRequest,
    IAgentAssistantSendMessageResult,
} from '@contracts/agent';
import type {IClaudeAgentAssistantSessionOptions} from '@electron/features/agent/claudeAgentSdkAssistant';
import {shouldUseClaudeAssistantFastMode} from '@electron/features/agent/claudeProviderMetadata';

export class FakeClaudeAssistantSession {
    private static nextSessionNumber = 0;

    private readonly sessionNumber = ++FakeClaudeAssistantSession.nextSessionNumber;
    private readonly sendGate: Promise<void> | null;
    private closed = false;
    readonly effort: IClaudeAgentAssistantSessionOptions['effort'];
    readonly fastMode: boolean;
    readonly isRetiring = false;
    readonly callbacks: IClaudeAgentAssistantSessionOptions['callbacks'];
    readonly completedMessages: string[] = [];
    readonly sentTexts: string[] = [];
    readonly sentAttachments: IAgentAssistantImageAttachment[][] = [];

    constructor(
        options: IClaudeAgentAssistantSessionOptions,
        sessionId: string | null = 'claude-session-1',
        sendGate: Promise<void> | null = null,
    ) {
        this.sendGate = sendGate;
        this.effort = options.effort;
        this.fastMode = shouldUseClaudeAssistantFastMode(options.model, options.speedMode);
        this.callbacks = options.callbacks;
        this.callbacks.onInitialized({
            sessionId,
            model: options.model,
            toolCount: 0,
            account: null,
        });
    }

    get isUsable() {
        return !this.closed;
    }

    async sendMessage(text: string, attachments: IAgentAssistantImageAttachment[] = []) {
        await this.sendGate;
        if (this.closed) {
            throw new Error('Claude assistant session is closed.');
        }
        this.sentTexts.push(text);
        this.sentAttachments.push(attachments.map(attachment => ({...attachment})));
        const turnId = `claude-turn-${this.sessionNumber}`;
        const messageId = `claude-message-${this.sessionNumber}`;
        const answer = `Claude completed: ${text}`;
        this.callbacks.onTurnStarted(turnId);
        this.callbacks.onAssistantDelta(turnId, messageId, 'Claude ');
        this.callbacks.onAssistantMessage(turnId, messageId, answer, false);
        this.callbacks.onTurnCompleted(turnId);
        this.completedMessages.push(answer);
        return turnId;
    }

    async interrupt() {}

    async close() {
        this.closed = true;
    }
}

export interface IDualProviderCompletionDriverOptions {
    startCodex(): {requestMethods: string[]};
    installClaudeSession(constructor: (options: IClaudeAgentAssistantSessionOptions) => FakeClaudeAssistantSession): void;
    resolveClaudeRuntime(): void;
    send(request: IAgentAssistantSendMessageRequest): Promise<IAgentAssistantSendMessageResult>;
    createScope(fileName: string): IAgentAssistantChatScope;
}

interface ICodexRequestProcess {
    requestMethods: string[];
    on(event: 'codex-request', listener: (method: string) => void): void;
    off(event: 'codex-request', listener: (method: string) => void): void;
}

export async function waitForCodexRequest(process: ICodexRequestProcess, method: string) {
    if (process.requestMethods.includes(method)) {
        return;
    }

    await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
            process.off('codex-request', onRequest);
            reject(new Error(`Timed out waiting for Codex request ${method}`));
        }, 5_000);
        function onRequest(candidate: string) {
            if (candidate !== method) {
                return;
            }
            clearTimeout(timeout);
            process.off('codex-request', onRequest);
            resolve();
        }

        process.on('codex-request', onRequest);
    });
}

export async function waitForCodexRequestCount(process: ICodexRequestProcess, method: string, count: number) {
    if (process.requestMethods.filter(candidate => candidate === method).length >= count) {
        return;
    }

    await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
            process.off('codex-request', onRequest);
            reject(new Error(`Timed out waiting for Codex request ${method} count ${count}`));
        }, 5_000);
        function onRequest(candidate: string) {
            if (candidate !== method) {
                return;
            }
            if (process.requestMethods.filter(requestMethod => requestMethod === method).length < count) {
                return;
            }
            clearTimeout(timeout);
            process.off('codex-request', onRequest);
            resolve();
        }

        process.on('codex-request', onRequest);
    });
}

export async function runDualProviderCompletionDriver(options: IDualProviderCompletionDriverOptions) {
    const codexProcess = options.startCodex();
    const claudeSessions: FakeClaudeAssistantSession[] = [];
    options.installClaudeSession(function createClaudeSession(sessionOptions) {
        const session = new FakeClaudeAssistantSession(sessionOptions);
        claudeSessions.push(session);
        return session;
    });

    const codexResult = await options.send({
        provider: 'codex',
        text: 'codex stream',
        scope: options.createScope('dual-provider-codex.pdf'),
    });

    options.resolveClaudeRuntime();
    const claudeResult = await options.send({
        provider: 'claude',
        text: 'claude completion',
        scope: options.createScope('dual-provider-claude.pdf'),
    });

    return {
        codexProcess,
        codexResult,
        claudeResult,
        claudeSessions,
    };
}
