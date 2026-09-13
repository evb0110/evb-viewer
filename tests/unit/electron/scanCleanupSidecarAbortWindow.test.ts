import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { TWorkerLog } from '@electron/features/ocr/worker/types';

const mocks = vi.hoisted(() => ({
    spawn: vi.fn(),
    terminateDetachedChildProcess: vi.fn(async (_proc: unknown, _graceMs: number): Promise<boolean> => false),
    verifyNativeToolProtocol: vi.fn(async () => {}),
}));

vi.mock('child_process', () => ({spawn: mocks.spawn}));
vi.mock('@electron/utils/nativeChildProcess', () => ({
    createDetachedChildProcessSpawnOptions: (options: unknown) => options,
    terminateDetachedChildProcess: mocks.terminateDetachedChildProcess,
}));
vi.mock('@electron/native-tools/runNativeToolCommand', () => ({verifyNativeToolProtocol: mocks.verifyNativeToolProtocol}));

class MockSidecarProcess extends EventEmitter {
    readonly stdout = new PassThrough();

    readonly stderr = new PassThrough();

    readonly kill = vi.fn();
}

describe('scan cleanup sidecar abort window', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        mocks.terminateDetachedChildProcess.mockResolvedValue(true);
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllEnvs();
    });

    it('settles an aborted run after bounded termination when the child never closes', async () => {
        vi.useFakeTimers();
        mocks.terminateDetachedChildProcess.mockImplementation(() => new Promise(() => {}));
        const { runScanCleanupSidecar } = await import('@electron/features/scan-cleanup/worker/runScanCleanupSidecar');
        const child = new MockSidecarProcess();
        mocks.spawn.mockReturnValue(child);
        const controller = new AbortController();
        const abortError = new DOMException('Canceled scan cleanup detection', 'AbortError');

        const run = runScanCleanupSidecar(
            '/native/evb-scan-cleanup',
            '/scratch/canceled-manifest.json',
            controller.signal,
            vi.fn<TWorkerLog>(),
            () => {},
        );
        await vi.advanceTimersByTimeAsync(0);
        controller.abort(abortError);
        const rejected = expect(run).rejects.toBe(abortError);

        await vi.advanceTimersByTimeAsync(3_500);
        await rejected;
        expect(mocks.terminateDetachedChildProcess).toHaveBeenCalledWith(child, 1_500);
    });

    // Native command admission resolves its waiters synchronously, so a run
    // that is canceled in the same tick as the release that admitted it reaches
    // the spawn with an already-aborted signal. The listener the sidecar
    // attaches after the spawn never replays that abort, so the terminate has
    // to be re-checked once the process exists.
    it('terminates a sidecar whose run was canceled while it waited for a native command slot', async () => {
        vi.stubEnv('EVB_NATIVE_COMMAND_MAX_CONCURRENCY', '1');
        vi.resetModules();
        const { acquireNativeCommandAdmission } = await import('@electron/native-tools/runNativeCommand');
        const { runScanCleanupSidecar } = await import('@electron/features/scan-cleanup/worker/runScanCleanupSidecar');
        const child = new MockSidecarProcess();
        mocks.spawn.mockReturnValue(child);
        const releaseOccupant = await acquireNativeCommandAdmission();
        const controller = new AbortController();

        const run = runScanCleanupSidecar(
            '/native/evb-scan-cleanup',
            '/scratch/canceled-manifest.json',
            controller.signal,
            vi.fn<TWorkerLog>(),
            () => {},
        );
        const rejected = expect(run).rejects.toMatchObject({name: 'AbortError'});
        for (let attempt = 0; attempt < 10; attempt += 1) {
            await new Promise(resolve => {
                setImmediate(resolve);
            });
        }
        expect(mocks.spawn).not.toHaveBeenCalled();

        releaseOccupant();
        controller.abort(new DOMException('Canceled scan cleanup detection', 'AbortError'));
        await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());

        expect(mocks.terminateDetachedChildProcess).toHaveBeenCalledWith(child, 1_500);
        child.emit('close', null, 'SIGKILL');
        await rejected;
    });
    // The worker turns an unproven stop into a quarantine of the source working
    // copy, so what this adapter reports about its process tree decides whether
    // the user's bytes survive a tab close.
    it('marks an aborted run whose process tree was never proven dead', async () => {
        vi.useFakeTimers();
        mocks.terminateDetachedChildProcess.mockImplementation(() => new Promise<boolean>(() => {}));
        const { runScanCleanupSidecar } = await import('@electron/features/scan-cleanup/worker/runScanCleanupSidecar');
        const { getUnprovenNativeTerminationDetail } = await import('@electron/utils/nativeTerminationProof');
        const child = new MockSidecarProcess();
        mocks.spawn.mockReturnValue(child);
        const controller = new AbortController();
        const log = vi.fn<TWorkerLog>();

        const rejection = runScanCleanupSidecar(
            '/native/evb-scan-cleanup',
            '/scratch/canceled-manifest.json',
            controller.signal,
            log,
            () => {},
        ).catch((error: unknown) => error);
        await vi.advanceTimersByTimeAsync(0);
        controller.abort(new DOMException('Canceled scan cleanup detection', 'AbortError'));
        await vi.advanceTimersByTimeAsync(3_500);

        const error = await rejection;
        expect(mocks.terminateDetachedChildProcess).toHaveBeenCalledWith(child, 1_500);
        expect(getUnprovenNativeTerminationDetail(error)).toContain('was not proven dead within 3500ms');
        expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('was not proven dead'));
    });

    it('leaves an aborted run whose process tree was confirmed dead unmarked', async () => {
        vi.useFakeTimers();
        mocks.terminateDetachedChildProcess.mockResolvedValue(true);
        const { runScanCleanupSidecar } = await import('@electron/features/scan-cleanup/worker/runScanCleanupSidecar');
        const { getUnprovenNativeTerminationDetail } = await import('@electron/utils/nativeTerminationProof');
        const child = new MockSidecarProcess();
        mocks.spawn.mockReturnValue(child);
        const controller = new AbortController();
        const log = vi.fn<TWorkerLog>();
        const abortError = new DOMException('Canceled scan cleanup detection', 'AbortError');

        const rejection = runScanCleanupSidecar(
            '/native/evb-scan-cleanup',
            '/scratch/canceled-manifest.json',
            controller.signal,
            log,
            () => {},
        ).catch((error: unknown) => error);
        await vi.advanceTimersByTimeAsync(0);
        controller.abort(abortError);
        await vi.advanceTimersByTimeAsync(3_500);

        const error = await rejection;
        expect(mocks.terminateDetachedChildProcess).toHaveBeenCalledWith(child, 1_500);
        expect(error).toBe(abortError);
        // A proven stop must not quarantine the working copy: the close path
        // would then retain a temp directory nothing is reading on every cancel.
        expect(getUnprovenNativeTerminationDetail(error)).toBeUndefined();
        expect(log).not.toHaveBeenCalledWith('warn', expect.stringContaining('was not proven dead'));
    });
});
