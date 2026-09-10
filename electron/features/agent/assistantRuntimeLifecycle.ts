import * as fsPromises from 'fs/promises';
import { join } from 'path';
import * as electron from 'electron';
import type {
    IAgentAssistantChatScope,
    TAgentAssistantEffort,
} from '@contracts/agent';
import { ASSISTANT_DEFAULT_EFFORT } from '@contracts/agentModels';
import {
    getCodexCliInfo,
    runCodexCli,
    type ICodexCliInfo,
} from '@electron/features/agent/codexCli';
import {
    ASSISTANT_MCP_CONTRACT_VERSION,
    ASSISTANT_MCP_SERVER_NAME,
    ASSISTANT_MCP_TOKEN_ENV,
    ASSISTANT_MODEL_CONFIG_DIR,
    ASSISTANT_ROLE_PROMPT,
    createAssistantCodexConfig,
} from '@electron/features/agent/codexAssistantConfig';
import {
    CodexAppServerClient,
    type ICodexAppServerNotification,
} from '@electron/features/agent/codexAppServerClient';
import {
    normalizeCodexModelListResponse,
    type TCodexAssistantModelOption,
} from '@electron/features/agent/assistantModelCatalog';
import {
    codexDefaultModelId,
    normalizeAssistantEffort,
    normalizeAssistantModel,
    normalizeCodexAssistantModel,
    type IAssistantSelection,
} from '@electron/features/agent/assistantProviderStatus';
import {
    reconcileTerminalAssistantProviderRuntimeState,
    type IAssistantProviderRuntimeState,
} from '@electron/features/agent/assistantProviderState';
import {
    refreshCodexAuthState,
    refreshCodexAuthStateAndRuntimeAvailability,
    syncCodexRuntimeStateAfterAuthCheck,
} from '@electron/features/agent/assistantProviderAccounts';
import type {
    IAssistantChatSession,
    TAssistantChatSessionStore,
} from '@electron/features/agent/assistantChatSessionStore';
import {
    isAssistantTurnActive,
    supersedeAssistantTurn,
} from '@electron/features/agent/assistantTurnLifecycle';
import {
    getEmbeddedMcpServerDescriptor,
    isEmbeddedMcpServerRunning,
    shutdownEmbeddedMcpServer,
    startEmbeddedMcpServer,
} from '@electron/features/agent/mcpServer';
import { isRecord } from '@contracts/runtimeGuards';
import { getErrorMessage } from '@electron/utils/error';

interface IAssistantRuntime {
    client: CodexAppServerClient;
    generation: number;
    codexPath: string;
    codexVersion: string;
    codeHome: string;
    cwd: string;
    mcpToken: string;
    mcpServerName: string;
    mcpContractVersion: number;
}

interface IEnsuredAssistantThread {
    threadId: string;
    created: boolean;
}

interface IAssistantRuntimeLifecycleLogger {
    info(message: string): void;
    warn(message: string): void;
}

interface IAssistantRuntimeLifecycleOptions {
    providerRuntime: IAssistantProviderRuntimeState;
    sessionStore: TAssistantChatSessionStore;
    getCodexModels: () => readonly TCodexAssistantModelOption[];
    setCodexModels: (models: readonly TCodexAssistantModelOption[]) => void;
    isAssistantFeatureEnabled: () => Promise<boolean>;
    createAssistantDisabledError: () => string;
    shutdownAssistant: () => Promise<void>;
    publishCodexState: (scope?: IAgentAssistantChatScope | null, selection?: IAssistantSelection) => void;
    handleNotification: (notification: ICodexAppServerNotification) => void;
    handleExit: (message: string) => void;
    logger: IAssistantRuntimeLifecycleLogger;
}

function getAssistantBaseDir() {
    return join(electron.app.getPath('userData'), ASSISTANT_MODEL_CONFIG_DIR);
}

function getAssistantCodexHome() {
    return join(getAssistantBaseDir(), 'codex-home');
}

function getAssistantCwd() {
    return join(getAssistantBaseDir(), 'cwd');
}

function createCodexProcessEnvironment(codeHome: string, mcpToken?: string) {
    return {
        ...process.env,
        CODEX_HOME: codeHome,
        ...(mcpToken ? {[ASSISTANT_MCP_TOKEN_ENV]: mcpToken} : {}),
        NO_COLOR: '1',
    };
}

