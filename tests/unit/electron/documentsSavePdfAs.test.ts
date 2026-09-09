import type * as TViMockOriginalModule from '@electron/file-access/workingCopyStore';

import {cast} from '@tests/helpers/cast';
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
    writeFileSync,
} from 'fs';
import {
    readFile,
    unlink,
    writeFile,
} from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';

const mocks = vi.hoisted(() => ({
    showSaveDialog: vi.fn(),
    resolveTypedStagedArtifact: vi.fn(),
    updateRecentFilesMenu: vi.fn(),
    addRecentFile: vi.fn(),
    allowOpenPath: vi.fn(),
    ensureWorkingCopyDirectory: vi.fn(),
    getWorkingCopyOriginalPath: vi.fn(),
    setWorkingCopyOriginalPath: vi.fn<(workingPath: string, originalPath: string, senderId?: number) => void>(),
    workingCopyMap: new Map<string, string>(),
    atomicReplace: vi.fn(),
    makeSiblingTempPath: vi.fn((targetPath: string) => `${targetPath}.tmp`),
    validatePdfFile: vi.fn(),
    optimizePdfForSaveAs: vi.fn(),
    assertWorkingCopyRevisionCurrent: vi.fn(),
    copyFileCopyOnWrite: vi.fn(),
    markWorkingCopyContentChanged: vi.fn(),
    markWorkingCopySyncRequired: vi.fn(),
}));

vi.mock('@electron/features/documents/main/managedTempFileHandles', () => ({resolveTypedStagedArtifact: (...args: unknown[]) => mocks.resolveTypedStagedArtifact(...args)}));

vi.mock('electron', () => ({
    app: {isPackaged: false},
    BrowserWindow: {
        fromWebContents: vi.fn(() => null),
        getAllWindows: vi.fn(() => []),
        getFocusedWindow: vi.fn(() => null),
    },
    dialog: {
        showOpenDialog: vi.fn(),
        showSaveDialog: (...args: unknown[]) => mocks.showSaveDialog(...args),
    },
    shell: { showItemInFolder: vi.fn() },
}));

vi.mock('@electron/image/pdfConversion', () => ({
    buildCombinedPdfOutputPath: vi.fn(),
    createPdfFromInputPaths: vi.fn(),
    isDjvuPath: vi.fn(() => false),
    isPdfPath: vi.fn((path: string) => path.toLowerCase().endsWith('.pdf')),
    isSupportedOpenPath: vi.fn(() => true),
}));
vi.mock('@electron/image/pdfCombineShared', () => ({PDF_COMBINE_SUPPORTED_IMAGE_EXTENSIONS: ['.png']}));

vi.mock('@electron/menu', () => ({
    refreshMenu: vi.fn(),
    updateRecentFilesMenu: (...args: unknown[]) => mocks.updateRecentFilesMenu(...args),
}));

