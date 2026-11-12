import {shell} from 'electron';
import type {
    IAgentAssistantAccount,
    IAgentAssistantImageAttachment,
} from '@contracts/agent';
import {isRecord} from '@contracts/runtimeGuards';
import {
    CodexAppServerClient,
    type ICodexAppServerNotification,
} from '@electron/features/agent/codexAppServerClient';
import {
    ASSISTANT_IMAGE_ONLY_PROMPT,
    ASSISTANT_MCP_TOKEN_ENV,
    ASSISTANT_ROLE_PROMPT,
    createCodexIsolationArgs,
    readCodexMcpStatusPage,
    readCodexUserToolConfig,
    type ICodexUserToolConfig,
} from '@electron/features/agent/codexAssistantConfig';
import {
    normalizeCodexModelListResponse,
    type TCodexAssistantModelOption,
} from '@electron/features/agent/assistantModelCatalog';
import {normalizeCodexAssistantAccount} from '@electron/features/agent/normalizeCodexAssistantAccount';
import type {IAssistantLaunchContext} from '@electron/features/agent/assistantInstances';
import {te} from '@electron/te';
import {createLogger} from '@electron/utils/createLogger';
import {getErrorMessage} from '@electron/utils/error';

const logger = createLogger('assistant-codex');
const CODEX_CONTROL_TIMEOUT_MS = 10_000;
const CODEX_PROBE_BUDGET_MS = 15_000;
const CODEX_LOGIN_TIMEOUT_MS = 10 * 60_000;

export interface ICodexProbeResult {
    auth: 'authenticated' | 'unauthenticated' | 'unknown';
    account: IAgentAssistantAccount | null;
    models: TCodexAssistantModelOption[];
    /** Set when the probe got this far and then failed. */
    warning?: string;
}

export interface ICodexThreadListener {
    onNotification(method: string, params: Record<string, unknown>): void;
    onExit(message: string): void;
}

export interface ICodexTurnInput {
    threadId: string;
    text: string;
    attachments: readonly IAgentAssistantImageAttachment[];
    model: string;
    effort: string;
    serviceTier: string | null;
}

function decodeRecord(value: unknown) {
    return isRecord(value) ? value : null;
}

function withDeadline<T>(promise: Promise<T>, timeoutMs: number, message: string, onTimeout: () => void) {
    let timer: ReturnType<typeof setTimeout> | null = null;
    return Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
                onTimeout();
                reject(new Error(message));
            }, timeoutMs);
        }),
    ]).finally(() => {
        if (timer) {
            clearTimeout(timer);
        }
    });
}

function readAuth(response: Record<string, unknown>) {
    const account = normalizeCodexAssistantAccount(response.account);
    if (account) {
        return {
            auth: 'authenticated' as const,
            account,
        };
    }
    return {
        // A provider that needs no OpenAI login (a proxy, an API key route) is usable without an account.
        auth: response.requiresOpenaiAuth === false ? 'authenticated' as const : 'unauthenticated' as const,
        account: null,
    };
}

/**
 * One configured Codex instance: a bounded metadata probe and, on demand, a
 * single chat app-server with EVB's tool isolation that serves every chat
 * thread of this instance.
 */
export class CodexInstanceRuntime {
    private chat: Promise<CodexAppServerClient> | null = null;
    /** Every process this instance started and has not stopped, including ones still starting. */
    private readonly clients = new Set<CodexAppServerClient>();
    private readonly stopping = new Map<CodexAppServerClient, Promise<void>>();
    /** Advances on shutdown, so a startup that began earlier discards its process. */
    private stopGeneration = 0;
    private chatClient: CodexAppServerClient | null = null;
    private userTools: ICodexUserToolConfig | null = null;
    private readonly threads = new Map<string, ICodexThreadListener>();
    private login: {
        client: CodexAppServerClient;
        loginId: string | null;
        timer: ReturnType<typeof setTimeout>;
    } | null = null;

