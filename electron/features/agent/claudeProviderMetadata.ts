import { constants } from 'node:fs';
import {
    access,
    readFile,
} from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import {
    delimiter,
    dirname,
    join,
} from 'node:path';
import { promisify } from 'node:util';
import { app } from 'electron';
import type { TAgentAssistantSpeedMode } from '@contracts/agent';
import {
    CLAUDE_ASSISTANT_DEFAULT_MODEL,
    CLAUDE_ASSISTANT_MODELS,
} from '@contracts/agentModels';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';
import { isRecord } from '@contracts/runtimeGuards';

const logger = createLogger('agent-claude-assistant');
const execFileAsync = promisify(execFile);
const requireFromHere = createRequire(import.meta.url);
const CLAUDE_CLI_DISCOVERY_TIMEOUT_MS = 5_000;

export const CLAUDE_AGENT_INSTALL_URL = 'https://code.claude.com/docs/en/agent-sdk/overview';
export const CLAUDE_AGENT_DEFAULT_MODEL = CLAUDE_ASSISTANT_DEFAULT_MODEL;
export const CLAUDE_AGENT_MODELS = CLAUDE_ASSISTANT_MODELS;
const CLAUDE_AGENT_MODEL_ALIASES = new Map<string, string>(Object.entries({
    'fable-5.1': 'fable',
    'claude-fable-5.1': 'fable',
    'claude-fable-5-1': 'fable',
    'anthropic.claude-fable-5.1': 'fable',
    'anthropic.claude-fable-5-1': 'fable',
    'claude-fable-5': 'fable',
    'anthropic.claude-fable-5': 'fable',
    'opus-5': 'opus',
    'claude-opus-5': 'opus',
    'claude-opus-5.0': 'opus',
    'claude-opus-5-0': 'opus',
    'anthropic.claude-opus-5': 'opus',
    'anthropic.claude-opus-5.0': 'opus',
    'anthropic.claude-opus-5-0': 'opus',
    'claude-opus-4-8': 'opus',
    'anthropic.claude-opus-4-8': 'opus',
    'claude-opus-4-7': 'opus',
    'anthropic.claude-opus-4-7': 'opus',
    'claude-opus-4-6': 'opus',
    'anthropic.claude-opus-4-6': 'opus',
    'sonnet-5': 'sonnet',
    'claude-sonnet-5': 'sonnet',
    'claude-sonnet-5.0': 'sonnet',
    'claude-sonnet-5-0': 'sonnet',
    'anthropic.claude-sonnet-5': 'sonnet',
    'anthropic.claude-sonnet-5.0': 'sonnet',
    'anthropic.claude-sonnet-5-0': 'sonnet',
    'claude-sonnet-4-6': 'sonnet',
    'anthropic.claude-sonnet-4-6': 'sonnet',
    'claude-sonnet-4-5': 'sonnet',
    'anthropic.claude-sonnet-4-5': 'sonnet',
    'claude-haiku-4-5': 'haiku',
    'anthropic.claude-haiku-4-5': 'haiku',
    'claude-haiku-4-5-20251001': 'haiku',
    'anthropic.claude-haiku-4-5-20251001': 'haiku',
}));
const CLAUDE_AGENT_MODEL_IDS = new Set<string>(CLAUDE_AGENT_MODELS.map(model => model.id));
const CLAUDE_AGENT_MODEL_LABELS = new Map<string, string>([
    ...CLAUDE_AGENT_MODELS.map(model => [
        model.id,
        model.label,
    ] as const),
    ...Object.entries({
        'claude-fable-5': 'Claude Fable 5',
        'anthropic.claude-fable-5': 'Claude Fable 5',
        'claude-opus-4-8': 'Claude Opus 4.8',
        'anthropic.claude-opus-4-8': 'Claude Opus 4.8',
        'claude-opus-4-7': 'Claude Opus 4.7',
        'anthropic.claude-opus-4-7': 'Claude Opus 4.7',
        'claude-opus-4-6': 'Claude Opus 4.6',
        'anthropic.claude-opus-4-6': 'Claude Opus 4.6',
        'claude-sonnet-4-6': 'Claude Sonnet 4.6',
        'anthropic.claude-sonnet-4-6': 'Claude Sonnet 4.6',
        'claude-sonnet-4-5': 'Claude Sonnet 4.5',
        'anthropic.claude-sonnet-4-5': 'Claude Sonnet 4.5',
        'claude-haiku-4-5': 'Claude Haiku 4.5',
        'anthropic.claude-haiku-4-5': 'Claude Haiku 4.5',
        'claude-haiku-4-5-20251001': 'Claude Haiku 4.5',
        'anthropic.claude-haiku-4-5-20251001': 'Claude Haiku 4.5',
    }),
] as const);
const CLAUDE_MODEL_ID_PATTERN = /^(?:claude-[a-z0-9][a-z0-9-]*|[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._/-]*|(?:global|us|eu)\.anthropic\.claude-[a-z0-9][a-z0-9-]*)(?:\[\d+m\])?$/iu;
export interface IClaudeAgentSdkInfoOptions {
    env?: NodeJS.ProcessEnv;
    resolveSdkPackageDir?: () => string | null;
    readSdkVersion?: (sdkDir: string) => Promise<string | null>;
    findBundledClaudeExecutable?: (sdkDir: string) => Promise<string | null>;
    pathIsExecutable?: (path: string | null | undefined) => Promise<boolean>;
    findClaudeOnPath?: (
        env: NodeJS.ProcessEnv,
        pathIsExecutable: (path: string | null | undefined) => Promise<boolean>,
    ) => Promise<string | null>;
}


