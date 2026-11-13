import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {cast} from '@tests/helpers/cast';
import type {IOpenDocument} from '@electron/file-access/documentStore';

const mocks = vi.hoisted(() => ({
    app: {
        isPackaged: false,
        on: vi.fn(),
    },
    existsSync: vi.fn<(path: string) => boolean>(() => false),
    resolveAllowedReadPath: vi.fn(),
    findWorkingCopyPathByOriginalPath: vi.fn(),
}));

vi.mock('electron', () => ({
    app: mocks.app,
    ipcMain: {handle: vi.fn()},
    webContents: {fromId: vi.fn(() => null)},
}));
vi.mock('fs', () => ({existsSync: mocks.existsSync}));

vi.mock('@electron/utils/pathValidator', () => ({resolveAllowedReadPath: mocks.resolveAllowedReadPath}));

// The service resolves the request's document and reports what it admitted.
vi.mock('@electron/features/search/main/searchService', () => ({
    searchPathDeniedError: () => new Error('SEARCH_PATH_DENIED'),
    createSearchService: () => ({async run(_context: unknown, request: {resolveDocument: (signal: AbortSignal) => Promise<{documentRevision: string}>}) {
        return (await request.resolveDocument(new AbortController().signal)).documentRevision;
    }}),
}));

vi.mock('@electron/file-access/documentStore', async importOriginal => ({
    ...await importOriginal<Record<string, unknown>>(),
    findWorkingCopyPathByOriginalPath: mocks.findWorkingCopyPathByOriginalPath,
    ensureWorkingCopyMaterialized: async (path: string) => ({physicalWorkingCopyPath: path}),
}));

const STORE_ROOT = '/tmp/evb-search-store';

/** An open document of the window `ownerWebContentsId`, as the store registers it. */
function documentEntry(path: string, ownerWebContentsId: number) {
    return cast<IOpenDocument>({
        ref: path,
        doc: {id: path.split('/').at(-2)},
        ownerWebContentsId,
        registrationId: 1,
        role: 'current',
    });
}

describe('resolveSearchablePdfPath', () => {
    beforeEach(() => {
        mocks.app.isPackaged = false;
        mocks.existsSync.mockReset();
        mocks.existsSync.mockReturnValue(false);
        vi.clearAllMocks();
    });

    it('returns directly resolved temp path when available', async () => {
        const path = `${STORE_ROOT}/documents/one/document.pdf`;
        mocks.resolveAllowedReadPath.mockResolvedValueOnce(path);
        const {setDocumentStoreRootForTests} = await import('@electron/file-access/documentStore');
        await setDocumentStoreRootForTests(STORE_ROOT);

        const { resolveSearchablePdfPath } = await import('@electron/features/search/main/ipc');
        const resolved = await resolveSearchablePdfPath(path);

        expect(resolved).toBe(path);
        expect(mocks.findWorkingCopyPathByOriginalPath).not.toHaveBeenCalled();
    });

    it('falls back to mapped working copy path for original-path requests', async () => {
        mocks.resolveAllowedReadPath
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce('/tmp/pdf-work-2/working.pdf');
        mocks.findWorkingCopyPathByOriginalPath.mockReturnValue('/tmp/pdf-work-2/working.pdf');

        const { resolveSearchablePdfPath } = await import('@electron/features/search/main/ipc');
        const resolved = await resolveSearchablePdfPath('/Users/test/Documents/original.pdf', 42);

        expect(resolved).toBe('/tmp/pdf-work-2/working.pdf');
        expect(mocks.findWorkingCopyPathByOriginalPath)
            .toHaveBeenCalledWith('/Users/test/Documents/original.pdf', 42);
    });

    it('returns null when neither direct nor mapped paths are allowed', async () => {
        mocks.resolveAllowedReadPath.mockResolvedValue(null);
        mocks.findWorkingCopyPathByOriginalPath.mockReturnValue(null);

        const { resolveSearchablePdfPath } = await import('@electron/features/search/main/ipc');
        const resolved = await resolveSearchablePdfPath('/Users/test/Documents/original.pdf');

        expect(resolved).toBeNull();
    });

    it('refuses to search another window\'s working copy, whatever revision it names', async () => {
        const path = `${STORE_ROOT}/documents/victim/document.pdf`;
        mocks.resolveAllowedReadPath.mockResolvedValue(path);
        const {openDocuments: workingCopyMap, setDocumentStoreRootForTests} = await import('@electron/file-access/documentStore');
        await setDocumentStoreRootForTests(STORE_ROOT);
        workingCopyMap.set(path, documentEntry(path, 222));
        try {
            const {prepareSearchMainBindings} = await import('@electron/features/search/main/ipc');
            const {SEARCH_PLATFORM_FEATURE} = await import('@contracts/searchPlatformFeature');
            const [request] = SEARCH_PLATFORM_FEATURE.ipcCodecs['pdf:search'].decodeArgs([{
                pdfPath: path,
                query: 'PRIVATE',
                documentRevision: 'drt1:chosen-by-the-caller',
            }]);
            const search = (senderId: number) => prepareSearchMainBindings().run(cast({
                sender: {id: senderId},
                senderId,
            }), request);

            await expect(search(111)).rejects.toThrow('SEARCH_PATH_DENIED');
            await expect(search(222)).resolves.toBe('drt1:chosen-by-the-caller');
        } finally {
            workingCopyMap.delete(path);
        }
    });

    it('refuses to search a retired copy kept in quarantine, but not an open one', async () => {
        const path = `${STORE_ROOT}/documents/retired/document.pdf`;
        mocks.resolveAllowedReadPath.mockResolvedValue(path);
        const {openDocuments: workingCopyMap, setDocumentStoreRootForTests} = await import('@electron/file-access/documentStore');
        await setDocumentStoreRootForTests(STORE_ROOT);
        const {
            clearWorkingCopyQuarantinesForTests, quarantineWorkingCopy,
        } = await import('@electron/file-access/workingCopyQuarantine');
        const {prepareSearchMainBindings} = await import('@electron/features/search/main/ipc');
        const {SEARCH_PLATFORM_FEATURE} = await import('@contracts/searchPlatformFeature');
        const [request] = SEARCH_PLATFORM_FEATURE.ipcCodecs['pdf:search'].decodeArgs([{
            pdfPath: path,
            query: 'PRIVATE',
            documentRevision: 'drt1:chosen-by-the-caller',
        }]);
        const search = (senderId: number) => prepareSearchMainBindings().run(cast({
            sender: {id: senderId},
            senderId,
        }), request);
        quarantineWorkingCopy(path, 'native sidecar exit was not proven');
        try {
            // Its window still has it open: that window may search it.
            workingCopyMap.set(path, documentEntry(path, 222));
            await expect(search(222)).resolves.toBe('drt1:chosen-by-the-caller');

            // Retired: no window owns it, and its kept bytes are nobody's.
            workingCopyMap.delete(path);
            await expect(search(111)).rejects.toThrow('SEARCH_PATH_DENIED');
            await expect(search(222)).rejects.toThrow('SEARCH_PATH_DENIED');
        } finally {
            workingCopyMap.delete(path);
            clearWorkingCopyQuarantinesForTests();
        }
    });
});
