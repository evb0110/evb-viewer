import {stat} from 'node:fs/promises';
import {spawn} from 'child_process';
import {getErrorMessage} from '@electron/utils/error';
import {resolveCodexProcessLaunch} from '@electron/features/agent/codexProcessLaunch';
import {resolveInstalledAssistantExecutable} from '@electron/features/agent/assistantLocalSetups';
import {createDetachedChildProcessSpawnOptions, terminateDetachedChildProcess} from '@electron/utils/nativeChildProcess';

export const CODEX_APP_INSTALL_URL = 'https://developers.openai.com/codex/app';
const MIN_CODEX_APP_SERVER_VERSION = '0.157.1';
const CODEX_COMMAND_TIMEOUT_MS = 15_000;
const CODEX_COMMAND_MAX_OUTPUT_CHARS = 256 * 1024;
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
export function resolveCodexCliPath(env: NodeJS.ProcessEnv = process.env) {
    return resolveInstalledAssistantExecutable('codex', env);
}
function runCommand(
    command: string,
    args: string[],
    timeoutMs = CODEX_COMMAND_TIMEOUT_MS,
    options: {
        env?: NodeJS.ProcessEnv;
        onStdout?: (chunk: string) => void;
        onStderr?: (chunk: string) => void;
    } = {},
): Promise<ICodexCliCommandResult> {
    const appendBoundedOutput = (existing: string, chunk: string) => {
        if (existing.length >= CODEX_COMMAND_MAX_OUTPUT_CHARS) {
            return existing;
        }
        return `${existing}${chunk}`.slice(0, CODEX_COMMAND_MAX_OUTPUT_CHARS);
    };
    return new Promise((resolve) => {
        let launch: ReturnType<typeof resolveCodexProcessLaunch>;
        try {
            launch = resolveCodexProcessLaunch(command, args);
        } catch (error) {
            resolve({
                ok: false,
                stdout: '',
                stderr: getErrorMessage(error),
                exitCode: null,
            });
            return;
        }
        const child = spawn(launch.command, launch.args, createDetachedChildProcessSpawnOptions({
            env: {
                ...process.env,
                NO_COLOR: '1',
                ...options.env,
            },
            shell: launch.shell,
            stdio: [
                'pipe',
                'pipe',
                'pipe',
            ],
            windowsHide: true,
        }));
        const childStdout = child.stdout;
        const childStderr = child.stderr;
        let stdout = '';
        let stderr = '';
        let settled = false;
        let timingOut = false;
        const settleTimeout = (terminated: boolean) => {
            if (settled) {
                return;
            }
            settled = true;
            resolve({
                ok: false,
                stdout,
                stderr: stderr || (terminated
                    ? 'Command timed out.'
                    : 'Command timed out and its process tree did not terminate.'),
                exitCode: null,
            });
        };
        const timeout = setTimeout(() => {
            if (settled || timingOut) {
                return;
            }
            timingOut = true;
            void terminateDetachedChildProcess(child, 1_000).then(
                settleTimeout,
                () => settleTimeout(false),
            );
        }, timeoutMs);

        childStdout.setEncoding('utf8');
        childStderr.setEncoding('utf8');
        childStdout.on('data', (chunk: string) => {
            stdout = appendBoundedOutput(stdout, chunk);
            options.onStdout?.(chunk);
        });
        childStderr.on('data', (chunk: string) => {
            stderr = appendBoundedOutput(stderr, chunk);
            options.onStderr?.(chunk);
        });
        child.on('error', (error) => {
            if (settled || timingOut) {
                return;
            }
            clearTimeout(timeout);
            settled = true;
            resolve({
                ok: false,
                stdout,
                stderr: getErrorMessage(error),
                exitCode: null,
            });
        });
        child.on('close', (exitCode) => {
            if (settled || timingOut) {
                return;
            }
            clearTimeout(timeout);
            settled = true;
            resolve({
                ok: exitCode === 0,
                stdout,
                stderr,
                exitCode,
            });
        });
    });
}

export function runCodexCli(codexPath: string, args: string[], options: {env?: NodeJS.ProcessEnv} = {}) {
    return runCommand(codexPath, args, CODEX_COMMAND_TIMEOUT_MS, options);
}
function parseCodexVersion(stdout: string) {
    const match = stdout.match(/(?:codex-cli\s+)?(\d+\.\d+\.\d+)/u);
    return match?.[1] ?? null;
}

function compareVersions(left: string, right: string) {
    const leftParts = left.split('.').map(part => Number.parseInt(part, 10));
    const rightParts = right.split('.').map(part => Number.parseInt(part, 10));
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
    const result = runCodexCli(codexPath, ['--version']).then(versionResult => {
        const version = versionResult.ok ? parseCodexVersion(versionResult.stdout || versionResult.stderr) : null;
        if (version === null && codexCliVersion?.result === result) {
            codexCliVersion = null;
        }
        return version;
    }).catch((error: unknown) => {
        if (codexCliVersion?.result === result) {
            codexCliVersion = null;
        }
        throw error;
    });
    codexCliVersion = identity ? {
        identity,
        result,
    } : null;
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
