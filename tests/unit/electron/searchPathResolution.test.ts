import type * as TViMockOriginalModule from '@electron/file-access/workingCopyStore';

import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {cast} from '@tests/helpers/cast';

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

vi.mock('@electron/file-access/workingCopyStore', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    findWorkingCopyPathByOriginalPath: mocks.findWorkingCopyPathByOriginalPath,
    normalizePathForLookup: (path: string) => path.trim(),
}));

describe('resolveSearchablePdfPath', () => {
    beforeEach(() => {
        mocks.app.isPackaged = false;
        mocks.existsSync.mockReset();
        mocks.existsSync.mockReturnValue(false);
        vi.clearAllMocks();
    });

    it('returns directly resolved temp path when available', async () => {
        mocks.resolveAllowedReadPath.mockResolvedValueOnce('/tmp/pdf-work-1/work.pdf');

        const { resolveSearchablePdfPath } = await import('@electron/features/search/main/ipc');
        const resolved = await resolveSearchablePdfPath('/tmp/pdf-work-1/work.pdf');

        expect(resolved).toBe('/tmp/pdf-work-1/work.pdf');
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
        const path = '/tmp/pdf-work-victim/document.pdf';
        mocks.resolveAllowedReadPath.mockResolvedValue(path);
        const {workingCopyMap} = await import('@electron/file-access/workingCopyStore');
        workingCopyMap.set(path, cast({
            logicalPath: path,
            originalPath: '/private/victim.pdf',
            backingState: 'materialized',
            ownerWebContentsId: 222,
            registeredAtMs: 1,
            registrationId: 1,
            role: 'current',
        }));
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
});
