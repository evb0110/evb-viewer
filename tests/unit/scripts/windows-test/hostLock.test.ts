import {
    spawn, type ChildProcess,
} from 'node:child_process';
import {
    mkdir,
    mkdtemp,
    rm,
    writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {createInterface} from 'node:readline';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
} from 'vitest';
import {
    HostLockBusyError,
    acquireHostLock,
    readHostLockOwner,
    withHostLock,
} from '@scripts/windows-test/host/hostLock';
import type {
    IHostLockDependencies,
    IHostLockHandle,
    IHostLockOwner,
} from '@scripts/windows-test/host/hostLock';
import type {IHostProcessIdentityProbe} from '@scripts/windows-test/host/hostProcessIdentity';

const FIRST_OWNER_PID = 41_001;
const REPLACEMENT_OWNER_PID = 41_002;
const STALE_CONTENDER_PID = 41_003;
const FIRST_OWNER_START_TIME = 'Fri Sep  4 12:00:00 2026';
const REPLACEMENT_OWNER_START_TIME = 'Fri Sep  4 12:05:00 2026';
const STALE_CONTENDER_START_TIME = 'Fri Sep  4 12:10:00 2026';

interface IDeferred<T> {
    promise: Promise<T>;
    resolve: (value: T | PromiseLike<T>) => void;
    reject: (reason?: unknown) => void;
}

function createDeferred<T = void>(): IDeferred<T> {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((promiseResolve, promiseReject) => {
        resolve = promiseResolve;
        reject = promiseReject;
    });
    return {
        promise,
        resolve,
        reject,
    };
}

function fakeProbe(processes: Map<number, string | null>): IHostProcessIdentityProbe {
    return {
        isAlive: pid => processes.has(pid),
        startTime: pid => Promise.resolve(processes.get(pid) ?? null),
    };
}

function lockDependencies(
    pid: number,
    probe: IHostProcessIdentityProbe,
    options: {
        hostId?: string;
        nowIso?: string;
        token?: string;
    } = {},
): IHostLockDependencies {
    const dependencies: IHostLockDependencies = {
        hostId: options.hostId ?? 'test-host',
        pid,
        probe,
        nowIso: () => options.nowIso ?? '2026-09-04T12:00:00.000Z',
        sleep: () => Promise.resolve(),
    };
    const token = options.token;
    if (token !== undefined) {
        dependencies.createToken = () => token;
    }
    return dependencies;
}

function owner(overrides: Partial<IHostLockOwner> = {}): IHostLockOwner {
    return {
        token: 'stale-owner-token',
        hostId: 'test-host',
        pid: FIRST_OWNER_PID,
        startTime: FIRST_OWNER_START_TIME,
        acquiredAt: '2026-09-04T12:00:00.000Z',
        ...overrides,
    };
}

async function writeOwner(lockDirectory: string, value: IHostLockOwner) {
    await mkdir(lockDirectory, {recursive: true});
    await writeFile(
        path.join(lockDirectory, 'owner.json'),
        `${JSON.stringify(value)}\n`,
        'utf8',
    );
}

async function forceKillAndWait(child: ChildProcess) {
    if (child.exitCode !== null || child.signalCode !== null) {
        return;
    }
    await new Promise<void>((resolve) => {
        const onExit = () => {
            child.off('error', onExit);
            child.off('exit', onExit);
            resolve();
        };
        child.once('exit', onExit);
        child.once('error', onExit);
        if (!child.kill('SIGKILL')) {
            child.off('exit', onExit);
            child.off('error', onExit);
            resolve();
        }
    });
}

type TWorkerEventName = 'ready' | 'acquired' | 'busy' | 'released' | 'error';

interface IParsedWorkerEvent {
    event: TWorkerEventName;
    message?: unknown;
    pid: number;
}

function isWorkerEventName(value: unknown): value is TWorkerEventName {
    return value === 'ready'
        || value === 'acquired'
        || value === 'busy'
        || value === 'released'
        || value === 'error';
}

