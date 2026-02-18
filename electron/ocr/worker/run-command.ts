import { spawn } from 'child_process';
import { dirname } from 'path';
import type { IRunCommandResult } from '@electron/ocr/worker/types';
import { describeProcessExitCode } from '@electron/utils/process-exit';

interface IRunCommandOptions {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    allowedExitCodes?: number[];
    commandLabel?: string;
    log?: (level: 'debug' | 'warn' | 'error', message: string) => void;
}

function hasDirectoryInPath(command: string) {
    return command.includes('/') || command.includes('\\');
}

function getCommandDirectory(command: string) {
    if (!hasDirectoryInPath(command)) {
        return null;
    }
    const resolvedDir = dirname(command);
    if (!resolvedDir || resolvedDir === '.') {
        return null;
    }
    return resolvedDir;
}

function resolvePathKey(env: NodeJS.ProcessEnv) {
    const existing = Object.keys(env).find(key => key.toLowerCase() === 'path');
    if (existing) {
        return existing;
    }
    return process.platform === 'win32' ? 'Path' : 'PATH';
}

function prependCommandDirToPath(commandDir: string, env: NodeJS.ProcessEnv) {
    const pathKey = resolvePathKey(env);
    const delimiter = process.platform === 'win32' ? ';' : ':';
    const currentPath = env[pathKey] ?? '';
    const normalizedExisting = currentPath
        .split(delimiter)
        .map(entry => entry.trim())
        .filter(Boolean);

    if (normalizedExisting.includes(commandDir)) {
        return env;
    }

    return {
        ...env,
        [pathKey]: currentPath ? `${commandDir}${delimiter}${currentPath}` : commandDir,
    };
}

function truncateForError(text: string, maxLen = 1200) {
    const normalized = text.trim();
    if (normalized.length <= maxLen) {
        return normalized;
    }
    return `${normalized.slice(0, maxLen - 3)}...`;
}

function formatArgForLog(arg: string) {
    if (/[\s"]/u.test(arg)) {
        return `"${arg.replaceAll('"', '\\"')}"`;
    }
    return arg;
}

export async function runCommand(
    command: string,
    args: string[],
    options: IRunCommandOptions = {},
): Promise<IRunCommandResult> {
    const {
        cwd,
        env,
        timeoutMs,
        allowedExitCodes = [0],
        commandLabel,
        log,
    } = options;

    return new Promise((resolve, reject) => {
        const commandDir = getCommandDirectory(command);
        const effectiveCwd = cwd ?? commandDir ?? undefined;
        const effectiveEnv = commandDir
            ? prependCommandDirToPath(commandDir, {
                ...process.env,
                ...env,
            })
            : ({
                ...process.env,
                ...env,
            });
        const displayName = commandLabel ?? command;
        const displayCommand = `${command} ${args.map(formatArgForLog).join(' ')}`.trim();

        const proc = spawn(command, args, {
            cwd: effectiveCwd,
            env: effectiveEnv,
            shell: false,
            windowsHide: true,
            stdio: [
                'ignore',
                'pipe',
                'pipe',
            ],
        });

        let stdout = '';
        let stderr = '';
        let timeoutHandle: NodeJS.Timeout | null = null;
        let settled = false;

        const finalizeReject = (error: Error) => {
            if (settled) {
                return;
            }
            settled = true;
            if (timeoutHandle) {
                clearTimeout(timeoutHandle);
                timeoutHandle = null;
            }
            reject(error);
        };

        const finalizeResolve = (result: IRunCommandResult) => {
            if (settled) {
                return;
            }
            settled = true;
            if (timeoutHandle) {
                clearTimeout(timeoutHandle);
                timeoutHandle = null;
            }
            resolve(result);
        };

        proc.stdout?.on('data', (data: Buffer) => {
            stdout += data.toString();
        });

        proc.stderr?.on('data', (data: Buffer) => {
            stderr += data.toString();
        });

        if (typeof timeoutMs === 'number' && timeoutMs > 0) {
            timeoutHandle = setTimeout(() => {
                proc.kill('SIGKILL');
                log?.('error', `${displayName} timed out after ${timeoutMs}ms; cmd=${displayCommand}`);
                finalizeReject(new Error(`${displayName} timed out after ${timeoutMs}ms`));
            }, timeoutMs);
        }

        proc.on('error', (err) => {
            log?.('error', `${displayName} failed to start: ${err.message}; cmd=${displayCommand}`);
            finalizeReject(new Error(`${displayName} failed to start: ${err.message}`));
        });

        proc.on('close', (code, signal) => {
            const exitCode = typeof code === 'number' ? code : -1;
            if (!allowedExitCodes.includes(exitCode)) {
                const describedExitCode = describeProcessExitCode(exitCode);
                const details = truncateForError(stderr || stdout || 'No process output was captured.');
                const signalSuffix = signal ? `, signal=${signal}` : '';
                const message = `${displayName} failed with exit code ${describedExitCode}${signalSuffix}. ${
                    details || 'No process output was captured.'
                }`;
                log?.('error', `${message}; cmd=${displayCommand}`);
                finalizeReject(new Error(message));
                return;
            }

            if (signal) {
                log?.('warn', `${displayName} exited after signal ${signal}; cmd=${displayCommand}`);
            }

            finalizeResolve({
                stdout,
                stderr,
                exitCode,
            });
        });
    });
}
