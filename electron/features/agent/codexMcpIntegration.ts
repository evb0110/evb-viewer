import {
    dialog,
    shell,
} from 'electron';
import type {
    BrowserWindow,
    MessageBoxOptions,
} from 'electron';
import {
    open, readFile, rename, writeFile,
} from 'node:fs/promises';
import {homedir} from 'node:os';
import {
    dirname, join,
} from 'node:path';
import type {
    IAgentMcpIntegrationStatus,
    IAgentMcpIntegrationUpdateResult,
    TAgentMcpCodexRegistrationState,
} from '@contracts/agent';
import {
    getLocalMcpCodexRegistrationTransport,
    getLocalMcpServerDescriptor,
    getLocalMcpSetupSnippets,
    isLocalMcpServerRunning,
    shutdownLocalMcpServer,
    startLocalMcpServer,
} from '@electron/features/agent/mcpServer';
import {
    loadSettings,
    updateSettings,
} from '@electron/settings';
import {
    CODEX_APP_INSTALL_URL,
    resolveCodexCliPath,
    runCodexCli,
} from '@electron/features/agent/codexCli';
import { te } from '@electron/te';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';
import {createIsoTimestamp} from '@contracts/timestamps';

const logger = createLogger('agent-codex-mcp');
const MCP_TOKEN_PLACEHOLDER = '__EVB_MCP_TOKEN_PLACEHOLDER__';

interface ICodexServerConfig {
    enabled?: unknown;
    transport?: {
        type?: unknown;
        url?: unknown;
        command?: unknown;
        args?: unknown;
        env?: unknown;
    };
}

interface IExternalMcpStartupError {
    message: string;
    code?: string;
    occurredAt: string;
}

let lastExternalMcpStartupError: IExternalMcpStartupError | null = null;

function normalizeExternalMcpStartupError(error: unknown): IExternalMcpStartupError {
    const code = typeof error === 'object'
        && error !== null
        && 'code' in error
        && typeof error.code === 'string'
        ? error.code
        : undefined;
    return {
        message: getErrorMessage(error),
        ...(code ? {code} : {}),
        occurredAt: new Date().toISOString(),
    };
}

async function startExternalMcpServer() {
    try {
        await startLocalMcpServer();
        lastExternalMcpStartupError = null;
    } catch (error) {
        lastExternalMcpStartupError = normalizeExternalMcpStartupError(error);
        throw error;
    }
}

async function disableExternalMcpServer() {
    await shutdownLocalMcpServer();
    lastExternalMcpStartupError = null;
}

function getTransportEnv(config: ICodexServerConfig | null) {
    const env = config?.transport?.env;
    return typeof env === 'object' && env !== null && !Array.isArray(env)
        ? env as Record<string, unknown>
        : null;
}

async function createBaseStatus(): Promise<Omit<IAgentMcpIntegrationStatus, 'enabled'>> {
    const descriptor = getLocalMcpServerDescriptor();
    let setupSnippets: IAgentMcpIntegrationStatus['setupSnippets'];
    let setupError: string | undefined;
    try {
        setupSnippets = await getLocalMcpSetupSnippets();
    } catch (error) {
        setupError = getErrorMessage(error);
    }
    return {
        serverName: descriptor.name,
        serverUrl: descriptor.url,
        serverRunning: isLocalMcpServerRunning(),
        codexInstalled: false,
        codexPath: null,
        codexConfigured: false,
        codexRegistrationState: 'unknown',
        installUrl: CODEX_APP_INSTALL_URL,
        lastCheckedAt: createIsoTimestamp(),
        ...(setupSnippets ? {setupSnippets} : {}),
        ...(setupError ? {error: setupError} : {}),
    };
}

async function createStatus(
    enabled: boolean,
    patch: Partial<Omit<IAgentMcpIntegrationStatus, 'enabled'>> = {},
): Promise<IAgentMcpIntegrationStatus> {
    return {
        enabled,
        ...await createBaseStatus(),
        ...patch,
        ...(lastExternalMcpStartupError ? {error: lastExternalMcpStartupError.message} : {}),
    };
}

function parseCodexServerConfig(stdout: string): ICodexServerConfig | null {
    try {
        const parsed: unknown = JSON.parse(stdout);
        return parsed && typeof parsed === 'object'
            ? parsed
            : null;
    } catch {
        return null;
    }
}

function redactMcpToken(value: string, token: string) {
    return token.length > 0
        ? value.split(token).join('<redacted>')
        : value;
}

function getCodexConfigPath() {
    // An empty CODEX_HOME is the same as an unset one; joining on it would
    // resolve the config relative to the working directory.
    const configuredHome = process.env.CODEX_HOME?.trim();
    const codexHome = configuredHome === '' ? undefined : configuredHome;
    return join(codexHome ?? join(homedir(), '.codex'), 'config.toml');
}

