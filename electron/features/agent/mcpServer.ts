import {
    BrowserWindow,
    app,
} from 'electron';
import {
    createServer,
    type Server,
} from 'http';
import type { AddressInfo } from 'net';
import { randomBytes } from 'node:crypto';
import {join} from 'node:path';
import type { IAgentTabSnapshot } from '@contracts/agent';
import type { IAssistantSessionScopeBinding } from '@electron/features/agent/assistantTurnLifecycle';
import type {
    ILocalMcpServerDescriptor,
    ILocalMcpServerIdentity,
    IProcessMcpRequestOptions,
} from '@electron/features/agent/mcp/mcpServerCore';
import {
    getRegisteredMainWindow,
    getWindowByIdFromRegistry,
} from '@electron/window/registry';
import {
    requestAgentCommand,
    requestAgentWorkspaceSnapshot,
} from '@electron/features/agent/workspaceBridge';
import {
    assertAssistantMcpSnapshotMatchesScope,
    assertAssistantMcpTabMatchesBinding,
    clearAssistantMcpSessionScope,
    createAssistantCommandExecutionScope,
    getActiveAssistantMcpSessionScope,
    resolveAssistantMcpSessionScope,
} from '@electron/features/agent/assistantMcpSessionScope';
import {
    inspectAgentDocumentText,
    readAgentDocumentPages,
    searchAgentDocument,
} from '@electron/features/agent/documentText';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';
import { createHttpHandler } from '@electron/features/agent/mcp/createHttpHandler';
import {
    ASSISTANT_MCP_SERVER_NAME,
    ASSISTANT_MCP_TOKEN_ENV,
} from '@electron/features/agent/codexAssistantConfig';
import { ensureSecurePersistentLocalMcpToken } from '@electron/features/agent/localMcpTokenStore';

export { processMcpRequest } from '@electron/features/agent/mcp/mcpServerCore';

const logger = createLogger('agent-mcp');
const DEFAULT_MCP_HOST = '127.0.0.1';
const DEFAULT_PROD_MCP_PORT = 38671;
const DEFAULT_DEV_MCP_PORT = 38672;
const MCP_SERVER_CLOSE_GRACE_MS = 250;
const MCP_SERVER_CLOSE_DEADLINE_MS = 1_000;
const LOCAL_MCP_PROXY_SCRIPT_PATH = join('scripts', 'evb-mcp-proxy.mjs');
const LOCAL_MCP_PROXY_ENV = {
    runAsNode: 'ELECTRON_RUN_AS_NODE',
    url: 'EVB_MCP_URL',
    token: 'EVB_MCP_TOKEN',
} as const;

let localMcpServer: Server | null = null;
let localMcpToken: string | null = null;
let localMcpTokenPromise: Promise<string> | null = null;
let localMcpTokenEnvOwned = false;
let localMcpStartPromise: Promise<void> | null = null;
let localMcpStopPromise: Promise<void> | null = null;
let localMcpDesiredRunning = false as boolean;
let localMcpGeneration = 0;
let embeddedMcpServer: Server | null = null;
const activeMcpRequestsByServer = new WeakMap<Server, Map<AbortController, IAssistantSessionScopeBinding | null>>();
let embeddedMcpServerDescriptor: ILocalMcpServerDescriptor | null = null;
// Stable for the server's lifetime so sessions opened earlier keep working; rotated only on full shutdown.
let embeddedMcpToken: string | null = null;
let embeddedMcpStartPromise: Promise<IEmbeddedMcpServerHandle> | null = null;
let embeddedMcpStopPromise: Promise<void> | null = null;
let embeddedMcpDesiredRunning = false as boolean;
let embeddedMcpGeneration = 0;

function isLocalMcpStartCurrent(generation: number) {
    return localMcpDesiredRunning && localMcpGeneration === generation;
}

function isLocalMcpStopCurrent(generation: number) {
    return !localMcpDesiredRunning && localMcpGeneration === generation;
}

