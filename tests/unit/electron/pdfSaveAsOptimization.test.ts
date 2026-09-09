import type * as TViMockOriginalModule from '@electron/pdf/nativeToolPaths';

import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    existsSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    truncateSync,
    writeFileSync,
} from 'fs';
import {
    copyFile,
    unlink,
    writeFile,
} from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import type { THostResourceTier } from '@contracts/hostResourceProfile';

const mocks = vi.hoisted(() => ({
    analyzePdfConformanceFile: vi.fn(),
    validatePdfFile: vi.fn(),
    runNativeToolCommand: vi.fn(),
    atomicReplace: vi.fn(),
    makeSiblingTempPath: vi.fn((targetPath: string) => `${targetPath}.optimized`),
    hostTier: 'high' as THostResourceTier,
}));

vi.mock('@electron/features/documents/main/pdfConformance', () => ({
    analyzePdfConformanceFile: (...args: unknown[]) => mocks.analyzePdfConformanceFile(...args),
    validatePdfFile: (...args: unknown[]) => mocks.validatePdfFile(...args),
}));
vi.mock('@electron/pdf/nativeToolPaths', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    getPdfNativeToolPaths: () => ({ qpdf: '/native/qpdf' }),
}));
vi.mock('@electron/native-tools/runNativeToolCommand', () => ({ runNativeToolCommand: (...args: unknown[]) => mocks.runNativeToolCommand(...args) }));
vi.mock('@electron/utils/createLogger', () => ({ createLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
}) }));
vi.mock('@electron/utils/atomicReplace', () => ({
    atomicReplace: (...args: unknown[]) => mocks.atomicReplace(...args),
    makeSiblingTempPath: (...args: [string]) => mocks.makeSiblingTempPath(...args),
}));
vi.mock('@electron/resources/hostResourceProfile', () => ({getHostResourceProfileSnapshot: () => ({tier: mocks.hostTier})}));

