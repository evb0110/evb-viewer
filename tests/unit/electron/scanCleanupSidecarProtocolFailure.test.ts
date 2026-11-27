import {
    EventEmitter, on,
} from 'node:events';
import {
    mkdtemp, readFile, rm, writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PassThrough} from 'node:stream';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
    createInterface: vi.fn(),
    spawn: vi.fn(),
    terminateDetachedChildProcess: vi.fn(async () => {}),
}));

vi.mock('child_process', () => ({spawn: mocks.spawn}));
vi.mock('readline', () => ({createInterface: mocks.createInterface}));
vi.mock('@electron/utils/nativeChildProcess', () => ({
    spawnNativeChildProcess: mocks.spawn,
    getNativeChildProcessPid: (proc: {pid?: number}) => Promise.resolve(proc.pid ?? null),
    getNativeChildProcessTerminationProof: () => undefined,
    createDetachedChildProcessSpawnOptions: (options: unknown) => options,
    terminateDetachedChildProcess: mocks.terminateDetachedChildProcess,
}));
class MockSidecarProcess extends EventEmitter {
    readonly pid = process.pid;

    readonly stdout = new PassThrough();

    readonly stderr = new PassThrough();
}

class MockLineReader extends EventEmitter {
    readonly close = vi.fn(() => this.emit('close'));

    async *[Symbol.asyncIterator]() {
        for await (const [line] of on(this, 'line', {close: ['close']})) {yield String(line);}
    }
}

function progressLine() {
    return JSON.stringify({
        version: 3,
        type: 'progress',
        progress: {
            stage: 'page-complete',
            completedPages: 1,
            totalPages: 1,
            pageNumber: 1,
            classification: 'single-uncut-page',
            confidence: 0.9,
        },
    });
}

