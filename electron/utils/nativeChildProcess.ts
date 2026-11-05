import type {
    ChildProcess,
    SpawnOptions,
    SpawnOptionsWithStdioTuple,
    SpawnOptionsWithoutStdio,
    StdioNull,
    StdioPipe,
} from 'child_process';
import { terminateProcessTree } from '@electron/utils/processTree';

export function shouldUseDetachedProcessGroup(platform: NodeJS.Platform = process.platform) {
    return platform !== 'win32';
}

export function createDetachedChildProcessSpawnOptions(): SpawnOptions;
export function createDetachedChildProcessSpawnOptions<
    TStdin extends StdioNull | StdioPipe,
    TStdout extends StdioNull | StdioPipe,
    TStderr extends StdioNull | StdioPipe,
>(
    options: SpawnOptionsWithStdioTuple<TStdin, TStdout, TStderr>,
    platform?: NodeJS.Platform,
): SpawnOptionsWithStdioTuple<TStdin, TStdout, TStderr>;
export function createDetachedChildProcessSpawnOptions(
    options: SpawnOptionsWithoutStdio,
    platform?: NodeJS.Platform,
): SpawnOptionsWithoutStdio;
export function createDetachedChildProcessSpawnOptions(
    options: SpawnOptions,
    platform?: NodeJS.Platform,
): SpawnOptions;
export function createDetachedChildProcessSpawnOptions(
    options: SpawnOptions = {},
    platform: NodeJS.Platform = process.platform,
): SpawnOptions {
    return {
        ...options,
        detached: shouldUseDetachedProcessGroup(platform),
    };
}

export async function terminateDetachedChildProcess(
    proc: ChildProcess,
    graceMs: number,
    platform: NodeJS.Platform = process.platform,
) {
    const pid = proc.pid;
    if (typeof pid === 'number' && Number.isFinite(pid) && pid > 0) {
        return terminateProcessTree(pid, {
            graceMs,
            isTargetAlive: () => proc.exitCode === null && proc.signalCode === null,
            platform,
            preferProcessGroup: shouldUseDetachedProcessGroup(platform),
        });
    }

    try {
        proc.kill('SIGTERM');
    } catch {
        // Process may already be gone.
    }
    return platform !== 'win32' && (proc.exitCode !== null || proc.signalCode !== null);
}
