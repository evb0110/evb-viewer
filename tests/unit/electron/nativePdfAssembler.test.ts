import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

interface IMockNativeWriteProgress {
    processed: number;
    total: number;
    percent: number;
    elapsedMs: number;
    estimatedRemainingMs: number | null;
}

interface IMockNativeWriteOptions {
    maxPages?: number;
    onProgress?: (progress: IMockNativeWriteProgress) => void;
    signal?: AbortSignal;
}

interface IMockDjvuConvertSuccess {
    success: true;
    outputPath: string;
    fileSize: number;
}

const mocks = vi.hoisted(() => {
    const atomicReplace = vi.fn(async (_sourcePath: string, _targetPath: string) => undefined);
    const copyFile = vi.fn(async () => undefined);
    const makeSiblingTempPath = vi.fn((targetPath: string) => `${targetPath}.tmp`);
    const mkdtemp = vi.fn(async () => '/tmp/native-assembler');
    const readFile = vi.fn(async (path: string, encoding?: string) => {
        if (path.endsWith('.json')) {
            return encoding === 'utf8'
                ? JSON.stringify({
                    bookmarks: [{
                        title: path.includes('/0.json') ? 'First' : 'Second',
                        pageIndex: 0,
                        namedDest: null,
                        bold: false,
                        italic: false,
                        color: null,
                        items: [],
                    }],
                    pageLabels: [{
                        pageIndex: 0,
                        style: 'D',
                        start: 1,
                    }],
                })
                : new Uint8Array();
        }
        return new Uint8Array(path.endsWith('input.pdf') ? [
            1,
            1,
            1,
        ] : [
            8,
            8,
            8,
        ]);
    });
    const rm = vi.fn(async () => undefined);
    const writeFile = vi.fn(async (_path: string, _data: string, _encoding: 'utf8') => undefined);
    const stat = vi.fn(async () => ({size: 3}));
    const statfs = vi.fn(async () => ({
        bavail: 1_000_000,
        bsize: 4096,
    }));
    const runQpdfCommand = vi.fn(async () => undefined);
    const runNativeCommand = vi.fn(async (_command: string, args: string[]) => {
        if (args[0] === 'read-catalog') {
            return undefined;
        }
        return undefined;
    });
    const assertNonEmptyPdfOutput = vi.fn(async () => undefined);
    const getPdfPageCount = vi.fn(async (path: string): Promise<number> => path.includes('/image-chunk-') ? 3 : 1);
    const getDjvuPageCount = vi.fn(async () => 2);
    const nativeWrite = vi.fn(async (
        inputPaths: string[],
        _outputPath: string,
        options?: IMockNativeWriteOptions,
    ) => {
        options?.onProgress?.({
            processed: inputPaths.length,
            total: inputPaths.length,
            percent: 100,
            elapsedMs: 1,
            estimatedRemainingMs: 0,
        });
        return true;
    });
    const convertDjvuToPdfFile = vi.fn(async (
        _inputPath: string,
        _outputPath: string,
        _jobId: string,
        _options?: unknown,
    ): Promise<IMockDjvuConvertSuccess> => ({
        success: true,
        outputPath: '/tmp/native-assembler/djvu-chunk.pdf',
        fileSize: 1024,
    }));
    const cancelConversion = vi.fn(async () => true);
    const warn = vi.fn();

    return {
        atomicReplace,
        copyFile,
        makeSiblingTempPath,
        mkdtemp,
        readFile,
        rm,
        writeFile,
        stat,
        statfs,
        runQpdfCommand,
        runNativeCommand,
        assertNonEmptyPdfOutput,
        getPdfPageCount,
        getDjvuPageCount,
        nativeWrite,
        convertDjvuToPdfFile,
        cancelConversion,
        warn,
    };
});

vi.mock('fs/promises', () => ({
    copyFile: mocks.copyFile,
    mkdtemp: mocks.mkdtemp,
    readFile: mocks.readFile,
    rm: mocks.rm,
    stat: mocks.stat,
    statfs: mocks.statfs,
    writeFile: mocks.writeFile,
}));

