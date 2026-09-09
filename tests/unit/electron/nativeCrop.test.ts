import type * as TViMockOriginalModule from '@electron/pdf/nativeToolPaths';

import {
    mkdtemp,
    readFile,
    rm,
    truncate,
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

const runNativeToolCommandMock = vi.hoisted(() => vi.fn());
const copyFileCopyOnWriteMock = vi.hoisted(() => vi.fn());

vi.mock('@electron/native-tools/runNativeToolCommand', () => ({runNativeToolCommand: (...args: unknown[]) => runNativeToolCommandMock(...args)}));
vi.mock('@electron/file-access/workingCopyDirectory', () => ({copyFileCopyOnWrite: (...args: unknown[]) => copyFileCopyOnWriteMock(...args)}));
vi.mock('@electron/pdf/nativeToolPaths', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    getPdfNativeToolPaths: () => ({qpdf: '/tools/qpdf'}),
}));
vi.mock('@electron/utils/createLogger', () => ({createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
})}));

const originalEnv = { ...process.env };

describe('native page crop helper', () => {
    let tempDir = '';
    let pdfPath = '';
    let nativeBinaryPath = '';

    beforeEach(async () => {
        vi.clearAllMocks();
        process.env = { ...originalEnv };
        process.env.EVB_PDF_PAGE_OPS_ENABLE = '1';
        tempDir = await mkdtemp(join(tmpdir(), 'native-crop-test-'));
        pdfPath = join(tempDir, 'work.pdf');
        nativeBinaryPath = join(tempDir, process.platform === 'win32' ? 'evb-pdf-page-ops.exe' : 'evb-pdf-page-ops');
        process.env.EVB_PDF_PAGE_OPS_PATH = nativeBinaryPath;
        await writeFile(pdfPath, '%PDF-1.7\noriginal');
        await writeFile(nativeBinaryPath, '');
    });

    afterEach(async () => {
        process.env = { ...originalEnv };
        if (tempDir) {
            await rm(tempDir, {
                recursive: true,
                force: true,
            });
        }
    });

    it('writes selected pages through a temp file before replacing the working copy', async () => {
        runNativeToolCommandMock.mockImplementationOnce(async (_binaryPath: string, args: string[]) => {
            const outputPath = args[args.indexOf('--output') + 1]!;
            const pagesFilePath = args[args.indexOf('--pages-file') + 1]!;
            await expect(readFile(pagesFilePath, 'utf8')).resolves.toBe('1\n2048\n3000\n');
            await writeFile(outputPath, '%PDF-1.7\nnative crop');
            return {
                exitCode: 0,
                stdout: '',
                stderr: '',
            };
        });

        const { tryCropPagesWithNativePageOps } = await import('@electron/features/page-ops/main/nativeCrop');

        await expect(tryCropPagesWithNativePageOps(pdfPath, [
            1,
            2048,
            3000,
        ], {
            top: 1,
            bottom: 2,
            left: 3,
            right: 4,
        })).resolves.toBe(true);

        const args = runNativeToolCommandMock.mock.calls[0]?.[1] as string[];
        const inputPath = args[args.indexOf('--input') + 1];
        const outputPath = args[args.indexOf('--output') + 1];
        const pagesFilePath = args[args.indexOf('--pages-file') + 1];
        expect(inputPath).toBe(outputPath);
        expect(copyFileCopyOnWriteMock).toHaveBeenCalledWith(pdfPath, inputPath);
        expect(args).toEqual([
            'crop',
            '--input',
            inputPath,
            '--output',
            outputPath,
            '--pages-file',
            pagesFilePath,
            '--qpdf',
            '/tools/qpdf',
            '--top',
            '1',
            '--bottom',
            '2',
            '--left',
            '3',
            '--right',
            '4',
        ]);
        expect(runNativeToolCommandMock).toHaveBeenCalledWith(nativeBinaryPath, args, {
            timeoutMs: 120000,
            commandLabel: 'evb-pdf-page-ops(crop)',
        });
        await expect(readFile(pdfPath, 'utf8')).resolves.toBe('%PDF-1.7\nnative crop');
    });

    it('passes the exact remove-crop command contract', async () => {
        runNativeToolCommandMock.mockImplementationOnce(async (_binaryPath: string, args: string[]) => {
            const outputPath = args[args.indexOf('--output') + 1]!;
            await writeFile(outputPath, '%PDF-1.7\nnative remove crop');
            return {
                exitCode: 0,
                stdout: '',
                stderr: '',
            };
        });

        const { tryRemoveCropWithNativePageOps } = await import('@electron/features/page-ops/main/nativeCrop');

        await expect(tryRemoveCropWithNativePageOps(pdfPath, [2])).resolves.toBe(true);

        const args = runNativeToolCommandMock.mock.calls[0]?.[1] as string[];
        const inputPath = args[args.indexOf('--input') + 1];
        const outputPath = args[args.indexOf('--output') + 1];
        const pagesFilePath = args[args.indexOf('--pages-file') + 1];
        expect(inputPath).toBe(outputPath);
        expect(copyFileCopyOnWriteMock).toHaveBeenCalledWith(pdfPath, inputPath);
        expect(args).toEqual([
            'remove-crop',
            '--input',
            inputPath,
            '--output',
            outputPath,
            '--pages-file',
            pagesFilePath,
            '--qpdf',
            '/tools/qpdf',
        ]);
        expect(runNativeToolCommandMock).toHaveBeenCalledWith(nativeBinaryPath, args, {
            timeoutMs: 120000,
            commandLabel: 'evb-pdf-page-ops(remove-crop)',
        });
        await expect(readFile(pdfPath, 'utf8')).resolves.toBe('%PDF-1.7\nnative remove crop');
    });

    it('uses a copy-on-write input and qpdf for the structural route above 512 MiB', async () => {
        await truncate(pdfPath, 512 * 1024 * 1024 + 1);
        copyFileCopyOnWriteMock.mockImplementationOnce(async (_sourcePath: string, targetPath: string) => {
            await writeFile(targetPath, '%PDF-1.7\nstructural input');
        });
        runNativeToolCommandMock.mockImplementationOnce(async (_binaryPath: string, args: string[]) => {
            const outputPath = args[args.indexOf('--output') + 1]!;
            await writeFile(outputPath, '%PDF-1.7\nstructural crop');
            return {
                exitCode: 0,
                stdout: '',
                stderr: '',
            };
        });

        const { tryCropPagesWithNativePageOps } = await import('@electron/features/page-ops/main/nativeCrop');

        await expect(tryCropPagesWithNativePageOps(pdfPath, [1], {
            top: 1,
            bottom: 2,
            left: 3,
            right: 4,
        })).resolves.toBe(true);

        const args = runNativeToolCommandMock.mock.calls[0]?.[1] as string[];
        const inputPath = args[args.indexOf('--input') + 1];
        const outputPath = args[args.indexOf('--output') + 1];
        expect(inputPath).toBe(outputPath);
        expect(inputPath).not.toBe(pdfPath);
        expect(args).toContain('/tools/qpdf');
        expect(copyFileCopyOnWriteMock).toHaveBeenCalledWith(pdfPath, inputPath);
    });

    it('rejects instead of silently falling back when the native helper fails in enabled test mode', async () => {
        runNativeToolCommandMock.mockRejectedValueOnce(new Error('native failed'));

        const { tryRemoveCropWithNativePageOps } = await import('@electron/features/page-ops/main/nativeCrop');

        await expect(tryRemoveCropWithNativePageOps(pdfPath, [1]))
            .rejects.toThrow('Native page ops fallback is not allowed in tests');
        await expect(readFile(pdfPath, 'utf8')).resolves.toBe('%PDF-1.7\noriginal');
    });
});