function isParsedWorkerEvent(value: unknown): value is IParsedWorkerEvent {
    if (value === null || typeof value !== 'object'
        || !('event' in value) || !('pid' in value)) {
        return false;
    }
    return isWorkerEventName(value.event) && typeof value.pid === 'number';
}

interface IWorkerEvent {
    event: TWorkerEventName;
    message?: string;
    pid: number;
}

interface IWorkerWaiter {
    events: readonly TWorkerEventName[];
    reject: (reason?: unknown) => void;
    resolve: (event: IWorkerEvent) => void;
}

interface ILockWorker {
    child: ChildProcess;
    send(command: 'go' | 'release'): void;
    waitFor(events: readonly TWorkerEventName[]): Promise<IWorkerEvent>;
}

function createMultiprocessWorkerScript(lockModuleUrl: string) {
    return `
import {createInterface} from 'node:readline';
import {acquireHostLock} from ${JSON.stringify(lockModuleUrl)};

const [lockDirectory] = process.argv.slice(1);
const input = createInterface({input: process.stdin});
const commands = [];
const waiters = [];

input.on('line', line => {
    const waiter = waiters.shift();
    if (waiter) {
        waiter(line);
    } else {
        commands.push(line);
    }
});

function nextCommand() {
    const command = commands.shift();
    return command === undefined
        ? new Promise(resolve => waiters.push(resolve))
        : Promise.resolve(command);
}

function send(event, message) {
    process.stdout.write(JSON.stringify({event, message: message ?? null, pid: process.pid}) + '\\n');
}

if (typeof lockDirectory !== 'string') {
    send('error', 'lock directory argument is missing');
    process.exitCode = 1;
} else {
    send('ready');
    try {
        const command = await nextCommand();
        if (command !== 'go') {
            throw new Error('worker did not receive the go barrier');
        }
        const handle = await acquireHostLock(lockDirectory, {
            hostId: 'macos-multiprocess-fixture',
            pid: process.pid,
            probe: {
                isAlive: () => true,
                startTime: () => Promise.resolve('fixture-process-start'),
            },
            nowIso: () => '2026-09-09T00:00:00.000Z',
            sleep: () => Promise.resolve(),
        }, {
            attempts: 1,
            retryDelayMs: 0,
        });
        send('acquired');
        const releaseCommand = await nextCommand();
        if (releaseCommand !== 'release') {
            throw new Error('worker did not receive the release barrier');
        }
        await handle.release();
        send('released');
    } catch (error) {
        if (error && typeof error === 'object' && 'name' in error && error.name === 'HostLockBusyError') {
            send('busy');
        } else {
            send('error', error instanceof Error ? error.message : String(error));
            process.exitCode = 1;
        }
    }
}

input.close();
process.stdin.destroy();
`;
}