function isEmbeddedMcpStartCurrent(generation: number) {
    return embeddedMcpDesiredRunning && embeddedMcpGeneration === generation;
}

function isEmbeddedMcpStopCurrent(generation: number) {
    return !embeddedMcpDesiredRunning && embeddedMcpGeneration === generation;
}

function getDefaultAgentWindow() {
    const focusedWindow = BrowserWindow.getFocusedWindow();
    if (focusedWindow && getWindowByIdFromRegistry(focusedWindow.id)) {
        return focusedWindow;
    }
    return getRegisteredMainWindow();
}

function resolveAgentWindow(windowId?: number) {
    return windowId === undefined
        ? getDefaultAgentWindow()
        : getWindowByIdFromRegistry(windowId);
}

function parsePort(value: string | undefined, fallbackPort: number) {
    const parsed = Number.parseInt(value ?? '', 10);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
        return fallbackPort;
    }
    return parsed;
}

export function resolveDefaultLocalMcpPort(isPackaged: boolean) {
    return isPackaged ? DEFAULT_PROD_MCP_PORT : DEFAULT_DEV_MCP_PORT;
}

function getAppUserDataPath() {
    try {
        return app.getPath('userData');
    } catch {
        return null;
    }
}

export function createLocalMcpServerIdentity(port: number, host = DEFAULT_MCP_HOST): ILocalMcpServerIdentity {
    const isPackaged = app.isPackaged;
    const appName = app.getName();
    return {
        name: isPackaged ? 'evb_viewer' : 'evb_viewer_dev',
        title: appName,
        appName,
        version: app.getVersion(),
        isPackaged,
        userDataPath: getAppUserDataPath(),
        host,
        port,
    };
}

function resolveConfiguredLocalMcpPort() {
    return parsePort(process.env.EVB_MCP_PORT, resolveDefaultLocalMcpPort(app.isPackaged));
}

export function getLocalMcpServerDescriptor(): ILocalMcpServerDescriptor {
    const port = resolveConfiguredLocalMcpPort();
    const identity = createLocalMcpServerIdentity(port);
    return {
        name: identity.name,
        title: identity.title,
        host: identity.host,
        port: identity.port,
        url: `http://${identity.host}:${identity.port}`,
    };
}

async function ensureLocalMcpServerBearerToken() {
    if (localMcpToken) {
        process.env[ASSISTANT_MCP_TOKEN_ENV] = localMcpToken;
        return localMcpToken;
    }
    if (localMcpTokenPromise) {
        return localMcpTokenPromise;
    }

    const tokenPromise = (async () => {
        const configuredToken = process.env[ASSISTANT_MCP_TOKEN_ENV]?.trim();
        const token = configuredToken && configuredToken.length > 0
            ? configuredToken
            : await ensureSecurePersistentLocalMcpToken(app.getPath('userData'));
        localMcpToken = token;
        localMcpTokenEnvOwned = !(configuredToken && configuredToken.length > 0);
        process.env[ASSISTANT_MCP_TOKEN_ENV] = token;
        return token;
    })().finally(() => {
        if (localMcpTokenPromise === tokenPromise) {
            localMcpTokenPromise = null;
        }
    });
    localMcpTokenPromise = tokenPromise;
    return tokenPromise;
}

interface ILocalMcpProxyLaunchConfig {
    command: string;
    args: string[];
    env: Record<string, string>;
}

function getAppRootPath() {
    try {
        return app.getAppPath();
    } catch {
        return process.cwd();
    }
}

function resolveLocalMcpProxyScriptPath() {
    return join(getAppRootPath(), LOCAL_MCP_PROXY_SCRIPT_PATH);
}

function createLocalMcpProxyLaunchConfig(
    descriptor: ILocalMcpServerDescriptor,
    token: string,
): ILocalMcpProxyLaunchConfig {
    return {
        command: process.execPath,
        args: [resolveLocalMcpProxyScriptPath()],
        env: {
            [LOCAL_MCP_PROXY_ENV.runAsNode]: '1',
            [LOCAL_MCP_PROXY_ENV.url]: descriptor.url,
            [LOCAL_MCP_PROXY_ENV.token]: token,
        },
    };
}

