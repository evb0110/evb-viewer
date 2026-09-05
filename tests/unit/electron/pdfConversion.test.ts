import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type * as PdfLibModule from 'pdf-lib';
import type * as PdfCoreModule from '@pdf-core';
import type * as DjvuPublicModule from '@electron/features/djvu/public';
import { PdfCombineCapabilityError } from '@electron/image/pdfCombineErrors';

interface IMockDjvuConvertSuccess {
    success: true;
    outputPath: string;
    fileSize: number;
}

const SMALL_INPUT_LIMIT_BYTES = 16 * 1024 * 1024;

const mocks = vi.hoisted(() => {
    const workerState: { mode: 'hang' | 'runtime-error' | 'startup-error' | 'success' } = { mode: 'startup-error' };
    const workerCtor = vi.fn();
    const workerTerminate = vi.fn();
    const loggerWarn = vi.fn();
    const atomicReplace = vi.fn(async () => undefined);
    const makeSiblingTempPath = vi.fn(() => '/tmp/.staged-output.tmp');
    const readFile = vi.fn(async () => new Uint8Array([
        1,
        2,
        3,
    ]));
    const writeFile = vi.fn(async () => undefined);
    const mkdtemp = vi.fn(async () => '/tmp/pdf-combine-djvu-test');
    const rm = vi.fn(async () => undefined);
    const stat = vi.fn(async () => ({
        isFile: () => true,
        size: 1024,
    }));
    const nativeAssembler = vi.fn(async (
        _inputPaths: string[],
        _options?: unknown,
    ) => null as Uint8Array | null);
    const nativeFileAssembler = vi.fn(async (
        _inputPaths: string[],
        _outputPath: string,
        _options?: unknown,
    ) => false);
    const getDjvuPageCount = vi.fn(async () => 2);
    const buildCompactDjvuAwarePdfFromDjvu = vi.fn(async (
        _options: { jobId: string },
    ): Promise<IMockDjvuConvertSuccess> => ({
        success: true,
        outputPath: '/tmp/pdf-combine-djvu-test/output.pdf',
        fileSize: 1024,
    }));
    const cancelConversion = vi.fn(async () => true);

    const addPage = vi.fn();
    const copyPages = vi.fn(async () => [{}]);
    const save = vi.fn(async () => new Uint8Array([
        9,
        9,
        9,
    ]));
    const create = vi.fn(async () => ({
        addPage,
        copyPages,
        save,
        embedPng: vi.fn(),
        embedJpg: vi.fn(),
    }));
    const load = vi.fn(async () => ({ getPageIndices: () => [0] }));

    return {
        workerState,
        workerCtor,
        workerTerminate,
        loggerWarn,
        atomicReplace,
        makeSiblingTempPath,
        readFile,
        writeFile,
        mkdtemp,
        rm,
        stat,
        nativeAssembler,
        nativeFileAssembler,
        getDjvuPageCount,
        buildCompactDjvuAwarePdfFromDjvu,
        cancelConversion,
        create,
        load,
    };
});

vi.mock('worker_threads', () => ({Worker: class {
    private readonly onceHandlers = new Map<string, Set<(arg: unknown) => void>>();

    private readonly onHandlers = new Map<string, Set<(arg: unknown) => void>>();

    constructor(script: string, options: unknown) {
        mocks.workerCtor(script, options);
        queueMicrotask(() => {
            switch (mocks.workerState.mode) {
                case 'startup-error':
                    this.emit('error', new Error('Cannot find package pdf-lib from [eval1]'));
                    return;
                case 'runtime-error':
                    this.emit('online', undefined);
                    this.emit('error', new Error('worker ran out of memory'));
                    return;
                case 'success':
                    this.emit('online', undefined);
                    this.emit('message', {
                        type: 'result',
                        ok: true,
                        data: new Uint8Array([
                            7,
                            7,
                        ]),
                    });
                    return;
                case 'hang':
                    this.emit('online', undefined);
                    return;
                default:
                    return;
            }
        });
    }

    on(event: string, callback: (arg: unknown) => void) {
        const handlers = this.onHandlers.get(event) ?? new Set();
        handlers.add(callback);
        this.onHandlers.set(event, handlers);
        return this;
    }

    once(event: string, callback: (arg: unknown) => void) {
        const handlers = this.onceHandlers.get(event) ?? new Set();
        handlers.add(callback);
        this.onceHandlers.set(event, handlers);
        return this;
    }

    removeAllListeners(event?: string) {
        if (event) {
            this.onceHandlers.delete(event);
            this.onHandlers.delete(event);
            return this;
        }

        this.onceHandlers.clear();
        this.onHandlers.clear();
        return this;
    }

    removeListener(event: string, callback: (arg: unknown) => void) {
        this.onceHandlers.get(event)?.delete(callback);
        this.onHandlers.get(event)?.delete(callback);
        return this;
    }

    terminate() {
        mocks.workerTerminate();
        return Promise.resolve(0);
    }

    private emit(event: string, payload: unknown) {
        const onHandlers = [...(this.onHandlers.get(event) ?? [])];
        for (const handler of onHandlers) {
            handler(payload);
        }

        const onceHandlers = [...(this.onceHandlers.get(event) ?? [])];
        this.onceHandlers.delete(event);
        for (const handler of onceHandlers) {
            handler(payload);
        }
    }
}}));

