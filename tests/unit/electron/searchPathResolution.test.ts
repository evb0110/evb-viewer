import type * as TViMockOriginalModule from '@electron/file-access/workingCopyStore';

import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

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

    it('resolves the bundled search worker beside main in development', async () => {
        const { resolveSearchWorkerPath } = await import('@electron/features/search/main/ipc');

        expect(resolveSearchWorkerPath('/tmp/evb/dist-electron')).toBe('/tmp/evb/dist-electron/search-worker.js');
    });

    it('prefers the unpacked bundled search worker path in packaged builds when present', async () => {
        mocks.app.isPackaged = true;
        mocks.existsSync.mockImplementation((path: string) => String(path).includes('app.asar.unpacked'));

        const { resolveSearchWorkerPath } = await import('@electron/features/search/main/ipc');

        expect(resolveSearchWorkerPath('/Applications/EVB Viewer.app/Contents/Resources/app.asar/dist-electron'))
            .toBe('/Applications/EVB Viewer.app/Contents/Resources/app.asar.unpacked/dist-electron/search-worker.js');
    });
});