vi.mock('@electron/utils/atomicReplace', () => ({
    atomicReplace: (...args: [string, string]) => mocks.atomicReplace(...args),
    makeSiblingTempPath: (...args: [string]) => mocks.makeSiblingTempPath(...args),
}));

vi.mock('@electron/features/page-ops/publicNative', () => ({
    assertNonEmptyPdfOutput: mocks.assertNonEmptyPdfOutput,
    getPdfPageCount: mocks.getPdfPageCount,
    QPDF_OUTPUT_SUCCESS_EXIT_CODES: [
        0,
        3,
    ],
    QPDF_TIMEOUT_MS: 120_000,
    runQpdfCommand: mocks.runQpdfCommand,
}));
vi.mock('@electron/features/page-ops/main/nativePageOpsPath', () => ({resolveNativePageOpsPath: () => process.env.EVB_TEST_NATIVE_PAGE_OPS === '1' ? '/tmp/page-ops' : null}));
vi.mock('@electron/native-tools/runNativeCommand', () => ({runNativeCommand: mocks.runNativeCommand}));
vi.mock('@electron/pdf/nativeToolPaths', () => ({getPdfNativeToolPaths: () => ({qpdf: '/tmp/qpdf'})}));

vi.mock('@electron/features/djvu/public', () => ({
    cancelConversion: mocks.cancelConversion,
    convertDjvuToPdfFile: mocks.convertDjvuToPdfFile,
}));
vi.mock('@electron/djvu/metadata', () => ({getDjvuPageCount: mocks.getDjvuPageCount}));

vi.mock('@electron/image/tryCreatePdfWithNativeImageCombiner', () => ({
    isNativePdfImageCombineBitmapPath: (inputPath: string) => /\.(?:png|jpe?g|tiff?)$/iu.test(inputPath),
    tryWritePdfWithNativeImageCombiner: (
        inputPaths: string[],
        outputPath: string,
        options?: Parameters<typeof mocks.nativeWrite>[2],
    ) => mocks.nativeWrite(inputPaths, outputPath, options),
}));

vi.mock('@electron/utils/createLogger', () => ({createLogger: () => ({
    warn: mocks.warn,
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
})}));

const {
    tryCreatePdfFromInputPathsNative,
    tryWritePdfFromInputPathsNative,
} = await import('@electron/image/tryCreatePdfFromInputPathsNative');