vi.mock('fs/promises', () => ({
    mkdtemp: mocks.mkdtemp,
    readFile: mocks.readFile,
    rm: mocks.rm,
    stat: mocks.stat,
    writeFile: mocks.writeFile,
}));

vi.mock('pdf-lib', async (importOriginal) => ({
    ...await importOriginal<typeof PdfLibModule>(),
    PDFDocument: {
        create: mocks.create,
        load: mocks.load,
    },
}));
vi.mock('@pdf-core', async (importOriginal) => ({
    ...await importOriginal<typeof PdfCoreModule>(),
    writePdfBookmarkOutlines: vi.fn(() => true),
}));

vi.mock('electron', () => ({
    app: {isPackaged: false},
    nativeImage: {createFromPath: vi.fn(() => ({
        isEmpty: () => true,
        toPNG: () => new Uint8Array(),
    }))},
}));

vi.mock('@electron/utils/createLogger', () => ({createLogger: () => ({
    warn: mocks.loggerWarn,
    error: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
})}));

vi.mock('@electron/utils/atomicReplace', () => ({
    atomicReplace: mocks.atomicReplace,
    makeSiblingTempPath: mocks.makeSiblingTempPath,
}));

vi.mock('@electron/features/djvu/main/ddjvuConversion', () => ({cancelConversion: mocks.cancelConversion}));
vi.mock('@electron/features/djvu/main/pagePreview', () => ({getDjvuPageSizesForViewing: vi.fn(async () => [
    {
        width: 1200,
        height: 1600,
        dpi: 300,
    },
    {
        width: 1200,
        height: 1600,
        dpi: 300,
    },
])}));
vi.mock('@electron/features/djvu/public', async (importOriginal) => ({
    ...await importOriginal<typeof DjvuPublicModule>(),
    buildCompactDjvuAwarePdfFromDjvu: mocks.buildCompactDjvuAwarePdfFromDjvu,
}));
vi.mock('@electron/djvu/metadata', () => ({
    getDjvuPageCount: mocks.getDjvuPageCount,
    getDjvuOutline: vi.fn(async () => ''),
    getDjvuResolution: vi.fn(async () => 300),
}));

vi.mock('@electron/image/tryCreatePdfFromInputPathsNative', () => ({
    tryCreatePdfFromInputPathsNative: (
        inputPaths: string[],
        options?: unknown,
    ) => mocks.nativeAssembler(inputPaths, options),
    tryWritePdfFromInputPathsNative: (
        inputPaths: string[],
        outputPath: string,
        options?: unknown,
    ) => mocks.nativeFileAssembler(inputPaths, outputPath, options),
}));

const {
    createPdfFileFromInputPaths,
    createPdfFromInputPaths,
} =
    await import('@electron/image/pdfConversion');