export async function ensureAssistantCwd() {
    const cwd = getAssistantCwd();
    await fsPromises.mkdir(cwd, { recursive: true });
    return cwd;
}

function ensureSharedEmbeddedMcp() {
    return startEmbeddedMcpServer();
}

async function writeAssistantConfig(codeHome: string, serverUrl: string, reasoningEffort: TAgentAssistantEffort) {
    await fsPromises.mkdir(codeHome, { recursive: true });
    await fsPromises.writeFile(join(codeHome, 'config.toml'), createAssistantCodexConfig(serverUrl, reasoningEffort), 'utf-8');
}

export function createBaseAssistantMcpStatus() {
    const descriptor = getEmbeddedMcpServerDescriptor();
    return {
        serverName: descriptor?.name ?? ASSISTANT_MCP_SERVER_NAME,
        serverUrl: descriptor?.url ?? '',
        serverRunning: isEmbeddedMcpServerRunning(),
        toolCount: 0,
    };
}

export function createAssistantFeatureLifecycle(options: {
    isEnabled: () => Promise<boolean>;
    createDisabledError: () => string;
}) {
    let generation = 0;
    let shutdownPromise: Promise<void> | null = null;

    async function isEnabled(expectedGeneration: number) {
        await shutdownPromise?.catch(() => undefined);
        if (generation !== expectedGeneration) {
            return false;
        }
        const enabled = await options.isEnabled();
        return enabled && generation === expectedGeneration;
    }

    async function assertEnabled(expectedGeneration: number) {
        if (!(await isEnabled(expectedGeneration))) {
            throw new Error(options.createDisabledError());
        }
    }

    return {
        assertEnabled,
        captureGeneration: () => generation,
        isEnabled,
        waitForShutdown: () => shutdownPromise?.catch(() => undefined) ?? Promise.resolve(),
        shutdown(run: () => Promise<void>) {
            generation += 1;
            const previousShutdown = shutdownPromise ?? Promise.resolve();
            const nextShutdown = previousShutdown
                .catch(() => undefined)
                .then(run)
                .finally(() => {
                    if (shutdownPromise === nextShutdown) {
                        shutdownPromise = null;
                    }
                });
            shutdownPromise = nextShutdown;
            return nextShutdown;
        },
    };
}

function decodeRecordResponse(value: unknown): Record<PropertyKey, unknown> | null {
    return isRecord(value) ? value : null;
}

