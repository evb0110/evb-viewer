import { createServer as createNetServer } from 'node:net';
import {
    execFileSync,
    execSync,
    type ChildProcess,
} from 'node:child_process';
import { readFileSync } from 'node:fs';
import { uniq } from 'es-toolkit/array';
import { delay } from 'es-toolkit/promise';

// SIGKILL only schedules teardown, so a killed process stays visible to
// `kill(pid, 0)` until the kernel reaps it. Callers read the liveness check
// straight after termination as its result, so the tree must be observed gone.
const FORCED_EXIT_TIMEOUT_MS = 2_000;

export async function findFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = createNetServer();
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            if (!addr || typeof addr === 'string') {
                server.close();
                reject(new Error('Failed to allocate free port'));
                return;
            }
            const { port } = addr;
            server.close(() => resolve(port));
        });
        server.on('error', reject);
    });
}

export function getPidsOnPort(port: number): number[] {
    try {
        const output = execSync(`lsof -ti :${port} 2>/dev/null || true`, { encoding: 'utf8' });
        return output
            .split('\n')
            .map(entry => Number(entry.trim()))
            .filter(pid => Number.isFinite(pid) && pid > 0);
    } catch {
        return [];
    }
}

export function killPids(
    pids: number[],
    options: {
        signal?: NodeJS.Signals | number;
        exclude?: Set<number>;
    } = {},
) {
    if (!Array.isArray(pids) || pids.length === 0) {
        return;
    }
    const signal = options.signal ?? 'SIGKILL';
    const exclude = options.exclude ?? new Set<number>();
    exclude.add(process.pid);
    if (typeof process.ppid === 'number' && process.ppid > 0) {
        exclude.add(process.ppid);
    }

    const uniquePids = uniq(pids);
    for (const pid of uniquePids) {
        if (exclude.has(pid)) {
            continue;
        }
        try {
            process.kill(pid, signal);
        } catch {}
    }
}

export function collectDescendantPidsUnix(rootPid: number) {
    if (!Number.isFinite(rootPid) || rootPid <= 0) {
        return [];
    }

    try {
        const output = execSync('ps -eo pid=,ppid=', { encoding: 'utf8' });
        const childrenByParent = new Map<number, number[]>();

        for (const line of output.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) {
                continue;
            }
            const parts = trimmed.split(/\s+/);
            const pid = Number(parts[0]);
            const ppid = Number(parts[1]);
            if (!Number.isFinite(pid) || !Number.isFinite(ppid) || pid <= 0 || ppid <= 0) {
                continue;
            }
            const bucket = childrenByParent.get(ppid) ?? [];
            bucket.push(pid);
            childrenByParent.set(ppid, bucket);
        }

        const descendants: number[] = [];
        const stack = [rootPid];
        while (stack.length > 0) {
            const current = stack.pop()!;
            const children = childrenByParent.get(current) ?? [];
            for (const childPid of children) {
                descendants.push(childPid);
                stack.push(childPid);
            }
        }

        return descendants;
    } catch {
        return [];
    }
}

export function findPidsByCommandSubstring(substring: string) {
    const needle = substring.trim();
    if (!needle) {
        return [];
    }

    if (process.platform === 'win32') {
        return [];
    }

    try {
        const output = execSync('ps -ax -o pid=,command=', { encoding: 'utf8' });
        const pids: number[] = [];
        for (const line of output.split('\n')) {
            const match = line.match(/^\s*(\d+)\s+(.+)$/);
            if (!match) {
                continue;
            }
            const pid = Number(match[1]);
            const command = match[2];
            if (!Number.isFinite(pid) || pid <= 0) {
                continue;
            }
            if (!command) {
                continue;
            }
            if (command.includes(needle)) {
                pids.push(pid);
            }
        }
        return pids;
    } catch {
        return [];
    }
}

/**
 * Resolves true when it found the root alive and terminated its tree, false
 * when the root was already gone and nothing was issued.
 */
