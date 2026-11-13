import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    BrowserRecentFilesStorageUnavailableError,
    BrowserRecentFilesStore,
} from '@app/platform/browser/browserRecentFilesStore';
import { RECENT_FILES_LIMIT } from '@contracts/shared';
import { requireDocumentRef } from '@contracts/documentRef';
import { BROWSER_RECENT_FILES_STORAGE_KEY } from '@app/utils/browserRuntimePersistence';

describe('BrowserRecentFilesStore', () => {
    beforeEach(() => {
        const storage = new Map<string, string>();
        const localStorage = {
            getItem: vi.fn((key: string) => storage.get(key) ?? null),
            removeItem: vi.fn((key: string) => {
                storage.delete(key);
            }),
            setItem: vi.fn((key: string, value: string) => {
                storage.set(key, value);
            }),
        };
        vi.stubGlobal('localStorage', localStorage);
        vi.stubGlobal('window', {localStorage});
        vi.stubGlobal('document', {cookie: ''});
    });

    it('leaves the list as it was when the recent-file write fails', async () => {
        const existingRecentFiles = Array.from({length: RECENT_FILES_LIMIT}, (_, index) => ({
            originalPath: `browser://documents/${index}.pdf`,
            backend: 'browser' as const,
            fileName: `${index}.pdf`,
            timestamp: index,
            fileSize: 1,
        }));
        globalThis.localStorage.setItem(
            BROWSER_RECENT_FILES_STORAGE_KEY,
            JSON.stringify(existingRecentFiles),
        );
        vi.mocked(globalThis.localStorage.setItem).mockImplementation(() => {
            throw new Error('quota exceeded');
        });
        const store = new BrowserRecentFilesStore();

        await expect(store.touch(requireDocumentRef('browser://documents/new/new.pdf'), 'new.pdf', 1))
            .rejects.toBeInstanceOf(BrowserRecentFilesStorageUnavailableError);

        expect(JSON.parse(
            globalThis.localStorage.getItem(BROWSER_RECENT_FILES_STORAGE_KEY)!,
        )).toEqual(existingRecentFiles);
    });
});
