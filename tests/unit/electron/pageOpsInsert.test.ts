import type * as TViMockOriginalModule from '@electron/pdf/nativeToolPaths';

import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    mkdtemp,
    readFile,
    rm,
    stat,
    truncate,
    writeFile,
} from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type * as NodeCrypto from 'node:crypto';
import type { TOpenPath } from '@electron/file-access/openPathCapabilities';
import { PdfCombineCapabilityError } from '@electron/image/pdfCombineErrors';

const randomUuidMock = vi.hoisted(() => vi.fn(() => 'fixed-output-id'));
const runNativeToolCommandMock = vi.hoisted(() => vi.fn());
const ensureWorkingCopyDirectoryMock = vi.hoisted(() => vi.fn());
const createPdfFileFromInputPathsMock = vi.hoisted(() => vi.fn());
const createPdfFromInputPathsMock = vi.hoisted(() => vi.fn());

interface IInsertRunCommandOptionsExpectation { allowedExitCodes?: number[] }

async function readQpdfArgFile(args: string[]) {
    const argFile = args[0];
    if (!argFile?.startsWith('@')) {
        throw new Error(`Expected qpdf arg file invocation, got ${JSON.stringify(args)}`);
    }

    return (await readFile(argFile.slice(1), 'utf8')).split('\n');
}

async function runTinyPdfSourceBatchInsertion(sourceCount: number) {
    const workDir = await mkdtemp(join(tmpdir(), 'page-ops-insert-'));
    const workingCopyPath = join(workDir, 'work.pdf');
    const sourcePath = join(workDir, 'source.pdf');
    const tempSourcePdfPath = join(workDir, 'insert-source-fixed-output-id.pdf');
    const tempOutputPath = join(workDir, 'tmp-fixed-output-id.pdf');
    const sourcePaths = Array.from({length: sourceCount}, () => sourcePath as TOpenPath);

    try {
        await writeFile(workingCopyPath, '%PDF-1.7\noriginal');
        await writeFile(sourcePath, '%PDF-1.7\nsource');
        createPdfFileFromInputPathsMock.mockImplementationOnce(async (
            _sourcePaths: TOpenPath[],
            outputPath: string,
        ) => {
            await writeFile(outputPath, '%PDF-1.7\nnative-merged');
        });
        runNativeToolCommandMock.mockResolvedValueOnce({
            exitCode: 0,
            stdout: '2\n',
            stderr: '',
        });
        runNativeToolCommandMock.mockImplementationOnce(async (_qpdf, args: string[]) => {
            const qpdfArgs = await readQpdfArgFile(args);
            expect(qpdfArgs).toEqual([
                workingCopyPath,
                '--pages',
                workingCopyPath,
                '1-1',
                tempSourcePdfPath,
                '1-z',
                workingCopyPath,
                '2-2',
                '--',
                tempOutputPath,
            ]);
            await writeFile(tempOutputPath, '%PDF-1.7\ninserted');
            return {
                exitCode: 0,
                stdout: '',
                stderr: '',
            };
        });

        const { insertPagesFromSourcePaths } = await import('@electron/features/page-ops/main/insertPagesFromSourcePaths.service');

        await insertPagesFromSourcePaths(workingCopyPath, 2, sourcePaths, 1);

        await expect(readFile(workingCopyPath, 'utf8')).resolves.toBe('%PDF-1.7\ninserted');
        return sourcePaths;
    } finally {
        await rm(workDir, {
            recursive: true,
            force: true,
        });
    }
}

vi.mock('node:crypto', async (importOriginal) => {
    const actual = await importOriginal<typeof NodeCrypto>();
    return {
        ...actual,
        randomUUID: () => randomUuidMock(),
    };
});
vi.mock('@electron/native-tools/runNativeToolCommand', () => ({runNativeToolCommand: (...args: unknown[]) => runNativeToolCommandMock(...args)}));
vi.mock('@electron/pdf/nativeToolPaths', async (importOriginal_1) => ({
    ...(await importOriginal_1<typeof TViMockOriginalModule>()),
    getPdfNativeToolPaths: () => ({ qpdf: '/mock/qpdf' }),
}));
vi.mock('@electron/file-access/workingCopyCreation', () => ({ensureWorkingCopyDirectory: (...args: unknown[]) => ensureWorkingCopyDirectoryMock(...args)}));
vi.mock('@electron/utils/createLogger', () => ({createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
})}));
vi.mock('@electron/image/pdfConversion', () => ({
    createPdfFileFromInputPaths: (...args: unknown[]) => createPdfFileFromInputPathsMock(...args),
    createPdfFromInputPaths: (...args: unknown[]) => createPdfFromInputPathsMock(...args),
    isPdfOrImagePath: (path: string) => /\.(?:pdf|png|jpe?g|webp)$/i.test(path),
}));