function spawnMultiprocessWorker(lockDirectory: string): ILockWorker {
    const lockModuleUrl = pathToFileURL(path.resolve(
        process.cwd(),
        'scripts/windows-test/host/hostLock.ts',
    )).href;
    const child = spawn(process.execPath, [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        createMultiprocessWorkerScript(lockModuleUrl),
        '--',
        lockDirectory,
    ], {
        cwd: process.cwd(),
        env: process.env,
        stdio: [
            'pipe',
            'pipe',
            'pipe',
        ],
    });
    if (child.stdin === null || child.stdout === null || child.stderr === null) {
        void forceKillAndWait(child);
        throw new Error('multiprocess lock fixture did not get piped stdio');
    }
    child.stdin.on('error', () => undefined);

    const eventQueue: IWorkerEvent[] = [];
    const waiters: IWorkerWaiter[] = [];
    let outputError: Error | null = null;
    let stderr = '';
    child.stderr.on('data', chunk => {
        stderr += String(chunk);
    });
    const output = createInterface({input: child.stdout});
    output.on('line', line => {
        try {
            const parsed: unknown = JSON.parse(line);
            if (!isParsedWorkerEvent(parsed)) {
                throw new Error(`invalid worker event: ${line}`);
            }
            const event: IWorkerEvent = {
                event: parsed.event,
                pid: parsed.pid,
                ...(typeof parsed.message === 'string' ? {message: parsed.message} : {}),
            };
            const waiterIndex = waiters.findIndex(waiter => waiter.events.includes(event.event));
            if (waiterIndex < 0) {
                eventQueue.push(event);
                return;
            }
            const [waiter] = waiters.splice(waiterIndex, 1);
            waiter?.resolve(event);
        } catch (error) {
            outputError = error instanceof Error ? error : new Error(String(error));
            for (const waiter of waiters.splice(0)) {
                waiter.reject(outputError);
            }
        }
    });
    child.on('error', error => {
        outputError = error;
        for (const waiter of waiters.splice(0)) {
            waiter.reject(error);
        }
    });
    child.on('exit', (code, signal) => {
        if (waiters.length === 0) {
            return;
        }
        const detail = stderr.trim().length > 0 ? `: ${stderr.trim()}` : '';
        const error = outputError ?? new Error(
            `multiprocess lock fixture exited before its event (code ${String(code)}, signal ${String(signal)})${detail}`,
        );
        for (const waiter of waiters.splice(0)) {
            waiter.reject(error);
        }
    });

    return {
        child,
        send: command => {
            if (!child.stdin?.destroyed && child.stdin?.writable) {
                child.stdin.write(`${command}\n`);
            }
        },
        waitFor: events => {
            const queuedIndex = eventQueue.findIndex(event => events.includes(event.event));
            if (queuedIndex >= 0) {
                const [event] = eventQueue.splice(queuedIndex, 1);
                return Promise.resolve(event!);
            }
            if (outputError !== null) {
                return Promise.reject(outputError);
            }
            return new Promise<IWorkerEvent>((resolve, reject) => {
                waiters.push({
                    events,
                    reject,
                    resolve,
                });
            });
        },
    };
}