function shellQuote(value: string) {
    if (process.platform === 'win32') {
        return `"${value.replace(/"/gu, '\\"')}"`;
    }
    return `'${value.replace(/'/gu, '\'\\\'\'')}'`;
}

function createSetupSnippet(
    provider: 'claude' | 'codex',
    descriptor: ILocalMcpServerDescriptor,
    launchConfig: ILocalMcpProxyLaunchConfig,
) {
    const commandPrefix = provider === 'codex'
        ? [
            'codex',
            'mcp',
            'add',
            shellQuote(descriptor.name),
        ]
        : [
            'claude',
            'mcp',
            'add',
            '--scope',
            'user',
            shellQuote(descriptor.name),
        ];
    const environmentFlag = provider === 'codex' ? '--env' : '-e';
    return [
        ...commandPrefix,
        environmentFlag,
        shellQuote(`${LOCAL_MCP_PROXY_ENV.runAsNode}=1`),
        environmentFlag,
        shellQuote(`${LOCAL_MCP_PROXY_ENV.url}=${launchConfig.env[LOCAL_MCP_PROXY_ENV.url] ?? '<missing>'}`),
        environmentFlag,
        shellQuote(`${LOCAL_MCP_PROXY_ENV.token}=${launchConfig.env[LOCAL_MCP_PROXY_ENV.token] ?? '<missing>'}`),
        '--',
        shellQuote(launchConfig.command),
        ...launchConfig.args.map(shellQuote),
    ].join(' ');
}

export async function getLocalMcpSetupSnippets() {
    const descriptor = getLocalMcpServerDescriptor();
    const token = await ensureLocalMcpServerBearerToken();
    const launchConfig = createLocalMcpProxyLaunchConfig(descriptor, token);
    return {
        codex: createSetupSnippet('codex', descriptor, launchConfig),
        claude: createSetupSnippet('claude', descriptor, launchConfig),
        cursor: JSON.stringify({mcpServers: { [descriptor.name]: {
            command: launchConfig.command,
            args: launchConfig.args,
            env: launchConfig.env,
        } }}, null, 2),
    };
}

export async function getLocalMcpCodexRegistrationTransport() {
    const descriptor = getLocalMcpServerDescriptor();
    const token = await ensureLocalMcpServerBearerToken();
    return {
        descriptor,
        launchConfig: createLocalMcpProxyLaunchConfig(descriptor, token),
        token,
    };
}

function clearGeneratedLocalMcpTokenEnv() {
    if (localMcpTokenEnvOwned && process.env[ASSISTANT_MCP_TOKEN_ENV] === localMcpToken) {
        Reflect.deleteProperty(process.env, ASSISTANT_MCP_TOKEN_ENV);
    }
    localMcpTokenEnvOwned = false;
}

export function isLocalMcpServerRunning() {
    return localMcpServer?.listening === true;
}

function createStartupCanceledError(serverKind: string) {
    return new Error(`${serverKind} MCP server startup was canceled by shutdown.`);
}

function createTrackedHttpServer(
    options: IProcessMcpRequestOptions,
    bearerToken: string,
    requestOptions: {
        getBinding?: () => IAssistantSessionScopeBinding | null;
        createOptions?: (binding: IAssistantSessionScopeBinding | null) => IProcessMcpRequestOptions;
    } = {},
) {
    const activeRequestControllers = new Map<AbortController, IAssistantSessionScopeBinding | null>();
    const server = createServer(createHttpHandler(options, {
        bearerToken,
        activeRequestControllers,
        ...(requestOptions.getBinding ? {getRequestContext: requestOptions.getBinding} : {}),
        ...(requestOptions.createOptions ? {createRequestOptions: (context: unknown) =>
            requestOptions.createOptions?.(context as IAssistantSessionScopeBinding | null) ?? options} : {}),
    }));
    activeMcpRequestsByServer.set(server, activeRequestControllers);
    return server;
}

