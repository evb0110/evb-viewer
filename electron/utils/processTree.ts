import { spawn } from 'child_process';
import { clamp } from 'es-toolkit/math';
import { delay } from 'es-toolkit/promise';

interface ITerminateProcessTreeOptions {
    graceMs?: number;
    isTargetAlive?: () => boolean;
    platform?: NodeJS.Platform;
    preferProcessGroup?: boolean;
    taskkillTimeoutMs?: number;
}

const DEFAULT_GRACE_MS = 2_500;
const DEFAULT_TASKKILL_TIMEOUT_MS = 2_000;

interface IProcessTreeRuntime {
    delay: typeof delay;
    kill: typeof process.kill;
    now: () => number;
    spawn: typeof spawn;
}

// Keep runtime hooks narrow so tests can avoid mocking global process state.
export const processTreeRuntime = {
    delay,
    kill: process.kill.bind(process),
    now: () => Date.now(),
    spawn,
} satisfies IProcessTreeRuntime;

function isPidAlive(pid: number) {
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) {
        return false;
    }

    try {
        processTreeRuntime.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function isProcessGroupAlive(pid: number) {
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) {
        return false;
    }

    try {
        processTreeRuntime.kill(-pid, 0);
        return true;
    } catch {
        return false;
    }
}

async function waitForExit(isAlive: () => boolean, timeoutMs: number) {
    const deadline = processTreeRuntime.now() + Math.max(0, timeoutMs);
    while (processTreeRuntime.now() < deadline) {
        if (!isAlive()) {
            return true;
        }
        await processTreeRuntime.delay(100);
    }

    return !isAlive();
}

async function waitForPreferredProcessExit(
    pid: number,
    timeoutMs: number,
    isDirectTargetAlive: () => boolean,
) {
    const deadline = processTreeRuntime.now() + Math.max(0, timeoutMs);
    while (processTreeRuntime.now() < deadline) {
        if (!isProcessGroupAlive(pid) && !isDirectTargetAlive()) {
            return true;
        }
        await processTreeRuntime.delay(100);
    }

    return !isProcessGroupAlive(pid) && !isDirectTargetAlive();
}

function sendPosixSignal(
    pid: number,
    signal: NodeJS.Signals,
    preferProcessGroup: boolean,
) {
    try {
        if (preferProcessGroup) {
            processTreeRuntime.kill(-pid, signal);
            return;
        }
    } catch {
        // Fall through to direct PID signaling.
    }

    try {
        processTreeRuntime.kill(pid, signal);
    } catch {
        // Process may have already exited.
    }
}

function killTaskkillHelper(child: ReturnType<typeof spawn>) {
    try {
        child.kill();
    } catch {
        // taskkill may have already exited.
    }
}

async function runTaskkill(pid: number, force: boolean, timeoutMs: number) {
    return new Promise<boolean>((resolve) => {
        let settled = false;
        let timeoutHandle: NodeJS.Timeout | null = null;
        const settle = (succeeded: boolean) => {
            if (settled) {
                return;
            }
            settled = true;
            if (timeoutHandle) {
                clearTimeout(timeoutHandle);
                timeoutHandle = null;
            }
            resolve(succeeded);
        };
        const args = [
            '/PID',
            String(pid),
            '/T',
        ];
        if (force) {
            args.push('/F');
        }

        const child = processTreeRuntime.spawn('taskkill', args, {
            shell: false,
            windowsHide: true,
            stdio: 'ignore',
        });

        timeoutHandle = setTimeout(() => {
            killTaskkillHelper(child);
            settle(false);
        }, Math.max(0, timeoutMs));
        timeoutHandle.unref();

        child.once('error', () => settle(false));
        child.once('close', exitCode => settle(exitCode === 0));
    });
}

export async function terminateProcessTree(
    pid: number,
    options: ITerminateProcessTreeOptions = {},
) {
    const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
    const platform = options.platform ?? process.platform;
    const preferProcessGroup = options.preferProcessGroup ?? false;
    const taskkillTimeoutMs = options.taskkillTimeoutMs ?? DEFAULT_TASKKILL_TIMEOUT_MS;
    const isDirectTargetAlive = options.isTargetAlive ?? (() => isPidAlive(pid));

    const targetAlive = preferProcessGroup
        ? isProcessGroupAlive(pid) || isDirectTargetAlive()
        : isDirectTargetAlive();
    if (!targetAlive) {
        return true;
    }

    if (platform === 'win32') {
        await runTaskkill(pid, false, taskkillTimeoutMs);
        const exitedGracefully = await waitForExit(isDirectTargetAlive, graceMs);
        if (exitedGracefully) {
            return true;
        }
        if (isDirectTargetAlive()) {
            await runTaskkill(pid, true, taskkillTimeoutMs);
            const forceKillWaitMs = clamp(Math.floor(graceMs / 2), 250, 2_000);
            const exitedAfterForce = await waitForExit(isDirectTargetAlive, forceKillWaitMs);
            return exitedAfterForce;
        }
        return !isDirectTargetAlive();
    }

    const processGroupWasAlive = preferProcessGroup && isProcessGroupAlive(pid);
    sendPosixSignal(pid, 'SIGTERM', processGroupWasAlive);
    const exitedGracefully = processGroupWasAlive
        ? await waitForPreferredProcessExit(pid, graceMs, isDirectTargetAlive)
        : await waitForExit(isDirectTargetAlive, graceMs);
    const stillAlive = preferProcessGroup
        ? isProcessGroupAlive(pid) || isDirectTargetAlive()
        : isDirectTargetAlive();
    if (exitedGracefully || !stillAlive || (!preferProcessGroup && !isDirectTargetAlive())) {
        return true;
    }

    sendPosixSignal(pid, 'SIGKILL', processGroupWasAlive && isProcessGroupAlive(pid));
    const forceKillWaitMs = clamp(Math.floor(graceMs / 2), 250, 2_000);
    if (preferProcessGroup) {
        return waitForPreferredProcessExit(pid, forceKillWaitMs, isDirectTargetAlive);
    }
    return waitForExit(isDirectTargetAlive, forceKillWaitMs);
}
