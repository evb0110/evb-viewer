import type * as TViMockOriginalModule from '@app/utils/platformDocuments';
import type * as TViMockOriginalModule2 from '@app/utils/viewerAssets';

import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {requireDocumentRef} from '@contracts/documentRef';

const mocks = vi.hoisted(() => {
    const documentOpen = {openDocumentDirect: vi.fn()};
    const documentPicker = {openDocumentDialog: vi.fn()};
    const documentFiles = {
        statFile: vi.fn(),
        readFile: vi.fn(),
        readFileRange: vi.fn(),
        writeFile: vi.fn(),
        savePdfDialog: vi.fn(),
    };

    return {
        documentOpen,
        documentFiles,
        documentPicker,
        hasElectronAPI: vi.fn(() => true),
        search: {source: 'search'},
        settings: {source: 'settings'},
        shell: {source: 'shell'},
    };
});

vi.mock('@app/utils/platform', () => ({hasElectronAPI: () => mocks.hasElectronAPI()}));

vi.mock('@app/utils/platformDocuments', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    getDocumentFilesCapability: () => mocks.documentFiles,
    getDocumentOpenCapability: () => mocks.documentOpen,
    getDocumentPickerCapability: () => mocks.documentPicker,
}));
vi.mock('@app/utils/getSearchCapability', () => ({getSearchCapability: () => mocks.search}));
vi.mock('@app/utils/getSettingsCapability', () => ({getSettingsCapability: () => mocks.settings}));
vi.mock('@app/utils/getShellCapability', () => ({getShellCapability: () => mocks.shell}));
vi.mock('@app/utils/viewerAssets', async (importOriginal_1) => ({
    ...(await importOriginal_1<typeof TViMockOriginalModule2>()),
    getViewerAssetResolver: () => ({pdfWorkerUrl: () => '/pdf.worker.js'}),
}));

const { getViewerHostApi } = await import('@app/utils/getViewerHostApi');

describe('getViewerHostApi', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.documentFiles.statFile.mockResolvedValue({size: 123});
        mocks.documentFiles.readFile.mockResolvedValue(Uint8Array.from([
            1,
            2,
        ]));
        mocks.documentFiles.readFileRange.mockResolvedValue(Uint8Array.from([3]));
        mocks.documentPicker.openDocumentDialog.mockResolvedValue(null);
        mocks.documentOpen.openDocumentDirect.mockResolvedValue({
            kind: 'pdf',
            originalPath: '/tmp/recent.pdf',
            workingPath: '/tmp/recent-working.pdf',
        });
        mocks.documentFiles.writeFile.mockResolvedValue(true);
        mocks.documentFiles.savePdfDialog.mockResolvedValue('/tmp/saved.pdf');
    });

    it('routes viewer host stat and raw reads through documentFiles when available', async () => {
        const hostApi = getViewerHostApi();

        await expect(hostApi.documents.stat(requireDocumentRef('/tmp/source.pdf'))).resolves.toEqual({size: 123});
        await expect(hostApi.documents.read(requireDocumentRef('/tmp/source.pdf'))).resolves.toEqual(Uint8Array.from([
            1,
            2,
        ]));
        await expect(hostApi.documents.readRange(requireDocumentRef('/tmp/source.pdf'), 10, 5)).resolves.toEqual(Uint8Array.from([3]));

        expect(mocks.documentFiles.statFile).toHaveBeenCalledWith('/tmp/source.pdf');
        expect(mocks.documentFiles.readFile).toHaveBeenCalledWith('/tmp/source.pdf');
        expect(mocks.documentFiles.readFileRange).toHaveBeenCalledWith('/tmp/source.pdf', 10, 5);
    });

    it('routes viewer host picker, open, and saves through split capabilities when available', async () => {
        const hostApi = getViewerHostApi();
        const {
            openRecent,
            pickDocument,
            save,
            saveAs,
        } = hostApi.documents;
        const bytes = Uint8Array.from([
            4,
            5,
        ]);

        if (!pickDocument || !openRecent || !save || !saveAs) {
            throw new Error('Expected viewer host document output methods');
        }

        await expect(pickDocument()).resolves.toBeNull();
        await expect(openRecent(requireDocumentRef('/tmp/recent.pdf'))).resolves.toEqual({
            kind: 'pdf',
            originalPath: '/tmp/recent.pdf',
            workingPath: '/tmp/recent-working.pdf',
        });
        await expect(save(requireDocumentRef('/tmp/output.pdf'), bytes)).resolves.toBe('/tmp/output.pdf');
        await expect(saveAs('output.pdf', bytes)).resolves.toBe('/tmp/saved.pdf');

        expect(mocks.documentPicker.openDocumentDialog).toHaveBeenCalledOnce();
        expect(mocks.documentOpen.openDocumentDirect).toHaveBeenCalledWith('/tmp/recent.pdf');
        expect(mocks.documentFiles.savePdfDialog).toHaveBeenCalledWith('output.pdf');
        expect(mocks.documentFiles.writeFile).toHaveBeenCalledWith('/tmp/output.pdf', bytes);
        expect(mocks.documentFiles.writeFile).toHaveBeenCalledWith('/tmp/saved.pdf', bytes);
    });
});
