import type * as TViMockOriginalModule from '@app/utils/yieldToBrowser';

import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    BROWSER_DOCUMENT_FULL_READ_TOO_LARGE,
    BrowserDocumentReadError,
} from '@app/platform/browser/browserDocumentReadError';
import { MAX_DOCUMENT_ALLOCATION_BYTES } from '@contracts/electronApiDocuments';
import {requireDocumentRef} from '@contracts/documentRef';

const documentsMock = vi.hoisted(() => ({
    readFile: vi.fn(),
    statFile: vi.fn(),
    readFileRange: vi.fn(),
}));
const documentFilesMock = vi.hoisted(() => ({
    readFile: vi.fn(),
    statFile: vi.fn(),
    readFileRange: vi.fn(),
}));

const getPlatformApiMock = vi.hoisted(() => vi.fn<() => unknown>(() => ({ documentFiles: documentsMock })));
const yieldToBrowserMock = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('@app/utils/platform', () => ({ getPlatformAPI: () => getPlatformApiMock() }));

vi.mock('@app/utils/yieldToBrowser', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    yieldToBrowser: yieldToBrowserMock,
}));

describe('platformDocuments', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        getPlatformApiMock.mockReturnValue({ documentFiles: documentsMock });
    });

    it('prefers split document capability fields when the platform exposes them', async () => {
        const documentPicker = { source: 'documentPicker' };
        const documentOpen = { source: 'documentOpen' };
        const documentWorkingCopy = { source: 'documentWorkingCopy' };
        const documentFiles = { source: 'documentFiles' };
        const documentPdf = { source: 'documentPdf' };
        const documentRecentFiles = { source: 'documentRecentFiles' };
        const documentWindow = { source: 'documentWindow' };
        const documentMenu = { source: 'documentMenu' };
        getPlatformApiMock.mockReturnValue({
            documentPicker,
            documentOpen,
            documentWorkingCopy,
            documentFiles,
            documentPdf,
            documentRecentFiles,
            documentWindow,
            documentMenu,
        });

        const {
            getDocumentFilesCapability,
            getDocumentMenuCapability,
            getDocumentOpenCapability,
            getDocumentPdfCapability,
            getDocumentPickerCapability,
            getDocumentRecentFilesCapability,
            getDocumentWindowCapability,
            getDocumentWorkingCopyCapability,
        } = await import('@app/utils/platformDocuments');

        expect(getDocumentPickerCapability()).toBe(documentPicker);
        expect(getDocumentOpenCapability()).toBe(documentOpen);
        expect(getDocumentWorkingCopyCapability()).toBe(documentWorkingCopy);
        expect(getDocumentFilesCapability()).toBe(documentFiles);
        expect(getDocumentPdfCapability()).toBe(documentPdf);
        expect(getDocumentRecentFilesCapability()).toBe(documentRecentFiles);
        expect(getDocumentWindowCapability()).toBe(documentWindow);
        expect(getDocumentMenuCapability()).toBe(documentMenu);
    });

    it('detects when native print is unavailable for the active platform capability', async () => {
        const { isNativePrintCapabilityUnavailable } = await import('@app/utils/platformDocuments');

        expect(isNativePrintCapabilityUnavailable({
            success: false,
            error: 'Printing via the native desktop dialog is unavailable in the browser capability',
            unsupportedReason: 'requires-native-backend',
        })).toBe(true);
        expect(isNativePrintCapabilityUnavailable({
            success: false,
            error: 'Printing via the native desktop dialog is unavailable in the browser capability',
        })).toBe(false);
        expect(isNativePrintCapabilityUnavailable({
            success: false,
            error: 'Printer offline',
        })).toBe(false);
        expect(isNativePrintCapabilityUnavailable({
            success: false,
            canceled: true,
        })).toBe(false);
    });

    it('refreshes the working copy after save-as only for browser-backed saved refs', async () => {
        const { shouldRefreshWorkingCopyAfterSaveAs } = await import('@app/utils/platformDocuments');

        expect(shouldRefreshWorkingCopyAfterSaveAs(requireDocumentRef('browser://documents/source.pdf'), requireDocumentRef('browser://documents/working.pdf'))).toBe(true);
        expect(shouldRefreshWorkingCopyAfterSaveAs(requireDocumentRef('/tmp/source.pdf'), requireDocumentRef('/tmp/working.pdf'))).toBe(false);
        expect(shouldRefreshWorkingCopyAfterSaveAs(requireDocumentRef('browser://documents/working.pdf'), requireDocumentRef('browser://documents/working.pdf'))).toBe(false);
        expect(shouldRefreshWorkingCopyAfterSaveAs(null, requireDocumentRef('browser://documents/working.pdf'))).toBe(false);
    });

    it('returns the direct file read when the capability allows it', async () => {
        documentsMock.readFile.mockResolvedValueOnce(new Uint8Array([
            1,
            2,
            3,
        ]));

        const { readDocumentFileFully } = await import('@app/utils/platformDocuments');
        await expect(readDocumentFileFully(requireDocumentRef('browser://documents/small.pdf'))).resolves.toEqual(new Uint8Array([
            1,
            2,
            3,
        ]));

        expect(documentsMock.statFile).not.toHaveBeenCalled();
        expect(documentsMock.readFileRange).not.toHaveBeenCalled();
    });

    it('reassembles a large browser document from range reads after the full-read limit error', async () => {
        const largeChunkSize = 4 * 1024 * 1024;
        getPlatformApiMock.mockReturnValueOnce({documentFiles: documentFilesMock});
        documentFilesMock.readFile.mockRejectedValueOnce(new BrowserDocumentReadError(
            BROWSER_DOCUMENT_FULL_READ_TOO_LARGE,
            'Browser document is too large to load fully into memory (huge.pdf: 128MB > 64MB limit)',
        ));
        documentFilesMock.statFile.mockResolvedValueOnce({ size: (largeChunkSize * 2) + 1 });
        documentFilesMock.readFileRange
            .mockResolvedValueOnce(new Uint8Array(largeChunkSize).fill(1))
            .mockResolvedValueOnce(new Uint8Array(largeChunkSize).fill(2))
            .mockResolvedValueOnce(new Uint8Array([3]));

        const { readDocumentFileFully } = await import('@app/utils/platformDocuments');
        const result = await readDocumentFileFully(requireDocumentRef('browser://documents/huge.pdf'));

        expect(result.byteLength).toBe((largeChunkSize * 2) + 1);
        expect(result[0]).toBe(1);
        expect(result[largeChunkSize - 1]).toBe(1);
        expect(result[largeChunkSize]).toBe(2);
        expect(result[(largeChunkSize * 2) - 1]).toBe(2);
        expect(result.at(-1)).toBe(3);
        expect(documentFilesMock.readFile).toHaveBeenCalledWith('browser://documents/huge.pdf');
        expect(documentFilesMock.statFile).toHaveBeenCalledWith('browser://documents/huge.pdf');
        expect(documentFilesMock.readFileRange).toHaveBeenCalledTimes(3);
        expect(yieldToBrowserMock).toHaveBeenCalledTimes(2);
    });

    it('rejects an oversized fallback allocation before requesting any ranges', async () => {
        documentsMock.readFile.mockRejectedValueOnce(new BrowserDocumentReadError(
            BROWSER_DOCUMENT_FULL_READ_TOO_LARGE,
            'Browser document is too large for a direct read',
        ));
        documentsMock.statFile.mockResolvedValueOnce({ size: MAX_DOCUMENT_ALLOCATION_BYTES + 1 });

        const { readDocumentFileFully } = await import('@app/utils/platformDocuments');
        await expect(readDocumentFileFully(requireDocumentRef('browser://documents/oversized.pdf')))
            .rejects
            .toThrow(`no greater than ${MAX_DOCUMENT_ALLOCATION_BYTES} bytes`);
        expect(documentsMock.readFileRange).not.toHaveBeenCalled();
    });

    it('fails the fallback read when a range read returns no bytes before EOF', async () => {
        documentsMock.readFile.mockRejectedValueOnce(new BrowserDocumentReadError(
            BROWSER_DOCUMENT_FULL_READ_TOO_LARGE,
            'Browser document is too large to load fully into memory (huge.pdf: 128MB > 64MB limit)',
        ));
        documentsMock.statFile.mockResolvedValueOnce({ size: 4 });
        documentsMock.readFileRange.mockResolvedValueOnce(new Uint8Array());

        const { readDocumentFileFully } = await import('@app/utils/platformDocuments');
        await expect(readDocumentFileFully(requireDocumentRef('browser://documents/huge.pdf'))).rejects.toThrow(
            'Range read returned no bytes before EOF at offset 0 of 4',
        );

        expect(documentsMock.readFileRange).toHaveBeenCalledTimes(1);
        expect(yieldToBrowserMock).not.toHaveBeenCalled();
    });

    it('does not swallow unrelated read failures', async () => {
        documentsMock.readFile.mockRejectedValueOnce(new Error('Permission denied'));

        const { readDocumentFileFully } = await import('@app/utils/platformDocuments');
        await expect(readDocumentFileFully(requireDocumentRef('browser://documents/forbidden.pdf'))).rejects.toThrow('Permission denied');

        expect(documentsMock.statFile).not.toHaveBeenCalled();
        expect(documentsMock.readFileRange).not.toHaveBeenCalled();
    });

    it('does not fall back for unrelated errors that reuse the old browser limit text', async () => {
        documentsMock.readFile.mockRejectedValueOnce(new Error(
            'Browser document is too large to load fully into memory (not actually typed)',
        ));

        const { readDocumentFileFully } = await import('@app/utils/platformDocuments');
        await expect(readDocumentFileFully(requireDocumentRef('browser://documents/huge.pdf'))).rejects.toThrow(
            'Browser document is too large to load fully into memory',
        );

        expect(documentsMock.statFile).not.toHaveBeenCalled();
        expect(documentsMock.readFileRange).not.toHaveBeenCalled();
    });
});
