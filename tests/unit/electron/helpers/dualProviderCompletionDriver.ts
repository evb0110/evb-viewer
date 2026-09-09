import type {
    IAgentAssistantChatScope,
    IAgentAssistantSendMessageRequest,
    IAgentAssistantSendMessageResult,
} from '@contracts/agent';
import type {IClaudeAgentAssistantSessionOptions} from '@electron/features/agent/claudeAgentSdkAssistant';

export class FakeClaudeAssistantSession {
    readonly effort: IClaudeAgentAssistantSessionOptions['effort'];
    readonly fastMode = false;
    readonly callbacks: IClaudeAgentAssistantSessionOptions['callbacks'];
    readonly completedMessages: string[] = [];

    constructor(options: IClaudeAgentAssistantSessionOptions) {
        this.effort = options.effort;
        this.callbacks = options.callbacks;
        this.callbacks.onInitialized({
            sessionId: 'claude-session-1',
            model: options.model,
            toolCount: 0,
            account: null,
        });
    }

    async sendMessage(text: string) {
        const turnId = 'claude-turn-1';
        const messageId = 'claude-message-1';
        const answer = `Claude completed: ${text}`;
        this.callbacks.onTurnStarted(turnId);
        this.callbacks.onAssistantDelta(turnId, messageId, 'Claude ');
        this.callbacks.onAssistantMessage(turnId, messageId, answer, false);
        this.callbacks.onTurnCompleted(turnId);
        this.completedMessages.push(answer);
        return turnId;
    }

    async interrupt() {}

    async close() {}
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
