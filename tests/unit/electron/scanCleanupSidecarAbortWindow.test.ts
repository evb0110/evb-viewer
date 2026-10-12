import { EventEmitter } from 'node:events';
import {
    mkdtemp, readFile, rm, writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import { PassThrough } from 'node:stream';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { TWorkerLog } from '@electron/features/ocr/pipeline/types';
import {createShutdownPhaseRunners} from '@electron/bootstrap/createShutdownPhaseRunners';

const mocks = vi.hoisted(() => ({
    spawn: vi.fn(),
    terminateDetachedChildProcess: vi.fn(async (_proc: unknown, _graceMs: number): Promise<boolean> => false),
}));

vi.mock('child_process', () => ({spawn: mocks.spawn}));
vi.mock('@electron/utils/nativeChildProcess', () => ({
    createDetachedChildProcessSpawnOptions: (options: unknown) => options,
    terminateDetachedChildProcess: mocks.terminateDetachedChildProcess,
}));
class MockSidecarProcess extends EventEmitter {
    readonly stdout = new PassThrough();

    readonly stderr = new PassThrough();

    readonly pid = process.pid;

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

    it('reaps canceled analysis within the feature disposal shutdown budget', async () => {
        vi.useFakeTimers();
        const {runScanCleanupSidecar} = await import('@electron/features/scan-cleanup/worker/runScanCleanupSidecar');
        const child = new MockSidecarProcess();
        mocks.spawn.mockReturnValue(child);
        let childAlive = true;
        // Model a busy native stage that needs force termination. The shared
        // process-tree owner polls at 100 ms intervals after the grace period.
        mocks.terminateDetachedChildProcess.mockImplementation((_proc, graceMs) => new Promise(resolve => {
            setTimeout(() => {
                childAlive = false;
                child.emit('close', null, 'SIGKILL');
                resolve(true);
            }, graceMs + 100);
        }));
        const controller = new AbortController();
        const run = runScanCleanupSidecar(
            '/native/evb-scan-cleanup',
            '/scratch/shutdown-manifest.json',
            controller.signal,
            vi.fn<TWorkerLog>(),
            () => {},
        ).catch((error: unknown) => error);
        await vi.advanceTimersByTimeAsync(0);
        const logger = {
            debug: vi.fn(),
            error: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
        };
        const phases = createShutdownPhaseRunners(logger, {
            createPreservationSteps: () => [{
                label: 'main-operations-cancel',
                run: () => controller.abort(new Error('app shutdown')),
            }],
            createBestEffortCleanupSteps: () => [
                {
                    label: 'feature-registration-disposal',
                    run: async () => { await run; },
                },
                // Production gives feature disposal the first of 13 shares
                // of its 20-second cleanup deadline, currently 1,538 ms.
                ...Array.from({length: 12}, (_, index) => ({
                    label: `remaining-cleanup-${index}`,
                    run: () => undefined,
                })),
            ],
        });
        const context = {
            reason: 'graceful' as const,
            preserveRecoveryState: false,
        };
        await phases.runPreservationSteps(context);
        const cleanup = phases.runBestEffortCleanupSteps(context);
        await vi.advanceTimersByTimeAsync(1_538);
        await cleanup;
        const aliveAtCleanup = childAlive;
        // Finish the simulated child even on the red baseline.
        await vi.runAllTimersAsync();
        await run;

        expect(logger.error.mock.calls.filter(([
            , diagnostic,
        ]) => diagnostic?.code === 'MAIN_SHUTDOWN_FAILED')).toEqual([]);
        expect(aliveAtCleanup).toBe(false);
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

        await vi.advanceTimersByTimeAsync(3_000);
        await rejected;
    });

    it('does not spawn a sidecar canceled while waiting for a native command slot', async () => {
        vi.resetModules();
        const { acquireNativeCommandAdmission } = await import('@electron/native-tools/runNativeCommand');
        const { runScanCleanupSidecar } = await import('@electron/features/scan-cleanup/worker/runScanCleanupSidecar');
        const releaseOccupants = await Promise.all(Array.from({length: 8}, () => acquireNativeCommandAdmission()));
        const controller = new AbortController();

        const run = runScanCleanupSidecar(
            '/native/evb-scan-cleanup',
            '/scratch/canceled-manifest.json',
            controller.signal,
            vi.fn<TWorkerLog>(),
            () => {},
        );
        for (let attempt = 0; attempt < 10; attempt += 1) {
            await new Promise(resolve => {
                setImmediate(resolve);
            });
        }
        expect(mocks.spawn).not.toHaveBeenCalled();

        releaseOccupants.forEach(release => release());
        controller.abort(new DOMException('Canceled scan cleanup detection', 'AbortError'));
        await expect(run).rejects.toMatchObject({name: 'AbortError'});
        expect(mocks.spawn).not.toHaveBeenCalled();
        expect(mocks.terminateDetachedChildProcess).not.toHaveBeenCalled();
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
        await vi.advanceTimersByTimeAsync(3_000);

        const error = await rejection;
        expect(getUnprovenNativeTerminationDetail(error)).toContain('was not proven dead');
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
        await vi.advanceTimersByTimeAsync(3_000);

        const error = await rejection;
        expect(error).toBe(abortError);
        // A proven stop must not quarantine the working copy: the close path
        // would then retain a temp directory nothing is reading on every cancel.
        expect(getUnprovenNativeTerminationDetail(error)).toBeUndefined();
        expect(log).not.toHaveBeenCalledWith('warn', expect.stringContaining('was not proven dead'));
    });

    it('replays staged destinations after an unproven sidecar termination', async () => {
        vi.useFakeTimers();
        mocks.terminateDetachedChildProcess.mockImplementation(() => new Promise<boolean>(() => {}));
        const {runScanCleanupSidecar} = await import('@electron/features/scan-cleanup/worker/runScanCleanupSidecar');
        const child = new MockSidecarProcess();
        mocks.spawn.mockReturnValue(child);
        const directory = await mkdtemp(join(tmpdir(), 'evb-scan-cleanup-recovery-'));
        const manifestPath = join(directory, 'manifest.json');
        const original = join(directory, 'page.png');
        const backup = join(directory, 'page.png.evb-tmp-recovery');
        const journalPath = `${manifestPath}.evb-publication-journal.json`;
        const controller = new AbortController();
        let deferredRecovery: Promise<boolean> | undefined;
        try {
            const run = runScanCleanupSidecar(
                '/native/evb-scan-cleanup',
                manifestPath,
                controller.signal,
                vi.fn<TWorkerLog>(),
                () => {},
                {onRecoveryPending: recovery => { deferredRecovery = recovery; }},
            ).catch((error: unknown) => error);
            await vi.advanceTimersByTimeAsync(0);
            await writeFile(backup, 'previous destination');
            await writeFile(journalPath, JSON.stringify({
                version: 1,
                manifestPath,
                entries: [{
                    original,
                    backup,
                }],
            }));
            controller.abort(new DOMException('Canceled scan cleanup detection', 'AbortError'));
            await vi.advanceTimersByTimeAsync(3_000);

            const error = await run;
            expect(error).toBeInstanceOf(Error);
            expect(deferredRecovery).toBeDefined();
            await expect(readFile(original, 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
            expect(JSON.parse(await readFile(journalPath, 'utf8'))).toMatchObject({entries: [expect.objectContaining({backup})]});

            // Recovery is deferred until the child has actually closed. The
            // owner retains the scratch until this promise settles.
            child.emit('close', null, 'SIGKILL');
            await expect(deferredRecovery!).resolves.toBe(true);
            await expect(readFile(original, 'utf8')).resolves.toBe('previous destination');
            await expect(readFile(journalPath)).rejects.toMatchObject({code: 'ENOENT'});
        } finally {
            await rm(directory, {
                recursive: true,
                force: true,
            });
        }
    });

    it('shares recovery between fatal settlement and a concurrent child close', async () => {
        let finishTermination!: (terminated: boolean) => void;
        mocks.terminateDetachedChildProcess.mockImplementation(() => new Promise<boolean>(resolve => {
            finishTermination = resolve;
        }));
        const {runScanCleanupSidecar} = await import('@electron/features/scan-cleanup/worker/runScanCleanupSidecar');
        const child = new MockSidecarProcess();
        mocks.spawn.mockReturnValue(child);
        const directory = await mkdtemp(join(tmpdir(), 'evb-scan-cleanup-concurrent-recovery-'));
        const manifestPath = join(directory, 'manifest.json');
        const original = join(directory, 'page.png');
        const backup = join(directory, 'page.png.evb-tmp-recovery');
        const journalPath = `${manifestPath}.evb-publication-journal.json`;
        const controller = new AbortController();
        let deferredRecovery: Promise<boolean> | undefined;
        try {
            const run = runScanCleanupSidecar(
                '/native/evb-scan-cleanup',
                manifestPath,
                controller.signal,
                vi.fn<TWorkerLog>(),
                () => {},
                {onRecoveryPending: recovery => { deferredRecovery = recovery; }},
            );
            await writeFile(backup, 'previous destination');
            await writeFile(journalPath, JSON.stringify({
                version: 1,
                manifestPath,
                entries: [{
                    original,
                    backup,
                }],
            }));
            controller.abort(new DOMException('Canceled scan cleanup detection', 'AbortError'));
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(mocks.terminateDetachedChildProcess).toHaveBeenCalledOnce();
            expect(deferredRecovery).toBeDefined();

            // The close observer and fatal settlement intentionally enter the
            // same replay window before either caller can consume the backup.
            child.emit('close', null, 'SIGKILL');
            finishTermination(true);

            await expect(run).rejects.toMatchObject({name: 'AbortError'});
            await expect(deferredRecovery!).resolves.toBe(true);
            await expect(readFile(original, 'utf8')).resolves.toBe('previous destination');
            await expect(readFile(journalPath)).rejects.toMatchObject({code: 'ENOENT'});
        } finally {
            await rm(directory, {
                recursive: true,
                force: true,
            });
        }
    });

    it('discards committed journal backups without restoring committed outputs', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'evb-scan-cleanup-committed-recovery-'));
        const manifestPath = join(directory, 'manifest.json');
        const journalPath = `${manifestPath}.evb-publication-journal.json`;
        const original = join(directory, 'page.png');
        const backup = join(directory, 'page.png.evb-tmp-recovery');
        try {
            await writeFile(original, 'new destination');
            await writeFile(backup, 'previous destination');
            await writeFile(journalPath, JSON.stringify({
                version: 1,
                manifestPath,
                committed: true,
                entries: [{
                    original,
                    backup,
                    remove: false,
                }],
            }));

            const {replayScanCleanupPublicationJournal} = await import('@electron/features/scan-cleanup/worker/runScanCleanupSidecar');
            await expect(replayScanCleanupPublicationJournal(manifestPath)).resolves.toBe(true);
            await expect(readFile(original, 'utf8')).resolves.toBe('new destination');
            await expect(readFile(backup)).rejects.toMatchObject({code: 'ENOENT'});
            await expect(readFile(journalPath)).rejects.toMatchObject({code: 'ENOENT'});
        } finally {
            await rm(directory, {
                recursive: true,
                force: true,
            });
        }
    });

    it('removes outputs for destinations that were absent before an interrupted publication', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'evb-scan-cleanup-absent-recovery-'));
        const manifestPath = join(directory, 'manifest.json');
        const journalPath = `${manifestPath}.evb-publication-journal.json`;
        const output = join(directory, 'page.png');
        try {
            await writeFile(output, 'partial destination');
            await writeFile(journalPath, JSON.stringify({
                version: 1,
                manifestPath,
                committed: false,
                entries: [{
                    original: output,
                    backup: null,
                    remove: true,
                }],
            }));

            const {replayScanCleanupPublicationJournal} = await import('@electron/features/scan-cleanup/worker/runScanCleanupSidecar');
            await expect(replayScanCleanupPublicationJournal(manifestPath)).resolves.toBe(true);
            await expect(readFile(output)).rejects.toMatchObject({code: 'ENOENT'});
            await expect(readFile(journalPath)).rejects.toMatchObject({code: 'ENOENT'});
        } finally {
            await rm(directory, {
                recursive: true,
                force: true,
            });
        }
    });
});