function closeHttpServer(server: Server | null) {
    if (!server) {
        return Promise.resolve();
    }

    for (const controller of activeMcpRequestsByServer.get(server)?.keys() ?? []) {
        controller.abort(new Error('MCP server is shutting down.'));
    }

    return new Promise<void>((resolve) => {
        let settled = false;
        let forceTimer: NodeJS.Timeout | null = null;
        let deadlineTimer: NodeJS.Timeout | null = null;
        const finish = () => {
            if (settled) {
                return;
            }
            settled = true;
            if (forceTimer) {
                clearTimeout(forceTimer);
            }
            if (deadlineTimer) {
                clearTimeout(deadlineTimer);
            }
            resolve();
        };
        try {
            server.close(finish);
            server.closeIdleConnections();
            forceTimer = setTimeout(() => server.closeAllConnections(), MCP_SERVER_CLOSE_GRACE_MS);
            deadlineTimer = setTimeout(finish, MCP_SERVER_CLOSE_DEADLINE_MS);
            forceTimer.unref();
            deadlineTimer.unref();
        } catch {
            finish();
        }
    });
}

function resolveInternalAssistantWindow(
    windowId?: number,
    requestBinding?: IAssistantSessionScopeBinding | null,
) {
    const binding = requestBinding ?? resolveAssistantMcpSessionScope(windowId);
    if (windowId !== undefined && windowId !== binding.windowId) {
        throw new Error('Internal EVB MCP request targeted a different window than the bound assistant turn.');
    }
    const window = getWindowByIdFromRegistry(binding.windowId);
    if (!window) {
        throw new Error('No live renderer window is available for the active assistant MCP turn.');
    }
    return {
        binding,
        window,
    };
}

function assertInternalInputTabMatchesBinding(
    tab: IAgentTabSnapshot,
    binding: ReturnType<typeof resolveAssistantMcpSessionScope>,
) {
    assertAssistantMcpTabMatchesBinding(tab, binding);
}

function createDefaultMcpRequestOptions(
    identity: ILocalMcpServerIdentity,
    callerKind: 'external' | 'internal',
    requestBinding?: IAssistantSessionScopeBinding | null,
): IProcessMcpRequestOptions {
    if (callerKind === 'internal') {
        return {
            identity,
            callerKind,
            getWorkspaceSnapshot: async (windowId) => {
                const {
                    binding,
                    window,
                } = resolveInternalAssistantWindow(windowId, requestBinding);
                const snapshot = await requestAgentWorkspaceSnapshot(
                    window,
                    undefined,
                    createAssistantCommandExecutionScope(binding),
                );
                assertAssistantMcpSnapshotMatchesScope(snapshot, binding);
                return snapshot;
            },
            runCommand: async (command, windowId, signal) => {
                const {
                    binding,
                    window,
                } = resolveInternalAssistantWindow(windowId, requestBinding);
                const scope = createAssistantCommandExecutionScope(binding);
                const snapshot = await requestAgentWorkspaceSnapshot(window, undefined, scope, signal);
                assertAssistantMcpSnapshotMatchesScope(snapshot, binding);
                return requestAgentCommand(
                    window,
                    command,
                    undefined,
                    scope,
                    signal,
                );
            },
            inspectDocumentText: async (input, windowId, signal) => {
                const {
                    binding,
                    window,
                } = resolveInternalAssistantWindow(windowId, requestBinding);
                assertInternalInputTabMatchesBinding(input.tab, binding);
                return inspectAgentDocumentText(window, input, signal);
            },
            searchDocument: async (input, windowId, signal) => {
                const {
                    binding,
                    window,
                } = resolveInternalAssistantWindow(windowId, requestBinding);
                assertInternalInputTabMatchesBinding(input.tab, binding);
                return searchAgentDocument(window, input, signal);
            },
            readDocumentPages: async (input, windowId, signal) => {
                const {
                    binding,
                    window,
                } = resolveInternalAssistantWindow(windowId, requestBinding);
                assertInternalInputTabMatchesBinding(input.tab, binding);
                return readAgentDocumentPages(window, input, signal);
            },
        };
    }

    return {
        identity,
        callerKind,
        getWorkspaceSnapshot: async (windowId) => {
            const window = resolveAgentWindow(windowId);
            return requestAgentWorkspaceSnapshot(window);
        },
        runCommand: async (command, windowId, signal) => {
            const window = resolveAgentWindow(windowId);
            return requestAgentCommand(window, command, undefined, undefined, signal);
        },
        inspectDocumentText: async (input, windowId, signal) => {
            const window = resolveAgentWindow(windowId);
            if (!window) {
                throw new Error('No live renderer window is available for document text inspection.');
            }
            return inspectAgentDocumentText(window, input, signal);
        },
        searchDocument: async (input, windowId, signal) => {
            const window = resolveAgentWindow(windowId);
            if (!window) {
                throw new Error('No live renderer window is available for document search.');
            }
            return searchAgentDocument(window, input, signal);
        },
        readDocumentPages: async (input, windowId, signal) => {
            const window = resolveAgentWindow(windowId);
            if (!window) {
                throw new Error('No live renderer window is available for document page text reading.');
            }
            return readAgentDocumentPages(window, input, signal);
        },
    };
}

