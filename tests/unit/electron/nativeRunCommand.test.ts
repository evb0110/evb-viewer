import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import {
    mkdtemp,
    rm,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    onTestFinished,
    vi,
} from 'vitest';
import { join } from 'node:path';
import type { IHostResourceProfileSnapshot } from '@contracts/hostResourceProfile';

const mocks = vi.hoisted(() => ({
    spawn: vi.fn(),
    jobProof: vi.fn<() => Promise<boolean> | undefined>(() => undefined),
    terminateDetachedChildProcess: vi.fn(async (_proc: unknown, _graceMs: number): Promise<boolean> => false),
    createManagedScratchTempDir: vi.fn(async (prefix: string, rootPath?: string) => join(rootPath ?? '/tmp', `${prefix}test`)),
    removeManagedScratchTempDir: vi.fn(async (_path: string, _prefix: string, _root: string) => true),
    unregisterManagedProcess: vi.fn(async () => undefined),
    registerManagedProcess: vi.fn(async () => ({
        entryPath: '/tmp/sidecar-test.json',
        unregister: mocks.unregisterManagedProcess,
    })),
    isProcessTreeAlive: vi.fn((_pid: number) => false),
    telemetryDebug: vi.fn(),
    telemetryWarn: vi.fn(),
}));

class MockNativeProcess extends EventEmitter {
    constructor(readonly pid = 42_424) {
        super();
    }

    readonly stdout = Object.assign(new EventEmitter(), {
        destroy: vi.fn(),
        unpipe: vi.fn(),
    });

    readonly stderr = Object.assign(new EventEmitter(), {
        destroy: vi.fn(),
        unpipe: vi.fn(),
    });

    readonly kill = vi.fn();
}

vi.mock('child_process', () => ({spawn: mocks.spawn}));
vi.mock('@electron/utils/nativeChildProcess', () => ({
    spawnNativeChildProcess: mocks.spawn,
    getNativeChildProcessTerminationProof: mocks.jobProof,
    getNativeChildProcessPid: (proc: {pid?: number}) => Promise.resolve(proc.pid ?? null),
    terminateDetachedChildProcess: mocks.terminateDetachedChildProcess,
}));
vi.mock('@electron/utils/managedScratchTemp', () => ({
    createManagedScratchTempDir: mocks.createManagedScratchTempDir,
    removeManagedScratchTempDir: mocks.removeManagedScratchTempDir,
}));
vi.mock('@electron/native-tools/managedProcessRegistry', () => ({registerManagedProcess: mocks.registerManagedProcess}));
vi.mock('@electron/utils/processTree', () => ({isProcessTreeAlive: mocks.isProcessTreeAlive}));
vi.mock('@electron/utils/createLogger', () => ({createLogger: () => ({
    debug: mocks.telemetryDebug,
    info: vi.fn(),
    warn: mocks.telemetryWarn,
    error: vi.fn(),
})}));

const GIB = 1024 ** 3;

function createHostProfile(logicalCpus: number, totalRamBytes: number): IHostResourceProfileSnapshot {
    return {
        logicalCpus,
        totalRamBytes,
        safeMode: false,
        detectedTier: 'high',
        performanceMode: 'auto',
        tier: 'high',
    };
}