describe('windows test host lock', () => {
    let dataRoot = '';
    let lockDirectory = '';
    const activeWorkers: ILockWorker[] = [];

    beforeEach(async () => {
        dataRoot = await mkdtemp(path.join(tmpdir(), 'evb-windows-host-lock-'));
        lockDirectory = path.join(dataRoot, 'host.lock');
    });

    afterEach(async () => {
        await Promise.all(activeWorkers.splice(0).map(worker => forceKillAndWait(worker.child)));
        await rm(dataRoot, {
            force: true,
            recursive: true,
        });
    });

    it('does not let a stale contender remove a replacement lock', async () => {
        await writeOwner(lockDirectory, owner());

        const staleProbeReached = createDeferred();
        const releaseStaleProbe = createDeferred();
        let blockedProbe = true;
        const staleContenderProbe: IHostProcessIdentityProbe = {
            isAlive: pid => pid === REPLACEMENT_OWNER_PID || pid === STALE_CONTENDER_PID,
            startTime: async (pid) => {
                if (pid === FIRST_OWNER_PID && blockedProbe) {
                    blockedProbe = false;
                    staleProbeReached.resolve();
                    await releaseStaleProbe.promise;
                    return null;
                }
                if (pid === REPLACEMENT_OWNER_PID) {
                    return REPLACEMENT_OWNER_START_TIME;
                }
                if (pid === STALE_CONTENDER_PID) {
                    return STALE_CONTENDER_START_TIME;
                }
                return null;
            },
        };
        const staleContender = acquireHostLock(
            lockDirectory,
            lockDependencies(STALE_CONTENDER_PID, staleContenderProbe, {token: 'stale-contender-token'}),
            {
                attempts: 2,
                retryDelayMs: 0,
            },
        );
        let replacementHandle: IHostLockHandle | undefined;
        try {
            await staleProbeReached.promise;
            replacementHandle = await acquireHostLock(
                lockDirectory,
                lockDependencies(REPLACEMENT_OWNER_PID, fakeProbe(new Map([[
                    REPLACEMENT_OWNER_PID,
                    REPLACEMENT_OWNER_START_TIME,
                ]])), {token: 'replacement-owner-token'}),
                {
                    attempts: 2,
                    retryDelayMs: 0,
                },
            );
            releaseStaleProbe.resolve();

            await expect(staleContender).rejects.toBeInstanceOf(HostLockBusyError);
            await expect(readHostLockOwner(lockDirectory)).resolves.toMatchObject({
                pid: REPLACEMENT_OWNER_PID,
                token: 'replacement-owner-token',
            });
        } finally {
            releaseStaleProbe.resolve();
            const unexpectedHandle = await staleContender.catch(() => undefined);
            await unexpectedHandle?.release();
            await replacementHandle?.release();
        }
    });

    it('does not let an old handle release a replacement lock', async () => {
        const processes = new Map<number, string | null>([[
            FIRST_OWNER_PID,
            FIRST_OWNER_START_TIME,
        ]]);
        const probe = fakeProbe(processes);
        const firstHandle = await acquireHostLock(
            lockDirectory,
            lockDependencies(FIRST_OWNER_PID, probe, {token: 'first-owner-token'}),
        );
        processes.delete(FIRST_OWNER_PID);
        processes.set(REPLACEMENT_OWNER_PID, REPLACEMENT_OWNER_START_TIME);

        const replacementEntered = createDeferred();
        const releaseReplacement = createDeferred();
        const replacementRun = withHostLock(
            lockDirectory,
            lockDependencies(REPLACEMENT_OWNER_PID, probe, {token: 'replacement-owner-token'}),
            async (handle) => {
                replacementEntered.resolve();
                await releaseReplacement.promise;
                return handle.owner;
            },
            {
                attempts: 2,
                retryDelayMs: 0,
            },
        );
        const replacementObserved = replacementRun.catch((error: unknown) => {
            replacementEntered.reject(error);
            throw error;
        });
        let firstReleaseAttempted = false;
        try {
            await replacementEntered.promise;
            await expect(readHostLockOwner(lockDirectory)).resolves.toMatchObject({
                pid: REPLACEMENT_OWNER_PID,
                token: 'replacement-owner-token',
            });

            firstReleaseAttempted = true;
            await firstHandle.release();

            await expect(readHostLockOwner(lockDirectory)).resolves.toMatchObject({
                pid: REPLACEMENT_OWNER_PID,
                token: 'replacement-owner-token',
            });
        } finally {
            releaseReplacement.resolve();
            await replacementObserved.catch(() => undefined);
            if (!firstReleaseAttempted) {
                await firstHandle.release().catch(() => undefined);
            }
        }
    });

    it.runIf(process.platform === 'darwin')(
        'allows only one real macOS Node process to hold the lock at a time',
        async () => {
            const workers = [
                spawnMultiprocessWorker(lockDirectory),
                spawnMultiprocessWorker(lockDirectory),
            ];
            activeWorkers.push(...workers);
            try {
                await Promise.all(workers.map(worker => worker.waitFor(['ready'])));
                for (const worker of workers) {
                    worker.send('go');
                }

                const outcomes = await Promise.all(workers.map(worker => worker.waitFor([
                    'acquired',
                    'busy',
                    'error',
                ])));
                expect(outcomes.filter(event => event.event === 'acquired')).toHaveLength(1);
                expect(outcomes.filter(event => event.event === 'busy')).toHaveLength(1);
                const acquired = outcomes.find(event => event.event === 'acquired');
                if (acquired === undefined) {
                    throw new Error('the multiprocess fixture did not report an owner');
                }
                await expect(readHostLockOwner(lockDirectory)).resolves.toMatchObject({pid: acquired.pid});

                for (const worker of workers) {
                    worker.send('release');
                }
                await Promise.all(workers.map((worker, index) => outcomes[index]?.event === 'acquired'
                    ? worker.waitFor(['released'])
                    : Promise.resolve()));
                await Promise.all(workers.map(worker => new Promise<void>(resolve => {
                    if (worker.child.exitCode !== null || worker.child.signalCode !== null) {
                        resolve();
                        return;
                    }
                    worker.child.once('exit', () => resolve());
                })));
                await expect(readHostLockOwner(lockDirectory)).resolves.toBeNull();
            } finally {
                for (const worker of workers) {
                    worker.send('release');
                }
                await Promise.all(workers.map(worker => forceKillAndWait(worker.child)));
            }
        },
        30_000,
    );
});
