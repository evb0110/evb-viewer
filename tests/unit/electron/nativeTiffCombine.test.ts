import type * as TRunNativeToolCommandModule from '@electron/native-tools/runNativeToolCommand';
import {
    mkdtemp,
    readFile,
    rm,
    writeFile,
} from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
    runNativeCommand: vi.fn(),
    atomicReplace: vi.fn(),
    makeSiblingTempPath: vi.fn((targetPath: string) => `${targetPath}.tmp`),
    nativePath: '/mock/evb-pdf-image-combine',
}));

vi.mock('@electron/image/tryCreatePdfWithNativeImageCombiner', () => ({resolveNativePdfImageCombinePath: () => mocks.nativePath}));
vi.mock('@electron/native-tools/runNativeToolCommand', async importOriginal => ({
    ...await importOriginal<typeof TRunNativeToolCommandModule>(),
    runNativeToolCommand: mocks.runNativeCommand,
}));
vi.mock('@electron/utils/createLogger', () => ({createLogger: () => ({
    debug: vi.fn(),
    warn: vi.fn(),
})}));
vi.mock('@electron/utils/atomicReplace', () => ({
    atomicReplace: (...args: unknown[]) => mocks.atomicReplace(...args),
    makeSiblingTempPath: (...args: [string]) => mocks.makeSiblingTempPath(...args),
}));

const { tryCombinePagesWithNativeTiffCombiner } = await import('@electron/features/image-export/main/tryCombinePagesWithNativeTiffCombiner');
const {
    getUnprovenNativeTerminationDetail,
    markUnprovenNativeTermination,
} = await import('@electron/utils/nativeTerminationProof');
const {NativeToolBuildMismatchError} = await import('@electron/native-tools/runNativeToolCommand');
const {createNativeFallbackTestError} = await import('@electron/native-tools/createNativeFallbackTestError');

