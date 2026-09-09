import { EventEmitter } from 'node:events';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => {
    return {
        open: vi.fn(),
        openData: Buffer.from('%PDF-1.7\n%%EOF\n'),
        readFile: vi.fn(),
        rm: vi.fn(async () => undefined),
        spawn: vi.fn(),
        terminateDetachedChildProcess: vi.fn(async () => true),
        verifyNativeToolProtocol: vi.fn(async () => undefined),
        warn: vi.fn(),
        writeFile: vi.fn(async () => undefined),
    };
});

class MockProcess extends EventEmitter {
    readonly pid = 12345;

    readonly stdout = Object.assign(new EventEmitter(), {destroy: vi.fn()});

    readonly stderr = Object.assign(new EventEmitter(), {destroy: vi.fn()});

    readonly kill = vi.fn();
}

vi.mock('child_process', () => ({spawn: mocks.spawn}));
vi.mock('fs/promises', () => ({
    mkdtemp: vi.fn(async () => '/tmp/pdf-image-combine-test'),
    open: mocks.open,
    readFile: mocks.readFile,
    rm: mocks.rm,
    writeFile: mocks.writeFile,
}));
vi.mock('@electron/native-tools/resolveNativeToolPath', () => ({resolveNativeToolPath: () => '/native/evb-pdf-image-combine'}));
vi.mock('@electron/native-tools/runNativeToolCommand', () => ({verifyNativeToolProtocol: mocks.verifyNativeToolProtocol}));
vi.mock('@electron/utils/nativeChildProcess', () => ({
    createDetachedChildProcessSpawnOptions: (options: object) => ({
        ...options,
        detached: true,
    }),
    terminateDetachedChildProcess: mocks.terminateDetachedChildProcess,
}));
vi.mock('@electron/utils/createLogger', () => ({createLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: mocks.warn,
})}));

