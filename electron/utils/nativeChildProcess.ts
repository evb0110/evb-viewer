import { spawn } from 'child_process';
import { randomUUID } from 'node:crypto';
import {
    createServer, type Socket,
} from 'node:net';
import type {
    Readable, Writable,
} from 'node:stream';
import { resolveNativeProcessSupervisorPath } from '@electron/native-tools/resolveNativeToolsBase';
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

export interface ISpawnNativeChildProcessOptions
    extends SpawnOptionsWithStdioTuple<'pipe' | 'ignore', 'pipe', 'pipe'> {
    memoryLimitBytes?: number | undefined;
    onMemoryLimitExceeded?: ((bytes: number) => void) | undefined;
}

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

interface ISupervisedJobState {
    proof: Promise<boolean>;
    pid: Promise<number | null>;
    getMemoryLimitExceededBytes: () => number | null;
    terminate: (graceMs: number) => Promise<boolean>;
}

const supervisedJobs = new WeakMap<ChildProcess, ISupervisedJobState>();

export function getNativeChildProcessPid(proc: ChildProcess) {
    return supervisedJobs.get(proc)?.pid ?? Promise.resolve(proc.pid ?? null);
}

export function getNativeChildProcessTerminationProof(proc: ChildProcess) {
    return supervisedJobs.get(proc)?.proof;
}

export function getNativeChildProcessMemoryLimitExceededBytes(proc: ChildProcess) {
    return supervisedJobs.get(proc)?.getMemoryLimitExceededBytes() ?? null;
}

function createSupervisedSpawnError(command: string, detail: string) {
    const codeMatch = /^([A-Z]+):/u.exec(detail);
    const error = new Error(`spawn ${command} ${detail}`) as NodeJS.ErrnoException;
    if (codeMatch?.[1]) {
        error.code = codeMatch[1];
    }
    return error;
}

function attachSupervisorControlSocket(
    socket: Socket,
    command: string,
    handlers: {
        resolvePid: (pid: number | null) => void;
        resolveProof: (proven: boolean) => void;
        onMemoryLimitExceeded: (bytes: number) => void;
        onSpawnError: (error: Error) => void;
    },
) {
    let message = '';
    let pendingSpawnError: Error | null = null;
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
        message += chunk;
        for (let newline = message.indexOf('\n'); newline >= 0; newline = message.indexOf('\n')) {
            const line = message.slice(0, newline);
            message = message.slice(newline + 1);
            if (/^pid=[1-9]\d{0,9}$/u.test(line)) {
                handlers.resolvePid(Number(line.slice(4)));
            } else if (/^memory_limit=\d{1,20}$/u.test(line)) {
                const bytes = Number(line.slice('memory_limit='.length));
                if (Number.isSafeInteger(bytes) && bytes > 0) {
                    handlers.onMemoryLimitExceeded(bytes);
                }
            } else if (line.startsWith('spawn_error=')) {
                pendingSpawnError = createSupervisedSpawnError(command, line.slice('spawn_error='.length));
            } else if (line === 'empty') {
                handlers.resolveProof(true);
                socket.end();
                if (pendingSpawnError) {
                    const error = pendingSpawnError;
                    pendingSpawnError = null;
                    handlers.onSpawnError(error);
                }
            } else {
                handlers.resolveProof(false);
                socket.destroy();
            }
        }
        if (message.length > 512) {
            handlers.resolveProof(false);
            socket.destroy();
        }
    });
    socket.on('error', () => handlers.resolveProof(false));
    socket.once('close', () => handlers.resolveProof(false));
}

function formatMemoryLimitArgs(memoryLimitBytes: number | undefined) {
    if (typeof memoryLimitBytes !== 'number' || !Number.isSafeInteger(memoryLimitBytes) || memoryLimitBytes <= 0) {
        return [];
    }
    return [
        '--memory-limit-bytes',
        String(memoryLimitBytes),
    ];
}

export function spawnNativeChildProcess(
    command: string,
    args: string[],
    options: ISpawnNativeChildProcessOptions,
): ChildProcessByStdio<Writable | null, Readable, Readable> {
    const {
        memoryLimitBytes,
        onMemoryLimitExceeded,
        ...spawnOptions
    } = options;
    const isPackaged = import.meta.dirname.includes('app.asar');
    const launcher = resolveNativeProcessSupervisorPath(import.meta.dirname);
    const memoryLimitArgs = formatMemoryLimitArgs(memoryLimitBytes);

    if (process.platform !== 'win32') {
        if (!launcher) {
            if (isPackaged) {
                throw new Error('Native process supervisor is missing; rebuild native tools');
            }
            return spawn(
                command,
                args,
                createDetachedChildProcessSpawnOptions(spawnOptions),
            ) as ChildProcessByStdio<Writable | null, Readable, Readable>;
        }
        const {
            promise: proof, resolve: resolveProof,
        } = Promise.withResolvers<boolean>();
        const {
            promise: pid, resolve: resolvePid,
        } = Promise.withResolvers<number | null>();
        let memoryLimitExceededBytes: number | null = null;
        void proof.then(() => resolvePid(null));

        const proc = spawn(launcher, [
            '--posix-fd',
            '3',
            ...memoryLimitArgs,
            '--',
            command,
            ...args,
        ], {
            ...spawnOptions,
            detached: false,
            stdio: [
                spawnOptions.stdio[0],
                spawnOptions.stdio[1],
                spawnOptions.stdio[2],
                'pipe',
            ],
        });
        const controlSocket = proc.stdio[3] as Socket | null;
        if (!controlSocket) {
            proc.kill('SIGKILL');
            throw new Error('Native process supervisor control channel was not created');
        }
        attachSupervisorControlSocket(controlSocket, command, {
            resolvePid,
            resolveProof,
            onMemoryLimitExceeded: (bytes) => {
                memoryLimitExceededBytes = bytes;
                onMemoryLimitExceeded?.(bytes);
            },
            onSpawnError: (error) => {
                proc.emit('error', error);
            },
        });
        proc.once('error', () => resolveProof(false));
        proc.once('close', () => resolveProof(false));
        supervisedJobs.set(proc, {
            proof,
            pid,
            getMemoryLimitExceededBytes: () => memoryLimitExceededBytes,
            terminate: (graceMs) => {
                const clampedGraceMs = Number.isFinite(graceMs) && graceMs > 0 ? Math.round(graceMs) : 0;
                if (!controlSocket.destroyed && controlSocket.writable) {
                    controlSocket.end(`terminate ${clampedGraceMs}\n`);
                }
                return proof;
            },
        });
        return proc as ChildProcessByStdio<Writable | null, Readable, Readable>;
    }

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
    let memoryLimitExceededBytes: number | null = null;
    void proof.then(() => resolvePid(null));
    const server = createServer(socket => {
        server.close();
        resolveConnection(socket);
        attachSupervisorControlSocket(socket, command, {
            resolvePid,
            resolveProof,
            onMemoryLimitExceeded: (bytes) => {
                memoryLimitExceededBytes = bytes;
                onMemoryLimitExceeded?.(bytes);
            },
            onSpawnError: (error) => {
                proc?.emit('error', error);
            },
        });
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
            spawnOptions.windowsHide === false ? '0' : '1',
            ...memoryLimitArgs,
            '--',
            command,
            ...args,
        ], spawnOptions) as ChildProcessByStdio<Writable | null, Readable, Readable>;
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
    supervisedJobs.set(proc, {
        proof,
        pid,
        getMemoryLimitExceededBytes: () => memoryLimitExceededBytes,
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
    const job = supervisedJobs.get(proc);
    if (job) return job.terminate(graceMs);
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
