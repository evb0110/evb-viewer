import {getAssistantShellEnvironment} from '@electron/features/agent/assistantShellEnvironment';
import {stat} from 'node:fs/promises';
import {getErrorMessage} from '@electron/utils/error';
import {resolveCodexProcessLaunch} from '@electron/features/agent/codexProcessLaunch';
import {resolveInstalledAssistantExecutable} from '@electron/features/agent/assistantLocalSetups';
import {runNativeCommand} from '@electron/native-tools/runNativeCommand';
import {NativeProcessError} from '@electron/native-tools/processResult';
import {getUnprovenNativeTerminationDetail} from '@electron/utils/nativeTerminationProof';

export const CODEX_APP_INSTALL_URL = 'https://developers.openai.com/codex/app';
const MIN_CODEX_APP_SERVER_VERSION = '0.157.1';
const CODEX_COMMAND_TIMEOUT_MS = 15_000;
const CODEX_COMMAND_MAX_OUTPUT_BYTES = 256 * 1024;
interface ICodexCliCommandResult {
    ok: boolean;
    stdout: string;
    stderr: string;
    exitCode: number | null;
}
export interface ICodexCliInfo {
    installed: boolean;
    path: string | null;
    version: string | null;
    isVersionSupported: boolean;
    minimumVersion: string;
}
export async function resolveCodexCliPath(env?: NodeJS.ProcessEnv) {
    return resolveInstalledAssistantExecutable('codex', env ?? (await getAssistantShellEnvironment()));
}
// Codex reports a failure, including a timeout or a launch that never ran, as a
// result rather than an error, so callers can show what the command printed.
export async function runCodexCli(
    codexPath: string,
    args: string[],
    options: {env?: NodeJS.ProcessEnv} = {},
): Promise<ICodexCliCommandResult> {
    const env = {
        NO_COLOR: '1',
        ...(await getAssistantShellEnvironment()),
        ...options.env,
    };
    try {
        const launch = resolveCodexProcessLaunch(codexPath, args);
        const result = await runNativeCommand(launch.command, launch.args, {
            env,
            includeProcessEnv: false,
            timeoutMs: CODEX_COMMAND_TIMEOUT_MS,
            maxStdoutBytes: CODEX_COMMAND_MAX_OUTPUT_BYTES,
            maxStderrBytes: CODEX_COMMAND_MAX_OUTPUT_BYTES,
            rejectOnStdoutTruncation: false,
            commandLabel: 'Codex',
        });
        return {
            ok: true,
            ...result,
        };
    } catch (error) {
        // A process that ran and failed returns what it printed; a timeout returns
        // what it printed before the deadline followed by the runner's message;
        // a launch failure returns the message.
        const failed = error instanceof NativeProcessError ? error : null;
        const captured = error as {stdout?: string; stderr?: string} | null | undefined;
        const message = getErrorMessage(error);
        const diagnostic = failed ? failed.stderr : captured?.stderr ? `${captured.stderr.trimEnd()}\n${message}` : message;
        const unproven = getUnprovenNativeTerminationDetail(error);
        return {
            ok: false,
            stdout: captured?.stdout ?? '',
            stderr: unproven ? `${diagnostic}; ${unproven}` : diagnostic,
            exitCode: failed?.exitCode ?? null,
        };
    }
}
function parseCodexVersion(stdout: string) {
    const match = stdout.match(/(?:codex-cli\s+)?(\d+\.\d+\.\d+)/u);
    return match?.[1] ?? null;
}

function compareVersions(left: string, right: string) {
    const leftParts = left.split('.').map((part) => Number.parseInt(part, 10));
    const rightParts = right.split('.').map((part) => Number.parseInt(part, 10));
    for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
        const rawLeftPart = leftParts[index];
        const rawRightPart = rightParts[index];
        const leftPart = typeof rawLeftPart === 'number' && Number.isFinite(rawLeftPart) ? rawLeftPart : 0;
        const rightPart = typeof rawRightPart === 'number' && Number.isFinite(rawRightPart) ? rawRightPart : 0;
        if (leftPart !== rightPart) {
            return leftPart - rightPart;
        }
    }
    return 0;
}

function isCodexVersionSupported(version: string | null) {
    return version !== null && compareVersions(version, MIN_CODEX_APP_SERVER_VERSION) >= 0;
}

let codexCliVersion: {
    identity: string;
    result: Promise<string | null>;
} | null = null;

async function getCodexVersion(codexPath: string) {
    // Follow symlinks and include ctime so same-size replacements with preserved
    // mtime still invalidate successful metadata. Discovery remains fresh.
    const identity = await (async () => {
        const launch = resolveCodexProcessLaunch(codexPath, ['--version']);
        const stats = await stat(launch.sourcePath, {bigint: true});
        return [
            codexPath,
            launch.command,
            launch.sourcePath,
            stats.dev,
            stats.ino,
            stats.size,
            stats.mtimeNs,
            stats.ctimeNs,
            stats.mode,
        ].join(':');
    })().catch(() => null);
    if (identity && codexCliVersion?.identity === identity) {
        return codexCliVersion.result;
    }
    const result = runCodexCli(codexPath, ['--version'])
        .then((versionResult) => {
            const version = versionResult.ok ? parseCodexVersion(versionResult.stdout || versionResult.stderr) : null;
            if (version === null && codexCliVersion?.result === result) {
                codexCliVersion = null;
            }
            return version;
        })
        .catch((error: unknown) => {
            if (codexCliVersion?.result === result) {
                codexCliVersion = null;
            }
            throw error;
        });
    codexCliVersion = identity
        ? {
              identity,
              result,
          }
        : null;
    return result;
}

export async function getCodexCliInfo(): Promise<ICodexCliInfo> {
    const codexPath = await resolveCodexCliPath();
    if (!codexPath) {
        codexCliVersion = null;
        return {
            installed: false,
            path: null,
            version: null,
            isVersionSupported: false,
            minimumVersion: MIN_CODEX_APP_SERVER_VERSION,
        };
    }

    const version = await getCodexVersion(codexPath);
    return {
        installed: true,
        path: codexPath,
        version,
        isVersionSupported: isCodexVersionSupported(version),
        minimumVersion: MIN_CODEX_APP_SERVER_VERSION,
    };
}