export async function killProcessTree(
    pid: number,
    graceMs = 1500,
    options: {force?: boolean} = {},
) {
    if (!isProcessAlive(pid)) {
        return false;
    }

    if (process.platform === 'win32') {
        try {
            execSync(`taskkill /PID ${pid} /T /F >NUL 2>&1`);
        } catch {}
        // TerminateProcess is asynchronous like SIGKILL, so the process stays
        // visible to the liveness check callers read straight afterwards.
        await waitForProcessesExit([pid], FORCED_EXIT_TIMEOUT_MS);
        return true;
    }

    const descendants = collectDescendantPidsUnix(pid);
    const targets = uniq([
        ...descendants,
        pid,
    ]);
    if (options.force) {
        killPids(targets, { signal: 'SIGKILL' });
        await waitForProcessesExit(targets, FORCED_EXIT_TIMEOUT_MS);
        return true;
    }
    killPids(targets, { signal: 'SIGTERM' });

    if (graceMs > 0) {
        const deadline = Date.now() + graceMs;
        while (Date.now() < deadline) {
            const alive = targets.some(targetPid => isProcessAlive(targetPid));
            if (!alive) {
                return true;
            }
            await delay(80);
        }
    }

    const remaining = targets.filter(targetPid => isProcessAlive(targetPid));
    if (remaining.length > 0) {
        killPids(remaining, { signal: 'SIGKILL' });
        await waitForProcessesExit(remaining, FORCED_EXIT_TIMEOUT_MS);
    }
    return true;
}

export async function killProcessTrees(pids: readonly number[], graceMs = 1200) {
    for (const pid of uniq(pids)) {
        await killProcessTree(pid, graceMs);
    }
}

/**
 * Terminate a child this process spawned: prefer the process tree while it is
 * still alive so orphaned grandchildren die with it, and otherwise fall back to
 * the handle's own kill. Every session teardown path uses this one helper.
 */
export async function killSpawnedProcessTree(child: ChildProcess | null | undefined, graceMs: number) {
    try {
        if (child?.pid && isProcessAlive(child.pid)) {
            await killProcessTree(child.pid, graceMs);
        } else {
            child?.kill();
        }
    } catch {}
}

async function waitForProcessesExit(pids: readonly number[], timeoutMs: number) {
    const targets = uniq([...pids]);
    const hasSurvivor = () => targets.some(pid => isProcessAlive(pid));
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (!hasSurvivor()) {
            return true;
        }
        await delay(100);
    }
    return !hasSurvivor();
}

export async function waitForProcessExit(pid: number, timeoutMs: number) {
    return waitForProcessesExit([pid], timeoutMs);
}

function isLinuxProcStatAlive(stat: string) {
    const commandEnd = stat.lastIndexOf(')');
    if (commandEnd < 0) {
        return true;
    }
    const state = stat.slice(commandEnd + 1).trimStart().charAt(0);
    return state !== 'Z' && state !== 'X';
}

// `kill(pid, 0)` succeeds for a zombie on every POSIX platform, so an exited
// child whose parent has not reaped it yet still looks alive. Session stops
// hit this window routinely: the E2E controller is a detached child of the
// test worker that kills Electron and then probes identity in one synchronous
// stretch, during which the controller exits and cannot be reaped.
function isPosixZombie(pid: number) {
    try {
        const state = execFileSync('ps', [
            '-p',
            String(pid),
            '-o',
            'stat=',
        ], {
            encoding: 'utf8',
            stdio: [
                'ignore',
                'pipe',
                'ignore',
            ],
        }).trim();
        return state.startsWith('Z');
    } catch {
        return false;
    }
}

export function isProcessAlive(pid: number) {
    if (!Number.isFinite(pid) || pid <= 0) {
        return false;
    }
    try {
        process.kill(pid, 0);
    } catch {
        return false;
    }
    if (process.platform === 'win32') {
        return true;
    }
    if (process.platform !== 'linux') {
        return !isPosixZombie(pid);
    }
    try {
        return isLinuxProcStatAlive(readFileSync(`/proc/${String(pid)}/stat`, 'utf8'));
    } catch {
        // The process may have exited between kill(0) and the procfs read. A
        // second liveness probe distinguishes that race from an unusual procfs
        // access failure, where refusing to kill remains the safe behavior.
        try {
            process.kill(pid, 0);
            return true;
        } catch {
            return false;
        }
    }
}
