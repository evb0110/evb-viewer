import {EventEmitter} from 'node:events';
import {resolve} from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const mocks = vi.hoisted(() => {
    return {
        open: vi.fn(),
        openData: Buffer.from('%PDF-1.7\n%%EOF\n'),
        readFile: vi.fn(),
        rm: vi.fn(async () => undefined),
        spawn: vi.fn(),
        terminateDetachedChildProcess: vi.fn(async () => true),
        warn: vi.fn(),
        writeFile: vi.fn(async () => undefined),
    };
});

class MockProcess extends EventEmitter {
    readonly pid = 12345;

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
vi.mock('@electron/utils/appTempDir', () => ({getAppTempDir: () => '/tmp'}));
// The native child is mocked; its feature tests do not inspect the host process.
vi.mock(import('@electron/utils/processIdentity'), async (importOriginal) => ({
    ...(await importOriginal()),
    getOwnStartTime: async () => null,
}));

vi.mock('fs/promises', () => ({
    mkdir: async () => undefined,
    lstat: async () => ({
        isDirectory: () => true,
        isFile: () => true,
        isSymbolicLink: () => false,
    }),
    mkdtemp: vi.fn(async () => '/tmp/pdfExport-scope-image-combine-test'),
    open: mocks.open,
    readFile: (path: string, ...args: unknown[]) =>
        path.endsWith('.evb-managed-scratch.json')
            ? Promise.resolve(
                  JSON.stringify({
                      createdAt: 0,
                      pid: process.pid,
                      prefix: 'pdfExport-scope-',
                  }),
              )
            : Reflect.apply(mocks.readFile, undefined, [path, ...args]),
    rm: mocks.rm,
    writeFile: mocks.writeFile,
}));
vi.mock('@electron/native-tools/resolveNativeToolPath', () => ({resolveNativeToolPath: () => '/native/evb-pdf-image-combine'}));
vi.mock('@electron/utils/nativeChildProcess', () => ({
    spawnNativeChildProcess: (command: string, args: string[], options: object) =>
        mocks.spawn(command, args, {
            ...options,
            detached: true,
        }),
    getNativeChildProcessPid: (proc: {pid?: number}) => Promise.resolve(proc.pid ?? null),
    getNativeChildProcessTerminationProof: () => undefined,
    terminateDetachedChildProcess: mocks.terminateDetachedChildProcess,
}));
vi.mock('@electron/utils/createLogger', () => ({
    createLogger: () => ({
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        warn: mocks.warn,
    }),
}));

// The managed scratch owner removes the resolved directory, which gains a drive
// letter on Windows.
const SCRATCH_DIR = resolve('/tmp/pdfExport-scope-image-combine-test');

describe('native PDF image combiner output validation', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        vi.stubEnv('EVB_PDF_IMAGE_COMBINE_ENABLE', '1');
        mocks.openData = Buffer.from('%PDF-1.7\n%%EOF\n');
        mocks.readFile.mockReset();
        mocks.readFile.mockImplementation(async () => Buffer.from(mocks.openData));
        mocks.open.mockImplementation(async (path: string) => {
            const openData = path.endsWith('.jpg') ? Buffer.from([0xff, 0xd8, 0xff, 0xda]) : mocks.openData;
            return {
                stat: vi.fn(async () => ({
                    isFile: () => true,
                    size: openData.byteLength,
                })),
                read: vi.fn(async (buffer: Buffer, offset: number, length: number, position: number) => {
                    openData.copy(buffer, offset, position, position + length);
                    return {
                        bytesRead: Math.min(length, Math.max(0, openData.byteLength - position)),
                        buffer,
                    };
                }),
                close: vi.fn(async () => undefined),
            };
        });
        mocks.spawn.mockImplementation(() => {
            const proc = new MockProcess();
            queueMicrotask(() => {
                proc.emit('close', 0);
            });
            return proc;
        });
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllEnvs();
    });

    it('rejects when native bytes are not a PDF in enabled test mode', async () => {
        mocks.openData = Buffer.from('not a pdf');
        mocks.readFile.mockResolvedValueOnce(Buffer.from('not a pdf'));
        const {tryBuildOptimizedPdfWithNativeImageCombiner} = await import('@electron/image/tryCreatePdfWithNativeImageCombiner');

        await expect(tryBuildOptimizedPdfWithNativeImageCombiner(['/tmp/input.ppm'], 300)).rejects.toThrow(
            'Native image PDF combine fallback is not allowed in tests',
        );

        expect(mocks.warn).toHaveBeenCalledWith(expect.stringContaining('produced invalid PDF output'));
        expect(mocks.rm).toHaveBeenCalledWith(expect.stringMatching(/^[\\/]tmp[\\/]pdfExport-scope-image-combine-test[\\/].+\.pdf$/u), {
            force: true,
        });
        expect(mocks.rm).toHaveBeenCalledWith(SCRATCH_DIR, {
            recursive: true,
            force: true,
        });
    });

    it('rejects successful file-backed native combines when output is malformed in enabled test mode', async () => {
        mocks.openData = Buffer.from('');
        const {tryWritePdfWithNativeImageCombiner} = await import('@electron/image/tryCreatePdfWithNativeImageCombiner');

        await expect(tryWritePdfWithNativeImageCombiner(['/tmp/input.jpg'], '/tmp/output.pdf')).rejects.toThrow(
            'Native image PDF combine fallback is not allowed in tests',
        );

        expect(mocks.rm).toHaveBeenCalledWith('/tmp/output.pdf', {force: true});
    });

    it('rejects when the native process fails in enabled test mode', async () => {
        mocks.spawn.mockImplementationOnce(() => {
            const proc = new MockProcess();
            queueMicrotask(() => {
                proc.emit('close', 1);
            });
            return proc;
        });
        const {tryWritePdfWithNativeImageCombiner} = await import('@electron/image/tryCreatePdfWithNativeImageCombiner');

        await expect(tryWritePdfWithNativeImageCombiner(['/tmp/input.jpg'], '/tmp/output.pdf')).rejects.toThrow(
            'Native image PDF combine fallback is not allowed in tests',
        );

        expect(mocks.rm).toHaveBeenCalledWith('/tmp/output.pdf', {force: true});
    });

    it('terminates the native process group and rejects when canceled', async () => {
        const proc = new MockProcess();
        const abortError = new Error('Canceled by test');
        abortError.name = 'AbortError';
        mocks.spawn.mockReturnValueOnce(proc);
        mocks.terminateDetachedChildProcess.mockImplementationOnce(async () => {
            proc.emit('close', null, 'SIGTERM');
            return true;
        });
        const {tryWritePdfWithNativeImageCombiner} = await import('@electron/image/tryCreatePdfWithNativeImageCombiner');
        const controller = new AbortController();

        const pending = tryWritePdfWithNativeImageCombiner(['/tmp/input.jpg'], '/tmp/output.pdf', {signal: controller.signal});
        await vi.waitFor(() => {
            expect(mocks.spawn).toHaveBeenCalled();
        });
        controller.abort(abortError);

        await expect(pending).rejects.toBe(abortError);
        expect(mocks.spawn).toHaveBeenCalledWith(
            '/native/evb-pdf-image-combine',
            expect.any(Array),
            expect.objectContaining({detached: true}),
        );
        expect(mocks.terminateDetachedChildProcess).toHaveBeenCalledWith(proc, 1_000);
        expect(mocks.readFile).not.toHaveBeenCalledWith('/tmp/input.jpg');
        expect(mocks.rm).toHaveBeenCalledWith(SCRATCH_DIR, {
            recursive: true,
            force: true,
        });
    });

    it('rejects cancellation when native tree termination is false and retains scratch', async () => {
        mocks.terminateDetachedChildProcess.mockResolvedValueOnce(false);
        const proc = new MockProcess();
        mocks.spawn.mockReturnValueOnce(proc);
        const {tryWritePdfWithNativeImageCombiner} = await import('@electron/image/tryCreatePdfWithNativeImageCombiner');
        const {getUnprovenNativeTerminationDetail} = await import('@electron/utils/nativeTerminationProof');
        const controller = new AbortController();
        const abortError = new Error('Canceled by test');
        abortError.name = 'AbortError';

        const pending = tryWritePdfWithNativeImageCombiner(['/tmp/input.jpg'], '/tmp/output.pdf', {signal: controller.signal});
        await vi.waitFor(() => {
            expect(mocks.spawn).toHaveBeenCalled();
        });
        controller.abort(abortError);

        const error = await pending.catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain('termination was not proven');
        expect(getUnprovenNativeTerminationDetail(error)).toContain('was not proven dead');
        expect(mocks.rm).not.toHaveBeenCalledWith(SCRATCH_DIR, {
            recursive: true,
            force: true,
        });
    });

    it('fails closed when the native child identity is ambiguous', async () => {
        const proc = new MockProcess();
        Object.defineProperty(proc, 'pid', {value: 0});
        mocks.spawn.mockReturnValueOnce(proc);
        const {tryWritePdfWithNativeImageCombiner} = await import('@electron/image/tryCreatePdfWithNativeImageCombiner');
        const {getUnprovenNativeTerminationDetail} = await import('@electron/utils/nativeTerminationProof');
        const controller = new AbortController();

        const pending = tryWritePdfWithNativeImageCombiner(['/tmp/input.jpg'], '/tmp/output.pdf', {signal: controller.signal});
        const result = pending.catch((caught: unknown) => caught);
        await vi.waitFor(() => {
            expect(mocks.spawn).toHaveBeenCalled();
        });
        controller.abort(new Error('Canceled by test'));

        const error = await result;
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain('termination was not proven');
        expect(getUnprovenNativeTerminationDetail(error)).toContain('child identity was not usable');
        expect(mocks.rm).not.toHaveBeenCalledWith(SCRATCH_DIR, {
            recursive: true,
            force: true,
        });
    });

    it('does not let an early close settle a timeout before tree proof', async () => {
        vi.useFakeTimers();
        mocks.terminateDetachedChildProcess.mockResolvedValueOnce(false);
        const proc = new MockProcess();
        mocks.spawn.mockReturnValueOnce(proc);
        const {tryWritePdfWithNativeImageCombiner} = await import('@electron/image/tryCreatePdfWithNativeImageCombiner');
        const {getUnprovenNativeTerminationDetail} = await import('@electron/utils/nativeTerminationProof');

        const pending = tryWritePdfWithNativeImageCombiner(['/tmp/input.jpg'], '/tmp/output.pdf');
        const result = pending.catch((caught: unknown) => caught);
        await vi.waitFor(() => {
            expect(mocks.spawn).toHaveBeenCalled();
        });
        await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
        proc.emit('close', null, 'SIGTERM');

        const error = await result;
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain('termination was not proven');
        expect(getUnprovenNativeTerminationDetail(error)).toContain('was not proven dead');
        expect(mocks.rm).not.toHaveBeenCalledWith(SCRATCH_DIR, {
            recursive: true,
            force: true,
        });
    });

    it('rejects a stdout-limit stop as unproven instead of admitting fallback', async () => {
        mocks.terminateDetachedChildProcess.mockResolvedValueOnce(false);
        const proc = new MockProcess();
        mocks.spawn.mockReturnValueOnce(proc);
        const {tryBuildOptimizedPdfWithNativeImageCombiner} = await import('@electron/image/tryCreatePdfWithNativeImageCombiner');
        const {getUnprovenNativeTerminationDetail} = await import('@electron/utils/nativeTerminationProof');

        const pending = tryBuildOptimizedPdfWithNativeImageCombiner(['/tmp/input.ppm'], 300);
        await vi.waitFor(() => {
            expect(mocks.spawn).toHaveBeenCalled();
        });
        proc.stdout.emit('data', Buffer.alloc(64 * 1024 + 1, 'x'));

        const error = await pending.catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain('termination was not proven');
        expect(getUnprovenNativeTerminationDetail(error)).toContain('was not proven dead');
        expect(mocks.rm).not.toHaveBeenCalledWith(SCRATCH_DIR, {
            recursive: true,
            force: true,
        });
    });

    it('rejects a pending termination proof and cleans only after later proof', async () => {
        vi.useFakeTimers();
        const termination = Promise.withResolvers<boolean>();
        mocks.terminateDetachedChildProcess.mockReturnValueOnce(termination.promise);
        const proc = new MockProcess();
        mocks.spawn.mockReturnValueOnce(proc);
        const {tryWritePdfWithNativeImageCombiner} = await import('@electron/image/tryCreatePdfWithNativeImageCombiner');
        const {getUnprovenNativeTerminationDetail} = await import('@electron/utils/nativeTerminationProof');
        const controller = new AbortController();

        const pending = tryWritePdfWithNativeImageCombiner(['/tmp/input.jpg'], '/tmp/output.pdf', {signal: controller.signal});
        const result = pending.catch((caught: unknown) => caught);
        await vi.waitFor(() => {
            expect(mocks.spawn).toHaveBeenCalled();
        });
        controller.abort(new Error('Canceled by test'));
        await vi.advanceTimersByTimeAsync(3_000);

        const error = await result;
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain('termination was not proven');
        expect(getUnprovenNativeTerminationDetail(error)).toContain('within 3000ms');
        expect(mocks.rm).not.toHaveBeenCalledWith(SCRATCH_DIR, {
            recursive: true,
            force: true,
        });

        termination.resolve(true);
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(0);
        expect(mocks.rm).toHaveBeenCalledTimes(1);
        expect(mocks.rm).toHaveBeenCalledWith(SCRATCH_DIR, {
            recursive: true,
            force: true,
        });
    });

    it('rejects a termination proof that rejects instead of admitting fallback', async () => {
        vi.useFakeTimers();
        mocks.terminateDetachedChildProcess.mockRejectedValueOnce(new Error('termination unavailable'));
        const proc = new MockProcess();
        mocks.spawn.mockReturnValueOnce(proc);
        const {tryBuildOptimizedPdfWithNativeImageCombiner} = await import('@electron/image/tryCreatePdfWithNativeImageCombiner');
        const {getUnprovenNativeTerminationDetail} = await import('@electron/utils/nativeTerminationProof');
        const controller = new AbortController();

        const pending = tryBuildOptimizedPdfWithNativeImageCombiner(['/tmp/input.ppm'], 300, undefined, {signal: controller.signal});
        const result = pending.catch((caught: unknown) => caught);
        await vi.waitFor(() => {
            expect(mocks.spawn).toHaveBeenCalled();
        });
        controller.abort(new Error('Canceled by test'));

        const error = await result;
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain('termination was not proven');
        expect(getUnprovenNativeTerminationDetail(error)).toContain('was not proven dead');
        expect(mocks.rm).not.toHaveBeenCalledWith(SCRATCH_DIR, {
            recursive: true,
            force: true,
        });
    });

    it('validates file-backed native PDF output without reading the whole file into memory', async () => {
        mocks.openData = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n');
        const {tryWritePdfWithNativeImageCombiner} = await import('@electron/image/tryCreatePdfWithNativeImageCombiner');

        await expect(tryWritePdfWithNativeImageCombiner(['/tmp/input.jpg'], '/tmp/output.pdf')).resolves.toBe(true);

        expect(mocks.readFile).not.toHaveBeenCalledWith('/tmp/input.jpg');
        expect(mocks.open).toHaveBeenCalledWith('/tmp/output.pdf', 'r');
    });

    it('allows strict file-backed output above the byte-returning cap', async () => {
        mocks.open.mockImplementation(async (path: string) => {
            const data = path.endsWith('.jpg')
                ? Buffer.from([0xff, 0xd8, 0xff, 0xda])
                : Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n');
            return {
                stat: vi.fn(async () => ({
                    isFile: () => true,
                    size: path.endsWith('.pdf') ? 16 * 1024 * 1024 + 1 : data.byteLength,
                })),
                read: vi.fn(async (buffer: Buffer, offset: number, length: number, position: number) => {
                    data.copy(buffer, offset, Math.min(position, data.byteLength), Math.min(position + length, data.byteLength));
                    if (position > 0) {
                        Buffer.from('%%EOF').copy(buffer, offset + length - 5);
                    }
                    return {
                        bytesRead: length,
                        buffer,
                    };
                }),
                close: vi.fn(async () => undefined),
            };
        });
        const {tryWritePdfWithNativeImageCombiner} = await import('@electron/image/tryCreatePdfWithNativeImageCombiner');

        await expect(
            tryWritePdfWithNativeImageCombiner(['/tmp/input.jpg'], '/tmp/output.pdf', {
                maxOutputBytes: Number.MAX_SAFE_INTEGER,
                outputMode: 'file-backed',
            }),
        ).resolves.toBe(true);

        expect((mocks.spawn.mock.calls.at(-1)![2] as {env: NodeJS.ProcessEnv}).env).toMatchObject({
            EVB_PDF_COMBINE_MAX_OUTPUT_BYTES: String(Number.MAX_SAFE_INTEGER),
            EVB_PDF_COMBINE_OUTPUT_MODE: 'file-backed',
        });
        expect(mocks.readFile).not.toHaveBeenCalled();
    });

    it('rejects oversized native PDF output before reading it into memory', async () => {
        mocks.open.mockImplementation(async (path: string) => {
            const data = path.endsWith('.jpg') ? Buffer.from([0xff, 0xd8, 0xff, 0xda]) : mocks.openData;
            return {
                stat: vi.fn(async () => ({
                    isFile: () => true,
                    size: path.endsWith('.pdf') ? 16 * 1024 * 1024 + 1 : data.byteLength,
                })),
                read: vi.fn(async (buffer: Buffer, offset: number, length: number, position: number) => {
                    data.copy(buffer, offset, position, position + length);
                    return {
                        bytesRead: Math.min(length, Math.max(0, data.byteLength - position)),
                        buffer,
                    };
                }),
                close: vi.fn(async () => undefined),
            };
        });
        const {tryBuildOptimizedPdfWithNativeImageCombiner, tryWritePdfWithNativeImageCombiner} =
            await import('@electron/image/tryCreatePdfWithNativeImageCombiner');

        await expect(tryBuildOptimizedPdfWithNativeImageCombiner(['/tmp/input.ppm'], 300)).rejects.toMatchObject({
            code: 'too-large',
            name: 'SerializableError',
        });
        await expect(tryWritePdfWithNativeImageCombiner(['/tmp/input.png'], '/tmp/output.pdf')).rejects.toMatchObject({
            code: 'too-large',
            name: 'SerializableError',
        });
        expect(mocks.readFile).not.toHaveBeenCalled();
        expect(mocks.rm).toHaveBeenCalledWith('/tmp/output.pdf', {force: true});
    });

    it('charges a single broker lease across wrapped combiner proof sinks from buildOptimizedPdf / estimateSizes', async () => {
        const proc = new MockProcess();
        mocks.spawn.mockReturnValueOnce(proc);
        const {configureMainJobBroker, mainJobBroker} = await import('@electron/resources/jobBroker');
        const {buildOptimizedPdf} = await import('@electron/features/djvu/main/buildOptimizedPdf');
        const {resolvePdfImageCombineResidentBytes} = await import('@electron/native-tools/pdfImageCombineBudget');

        configureMainJobBroker({
            logicalCpus: 4,
            totalRamBytes: 4 * 1024 ** 3,
            safeMode: false,
            detectedTier: 'low',
            performanceMode: 'auto',
            tier: 'low',
        });
        const estimateResources = {
            cpuTokens: 1,
            estimatedResidentBytes: resolvePdfImageCombineResidentBytes(mainJobBroker.getSnapshot().capacity),
            nativeProcesses: 1,
            ioWeight: 2,
        };
        const result = await mainJobBroker.run(
            {
                ownerId: 'djvu-estimate:/tmp/sample.ppm',
                kind: 'djvu-estimate',
                priority: 'user',
                resources: estimateResources,
            },
            async (brokerRun) => {
                const pdfPromise = buildOptimizedPdf(['/tmp/sample.ppm'], 300, undefined, {
                    combineThreads: 1,
                    brokerRun,
                });
                await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
                // Wrapped proof sink in runNativePdfImageCombine must preserve the explicit
                // lease rather than double-charging mainJobBroker with a second leaf lease.
                expect(mainJobBroker.getSnapshot()).toMatchObject({
                    active: 1,
                    queued: 0,
                    used: estimateResources,
                });
                proc.emit('close', 0);
                return pdfPromise;
            },
        );

        expect(result.byteLength).toBeGreaterThan(0);
        expect(mainJobBroker.getSnapshot()).toMatchObject({
            active: 0,
            queued: 0,
        });
    });

    it('retains the owning broker lease through the wrapped identity-bound combiner proof sink on unproven termination', async () => {
        vi.useFakeTimers();
        const proc = new MockProcess();
        mocks.spawn.mockReturnValueOnce(proc);
        const termination = Promise.withResolvers<boolean>();
        mocks.terminateDetachedChildProcess.mockReturnValueOnce(termination.promise);

        const {configureMainJobBroker, mainJobBroker} = await import('@electron/resources/jobBroker');
        const {tryBuildOptimizedPdfWithNativeImageCombiner} = await import('@electron/image/tryCreatePdfWithNativeImageCombiner');

        configureMainJobBroker({
            logicalCpus: 4,
            totalRamBytes: 4 * 1024 ** 3,
            safeMode: false,
            detectedTier: 'low',
            performanceMode: 'auto',
            tier: 'low',
        });
        const controller = new AbortController();
        const resources = {
            cpuTokens: 1,
            estimatedResidentBytes: 512 * 1024 * 1024,
            nativeProcesses: 1,
            ioWeight: 2,
        };
        const runPromise = mainJobBroker
            .run(
                {
                    ownerId: 'djvu-estimate:/tmp/hung.ppm',
                    kind: 'djvu-estimate',
                    priority: 'user',
                    resources,
                },
                async (brokerRun) => {
                    return tryBuildOptimizedPdfWithNativeImageCombiner(['/tmp/hung.ppm'], 300, undefined, {
                        signal: controller.signal,
                        brokerRun,
                    });
                },
            )
            .catch((error: unknown) => error);

        await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
        expect(mainJobBroker.getSnapshot()).toMatchObject({
            active: 1,
            used: resources,
        });

        controller.abort(new DOMException('Canceled', 'AbortError'));
        await vi.advanceTimersByTimeAsync(3_500);
        await expect(runPromise).resolves.toMatchObject({name: 'AbortError'});
        // Lease stays charged (still single charge) until termination proof resolves true.
        expect(mainJobBroker.getSnapshot()).toMatchObject({
            active: 1,
            used: resources,
        });

        termination.resolve(true);
        await vi.waitFor(() =>
            expect(mainJobBroker.getSnapshot()).toMatchObject({
                active: 0,
                used: {nativeProcesses: 0},
            }),
        );
    });

    it('acquires a leaf lease when tryWritePdfWithNativeImageCombiner receives a released brokerRun lease', async () => {
        const proc = new MockProcess();
        mocks.spawn.mockReturnValueOnce(proc);
        const {configureMainJobBroker, mainJobBroker} = await import('@electron/resources/jobBroker');
        const {tryWritePdfWithNativeImageCombiner} = await import('@electron/image/tryCreatePdfWithNativeImageCombiner');

        configureMainJobBroker({
            logicalCpus: 4,
            totalRamBytes: 4 * 1024 ** 3,
            safeMode: false,
            detectedTier: 'low',
            performanceMode: 'auto',
            tier: 'low',
        });
        let releasedBrokerRun: Parameters<Parameters<typeof mainJobBroker.run>[1]>[0] | undefined;
        await mainJobBroker.run(
            {
                ownerId: 'stale-combine',
                kind: 'combine',
                priority: 'user',
                resources: {
                    cpuTokens: 2,
                    estimatedResidentBytes: 512 * 1024 * 1024,
                    nativeProcesses: 1,
                    ioWeight: 2,
                },
            },
            async (brokerRun) => {
                releasedBrokerRun = brokerRun;
            },
        );

        expect(mainJobBroker.isActive(releasedBrokerRun!.lease)).toBe(false);
        const writePromise = tryWritePdfWithNativeImageCombiner(['/tmp/input.png'], '/tmp/output.pdf', {
            brokerRun: releasedBrokerRun!,
        });
        await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
        // broker.isActive(lease) is false, so runNativeCommand acquires a leaf lease.
        expect(mainJobBroker.getSnapshot()).toMatchObject({
            active: 1,
            used: {
                cpuTokens: 1,
                estimatedResidentBytes: 512 * 1024 * 1024,
                nativeProcesses: 1,
                ioWeight: 1,
            },
        });
        proc.emit('close', 0);
        await expect(writePromise).resolves.toBe(true);
        expect(mainJobBroker.getSnapshot().active).toBe(0);
    });

    it('runs dev-build --build-id probe under the owning brokerRun lease without double-charging', async () => {
        const previousBuildIds = (globalThis as Record<string, unknown>).__EVB_NATIVE_BUILD_IDS__;
        (globalThis as Record<string, unknown>).__EVB_NATIVE_BUILD_IDS__ = {
            'evb-pdf-image-combine': 'test-build-id-123',
        };
        try {
            const buildIdProc = new MockProcess();
            const combineProc = new MockProcess();
            mocks.spawn.mockReturnValueOnce(buildIdProc).mockReturnValueOnce(combineProc);
            const {configureMainJobBroker, mainJobBroker} = await import('@electron/resources/jobBroker');
            const {runNativeToolCommand} = await import('@electron/native-tools/runNativeToolCommand');
            configureMainJobBroker({
                logicalCpus: 4,
                totalRamBytes: 4 * 1024 ** 3,
                safeMode: false,
                detectedTier: 'low',
                performanceMode: 'auto',
                tier: 'low',
            });
            const resources = {
                cpuTokens: 1,
                estimatedResidentBytes: 512 * 1024 * 1024,
                nativeProcesses: 1,
                ioWeight: 2,
            };
            await mainJobBroker.run(
                {
                    ownerId: 'dev-build-id-test',
                    kind: 'combine',
                    priority: 'user',
                    resources,
                },
                async (brokerRun) => {
                    const cmd = runNativeToolCommand('/native/evb-pdf-image-combine', ['--output', '/tmp/out.pdf'], {
                        brokerRun,
                    });
                    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledTimes(1));
                    // Uncached --build-id probe must run under the caller's lease (1 active, not 2).
                    expect(mainJobBroker.getSnapshot()).toMatchObject({
                        active: 1,
                        used: resources,
                    });
                    buildIdProc.stdout.emit('data', Buffer.from('test-build-id-123\n'));
                    buildIdProc.emit('close', 0);
                    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledTimes(2));
                    expect(mainJobBroker.getSnapshot()).toMatchObject({
                        active: 1,
                        used: resources,
                    });
                    combineProc.emit('close', 0);
                    await cmd;
                },
            );
            expect(mainJobBroker.getSnapshot().active).toBe(0);
        } finally {
            if (previousBuildIds === undefined) {
                delete (globalThis as Record<string, unknown>).__EVB_NATIVE_BUILD_IDS__;
            } else {
                (globalThis as Record<string, unknown>).__EVB_NATIVE_BUILD_IDS__ = previousBuildIds;
            }
        }
    });

    it('releases the combine lease when a dev --build-id probe terminates cleanly before combiner spawn', async () => {
        vi.useFakeTimers();
        const previousBuildIds = (globalThis as Record<string, unknown>).__EVB_NATIVE_BUILD_IDS__;
        (globalThis as Record<string, unknown>).__EVB_NATIVE_BUILD_IDS__ = {
            'evb-pdf-image-combine': 'test-build-id-timeout',
        };
        try {
            const buildIdProc = new MockProcess();
            mocks.spawn.mockReturnValueOnce(buildIdProc);
            mocks.terminateDetachedChildProcess.mockResolvedValueOnce(true);
            const {configureMainJobBroker, mainJobBroker} = await import('@electron/resources/jobBroker');
            const {tryBuildOptimizedPdfWithNativeImageCombiner} = await import('@electron/image/tryCreatePdfWithNativeImageCombiner');
            configureMainJobBroker({
                logicalCpus: 4,
                totalRamBytes: 4 * 1024 ** 3,
                safeMode: false,
                detectedTier: 'low',
                performanceMode: 'auto',
                tier: 'low',
            });
            const resources = {
                cpuTokens: 1,
                estimatedResidentBytes: 512 * 1024 * 1024,
                nativeProcesses: 1,
                ioWeight: 2,
            };

            const runPromise = mainJobBroker
                .run(
                    {
                        ownerId: 'dev-build-id-timeout',
                        kind: 'djvu-estimate',
                        priority: 'user',
                        resources,
                    },
                    async (brokerRun) => tryBuildOptimizedPdfWithNativeImageCombiner(['/tmp/input.ppm'], 300, undefined, {brokerRun}),
                )
                .catch((error: unknown) => error);

            await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledTimes(1));
            // Advance past DEFAULT_NATIVE_COMMAND_TIMEOUT_MS (15m) so --build-id times out and terminates cleanly.
            await vi.advanceTimersByTimeAsync(15 * 60 * 1_000 + 50);
            const error = await runPromise;
            expect(error).toBeInstanceOf(Error);
            // Proven --build-id termination must NOT be converted to false by the combiner's childPid wrapper.
            expect(mainJobBroker.getSnapshot().active).toBe(0);
        } finally {
            if (previousBuildIds === undefined) {
                delete (globalThis as Record<string, unknown>).__EVB_NATIVE_BUILD_IDS__;
            } else {
                (globalThis as Record<string, unknown>).__EVB_NATIVE_BUILD_IDS__ = previousBuildIds;
            }
        }
    });
});
