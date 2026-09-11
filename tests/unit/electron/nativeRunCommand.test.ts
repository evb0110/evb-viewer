import { EventEmitter } from 'node:events';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
    spawn: vi.fn(),
    terminateDetachedChildProcess: vi.fn(async (_proc: unknown, _graceMs: number): Promise<boolean> => false),
}));

class MockNativeProcess extends EventEmitter {
    readonly pid = 42_424;

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
    createDetachedChildProcessSpawnOptions: (options: unknown) => options,
    terminateDetachedChildProcess: mocks.terminateDetachedChildProcess,
}));

describe('runNativeCommand', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        vi.useRealTimers();
        vi.unstubAllEnvs();
    });

    // Several cases below install fake timers and the last one to run would
    // otherwise leave them installed past this file. Restoring here bounds that
    // to the test that asked for them.
    afterEach(() => {
        vi.useRealTimers();
    });

    it('applies a bounded default timeout when a caller omits one', async () => {
        vi.useFakeTimers();
        vi.stubEnv('EVB_NATIVE_COMMAND_TIMEOUT_MS', '1000');
        const proc = new MockNativeProcess();
        mocks.spawn.mockReturnValue(proc);
        const { runNativeCommand } = await import('@electron/native-tools/runNativeCommand');

        const resultPromise = runNativeCommand('/bin/tool', []);
        const rejection = resultPromise.catch((error: unknown) => error);
        await vi.advanceTimersByTimeAsync(1_000);

        await expect(rejection).resolves.toMatchObject({message: '/bin/tool timed out after 1000ms'});
        expect(mocks.terminateDetachedChildProcess).toHaveBeenCalledWith(proc, 1_000);
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

    it('reports the spawned process before it can finish', async () => {
        const proc = new MockNativeProcess();
        const onSpawn = vi.fn();
        mocks.spawn.mockReturnValue(proc);
        const {runNativeCommand} = await import('@electron/native-tools/runNativeCommand');

        const resultPromise = runNativeCommand('/bin/tool', [], {onSpawn});

        expect(onSpawn).toHaveBeenCalledOnce();
        expect(onSpawn).toHaveBeenCalledWith(proc.pid);
        proc.emit('close', 0, null);
        await expect(resultPromise).resolves.toMatchObject({exitCode: 0});
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
        expect(log).toHaveBeenCalledWith('error', expect.stringContaining('cmd=/bin/tool --bad'));
    });

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

    it('rejects stdout truncation when requested even for successful exits', async () => {
        const proc = new MockNativeProcess();
        mocks.spawn.mockReturnValue(proc);
        const { runNativeCommand } = await import('@electron/native-tools/runNativeCommand');

        const resultPromise = runNativeCommand('/bin/tool', [], {
            commandLabel: 'fixture-tool',
            maxStdoutBytes: 3,
            rejectOnStdoutTruncation: true,
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
        const { runNativeCommand } = await import('@electron/native-tools/runNativeCommand');
        const { getUnprovenNativeTerminationDetail } = await import('@electron/utils/nativeTerminationProof');

        const rejection = runNativeCommand('/bin/tool', [], {
            log,
            timeoutMs: 10,
        }).catch((error: unknown) => error);
        await vi.advanceTimersByTimeAsync(10);

        const error = await rejection;
        expect((error as Error).message).toBe('/bin/tool timed out after 10ms');
        expect(getUnprovenNativeTerminationDetail(error)).toBeUndefined();
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

    it('marks a rejection whose child closed before any termination result existed', async () => {
        // The close handler falls back to a resolved value when the termination
        // request has not recorded one yet. That fallback is an absence of
        // evidence, so it has to read as "not proven dead": a fallback that said
        // `true` would hand the working-copy owner permission to delete bytes on
        // the strength of nothing at all. Emitting 'close' from inside the
        // termination call is what reaches the fallback, because it runs before
        // the promise is assigned.
        const proc = new MockNativeProcess();
        mocks.spawn.mockReturnValue(proc);
        mocks.terminateDetachedChildProcess.mockImplementation(async () => {
            proc.emit('close', null, 'SIGTERM');
            return true;
        });
        const controller = new AbortController();
        const { runNativeCommand } = await import('@electron/native-tools/runNativeCommand');
        const { getUnprovenNativeTerminationDetail } = await import('@electron/utils/nativeTerminationProof');

        const rejection = runNativeCommand('/bin/tool', [], {signal: controller.signal})
            .catch((error: unknown) => error);
        controller.abort();

        const error = await rejection;
        expect(getUnprovenNativeTerminationDetail(error)).toContain('was not proven dead');
    });

    it('streams output chunks and cancels named command groups', async () => {
        const proc = new MockNativeProcess();
        const onStdout = vi.fn();
        const onStderr = vi.fn();
        mocks.spawn.mockReturnValue(proc);
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
});