describe('runNativeCommand', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        vi.useRealTimers();
        vi.unstubAllEnvs();
        mocks.jobProof.mockReturnValue(undefined);
        mocks.createManagedScratchTempDir.mockImplementation(async (prefix, rootPath) => join(rootPath ?? '/tmp', `${prefix}test`));
        mocks.removeManagedScratchTempDir.mockResolvedValue(true);
        mocks.unregisterManagedProcess.mockResolvedValue(undefined);
        mocks.registerManagedProcess.mockResolvedValue({
            entryPath: '/tmp/sidecar-test.json',
            unregister: mocks.unregisterManagedProcess,
        });
        mocks.isProcessTreeAlive.mockReturnValue(false);
    });

    // Several cases below install fake timers and the last one to run would
    // otherwise leave them installed past this file. Restoring here bounds that
    // to the test that asked for them.
    afterEach(() => {
        vi.useRealTimers();
    });

    it('applies the production timeout when a caller omits one', async () => {
        vi.useFakeTimers();
        const proc = new MockNativeProcess();
        mocks.spawn.mockReturnValue(proc);
        const { runNativeCommand } = await import('@electron/native-tools/runNativeCommand');

        const resultPromise = runNativeCommand('/bin/tool', []);
        const rejection = resultPromise.catch((error: unknown) => error);
        await vi.advanceTimersByTimeAsync(15 * 60 * 1_000);

        await expect(rejection).resolves.toMatchObject({message: '/bin/tool timed out after 900000ms'});
        expect(mocks.terminateDetachedChildProcess).toHaveBeenCalledWith(proc, 1_000);
    });

    it('passes the 4 GiB supervisor memory limit for Poppler on every platform without wrapping in /bin/sh', async () => {
        const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
        onTestFinished(() => {
            Object.defineProperty(process, 'platform', platform);
        });
        const {runNativeCommand} = await import('@electron/native-tools/runNativeCommand');
        const spawnedAs = async (platformName: NodeJS.Platform, command: string) => {
            Object.defineProperty(process, 'platform', {
                value: platformName,
                configurable: true,
            });
            const proc = new MockNativeProcess();
            mocks.spawn.mockReturnValueOnce(proc);
            const result = runNativeCommand(command, [
                '-f',
                '1',
                'in.pdf',
                '-',
            ]);
            await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
            const [
                file,
                args,
                spawnOptions,
            ] = mocks.spawn.mock.calls[0]! as [string, string[], {
                memoryLimitBytes?: number;
                onMemoryLimitExceeded?: (bytes: number) => void;
            }];
            proc.emit('close', 0, null);
            await result;
            mocks.spawn.mockClear();
            return {
                file,
                args,
                memoryLimitBytes: spawnOptions.memoryLimitBytes,
                hasMemoryCallback: typeof spawnOptions.onMemoryLimitExceeded === 'function',
            };
        };

        for (const [
            platformName,
            command,
        ] of [
            [
                'linux',
                '/opt/poppler/bin/pdftotext',
            ],
            [
                'darwin',
                '/opt/poppler/bin/pdftoppm',
            ],
            [
                'win32',
                '/opt/poppler/bin/pdftoppm.exe',
            ],
        ] as const) {
            expect(await spawnedAs(platformName, command)).toEqual({
                file: command,
                args: [
                    '-f',
                    '1',
                    'in.pdf',
                    '-',
                ],
                memoryLimitBytes: 4 * 1024 ** 3,
                hasMemoryCallback: true,
            });
        }
        expect(await spawnedAs('linux', '/opt/tools/evb-pdf-page-ops')).toEqual({
            file: '/opt/tools/evb-pdf-page-ops',
            args: [
                '-f',
                '1',
                'in.pdf',
                '-',
            ],
            memoryLimitBytes: undefined,
            hasMemoryCallback: false,
        });
    });

    it.each([
        [
            'darwin',
            '/opt/poppler/bin/pdftoppm',
        ],
        [
            'linux',
            '/opt/poppler/bin/pdftoppm',
        ],
        [
            'win32',
            '/opt/poppler/bin/pdftoppm.exe',
        ],
    ] as const)('stops Poppler on %s when the native supervisor reports a memory-limit breach and leaves other tools alone', async (platformName, popplerPath) => {
        const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
        onTestFinished(() => {
            Object.defineProperty(process, 'platform', platform);
        });
        Object.defineProperty(process, 'platform', {
            value: platformName,
            configurable: true,
        });
        const {runNativeCommand} = await import('@electron/native-tools/runNativeCommand');
        const poppler = new MockNativeProcess(7_001);
        const otherTool = new MockNativeProcess(7_002);
        mocks.spawn.mockReturnValueOnce(poppler).mockReturnValueOnce(otherTool);
        mocks.terminateDetachedChildProcess.mockResolvedValueOnce(true);

        const popplerRejection = runNativeCommand(popplerPath, ['in.pdf']).then(
            () => null,
            (error: Error) => error,
        );
        const otherResult = runNativeCommand('/opt/tools/evb-pdf-page-ops', ['in.pdf']);
        await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledTimes(2));

        const popplerOptions = mocks.spawn.mock.calls[0]![2] as {
            memoryLimitBytes?: number;
            onMemoryLimitExceeded?: (bytes: number) => void;
        };
        const otherOptions = mocks.spawn.mock.calls[1]![2] as {
            memoryLimitBytes?: number;
            onMemoryLimitExceeded?: (bytes: number) => void;
        };
        expect(popplerOptions.memoryLimitBytes).toBe(4 * 1024 ** 3);
        expect(otherOptions.memoryLimitBytes).toBeUndefined();

        popplerOptions.onMemoryLimitExceeded?.(5 * 1024 ** 3);

        expect((await popplerRejection)?.message).toBe(`${popplerPath} stopped after using more than 4 GiB of memory`);
        expect(mocks.terminateDetachedChildProcess).toHaveBeenCalledExactlyOnceWith(poppler, 1_000);

        otherTool.emit('close', 0, null);
        await expect(otherResult).resolves.toMatchObject({exitCode: 0});
    });

    it('routes managed native temp files to per-invocation scratch and removes it after success', async () => {
        vi.stubEnv('EVB_APP_TEMP_NAMESPACE', 'profile-one');
        const proc = new MockNativeProcess();
        mocks.spawn.mockReturnValue(proc);
        const {runNativeCommand} = await import('@electron/native-tools/runNativeCommand');

        const resultPromise = runNativeCommand('/bin/tool', [], {env: {EXTRA: 'preserved'}});
        await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
        const scratchPath = await mocks.createManagedScratchTempDir.mock.results[0]!.value;
        const spawnOptions = mocks.spawn.mock.calls[0]?.[2] as {env: NodeJS.ProcessEnv};
        expect(spawnOptions.env).toMatchObject({
            EXTRA: 'preserved',
            TMPDIR: scratchPath,
            TMP: scratchPath,
            TEMP: scratchPath,
        });

        proc.emit('close', 0, null);
        await expect(resultPromise).resolves.toMatchObject({exitCode: 0});
        expect(mocks.registerManagedProcess).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({
                pid: proc.pid,
                scratchPath,
            }),
        );
        expect(mocks.removeManagedScratchTempDir).toHaveBeenCalledWith(
            scratchPath,
            'native-command-',
            expect.any(String),
        );
        expect(mocks.unregisterManagedProcess).toHaveBeenCalledOnce();
    });

    it('keeps concurrent native invocations in separate scratch directories', async () => {
        vi.stubEnv('EVB_APP_TEMP_NAMESPACE', 'profile-one');
        const scratchRoot = await mkdtemp(join(tmpdir(), 'native-run-command-test-'));
        const secondSpawned = Promise.withResolvers<number>();
        // Filesystem work may finish out of call order. Hold the first
        // allocation until the second invocation has actually spawned.
        mocks.createManagedScratchTempDir
            .mockImplementationOnce(async (prefix) => {
                const path = await mkdtemp(join(scratchRoot, prefix));
                await secondSpawned.promise;
                return path;
            })
            .mockImplementation(async prefix => mkdtemp(join(scratchRoot, prefix)));
        mocks.removeManagedScratchTempDir.mockImplementation(async path => {
            await rm(path, {
                force: true,
                recursive: true,
            });
            return true;
        });
        const processes = [
            new MockNativeProcess(),
            new MockNativeProcess(42_425),
        ];
        mocks.spawn.mockReturnValueOnce(processes[0]).mockReturnValueOnce(processes[1]);
        const {runNativeCommand} = await import('@electron/native-tools/runNativeCommand');

        const firstSpawned = Promise.withResolvers<number>();
        const firstResult = runNativeCommand('/bin/tool', [], {onSpawn: firstSpawned.resolve});
        const secondResult = runNativeCommand('/bin/tool', [], {onSpawn: secondSpawned.resolve});
        const [
            firstPid,
            secondPid,
        ] = await Promise.all([
            firstSpawned.promise,
            secondSpawned.promise,
        ]);
        const firstProcess = processes.find(proc => proc.pid === firstPid)!;
        const secondProcess = processes.find(proc => proc.pid === secondPid)!;
        const firstScratch = await mocks.createManagedScratchTempDir.mock.results[0]!.value;
        const secondScratch = await mocks.createManagedScratchTempDir.mock.results[1]!.value;

        expect(firstScratch).not.toBe(secondScratch);
        expect(existsSync(firstScratch)).toBe(true);
        expect(existsSync(secondScratch)).toBe(true);

        firstProcess.emit('close', 0, null);
        await expect(firstResult).resolves.toMatchObject({exitCode: 0});
        expect(existsSync(firstScratch)).toBe(false);
        expect(existsSync(secondScratch)).toBe(true);

        secondProcess.emit('close', 0, null);
        await expect(secondResult).resolves.toMatchObject({exitCode: 0});
        expect(existsSync(secondScratch)).toBe(false);
        await rm(scratchRoot, {
            force: true,
            recursive: true,
        });
    });

    it('cleans an ordinary native error only when its process tree is proven stopped', async () => {
        const {getUnprovenNativeTerminationDetail} = await import('@electron/utils/nativeTerminationProof');
        vi.stubEnv('EVB_APP_TEMP_NAMESPACE', 'profile-one');
        const proc = new MockNativeProcess();
        mocks.spawn.mockReturnValue(proc);
        const {runNativeCommand} = await import('@electron/native-tools/runNativeCommand');

        const resultPromise = runNativeCommand('/bin/tool', []);
        await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
        proc.emit('close', 2, null);

        const failure: unknown = await resultPromise.catch((error: unknown) => error);
        expect(failure).toMatchObject({kind: 'exit-code'});
        if (process.platform === 'win32') {
            expect(getUnprovenNativeTerminationDetail(failure)).toBeDefined();
            expect(mocks.removeManagedScratchTempDir).not.toHaveBeenCalled();
            expect(mocks.unregisterManagedProcess).not.toHaveBeenCalled();
        } else {
            expect(getUnprovenNativeTerminationDetail(failure)).toBeUndefined();
            expect(mocks.removeManagedScratchTempDir).toHaveBeenCalledOnce();
            expect(mocks.unregisterManagedProcess).toHaveBeenCalledOnce();
        }
    });

    it('removes managed native scratch after confirmed cancellation', async () => {
        vi.stubEnv('EVB_APP_TEMP_NAMESPACE', 'profile-one');
        const proc = new MockNativeProcess();
        mocks.spawn.mockReturnValue(proc);
        mocks.terminateDetachedChildProcess.mockResolvedValueOnce(true);
        const controller = new AbortController();
        const {runNativeCommand} = await import('@electron/native-tools/runNativeCommand');

        const resultPromise = runNativeCommand('/bin/tool', [], {signal: controller.signal});
        await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
        controller.abort();

        await expect(resultPromise).rejects.toMatchObject({message: /(?:This|The) operation was aborted/u});
        expect(mocks.removeManagedScratchTempDir).toHaveBeenCalledOnce();
        expect(mocks.unregisterManagedProcess).toHaveBeenCalledOnce();
    });

    it('keeps managed native scratch when cancellation cannot prove tree death', async () => {
        vi.stubEnv('EVB_APP_TEMP_NAMESPACE', 'profile-one');
        const proc = new MockNativeProcess();
        mocks.spawn.mockReturnValue(proc);
        mocks.terminateDetachedChildProcess.mockResolvedValueOnce(false);
        const controller = new AbortController();
        const {runNativeCommand} = await import('@electron/native-tools/runNativeCommand');

        const resultPromise = runNativeCommand('/bin/tool', [], {signal: controller.signal});
        await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
        controller.abort();

        await expect(resultPromise).rejects.toMatchObject({message: /(?:This|The) operation was aborted/u});
        expect(mocks.removeManagedScratchTempDir).not.toHaveBeenCalled();
        expect(mocks.unregisterManagedProcess).not.toHaveBeenCalled();
    });

    it('rejects an already-aborted signal before spawning', async () => {
        const controller = new AbortController();
        controller.abort();
        const { runNativeCommand } = await import('@electron/native-tools/runNativeCommand');

        await expect(runNativeCommand('/bin/tool', [], {signal: controller.signal}))
            .rejects.toThrow(/(?:This|The) operation was aborted/u);

        expect(mocks.spawn).not.toHaveBeenCalled();
    });

    it('resolves allowed exit codes and captures bounded stdout/stderr', async () => {
        const proc = new MockNativeProcess();
        mocks.spawn.mockReturnValue(proc);
        const { runNativeCommand } = await import('@electron/native-tools/runNativeCommand');

        const resultPromise = runNativeCommand('/bin/tool', ['--version'], {allowedExitCodes: [
            0,
            3,
        ]});
        proc.stdout.emit('data', Buffer.from('ok'));
        proc.stderr.emit('data', Buffer.from('warn'));
        proc.emit('close', 3, null);

        await expect(resultPromise).resolves.toEqual({
            stdout: 'ok',
            stderr: 'warn',
            exitCode: 3,
        });
    });

    it('streams long-lived stdout without retaining it and reports close', async () => {
        const proc = new MockNativeProcess();
        const chunks: string[] = [];
        const onClose = vi.fn();
        mocks.spawn.mockReturnValue(proc);
        const {runNativeCommand} = await import('@electron/native-tools/runNativeCommand');

        const resultPromise = runNativeCommand('/bin/tool', [], {
            longLived: true,
            maxStdoutBytes: 3,
            onStdout: chunk => chunks.push(chunk),
            onClose,
        });
        proc.stdout.emit('data', Buffer.from('streamed output'));
        proc.emit('close', 0, null);

        await expect(resultPromise).resolves.toEqual({
            stdout: '',
            stderr: '',
            exitCode: 0,
        });
        expect(chunks.join('')).toBe('streamed output');
        expect(onClose).toHaveBeenCalledOnce();
    });

    it('reports the spawned process before it can finish', async () => {
        const proc = new MockNativeProcess();
        const onSpawn = vi.fn();
        mocks.spawn.mockReturnValue(proc);
        const {runNativeCommand} = await import('@electron/native-tools/runNativeCommand');

        const resultPromise = runNativeCommand('/bin/tool', [], {onSpawn});

        expect(onSpawn).toHaveBeenCalledOnce();
        expect(onSpawn).toHaveBeenCalledWith(proc.pid, expect.any(Function), undefined);
        proc.emit('close', 0, null);
        await expect(resultPromise).resolves.toMatchObject({exitCode: 0});
    });

    it('keeps a long successful process out of the warning log', async () => {
        vi.useFakeTimers();
        const proc = new MockNativeProcess();
        mocks.spawn.mockReturnValue(proc);
        const {runNativeCommand} = await import('@electron/native-tools/runNativeCommand');

        const resultPromise = runNativeCommand('/bin/tool', [], {commandLabel: 'slow-tool'});
        await vi.advanceTimersByTimeAsync(60_000);
        proc.emit('close', 0, null);
        await expect(resultPromise).resolves.toMatchObject({exitCode: 0});

        // A scanned page takes seconds to render; its age is timing detail.
        expect(mocks.telemetryWarn).not.toHaveBeenCalled();
        expect(mocks.telemetryDebug).toHaveBeenCalledWith('Native process settled', expect.objectContaining({
            command: 'slow-tool',
            durationMs: 60_000,
            exitCode: 0,
            outcome: 'resolved',
        }));
    });

    it('terminates the process when the spawn callback fails', async () => {
        const proc = new MockNativeProcess();
        mocks.spawn.mockReturnValue(proc);
        mocks.terminateDetachedChildProcess.mockResolvedValueOnce(true);
        const {runNativeCommand} = await import('@electron/native-tools/runNativeCommand');

        const resultPromise = runNativeCommand('/bin/tool', [], {
            onSpawn: () => {
                throw new Error('spawn callback exploded');
            },
            terminationGraceMs: 2_345,
        });

        await expect(resultPromise).rejects.toThrow('spawn handler failed: spawn callback exploded');
        expect(mocks.terminateDetachedChildProcess).toHaveBeenCalledWith(proc, 2_345);
    });

    it('rejects a spawn callback when the child has no usable process id', async () => {
        const proc = new MockNativeProcess();
        Object.defineProperty(proc, 'pid', {value: 0});
        mocks.spawn.mockReturnValue(proc);
        mocks.terminateDetachedChildProcess.mockResolvedValueOnce(true);
        const onSpawn = vi.fn();
        const {runNativeCommand} = await import('@electron/native-tools/runNativeCommand');

        const resultPromise = runNativeCommand('/bin/tool', [], {
            onSpawn,
            terminationGraceMs: 2_345,
        });

        await expect(resultPromise).rejects.toThrow('spawned without a valid process id');
        expect(onSpawn).not.toHaveBeenCalled();
        expect(mocks.terminateDetachedChildProcess).toHaveBeenCalledWith(proc, 2_345);
    });

    it.each([
        [
            'stdout' as const,
            'onStdout' as const,
        ],
        [
            'stderr' as const,
            'onStderr' as const,
        ],
    ])('contains throwing %s callbacks and terminates the helper', async (stream, callbackName) => {
        const proc = new MockNativeProcess();
        mocks.spawn.mockReturnValue(proc);
        const {runNativeCommand} = await import('@electron/native-tools/runNativeCommand');
        const resultPromise = runNativeCommand('/bin/tool', [], {[callbackName]: () => {
            throw new Error('callback exploded');
        }});

        expect(() => proc[stream].emit('data', Buffer.from('progress'))).not.toThrow();

        await expect(resultPromise).rejects.toThrow(`${stream} handler failed: callback exploded`);
        expect(mocks.terminateDetachedChildProcess).toHaveBeenCalledWith(proc, 1_000);
    });

    it('rejects a callback failure raised while flushing the decoder on close', async () => {
        const proc = new MockNativeProcess();
        mocks.spawn.mockReturnValue(proc);
        const {runNativeCommand} = await import('@electron/native-tools/runNativeCommand');
        const resultPromise = runNativeCommand('/bin/tool', [], {onStdout: () => {
            throw new Error('flush callback exploded');
        }});

        proc.stdout.emit('data', Buffer.from([0xd0]));
        proc.emit('close', 0, null);

        await expect(resultPromise).rejects.toThrow('stdout handler failed: flush callback exploded');
        expect(mocks.terminateDetachedChildProcess).toHaveBeenCalledWith(proc, 1_000);
    });

    it('decodes UTF-8 incrementally when multibyte characters straddle process chunks', async () => {
        const proc = new MockNativeProcess();
        const onStdout = vi.fn();
        const onStderr = vi.fn();
        mocks.spawn.mockReturnValue(proc);
        const {runNativeCommand} = await import('@electron/native-tools/runNativeCommand');

        const resultPromise = runNativeCommand('/bin/tool', [], {
            onStderr,
            onStdout,
        });
        const russian = Buffer.from('Предисловие', 'utf8');
        const splitAt = russian.indexOf(0xd1) + 1;
        const stderr = Buffer.from('ошибка', 'utf8');
        proc.stdout.emit('data', russian.subarray(0, splitAt));
        proc.stdout.emit('data', russian.subarray(splitAt));
        proc.stderr.emit('data', stderr.subarray(0, 1));
        proc.stderr.emit('data', stderr.subarray(1));
        proc.emit('close', 0, null);

        await expect(resultPromise).resolves.toEqual({
            stdout: 'Предисловие',
            stderr: 'ошибка',
            exitCode: 0,
        });
        expect(onStdout.mock.calls.flat().join('')).toBe('Предисловие');
        expect(onStderr.mock.calls.flat().join('')).toBe('ошибка');
        expect(onStdout.mock.calls.flat().join('')).not.toContain('\ufffd');
        expect(onStderr.mock.calls.flat().join('')).not.toContain('\ufffd');
    });

    it('formats nonzero exits with truncated output and close signal details', async () => {
        const proc = new MockNativeProcess();
        const log = vi.fn();
        mocks.spawn.mockReturnValue(proc);
        const { runNativeCommand } = await import('@electron/native-tools/runNativeCommand');

        const resultPromise = runNativeCommand('/bin/tool', ['--bad'], {
            commandLabel: 'fixture-tool',
            maxStdoutBytes: 4,
            maxStderrBytes: 4,
            log,
        });
        const rejection: Promise<Error> = resultPromise.then(
            () => {
                throw new Error('Expected command to reject');
            },
            error => error as Error,
        );
        proc.stdout.emit('data', Buffer.from('abcdef'));
        proc.stderr.emit('data', Buffer.from('uvwxyz'));
        proc.emit('close', 2, 'SIGTERM');

        const error = await rejection;
        expect(error.message).toContain('fixture-tool failed with exit code 2');
        expect(error.message).toContain('[stderr truncated to 4 bytes]');
        expect(error.message).toContain('signal=SIGTERM');
        expect(error.name).toBe('NativeProcessError');
        const {stdout, stderr} = error as Error & {stdout: string; stderr: string};
        expect(stdout).toMatch(/^.{1,4}$/u);
        expect('abcdef'.endsWith(stdout)).toBe(true);
        expect(stderr).toMatch(/^.{1,4}$/u);
        expect('uvwxyz'.endsWith(stderr)).toBe(true);
        expect(error.message).toContain(`[stderr truncated to 4 bytes]\n${stderr}`);
        expect(log).toHaveBeenCalledWith('error', expect.stringContaining('cmd=/bin/tool --bad'));
    });

    it.each([
        'SIGKILL',
        'SIGBUS',
        'SIGSEGV',
    ] as const)(
        'classifies a signal-only %s exit with its typed signal instead of exit code -1',
        async signal => {
            const proc = new MockNativeProcess();
            mocks.spawn.mockReturnValue(proc);
            const {runNativeCommand} = await import('@electron/native-tools/runNativeCommand');

            const resultPromise = runNativeCommand('/bin/tool', []);
            const rejection: Promise<Error & {
                closeSignal?: NodeJS.Signals | null;
                exitCode?: number | null;
                kind?: string;
            }> = resultPromise.then(
                () => {
                    throw new Error('Expected command to reject');
                },
                error => error as Error & {
                    closeSignal?: NodeJS.Signals | null;
                    exitCode?: number | null;
                    kind?: string;
                },
            );
            proc.emit('close', null, signal);

            const error = await rejection;
            expect(error).toMatchObject({
                closeSignal: signal,
                exitCode: null,
                kind: 'signal',
            });
            expect(error.message).toContain(`failed after signal ${signal}`);
            expect(error.message).not.toContain('exit code -1');
        },
    );

    it('classifies native failures from a structured error code instead of message text', async () => {
        const proc = new MockNativeProcess();
        mocks.spawn.mockReturnValue(proc);
        const {runNativeCommand} = await import('@electron/native-tools/runNativeCommand');

        const resultPromise = runNativeCommand('/bin/tool', []);
        proc.stderr.emit('data', Buffer.from('{"code":"corrupt-xref","message":"localized detail"}\n'));
        proc.emit('close', 2, null);

        await expect(resultPromise).rejects.toMatchObject({
            code: 'corrupt-xref',
            message: 'localized detail',
            name: 'NativeToolError',
        });
    });

    it('does not classify an earlier third-party diagnostic as the native error envelope', async () => {
        const proc = new MockNativeProcess();
        mocks.spawn.mockReturnValue(proc);
        const {runNativeCommand} = await import('@electron/native-tools/runNativeCommand');

        const resultPromise = runNativeCommand('/bin/tool', []);
        proc.stderr.emit('data', Buffer.from('{"code":"too-large","message":"diagnostic"}\n'));
        proc.stderr.emit('data', Buffer.from('third-party failure\n'));
        proc.emit('close', 2, null);

        await expect(resultPromise).rejects.toMatchObject({
            name: 'NativeProcessError',
            message: expect.stringContaining('/bin/tool failed with exit code 2'),
        });
    });

    it('rejects stdout truncation by default even for successful exits', async () => {
        const proc = new MockNativeProcess();
        mocks.spawn.mockReturnValue(proc);
        const { runNativeCommand } = await import('@electron/native-tools/runNativeCommand');

        const resultPromise = runNativeCommand('/bin/tool', [], {
            commandLabel: 'fixture-tool',
            maxStdoutBytes: 3,
        });
        const rejection: Promise<Error> = resultPromise.then(
            () => {
                throw new Error('Expected command to reject');
            },
            error => error as Error,
        );
        proc.stdout.emit('data', Buffer.from('abcdef'));
        proc.emit('close', 0, null);

        await expect(rejection).resolves.toMatchObject({message: 'fixture-tool stdout exceeded 3 bytes'});
    });

    it('allows stdout truncation when explicitly requested', async () => {
        const proc = new MockNativeProcess();
        mocks.spawn.mockReturnValue(proc);
        const { runNativeCommand } = await import('@electron/native-tools/runNativeCommand');

        const resultPromise = runNativeCommand('/bin/tool', [], {
            maxStdoutBytes: 3,
            rejectOnStdoutTruncation: false,
        });
        proc.stdout.emit('data', Buffer.from('abcdef'));
        proc.emit('close', 0, null);

        await expect(resultPromise).resolves.toEqual({
            stdout: 'ef',
            stderr: '',
            exitCode: 0,
        });
    });

    it('terminates and cleans up listeners on timeout', async () => {
        vi.useFakeTimers();
        const proc = new MockNativeProcess();
        const controller = new AbortController();
        const removeEventListener = vi.spyOn(controller.signal, 'removeEventListener');
        mocks.spawn.mockReturnValue(proc);
        const { runNativeCommand } = await import('@electron/native-tools/runNativeCommand');

        const resultPromise = runNativeCommand('/bin/tool', [], {
            signal: controller.signal,
            timeoutMs: 10,
        });
        const rejection: Promise<Error> = resultPromise.then(
            () => {
                throw new Error('Expected command to reject');
            },
            error => error as Error,
        );
        await vi.advanceTimersByTimeAsync(10);

        const error = await rejection;
        expect(error.message).toBe('/bin/tool timed out after 10ms');
        expect(mocks.terminateDetachedChildProcess).toHaveBeenCalledWith(proc, 1_000);
        expect(removeEventListener).toHaveBeenCalledWith('abort', expect.any(Function));
        expect(proc.stdout.listenerCount('data')).toBe(0);
        expect(proc.stderr.listenerCount('data')).toBe(0);
        expect(proc.listenerCount('close')).toBe(0);
        expect(proc.stdout.destroy).toHaveBeenCalledTimes(1);
        expect(proc.stderr.destroy).toHaveBeenCalledTimes(1);
    });

    // Whether the child's process tree actually died decides whether the caller
    // that owns its input files may reclaim them. These three cases are the only
    // ones the runner can distinguish, and each has to travel on the rejection.
    it('leaves a confirmed process-tree termination unmarked', async () => {
        vi.useFakeTimers();
        mocks.terminateDetachedChildProcess.mockResolvedValue(true);
        const proc = new MockNativeProcess();
        mocks.spawn.mockReturnValue(proc);
        const log = vi.fn();
        const onTerminationProof = vi.fn();
        const { runNativeCommand } = await import('@electron/native-tools/runNativeCommand');
        const { getUnprovenNativeTerminationDetail } = await import('@electron/utils/nativeTerminationProof');

        const rejection = runNativeCommand('/bin/tool', [], {
            log,
            timeoutMs: 10,
            onTerminationProof,
        }).catch((error: unknown) => error);
        await vi.advanceTimersByTimeAsync(10);

        const error = await rejection;
        expect((error as Error).message).toBe('/bin/tool timed out after 10ms');
        expect(getUnprovenNativeTerminationDetail(error)).toBeUndefined();
        expect(onTerminationProof).toHaveBeenCalledOnce();
        await expect(onTerminationProof.mock.calls[0]![0]).resolves.toBe(true);
        expect(log).not.toHaveBeenCalledWith('warn', expect.stringContaining('did not confirm process-tree'));
    });

    it('marks a rejection whose process tree termination reported failure', async () => {
        vi.useFakeTimers();
        // `terminateDetachedChildProcess` answering anything but `true` means the
        // tree was still alive when the kill gave up, so its inputs may still be
        // open.
        mocks.terminateDetachedChildProcess.mockResolvedValue(false);
        const proc = new MockNativeProcess();
        mocks.spawn.mockReturnValue(proc);
        const log = vi.fn();
        const { runNativeCommand } = await import('@electron/native-tools/runNativeCommand');
        const { getUnprovenNativeTerminationDetail } = await import('@electron/utils/nativeTerminationProof');

        const rejection = runNativeCommand('/bin/tool', [], {
            log,
            timeoutMs: 10,
        }).catch((error: unknown) => error);
        await vi.advanceTimersByTimeAsync(10);

        const error = await rejection;
        expect((error as Error).message).toBe('/bin/tool timed out after 10ms');
        expect(getUnprovenNativeTerminationDetail(error)).toContain('was not proven dead');
        expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('did not confirm process-tree termination'));
    });

    it('marks a rejection released by the force-reject bound rather than by termination', async () => {
        vi.useFakeTimers();
        // A termination that never answers: the bound below releases the caller,
        // and giving up waiting is not evidence the tree died.
        mocks.terminateDetachedChildProcess.mockImplementation(() => new Promise<boolean>(() => {}));
        const proc = new MockNativeProcess();
        mocks.spawn.mockReturnValue(proc);
        const { runNativeCommand } = await import('@electron/native-tools/runNativeCommand');
        const { getUnprovenNativeTerminationDetail } = await import('@electron/utils/nativeTerminationProof');

        const rejection = runNativeCommand('/bin/tool', [], {
            terminationGraceMs: 500,
            timeoutMs: 10,
        }).catch((error: unknown) => error);
        await vi.advanceTimersByTimeAsync(10);
        await vi.advanceTimersByTimeAsync(2_500);

        const error = await rejection;
        expect((error as Error).message).toBe('/bin/tool timed out after 10ms');
        expect(getUnprovenNativeTerminationDetail(error)).toContain('within 2500ms of termination');
    });

    it('marks an aborted command whose child closed before its tree was confirmed', async () => {
        // `close` only says this child's stdio ended; the detached group it led
        // can outlive it, so the termination result stays the authority.
        mocks.terminateDetachedChildProcess.mockResolvedValue(false);
        const proc = new MockNativeProcess();
        mocks.spawn.mockReturnValue(proc);
        const controller = new AbortController();
        const { runNativeCommand } = await import('@electron/native-tools/runNativeCommand');
        const { getUnprovenNativeTerminationDetail } = await import('@electron/utils/nativeTerminationProof');

        const rejection = runNativeCommand('/bin/tool', [], {signal: controller.signal})
            .catch((error: unknown) => error);
        controller.abort();
        proc.emit('close', null, 'SIGTERM');

        const error = await rejection;
        expect(getUnprovenNativeTerminationDetail(error)).toContain('was not proven dead');
    });

    it('waits for termination proof when the child closes before the proof settles', async () => {
        let proveTermination!: (terminated: boolean) => void;
        const proc = new MockNativeProcess();
        mocks.spawn.mockReturnValue(proc);
        mocks.terminateDetachedChildProcess.mockImplementation(() => new Promise<boolean>(resolve => {
            proveTermination = resolve;
        }));
        const controller = new AbortController();
        const { runNativeCommand } = await import('@electron/native-tools/runNativeCommand');
        const { getUnprovenNativeTerminationDetail } = await import('@electron/utils/nativeTerminationProof');

        const rejection = runNativeCommand('/bin/tool', [], {signal: controller.signal})
            .catch((error: unknown) => error);
        controller.abort();
        await Promise.resolve();
        proc.emit('close', null, 'SIGTERM');
        proveTermination(true);

        const error = await rejection;
        expect(getUnprovenNativeTerminationDetail(error)).toBeUndefined();
    });

    it('streams output chunks and cancels named command groups', async () => {
        const proc = new MockNativeProcess();
        const onStdout = vi.fn();
        const onStderr = vi.fn();
        mocks.spawn.mockReturnValue(proc);
        mocks.terminateDetachedChildProcess.mockResolvedValueOnce(true);
        const {
            cancelNativeCommandGroup,
            runNativeCommand,
        } = await import('@electron/native-tools/runNativeCommand');

        const resultPromise = runNativeCommand('/bin/tool', ['--watch'], {
            cancelGroup: 'job-1',
            onStderr,
            onStdout,
        });
        const rejection: Promise<Error> = resultPromise.then(
            () => {
                throw new Error('Expected command to reject');
            },
            error => error as Error,
        );

        proc.stdout.emit('data', Buffer.from('progress'));
        proc.stderr.emit('data', Buffer.from('warning'));
        expect(cancelNativeCommandGroup('job-1')).toBe(true);

        const error = await rejection;
        expect(error.message).toBe('The operation was aborted');
        expect(onStdout).toHaveBeenCalledWith('progress');
        expect(onStderr).toHaveBeenCalledWith('warning');
        expect(mocks.terminateDetachedChildProcess).toHaveBeenCalledWith(proc, 1_000);
        expect(cancelNativeCommandGroup('job-1')).toBe(false);
    });

    it('waits for detached native termination before acknowledging cancellation', async () => {
        const proc = new MockNativeProcess();
        mocks.spawn.mockReturnValue(proc);
        mocks.terminateDetachedChildProcess.mockResolvedValueOnce(true);
        const {
            cancelNativeCommandGroupAndWait,
            runNativeCommand,
        } = await import('@electron/native-tools/runNativeCommand');

        const resultPromise = runNativeCommand('/bin/tool', ['--watch'], {cancelGroup: 'job-ack'});
        const rejection = resultPromise.catch((error: unknown) => error as Error);

        await expect(cancelNativeCommandGroupAndWait('job-ack')).resolves.toBe(true);
        await expect(rejection).resolves.toMatchObject({message: 'The operation was aborted'});
        expect(mocks.terminateDetachedChildProcess).toHaveBeenCalledWith(proc, 1_000);
    });

    it.each([
        'abnormal-close',
        'cancellation',
        'job-close',
    ] as const)('retains real Windows scratch after unproven %s', async mode => {
        const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
        const scratchRoot = await mkdtemp(join(tmpdir(), 'native-windows-containment-'));
        onTestFinished(async () => {
            Object.defineProperty(process, 'platform', platform);
            await rm(scratchRoot, {
                recursive: true,
                force: true,
            });
        });
        Object.defineProperty(process, 'platform', {
            value: 'win32',
            configurable: true,
        });
        vi.stubEnv('EVB_APP_TEMP_NAMESPACE', 'windows-containment');
        mocks.createManagedScratchTempDir.mockImplementation(async prefix => mkdtemp(join(scratchRoot, prefix)));
        mocks.removeManagedScratchTempDir.mockImplementation(async path => {
            await rm(path, {
                recursive: true,
                force: true,
            }); return true;
        });
        const proc = new MockNativeProcess();
        mocks.spawn.mockReturnValue(proc);
        mocks.terminateDetachedChildProcess.mockResolvedValueOnce(false);
        if (mode === 'job-close') mocks.jobProof.mockReturnValue(Promise.resolve(false));
        const {
            configureMainJobBroker,
            mainJobBroker,
        } = await import('@electron/resources/jobBroker');
        configureMainJobBroker(createHostProfile(8, 16 * GIB));
        const {runNativeCommand} = await import('@electron/native-tools/runNativeCommand');
        const {getUnprovenNativeTerminationDetail} = await import('@electron/utils/nativeTerminationProof');
        const controller = new AbortController();
        const result = runNativeCommand('/native/qpdf.exe', [], {signal: controller.signal});
        const rejection = result.catch((error: unknown) => error);
        await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
        const scratch = await mocks.createManagedScratchTempDir.mock.results[0]!.value;
        if (mode === 'cancellation') controller.abort(new Error('cancel native command'));
        proc.emit('close', 2, null);
        expect(getUnprovenNativeTerminationDetail(await rejection)).toBeDefined();
        expect(existsSync(scratch)).toBe(true);
        expect(mocks.unregisterManagedProcess).not.toHaveBeenCalled();
        // A child not proven gone keeps its native-process charge on the broker.
        expect(mainJobBroker.getSnapshot()).toMatchObject({
            active: 1,
            used: {nativeProcesses: 1},
        });
    });

    it('keeps scratch until the owned Windows job acknowledges empty', async () => {
        vi.stubEnv('EVB_APP_TEMP_NAMESPACE', 'windows-job-proof');
        const scratchRoot = await mkdtemp(join(tmpdir(), 'native-windows-proof-'));
        onTestFinished(() => rm(scratchRoot, {
            recursive: true,
            force: true,
        }));
        mocks.createManagedScratchTempDir.mockImplementation(async prefix => mkdtemp(join(scratchRoot, prefix)));
        mocks.removeManagedScratchTempDir.mockImplementation(async path => {
            await rm(path, {
                recursive: true,
                force: true,
            });
            return true;
        });
        const proof = Promise.withResolvers<boolean>();
        mocks.jobProof.mockReturnValue(proof.promise);
        const proc = new MockNativeProcess();
        mocks.spawn.mockReturnValue(proc);
        const {runNativeCommand} = await import('@electron/native-tools/runNativeCommand');
        const result = runNativeCommand('/native/qpdf.exe', []);
        await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
        const scratch = await mocks.createManagedScratchTempDir.mock.results[0]!.value;
        proc.emit('close', 0, null);
        await Promise.resolve();
        expect(existsSync(scratch)).toBe(true);
        proof.resolve(true);
        await expect(result).resolves.toMatchObject({exitCode: 0});
        expect(existsSync(scratch)).toBe(false);
    });

});