function executableSuffix() {
    return process.platform === 'win32' ? '.exe' : '';
}

async function pathIsExecutable(path: string | null | undefined) {
    if (!path) {
        return false;
    }

    try {
        await access(path, constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

function uniqueStrings(values: Array<string | null | undefined>) {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const value of values) {
        const candidate = value?.trim();
        if (!candidate || seen.has(candidate)) {
            continue;
        }
        seen.add(candidate);
        result.push(candidate);
    }
    return result;
}

function firstNonBlank(values: Array<string | null | undefined>) {
    for (const value of values) {
        const candidate = value?.trim();
        if (candidate) {
            return candidate;
        }
    }
    return null;
}

function getClaudeExecutableNames() {
    return process.platform === 'win32'
        ? [
            'claude.cmd',
            'claude.exe',
            'claude',
        ]
        : ['claude'];
}

function getClaudeHomeDir(env: NodeJS.ProcessEnv) {
    return firstNonBlank([
        env.HOME,
        env.USERPROFILE,
    ]) ?? homedir();
}

function buildClaudePathCandidates(env: NodeJS.ProcessEnv) {
    const executableNames = getClaudeExecutableNames();
    const pathCandidates = (env.PATH ?? '')
        .split(delimiter)
        .filter(Boolean)
        .flatMap(entry => executableNames.map(name => join(entry, name)));
    const homeDir = getClaudeHomeDir(env);
    const userBinCandidates = process.platform === 'win32'
        ? [
            env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'Programs', 'Claude', 'claude.exe') : undefined,
            env.APPDATA ? join(env.APPDATA, 'npm', 'claude.cmd') : undefined,
        ]
        : executableNames.flatMap(name => [
            join(homeDir, '.local', 'bin', name),
            join(homeDir, '.claude', 'local', name),
            join(homeDir, '.bun', 'bin', name),
            join(homeDir, 'Library', 'pnpm', name),
        ]);
    const systemCandidates = process.platform === 'win32'
        ? []
        : executableNames.flatMap(name => [
            join('/opt/homebrew/bin', name),
            join('/usr/local/bin', name),
            join('/usr/bin', name),
            join('/snap/bin', name),
        ]);

    return uniqueStrings([
        env.CLAUDE_CODE_PATH,
        env.CLAUDE_CLI_PATH,
        ...pathCandidates,
        ...userBinCandidates,
        ...systemCandidates,
    ]);
}

async function findClaudeWithCommand(
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    isExecutable: (path: string | null | undefined) => Promise<boolean>,
) {
    try {
        const {stdout} = await execFileAsync(command, args, {
            encoding: 'utf8',
            env: {
                ...process.env,
                ...env,
            },
            timeout: CLAUDE_CLI_DISCOVERY_TIMEOUT_MS,
            windowsHide: true,
        });
        const matches = stdout
            .split(/\r?\n/u)
            .map(line => line.trim())
            .filter(Boolean);
        for (const match of matches) {
            if (await isExecutable(match)) {
                return match;
            }
        }
    } catch {
        return null;
    }
    return null;
}

async function findClaudeInLoginShell(
    env: NodeJS.ProcessEnv,
    isExecutable: (path: string | null | undefined) => Promise<boolean>,
) {
    if (process.platform === 'win32') {
        return null;
    }

    const shellPath = firstNonBlank([env.SHELL]) ?? '/bin/zsh';
    if (!(await isExecutable(shellPath))) {
        return null;
    }
    return findClaudeWithCommand(shellPath, [
        '-lc',
        'command -v claude',
    ], env, isExecutable);
}

async function findClaudeOnPath(
    env: NodeJS.ProcessEnv = process.env,
    isExecutable: (path: string | null | undefined) => Promise<boolean> = pathIsExecutable,
) {
    for (const candidate of buildClaudePathCandidates(env)) {
        if (await isExecutable(candidate)) {
            return candidate;
        }
    }

    if (process.platform === 'win32') {
        return findClaudeWithCommand('where.exe', ['claude'], env, isExecutable);
    }

    const shCandidate = await findClaudeWithCommand('/bin/sh', [
        '-lc',
        'command -v claude',
    ], env, isExecutable);
    if (shCandidate) {
        return shCandidate;
    }
    return findClaudeInLoginShell(env, isExecutable);
}

function platformNativePackageNames() {
    if (process.platform === 'darwin') {
        return [`@anthropic-ai/claude-agent-sdk-darwin-${process.arch}`];
    }
    if (process.platform === 'win32') {
        return [`@anthropic-ai/claude-agent-sdk-win32-${process.arch}`];
    }
    if (process.platform === 'linux') {
        return [
            `@anthropic-ai/claude-agent-sdk-linux-${process.arch}`,
            `@anthropic-ai/claude-agent-sdk-linux-${process.arch}-musl`,
        ];
    }
    return [];
}

function resolveSdkPackageDir() {
    const sdkEntry = requireFromHere.resolve('@anthropic-ai/claude-agent-sdk');
    return dirname(sdkEntry);
}

async function readSdkVersion(sdkDir: string) {
    try {
        const rawPackage = await readFile(join(sdkDir, 'package.json'), 'utf-8');
        const parsed: unknown = JSON.parse(rawPackage);
        return isRecord(parsed) && typeof parsed.version === 'string' ? parsed.version : null;
    } catch {
        return null;
    }
}

async function findBundledClaudeExecutable(sdkDir: string) {
    const sdkRequire = createRequire(join(sdkDir, 'sdk.mjs'));
    for (const packageName of platformNativePackageNames()) {
        try {
            const packageJsonPath = sdkRequire.resolve(`${packageName}/package.json`);
            const executablePath = join(dirname(packageJsonPath), `claude${executableSuffix()}`);
            if (await pathIsExecutable(executablePath)) {
                return executablePath;
            }
        } catch {
            // Optional native packages are platform-specific; try the next name.
        }
    }
    return null;
}

function resolveOptionalSdkPackageDir(resolvePackageDir: () => string | null) {
    try {
        return resolvePackageDir();
    } catch (error) {
        const message = `Claude Agent SDK package metadata is unavailable: ${getErrorMessage(error)}`;
        if (app.isPackaged) {
            logger.info(message);
        } else {
            logger.warn(message);
        }
        return null;
    }
}

export async function getClaudeAgentSdkInfo(options: IClaudeAgentSdkInfoOptions = {}): Promise<IClaudeAssistantProviderInfo> {
    const env = options.env ?? process.env;
    const resolvePackageDir = options.resolveSdkPackageDir ?? resolveSdkPackageDir;
    const readVersion = options.readSdkVersion ?? readSdkVersion;
    const findBundledExecutable = options.findBundledClaudeExecutable ?? findBundledClaudeExecutable;
    const findPathExecutable = options.findClaudeOnPath ?? findClaudeOnPath;
    const isExecutable = options.pathIsExecutable ?? pathIsExecutable;
    const envPath = env.CLAUDE_CODE_PATH ?? env.CLAUDE_CLI_PATH ?? null;
    const sdkDir = resolveOptionalSdkPackageDir(resolvePackageDir);

    try {
        const [
            version,
            pathExecutable,
            bundledExecutable,
        ] = await Promise.all([
            sdkDir ? readVersion(sdkDir) : Promise.resolve(null),
            findPathExecutable(env, isExecutable),
            sdkDir ? findBundledExecutable(sdkDir) : Promise.resolve(null),
        ]);
        const executablePath = await isExecutable(envPath)
            ? envPath
            : await isExecutable(pathExecutable)
                ? pathExecutable
                : bundledExecutable;
        return {
            installed: Boolean(executablePath),
            version,
            executablePath,
            ...(executablePath
                ? {}
                : { error: sdkDir
                    ? 'Claude Agent SDK native binary was not found. Install Claude Code, reinstall optional dependencies, or set CLAUDE_CODE_PATH to a local claude executable.'
                    : 'Claude Code executable was not found. Install Claude Code or set CLAUDE_CODE_PATH to a local claude executable.' }),
        };
    } catch (error) {
        return {
            installed: false,
            version: null,
            executablePath: null,
            error: getErrorMessage(error),
        };
    }
}


export type TClaudeAuthState = 'signed-in' | 'signed-out' | 'unknown';

export interface IClaudeAssistantProviderInfo {
    installed: boolean;
    version: string | null;
    executablePath: string | null;
    error?: string;
}

const CLAUDE_AUTH_ENV_VARS = [
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
] as const;

function trimmedEnv(name: string) {
    const value = process.env[name]?.trim();
    if (value) {
        return value;
    }
    return undefined;
}

function resolveClaudeConfigDir() {
    const override = trimmedEnv('CLAUDE_CONFIG_DIR');
    if (override) {
        return override;
    }

    const home = trimmedEnv('HOME')
        ?? (process.platform === 'win32' ? trimmedEnv('USERPROFILE') : undefined)
        ?? homedir();
    return join(home, '.claude');
}

function hasClaudeAuthEnv() {
    return CLAUDE_AUTH_ENV_VARS.some(name => trimmedEnv(name) !== undefined);
}

// Cheap env + credentials-file check used on the poll path. No subprocess, no keychain probe.
export async function detectClaudeAuthState(): Promise<TClaudeAuthState> {
    if (hasClaudeAuthEnv()) {
        return 'signed-in';
    }

    try {
        await access(join(resolveClaudeConfigDir(), '.credentials.json'), constants.R_OK);
        return 'signed-in';
    } catch {
        // Credentials file absent; fall through to platform-specific handling.
    }

    // On macOS the OAuth credentials usually live in the login keychain, which is too
    // expensive to probe per poll; treat as inconclusive so a live session can confirm.
    return process.platform === 'darwin' ? 'unknown' : 'signed-out';
}

// Only true authentication failures demote auth state. Billing/rate-limit (quota,
// credit balance) and permission (forbidden, 403) errors are deliberately excluded so
// a signed-in user is not bounced to the sign-in view by an unrelated failure.
const CLAUDE_AUTH_ERROR_MARKERS = [
    'invalid api key',
    'invalid x-api-key',
    'unauthorized',
    '(401)',
    'oauth token',
    'please run /login',
    'please log in',
    'not logged in',
    'no credentials',
    'login required',
    'authentication_error',
] as const;

export function isClaudeAuthErrorMessage(message: string) {
    const normalized = message.toLowerCase();
    return CLAUDE_AUTH_ERROR_MARKERS.some(marker => normalized.includes(marker));
}


export function getClaudeAssistantModelLabel(model: string) {
    const canonicalModel = CLAUDE_AGENT_MODEL_ALIASES.get(model);
    return CLAUDE_AGENT_MODEL_LABELS.get(model)
        ?? (canonicalModel ? CLAUDE_AGENT_MODEL_LABELS.get(canonicalModel) : undefined)
        ?? model;
}

export function normalizeClaudeAssistantModel(model: string | null | undefined) {
    const trimmed = model?.trim();
    if (!trimmed) {
        return CLAUDE_AGENT_DEFAULT_MODEL;
    }

    if (CLAUDE_AGENT_MODEL_IDS.has(trimmed) || CLAUDE_MODEL_ID_PATTERN.test(trimmed)) {
        return trimmed;
    }

    const normalized = CLAUDE_AGENT_MODEL_ALIASES.get(trimmed) ?? trimmed;
    return CLAUDE_AGENT_MODEL_IDS.has(normalized)
        ? normalized
        : CLAUDE_AGENT_DEFAULT_MODEL;
}

function isClaudeAssistantFastModeModel(model: string) {
    const normalized = normalizeClaudeAssistantModel(model).toLowerCase();
    return normalized === 'opus'
        || normalized.startsWith('opus[')
        || normalized.includes('claude-opus-')
        || normalized.includes('/opus-')
        || normalized.includes('.opus-');
}

export function shouldUseClaudeAssistantFastMode(
    model: string,
    speedMode: TAgentAssistantSpeedMode,
) {
    return speedMode === 'fast' && isClaudeAssistantFastModeModel(model);
}

export function shouldRefuseClaudeContextContinuation(messageCount: number, providerThreadId: string | null) {
    return messageCount > 0 && !providerThreadId;
}
