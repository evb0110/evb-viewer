import { spawn } from 'child_process';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { resolveNativeResourcesBase } from '@electron/native-tools/resolveNativeResourcesBase';
import {
    createServer, type Socket,
} from 'node:net';
import type {
    Readable, Writable,
} from 'node:stream';
import { resolveNativeToolPath } from '@electron/native-tools/resolveNativeToolPath';
import type {
    ChildProcess,
    ChildProcessByStdio,
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

const windowsJobs = new WeakMap<ChildProcess, {
    proof: Promise<boolean>;
    pid: Promise<number | null>;
    terminate: () => Promise<boolean>;
}>();

export function getNativeChildProcessPid(proc: ChildProcess) {
    return windowsJobs.get(proc)?.pid ?? Promise.resolve(proc.pid ?? null);
}

export function getNativeChildProcessTerminationProof(proc: ChildProcess) {
    return windowsJobs.get(proc)?.proof;
}

export function spawnNativeChildProcess(
    command: string,
    args: string[],
    options: SpawnOptionsWithStdioTuple<'pipe' | 'ignore', 'pipe', 'pipe'>,
): ChildProcessByStdio<Writable | null, Readable, Readable> {
    if (process.platform !== 'win32') {
        return spawn(command, args, createDetachedChildProcessSpawnOptions(options)) as ChildProcessByStdio<Writable | null, Readable, Readable>;
    }
    const isPackaged = import.meta.dirname.includes('app.asar');
    const resourcesBase = resolveNativeResourcesBase(import.meta.dirname, isPackaged, {cwd: import.meta.dirname});
    const launcher = resolveNativeToolPath({
        binaryName: 'evb-windows-job-launcher.exe',
        crateName: 'windows-job-launcher',
        projectRoot: dirname(resourcesBase),
        resourcesBase,
        currentDir: import.meta.dirname,
        isPackaged,
    });
    if (!launcher) throw new Error('Windows Job Object launcher is missing; rebuild native tools');
    const pipe = `\\\\.\\pipe\\evb-native-job-${randomUUID()}`;
    const {
        promise: proof, resolve: resolveProof,
    } = Promise.withResolvers<boolean>();
    const {
        promise: connection, resolve: resolveConnection,
    } = Promise.withResolvers<Socket | null>();
    const {
        promise: pid, resolve: resolvePid,
    } = Promise.withResolvers<number | null>();
    void proof.then(() => resolvePid(null));
    const server = createServer(socket => {
        server.close();
        resolveConnection(socket);
        let message = '';
        socket.setEncoding('utf8');
        socket.on('data', chunk => {
            message += chunk;
            for (let newline = message.indexOf('\n'); newline >= 0; newline = message.indexOf('\n')) {
                const line = message.slice(0, newline);
                message = message.slice(newline + 1);
                if (/^pid=[1-9]\d{0,9}$/u.test(line)) resolvePid(Number(line.slice(4)));
                else if (line === 'empty') { resolveProof(true); socket.end(); }
                else { resolveProof(false); socket.destroy(); }
            }
            if (message.length > 16) { resolveProof(false); socket.destroy(); }
        });
        socket.once('error', () => resolveProof(false));
        socket.once('close', () => resolveProof(false));
    });
    server.once('close', () => {
        resolveConnection(null);
        resolveProof(false);
    });
    // Named-pipe binding happens during listen, before the child can connect.
    server.listen(pipe);
    let proc: ChildProcessByStdio<Writable | null, Readable, Readable>;
    try {
        // Node's overloads omit a union stdin even though both outputs are pipes.
        proc = spawn(launcher, [
            pipe,
            options.windowsHide === false ? '0' : '1',
            '--',
            command,
            ...args,
        ], options) as ChildProcessByStdio<Writable | null, Readable, Readable>;
    } catch (error) {
        server.close();
        throw error;
    }
    server.once('error', () => {
        resolveConnection(null);
        resolveProof(false);
        proc.kill();
    });
    const closeServer = () => server.close();
    proc.once('error', closeServer);
    proc.once('close', closeServer);
    windowsJobs.set(proc, {
        proof,
        pid,
        terminate: () => {
            void connection.then(socket => socket?.end('terminate\n'));
            return proof;
        },
    });
    return proc;
}

export async function terminateDetachedChildProcess(
    proc: ChildProcess,
    graceMs: number,
    platform: NodeJS.Platform = process.platform,
) {
    const job = windowsJobs.get(proc);
    if (job) return job.terminate();
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