export function createAssistantRuntimeLifecycle(options: IAssistantRuntimeLifecycleOptions) {
    let codexInfoCache: ICodexCliInfo | null = null;
    let runtime: IAssistantRuntime | null = null;
    let runtimeStartPromise: Promise<IAssistantRuntime> | null = null;
    let runtimeShutdownPromise: Promise<void> | null = null;
    let runtimeGeneration = 0;
    let mcpToolCount = 0;

    function getRuntime() {
        return runtime;
    }

    function getCodexInfo() {
        return codexInfoCache;
    }

    function setCodexInfo(info: ICodexCliInfo | null) {
        codexInfoCache = info;
    }

    function getMcpToolCount() {
        return mcpToolCount;
    }

    function clearRuntimeForExit() {
        if (runtime?.client.hasProvenTermination()) {
            runtime = null;
        }
    }

    async function assertRuntimeEnabled(
        expectedRuntime: IAssistantRuntime | null,
        generation: number,
    ) {
        if (runtimeGeneration !== generation || (expectedRuntime && runtime !== expectedRuntime)) {
            throw new Error(options.createAssistantDisabledError());
        }
        const enabled = await options.isAssistantFeatureEnabled();
        if (
            !enabled
            || runtimeGeneration !== generation
            || (expectedRuntime && runtime !== expectedRuntime)
        ) {
            throw new Error(options.createAssistantDisabledError());
        }
    }

    async function shutdownCodexRuntime(shutdownOptions: { shutdownMcp?: boolean } = {}) {
        if (runtimeShutdownPromise) {
            return runtimeShutdownPromise;
        }

        const shutdownGeneration = ++runtimeGeneration;
        runtimeStartPromise = null;
        const runtimeToShutdown = runtime;
        const nextShutdownPromise = (async () => {
            try {
                await runtimeToShutdown?.client.shutdown();
            } catch (error: unknown) {
                if (runtimeGeneration === shutdownGeneration) {
                    options.providerRuntime.runtimeState = 'error';
                    options.providerRuntime.lastError = getErrorMessage(error);
                    options.publishCodexState();
                }
                throw error;
            }
            if (runtimeGeneration !== shutdownGeneration) {
                return;
            }
            if (runtime === runtimeToShutdown) {
                runtime = null;
            }
            options.providerRuntime.runtimeState = 'stopped';
            options.sessionStore.clearActiveSessionForProvider('codex');
            for (const session of options.sessionStore.listSessions()) {
                if (session.provider !== 'codex') {
                    continue;
                }
                session.turnOwner = supersedeAssistantTurn(session.turnOwner);
                session.scopeBinding = null;
                options.sessionStore.recordTurnBoundary(session);
            }
            mcpToolCount = 0;
            if (shutdownOptions.shutdownMcp === true) {
                await shutdownEmbeddedMcpServer();
            }
        })().finally(() => {
            if (runtimeShutdownPromise === nextShutdownPromise) {
                runtimeShutdownPromise = null;
            }
        });
        runtimeShutdownPromise = nextShutdownPromise;
        return nextShutdownPromise;
    }

    async function refreshCodexInfo() {
        codexInfoCache = await getCodexCliInfo();
        return codexInfoCache;
    }

    async function refreshCodexAuthStateWithoutRuntime() {
        if (!codexInfoCache?.installed || !codexInfoCache.path) {
            options.providerRuntime.authState = 'unknown';
            options.providerRuntime.account = null;
            return;
        }
        if (options.providerRuntime.authState !== 'unknown') {
            return;
        }

        const result = await runCodexCli(codexInfoCache.path, [
            'login',
            'status',
        ], {env: createCodexProcessEnvironment(getAssistantCodexHome())});
        options.providerRuntime.authState = result.ok ? 'signed-in' : 'signed-out';
        options.providerRuntime.account = null;
        if (result.ok) {
            delete options.providerRuntime.lastError;
            if (options.providerRuntime.runtimeState === 'stopped') {
                options.providerRuntime.runtimeState = 'ready';
            }
            return;
        }
        options.providerRuntime.runtimeState = 'stopped';
        delete options.providerRuntime.lastError;
    }

    async function refreshAuthState() {
        await refreshCodexAuthState(
            options.providerRuntime,
            runtime?.client ?? null,
            {
                info: (message: string) => options.logger.info(message),
                warn: (message: string) => options.logger.warn(message),
            },
        );
    }

    async function refreshAuthStateAndRuntimeAvailability(refreshOptions: { recoverFromError?: boolean } = {}) {
        await refreshCodexAuthStateAndRuntimeAvailability({
            providerRuntime: options.providerRuntime,
            client: runtime?.client ?? null,
            hasRuntime: Boolean(runtime),
            ...(refreshOptions.recoverFromError === undefined ? {} : { recoverFromError: refreshOptions.recoverFromError }),
            info: (message: string) => options.logger.info(message),
            warn: (message: string) => options.logger.warn(message),
        });
        const repairedOrphanedBusyState = reconcileTerminalAssistantProviderRuntimeState(
            options.providerRuntime,
            {
                hasRuntime: Boolean(runtime),
                hasActiveWork: options.sessionStore.listSessions().some(session => (
                    session.provider === 'codex'
                    && (session.sendInFlight !== null || isAssistantTurnActive(session.turnOwner))
                )),
            },
        );
        if (repairedOrphanedBusyState) {
            options.logger.warn('Recovered an orphaned Codex busy state after all assistant turns became terminal.');
        }
    }

    async function ensureRuntime() {
        if (!(await options.isAssistantFeatureEnabled())) {
            await options.shutdownAssistant();
            throw new Error(options.createAssistantDisabledError());
        }

        if (runtimeStartPromise) {
            return runtimeStartPromise;
        }

        if (runtimeShutdownPromise) {
            await runtimeShutdownPromise;
        }

        if (runtime?.client.isClosed()) {
            await shutdownCodexRuntime();
        }

        if (runtime) {
            const runtimeUsesCurrentCodex = codexInfoCache === null
                || (
                    codexInfoCache.isVersionSupported
                    && codexInfoCache.path === runtime.codexPath
                    && codexInfoCache.version === runtime.codexVersion
                );
            if (
                runtimeUsesCurrentCodex
                && runtime.mcpServerName === ASSISTANT_MCP_SERVER_NAME
                && runtime.mcpContractVersion === ASSISTANT_MCP_CONTRACT_VERSION
            ) {
                return runtime;
            }
            options.logger.info(runtimeUsesCurrentCodex
                ? 'Restarting Codex assistant runtime for updated embedded MCP contract.'
                : 'Restarting Codex assistant runtime for the installed Codex version.');
            await shutdownCodexRuntime();
        }

        if (runtime) {
            return runtime;
        }

        const generation = ++runtimeGeneration;
        const startPromise = startRuntime(generation).finally(() => {
            if (runtimeStartPromise === startPromise) {
                runtimeStartPromise = null;
            }
        });
        runtimeStartPromise = startPromise;
        return startPromise;
    }

    async function startRuntime(generation: number) {
        options.providerRuntime.runtimeState = 'starting';
        delete options.providerRuntime.lastError;
        options.publishCodexState();

        const codexInfo = await refreshCodexInfo();
        await assertRuntimeEnabled(null, generation);
        if (!codexInfo.installed || !codexInfo.path) {
            options.providerRuntime.runtimeState = 'stopped';
            options.providerRuntime.authState = 'unknown';
            options.publishCodexState();
            throw new Error('Codex is not installed.');
        }
        if (!codexInfo.isVersionSupported || !codexInfo.version) {
            options.providerRuntime.runtimeState = 'error';
            options.providerRuntime.lastError = `Codex ${codexInfo.version ?? ''} is too old. EVB Assistant requires Codex ${codexInfo.minimumVersion} or newer.`;
            options.publishCodexState();
            throw new Error(options.providerRuntime.lastError);
        }

        const codeHome = getAssistantCodexHome();
        const cwd = await ensureAssistantCwd();
        await assertRuntimeEnabled(null, generation);
        const selection = options.sessionStore.getRememberedSelection();
        const codexModels = options.getCodexModels();
        const codexModel = selection.provider === 'codex'
            ? selection.model
            : codexDefaultModelId(codexModels);
        const codexEffort = normalizeAssistantEffort(
            codexModels,
            'codex',
            codexModel,
            selection.provider === 'codex' ? selection.effort : ASSISTANT_DEFAULT_EFFORT,
        );
        const {
            descriptor,
            token: mcpToken,
        } = await ensureSharedEmbeddedMcp();
        await assertRuntimeEnabled(null, generation);
        await writeAssistantConfig(codeHome, descriptor.url, codexEffort);
        await assertRuntimeEnabled(null, generation);

        const client = new CodexAppServerClient(
            codexInfo.path,
            createCodexProcessEnvironment(codeHome, mcpToken),
            cwd,
            options.handleNotification,
            options.handleExit,
        );
        const nextRuntime = {
            client,
            generation,
            codexPath: codexInfo.path,
            codexVersion: codexInfo.version,
            codeHome,
            cwd,
            mcpToken,
            mcpServerName: ASSISTANT_MCP_SERVER_NAME,
            mcpContractVersion: ASSISTANT_MCP_CONTRACT_VERSION,
        } satisfies IAssistantRuntime;
        runtime = nextRuntime;

        try {
            await assertRuntimeEnabled(nextRuntime, generation);
            await client.initialize();
            await assertRuntimeEnabled(nextRuntime, generation);
            await refreshAuthState();
            await assertRuntimeEnabled(nextRuntime, generation);
            syncCodexRuntimeStateAfterAuthCheck(options.providerRuntime, { hasRuntime: true });
            await refreshCodexModelList();
            await assertRuntimeEnabled(nextRuntime, generation);
            await refreshMcpToolCount();
            await assertRuntimeEnabled(nextRuntime, generation);
            options.publishCodexState();
            return nextRuntime;
        } catch (error) {
            if (runtime === nextRuntime) {
                runtime = null;
            }
            await client.shutdown().catch((shutdownError: unknown) => {
                options.logger.warn(`Failed to stop Codex client after startup failure: ${getErrorMessage(shutdownError)}`);
            });
            if (runtimeGeneration === generation) {
                options.providerRuntime.runtimeState = 'error';
                options.providerRuntime.lastError = getErrorMessage(error);
                options.publishCodexState();
            }
            throw error;
        }
    }

    async function refreshMcpToolCount() {
        if (!runtime) {
            return;
        }

        try {
            const response = await runtime.client.requestDecoded(
                'mcpServerStatus/list',
                {detail: 'toolsAndAuthOnly'},
                decodeRecordResponse,
            );
            if (!Array.isArray(response.data)) {
                return;
            }
            const servers: unknown[] = response.data;
            const server = servers.find(candidate => isRecord(candidate) && candidate.name === ASSISTANT_MCP_SERVER_NAME);
            if (!isRecord(server) || !isRecord(server.tools)) {
                return;
            }
            const descriptor = getEmbeddedMcpServerDescriptor();
            if (!descriptor) {
                return;
            }
            mcpToolCount = Object.keys(server.tools).length;
        } catch (error) {
            options.logger.warn(`Failed to read embedded MCP status: ${getErrorMessage(error)}`);
        }
    }

    async function refreshCodexModelList() {
        if (!runtime) {
            return;
        }

        try {
            const response = await runtime.client.requestDecoded(
                'model/list',
                { includeHidden: false },
                normalizeCodexModelListResponse,
            );
            if (response.length > 0) {
                options.setCodexModels(response);
                const selection = options.sessionStore.getRememberedSelection();
                options.sessionStore.updateRememberedSelection({ model: normalizeAssistantModel(response, selection.provider, selection.model) });
            }
        } catch (error) {
            options.logger.warn(`Failed to read Codex model list: ${getErrorMessage(error)}`);
        }
    }

    async function ensureThread(session: IAssistantChatSession): Promise<IEnsuredAssistantThread> {
        const currentRuntime = await ensureRuntime();
        await assertRuntimeEnabled(currentRuntime, currentRuntime.generation);
        if (options.providerRuntime.authState !== 'signed-in') {
            throw new Error('Sign in with ChatGPT before using EVB Assistant.');
        }
        if (session.providerThreadId) {
            await currentRuntime.client.requestDecoded('thread/resume', {
                threadId: session.providerThreadId,
                cwd: currentRuntime.cwd,
                approvalPolicy: 'never',
                sandbox: 'read-only',
                developerInstructions: ASSISTANT_ROLE_PROMPT,
                personality: 'friendly',
            }, decodeRecordResponse);
            await assertRuntimeEnabled(currentRuntime, currentRuntime.generation);
            return {
                threadId: session.providerThreadId,
                created: false,
            };
        }

        const codexModel = normalizeCodexAssistantModel(options.getCodexModels(), session.model);
        const response = await currentRuntime.client.requestDecoded('thread/start', {
            ...(codexModel ? { model: codexModel } : {}),
            cwd: currentRuntime.cwd,
            approvalPolicy: 'never',
            sandbox: 'read-only',
            serviceName: 'EVB Assistant',
            developerInstructions: ASSISTANT_ROLE_PROMPT,
            personality: 'friendly',
            ephemeral: false,
            threadSource: 'user',
        }, decodeRecordResponse);
        await assertRuntimeEnabled(currentRuntime, currentRuntime.generation);
        if (!isRecord(response.thread) || typeof response.thread.id !== 'string') {
            throw new Error('Codex did not return an assistant thread.');
        }
        return {
            threadId: response.thread.id,
            created: true,
        };
    }

    return {
        clearRuntimeForExit,
        assertRuntimeEnabled: (expectedRuntime: IAssistantRuntime) =>
            assertRuntimeEnabled(expectedRuntime, expectedRuntime.generation),
        ensureRuntime,
        ensureThread,
        getCodexInfo,
        getMcpToolCount,
        getRuntime,
        refreshAuthState,
        refreshAuthStateAndRuntimeAvailability,
        refreshCodexInfo,
        refreshCodexAuthStateWithoutRuntime,
        setCodexInfo,
        shutdownCodexRuntime,
    };
}