describe('page-ops insert service', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        randomUuidMock.mockReturnValue('fixed-output-id');
        ensureWorkingCopyDirectoryMock.mockResolvedValue(true);
        createPdfFileFromInputPathsMock.mockResolvedValue(undefined);
        createPdfFromInputPathsMock.mockResolvedValue(Buffer.from('%PDF-1.7\nmerged'));
    });

    it('accepts qpdf warning-only insertion when a non-empty PDF was written', async () => {
        const workDir = await mkdtemp(join(tmpdir(), 'page-ops-insert-'));
        const workingCopyPath = join(workDir, 'work.pdf');
        const sourcePath = join(workDir, 'source.pdf');
        const tempOutputPath = join(workDir, 'tmp-fixed-output-id.pdf');

        try {
            await writeFile(workingCopyPath, '%PDF-1.7\noriginal');
            await writeFile(sourcePath, '%PDF-1.7\nsource');
            runNativeToolCommandMock.mockResolvedValueOnce({
                exitCode: 0,
                stdout: '2\n',
                stderr: '',
            });
            runNativeToolCommandMock.mockImplementationOnce(async (
                _qpdf,
                args: string[],
                options: IInsertRunCommandOptionsExpectation,
            ) => {
                const qpdfArgs = await readQpdfArgFile(args);
                expect(qpdfArgs).toEqual([
                    workingCopyPath,
                    '--pages',
                    workingCopyPath,
                    '1-1',
                    sourcePath,
                    '1-z',
                    workingCopyPath,
                    '2-2',
                    '--',
                    tempOutputPath,
                ]);
                expect(options.allowedExitCodes).toEqual([
                    0,
                    3,
                ]);
                await writeFile(tempOutputPath, '%PDF-1.7\ninserted');
                return {
                    exitCode: 3,
                    stdout: '',
                    stderr: 'WARNING: repaired object stream\nqpdf: operation succeeded with warnings',
                };
            });

            const { insertPagesFromSourcePaths } = await import('@electron/features/page-ops/main/insertPagesFromSourcePaths.service');

            await insertPagesFromSourcePaths(workingCopyPath, 2, [sourcePath as TOpenPath], 1);

            await expect(readFile(workingCopyPath, 'utf8')).resolves.toBe('%PDF-1.7\ninserted');
            await expect(stat(tempOutputPath)).rejects.toMatchObject({ code: 'ENOENT' });
        } finally {
            await rm(workDir, {
                recursive: true,
                force: true,
            });
        }
    });

    it('rejects empty qpdf output without replacing the working copy', async () => {
        const workDir = await mkdtemp(join(tmpdir(), 'page-ops-insert-'));
        const workingCopyPath = join(workDir, 'work.pdf');
        const sourcePath = join(workDir, 'source.pdf');
        const tempOutputPath = join(workDir, 'tmp-fixed-output-id.pdf');

        try {
            await writeFile(workingCopyPath, '%PDF-1.7\noriginal');
            await writeFile(sourcePath, '%PDF-1.7\nsource');
            runNativeToolCommandMock.mockResolvedValueOnce({
                exitCode: 0,
                stdout: '2\n',
                stderr: '',
            });
            runNativeToolCommandMock.mockImplementationOnce(async (_qpdf, args: string[]) => {
                const qpdfArgs = await readQpdfArgFile(args);
                expect(qpdfArgs.at(-1)).toBe(tempOutputPath);
                await writeFile(tempOutputPath, new Uint8Array());
                return {
                    exitCode: 0,
                    stdout: '',
                    stderr: '',
                };
            });

            const { insertPagesFromSourcePaths } = await import('@electron/features/page-ops/main/insertPagesFromSourcePaths.service');

            await expect(insertPagesFromSourcePaths(workingCopyPath, 2, [sourcePath as TOpenPath], 1))
                .rejects.toThrow('Inserting pages failed: qpdf produced an empty PDF');

            await expect(readFile(workingCopyPath, 'utf8')).resolves.toBe('%PDF-1.7\noriginal');
            await expect(stat(tempOutputPath)).rejects.toMatchObject({ code: 'ENOENT' });
        } finally {
            await rm(workDir, {
                recursive: true,
                force: true,
            });
        }
    });

    it('rejects stale renderer page counts before building insertion ranges', async () => {
        const workDir = await mkdtemp(join(tmpdir(), 'page-ops-insert-'));
        const workingCopyPath = join(workDir, 'work.pdf');
        const sourcePath = join(workDir, 'source.pdf');

        try {
            await writeFile(workingCopyPath, '%PDF-1.7\noriginal');
            await writeFile(sourcePath, '%PDF-1.7\nsource');
            runNativeToolCommandMock.mockResolvedValueOnce({
                exitCode: 0,
                stdout: '4\n',
                stderr: '',
            });

            const { insertPagesFromSourcePaths } = await import('@electron/features/page-ops/main/insertPagesFromSourcePaths.service');

            await expect(insertPagesFromSourcePaths(workingCopyPath, 2, [sourcePath as TOpenPath], 1))
                .rejects.toThrow('Renderer page count is stale');

            expect(runNativeToolCommandMock).toHaveBeenCalledTimes(1);
            await expect(readFile(workingCopyPath, 'utf8')).resolves.toBe('%PDF-1.7\noriginal');
        } finally {
            await rm(workDir, {
                recursive: true,
                force: true,
            });
        }
    });

    it('passes cancellation options to source combine and qpdf insertion commands', async () => {
        const workDir = await mkdtemp(join(tmpdir(), 'page-ops-insert-'));
        const workingCopyPath = join(workDir, 'work.pdf');
        const sourcePath = join(workDir, 'source.png');
        const tempOutputPath = join(workDir, 'tmp-fixed-output-id.pdf');
        const controller = new AbortController();
        const options = {
            signal: controller.signal,
            cancelGroup: 'working-copy-mutation:test',
        };

        try {
            await writeFile(workingCopyPath, '%PDF-1.7\noriginal');
            await writeFile(sourcePath, 'png-bytes');
            runNativeToolCommandMock.mockResolvedValueOnce({
                exitCode: 0,
                stdout: '2\n',
                stderr: '',
            });
            runNativeToolCommandMock.mockImplementationOnce(async (_qpdf, args: string[]) => {
                const qpdfArgs = await readQpdfArgFile(args);
                expect(qpdfArgs.at(-1)).toBe(tempOutputPath);
                await writeFile(tempOutputPath, '%PDF-1.7\ninserted');
                return {
                    exitCode: 0,
                    stdout: '',
                    stderr: '',
                };
            });

            const { insertPagesFromSourcePaths } = await import('@electron/features/page-ops/main/insertPagesFromSourcePaths.service');

            await insertPagesFromSourcePaths(workingCopyPath, 2, [sourcePath as TOpenPath], 1, 12, undefined, options);

            expect(createPdfFileFromInputPathsMock).toHaveBeenCalledWith(
                [sourcePath],
                expect.stringMatching(/\/insert-source-fixed-output-id\.pdf$/u),
                expect.objectContaining({signal: controller.signal}),
            );
            expect(runNativeToolCommandMock.mock.calls[0]?.[2]).toEqual(expect.objectContaining(options));
            expect(runNativeToolCommandMock.mock.calls[1]?.[2]).toEqual(expect.objectContaining(options));
        } finally {
            await rm(workDir, {
                recursive: true,
                force: true,
            });
        }
    });

    it('keeps an input just above 16 MiB path-backed without reading a merged PDF', async () => {
        const workDir = await mkdtemp(join(tmpdir(), 'page-ops-insert-'));
        const workingCopyPath = join(workDir, 'work.pdf');
        const sourcePath = join(workDir, 'source.png');
        const tempSourcePdfPath = join(workDir, 'insert-source-fixed-output-id.pdf');
        const tempOutputPath = join(workDir, 'tmp-fixed-output-id.pdf');

        try {
            await writeFile(workingCopyPath, '%PDF-1.7\noriginal');
            await writeFile(sourcePath, new Uint8Array());
            await truncate(sourcePath, 16 * 1024 * 1024 + 1);
            createPdfFileFromInputPathsMock.mockImplementationOnce(async (
                _sourcePaths: TOpenPath[],
                outputPath: string,
            ) => {
                await writeFile(outputPath, '%PDF-1.7\nnative-merged');
            });
            runNativeToolCommandMock.mockResolvedValueOnce({
                exitCode: 0,
                stdout: '2\n',
                stderr: '',
            });
            runNativeToolCommandMock.mockImplementationOnce(async (_qpdf, args: string[]) => {
                const qpdfArgs = await readQpdfArgFile(args);
                expect(qpdfArgs).toEqual([
                    workingCopyPath,
                    '--pages',
                    workingCopyPath,
                    '1-1',
                    tempSourcePdfPath,
                    '1-z',
                    workingCopyPath,
                    '2-2',
                    '--',
                    tempOutputPath,
                ]);
                await writeFile(tempOutputPath, '%PDF-1.7\ninserted');
                return {
                    exitCode: 0,
                    stdout: '',
                    stderr: '',
                };
            });

            const { insertPagesFromSourcePaths } = await import('@electron/features/page-ops/main/insertPagesFromSourcePaths.service');

            await insertPagesFromSourcePaths(workingCopyPath, 2, [sourcePath as TOpenPath], 1);

            expect(createPdfFromInputPathsMock).not.toHaveBeenCalled();
            expect(createPdfFileFromInputPathsMock).toHaveBeenCalledWith(
                [sourcePath],
                tempSourcePdfPath,
                {},
            );
            await expect(readFile(workingCopyPath, 'utf8')).resolves.toBe('%PDF-1.7\ninserted');
            await expect(stat(tempSourcePdfPath)).rejects.toMatchObject({code: 'ENOENT'});
        } finally {
            await rm(workDir, {
                recursive: true,
                force: true,
            });
        }
    });

    it('propagates a typed native failure for an input just above 16 MiB', async () => {
        const workDir = await mkdtemp(join(tmpdir(), 'page-ops-insert-'));
        const workingCopyPath = join(workDir, 'work.pdf');
        const sourcePath = join(workDir, 'source.png');
        const tempSourcePdfPath = join(workDir, 'insert-source-fixed-output-id.pdf');
        const nativeFailure = new PdfCombineCapabilityError(
            'native-failure',
            'Native PDF combine failed',
            {operation: 'pdf-combine'},
        );

        try {
            await writeFile(workingCopyPath, '%PDF-1.7\noriginal');
            await writeFile(sourcePath, new Uint8Array());
            await truncate(sourcePath, 16 * 1024 * 1024 + 1);
            createPdfFileFromInputPathsMock.mockRejectedValueOnce(nativeFailure);
            runNativeToolCommandMock.mockResolvedValueOnce({
                exitCode: 0,
                stdout: '2\n',
                stderr: '',
            });

            const { insertPagesFromSourcePaths } = await import('@electron/features/page-ops/main/insertPagesFromSourcePaths.service');

            await expect(insertPagesFromSourcePaths(workingCopyPath, 2, [sourcePath as TOpenPath], 1))
                .rejects.toBe(nativeFailure);

            expect(createPdfFromInputPathsMock).not.toHaveBeenCalled();
            expect(createPdfFileFromInputPathsMock).toHaveBeenCalledWith(
                [sourcePath],
                tempSourcePdfPath,
                {},
            );
            expect(runNativeToolCommandMock).toHaveBeenCalledTimes(1);
            await expect(stat(tempSourcePdfPath)).rejects.toMatchObject({code: 'ENOENT'});
        } finally {
            await rm(workDir, {
                recursive: true,
                force: true,
            });
        }
    });

    it('routes 501 tiny source pages through file-backed combine without in-memory conversion', async () => {
        const sourcePaths = await runTinyPdfSourceBatchInsertion(501);

        expect(createPdfFileFromInputPathsMock).toHaveBeenCalledWith(
            sourcePaths,
            expect.stringMatching(/\/insert-source-fixed-output-id\.pdf$/u),
            {},
        );
        expect(createPdfFromInputPathsMock).not.toHaveBeenCalled();
    });

    it('routes 10,001 tiny source pages through file-backed combine without in-memory conversion', async () => {
        const sourcePaths = await runTinyPdfSourceBatchInsertion(10_001);

        expect(createPdfFileFromInputPathsMock).toHaveBeenCalledWith(
            sourcePaths,
            expect.stringMatching(/\/insert-source-fixed-output-id\.pdf$/u),
            {},
        );
        expect(createPdfFromInputPathsMock).not.toHaveBeenCalled();
    });
});