describe('pdfSaveAsOptimization', () => {
    let tempRoot = '';

    beforeEach(() => {
        vi.clearAllMocks();
        tempRoot = mkdtempSync(join(tmpdir(), 'evb-pdf-save-as-optimization-test-'));
        mocks.hostTier = 'high';
        mocks.analyzePdfConformanceFile.mockResolvedValue({
            isSigned: false,
            isEncrypted: false,
            isTagged: false,
            pdfaLevel: null,
            hasAcroForm: false,
            hasXfa: false,
            canIncrementalSave: true,
            saveRestrictions: [],
        });
        mocks.validatePdfFile.mockResolvedValue({
            isValid: true,
            tool: 'qpdf',
            errors: [],
            warnings: [],
        });
        mocks.atomicReplace.mockImplementation(async (sourcePath: string, targetPath: string) => {
            await copyFile(sourcePath, targetPath);
            await unlink(sourcePath);
        });
    });

    afterEach(() => {
        rmSync(tempRoot, {
            force: true,
            recursive: true,
        });
    });

    it('skips automatic save optimization for small PDFs', async () => {
        const tempPath = join(tempRoot, 'document.pdf');
        writeFileSync(tempPath, 'original-pdf');
        const { optimizePdfForSaveAs } = await import('@electron/features/documents/main/pdfSaveAsOptimization');

        await expect(optimizePdfForSaveAs(tempPath)).resolves.toBeNull();

        expect(mocks.runNativeToolCommand).not.toHaveBeenCalled();
        expect(readFileSyncUtf8(tempPath)).toBe('original-pdf');
    });

    it('keeps valid qpdf output and replaces the temp PDF', async () => {
        const tempPath = join(tempRoot, 'document.pdf');
        const optimizedPath = `${tempPath}.optimized`;
        writeFileSync(tempPath, 'original-pdf');
        mocks.runNativeToolCommand.mockImplementation(async () => {
            await writeFile(optimizedPath, 'small');
        });
        const { optimizePdfForSaveAs } = await import('@electron/features/documents/main/pdfSaveAsOptimization');

        await expect(optimizePdfForSaveAs(tempPath, { optimizeLossless: true }))
            .resolves
            .toMatchObject({ isValid: true });

        expect(mocks.runNativeToolCommand).toHaveBeenCalledWith(
            '/native/qpdf',
            [
                '--linearize',
                '--stream-data=preserve',
                '--object-streams=generate',
                tempPath,
                optimizedPath,
            ],
            expect.objectContaining({ commandLabel: 'qpdf(save-as-optimize)' }),
        );
        expect(mocks.validatePdfFile).toHaveBeenCalledWith(optimizedPath, {});
        expect(mocks.atomicReplace).toHaveBeenCalledWith(optimizedPath, tempPath);
        expect(readFileSyncUtf8(tempPath)).toBe('small');
        expect(existsSync(optimizedPath)).toBe(false);
    });

    it('keeps valid qpdf output even when it is not smaller', async () => {
        const tempPath = join(tempRoot, 'document.pdf');
        const optimizedPath = `${tempPath}.optimized`;
        writeFileSync(tempPath, 'tiny');
        mocks.runNativeToolCommand.mockImplementation(async () => {
            await writeFile(optimizedPath, 'larger-pdf');
        });
        const { optimizePdfForSaveAs } = await import('@electron/features/documents/main/pdfSaveAsOptimization');

        await expect(optimizePdfForSaveAs(tempPath, { optimizeLossless: true }))
            .resolves
            .toMatchObject({ isValid: true });

        expect(mocks.validatePdfFile).toHaveBeenCalledWith(optimizedPath, {});
        expect(mocks.atomicReplace).toHaveBeenCalledWith(optimizedPath, tempPath);
        expect(readFileSyncUtf8(tempPath)).toBe('larger-pdf');
        expect(existsSync(optimizedPath)).toBe(false);
    });

    it('automatically optimizes large PDFs on save', async () => {
        const tempPath = join(tempRoot, 'large.pdf');
        const optimizedPath = `${tempPath}.optimized`;
        writeFileSync(tempPath, 'large-pdf');
        truncateSync(tempPath, (64 * 1024 * 1024) + 1);
        mocks.runNativeToolCommand.mockImplementation(async () => {
            await writeFile(optimizedPath, 'linearized-pdf');
        });
        const { optimizeLargePdfForOrdinarySave } = await import(
            '@electron/features/documents/main/pdfSaveAsOptimization'
        );

        await expect(optimizeLargePdfForOrdinarySave(tempPath))
            .resolves
            .toMatchObject({ isValid: true });

        expect(mocks.runNativeToolCommand).toHaveBeenCalledWith(
            '/native/qpdf',
            expect.arrayContaining(['--linearize']),
            expect.objectContaining({ commandLabel: 'qpdf(save-optimize-large)' }),
        );
        expect(readFileSyncUtf8(tempPath)).toBe('linearized-pdf');
    });

    it('skips automatic ordinary-save optimization on the authoritative low tier', async () => {
        const tempPath = join(tempRoot, 'large-low-tier.pdf');
        writeFileSync(tempPath, 'large-pdf');
        truncateSync(tempPath, (64 * 1024 * 1024) + 1);
        mocks.hostTier = 'low';
        const { optimizeLargePdfForOrdinarySave } = await import(
            '@electron/features/documents/main/pdfSaveAsOptimization'
        );

        await expect(optimizeLargePdfForOrdinarySave(tempPath)).resolves.toBeNull();

        expect(mocks.analyzePdfConformanceFile).not.toHaveBeenCalled();
        expect(mocks.runNativeToolCommand).not.toHaveBeenCalled();
    });

    it('preserves automatic Save As optimization on the low tier', async () => {
        const tempPath = join(tempRoot, 'large-save-as-low-tier.pdf');
        const optimizedPath = `${tempPath}.optimized`;
        writeFileSync(tempPath, 'large-pdf');
        truncateSync(tempPath, (64 * 1024 * 1024) + 1);
        mocks.hostTier = 'low';
        mocks.runNativeToolCommand.mockImplementation(async () => {
            await writeFile(optimizedPath, 'linearized-pdf');
        });
        const { optimizePdfForSaveAs } = await import(
            '@electron/features/documents/main/pdfSaveAsOptimization'
        );

        await expect(optimizePdfForSaveAs(tempPath))
            .resolves
            .toMatchObject({isValid: true});

        expect(mocks.runNativeToolCommand).toHaveBeenCalledWith(
            '/native/qpdf',
            expect.arrayContaining(['--linearize']),
            expect.objectContaining({commandLabel: 'qpdf(save-optimize-large)'}),
        );
    });

    it('optimizes generated PDFs without semantic preflight', async () => {
        const tempPath = join(tempRoot, 'generated.pdf');
        const optimizedPath = `${tempPath}.optimized`;
        writeFileSync(tempPath, 'generated-pdf');
        mocks.runNativeToolCommand.mockImplementation(async () => {
            await writeFile(optimizedPath, 'linearized-generated-pdf');
        });
        const { optimizeGeneratedPdfForInteraction } =
            await import('@electron/features/documents/main/pdfSaveAsOptimization');

        await expect(optimizeGeneratedPdfForInteraction(tempPath))
            .resolves
            .toMatchObject({ isValid: true });

        expect(mocks.analyzePdfConformanceFile).not.toHaveBeenCalled();
        expect(mocks.runNativeToolCommand).toHaveBeenCalledWith(
            '/native/qpdf',
            expect.arrayContaining(['--linearize']),
            expect.objectContaining({ commandLabel: 'qpdf(generated-pdf-optimize)' }),
        );
        expect(readFileSyncUtf8(tempPath)).toBe('linearized-generated-pdf');
    });

    it('skips PDFs where rewriting can alter document semantics', async () => {
        const tempPath = join(tempRoot, 'signed.pdf');
        writeFileSync(tempPath, 'signed-pdf');
        mocks.analyzePdfConformanceFile.mockResolvedValue({
            isSigned: true,
            isEncrypted: false,
            isTagged: false,
            pdfaLevel: null,
            hasAcroForm: false,
            hasXfa: false,
            canIncrementalSave: false,
            saveRestrictions: ['signed'],
        });
        const { optimizePdfForSaveAs } = await import('@electron/features/documents/main/pdfSaveAsOptimization');

        await expect(optimizePdfForSaveAs(tempPath, { optimizeLossless: true })).resolves.toBeNull();

        expect(mocks.runNativeToolCommand).not.toHaveBeenCalled();
        expect(readFileSyncUtf8(tempPath)).toBe('signed-pdf');
    });
});

function readFileSyncUtf8(path: string) {
    return readFileSync(path, 'utf8');
}