    constructor(
        private readonly options: {
            resolveContext: () => Promise<IAssistantLaunchContext>;
            cwd: () => Promise<string>;
            embeddedMcp: () => Promise<{
                url: string;
                token: string
            }>;
            onLoginFinished: (error: string | null) => void;
        },
    ) {}

    private spawn(context: IAssistantLaunchContext, extraArgs: readonly string[], env: NodeJS.ProcessEnv, cwd: string, listener?: {
        notification: (notification: ICodexAppServerNotification) => void;
        exit: (message: string) => void;
    }) {
        if (!context.binaryPath) {
            throw new Error(te('dialogs.agentAssistant.codexMissing'));
        }
        const client = new CodexAppServerClient(
            context.binaryPath,
            [
                ...context.launchArgs,
                ...extraArgs,
            ],
            env,
            cwd,
            listener?.notification ?? (() => undefined),
            listener?.exit ?? (() => undefined),
        );
        this.clients.add(client);
        return client;
    }

    /** A client stays owned until its process has stopped, so every shutdown waits for it. */
    private stop(client: CodexAppServerClient) {
        const pending = this.stopping.get(client);
        if (pending) {
            return pending;
        }
        const stopped = client.shutdown().catch((error: unknown) => {
            logger.warn(`Codex process did not stop cleanly: ${getErrorMessage(error)}`);
        }).finally(() => {
            this.clients.delete(client);
            this.stopping.delete(client);
        });
        this.stopping.set(client, stopped);
        return stopped;
    }

    private assertNotStopped(generation: number) {
        if (generation !== this.stopGeneration) {
            throw new Error('EVB Assistant stopped.');
        }
    }

    /**
     * Reads login, models and the instance's own tool configuration without
     * starting a chat or EVB's MCP server. The whole probe has one budget;
     * on expiry its process is killed and the failure names the cause.
     */
    async probe(generation = this.stopGeneration): Promise<ICodexProbeResult> {
        const context = await this.options.resolveContext();
        const cwd = await this.options.cwd();
        this.assertNotStopped(generation);
        const client = this.spawn(context, [], context.env, cwd);
        const work = (async (): Promise<ICodexProbeResult> => {
            await client.initialize();
            const account = await client.requestDecoded('account/read', {refreshToken: false}, decodeRecord, CODEX_CONTROL_TIMEOUT_MS);
            const result: ICodexProbeResult = {
                ...readAuth(account),
                models: [],
            };
            try {
                const config = await client.requestDecoded('config/read', {}, decodeRecord, CODEX_CONTROL_TIMEOUT_MS);
                this.userTools = readCodexUserToolConfig(config);
                result.models = await client.requestDecoded(
                    'model/list',
                    {includeHidden: false},
                    normalizeCodexModelListResponse,
                    CODEX_CONTROL_TIMEOUT_MS,
                );
            } catch (error) {
                result.warning = te('dialogs.agentAssistant.modelListUnavailable', {reason: getErrorMessage(error)});
            }
            return result;
        })();
        try {
            return await withDeadline(
                work,
                CODEX_PROBE_BUDGET_MS,
                te('dialogs.agentAssistant.statusTimeout', {
                    provider: 'Codex',
                    seconds: CODEX_PROBE_BUDGET_MS / 1000,
                }),
                () => void this.stop(client),
            );
        } finally {
            await this.stop(client);
        }
    }

    private async startChat() {
        const generation = this.stopGeneration;
        const context = await this.options.resolveContext();
        if (!this.userTools) {
            this.assertNotStopped(generation);
            await this.probe(generation);
        }
        const userTools = this.userTools ?? {
            mcpServers: [],
            plugins: [],
        };
        const mcp = await this.options.embeddedMcp();
        const cwd = await this.options.cwd();
        this.assertNotStopped(generation);
        const client = this.spawn(
            context,
            createCodexIsolationArgs(mcp.url, 'medium', userTools),
            {
                ...context.env,
                [ASSISTANT_MCP_TOKEN_ENV]: mcp.token,
                NO_COLOR: '1',
            },
            cwd,
            {
                notification: notification => this.route(notification),
                exit: message => this.handleExit(client, message),
            },
        );
        try {
            await client.initialize();
            const leaks: string[] = [];
            let cursor: string | null = null;
            do {
                const page = readCodexMcpStatusPage(await client.request('mcpServerStatus/list', {
                    detail: 'toolsAndAuthOnly',
                    ...(cursor ? {cursor} : {}),
                }, CODEX_CONTROL_TIMEOUT_MS));
                leaks.push(...page.leaks);
                cursor = page.nextCursor;
            } while (cursor);
            if (leaks.length > 0) {
                throw new Error(te('dialogs.agentAssistant.toolLeak', {servers: leaks.join(', ')}));
            }
            this.assertNotStopped(generation);
        } catch (error) {
            await this.stop(client);
            throw error;
        }
        this.chatClient = client;
        return client;
    }