export function startLocalMcpServer() {
    if (localMcpDesiredRunning && localMcpStartPromise) {
        return localMcpStartPromise;
    }
    if (localMcpDesiredRunning && localMcpServer?.listening) {
        return Promise.resolve();
    }
    localMcpDesiredRunning = true;
    const generation = ++localMcpGeneration;
    const precedingStop = localMcpStopPromise;
    const startPromise = (async () => {
        await precedingStop;
        if (!isLocalMcpStartCurrent(generation)) {
            throw createStartupCanceledError('Local');
        }
        const bearerToken = await ensureLocalMcpServerBearerToken();
        if (!isLocalMcpStartCurrent(generation)) {
            throw createStartupCanceledError('Local');
        }
        const port = resolveConfiguredLocalMcpPort();
        const identity = createLocalMcpServerIdentity(port);
        const options = {...createDefaultMcpRequestOptions(identity, 'external')};

        const server = createTrackedHttpServer(options, bearerToken);
        localMcpServer = server;
        await new Promise<void>((resolve, reject) => {
            let settled = false;
            const failStartup = (error: Error, logFailure: boolean) => {
                if (settled) {
                    return;
                }
                settled = true;
                if (logFailure) {
                    logger.error(`Local MCP server failed: ${getErrorMessage(error)}`, {
                        code: 'MAIN_CODEX_MCP_INTEGRATION_FAILED',
                        context: {action: 'enable'},
                        cause: error,
                    });
                }
                if (localMcpServer === server) {
                    localMcpServer = null;
                }
                reject(error);
            };

            server.on('error', (error) => {
                const normalizedError = error instanceof Error ? error : new Error(getErrorMessage(error));
                if (settled) {
                    logger.error(`Local MCP server failed: ${getErrorMessage(normalizedError)}`, {
                        code: 'MAIN_CODEX_MCP_INTEGRATION_FAILED',
                        context: {action: 'enable'},
                        cause: normalizedError,
                    });
                    return;
                }
                const isCurrentStartup = localMcpDesiredRunning
                    && localMcpGeneration === generation
                    && localMcpServer === server;
                failStartup(normalizedError, isCurrentStartup);
            });
            server.on('close', () => {
                failStartup(createStartupCanceledError('Local'), false);
            });
            server.listen(port, DEFAULT_MCP_HOST, () => {
                if (settled) {
                    return;
                }
                if (
                    !localMcpDesiredRunning
                    || localMcpGeneration !== generation
                    || localMcpServer !== server
                ) {
                    void closeHttpServer(server);
                    failStartup(createStartupCanceledError('Local'), false);
                    return;
                }

                settled = true;
                const address = server.address() as AddressInfo | null;
                logger.info(`Local MCP server ${identity.name} listening on http://${DEFAULT_MCP_HOST}:${address?.port ?? port}`);
                resolve();
            });
        });
    })().finally(() => {
        if (localMcpStartPromise === startPromise) {
            localMcpStartPromise = null;
        }
    });
    localMcpStartPromise = startPromise;
    return startPromise;
}