describe('runNativeCommand broker admission', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        vi.useRealTimers();
        vi.unstubAllEnvs();
        vi.stubEnv('EVB_PDF_COMBINE_THREADS', undefined);
        mocks.jobProof.mockReturnValue(undefined);
        mocks.isProcessTreeAlive.mockReturnValue(false);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    async function loadConfigured(profile = createHostProfile(32, 64 * GIB)) {
        const broker = await import('@electron/resources/jobBroker');
        broker.configureMainJobBroker(profile);
        const {runNativeCommand} = await import('@electron/native-tools/runNativeCommand');
        return {
            ...broker,
            runNativeCommand,
        };
    }

    function spawnEnv(callIndex = 0) {
        const options = mocks.spawn.mock.calls[callIndex]?.[2] as {env?: NodeJS.ProcessEnv} | undefined;
        return options?.env ?? {};
    }

    it('runs more than eight commands at once on a large host', async () => {
        const processes = Array.from({length: 12}, (_, index) => new MockNativeProcess(50_000 + index));
        for (const proc of processes) mocks.spawn.mockReturnValueOnce(proc);
        const {
            mainJobBroker,
            runNativeCommand,
        } = await loadConfigured();

        const results = processes.map(() => runNativeCommand('/bin/tool', []));

        await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledTimes(12));
        expect(mainJobBroker.getSnapshot()).toMatchObject({
            active: 12,
            queued: 0,
            used: {nativeProcesses: 12},
        });
        for (const proc of processes) proc.emit('close', 0, null);
        await Promise.all(results);
        expect(mainJobBroker.getSnapshot()).toMatchObject({
            active: 0,
            used: {nativeProcesses: 0},
        });
    });

    it('keeps a queued command waiting past thirty seconds instead of failing it', async () => {
        vi.useFakeTimers();
        const proc = new MockNativeProcess();
        mocks.spawn.mockReturnValue(proc);
        const {
            mainJobBroker,
            runNativeCommand,
        } = await loadConfigured(createHostProfile(2, 4 * GIB));
        const occupant = await mainJobBroker.acquire({
            ownerId: 'occupant',
            kind: 'native-command',
            priority: 'user',
            admissionClass: 'leaf',
            resources: mainJobBroker.getSnapshot().capacity,
        });
        let settled = false;
        const result = runNativeCommand('/bin/tool', []).finally(() => {
            settled = true;
        });

        await vi.advanceTimersByTimeAsync(5 * 60 * 1_000);
        expect(settled).toBe(false);
        expect(mocks.spawn).not.toHaveBeenCalled();
        expect(mainJobBroker.getSnapshot().queued).toBe(1);

        occupant.release();
        await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
        proc.emit('close', 0, null);
        await expect(result).resolves.toMatchObject({exitCode: 0});
    });

    it('keeps the native-process charge when the child reports an error while its termination is unproven', async () => {
        const proc = new MockNativeProcess();
        mocks.spawn.mockReturnValue(proc);
        const termination = Promise.withResolvers<boolean>();
        mocks.terminateDetachedChildProcess.mockImplementation(() => termination.promise);
        const {
            mainJobBroker,
            runNativeCommand,
        } = await loadConfigured();
        const {getUnprovenNativeTerminationDetail} = await import('@electron/utils/nativeTerminationProof');
        const controller = new AbortController();
        const rejection = runNativeCommand('/bin/tool', [], {signal: controller.signal})
            .catch((error: unknown) => error);
        await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());

        controller.abort(new Error('cancel native command'));
        await vi.waitFor(() => expect(mocks.terminateDetachedChildProcess).toHaveBeenCalledOnce());
        // Sol's probe: a failed kill surfaces as a child `error` before the
        // termination proof settles.
        proc.emit('error', new Error('kill EPERM'));
        await new Promise(resolve => setImmediate(resolve));
        expect(mainJobBroker.getSnapshot()).toMatchObject({
            active: 1,
            used: {nativeProcesses: 1},
        });

        termination.resolve(false);
        const error = await rejection;
        expect(error).toMatchObject({message: 'cancel native command'});
        expect(getUnprovenNativeTerminationDetail(error)).toContain('was not proven dead');
        expect(mainJobBroker.getSnapshot()).toMatchObject({
            active: 1,
            used: {nativeProcesses: 1},
        });
    });

    it('runs under the lease of the broker run whose proof sink it receives', async () => {
        const proc = new MockNativeProcess();
        mocks.spawn.mockReturnValue(proc);
        const {
            mainJobBroker,
            runNativeCommand,
        } = await loadConfigured();
        // A single-slot broker: the outer lease takes everything.
        const capacity = {
            cpuTokens: 1,
            estimatedResidentBytes: GIB,
            nativeProcesses: 1,
            ioWeight: 1,
        };
        mainJobBroker.reconfigureCapacity(capacity);

        const result = mainJobBroker.run({
            ownerId: 'outer',
            kind: 'outer-job',
            priority: 'user',
            resources: capacity,
        }, async ({onTerminationProof}) => {
            const command = runNativeCommand('/bin/tool', [], {onTerminationProof});
            await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
            expect(mainJobBroker.getSnapshot()).toMatchObject({
                active: 1,
                queued: 0,
            });
            proc.emit('close', 0, null);
            return command;
        });

        await expect(result).resolves.toMatchObject({exitCode: 0});
        expect(mainJobBroker.getSnapshot()).toMatchObject({
            active: 0,
            queued: 0,
        });
    });

    it('runs a command inside an undeclared lease that fills a single-slot broker', async () => {
        const inner = new MockNativeProcess();
        const later = new MockNativeProcess(42_425);
        mocks.spawn.mockReturnValueOnce(inner).mockReturnValueOnce(later);
        const {
            mainJobBroker,
            runNativeCommand,
        } = await loadConfigured();
        const capacity = {
            cpuTokens: 1,
            estimatedResidentBytes: GIB,
            nativeProcesses: 1,
            ioWeight: 1,
        };
        mainJobBroker.reconfigureCapacity(capacity);
        const outer = await mainJobBroker.acquire({
            ownerId: 'outer',
            kind: 'outer-job',
            priority: 'user',
            resources: capacity,
        });

        // The caller never says it holds the lease; the command still starts.
        const nested = runNativeCommand('/bin/tool', []);
        await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
        // A second command waits for the first to finish rather than overrunning further.
        const queued = runNativeCommand('/bin/tool', []);
        await vi.waitFor(() => expect(mainJobBroker.getSnapshot().queued).toBe(1));

        inner.emit('close', 0, null);
        await expect(nested).resolves.toMatchObject({exitCode: 0});
        await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledTimes(2));
        later.emit('close', 0, null);
        await expect(queued).resolves.toMatchObject({exitCode: 0});
        outer.release();
        expect(mainJobBroker.getSnapshot()).toMatchObject({
            active: 0,
            queued: 0,
        });
    });

    it('runs under the caller lease through a sink chained from its run', async () => {
        const proc = new MockNativeProcess();
        mocks.spawn.mockReturnValue(proc);
        const {
            chainTerminationProofSink,
            mainJobBroker,
            runNativeCommand,
        } = await loadConfigured();
        const capacity = {
            cpuTokens: 1,
            estimatedResidentBytes: GIB,
            nativeProcesses: 1,
            ioWeight: 1,
        };
        mainJobBroker.reconfigureCapacity(capacity);
        const local: Array<Promise<boolean>> = [];

        const result = mainJobBroker.run({
            ownerId: 'outer',
            kind: 'outer-job',
            priority: 'user',
            resources: capacity,
        }, async ({onTerminationProof}) => {
            // A caller that keeps its own record of the proof still names the lease.
            const command = runNativeCommand('/bin/tool', [], {
                onTerminationProof: chainTerminationProofSink(onTerminationProof, proof => local.push(proof)),
            });
            await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
            expect(mainJobBroker.getSnapshot()).toMatchObject({
                active: 1,
                used: capacity,
            });
            proc.emit('close', 0, null);
            return command;
        });

        await expect(result).resolves.toMatchObject({exitCode: 0});
        expect(mainJobBroker.getSnapshot().active).toBe(0);
    });

    it('lets scan-cleanup sidecar and Poppler batch stage concurrently under one broker run when bulk capacity is full', async () => {
        const sidecarProc = new MockNativeProcess();
        const batchProc = new MockNativeProcess();
        const spawnedArgs: string[][] = [];
        const scratch = await mkdtemp(join(tmpdir(), 'scan-cleanup-broker-concurrent-'));
        const manifestPath = join(scratch, 'classify-manifest.json');
        const pageOutputPath = join(scratch, 'page-2.ppm');
        const ppmBytes = Buffer.concat([
            Buffer.from('P6\n1 1\n255\n', 'ascii'),
            Buffer.from([
                255,
                255,
                255,
            ]),
        ]);
        const batchWritten = Promise.withResolvers<void>();
        const releaseBatch = Promise.withResolvers<void>();
        mocks.spawn.mockImplementation((_command: string, args: string[]) => {
            spawnedArgs.push(args);
            if (args.includes('--manifest')) {
                return sidecarProc;
            }
            const prefix = args.at(-1)!;
            void writeFile(`${prefix}-2.ppm`, ppmBytes).then(async () => {
                batchWritten.resolve();
                await releaseBatch.promise;
                batchProc.emit('close', 0, null);
            });
            return batchProc;
        });
        const {
            mainJobBroker,
            runNativeCommand,
        } = await loadConfigured();
        const {runScanCleanupSidecar} = await import('@electron/features/scan-cleanup/worker/runScanCleanupSidecar');
        const {createScanCleanupRasterBatchRenderer} = await import('@electron/features/scan-cleanup/createScanCleanupRasterBatchRenderer');
        const {
            mkdtemp: fsMkdtemp,
            open: fsOpen,
            readdir: fsReaddir,
            rename: fsRename,
            rm: fsRm,
        } = await import('node:fs/promises');
        const capacity = {
            cpuTokens: 2,
            estimatedResidentBytes: 2 * GIB,
            nativeProcesses: 2,
            ioWeight: 4,
        };
        mainJobBroker.reconfigureCapacity(capacity);
        // Saturate the remaining bulk slot just like a concurrent scan-cleanup preview does.
        const previewLease = await mainJobBroker.acquire({
            ownerId: 'scan-cleanup:1:owner',
            kind: 'scan-cleanup-preview',
            priority: 'visible',
            resources: {
                cpuTokens: 1,
                estimatedResidentBytes: 512 * 1024 * 1024,
                nativeProcesses: 1,
                ioWeight: 1,
            },
        });
        try {
            const renderBatch = createScanCleanupRasterBatchRenderer(runNativeCommand, {
                mkdtemp: fsMkdtemp,
                open: fsOpen,
                readdir: (dirPath, options) => fsReaddir(dirPath, options),
                rename: fsRename,
                rm: fsRm,
            });
            await mainJobBroker.run({
                ownerId: 'scan-cleanup:1:owner',
                kind: 'scan-cleanup-detect-all',
                priority: 'user',
                resources: {
                    cpuTokens: 1,
                    estimatedResidentBytes: 512 * 1024 * 1024,
                    nativeProcesses: 1,
                    ioWeight: 2,
                },
            }, async ({onTerminationProof}) => {
                const controller = new AbortController();
                const sidecarPromise = runScanCleanupSidecar(
                    '/bin/evb-scan-cleanup',
                    manifestPath,
                    controller.signal,
                    () => undefined,
                    () => undefined,
                    {
                        allowedPathRoot: scratch,
                        onTerminationProof,
                    },
                );
                await vi.waitFor(() => expect(spawnedArgs).toHaveLength(1));
                // While the sidecar is still running, staging page 2 must be admitted under the
                // same detection lease rather than blocking on the broker's single leaf slot.
                const stagedPromise = renderBatch({
                    dpi: 150,
                    log: () => undefined,
                    pdftoppmBinary: '/bin/pdftoppm',
                    signal: controller.signal,
                    sourcePdfPath: join(scratch, 'source.pdf'),
                    targets: [{
                        limits: {
                            expectedWidthPx: 1,
                            expectedHeightPx: 1,
                            maxDimensionPx: 100,
                            maxPixels: 10_000,
                        },
                        outputPath: pageOutputPath,
                        pageNumber: 2,
                    }],
                    onTerminationProof,
                });
                await batchWritten.promise;
                expect(spawnedArgs).toHaveLength(2);
                // Both sidecarProc and batchProc are simultaneously active under the same
                // detection lease; no extra transient leaf lease was allocated.
                expect(mainJobBroker.getSnapshot()).toMatchObject({
                    active: 2,
                    queued: 0,
                });
                releaseBatch.resolve();
                const staged = await stagedPromise;
                expect(staged).toEqual([{
                    pageNumber: 2,
                    width: 1,
                    height: 1,
                }]);
                expect(mainJobBroker.getSnapshot()).toMatchObject({
                    active: 2,
                    queued: 0,
                });
                sidecarProc.stdout.emit('data', Buffer.from(
                    '{"version":3,"type":"result","result":{"status":"success","completedPages":2,"totalPages":2}}\n',
                ));
                sidecarProc.emit('close', 0, null);
                await sidecarPromise;
            });
        } finally {
            previewLease.release();
            await rm(scratch, {
                recursive: true,
                force: true,
            });
        }
        expect(mainJobBroker.getSnapshot()).toMatchObject({
            active: 0,
            queued: 0,
        });
    });

    it('keeps its own lease charged until a late termination proof arrives', async () => {
        vi.useFakeTimers();
        const proc = new MockNativeProcess();
        mocks.spawn.mockReturnValue(proc);
        const termination = Promise.withResolvers<boolean>();
        mocks.terminateDetachedChildProcess.mockReturnValueOnce(termination.promise);
        const {
            mainJobBroker,
            runNativeCommand,
        } = await loadConfigured();
        const {getUnprovenNativeTerminationDetail} = await import('@electron/utils/nativeTerminationProof');
        const proofs: Array<Promise<boolean>> = [];
        const controller = new AbortController();

        const rejection = runNativeCommand('/bin/tool', [], {
            signal: controller.signal,
            onTerminationProof: proof => proofs.push(proof),
        }).catch((error: unknown) => error);
        await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
        controller.abort();
        await vi.advanceTimersByTimeAsync(3_000);

        expect(getUnprovenNativeTerminationDetail(await rejection)).toBeDefined();
        expect(proofs).toHaveLength(1);
        expect(mainJobBroker.getSnapshot()).toMatchObject({
            active: 1,
            used: {nativeProcesses: 1},
        });

        termination.resolve(true);
        await vi.waitFor(() => expect(mainJobBroker.getSnapshot()).toMatchObject({
            active: 0,
            used: {nativeProcesses: 0},
        }));
    });

    it.each([
        {
            name: 'the granted cores',
            lease: {
                cpuTokens: 6,
                estimatedResidentBytes: 8 * GIB,
            },
            env: undefined,
            expected: '6',
        },
        {
            name: 'one prepared image per thread of the granted memory',
            lease: {
                cpuTokens: 6,
                estimatedResidentBytes: GIB,
            },
            env: undefined,
            expected: '2',
        },
        {
            name: 'a thread count the caller set',
            lease: {
                cpuTokens: 6,
                estimatedResidentBytes: 8 * GIB,
            },
            env: {EVB_PDF_COMBINE_THREADS: '3'},
            expected: '3',
        },
    ])('starts the image combiner under a caller lease with $name', async ({
        lease,
        env,
        expected,
    }) => {
        const proc = new MockNativeProcess();
        mocks.spawn.mockReturnValue(proc);
        const {
            JobBroker,
            runNativeCommand,
        } = await loadConfigured();
        const resources = {
            ...lease,
            nativeProcesses: 1,
            ioWeight: 1,
        };

        await new JobBroker(resources).run({
            ownerId: 'combine',
            kind: 'combine',
            priority: 'user',
            resources,
        }, async ({onTerminationProof}) => {
            const result = runNativeCommand('/native/evb-pdf-image-combine', ['--output', '/out.pdf'], {
                onTerminationProof,
                ...(env === undefined ? {} : {env}),
            });
            await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
            expect(spawnEnv().EVB_PDF_COMBINE_THREADS).toBe(expected);
            proc.emit('close', 0, null);
            return result;
        });
    });

    it.each([
        {
            name: 'its 512 MiB first thread',
            capacityBytes: 60 * GIB,
            charged: 512 * 1024 * 1024,
        },
        {
            name: 'the whole budget of a smaller broker',
            capacityBytes: 256 * 1024 * 1024,
            charged: 256 * 1024 * 1024,
        },
    ])('charges a standalone image combiner $name and starts it with one thread', async ({
        capacityBytes,
        charged,
    }) => {
        const combine = new MockNativeProcess();
        mocks.spawn.mockReturnValueOnce(combine);
        const {
            mainJobBroker,
            runNativeCommand,
        } = await loadConfigured();
        mainJobBroker.reconfigureCapacity({
            cpuTokens: 8,
            estimatedResidentBytes: capacityBytes,
            nativeProcesses: 4,
            ioWeight: 4,
        });

        const combined = runNativeCommand('/native/evb-pdf-image-combine.exe', []);
        await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
        expect(mainJobBroker.getSnapshot().used).toEqual({
            cpuTokens: 1,
            estimatedResidentBytes: charged,
            nativeProcesses: 1,
            ioWeight: 1,
        });
        expect(spawnEnv(0).EVB_PDF_COMBINE_THREADS).toBe('1');
        combine.emit('close', 0, null);
        await combined;
        expect(mainJobBroker.getSnapshot().active).toBe(0);
    });

    it('leaves the combiner thread count of other tools alone', async () => {
        const other = new MockNativeProcess(42_425);
        mocks.spawn.mockReturnValueOnce(other);
        const {
            JobBroker,
            runNativeCommand,
        } = await loadConfigured();
        const resources = {
            cpuTokens: 6,
            estimatedResidentBytes: 8 * GIB,
            nativeProcesses: 1,
            ioWeight: 1,
        };

        await new JobBroker(resources).run({
            ownerId: 'qpdf',
            kind: 'qpdf',
            priority: 'user',
            resources,
        }, async ({onTerminationProof}) => {
            const qpdf = runNativeCommand('/native/qpdf', [], {onTerminationProof});
            await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
            expect(spawnEnv(0).EVB_PDF_COMBINE_THREADS).toBeUndefined();
            other.emit('close', 0, null);
            return qpdf;
        });
    });

    it('never retains JobBroker leases when onStdout aborts a fast-exiting supervised POSIX child', async () => {
        if (process.platform === 'win32') {
            return;
        }
        const {resolveNativeProcessSupervisorPath} = await import('@electron/native-tools/resolveNativeToolsBase');
        if (!resolveNativeProcessSupervisorPath(import.meta.dirname)) {
            return;
        }

        vi.doUnmock('child_process');
        vi.doUnmock('@electron/utils/nativeChildProcess');
        onTestFinished(() => {
            vi.doMock('child_process', () => ({spawn: mocks.spawn}));
            vi.doMock('@electron/utils/nativeChildProcess', () => ({
                spawnNativeChildProcess: mocks.spawn,
                getNativeChildProcessTerminationProof: mocks.jobProof,
                getNativeChildProcessPid: (proc: {pid?: number}) => Promise.resolve(proc.pid ?? null),
                terminateDetachedChildProcess: mocks.terminateDetachedChildProcess,
            }));
        });
        vi.resetModules();

        const {
            JobBroker,
            runNativeCommand,
        } = await loadConfigured();
        const {getUnprovenNativeTerminationDetail} = await import('@electron/utils/nativeTerminationProof');
        const broker = new JobBroker({
            cpuTokens: 2,
            estimatedResidentBytes: 4 * GIB,
            nativeProcesses: 2,
            ioWeight: 2,
        });

        for (let iteration = 0; iteration < 25; iteration += 1) {
            const controller = new AbortController();
            const outcome = await broker.run({
                ownerId: `fast-abort-${iteration}`,
                kind: 'search',
                priority: 'user',
                resources: {
                    cpuTokens: 1,
                    estimatedResidentBytes: 128 * 1024 * 1024,
                    nativeProcesses: 1,
                    ioWeight: 1,
                },
            }, async ({onTerminationProof}) => {
                try {
                    await runNativeCommand(process.execPath, [
                        '-e',
                        'process.stdout.write("hit\\n"); process.exit(0);',
                    ], {
                        signal: controller.signal,
                        onTerminationProof,
                        onStdout: () => {
                            controller.abort();
                        },
                    });
                    return null;
                } catch (error) {
                    return error;
                }
            });

            if (outcome !== null) {
                expect(
                    getUnprovenNativeTerminationDetail(outcome),
                    `iteration ${iteration} reported unprovenNativeTermination`,
                ).toBeUndefined();
            }
            expect(
                broker.getSnapshot().active,
                `iteration ${iteration} retained a JobBroker lease`,
            ).toBe(0);
        }
        expect(mocks.telemetryWarn).not.toHaveBeenCalledWith(
            expect.stringContaining('unprovenNativeTermination'),
            expect.anything(),
        );
    });
});