    private ensureChat() {
        if (!this.chat) {
            const pending = this.startChat();
            this.chat = pending;
            pending.catch(() => {
                if (this.chat === pending) {
                    this.chat = null;
                }
            });
        }
        return this.chat;
    }

    private route(notification: ICodexAppServerNotification) {
        const method = typeof notification.method === 'string' ? notification.method : '';
        const params = isRecord(notification.params) ? notification.params : {};
        if (method === 'account/login/completed') {
            this.finishLogin(params.success === false ? (typeof params.error === 'string' ? params.error : te('dialogs.agentAssistant.signInCanceled')) : null);
            return;
        }
        const threadId = typeof params.threadId === 'string' ? params.threadId : null;
        if (threadId) {
            this.threads.get(threadId)?.onNotification(method, params);
        }
    }

    private handleExit(client: CodexAppServerClient, message: string) {
        if (this.chatClient !== client) {
            return;
        }
        this.chatClient = null;
        this.chat = null;
        const listeners = [...this.threads.values()];
        this.threads.clear();
        for (const listener of listeners) {
            listener.onExit(message);
        }
    }

    /** Starts or resumes a thread; a thread id from another home starts fresh. */
    async openThread(threadId: string | null, model: string, listener: ICodexThreadListener) {
        const client = await this.ensureChat();
        const cwd = await this.options.cwd();
        const common = {
            cwd,
            approvalPolicy: 'never',
            sandbox: 'read-only',
            developerInstructions: ASSISTANT_ROLE_PROMPT,
            personality: 'friendly',
        };
        if (threadId) {
            try {
                await client.requestDecoded('thread/resume', {
                    threadId,
                    ...common,
                }, decodeRecord, CODEX_CONTROL_TIMEOUT_MS);
                this.threads.set(threadId, listener);
                return {
                    threadId,
                    resumed: true,
                };
            } catch (error) {
                logger.info(`Starting a new Codex thread because ${threadId} could not be resumed: ${getErrorMessage(error)}`);
            }
        }
        const response = await client.requestDecoded('thread/start', {
            ...(model ? {model} : {}),
            ...common,
            serviceName: 'EVB Assistant',
            ephemeral: false,
            threadSource: 'user',
        }, decodeRecord, CODEX_CONTROL_TIMEOUT_MS);
        const id = isRecord(response.thread) && typeof response.thread.id === 'string' ? response.thread.id : null;
        if (!id) {
            throw new Error(te('dialogs.agentAssistant.noThread'));
        }
        this.threads.set(id, listener);
        return {
            threadId: id,
            resumed: false,
        };
    }

    releaseThread(threadId: string) {
        this.threads.delete(threadId);
    }

    async startTurn(input: ICodexTurnInput) {
        const client = await this.ensureChat();
        const response = await client.requestDecoded('turn/start', {
            threadId: input.threadId,
            input: [
                {
                    type: 'text',
                    text: input.text || ASSISTANT_IMAGE_ONLY_PROMPT,
                    text_elements: [],
                },
                ...input.attachments.map(attachment => ({
                    type: 'image',
                    url: attachment.dataUrl,
                })),
            ],
            ...(input.model ? {model: input.model} : {}),
            effort: input.effort,
            ...(input.serviceTier ? {serviceTier: input.serviceTier} : {}),
            cwd: await this.options.cwd(),
            approvalPolicy: 'never',
            sandboxPolicy: {
                type: 'readOnly',
                networkAccess: false,
            },
            personality: 'friendly',
        }, decodeRecord, CODEX_CONTROL_TIMEOUT_MS);
        const turnId = isRecord(response.turn) && typeof response.turn.id === 'string' ? response.turn.id : null;
        if (!turnId) {
            throw new Error(te('dialogs.agentAssistant.notAccepted'));
        }
        return turnId;
    }