export function shutdownLocalMcpServer() {
    localMcpDesiredRunning = false;
    const generation = ++localMcpGeneration;
    const server = localMcpServer;
    localMcpServer = null;
    const pendingStart = localMcpStartPromise;
    const pendingToken = localMcpTokenPromise;
    const stopPromise = (async () => {
        await Promise.allSettled([
            closeHttpServer(server),
            ...(pendingStart ? [pendingStart] : []),
            ...(pendingToken ? [pendingToken] : []),
        ]);
        if (isLocalMcpStopCurrent(generation)) {
            clearGeneratedLocalMcpTokenEnv();
            localMcpToken = null;
        }
    })().finally(() => {
        if (localMcpStopPromise === stopPromise) {
            localMcpStopPromise = null;
        }
    });
    localMcpStopPromise = stopPromise;
    return stopPromise;
}

export function isEmbeddedMcpServerRunning() {
    return embeddedMcpServer?.listening === true;
}

export function abortActiveEmbeddedMcpRequests(
    binding: IAssistantSessionScopeBinding | null,
    reason = 'Assistant turn interrupted.',
) {
    if (!embeddedMcpServer || !binding) {
        return 0;
    }
    const controllers = activeMcpRequestsByServer.get(embeddedMcpServer) ?? new Map<AbortController, IAssistantSessionScopeBinding | null>();
    return abortAssistantToolRequestsForBinding(controllers, binding, reason);
}

export function abortAssistantToolRequestsForBinding(
    controllers: ReadonlyMap<AbortController, IAssistantSessionScopeBinding | null>,
    binding: IAssistantSessionScopeBinding,
    reason = 'Assistant turn interrupted.',
) {
    let aborted = 0;
    for (const [
        controller,
        requestBinding,
    ] of controllers) {
        if (
            requestBinding?.sessionKey === binding.sessionKey
            && requestBinding.turnGeneration === binding.turnGeneration
            && requestBinding.windowId === binding.windowId
            && !controller.signal.aborted
        ) {
            controller.abort(new Error(reason));
            aborted += 1;
        }
    }
    return aborted;
}

export function getEmbeddedMcpServerDescriptor() {
    return embeddedMcpServerDescriptor;
}

export interface IEmbeddedMcpServerHandle {
    descriptor: ILocalMcpServerDescriptor;
    token: string;
}