describe('tryCreatePdfFromInputPathsNative', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubEnv('VITEST', 'true');
        mocks.getDjvuPageCount.mockResolvedValue(2);
        mocks.cancelConversion.mockResolvedValue(true);
        mocks.stat.mockImplementation(async () => ({size: 3}));
        mocks.getPdfPageCount.mockImplementation(async (path: string) => path.includes('/tmp/native-assembler/') || path.includes('final.pdf.tmp') ? 3 : 1);
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('is disabled by default in Vitest', async () => {
        const result = await tryCreatePdfFromInputPathsNative(['/tmp/input.pdf']);

        expect(result).toBeNull();
        expect(mocks.mkdtemp).not.toHaveBeenCalled();
        expect(mocks.runQpdfCommand).not.toHaveBeenCalled();
    });

    it('applies read catalogs with page offsets after qpdf merges chunks', async () => {
        vi.stubEnv('EVB_PDF_NATIVE_ASSEMBLER_ENABLE', '1');
        vi.stubEnv('EVB_TEST_NATIVE_PAGE_OPS', '1');
        mocks.getPdfPageCount.mockImplementation(async path => path.endsWith('final.pdf.tmp') ? 2 : 1);

        await expect(tryWritePdfFromInputPathsNative(
            [
                '/tmp/first.pdf',
                '/tmp/second.pdf',
            ],
            '/tmp/final.pdf',
            {failureMode: 'capability-error'},
        )).resolves.toBe(true);

        expect(mocks.runQpdfCommand).toHaveBeenCalledOnce();
        expect(mocks.runNativeCommand).toHaveBeenCalledWith(
            '/tmp/page-ops',
            expect.arrayContaining([
                'save-mutations',
                '--append',
            ]),
            expect.any(Object),
        );
        expect(mocks.writeFile).toHaveBeenCalledWith(
            expect.stringContaining('mutations.json'),
            expect.stringContaining('Second'),
            'utf8',
        );
        const mutationWrite = mocks.writeFile.mock.calls.at(-1);
        if (!mutationWrite) {
            throw new Error('Expected the native assembler mutation file write');
        }
        const mutationJson = mutationWrite[1];
        expect(mutationJson).toContain('"pageIndex":1');
    });

    it('reports native unavailability as a typed error in strict mode', async () => {
        await expect(tryWritePdfFromInputPathsNative(
            ['/tmp/input.pdf'],
            '/tmp/final.pdf',
            {failureMode: 'capability-error'},
        )).rejects.toMatchObject({
            code: 'native-unavailable',
            name: 'PdfCombineCapabilityError',
        });

        expect(mocks.mkdtemp).not.toHaveBeenCalled();
        expect(mocks.runQpdfCommand).not.toHaveBeenCalled();
    });

    it('copies a single native output chunk to the requested output path', async () => {
        vi.stubEnv('EVB_PDF_NATIVE_ASSEMBLER_ENABLE', '1');

        const ok = await tryWritePdfFromInputPathsNative([
            '/tmp/one.png',
            '/tmp/two.jpg',
        ], '/tmp/final.pdf');

        expect(ok).toBe(true);
        expect(mocks.copyFile).toHaveBeenCalledWith(
            expect.stringMatching(/^\/tmp\/native-assembler\/image-chunk-\d+-.+\.pdf$/u),
            '/tmp/final.pdf.tmp',
        );
        expect(mocks.atomicReplace).toHaveBeenCalledWith('/tmp/final.pdf.tmp', '/tmp/final.pdf');
        expect(mocks.runQpdfCommand).not.toHaveBeenCalled();
        expect(mocks.readFile).not.toHaveBeenCalled();
    });

    it('leaves the destination untouched when disk space is insufficient', async () => {
        vi.stubEnv('EVB_PDF_NATIVE_ASSEMBLER_ENABLE', '1');
        mocks.statfs.mockResolvedValueOnce({
            bavail: 1,
            bsize: 1,
        });

        await expect(tryWritePdfFromInputPathsNative(
            ['/tmp/one.png'],
            '/tmp/final.pdf',
        )).rejects.toThrow('Insufficient disk space for PDF combine');

        expect(mocks.nativeWrite).not.toHaveBeenCalled();
        expect(mocks.copyFile).not.toHaveBeenCalled();
        expect(mocks.atomicReplace).not.toHaveBeenCalled();
        expect(mocks.rm).toHaveBeenCalledWith('/tmp/final.pdf.tmp', { force: true });
    });

    it('falls back when the native image writer is unavailable', async () => {
        vi.stubEnv('EVB_PDF_NATIVE_ASSEMBLER_ENABLE', '1');
        mocks.nativeWrite.mockResolvedValueOnce(false);

        const result = await tryCreatePdfFromInputPathsNative(['/tmp/one.png']);

        expect(result).toBeNull();
        expect(mocks.runQpdfCommand).not.toHaveBeenCalled();
        expect(mocks.rm).toHaveBeenCalledWith('/tmp/native-assembler', {
            recursive: true,
            force: true,
        });
    });

    it('returns a typed capability error instead of falling back for strict native jobs', async () => {
        vi.stubEnv('EVB_PDF_NATIVE_ASSEMBLER_ENABLE', '1');
        mocks.nativeWrite.mockResolvedValueOnce(false);

        await expect(tryWritePdfFromInputPathsNative(
            ['/tmp/one.png'],
            '/tmp/final.pdf',
            {failureMode: 'capability-error'},
        )).rejects.toMatchObject({
            code: 'native-unavailable',
            name: 'PdfCombineCapabilityError',
        });
        expect(mocks.nativeWrite).toHaveBeenCalledOnce();
        expect(mocks.atomicReplace).not.toHaveBeenCalled();
        expect(mocks.copyFile).not.toHaveBeenCalled();
    });

    it('assembles PDF and DjVu paths through qpdf in strict file-backed mode', async () => {
        vi.stubEnv('EVB_PDF_NATIVE_ASSEMBLER_ENABLE', '1');
        vi.stubEnv('EVB_TEST_NATIVE_PAGE_OPS', '1');
        mocks.getPdfPageCount.mockImplementation(async (path: string) => path.includes('final.pdf.tmp') ? 2 : 1);

        await expect(tryWritePdfFromInputPathsNative(
            [
                '/tmp/first.pdf',
                '/tmp/second.pdf',
            ],
            '/tmp/final.pdf',
            {failureMode: 'capability-error'},
        )).resolves.toBe(true);

        expect(mocks.runQpdfCommand).toHaveBeenCalledWith(
            expect.arrayContaining([
                '--empty',
                '--pages',
                '/tmp/first.pdf',
                '/tmp/second.pdf',
                '--',
                '/tmp/final.pdf.tmp',
            ]),
            expect.any(Object),
        );
        expect(mocks.copyFile).not.toHaveBeenCalled();
        expect(mocks.atomicReplace).toHaveBeenCalledWith('/tmp/final.pdf.tmp', '/tmp/final.pdf');
    });

    it('returns a typed capability error when qpdf fails in strict mode', async () => {
        vi.stubEnv('EVB_PDF_NATIVE_ASSEMBLER_ENABLE', '1');
        mocks.runQpdfCommand.mockRejectedValueOnce(new Error('qpdf unavailable'));

        await expect(tryWritePdfFromInputPathsNative(
            [
                '/tmp/first.pdf',
                '/tmp/second.pdf',
            ],
            '/tmp/final.pdf',
            {failureMode: 'capability-error'},
        )).rejects.toMatchObject({
            code: 'native-failure',
            name: 'PdfCombineCapabilityError',
        });

        expect(mocks.atomicReplace).not.toHaveBeenCalled();
    });

    it('accepts a strict file-backed PDF page count above ten thousand', async () => {
        vi.stubEnv('EVB_PDF_NATIVE_ASSEMBLER_ENABLE', '1');
        mocks.getPdfPageCount.mockResolvedValue(10_001);

        await expect(tryWritePdfFromInputPathsNative(
            ['/tmp/large.pdf'],
            '/tmp/final.pdf',
            {failureMode: 'capability-error'},
        )).resolves.toBe(true);

        expect(mocks.copyFile).toHaveBeenCalledWith(
            '/tmp/large.pdf',
            '/tmp/final.pdf.tmp',
        );
        expect(mocks.atomicReplace).toHaveBeenCalledWith('/tmp/final.pdf.tmp', '/tmp/final.pdf');
    });

    it('refuses strict file-backed output above the shared output cap', async () => {
        vi.stubEnv('EVB_PDF_NATIVE_ASSEMBLER_ENABLE', '1');
        let statCalls = 0;
        mocks.stat.mockImplementation(async () => {
            statCalls += 1;
            return {size: statCalls === 2 ? (16 * 1024 * 1024) + 1 : 3};
        });
        mocks.getPdfPageCount.mockImplementation(async () => 3);

        await expect(tryWritePdfFromInputPathsNative(
            ['/tmp/one.png'],
            '/tmp/final.pdf',
            {failureMode: 'capability-error'},
        )).rejects.toMatchObject({
            code: 'too-large',
            name: 'SerializableError',
        });

        expect(mocks.atomicReplace).not.toHaveBeenCalled();
    });

    it('does not apply the former 500-page cap to strict file-backed input batches', async () => {
        vi.stubEnv('EVB_PDF_NATIVE_ASSEMBLER_ENABLE', '1');
        const inputPaths = Array.from({length: 501}, (_, index) => `/tmp/page-${index}.png`);
        mocks.getPdfPageCount.mockImplementation(async () => 3);

        await expect(tryWritePdfFromInputPathsNative(
            inputPaths,
            '/tmp/final.pdf',
            {failureMode: 'capability-error'},
        )).resolves.toBe(true);

        expect(mocks.nativeWrite).toHaveBeenCalledWith(
            inputPaths,
            expect.stringMatching(/^\/tmp\/native-assembler\/image-chunk-\d+-.+\.pdf$/u),
            expect.objectContaining({maxPages: Number.MAX_SAFE_INTEGER}),
        );
        expect(mocks.atomicReplace).toHaveBeenCalledWith('/tmp/final.pdf.tmp', '/tmp/final.pdf');
    });

    it('keeps pure image jobs on the native image combiner with exact page counting', async () => {
        vi.stubEnv('EVB_PDF_NATIVE_ASSEMBLER_ENABLE', '1');

        const result = await tryCreatePdfFromInputPathsNative([
            '/tmp/one.png',
            '/tmp/two.jpg',
            '/tmp/three.tiff',
        ]);

        expect(Array.from(result ?? [])).toEqual([
            8,
            8,
            8,
        ]);
        expect(mocks.nativeWrite).toHaveBeenCalledWith([
            '/tmp/one.png',
            '/tmp/two.jpg',
            '/tmp/three.tiff',
        ], expect.stringMatching(/^\/tmp\/native-assembler\/image-chunk-\d+-.+\.pdf$/u), expect.any(Object));
        expect(mocks.getPdfPageCount).toHaveBeenCalled();
        expect(mocks.runQpdfCommand).not.toHaveBeenCalled();
    });

    it('falls back before creating temp files for image formats outside the native assembler boundary', async () => {
        vi.stubEnv('EVB_PDF_NATIVE_ASSEMBLER_ENABLE', '1');

        const result = await tryCreatePdfFromInputPathsNative([
            '/tmp/a.pdf',
            '/tmp/poster.bmp',
        ]);

        expect(result).toBeNull();
        expect(mocks.mkdtemp).not.toHaveBeenCalled();
        expect(mocks.nativeWrite).not.toHaveBeenCalled();
        expect(mocks.runQpdfCommand).not.toHaveBeenCalled();
    });

    it('preserves the shared page cap precheck for pure image native jobs', async () => {
        vi.stubEnv('EVB_PDF_NATIVE_ASSEMBLER_ENABLE', '1');
        vi.stubEnv('EVB_PDF_COMBINE_MAX_PAGES', '2');

        const result = await tryCreatePdfFromInputPathsNative([
            '/tmp/one.png',
            '/tmp/two.jpg',
            '/tmp/three.tiff',
        ]);

        expect(result).toBeNull();
        expect(mocks.nativeWrite).not.toHaveBeenCalled();
        expect(mocks.getPdfPageCount).not.toHaveBeenCalled();
        expect(mocks.warn).toHaveBeenCalledWith(expect.stringContaining('Combined PDF is capped at 2 pages'));
    });

    it('refuses native assembler output above the shared output byte cap', async () => {
        vi.stubEnv('EVB_PDF_NATIVE_ASSEMBLER_ENABLE', '1');
        vi.stubEnv('EVB_PDF_COMBINE_MAX_OUTPUT_MB', '1');
        mocks.stat.mockResolvedValueOnce({size: (1024 * 1024) + 1});

        await expect(tryCreatePdfFromInputPathsNative(['/tmp/one.png']))
            .rejects.toMatchObject({
                code: 'too-large',
                name: 'SerializableError',
            });
        expect(mocks.runQpdfCommand).not.toHaveBeenCalled();
        expect(mocks.readFile).not.toHaveBeenCalled();
    });
});