describe('native PDF image combiner output validation', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        vi.stubEnv('EVB_PDF_IMAGE_COMBINE_ENABLE', '1');
        mocks.openData = Buffer.from('%PDF-1.7\n%%EOF\n');
        mocks.readFile.mockReset();
        mocks.readFile.mockImplementation(async () => Buffer.from(mocks.openData));
        mocks.open.mockImplementation(async (path: string) => {
            const openData = path.endsWith('.jpg')
                ? Buffer.from([
                    0xff,
                    0xd8,
                    0xff,
                    0xda,
                ])
                : mocks.openData;
            return {
                stat: vi.fn(async () => ({
                    isFile: () => true,
                    size: openData.byteLength,
                })),
                read: vi.fn(async (
                    buffer: Buffer,
                    offset: number,
                    length: number,
                    position: number,
                ) => {
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
        const { tryCreatePdfWithNativeImageCombiner } = await import('@electron/image/tryCreatePdfWithNativeImageCombiner');

        await expect(tryCreatePdfWithNativeImageCombiner(['/tmp/input.png']))
            .rejects.toThrow('Native image PDF combine fallback is not allowed in tests');

        expect(mocks.warn).toHaveBeenCalledWith(expect.stringContaining('produced invalid PDF output'));
        expect(mocks.rm).toHaveBeenCalledWith(expect.stringMatching(/^\/tmp\/pdf-image-combine-test\/.+\.pdf$/u), { force: true });
        expect(mocks.rm).toHaveBeenCalledWith('/tmp/pdf-image-combine-test', {
            recursive: true,
            force: true,
        });
    });

    it('rejects successful file-backed native combines when output is malformed in enabled test mode', async () => {
        mocks.openData = Buffer.from('');
        const { tryWritePdfWithNativeImageCombiner } = await import('@electron/image/tryCreatePdfWithNativeImageCombiner');

        await expect(tryWritePdfWithNativeImageCombiner(['/tmp/input.jpg'], '/tmp/output.pdf'))
            .rejects.toThrow('Native image PDF combine fallback is not allowed in tests');

        expect(mocks.rm).toHaveBeenCalledWith('/tmp/output.pdf', { force: true });
    });

    it('rejects when the native process fails in enabled test mode', async () => {
        mocks.spawn.mockImplementationOnce(() => {
            const proc = new MockProcess();
            queueMicrotask(() => {
                proc.emit('close', 1);
            });
            return proc;
        });
        const { tryWritePdfWithNativeImageCombiner } = await import('@electron/image/tryCreatePdfWithNativeImageCombiner');

        await expect(tryWritePdfWithNativeImageCombiner(['/tmp/input.jpg'], '/tmp/output.pdf'))
            .rejects.toThrow('Native image PDF combine fallback is not allowed in tests');

        expect(mocks.rm).toHaveBeenCalledWith('/tmp/output.pdf', { force: true });
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
        const { tryWritePdfWithNativeImageCombiner } = await import('@electron/image/tryCreatePdfWithNativeImageCombiner');
        const controller = new AbortController();

        const pending = tryWritePdfWithNativeImageCombiner(['/tmp/input.jpg'], '/tmp/output.pdf', {signal: controller.signal});
        await vi.waitFor(() => {
            expect(mocks.spawn).toHaveBeenCalled();
        });
        controller.abort(abortError);

        await expect(pending).rejects.toBe(abortError);
        expect(mocks.spawn).toHaveBeenCalledWith('/native/evb-pdf-image-combine', expect.any(Array), expect.objectContaining({detached: true}));
        expect(mocks.terminateDetachedChildProcess).toHaveBeenCalledWith(proc, 1_000);
        expect(mocks.readFile).not.toHaveBeenCalledWith('/tmp/input.jpg');
        expect(mocks.rm).toHaveBeenCalledWith('/tmp/pdf-image-combine-test', {
            recursive: true,
            force: true,
        });
    });

    it('rejects cancellation when native tree termination is false and retains scratch', async () => {
        mocks.terminateDetachedChildProcess.mockResolvedValueOnce(false);
        const proc = new MockProcess();
        mocks.spawn.mockReturnValueOnce(proc);
        const { tryWritePdfWithNativeImageCombiner } = await import('@electron/image/tryCreatePdfWithNativeImageCombiner');
        const { getUnprovenNativeTerminationDetail } = await import('@electron/utils/nativeTerminationProof');
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
        expect(mocks.rm).not.toHaveBeenCalledWith('/tmp/pdf-image-combine-test', {
            recursive: true,
            force: true,
        });
    });

    it('fails closed when the native child identity is ambiguous', async () => {
        const proc = new MockProcess();
        Object.defineProperty(proc, 'pid', {value: 0});
        mocks.spawn.mockReturnValueOnce(proc);
        const { tryWritePdfWithNativeImageCombiner } = await import('@electron/image/tryCreatePdfWithNativeImageCombiner');
        const { getUnprovenNativeTerminationDetail } = await import('@electron/utils/nativeTerminationProof');
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
        expect(mocks.rm).not.toHaveBeenCalledWith('/tmp/pdf-image-combine-test', {
            recursive: true,
            force: true,
        });
    });

    it('does not let an early close settle a timeout before tree proof', async () => {
        vi.useFakeTimers();
        vi.stubEnv('EVB_PDF_IMAGE_COMBINE_TIMEOUT_MS', '10000');
        mocks.terminateDetachedChildProcess.mockResolvedValueOnce(false);
        const proc = new MockProcess();
        mocks.spawn.mockReturnValueOnce(proc);
        const { tryWritePdfWithNativeImageCombiner } = await import('@electron/image/tryCreatePdfWithNativeImageCombiner');
        const { getUnprovenNativeTerminationDetail } = await import('@electron/utils/nativeTerminationProof');

        const pending = tryWritePdfWithNativeImageCombiner(['/tmp/input.jpg'], '/tmp/output.pdf');
        const result = pending.catch((caught: unknown) => caught);
        await vi.waitFor(() => {
            expect(mocks.spawn).toHaveBeenCalled();
        });
        await vi.advanceTimersByTimeAsync(10_000);
        proc.emit('close', null, 'SIGTERM');

        const error = await result;
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain('termination was not proven');
        expect(getUnprovenNativeTerminationDetail(error)).toContain('was not proven dead');
        expect(mocks.rm).not.toHaveBeenCalledWith('/tmp/pdf-image-combine-test', {
            recursive: true,
            force: true,
        });
    });

    it('rejects a stdout-limit stop as unproven instead of admitting fallback', async () => {
        mocks.terminateDetachedChildProcess.mockResolvedValueOnce(false);
        const proc = new MockProcess();
        mocks.spawn.mockReturnValueOnce(proc);
        const { tryCreatePdfWithNativeImageCombiner } = await import('@electron/image/tryCreatePdfWithNativeImageCombiner');
        const { getUnprovenNativeTerminationDetail } = await import('@electron/utils/nativeTerminationProof');

        const pending = tryCreatePdfWithNativeImageCombiner(['/tmp/input.png']);
        await vi.waitFor(() => {
            expect(mocks.spawn).toHaveBeenCalled();
        });
        proc.stdout.emit('data', Buffer.alloc(64 * 1024 + 1, 'x'));

        const error = await pending.catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain('termination was not proven');
        expect(getUnprovenNativeTerminationDetail(error)).toContain('was not proven dead');
        expect(mocks.rm).not.toHaveBeenCalledWith('/tmp/pdf-image-combine-test', {
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
        const { tryWritePdfWithNativeImageCombiner } = await import('@electron/image/tryCreatePdfWithNativeImageCombiner');
        const { getUnprovenNativeTerminationDetail } = await import('@electron/utils/nativeTerminationProof');
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
        expect(mocks.rm).not.toHaveBeenCalledWith('/tmp/pdf-image-combine-test', {
            recursive: true,
            force: true,
        });

        termination.resolve(true);
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(0);
        expect(mocks.rm).toHaveBeenCalledTimes(1);
        expect(mocks.rm).toHaveBeenCalledWith('/tmp/pdf-image-combine-test', {
            recursive: true,
            force: true,
        });
    });

    it('rejects a termination proof that rejects instead of admitting fallback', async () => {
        vi.useFakeTimers();
        mocks.terminateDetachedChildProcess.mockRejectedValueOnce(new Error('termination unavailable'));
        const proc = new MockProcess();
        mocks.spawn.mockReturnValueOnce(proc);
        const { tryCreatePdfWithNativeImageCombiner } = await import('@electron/image/tryCreatePdfWithNativeImageCombiner');
        const { getUnprovenNativeTerminationDetail } = await import('@electron/utils/nativeTerminationProof');
        const controller = new AbortController();

        const pending = tryCreatePdfWithNativeImageCombiner(['/tmp/input.png'], {signal: controller.signal});
        const result = pending.catch((caught: unknown) => caught);
        await vi.waitFor(() => {
            expect(mocks.spawn).toHaveBeenCalled();
        });
        controller.abort(new Error('Canceled by test'));

        const error = await result;
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain('termination was not proven');
        expect(getUnprovenNativeTerminationDetail(error)).toContain('was not proven dead');
        expect(mocks.rm).not.toHaveBeenCalledWith('/tmp/pdf-image-combine-test', {
            recursive: true,
            force: true,
        });
    });

    it('accepts structurally plausible native PDF output', async () => {
        const validPdf = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n');
        mocks.openData = validPdf;
        mocks.readFile.mockResolvedValueOnce(validPdf);
        const { tryCreatePdfWithNativeImageCombiner } = await import('@electron/image/tryCreatePdfWithNativeImageCombiner');

        await expect(tryCreatePdfWithNativeImageCombiner(['/tmp/input.png'])).resolves.toEqual(new Uint8Array(validPdf));
        expect(mocks.verifyNativeToolProtocol).toHaveBeenCalledWith('/native/evb-pdf-image-combine', {env: expect.objectContaining({EVB_PDF_COMBINE_MAX_OUTPUT_BYTES: String(16 * 1024 * 1024)})});
        expect(mocks.verifyNativeToolProtocol.mock.invocationCallOrder[0]!)
            .toBeLessThan(mocks.spawn.mock.invocationCallOrder[0]!);
    });

    it('validates file-backed native PDF output without reading the whole file into memory', async () => {
        mocks.openData = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n');
        const { tryWritePdfWithNativeImageCombiner } = await import('@electron/image/tryCreatePdfWithNativeImageCombiner');

        await expect(tryWritePdfWithNativeImageCombiner(['/tmp/input.jpg'], '/tmp/output.pdf')).resolves.toBe(true);

        expect(mocks.readFile).not.toHaveBeenCalledWith('/tmp/input.jpg');
        expect(mocks.open).toHaveBeenCalledWith('/tmp/output.pdf', 'r');
    });

    it('rejects oversized native PDF output before reading it into memory', async () => {
        mocks.open.mockImplementation(async (path: string) => {
            const data = path.endsWith('.jpg')
                ? Buffer.from([
                    0xff,
                    0xd8,
                    0xff,
                    0xda,
                ])
                : mocks.openData;
            return {
                stat: vi.fn(async () => ({
                    isFile: () => true,
                    size: path.endsWith('.pdf') ? (16 * 1024 * 1024) + 1 : data.byteLength,
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
        const {
            tryCreatePdfWithNativeImageCombiner,
            tryWritePdfWithNativeImageCombiner,
        } = await import('@electron/image/tryCreatePdfWithNativeImageCombiner');

        await expect(tryCreatePdfWithNativeImageCombiner(['/tmp/input.png']))
            .rejects.toMatchObject({
                code: 'too-large',
                name: 'SerializableError',
            });
        await expect(tryWritePdfWithNativeImageCombiner(['/tmp/input.png'], '/tmp/output.pdf'))
            .rejects.toMatchObject({
                code: 'too-large',
                name: 'SerializableError',
            });
        expect(mocks.readFile).not.toHaveBeenCalled();
        expect(mocks.rm).toHaveBeenCalledWith('/tmp/output.pdf', { force: true });
    });

    it('rejects before spawning when protocol verification fails', async () => {
        mocks.verifyNativeToolProtocol.mockRejectedValueOnce(new Error('expected 1, got 99'));
        const { tryCreatePdfWithNativeImageCombiner } = await import('@electron/image/tryCreatePdfWithNativeImageCombiner');

        await expect(tryCreatePdfWithNativeImageCombiner(['/tmp/input.png'])).rejects.toThrow('expected 1, got 99');
        expect(mocks.spawn).not.toHaveBeenCalled();
    });
});
