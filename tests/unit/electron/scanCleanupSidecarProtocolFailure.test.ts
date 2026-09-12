import {EventEmitter} from 'node:events';
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
    verifyNativeToolProtocol: vi.fn(async () => {}),
}));

vi.mock('child_process', () => ({spawn: mocks.spawn}));
vi.mock('readline', () => ({createInterface: mocks.createInterface}));
vi.mock('@electron/utils/nativeChildProcess', () => ({
    createDetachedChildProcessSpawnOptions: (options: unknown) => options,
    terminateDetachedChildProcess: mocks.terminateDetachedChildProcess,
}));
vi.mock('@electron/native-tools/runNativeToolCommand', () => ({verifyNativeToolProtocol: mocks.verifyNativeToolProtocol}));

class MockSidecarProcess extends EventEmitter {
    readonly stdout = new PassThrough();

    readonly stderr = new PassThrough();
}

class MockLineReader extends EventEmitter {
    readonly close = vi.fn();
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
        await vi.advanceTimersByTimeAsync(0);
        lines.emit('line', '{');
        controller.abort(new DOMException('Canceled scan cleanup detection', 'AbortError'));
        const rejected = expect(run).rejects.toMatchObject({name: 'SyntaxError'});

        await vi.advanceTimersByTimeAsync(3_500);
        await rejected;
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
                if (progressError !== undefined) throw progressError;
            },
        );

        await vi.waitFor(() => expect(mocks.createInterface).toHaveBeenCalledOnce());
        lines.emit('line', line);
        await vi.waitFor(() => {
            expect(lines.close).toHaveBeenCalledOnce();
            expect(mocks.terminateDetachedChildProcess).toHaveBeenCalledWith(child, 1_500);
        });
        child.emit('close', null, 'SIGTERM');

        if (progressError === undefined) {
            await expect(run).rejects.toBeInstanceOf(Error);
        } else {
            await expect(run).rejects.toBe(progressError);
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

});