async function syncDirectory(path: string) {
    const directory = await open(path, 'r');
    try {
        await directory.sync();
    } finally {
        await directory.close();
    }
}

/**
 * `codex mcp add` writes the token straight into argv, where any other user on
 * the machine can read it out of the process table. Registration therefore
 * passes a placeholder and the real token is substituted here, after the CLI
 * has finished rewriting the config.
 *
 * This is the user's global Codex config, so a half-written file would cost
 * them every unrelated server they have registered: stage the new contents
 * beside it and rename over the original instead of truncating in place.
 */
async function persistCodexMcpToken(token: string) {
    const configPath = getCodexConfigPath();
    const config = await readFile(configPath, 'utf8');
    const placeholder = `EVB_MCP_TOKEN = ${JSON.stringify(MCP_TOKEN_PLACEHOLDER)}`;
    const occurrences = config.split(placeholder).length - 1;
    if (occurrences !== 1) {
        throw new Error('Codex MCP registration did not produce exactly one token placeholder.');
    }
    const replacement = `EVB_MCP_TOKEN = ${JSON.stringify(token)}`;
    const configDirectory = dirname(configPath);
    const stagingPath = `${configPath}.evb-${process.pid}.tmp`;
    await writeFile(stagingPath, config.replace(placeholder, replacement), {
        encoding: 'utf8',
        mode: 0o600,
    });
    await rename(stagingPath, configPath);
    await syncDirectory(configDirectory);
}

async function getCodexRegistrationState(codexPath: string) {
    const descriptor = getLocalMcpServerDescriptor();
    const {
        launchConfig,
        token,
    } = await getLocalMcpCodexRegistrationTransport();
    const result = await runCodexCli(codexPath, [
        'mcp',
        'get',
        descriptor.name,
        '--json',
    ]);
    if (!result.ok) {
        return {
            state: 'missing' as TAgentMcpCodexRegistrationState,
            configured: false,
        };
    }

    const config = parseCodexServerConfig(result.stdout);
    const transportEnv = getTransportEnv(config);
    const configured = config?.enabled === true
        && config.transport?.type === 'stdio'
        && config.transport.command === launchConfig.command
        && Array.isArray(config.transport.args)
        && config.transport.args.length === launchConfig.args.length
        && config.transport.args.every((arg, index) => arg === launchConfig.args[index])
        && transportEnv !== null
        && transportEnv.ELECTRON_RUN_AS_NODE === '1'
        && transportEnv.EVB_MCP_URL === descriptor.url
        && transportEnv.EVB_MCP_TOKEN === token;
    return {
        state: configured
            ? 'configured' as const
            : 'mismatched' as const,
        configured,
    };
}

async function removeCodexRegistration(codexPath: string) {
    await runCodexCli(codexPath, [
        'mcp',
        'remove',
        getLocalMcpServerDescriptor().name,
    ]);
}

async function registerCodexMcp(codexPath: string) {
    const {
        descriptor,
        launchConfig,
        token,
    } = await getLocalMcpCodexRegistrationTransport();
    await removeCodexRegistration(codexPath);
    const result = await runCodexCli(codexPath, [
        'mcp',
        'add',
        descriptor.name,
        '--env',
        'ELECTRON_RUN_AS_NODE=1',
        '--env',
        `EVB_MCP_URL=${launchConfig.env.EVB_MCP_URL ?? '<missing>'}`,
        '--env',
        `EVB_MCP_TOKEN=${MCP_TOKEN_PLACEHOLDER}`,
        '--',
        launchConfig.command,
        ...launchConfig.args,
    ]);
    if (!result.ok) {
        const stderr = redactMcpToken(result.stderr, token).trim();
        const stdout = redactMcpToken(result.stdout, token).trim();
        throw new Error(stderr || stdout || 'Codex MCP registration failed.');
    }
    try {
        await persistCodexMcpToken(token);
    } catch (error) {
        // The registration on disk still carries the placeholder, so leaving it
        // would give the assistant a server that authenticates with a literal
        // sentinel. Drop it and let the caller see the original failure.
        await removeCodexRegistration(codexPath).catch(() => undefined);
        throw error;
    }
}

async function showInstallCodexDialog(parentWindow?: BrowserWindow | null) {
    const openInstall = te('dialogs.agentMcp.openInstall');
    const cancel = te('dialogs.agentMcp.cancel');
    const options = {
        type: 'info',
        title: te('dialogs.agentMcp.codexMissingTitle'),
        message: te('dialogs.agentMcp.codexMissingMessage'),
        detail: te('dialogs.agentMcp.codexMissingDetail'),
        buttons: [
            openInstall,
            cancel,
        ],
        defaultId: 0,
        cancelId: 1,
    } satisfies MessageBoxOptions;
    const { response } = parentWindow
        ? await dialog.showMessageBox(parentWindow, options)
        : await dialog.showMessageBox(options);
    if (response === 0) {
        await shell.openExternal(CODEX_APP_INSTALL_URL);
    }
}