describe('createPdfFromInputPaths worker fallback', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.workerState.mode = 'startup-error';
        mocks.mkdtemp.mockResolvedValue('/tmp/pdf-combine-djvu-test');
        mocks.rm.mockResolvedValue(undefined);
        mocks.atomicReplace.mockResolvedValue(undefined);
        mocks.makeSiblingTempPath.mockReturnValue('/tmp/.staged-output.tmp');
        mocks.buildCompactDjvuAwarePdfFromDjvu.mockResolvedValue({
            success: true,
            outputPath: '/tmp/pdf-combine-djvu-test/output.pdf',
            fileSize: 1024,
        });
        mocks.getDjvuPageCount.mockResolvedValue(2);
        mocks.stat.mockResolvedValue({
            isFile: () => true,
            size: 1024,
        });
        mocks.nativeAssembler.mockResolvedValue(null);
        mocks.nativeFileAssembler.mockResolvedValue(false);
        mocks.cancelConversion.mockResolvedValue(true);
    });

    it('uses the native assembler before spawning the pdf-lib worker for mixed PDF and image inputs', async () => {
        const progress = vi.fn();
        const nativeBytes = new Uint8Array([
            6,
            6,
            6,
        ]);
        mocks.nativeAssembler.mockResolvedValueOnce(nativeBytes);

        const inputPaths = [
            '/tmp/input.pdf',
            '/tmp/photo.png',
            '/tmp/photo.jpg',
            '/tmp/scan.tiff',
        ];
        const result = await createPdfFromInputPaths(inputPaths, {onProgress: progress});

        expect(result).toBe(nativeBytes);
        expect(mocks.nativeAssembler).toHaveBeenCalledWith(inputPaths, {onProgress: progress});
        expect(mocks.workerCtor).not.toHaveBeenCalled();
        expect(mocks.create).not.toHaveBeenCalled();
        expect(mocks.load).not.toHaveBeenCalled();
    });

    it('writes oversized native-supported batches through the file-backed native assembler', async () => {
        const progress = vi.fn();
        mocks.stat.mockResolvedValue({
            isFile: () => true,
            size: 4 * 1024 * 1024 * 1024,
        });
        mocks.nativeFileAssembler.mockResolvedValueOnce(true);

        const result = await createPdfFileFromInputPaths(
            ['/tmp/huge.tiff'],
            '/tmp/output.pdf',
            {onProgress: progress},
        );

        expect(result).toBe('/tmp/output.pdf');
        expect(mocks.nativeFileAssembler).toHaveBeenCalledWith(
            ['/tmp/huge.tiff'],
            '/tmp/output.pdf',
            {
                onProgress: progress,
                failureMode: 'capability-error',
            },
        );
        expect(mocks.nativeAssembler).not.toHaveBeenCalled();
        expect(mocks.workerCtor).not.toHaveBeenCalled();
        expect(mocks.create).not.toHaveBeenCalled();
        expect(mocks.writeFile).not.toHaveBeenCalled();
    });

    it('does not refuse a file-backed batch when the former total-input cap is exceeded', async () => {
        mocks.stat.mockResolvedValue({
            isFile: () => true,
            size: 600 * 1024 * 1024,
        });
        mocks.nativeFileAssembler.mockResolvedValueOnce(true);

        await expect(createPdfFileFromInputPaths([
            '/tmp/first.pdf',
            '/tmp/second.pdf',
        ], '/tmp/output.pdf')).resolves.toBe('/tmp/output.pdf');

        expect(mocks.nativeFileAssembler).toHaveBeenCalledWith(
            [
                '/tmp/first.pdf',
                '/tmp/second.pdf',
            ],
            '/tmp/output.pdf',
            {failureMode: 'capability-error'},
        );
        expect(mocks.workerCtor).not.toHaveBeenCalled();
        expect(mocks.create).not.toHaveBeenCalled();
    });

    it('does not fall back to memory combine when oversized file-backed native combine fails', async () => {
        mocks.stat.mockResolvedValue({
            isFile: () => true,
            size: 4 * 1024 * 1024 * 1024,
        });
        mocks.nativeFileAssembler.mockResolvedValueOnce(false);

        await expect(createPdfFileFromInputPaths(['/tmp/huge.tiff'], '/tmp/output.pdf'))
            .rejects
            .toBeInstanceOf(PdfCombineCapabilityError);

        expect(mocks.nativeAssembler).not.toHaveBeenCalled();
        expect(mocks.workerCtor).not.toHaveBeenCalled();
        expect(mocks.create).not.toHaveBeenCalled();
        expect(mocks.writeFile).not.toHaveBeenCalled();
    });

    it('routes file-backed inputs just above the small-input classifier to native combine', async () => {
        mocks.stat.mockResolvedValue({
            isFile: () => true,
            size: SMALL_INPUT_LIMIT_BYTES + 1,
        });
        mocks.nativeFileAssembler.mockResolvedValueOnce(true);

        await expect(createPdfFileFromInputPaths(['/tmp/just-over-limit.pdf'], '/tmp/output.pdf'))
            .resolves.toBe('/tmp/output.pdf');

        expect(mocks.nativeFileAssembler).toHaveBeenCalledWith(
            ['/tmp/just-over-limit.pdf'],
            '/tmp/output.pdf',
            {failureMode: 'capability-error'},
        );
        expect(mocks.readFile).not.toHaveBeenCalled();
        expect(mocks.load).not.toHaveBeenCalled();
        expect(mocks.workerCtor).not.toHaveBeenCalled();
        expect(mocks.create).not.toHaveBeenCalled();
    });

    it('keeps tiny file-backed jobs native-only', async () => {
        mocks.nativeFileAssembler.mockResolvedValueOnce(true);

        const result = await createPdfFileFromInputPaths(['/tmp/input.pdf'], '/tmp/output.pdf');

        expect(result).toBe('/tmp/output.pdf');
        expect(mocks.nativeFileAssembler).toHaveBeenCalledWith(
            ['/tmp/input.pdf'],
            '/tmp/output.pdf',
            {failureMode: 'capability-error'},
        );
        expect(mocks.nativeAssembler).not.toHaveBeenCalled();
        expect(mocks.workerCtor).not.toHaveBeenCalled();
        expect(mocks.create).not.toHaveBeenCalled();
        expect(mocks.load).not.toHaveBeenCalled();
        expect(mocks.readFile).not.toHaveBeenCalled();
        expect(mocks.writeFile).not.toHaveBeenCalled();
    });

    it('does not fall back to in-process conversion after runtime worker failure', async () => {
        mocks.workerState.mode = 'runtime-error';

        await expect(createPdfFromInputPaths(['/tmp/input.pdf']))
            .rejects
            .toThrow('worker ran out of memory');

        expect(mocks.workerCtor).toHaveBeenCalledTimes(1);
        expect(mocks.create).not.toHaveBeenCalled();
        expect(mocks.load).not.toHaveBeenCalled();
        expect(mocks.loggerWarn).toHaveBeenCalledTimes(1);
    });

    it('returns worker result when worker combine succeeds', async () => {
        mocks.workerState.mode = 'success';

        const result = await createPdfFromInputPaths(['/tmp/input.pdf']);

        expect(Array.from(result)).toEqual([
            7,
            7,
        ]);
        expect(mocks.workerCtor).toHaveBeenCalledTimes(1);
        expect(mocks.create).not.toHaveBeenCalled();
        expect(mocks.loggerWarn).not.toHaveBeenCalled();
    });

    it('terminates the worker combine path when the supplied signal aborts', async () => {
        mocks.workerState.mode = 'hang';
        const controller = new AbortController();

        const combinePromise = createPdfFromInputPaths(['/tmp/input.pdf'], {signal: controller.signal});
        for (let attempt = 0; attempt < 5 && mocks.workerCtor.mock.calls.length === 0; attempt += 1) {
            await Promise.resolve();
        }
        expect(mocks.workerCtor).toHaveBeenCalledOnce();

        controller.abort(new Error('page insert canceled'));

        await expect(combinePromise).rejects.toThrow('page insert canceled');
        expect(mocks.workerTerminate).toHaveBeenCalledOnce();
    });

    it('returns a typed capability error just above the classifier without a byte-returning fallback', async () => {
        mocks.stat.mockResolvedValue({
            isFile: () => true,
            size: SMALL_INPUT_LIMIT_BYTES + 1,
        });

        await expect(createPdfFromInputPaths(['/tmp/input.pdf']))
            .rejects
            .toMatchObject({
                code: 'native-failure',
                name: 'PdfCombineCapabilityError',
            });

        expect(mocks.nativeAssembler).not.toHaveBeenCalled();
        expect(mocks.workerCtor).not.toHaveBeenCalled();
        expect(mocks.create).not.toHaveBeenCalled();
        expect(mocks.load).not.toHaveBeenCalled();
        expect(mocks.readFile).not.toHaveBeenCalled();
        expect(mocks.writeFile).not.toHaveBeenCalled();
    });

    it('keeps worker combine path for worker-safe image inputs', async () => {
        mocks.workerState.mode = 'success';

        const inputPaths = [
            '/tmp/input.png',
            '/tmp/input.jpg',
            '/tmp/input.tiff',
        ];
        const result = await createPdfFromInputPaths(inputPaths);

        expect(Array.from(result)).toEqual([
            7,
            7,
        ]);
        expect(mocks.workerCtor).toHaveBeenCalledTimes(1);
        const workerOptions = mocks.workerCtor.mock.calls[0]?.[1] as {workerData?: { inputPaths?: string[] };};
        expect(workerOptions.workerData?.inputPaths).toEqual(inputPaths);
        expect(mocks.create).not.toHaveBeenCalled();
        expect(mocks.loggerWarn).not.toHaveBeenCalled();
    });

    it('rejects generated DjVu PDFs above the small-input classifier before reading them into pdf-lib', async () => {
        mocks.stat
            .mockResolvedValueOnce({
                isFile: () => true,
                size: 1024,
            })
            .mockResolvedValueOnce({
                isFile: () => true,
                size: SMALL_INPUT_LIMIT_BYTES + 1,
            });

        await expect(createPdfFromInputPaths(['/tmp/scan.djvu']))
            .rejects
            .toMatchObject({
                code: 'native-failure',
                name: 'PdfCombineCapabilityError',
            });

        expect(mocks.readFile).not.toHaveBeenCalled();
        expect(mocks.load).not.toHaveBeenCalled();
    });
});
