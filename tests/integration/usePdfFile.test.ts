import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mockElectronAPI = {
    openPdfDialog: vi.fn(),
    openPdfDirect: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    saveFile: vi.fn(),
    savePdfAs: vi.fn(),
    statFile: vi.fn(),
    cleanupFile: vi.fn(),
};

vi.mock('@app/utils/electron', () => ({getElectronAPI: () => mockElectronAPI}));

vi.mock('@app/composables/pdf/useOcrTextContent', () => ({useOcrTextContent: () => ({clearCache: vi.fn()})}));

const mockT = vi.fn((key: string) => key);
vi.stubGlobal('useI18n', () => ({ t: mockT }));

vi.stubGlobal('window', {
    ...globalThis,
    electronAPI: mockElectronAPI,
});

const { usePdfFile } = await import('@app/composables/usePdfFile');

describe('usePdfFile', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('initial state', () => {
        it('starts with null pdfSrc and pdfData', () => {
            const file = usePdfFile();

            expect(file.pdfSrc.value).toBeNull();
            expect(file.pdfData.value).toBeNull();
        });

        it('starts with no working copy path', () => {
            const file = usePdfFile();

            expect(file.workingCopyPath.value).toBeNull();
            expect(file.fileName.value).toBeNull();
        });

        it('starts clean (not dirty)', () => {
            const file = usePdfFile();

            expect(file.isDirty.value).toBe(false);
        });

        it('starts with no undo/redo available', () => {
            const file = usePdfFile();

            expect(file.canUndo.value).toBe(false);
            expect(file.canRedo.value).toBe(false);
        });
    });

    describe('openFile', () => {
        it('sets pendingDjvu for DjVu files', async () => {
            mockElectronAPI.openPdfDialog.mockResolvedValue({
                kind: 'djvu',
                originalPath: '/docs/scan.djvu',
            });

            const file = usePdfFile();
            await file.openFile();

            expect(file.pendingDjvu.value).toBe('/docs/scan.djvu');
            expect(file.pdfData.value).toBeNull();
        });

        it('loads PDF data for PDF files', async () => {
            const pdfBytes = new Uint8Array([
                0x25,
                0x50,
                0x44,
                0x46,
            ]);
            mockElectronAPI.openPdfDialog.mockResolvedValue({
                kind: 'pdf',
                originalPath: '/docs/report.pdf',
                workingPath: '/tmp/work/report.pdf',
            });
            mockElectronAPI.statFile.mockResolvedValue({ size: pdfBytes.length });
            mockElectronAPI.readFile.mockResolvedValue(pdfBytes.buffer);

            const file = usePdfFile();
            await file.openFile();

            expect(file.workingCopyPath.value).toBe('/tmp/work/report.pdf');
            expect(file.originalPath.value).toBe('/docs/report.pdf');
            expect(file.pdfData.value).toBeTruthy();
            expect(file.pdfSrc.value).toBeInstanceOf(Blob);
        });

        it('does nothing when dialog is cancelled', async () => {
            mockElectronAPI.openPdfDialog.mockResolvedValue(null);

            const file = usePdfFile();
            await file.openFile();

            expect(file.pdfSrc.value).toBeNull();
            expect(file.error.value).toBeNull();
        });

        it('sets error on failure', async () => {
            mockElectronAPI.openPdfDialog.mockRejectedValue(new Error('Access denied'));

            const file = usePdfFile();
            await file.openFile();

            expect(file.error.value).toBe('Access denied');
        });
    });

    describe('openFileDirect', () => {
        it('detects DjVu files from direct open', async () => {
            mockElectronAPI.openPdfDirect.mockResolvedValue({
                kind: 'djvu',
                originalPath: '/path/doc.djvu',
            });

            const file = usePdfFile();
            await file.openFileDirect('/path/doc.djvu');

            expect(file.pendingDjvu.value).toBe('/path/doc.djvu');
        });

        it('sets error when result is null', async () => {
            mockElectronAPI.openPdfDirect.mockResolvedValue(null);

            const file = usePdfFile();
            await file.openFileDirect('/nonexistent.pdf');

            expect(file.error.value).toBe('errors.file.invalid');
        });
    });

    describe('closeFile', () => {
        it('resets all state', async () => {
            const pdfBytes = new Uint8Array([
                1,
                2,
                3,
            ]);
            mockElectronAPI.openPdfDialog.mockResolvedValue({
                kind: 'pdf',
                originalPath: '/test.pdf',
                workingPath: '/tmp/test.pdf',
            });
            mockElectronAPI.statFile.mockResolvedValue({ size: 3 });
            mockElectronAPI.readFile.mockResolvedValue(pdfBytes.buffer);
            mockElectronAPI.cleanupFile.mockResolvedValue(undefined);

            const file = usePdfFile();
            await file.openFile();

            expect(file.pdfSrc.value).not.toBeNull();

            await file.closeFile();

            expect(file.pdfSrc.value).toBeNull();
            expect(file.pdfData.value).toBeNull();
            expect(file.workingCopyPath.value).toBeNull();
            expect(file.originalPath.value).toBeNull();
            expect(file.error.value).toBeNull();
            expect(file.isDirty.value).toBe(false);
        });

        it('calls cleanupFile for the working copy', async () => {
            const pdfBytes = new Uint8Array([1]);
            mockElectronAPI.openPdfDialog.mockResolvedValue({
                kind: 'pdf',
                originalPath: '/a.pdf',
                workingPath: '/tmp/a.pdf',
            });
            mockElectronAPI.statFile.mockResolvedValue({ size: 1 });
            mockElectronAPI.readFile.mockResolvedValue(pdfBytes.buffer);
            mockElectronAPI.cleanupFile.mockResolvedValue(undefined);

            const file = usePdfFile();
            await file.openFile();
            await file.closeFile();

            expect(mockElectronAPI.cleanupFile).toHaveBeenCalledWith('/tmp/a.pdf');
        });
    });

    describe('undo/redo', () => {
        async function setupWithHistory() {
            const bytes1 = new Uint8Array([
                1,
                2,
            ]);
            const bytes2 = new Uint8Array([
                3,
                4,
            ]);

            mockElectronAPI.openPdfDialog.mockResolvedValue({
                kind: 'pdf',
                originalPath: '/undo.pdf',
                workingPath: '/tmp/undo.pdf',
            });
            mockElectronAPI.statFile.mockResolvedValue({ size: 2 });
            mockElectronAPI.readFile.mockResolvedValue(bytes1.buffer);
            mockElectronAPI.writeFile.mockResolvedValue(undefined);

            const file = usePdfFile();
            await file.openFile();
            await file.loadPdfFromData(bytes2);

            return file;
        }

        it('can undo after pushing a snapshot', async () => {
            const file = await setupWithHistory();

            expect(file.canUndo.value).toBe(true);

            const result = await file.undo();
            expect(result).toBe(true);
        });

        it('can redo after undo', async () => {
            const file = await setupWithHistory();

            await file.undo();
            expect(file.canRedo.value).toBe(true);

            const result = await file.redo();
            expect(result).toBe(true);
        });

        it('returns false when nothing to undo', async () => {
            const file = usePdfFile();

            const result = await file.undo();
            expect(result).toBe(false);
        });

        it('returns false when nothing to redo', async () => {
            const file = usePdfFile();

            const result = await file.redo();
            expect(result).toBe(false);
        });
    });

    describe('markDirty', () => {
        it('marks the file as dirty', () => {
            const file = usePdfFile();

            file.markDirty();
            expect(file.isDirty.value).toBe(true);
        });
    });

    describe('saveFile', () => {
        it('returns false when no working copy path', async () => {
            const file = usePdfFile();

            const result = await file.saveFile(new Uint8Array([1]));
            expect(result).toBe(false);
        });

        it('saves and clears dirty flag', async () => {
            const pdfBytes = new Uint8Array([
                1,
                2,
            ]);
            mockElectronAPI.openPdfDialog.mockResolvedValue({
                kind: 'pdf',
                originalPath: '/save.pdf',
                workingPath: '/tmp/save.pdf',
            });
            mockElectronAPI.statFile.mockResolvedValue({ size: 2 });
            mockElectronAPI.readFile.mockResolvedValue(pdfBytes.buffer);
            mockElectronAPI.writeFile.mockResolvedValue(undefined);
            mockElectronAPI.saveFile.mockResolvedValue(undefined);

            const file = usePdfFile();
            await file.openFile();
            file.markDirty();

            expect(file.isDirty.value).toBe(true);

            const result = await file.saveFile(pdfBytes);

            expect(result).toBe(true);
            expect(file.isDirty.value).toBe(false);
        });
    });
});
