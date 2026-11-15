import {sanitizeAssistantProviderText} from '@electron/features/agent/assistantErrorEnvelope';
import {constants, existsSync} from 'node:fs';
import {
    access,
    readFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import {
    dirname,
    join,
} from 'node:path';
import { app } from 'electron';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';
import {resolveInstalledAssistantExecutable} from '@electron/features/agent/assistantLocalSetups';
import { isRecord } from '@contracts/runtimeGuards';

const logger = createLogger('agent-claude-assistant');
const requireFromHere = createRequire(import.meta.url);
export interface IClaudeAgentSdkInfoOptions {
    env?: NodeJS.ProcessEnv;
    resolveSdkPackageDir?: () => string | null;
    readSdkVersion?: (sdkDir: string) => Promise<string | null>;
    pathIsExecutable?: (path: string | null | undefined) => Promise<boolean>;
    findClaudeOnPath?: (
        env: NodeJS.ProcessEnv,
        pathIsExecutable: (path: string | null | undefined) => Promise<boolean>,
    ) => Promise<string | null>;
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

// Adapted from T3 Code Drivers/ClaudeExecutable.ts (0b6f482dc5), MIT.
export function resolveClaudeSdkExecutablePath(binaryPath: string) {
    if (process.platform !== 'win32' || !/\.(?:cmd|bat|ps1)$/iu.test(binaryPath)) return binaryPath;
    const directory = dirname(binaryPath);
    for (const entry of ['bin/claude.exe', 'cli.js']) {
        const candidate = join(directory, 'node_modules', '@anthropic-ai', 'claude-code', entry);
        if (existsSync(candidate)) return candidate;
    }
    throw new Error('Claude launcher cannot be run by the SDK. Select the installed Claude executable in Settings.');
}
async function findClaudeOnPath(env: NodeJS.ProcessEnv) {
    const binary = await resolveInstalledAssistantExecutable('claude', env);
    return binary ? resolveClaudeSdkExecutablePath(binary) : null;
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

function resolveOptionalSdkPackageDir(resolvePackageDir: () => string | null) {
    try {
        return resolvePackageDir();
    } catch (error) {
        const message = `Claude Agent SDK package metadata is unavailable: ${sanitizeAssistantProviderText(getErrorMessage(error))}`;
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
    const findPathExecutable = options.findClaudeOnPath ?? findClaudeOnPath;
    const isExecutable = options.pathIsExecutable ?? pathIsExecutable;
    const envPath = env.CLAUDE_CODE_PATH ?? env.CLAUDE_CLI_PATH ?? null;
    const sdkDir = resolveOptionalSdkPackageDir(resolvePackageDir);

    try {
        const [
            version,
            pathExecutable,
        ] = await Promise.all([
            sdkDir ? readVersion(sdkDir) : Promise.resolve(null),
            findPathExecutable(env, isExecutable),
        ]);
        const executablePath = await isExecutable(envPath)
            ? envPath
            : await isExecutable(pathExecutable)
                ? pathExecutable
                : null;
        return {
            installed: Boolean(executablePath),
            version,
            executablePath,
            ...(executablePath
                ? {}
                : { error: 'Claude Code executable was not found. Install Claude Code or set the executable in Settings.' }),
        };
    } catch (error) {
        return {
            installed: false,
            version: null,
            executablePath: null,
            error: sanitizeAssistantProviderText(getErrorMessage(error)),
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


export function shouldRefuseClaudeContextContinuation(messageCount: number, providerThreadId: string | null) {
    return messageCount > 0 && !providerThreadId?.trim();
}