export function startEmbeddedMcpServer(): Promise<IEmbeddedMcpServerHandle> {
    if (embeddedMcpServer && embeddedMcpServerDescriptor && embeddedMcpToken) {
        if (embeddedMcpServerDescriptor.name !== ASSISTANT_MCP_SERVER_NAME) {
            return shutdownEmbeddedMcpServer().then(() => startEmbeddedMcpServer());
        }
        return Promise.resolve({
            descriptor: embeddedMcpServerDescriptor,
            token: embeddedMcpToken,
        });
    }
    if (embeddedMcpDesiredRunning && embeddedMcpStartPromise) {
        return embeddedMcpStartPromise;
    }
    embeddedMcpDesiredRunning = true;
    const generation = ++embeddedMcpGeneration;
    const precedingStop = embeddedMcpStopPromise;
    const startPromise = (async () => {
        await precedingStop;
        if (!isEmbeddedMcpStartCurrent(generation)) {
            throw createStartupCanceledError('Embedded');
        }
        const token = embeddedMcpToken ?? randomBytes(32).toString('hex');
        embeddedMcpToken = token;
        return new Promise<IEmbeddedMcpServerHandle>((resolve, reject) => {
            const identity = createLocalMcpServerIdentity(0);
            identity.name = ASSISTANT_MCP_SERVER_NAME;
            identity.title = `${identity.title} Assistant`;
            const options = createDefaultMcpRequestOptions(identity, 'internal');
            const server = createTrackedHttpServer(options, token, {
                getBinding: getActiveAssistantMcpSessionScope,
                createOptions: binding => createDefaultMcpRequestOptions(identity, 'internal', binding),
            });
            // Track the binding server immediately so a shutdown racing the bind can always close it.
            embeddedMcpServer = server;
            let settled = false;

            const failStartup = (error: Error, logFailure: boolean) => {
                if (settled) {
                    return;
                }
                settled = true;
                if (logFailure) {
                    logger.error(`Embedded MCP server failed: ${getErrorMessage(error)}`, {
                        code: 'MAIN_CODEX_MCP_INTEGRATION_FAILED',
                        context: {action: 'enable'},
                        cause: error,
                    });
                }
                if (embeddedMcpServer === server) {
                    embeddedMcpServer = null;
                    embeddedMcpServerDescriptor = null;
                }
                reject(error);
            };

            server.on('error', (error) => {
                const normalizedError = error instanceof Error ? error : new Error(getErrorMessage(error));
                if (settled) {
                    logger.error(`Embedded MCP server failed: ${getErrorMessage(normalizedError)}`, {
                        code: 'MAIN_CODEX_MCP_INTEGRATION_FAILED',
                        context: {action: 'enable'},
                        cause: normalizedError,
                    });
                    return;
                }
                const isCurrentStartup = embeddedMcpDesiredRunning
                && embeddedMcpGeneration === generation
                && embeddedMcpServer === server;
                failStartup(normalizedError, isCurrentStartup);
            });
            // If a shutdown closes the server mid-bind, Node aborts the bind and fires neither the
            // listen callback nor 'error' — only 'close'. Settle here so awaiters don't hang forever.
            server.on('close', () => {
                failStartup(createStartupCanceledError('Embedded'), false);
            });
            server.listen(0, DEFAULT_MCP_HOST, () => {
                if (settled) {
                    return;
                }
                // A shutdown that raced this bind has already detached the server.
                if (
                    !embeddedMcpDesiredRunning
                || embeddedMcpGeneration !== generation
                || embeddedMcpServer !== server
                ) {
                    void closeHttpServer(server);
                    failStartup(createStartupCanceledError('Embedded'), false);
                    return;
                }

                const address = server.address() as AddressInfo | null;
                const port = address?.port;
                if (!port) {
                    server.close();
                    failStartup(new Error('Embedded MCP server did not receive a port.'), true);
                    return;
                }

                identity.port = port;
                embeddedMcpServerDescriptor = {
                    name: identity.name,
                    title: identity.title,
                    host: identity.host,
                    port,
                    url: `http://${identity.host}:${port}`,
                };
                settled = true;
                logger.info(`Embedded MCP server ${identity.name} listening on ${embeddedMcpServerDescriptor.url}`);
                resolve({
                    descriptor: embeddedMcpServerDescriptor,
                    token,
                });
            });
        });
    })().finally(() => {
        if (embeddedMcpStartPromise === startPromise) {
            embeddedMcpStartPromise = null;
        }
    });

    embeddedMcpStartPromise = startPromise;
    return startPromise;
}

export function shutdownEmbeddedMcpServer() {
    clearAssistantMcpSessionScope();
    embeddedMcpDesiredRunning = false;
    const generation = ++embeddedMcpGeneration;
    const server = embeddedMcpServer;
    embeddedMcpServer = null;
    embeddedMcpServerDescriptor = null;
    embeddedMcpToken = null;
    const pendingStart = embeddedMcpStartPromise;
    const stopPromise = (async () => {
        await Promise.allSettled([
            closeHttpServer(server),
            ...(pendingStart ? [pendingStart] : []),
        ]);
        if (isEmbeddedMcpStopCurrent(generation)) {
            embeddedMcpToken = null;
        }
    })().finally(() => {
        if (embeddedMcpStopPromise === stopPromise) {
            embeddedMcpStopPromise = null;
        }
    });
    embeddedMcpStopPromise = stopPromise;
    return stopPromise;
}
