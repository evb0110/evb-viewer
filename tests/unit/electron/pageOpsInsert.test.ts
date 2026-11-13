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
import {
    dirname, join,
} from 'path';
import type * as NodeCrypto from 'node:crypto';
import type { TOpenPath } from '@electron/file-access/openPathCapabilities';
import { PdfCombineCapabilityError } from '@electron/image/pdfCombineErrors';

const randomUuidMock = vi.hoisted(() => vi.fn(() => 'fixed-output-id'));
const runNativeToolCommandMock = vi.hoisted(() => vi.fn());
const ensureWorkingCopyDirectoryMock = vi.hoisted(() => vi.fn());
const createPdfFileFromInputPathsMock = vi.hoisted(() => vi.fn());
const createPdfFromInputPathsMock = vi.hoisted(() => vi.fn());

/** The engine's insert command, which publishes its output over the working copy. */
function expectInsertCommand(args: string[], workingCopyPath: string, sourcePdfPath: string) {
    expect(args).toEqual([
        'insert-pages',
        '--input',
        workingCopyPath,
        '--output',
        workingCopyPath,
        '--source',
        sourcePdfPath,
        '--after-page',
        '1',
    ]);
}

async function runTinyPdfSourceBatchInsertion(sourceCount: number) {
    const workDir = await mkdtemp(join(tmpdir(), 'page-ops-insert-'));
    const workingCopyPath = join(workDir, 'work.pdf');
    const sourcePath = join(workDir, 'source.pdf');
    const tempSourcePdfPath = join(workDir, 'insert-source-fixed-output-id.pdf');
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
        runNativeToolCommandMock.mockImplementationOnce(async (_binary, args: string[]) => {
            expectInsertCommand(args, workingCopyPath, tempSourcePdfPath);
            await writeFile(workingCopyPath, '%PDF-1.7\ninserted');
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
vi.mock('@electron/features/page-ops/main/resolveNativePageOpsPath', () => ({resolveNativePageOpsPath: () => '/mock/pdf-page-ops'}));
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

    it('passes cancellation options to source combine and the engine insertion command', async () => {
        const workDir = await mkdtemp(join(tmpdir(), 'page-ops-insert-'));
        const workingCopyPath = join(workDir, 'work.pdf');
        const sourcePath = join(workDir, 'source.png');
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
            runNativeToolCommandMock.mockImplementationOnce(async (_binary, args: string[]) => {
                expectInsertCommand(args, workingCopyPath, join(workDir, 'insert-source-fixed-output-id.pdf'));
                await writeFile(workingCopyPath, '%PDF-1.7\ninserted');
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
                join(workDir, 'insert-source-fixed-output-id.pdf'),
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
            runNativeToolCommandMock.mockImplementationOnce(async (_binary, args: string[]) => {
                expectInsertCommand(args, workingCopyPath, tempSourcePdfPath);
                await writeFile(workingCopyPath, '%PDF-1.7\ninserted');
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
            join(dirname(sourcePaths[0]!), 'insert-source-fixed-output-id.pdf'),
            {},
        );
        expect(createPdfFromInputPathsMock).not.toHaveBeenCalled();
    });

    it('routes 10,001 tiny source pages through file-backed combine without in-memory conversion', async () => {
        const sourcePaths = await runTinyPdfSourceBatchInsertion(10_001);

        expect(createPdfFileFromInputPathsMock).toHaveBeenCalledWith(
            sourcePaths,
            join(dirname(sourcePaths[0]!), 'insert-source-fixed-output-id.pdf'),
            {},
        );
        expect(createPdfFromInputPathsMock).not.toHaveBeenCalled();
    });
});
