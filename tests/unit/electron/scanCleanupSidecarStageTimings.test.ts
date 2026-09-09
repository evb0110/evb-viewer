import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
    type Mock,
} from 'vitest';
import type { TWorkerLog } from '@electron/ocr/worker/types';

const mocks = vi.hoisted(() => ({
    spawn: vi.fn(),
    terminateDetachedChildProcess: vi.fn(async () => {}),
    verifyNativeToolProtocol: vi.fn(async (): Promise<{
        protocolVersion: number;
        capabilities: readonly string[];
    }> => ({
        protocolVersion: 10,
        capabilities: [
            'manifest-v3',
            'structured-warning-events',
        ],
    })),
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

function progressLine(
    pageNumber: number,
    stageTimings: Record<string, number>,
    stage: 'page-analyzed' | 'page-complete' = 'page-complete',
) {
    return `${JSON.stringify({
        version: 3,
        type: 'progress',
        progress: {
            stage,
            completedPages: pageNumber,
            totalPages: 2,
            pageNumber,
            classification: 'single-uncut-page',
            confidence: 0.9,
            stageTimings,
        },
    })}\n`;
}

function resultLine(status: 'success' | 'failure') {
    return `${JSON.stringify({
        version: 3,
        type: 'result',
        result: status === 'success'
            ? {
                status,
                completedPages: 2,
                totalPages: 2,
            }
            : {
                status,
                code: 'native-failure',
                message: 'sidecar refused the manifest',
            },
    })}\n`;
}

async function flushLines(seen: () => number, expected: number) {
    for (let attempt = 0; attempt < 100 && seen() < expected; attempt += 1) {
        await new Promise(resolve => {
            setImmediate(resolve);
        });
    }
}

function readTimingLog(log: Mock<TWorkerLog>) {
    const entries = log.mock.calls.filter(call => call[0] === 'debug');
    expect(entries).toHaveLength(1);
    return entries[0]![1];
}

describe('scan cleanup sidecar stage timings', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        mocks.terminateDetachedChildProcess.mockResolvedValue(undefined);
        vi.useRealTimers();
    });

    it('terminates a malformed NDJSON sidecar once and surfaces the protocol error', async () => {
        const child = new MockSidecarProcess();
        mocks.spawn.mockReturnValue(child);
        const {runScanCleanupSidecar} = await import('@electron/features/scan-cleanup/worker/runScanCleanupSidecar');
        const controller = new AbortController();
        const run = runScanCleanupSidecar(
            '/native/evb-scan-cleanup',
            '/scratch/malformed-manifest.json',
            controller.signal,
            vi.fn<TWorkerLog>(),
            () => {},
        );
        const rejected = expect(run).rejects.toThrow();

        child.stdout.write('{not-json}\n');
        child.stdout.write('{still-not-json}\n');
        await vi.waitFor(() => expect(mocks.terminateDetachedChildProcess).toHaveBeenCalledOnce());
        expect(mocks.terminateDetachedChildProcess).toHaveBeenCalledWith(child, 1_500);
        child.emit('close', 1, null);
        await rejected;
    });

    it('keeps the fatal protocol error authoritative when abort follows malformed NDJSON', async () => {
        const child = new MockSidecarProcess();
        mocks.spawn.mockReturnValue(child);
        const {runScanCleanupSidecar} = await import('@electron/features/scan-cleanup/worker/runScanCleanupSidecar');
        const controller = new AbortController();
        const run = runScanCleanupSidecar('/native/evb-scan-cleanup', '/scratch/malformed.json', controller.signal, vi.fn<TWorkerLog>(), () => {});
        const rejected = expect(run).rejects.toBeInstanceOf(SyntaxError);
        child.stdout.write('{not-json}\n');
        await vi.waitFor(() => expect(mocks.terminateDetachedChildProcess).toHaveBeenCalledOnce());
        // Abort shares the same termination guard. It must not issue a second
        // process-tree kill after the fatal protocol frame.
        controller.abort(new DOMException('Canceled later', 'AbortError'));
        expect(mocks.terminateDetachedChildProcess).toHaveBeenCalledOnce();
        child.emit('close', null, 'SIGTERM');
        await rejected;
    });

    it('reports the decoded native frame alone and invents no stage or percentage', async () => {
        const child = new MockSidecarProcess();
        mocks.spawn.mockReturnValue(child);
        const {runScanCleanupSidecar} = await import('@electron/features/scan-cleanup/worker/runScanCleanupSidecar');
        const onProgress = vi.fn();

        const run = runScanCleanupSidecar(
            '/native/evb-scan-cleanup',
            '/scratch/transport-manifest.json',
            new AbortController().signal,
            vi.fn<TWorkerLog>(),
            onProgress,
        );
        child.stdout.write(progressLine(1, {decodeMs: 10}, 'page-analyzed'));
        child.stdout.write(progressLine(1, {decodeMs: 20}));
        child.stdout.write(resultLine('success'));
        await flushLines(() => onProgress.mock.calls.length, 2);
        child.emit('close', 0, null);
        await run;

        // A second stage model here labelled analyze `page-complete` as
        // `rendering` for consumers that never asked for it. The adapter now
        // reports the native frame verbatim, and nothing else.
        expect(onProgress.mock.calls.map(call => call.length)).toEqual([
            1,
            1,
        ]);
        const frames = onProgress.mock.calls.map(([frame]) => frame as Record<string, unknown>);
        expect(frames.map(frame => frame.stage)).toEqual([
            'page-analyzed',
            'page-complete',
        ]);
        for (const frame of frames) {
            expect(frame).not.toHaveProperty('completedUnits');
            expect(frame).not.toHaveProperty('totalUnits');
            expect(frame).not.toHaveProperty('percent');
            expect(frame).not.toHaveProperty('completedPageNumbers');
            expect(frame).not.toHaveProperty('etaSeconds');
        }
        expect(frames[1]).toEqual({
            stage: 'page-complete',
            completedPages: 1,
            totalPages: 2,
            pageNumber: 1,
            classification: 'single-uncut-page',
            confidence: 0.9,
            stageTimings: {decodeMs: 20},
        });
    });

    it.each([
        [
            'legacy revision 9',
            {
                protocolVersion: 9,
                capabilities: ['manifest-v3'],
            },
            false,
        ],
        [
            'revision 10 structured warnings',
            {
                protocolVersion: 10,
                capabilities: [
                    'manifest-v3',
                    'structured-warning-events',
                ],
            },
            true,
        ],
    ] as const)('returns the %s warning capability gate to the production pipeline', async (
        _label,
        handshake,
        structuredWarningEventsSupported,
    ) => {
        const child = new MockSidecarProcess();
        mocks.spawn.mockReturnValue(child);
        mocks.verifyNativeToolProtocol.mockResolvedValue(handshake);
        const {runScanCleanupSidecar} = await import('@electron/features/scan-cleanup/worker/runScanCleanupSidecar');
        const run = runScanCleanupSidecar(
            '/native/evb-scan-cleanup',
            '/scratch/capability-manifest.json',
            new AbortController().signal,
            vi.fn<TWorkerLog>(),
            () => {},
        );
        child.stdout.write(resultLine('success'));
        await new Promise(resolve => setImmediate(resolve));
        child.emit('close', 0, null);

        await expect(run).resolves.toEqual({structuredWarningEventsSupported});
    });

    it('reports per-stage totals summed across every page the sidecar timed', async () => {
        const child = new MockSidecarProcess();
        mocks.spawn.mockReturnValue(child);
        const { runScanCleanupSidecar } = await import('@electron/features/scan-cleanup/worker/runScanCleanupSidecar');
        const log = vi.fn<TWorkerLog>();
        let progressEvents = 0;

        const run = runScanCleanupSidecar(
            '/native/evb-scan-cleanup',
            '/scratch/cleanup-manifest.json',
            new AbortController().signal,
            log,
            () => {
                progressEvents += 1;
            },
        );
        child.stdout.write(progressLine(1, {
            decodeMs: 120,
            renderMs: 40,
            writeMs: 10,
        }));
        child.stdout.write(progressLine(2, {
            decodeMs: 80,
            renderMs: 60,
            splitMs: 250,
        }));
        child.stdout.write(resultLine('success'));
        await flushLines(() => progressEvents, 2);
        child.emit('close', 0, null);
        await run;

        const message = readTimingLog(log);
        expect(message).toContain('cleanup-manifest.json');
        expect(message).toContain('timedPages=2');
        expect(message).toContain('decode=0.200s');
        expect(message).toContain('split=0.250s');
        expect(message).toContain('render=0.100s');
        expect(message).toContain('write=0.010s');
        expect(message).not.toContain('deskew');
    });

    it('counts only terminal page timings once after provisional analysis frames', async () => {
        const child = new MockSidecarProcess();
        mocks.spawn.mockReturnValue(child);
        const {runScanCleanupSidecar} = await import('@electron/features/scan-cleanup/worker/runScanCleanupSidecar');
        const log = vi.fn<TWorkerLog>();
        let progressEvents = 0;

        const run = runScanCleanupSidecar(
            '/native/evb-scan-cleanup',
            '/scratch/reconciled-manifest.json',
            new AbortController().signal,
            log,
            () => {
                progressEvents += 1;
            },
        );
        child.stdout.write(progressLine(1, {decodeMs: 120}, 'page-analyzed'));
        child.stdout.write(progressLine(1, {
            decodeMs: 80,
            renderMs: 40,
        }));
        child.stdout.write(progressLine(2, {decodeMs: 90}, 'page-analyzed'));
        child.stdout.write(progressLine(2, {
            decodeMs: 60,
            writeMs: 10,
        }));
        child.stdout.write(resultLine('success'));
        await flushLines(() => progressEvents, 4);
        child.emit('close', 0, null);
        await run;

        const message = readTimingLog(log);
        expect(message).toContain('timedPages=2');
        expect(message).toContain('decode=0.140s');
        expect(message).toContain('render=0.040s');
        expect(message).toContain('write=0.010s');
        expect(message).not.toContain('0.260s');
    });

    it('waits for close so terminal stdout delivered after exit remains authoritative', async () => {
        const child = new MockSidecarProcess();
        mocks.spawn.mockReturnValue(child);
        const {runScanCleanupSidecar} = await import('@electron/features/scan-cleanup/worker/runScanCleanupSidecar');
        const run = runScanCleanupSidecar(
            '/native/evb-scan-cleanup',
            '/scratch/late-terminal-manifest.json',
            new AbortController().signal,
            vi.fn<TWorkerLog>(),
            () => {},
        );

        child.emit('exit', 0, null);
        child.stdout.end(resultLine('success'));
        await new Promise(resolve => {
            setImmediate(resolve);
        });
        child.emit('close', 0, null);

        await expect(run).resolves.toEqual({structuredWarningEventsSupported: true});
    });

    it('awaits process-tree cleanup before a wall-clock timeout rejects', async () => {
        vi.useFakeTimers();
        try {
            const child = new MockSidecarProcess();
            let finishTermination = () => {};
            mocks.spawn.mockReturnValue(child);
            mocks.terminateDetachedChildProcess.mockImplementationOnce(() => new Promise<void>(resolve => {
                finishTermination = resolve;
            }));
            const {runScanCleanupSidecar} = await import('@electron/features/scan-cleanup/worker/runScanCleanupSidecar');
            let failureReturned = false;
            const failure = runScanCleanupSidecar(
                '/native/evb-scan-cleanup',
                '/scratch/timed-out-manifest.json',
                new AbortController().signal,
                vi.fn<TWorkerLog>(),
                () => {},
                {timeoutMs: 10},
            ).catch(error => {
                failureReturned = true;
                return error as Error;
            });

            await vi.advanceTimersByTimeAsync(10);
            expect(mocks.terminateDetachedChildProcess).toHaveBeenCalledWith(child, 1_500);
            expect(failureReturned).toBe(false);

            finishTermination();
            await expect(failure).resolves.toMatchObject({message: 'evb-scan-cleanup timed out after 10ms'});
            expect(failureReturned).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it('uses a bounded fallback when process-tree cleanup does not settle', async () => {
        vi.useFakeTimers();
        try {
            const child = new MockSidecarProcess();
            mocks.spawn.mockReturnValue(child);
            mocks.terminateDetachedChildProcess.mockImplementationOnce(() => new Promise<void>(() => {}));
            const {runScanCleanupSidecar} = await import('@electron/features/scan-cleanup/worker/runScanCleanupSidecar');
            let failureReturned = false;
            const failure = runScanCleanupSidecar(
                '/native/evb-scan-cleanup',
                '/scratch/stuck-termination-manifest.json',
                new AbortController().signal,
                vi.fn<TWorkerLog>(),
                () => {},
                {timeoutMs: 10},
            ).catch(error => {
                failureReturned = true;
                return error as Error;
            });

            await vi.advanceTimersByTimeAsync(10 + 3_499);
            expect(failureReturned).toBe(false);
            await vi.advanceTimersByTimeAsync(1);

            await expect(failure).resolves.toMatchObject({message: 'evb-scan-cleanup timed out after 10ms'});
            expect(failureReturned).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it('still reports what the failed run spent before the sidecar gave up', async () => {
        const child = new MockSidecarProcess();
        mocks.spawn.mockReturnValue(child);
        const { runScanCleanupSidecar } = await import('@electron/features/scan-cleanup/worker/runScanCleanupSidecar');
        const log = vi.fn<TWorkerLog>();
        let progressEvents = 0;

        const run = runScanCleanupSidecar(
            '/native/evb-scan-cleanup',
            '/scratch/lossless-analysis-manifest.json',
            new AbortController().signal,
            log,
            () => {
                progressEvents += 1;
            },
        );
        child.stdout.write(progressLine(1, {decodeMs: 300}));
        child.stdout.write(resultLine('failure'));
        await flushLines(() => progressEvents, 1);
        child.emit('close', 1, null);

        await expect(run).rejects.toThrow('sidecar refused the manifest');
        const message = readTimingLog(log);
        expect(message).toContain('lossless-analysis-manifest.json');
        expect(message).toContain('timedPages=1');
        expect(message).toContain('decode=0.300s');
    });

    it('waits for a native command slot before it spawns', async () => {
        vi.stubEnv('EVB_NATIVE_COMMAND_MAX_CONCURRENCY', '1');
        vi.resetModules();
        const { acquireNativeCommandAdmission } = await import('@electron/native-tools/runNativeCommand');
        const { runScanCleanupSidecar } = await import('@electron/features/scan-cleanup/worker/runScanCleanupSidecar');
        const child = new MockSidecarProcess();
        mocks.spawn.mockReturnValue(child);
        const releaseOccupant = await acquireNativeCommandAdmission();

        const run = runScanCleanupSidecar(
            '/native/evb-scan-cleanup',
            '/scratch/admitted-manifest.json',
            new AbortController().signal,
            vi.fn<TWorkerLog>(),
            () => {},
        );
        for (let attempt = 0; attempt < 10; attempt += 1) {
            await new Promise(resolve => {
                setImmediate(resolve);
            });
        }
        expect(mocks.spawn).not.toHaveBeenCalled();

        releaseOccupant();
        await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
        child.stdout.write(resultLine('success'));
        await vi.waitFor(() => expect(child.stdout.readableLength).toBe(0));
        child.emit('close', 0, null);
        await run;

        // The slot the sidecar held is handed back, so the next native command
        // is admitted immediately.
        const releaseAfterRun = await acquireNativeCommandAdmission();
        releaseAfterRun();
        vi.unstubAllEnvs();
    });
});