async function confirmCodexMutation(parentWindow: BrowserWindow | null | undefined, enabled: boolean) {
    const descriptor = getLocalMcpServerDescriptor();
    const allowLabel = enabled
        ? te('dialogs.agentMcp.enableAllow')
        : te('dialogs.agentMcp.disableAllow');
    const cancelLabel = te('dialogs.agentMcp.cancel');
    const options = {
        type: 'question',
        title: enabled
            ? te('dialogs.agentMcp.enableTitle')
            : te('dialogs.agentMcp.disableTitle'),
        message: enabled
            ? te('dialogs.agentMcp.enableMessage')
            : te('dialogs.agentMcp.disableMessage'),
        detail: te('dialogs.agentMcp.configDetail', {
            server: descriptor.name,
            url: descriptor.url,
        }),
        buttons: [
            allowLabel,
            cancelLabel,
        ],
        defaultId: 0,
        cancelId: 1,
    } satisfies MessageBoxOptions;
    const { response } = parentWindow
        ? await dialog.showMessageBox(parentWindow, options)
        : await dialog.showMessageBox(options);
    return response === 0;
}

export async function getAgentMcpIntegrationStatus(): Promise<IAgentMcpIntegrationStatus> {
    const settings = await loadSettings();
    const codexPath = await resolveCodexCliPath();
    if (!codexPath) {
        return createStatus(settings.agentMcpEnabled, {codexRegistrationState: 'unknown'});
    }

    try {
        const registration = await getCodexRegistrationState(codexPath);
        return await createStatus(settings.agentMcpEnabled, {
            codexInstalled: true,
            codexPath,
            codexConfigured: registration.configured,
            codexRegistrationState: registration.state,
        });
    } catch (error) {
        return createStatus(settings.agentMcpEnabled, {
            codexInstalled: true,
            codexPath,
            codexRegistrationState: 'unknown',
            error: getErrorMessage(error),
        });
    }
}

async function setAgentMcpSetting(enabled: boolean) {
    await updateSettings(settings => {
        settings.agentMcpEnabled = enabled;
        return undefined;
    });
}

export async function setAgentMcpIntegrationEnabled(
    enabled: boolean,
    parentWindow?: BrowserWindow | null,
): Promise<IAgentMcpIntegrationUpdateResult> {
    const previousSettings = await loadSettings();
    const codexPath = await resolveCodexCliPath();
    if (!codexPath) {
        if (!enabled) {
            await disableExternalMcpServer();
            await setAgentMcpSetting(false);
            return {
                ok: true,
                status: await getAgentMcpIntegrationStatus(),
            };
        }
        await showInstallCodexDialog(parentWindow);
        const status = await getAgentMcpIntegrationStatus();
        return {
            ok: false,
            status,
            error: te('dialogs.agentMcp.codexMissingTitle'),
        };
    }

    const confirmed = await confirmCodexMutation(parentWindow, enabled);
    if (!confirmed) {
        return {
            ok: false,
            cancelled: true,
            status: await getAgentMcpIntegrationStatus(),
        };
    }

    try {
        if (enabled) {
            await startExternalMcpServer();
            await registerCodexMcp(codexPath);
            await setAgentMcpSetting(true);
        } else {
            await removeCodexRegistration(codexPath);
            await disableExternalMcpServer();
            await setAgentMcpSetting(false);
        }
        return {
            ok: true,
            status: await getAgentMcpIntegrationStatus(),
        };
    } catch (error) {
        logger.error(
            `Failed to ${enabled ? 'enable' : 'disable'} Codex MCP integration: ${getErrorMessage(error)}`,
            {
                code: 'MAIN_CODEX_MCP_INTEGRATION_FAILED',
                context: {action: enabled ? 'enable' : 'disable'},
                cause: error,
            },
        );
        if (enabled && !previousSettings.agentMcpEnabled) {
            await shutdownLocalMcpServer();
        }
        return {
            ok: false,
            status: await getAgentMcpIntegrationStatus(),
            error: getErrorMessage(error),
        };
    }
}

export async function syncAgentMcpServerWithSettings() {
    const settings = await loadSettings().catch((error: unknown) => {
        logger.warn(`Failed to load external MCP setting; continuing without startup sync: ${getErrorMessage(error)}`);
        return null;
    });
    if (!settings) {
        return;
    }

    try {
        if (settings.agentMcpEnabled) {
            await startExternalMcpServer();
        } else {
            await disableExternalMcpServer();
        }
    } catch (error) {
        lastExternalMcpStartupError ??= normalizeExternalMcpStartupError(error);
        logger.warn(`External MCP startup is unavailable; continuing without it: ${getErrorMessage(error)}`);
        await shutdownLocalMcpServer().catch((shutdownError: unknown) => {
            logger.warn(`Failed to clean up external MCP startup: ${getErrorMessage(shutdownError)}`);
        });
    }
}