    async interrupt(threadId: string, turnId: string) {
        const client = this.chatClient;
        if (!client) {
            return;
        }
        await client.request('turn/interrupt', {
            threadId,
            turnId,
        }, CODEX_CONTROL_TIMEOUT_MS);
    }

    async startLogin(mode: 'chatgpt' | 'device-code') {
        const generation = this.stopGeneration;
        await this.cancelLogin();
        const context = await this.options.resolveContext();
        const cwd = await this.options.cwd();
        this.assertNotStopped(generation);
        const client = this.spawn(context, [], context.env, cwd, {
            notification: notification => this.route(notification),
            exit: () => undefined,
        });
        try {
            await client.initialize();
            const response = await client.requestDecoded(
                'account/login/start',
                mode === 'device-code' ? {type: 'chatgptDeviceCode'} : {type: 'chatgpt'},
                decodeRecord,
                CODEX_CONTROL_TIMEOUT_MS,
            );
            const timer = setTimeout(() => this.finishLogin(te('dialogs.agentAssistant.signInTimedOut')), CODEX_LOGIN_TIMEOUT_MS);
            this.login = {
                client,
                loginId: typeof response.loginId === 'string' ? response.loginId : null,
                timer,
            };
            const authUrl = typeof response.authUrl === 'string' ? response.authUrl : undefined;
            const verificationUrl = typeof response.verificationUrl === 'string' ? response.verificationUrl : undefined;
            const url = authUrl ?? verificationUrl;
            if (url) {
                await shell.openExternal(url);
            }
            return {
                ...(authUrl ? {authUrl} : {}),
                ...(verificationUrl ? {verificationUrl} : {}),
                ...(typeof response.userCode === 'string' ? {userCode: response.userCode} : {}),
            };
        } catch (error) {
            await this.stop(client);
            throw error;
        }
    }

    isLoginPending() {
        return this.login !== null;
    }

    private finishLogin(error: string | null) {
        const login = this.login;
        if (!login) {
            return;
        }
        this.login = null;
        clearTimeout(login.timer);
        void this.stop(login.client);
        this.userTools = null;
        this.options.onLoginFinished(error);
    }

    /** Cancels a pending sign-in. Teardown cancels silently, so no refresh follows it. */
    async cancelLogin(notify = true) {
        const login = this.login;
        if (!login) {
            return;
        }
        // Detach first: a completion that arrives while cancelling is no longer this sign-in's.
        this.login = null;
        clearTimeout(login.timer);
        if (login.loginId) {
            await login.client.request('account/login/cancel', {loginId: login.loginId}, CODEX_CONTROL_TIMEOUT_MS).catch(() => undefined);
        }
        await this.stop(login.client);
        this.userTools = null;
        if (notify) {
            this.options.onLoginFinished(te('dialogs.agentAssistant.signInCanceled'));
        }
    }

    /**
     * Stops every process this instance owns, including probes and a chat
     * process that is still starting. Open threads see an exit.
     */
    async shutdown() {
        // Detach everything this call stops before the first await, so a chat
        // started meanwhile gets a new process that this call leaves alone.
        this.stopGeneration += 1;
        const owned = [...this.clients];
        const listeners = [...this.threads.values()];
        this.threads.clear();
        this.chatClient = null;
        this.chat = null;
        await this.cancelLogin(false);
        await Promise.all(owned.map(process => this.stop(process)));
        // Threads hear of the exit only once their process is gone, because
        // ending a turn releases the document grant.
        for (const listener of listeners) {
            listener.onExit('EVB Assistant stopped.');
        }
    }
}