describe('native TIFF combine wrapper', () => {
    let tempDir = '';

    beforeEach(async () => {
        vi.clearAllMocks();
        process.env.EVB_TIFF_COMBINE_NATIVE_ENABLE = '1';
        tempDir = await mkdtemp(join(tmpdir(), 'native-tiff-combine-test-'));
        mocks.atomicReplace.mockImplementation(async (sourcePath: string, targetPath: string) => {
            await writeFile(targetPath, await readFile(sourcePath));
            await rm(sourcePath, { force: true });
        });
    });

    afterEach(async () => {
        delete process.env.EVB_TIFF_COMBINE_NATIVE_ENABLE;
        if (tempDir) {
            await rm(tempDir, {
                recursive: true,
                force: true,
            });
        }
    });

    it('passes large page lists through an inputs file and atomically promotes native output', async () => {
        const inputPaths = [
            join(tempDir, 'page-001.tif'),
            join(tempDir, 'page-002.tif'),
        ];
        const outputPath = join(tempDir, 'combined.tiff');
        let recordedInputsFile = '';
        let recordedInputs = '';

        mocks.runNativeCommand.mockImplementation(async (binaryPath: string, args: string[]) => {
            expect(binaryPath).toBe('/mock/evb-pdf-image-combine');
            expect(args).toEqual([
                '--output',
                `${outputPath}.tmp`,
                '--format',
                'tiff',
                '--inputs-file',
                expect.any(String),
                '--dpi',
                '300',
            ]);
            recordedInputsFile = args[args.indexOf('--inputs-file') + 1]!;
            expect(args).not.toContain(inputPaths[0]);

            recordedInputs = await readFile(recordedInputsFile, 'utf8');
            const nativeOutputPath = args[args.indexOf('--output') + 1]!;
            await writeFile(nativeOutputPath, Buffer.from('native-tiff'));
            return {
                stdout: '',
                stderr: '',
                exitCode: 0,
            };
        });

        await expect(tryCombinePagesWithNativeTiffCombiner(inputPaths, outputPath, undefined, 300)).resolves.toBe(true);
        await expect(readFile(outputPath, 'utf8')).resolves.toBe('native-tiff');
        expect(recordedInputs).toBe(`${inputPaths.join('\n')}\n`);
        expect(mocks.runNativeCommand).toHaveBeenCalledWith('/mock/evb-pdf-image-combine', expect.any(Array), {
            timeoutMs: 600000,
            commandLabel: 'evb-pdf-image-combine(tiff)',
            maxStdoutBytes: 1024,
            maxStderrBytes: 8192,
            onTerminationProof: expect.any(Function),
        });
        expect(mocks.atomicReplace).toHaveBeenCalledWith(`${outputPath}.tmp`, outputPath);
    });

    it('rejects instead of silently falling back when the command fails in enabled test mode', async () => {
        const inputPaths = [join(tempDir, 'page-001.tif')];
        const outputPath = join(tempDir, 'combined.tiff');
        await writeFile(`${outputPath}.tmp`, 'stale');
        mocks.runNativeCommand.mockRejectedValueOnce(new Error('native failed'));

        await expect(tryCombinePagesWithNativeTiffCombiner(inputPaths, outputPath))
            .rejects.toThrow('Native TIFF combine fallback is not allowed in tests');

        await expect(readFile(`${outputPath}.tmp`, 'utf8')).rejects.toThrow();
        expect(mocks.atomicReplace).not.toHaveBeenCalled();
    });

    it('keeps the pages, inputs and output, and starts no fallback, while the native child may be alive', async () => {
        const inputPaths = [join(tempDir, 'page-001.tif')];
        const outputPath = join(tempDir, 'combined.tiff');
        await writeFile(outputPath, 'existing destination');
        let settleProof!: (proven: boolean) => void;
        let inputsFile = '';
        mocks.runNativeCommand.mockImplementationOnce(async (_binaryPath: string, args: string[], options: {onTerminationProof: (proof: Promise<boolean>) => void;}) => {
            inputsFile = args[args.indexOf('--inputs-file') + 1]!;
            await writeFile(args[args.indexOf('--output') + 1]!, 'partial');
            options.onTerminationProof(new Promise(resolve => {
                settleProof = resolve;
            }));
            throw markUnprovenNativeTermination(new Error('evb-pdf-image-combine timed out'), 'process tree survived its kill');
        });

        const error = await tryCombinePagesWithNativeTiffCombiner(inputPaths, outputPath, undefined, 300)
            .then(() => null, (reason: unknown) => reason);

        // The caller sees the uncertainty instead of a fallback signal.
        expect(getUnprovenNativeTerminationDetail(error)).toBe('process tree survived its kill');
        await expect(readFile(inputsFile, 'utf8')).resolves.toBe(`${inputPaths[0]}\n`);
        await expect(readFile(`${outputPath}.tmp`, 'utf8')).resolves.toBe('partial');
        await expect(readFile(outputPath, 'utf8')).resolves.toBe('existing destination');
        expect(mocks.atomicReplace).not.toHaveBeenCalled();

        settleProof(true);
        await vi.waitFor(async () => {
            await expect(readFile(inputsFile, 'utf8')).rejects.toThrow();
            await expect(readFile(`${outputPath}.tmp`, 'utf8')).rejects.toThrow();
        });
    });

    it('refuses a stale development binary instead of falling back', async () => {
        const inputPaths = [join(tempDir, 'page-001.tif')];
        const outputPath = join(tempDir, 'combined.tiff');
        const stale = new NativeToolBuildMismatchError('evb-pdf-image-combine was built from other native sources');
        mocks.runNativeCommand.mockRejectedValueOnce(stale);

        await expect(tryCombinePagesWithNativeTiffCombiner(inputPaths, outputPath)).rejects.toBe(stale);
        expect(mocks.atomicReplace).not.toHaveBeenCalled();
        // Every native adapter asks this helper before it falls back, in the
        // app as in tests: a stale binary is thrown, any other failure is not.
        expect(createNativeFallbackTestError(false, 'Native TIFF combine', 'failed', stale)).toBe(stale);
        expect(createNativeFallbackTestError(false, 'Native TIFF combine', 'failed', new Error('exit 1'))).toBeNull();
    });

    it('rejects when native output is missing in enabled test mode', async () => {
        const inputPaths = [join(tempDir, 'page-001.tif')];
        const outputPath = join(tempDir, 'combined.tiff');
        mocks.runNativeCommand.mockResolvedValueOnce({
            stdout: '',
            stderr: '',
            exitCode: 0,
        });

        await expect(tryCombinePagesWithNativeTiffCombiner(inputPaths, outputPath))
            .rejects.toThrow('Native TIFF combine fallback is not allowed in tests');

        await expect(readFile(`${outputPath}.tmp`, 'utf8')).rejects.toThrow();
        expect(mocks.atomicReplace).not.toHaveBeenCalled();
    });
});