vi.mock('@electron/recentFiles', () => ({addRecentFile: (...args: unknown[]) => mocks.addRecentFile(...args)}));
vi.mock('@electron/file-access/docxExportPaths', () => ({allowDocxWritePath: vi.fn()}));
vi.mock('@electron/features/djvu/main/exportPaths', () => ({allowDjvuWritePath: vi.fn()}));
vi.mock('@electron/file-access/workingCopyCreation', () => ({
    createWorkingCopy: vi.fn(),
    createWorkingCopyFromData: vi.fn(),
    createWorkingCopyFromPath: vi.fn(),
    ensureWorkingCopyDirectory: (...args: unknown[]) => mocks.ensureWorkingCopyDirectory(...args),
}));
vi.mock('@electron/file-access/workingCopyStore', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    getWorkingCopyOriginalPath: (...args: unknown[]) => mocks.getWorkingCopyOriginalPath(...args),
    isKnownWorkingCopyOriginalPath: vi.fn(() => false),
    normalizePathForLookup: (path: string) => path.trim(),
    setWorkingCopyOriginalPath: (...args: [string, string, number?]) => mocks.setWorkingCopyOriginalPath(...args),
}));
vi.mock('@electron/file-access/openPathCapabilities', () => ({
    allowOpenPath: (...args: unknown[]) => mocks.allowOpenPath(...args),
    allowOpenPaths: vi.fn(),
    logRejectedOpenPath: vi.fn(),
    requireOpenPath: vi.fn((path: string) => path),
}));
vi.mock('@electron/utils/pathValidator', () => ({
    getManagedTempPathAccessDecision: vi.fn(() => undefined),
    resolveAllowedReadPath: vi.fn(async () => null),
    setManagedTempPathAccessValidator: vi.fn(),
}));
vi.mock('@electron/te', () => ({te: (key: string) => key}));
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
vi.mock('@electron/features/documents/main/pdfConformance', () => ({validatePdfFile: (...args: unknown[]) => mocks.validatePdfFile(...args)}));
vi.mock('@electron/features/documents/public/pdfSaveAsOptimization', () => ({
    normalizePdfSaveAsOptions: (value: unknown) => (
        value
        && typeof value === 'object'
        && 'optimizeLossless' in value
        && value.optimizeLossless === true
            ? { optimizeLossless: true }
            : undefined
    ),
    optimizePdfForSaveAs: (...args: unknown[]) => mocks.optimizePdfForSaveAs(...args),
}));
vi.mock('@electron/file-access/documentRevisionStore', () => ({
    assertWorkingCopyRevisionCurrent: (...args: unknown[]) => mocks.assertWorkingCopyRevisionCurrent(...args),
    markWorkingCopyContentChanged: (...args: unknown[]) => mocks.markWorkingCopyContentChanged(...args),
    markWorkingCopySyncRequired: (...args: unknown[]) => mocks.markWorkingCopySyncRequired(...args),
}));
vi.mock('@electron/file-access/workingCopyDirectory', () => ({copyFileCopyOnWrite: (...args: [string, string]) => mocks.copyFileCopyOnWrite(...args)}));
vi.mock('@electron/file-access/documentMutationGuards', () => ({
    assertQueuedWorkingCopyMutationPreconditions: (workingPath: string, expectedRevision?: string | null) => {
        if (expectedRevision === undefined || expectedRevision === null) {
            throw new Error('Document revision token is required');
        }
        return mocks.assertWorkingCopyRevisionCurrent(workingPath, expectedRevision);
    },
    assertWorkingCopyMutationAllowed: (...args: unknown[]) => mocks.assertWorkingCopyRevisionCurrent(...args),
    normalizeExpectedDocumentRevisionToken: (options?: { expectedDocumentRevisionToken?: string | null; } | null) =>
        options?.expectedDocumentRevisionToken?.trim() ?? null,
}));