describe('scan cleanup sidecar protocol failures', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        mocks.terminateDetachedChildProcess.mockResolvedValue(undefined);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('settles malformed NDJSON after bounded termination without close and prefers the protocol error', async () => {
        vi.useFakeTimers();
        mocks.terminateDetachedChildProcess.mockImplementation(() => new Promise(() => {}));
        const child = new MockSidecarProcess();
        const lines = new MockLineReader();
        mocks.spawn.mockReturnValue(child);
        mocks.createInterface.mockReturnValue(lines);
        const {runScanCleanupSidecar} = await import(
            '@electron/features/scan-cleanup/worker/runScanCleanupSidecar'
        );
        const controller = new AbortController();
        const run = runScanCleanupSidecar(
            '/native/evb-scan-cleanup',
            '/scratch/manifest.json',
            controller.signal,
            vi.fn(),
            () => {},
        );
        const rejection = run.catch(error => error);
        await vi.advanceTimersByTimeAsync(0);
        lines.emit('line', '{');
        controller.abort(new DOMException('Canceled scan cleanup detection', 'AbortError'));

        await vi.advanceTimersByTimeAsync(3_000);
        await expect(rejection).resolves.toMatchObject({name: 'SyntaxError'});
        expect(mocks.terminateDetachedChildProcess).toHaveBeenCalledTimes(1);
    });

    it.each([
        [
            'malformed NDJSON',
            '{',
            undefined,
        ],
        [
            'schema-invalid NDJSON',
            JSON.stringify({
                version: 3,
                type: 'progress',
                progress: {},
            }),
            undefined,
        ],
        [
            'progress callback failure',
            progressLine(),
            new Error('Progress consumer failed'),
        ],
    ] as const)('closes stdout and terminates immediately on %s', async (
        _label,
        line,
        progressError,
    ) => {
        const child = new MockSidecarProcess();
        const lines = new MockLineReader();
        mocks.spawn.mockReturnValue(child);
        mocks.createInterface.mockReturnValue(lines);
        const {runScanCleanupSidecar} = await import(
            '@electron/features/scan-cleanup/worker/runScanCleanupSidecar'
        );
        const run = runScanCleanupSidecar(
            '/native/evb-scan-cleanup',
            '/scratch/manifest.json',
            new AbortController().signal,
            vi.fn(),
            () => {
                if (progressError !== undefined) {throw progressError;}
            },
        );
        const rejection = run.catch(error => error);

        await vi.waitFor(() => expect(mocks.createInterface).toHaveBeenCalledOnce());
        lines.emit('line', line);
        await vi.waitFor(() => {
            expect(lines.close).toHaveBeenCalled();
        });
        child.emit('close', null, 'SIGTERM');

        if (progressError === undefined) {
            await expect(rejection).resolves.toBeInstanceOf(Error);
        } else {
            await expect(rejection).resolves.toBe(progressError);
        }
    });

    it('rejects an NDJSON line that exceeds the byte limit before readline buffers it', async () => {
        const child = new MockSidecarProcess();
        const lines = new MockLineReader();
        const onProtocolError = vi.fn();
        mocks.createInterface.mockReturnValue(lines);
        const {createScanCleanupSidecarProtocolHandler} = await import(
            '@evb/scan-cleanup/core/createScanCleanupSidecarProtocolHandler'
        );
        createScanCleanupSidecarProtocolHandler({
            stdout: child.stdout,
            stderr: child.stderr,
            onProtocolError,
            log: vi.fn(),
        });

        child.stdout.end(Buffer.alloc(4 * 1024 * 1024 + 1, 0x61));
        await vi.waitFor(() => expect(onProtocolError).toHaveBeenCalledOnce());
        const error = onProtocolError.mock.calls[0]?.[0];
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain('exceeds 4194304 bytes');
        expect(lines.close).toHaveBeenCalledOnce();
    });

    it('keeps stderr bounded by UTF-8 bytes without splitting the retained buffer operation', async () => {
        const child = new MockSidecarProcess();
        const lines = new MockLineReader();
        mocks.createInterface.mockReturnValue(lines);
        const {createScanCleanupSidecarProtocolHandler} = await import(
            '@evb/scan-cleanup/core/createScanCleanupSidecarProtocolHandler'
        );
        const protocol = createScanCleanupSidecarProtocolHandler({
            stdout: child.stdout,
            stderr: child.stderr,
            onProtocolError: vi.fn(),
            log: vi.fn(),
        });

        child.stderr.end(Buffer.from('ошибка'.repeat(20_000), 'utf8'));
        await vi.waitFor(() => expect(Buffer.byteLength(protocol.stderr, 'utf8')).toBeLessThanOrEqual(64 * 1024));
        expect(protocol.stderr).not.toMatch(/^�/u);
    });

    it('rejects when options.onResult fails after the sidecar exits cleanly with code 0', async () => {
        const child = new MockSidecarProcess();
        const lines = new MockLineReader();
        mocks.spawn.mockReturnValue(child);
        mocks.createInterface.mockReturnValue(lines);
        const {runScanCleanupSidecar} = await import(
            '@electron/features/scan-cleanup/worker/runScanCleanupSidecar'
        );
        const onResultError = new Error('Late onResult failure after clean exit');
        const releaseOnResult = Promise.withResolvers<void>();
        let onResultEntered = false;
        const run = runScanCleanupSidecar(
            '/native/evb-scan-cleanup',
            '/scratch/manifest.json',
            new AbortController().signal,
            vi.fn(),
            () => {},
            {
                onResult: async () => {
                    onResultEntered = true;
                    await releaseOnResult.promise;
                    throw onResultError;
                },
            },
        );
        const rejection = run.catch(error => error);

        await vi.waitFor(() => expect(mocks.createInterface).toHaveBeenCalledOnce());
        lines.emit('line', JSON.stringify({
            version: 3,
            type: 'result',
            result: {
                status: 'success',
                completedPages: 1,
                totalPages: 1,
            },
        }));
        await vi.waitFor(() => expect(onResultEntered).toBe(true));

        // Sidecar closes with exit code 0 before onResult settles so runNativeToolCommand resolves cleanly.
        child.emit('close', 0, null);
        await Promise.resolve();
        await Promise.resolve();
        releaseOnResult.resolve();

        await expect(rejection).resolves.toBe(onResultError);
    });

    it('rejects when the sidecar exits cleanly with code 0 without emitting a terminal result envelope', async () => {
        const child = new MockSidecarProcess();
        const lines = new MockLineReader();
        mocks.spawn.mockReturnValue(child);
        mocks.createInterface.mockReturnValue(lines);
        const {runScanCleanupSidecar} = await import(
            '@electron/features/scan-cleanup/worker/runScanCleanupSidecar'
        );
        const run = runScanCleanupSidecar(
            '/native/evb-scan-cleanup',
            '/scratch/manifest.json',
            new AbortController().signal,
            vi.fn(),
            () => {},
        );

        await vi.waitFor(() => expect(mocks.createInterface).toHaveBeenCalledOnce());
        lines.emit('line', progressLine());
        child.emit('close', 0, null);
        lines.close();

        await expect(run).rejects.toMatchObject({
            name: 'NativeScanCleanupError',
            code: 'native-failure',
            message: 'evb-scan-cleanup returned no terminal result envelope',
        });
    });

    it('prefers caller abort over wall-clock timeout and marks unproven timeout terminations', async () => {
        vi.useFakeTimers();
        mocks.terminateDetachedChildProcess.mockImplementation(() => new Promise(() => {}));
        const {runScanCleanupSidecar} = await import(
            '@electron/features/scan-cleanup/worker/runScanCleanupSidecar'
        );
        const {getUnprovenNativeTerminationDetail} = await import('@electron/utils/nativeTerminationProof');

        // 1. Caller abort wins over wall-clock timeout when both race before settlement.
        const abortChild = new MockSidecarProcess();
        mocks.spawn.mockReturnValueOnce(abortChild);
        mocks.createInterface.mockReturnValueOnce(new MockLineReader());
        const controller = new AbortController();
        const abortError = new DOMException('Caller aborted during timeout', 'AbortError');
        const abortLog = vi.fn();
        const abortRun = runScanCleanupSidecar(
            '/native/evb-scan-cleanup',
            '/scratch/abort-vs-timeout.json',
            controller.signal,
            abortLog,
            () => {},
            {timeoutMs: 10},
        ).catch(error => error);
        await vi.advanceTimersByTimeAsync(10);
        controller.abort(abortError);
        await vi.advanceTimersByTimeAsync(3_000);
        const abortResult = await abortRun;
        expect(abortResult).toBe(abortError);
        expect(getUnprovenNativeTerminationDetail(abortResult)).toContain('was not proven dead');
        expect(abortLog).toHaveBeenCalledWith('warn', expect.stringContaining('was not proven dead'));

        // 2. Pure timeout with unproven termination warns, marks the timeout error,
        // and defers publication journal replay until the child closes later.
        const timeoutChild = new MockSidecarProcess();
        mocks.spawn.mockReturnValueOnce(timeoutChild);
        mocks.createInterface.mockReturnValueOnce(new MockLineReader());
        const timeoutLog = vi.fn();
        const directory = await mkdtemp(join(tmpdir(), 'evb-scan-cleanup-timeout-recovery-'));
        const manifestPath = join(directory, 'manifest.json');
        const original = join(directory, 'page.png');
        const backup = join(directory, 'page.png.evb-tmp-recovery');
        const journalPath = `${manifestPath}.evb-publication-journal.json`;
        let deferredRecovery: Promise<boolean> | undefined;
        try {
            await writeFile(backup, 'previous destination');
            await writeFile(journalPath, JSON.stringify({
                version: 1,
                manifestPath,
                entries: [{original, backup}],
            }));
            const timeoutRun = runScanCleanupSidecar(
                '/native/evb-scan-cleanup',
                manifestPath,
                new AbortController().signal,
                timeoutLog,
                () => {},
                {
                    timeoutMs: 10,
                    onRecoveryPending: recovery => { deferredRecovery = recovery; },
                },
            ).catch(error => error);
            await vi.advanceTimersByTimeAsync(3_010);
            const timeoutResult = await timeoutRun;
            expect(timeoutResult).toMatchObject({
                name: 'NativeScanCleanupError',
                code: 'native-failure',
                message: 'evb-scan-cleanup timed out after 10ms',
            });
            expect(getUnprovenNativeTerminationDetail(timeoutResult)).toContain('was not proven dead');
            expect(timeoutLog).toHaveBeenCalledWith('warn', expect.stringContaining('was not proven dead'));
            expect(deferredRecovery).toBeDefined();
            await expect(readFile(original, 'utf8')).rejects.toMatchObject({code: 'ENOENT'});

            timeoutChild.emit('close', null, 'SIGKILL');
            await expect(deferredRecovery!).resolves.toBe(true);
            await expect(readFile(original, 'utf8')).resolves.toBe('previous destination');
            await expect(readFile(journalPath)).rejects.toMatchObject({code: 'ENOENT'});
        } finally {
            await rm(directory, {recursive: true, force: true});
        }

        // 3. A synchronous onRecoveryPending throw must not mask the unproven timeout error.
        const syncThrowChild = new MockSidecarProcess();
        mocks.spawn.mockReturnValueOnce(syncThrowChild);
        mocks.createInterface.mockReturnValueOnce(new MockLineReader());
        const syncThrowLog = vi.fn();
        const syncThrowRun = runScanCleanupSidecar(
            '/native/evb-scan-cleanup',
            '/scratch/sync-throw-timeout.json',
            new AbortController().signal,
            syncThrowLog,
            () => {},
            {
                timeoutMs: 10,
                onRecoveryPending: () => {
                    throw new Error('Sync recovery owner failure');
                },
            },
        ).catch(error => error);
        await vi.advanceTimersByTimeAsync(3_010);
        const syncThrowResult = await syncThrowRun;
        expect(syncThrowResult).toMatchObject({
            name: 'NativeScanCleanupError',
            code: 'native-failure',
            message: 'evb-scan-cleanup timed out after 10ms',
        });
        expect(getUnprovenNativeTerminationDetail(syncThrowResult)).toContain('was not proven dead');
        expect(syncThrowLog).toHaveBeenCalledWith(
            'warn',
            expect.stringContaining('Deferred scan-cleanup recovery owner failed: Error: Sync recovery owner failure'),
        );

        // 4. A timeout before the manifest sidecar spawns does not register forever-pending recovery.
        mocks.spawn.mockImplementationOnce(() => {
            throw new Error('pre-spawn timed out');
        });
        mocks.createInterface.mockReturnValueOnce(new MockLineReader());
        const preSpawnRecovery = vi.fn();
        const preSpawnResult = await runScanCleanupSidecar(
            '/native/evb-scan-cleanup',
            '/scratch/pre-spawn-timeout.json',
            new AbortController().signal,
            vi.fn(),
            () => {},
            {
                timeoutMs: 10,
                onRecoveryPending: preSpawnRecovery,
            },
        ).catch(error => error);
        expect(preSpawnResult).toMatchObject({
            name: 'NativeScanCleanupError',
            code: 'native-failure',
            message: 'evb-scan-cleanup timed out after 10ms',
        });
        expect(getUnprovenNativeTerminationDetail(preSpawnResult)).toBeUndefined();
        expect(preSpawnRecovery).not.toHaveBeenCalled();
    });
});