describe('handleSavePdfAs', () => {
    let tempRoot = '';
    const sender = {id: 42};
    const revisionOptions = { expectedDocumentRevisionToken: requireDocumentRevisionToken('revision-before-save') };
    const dialogContext = {
        parentWindow: null,
        sender,
        senderId: 42,
    } as never;

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.workingCopyMap.clear();
        tempRoot = mkdtempSync(join(tmpdir(), 'evb-save-pdf-as-test-'));
        mocks.ensureWorkingCopyDirectory.mockResolvedValue(true);
        mocks.setWorkingCopyOriginalPath.mockImplementation((workingPath, originalPath) => {
            mocks.workingCopyMap.set(workingPath, originalPath);
        });
        mocks.atomicReplace.mockImplementation(async (sourcePath: string, targetPath: string) => {
            await writeFile(targetPath, await readFile(sourcePath));
            await unlink(sourcePath);
        });
        mocks.validatePdfFile.mockResolvedValue({
            isValid: true,
            tool: 'qpdf',
            errors: [],
            warnings: [],
        });
        mocks.optimizePdfForSaveAs.mockResolvedValue(null);
        mocks.assertWorkingCopyRevisionCurrent.mockResolvedValue(undefined);
        mocks.markWorkingCopyContentChanged.mockResolvedValue(undefined);
        mocks.copyFileCopyOnWrite.mockImplementation(async (sourcePath: string, targetPath: string) => {
            await writeFile(targetPath, await readFile(sourcePath));
        });
    });

    afterEach(() => {
        rmSync(tempRoot, {
            force: true,
            recursive: true,
        });
    });

    it.each([
        'success',
        'cancel',
        'invalid-artifact',
        'publish-failure',
        'copyback-failure',
        'mapping-failure',
    ])('keeps original bytes unchanged for staged Save As %s', async (outcome) => {
        const workingPath = join(tempRoot, 'working.pdf');
        const originalPath = join(tempRoot, 'original.pdf');
        const targetPath = join(tempRoot, 'saved.pdf');
        const stagedPath = join(tempRoot, 'staged.pdf');
        writeFileSync(workingPath, 'source-pdf');
        writeFileSync(originalPath, 'source-pdf');
        writeFileSync(targetPath, 'existing-destination');
        writeFileSync(stagedPath, 'annotated-pdf');
        mocks.getWorkingCopyOriginalPath.mockReturnValue({originalPath});
        mocks.resolveTypedStagedArtifact.mockResolvedValue({path: stagedPath});
        if (outcome === 'invalid-artifact') mocks.resolveTypedStagedArtifact.mockRejectedValueOnce(new Error('invalid artifact'));
        if (outcome === 'publish-failure') mocks.atomicReplace.mockRejectedValueOnce(new Error('publish failed'));
        if (outcome === 'mapping-failure') mocks.setWorkingCopyOriginalPath.mockRejectedValueOnce(new Error('mapping failed'));
        if (outcome === 'copyback-failure') mocks.copyFileCopyOnWrite.mockImplementationOnce(async (source: string, target: string) => {
            await writeFile(target, await readFile(source));
        }).mockRejectedValueOnce(new Error('copyback failed'));
        const {savePdfAs} = await import('@electron/features/documents/main/documentSave.service');
        const save = savePdfAs(dialogContext, workingPath, {stagedOutput: cast({path: stagedPath})},
            async () => outcome === 'cancel' ? null : targetPath, revisionOptions);
        if (outcome === 'invalid-artifact' || outcome === 'publish-failure') await expect(save).rejects.toThrow();
        else await expect(save).resolves.toBe(outcome === 'cancel' ? null : targetPath);
        expect(readFileSyncUtf8(originalPath)).toBe('source-pdf');
        expect(readFileSyncUtf8(workingPath)).toBe(outcome === 'success' ? 'annotated-pdf' : 'source-pdf');
        expect(readFileSyncUtf8(targetPath)).toBe([
            'success',
            'copyback-failure',
            'mapping-failure',
        ].includes(outcome) ? 'annotated-pdf' : 'existing-destination');
        expect(mocks.workingCopyMap.get(workingPath)).toBe([
            'success',
            'copyback-failure',
        ].includes(outcome) ? targetPath : undefined);
        if (outcome === 'copyback-failure' || outcome === 'mapping-failure') expect(mocks.markWorkingCopySyncRequired).toHaveBeenCalled();
    });

    it('writes through a sibling temp path before replacing the selected PDF path', async () => {
        const workingPath = join(tempRoot, 'working.pdf');
        const originalPath = join(tempRoot, 'original.pdf');
        const targetPath = join(tempRoot, 'saved.pdf');
        const tempPath = `${targetPath}.tmp`;
        writeFileSync(workingPath, 'new-pdf');
        writeFileSync(targetPath, 'old-pdf');
        mocks.getWorkingCopyOriginalPath.mockReturnValue({originalPath});
        mocks.showSaveDialog.mockResolvedValue({
            canceled: false,
            filePath: targetPath,
        });

        const { handleSavePdfAs } = await import('@electron/features/documents/main/documentSaveDialogHandlers');

        await expect(handleSavePdfAs(
            dialogContext,
            workingPath,
            undefined,
            revisionOptions,
        )).resolves.toBe(targetPath);

        expect(mocks.makeSiblingTempPath).toHaveBeenCalledWith(targetPath);
        expect(mocks.validatePdfFile).toHaveBeenCalledWith(workingPath);
        expect(mocks.atomicReplace).toHaveBeenCalledWith(tempPath, targetPath);
        expect(readFileSyncUtf8(targetPath)).toBe('new-pdf');
        expect(existsSync(tempPath)).toBe(false);
        expect(mocks.workingCopyMap.get(workingPath)).toBe(targetPath);
        expect(mocks.allowOpenPath).toHaveBeenCalledWith(targetPath, {id: 42});
        expect(mocks.addRecentFile).toHaveBeenCalledWith(targetPath);
        expect(mocks.updateRecentFilesMenu).toHaveBeenCalled();
        expect(
            mocks.validatePdfFile.mock.invocationCallOrder[0]!,
        ).toBeLessThan(mocks.atomicReplace.mock.invocationCallOrder[0]!);
        expect(
            mocks.atomicReplace.mock.invocationCallOrder[0]!,
        ).toBeLessThan(mocks.allowOpenPath.mock.invocationCallOrder[0]!);
    });

    it('runs lossless optimization before replacing the selected PDF path when requested', async () => {
        const workingPath = join(tempRoot, 'working.pdf');
        const targetPath = join(tempRoot, 'saved.pdf');
        const tempPath = `${targetPath}.tmp`;
        writeFileSync(workingPath, 'new-pdf');
        writeFileSync(targetPath, 'old-pdf');
        mocks.getWorkingCopyOriginalPath.mockReturnValue(null);
        mocks.showSaveDialog.mockResolvedValue({
            canceled: false,
            filePath: targetPath,
        });

        const { handleSavePdfAs } = await import('@electron/features/documents/main/documentSaveDialogHandlers');

        await expect(handleSavePdfAs(
            dialogContext,
            workingPath,
            { optimizeLossless: true },
            revisionOptions,
        )).resolves.toBe(targetPath);

        expect(mocks.optimizePdfForSaveAs).toHaveBeenCalledWith(tempPath, { optimizeLossless: true });
        expect(
            mocks.optimizePdfForSaveAs.mock.invocationCallOrder[0]!,
        ).toBeLessThan(mocks.atomicReplace.mock.invocationCallOrder[0]!);
    });

    it('copies optimized Save As target bytes back to the managed working copy after replacement', async () => {
        const workingPath = join(tempRoot, 'optimized-working.pdf');
        const targetPath = join(tempRoot, 'optimized-saved.pdf');
        const tempPath = `${targetPath}.tmp`;
        writeFileSync(workingPath, 'unoptimized-pdf');
        writeFileSync(targetPath, 'old-pdf');
        mocks.getWorkingCopyOriginalPath.mockReturnValue(null);
        mocks.showSaveDialog.mockResolvedValue({
            canceled: false,
            filePath: targetPath,
        });
        mocks.optimizePdfForSaveAs.mockImplementationOnce(async (optimizedTempPath: string) => {
            writeFileSync(optimizedTempPath, 'optimized-pdf');
            return {
                isValid: true,
                tool: 'qpdf',
                errors: [],
                warnings: [],
            };
        });

        const { handleSavePdfAs } = await import('@electron/features/documents/main/documentSaveDialogHandlers');

        await expect(handleSavePdfAs(
            dialogContext,
            workingPath,
            { optimizeLossless: true },
            revisionOptions,
        )).resolves.toBe(targetPath);

        expect(readFileSyncUtf8(targetPath)).toBe('optimized-pdf');
        expect(readFileSyncUtf8(workingPath)).toBe('optimized-pdf');
        expect(mocks.copyFileCopyOnWrite).toHaveBeenCalledWith(workingPath, tempPath);
        expect(mocks.copyFileCopyOnWrite).toHaveBeenCalledWith(targetPath, workingPath);
        expect(mocks.atomicReplace.mock.invocationCallOrder[0]!)
            .toBeLessThan(mocks.copyFileCopyOnWrite.mock.invocationCallOrder[1]!);
        expect(mocks.markWorkingCopyContentChanged).toHaveBeenCalledWith(workingPath, 'save-sync', 42);
    });

    it('returns the committed target when optimized Save As copyback fails', async () => {
        const workingPath = join(tempRoot, 'copyback-fail-working.pdf');
        const targetPath = join(tempRoot, 'copyback-fail-saved.pdf');
        writeFileSync(workingPath, 'unoptimized-pdf');
        writeFileSync(targetPath, 'old-pdf');
        mocks.getWorkingCopyOriginalPath.mockReturnValue(null);
        mocks.showSaveDialog.mockResolvedValue({
            canceled: false,
            filePath: targetPath,
        });
        mocks.optimizePdfForSaveAs.mockImplementationOnce(async (tempPath: string) => {
            writeFileSync(tempPath, 'optimized-pdf');
            return {
                isValid: true,
                tool: 'qpdf',
                errors: [],
                warnings: [],
            };
        });
        mocks.copyFileCopyOnWrite.mockImplementationOnce(async (sourcePath: string, copyTargetPath: string) => {
            await writeFile(copyTargetPath, await readFile(sourcePath));
        });
        mocks.copyFileCopyOnWrite.mockRejectedValueOnce(new Error('copy-back failed'));

        const { handleSavePdfAs } = await import('@electron/features/documents/main/documentSaveDialogHandlers');

        await expect(handleSavePdfAs(
            dialogContext,
            workingPath,
            { optimizeLossless: true },
            revisionOptions,
        )).resolves.toBe(targetPath);

        expect(readFileSyncUtf8(targetPath)).toBe('optimized-pdf');
        expect(readFileSyncUtf8(workingPath)).toBe('unoptimized-pdf');
        expect(mocks.setWorkingCopyOriginalPath).toHaveBeenCalledWith(workingPath, targetPath, 42);
        expect(mocks.markWorkingCopySyncRequired).toHaveBeenCalledWith(
            workingPath,
            expect.stringContaining('copy-back failed'),
        );
        expect(mocks.markWorkingCopyContentChanged).not.toHaveBeenCalled();
        expect(mocks.allowOpenPath).toHaveBeenCalledWith(targetPath, sender);
    });

    it('returns the committed target when Save As remapping fails', async () => {
        const workingPath = join(tempRoot, 'remap-fail-working.pdf');
        const targetPath = join(tempRoot, 'remap-fail-saved.pdf');
        writeFileSync(workingPath, 'new-pdf');
        writeFileSync(targetPath, 'old-pdf');
        mocks.getWorkingCopyOriginalPath.mockReturnValue(null);
        mocks.showSaveDialog.mockResolvedValue({
            canceled: false,
            filePath: targetPath,
        });
        mocks.setWorkingCopyOriginalPath.mockRejectedValueOnce(new Error('remap failed'));

        const { handleSavePdfAs } = await import('@electron/features/documents/main/documentSaveDialogHandlers');

        await expect(handleSavePdfAs(
            dialogContext,
            workingPath,
            undefined,
            revisionOptions,
        )).resolves.toBe(targetPath);

        expect(readFileSyncUtf8(targetPath)).toBe('new-pdf');
        expect(readFileSyncUtf8(workingPath)).toBe('new-pdf');
        expect(mocks.setWorkingCopyOriginalPath).toHaveBeenCalledWith(workingPath, targetPath, 42);
        expect(mocks.markWorkingCopySyncRequired).toHaveBeenCalledWith(
            workingPath,
            expect.stringContaining('remap failed'),
        );
        expect(mocks.markWorkingCopyContentChanged).not.toHaveBeenCalled();
        expect(mocks.allowOpenPath).toHaveBeenCalledWith(targetPath, sender);
    });

    it('does not copy the working PDF when validation fails', async () => {
        const workingPath = join(tempRoot, 'working.pdf');
        const targetPath = join(tempRoot, 'saved.pdf');
        const tempPath = `${targetPath}.tmp`;
        writeFileSync(workingPath, 'not-pdf');
        writeFileSync(targetPath, 'old-pdf');
        mocks.getWorkingCopyOriginalPath.mockReturnValue(null);
        mocks.showSaveDialog.mockResolvedValue({
            canceled: false,
            filePath: targetPath,
        });
        mocks.validatePdfFile.mockResolvedValue({
            isValid: false,
            issues: ['invalid'],
            metadata: null,
        });

        const { handleSavePdfAs } = await import('@electron/features/documents/main/documentSaveDialogHandlers');

        await expect(handleSavePdfAs(
            dialogContext,
            workingPath,
            undefined,
            revisionOptions,
        ))
            .rejects
            .toThrow('Working copy is not a valid PDF');

        expect(mocks.validatePdfFile).toHaveBeenCalledWith(workingPath);
        expect(mocks.atomicReplace).not.toHaveBeenCalled();
        expect(readFileSyncUtf8(targetPath)).toBe('old-pdf');
        expect(existsSync(tempPath)).toBe(false);
        expect(mocks.allowOpenPath).not.toHaveBeenCalled();
    });

    it('cleans the sibling temp path and preserves the existing target when replacement fails', async () => {
        const workingPath = join(tempRoot, 'working.pdf');
        const originalPath = join(tempRoot, 'original.pdf');
        const targetPath = join(tempRoot, 'saved.pdf');
        const tempPath = `${targetPath}.tmp`;
        writeFileSync(workingPath, 'new-pdf');
        writeFileSync(targetPath, 'old-pdf');
        mocks.getWorkingCopyOriginalPath.mockReturnValue({originalPath});
        mocks.showSaveDialog.mockResolvedValue({
            canceled: false,
            filePath: targetPath,
        });
        mocks.atomicReplace.mockRejectedValue(new Error('replace failed'));

        const { handleSavePdfAs } = await import('@electron/features/documents/main/documentSaveDialogHandlers');

        await expect(handleSavePdfAs(
            dialogContext,
            workingPath,
            undefined,
            revisionOptions,
        ))
            .rejects
            .toThrow('replace failed');

        expect(readFileSyncUtf8(targetPath)).toBe('old-pdf');
        expect(existsSync(tempPath)).toBe(false);
        expect(mocks.workingCopyMap.has(workingPath)).toBe(false);
        expect(mocks.allowOpenPath).not.toHaveBeenCalled();
        expect(mocks.addRecentFile).not.toHaveBeenCalled();
        expect(mocks.updateRecentFilesMenu).not.toHaveBeenCalled();
    });

});

function readFileSyncUtf8(path: string) {
    return readFileSync(path, 'utf8');
}
