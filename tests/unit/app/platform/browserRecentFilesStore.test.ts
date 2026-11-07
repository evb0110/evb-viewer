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

    it('does not rebuild recent-files storage when IndexedDB is unavailable', async () => {
        const repository = {
            requireEntry: vi.fn(),
            getAllPersistedRecords: vi.fn(async () => ({
                available: false,
                records: [],
            })),
            cleanupEvictedRecentRefs: vi.fn(async () => undefined),
        };
        const store = new BrowserRecentFilesStore(repository);

        await expect(store.recoverRecentFilesIfStorageMissing()).resolves.toEqual([]);

        expect(repository.getAllPersistedRecords).toHaveBeenCalledOnce();
        expect(globalThis.localStorage.setItem).not.toHaveBeenCalled();
    });

    it('rebuilds an explicitly truncated migrated snapshot from IndexedDB', async () => {
        globalThis.localStorage.setItem(BROWSER_RECENT_FILES_STORAGE_KEY, JSON.stringify({
            files: [{
                originalPath: 'browser://documents/subset',
                backend: 'browser',
                fileName: 'subset.pdf',
                timestamp: 1,
            }],
            truncated: true,
        }));
        const repository = {
            requireEntry: vi.fn(),
            getAllPersistedRecords: vi.fn(async () => ({
                available: true,
                records: [{
                    ref: 'browser://documents/full',
                    fileName: 'full.pdf',
                    mimeType: 'application/pdf',
                    kind: 'source' as const,
                    retention: 'durable' as const,
                    data: new Uint8Array(),
                    fileSize: 42,
                    updatedAt: 2,
                }],
            })),
            cleanupEvictedRecentRefs: vi.fn(async () => undefined),
        };
        const store = new BrowserRecentFilesStore(repository);

        await expect(store.recoverRecentFilesIfStorageMissing()).resolves.toEqual([expect.objectContaining({originalPath: 'browser://documents/full'})]);
        expect(repository.getAllPersistedRecords).toHaveBeenCalledOnce();
    });

    it('rebuilds valid JSON with the wrong storage shape from IndexedDB', async () => {
        globalThis.localStorage.setItem(BROWSER_RECENT_FILES_STORAGE_KEY, JSON.stringify({}));
        const repository = {
            requireEntry: vi.fn(),
            getAllPersistedRecords: vi.fn(async () => ({
                available: true,
                records: [{
                    ref: 'browser://documents/recovered',
                    fileName: 'recovered.pdf',
                    mimeType: 'application/pdf',
                    kind: 'source' as const,
                    retention: 'durable' as const,
                    data: new Uint8Array(),
                    fileSize: 24,
                    updatedAt: 3,
                }],
            })),
            cleanupEvictedRecentRefs: vi.fn(async () => undefined),
        };

        const store = new BrowserRecentFilesStore(repository);
        await expect(store.recoverRecentFilesIfStorageMissing()).resolves.toEqual([expect.objectContaining({originalPath: 'browser://documents/recovered'})]);
        expect(repository.getAllPersistedRecords).toHaveBeenCalledOnce();
    });

    it('does not evict durable records when the recent-file write fails', async () => {
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
        const repository = {
            requireEntry: vi.fn(async () => ({
                retention: 'durable' as const,
                fileName: 'new.pdf',
                fileSize: 1,
                updatedAt: 31,
            })),
            getAllPersistedRecords: vi.fn(),
            cleanupEvictedRecentRefs: vi.fn(async () => undefined),
        };
        const store = new BrowserRecentFilesStore(repository);

        await expect(store.touchRecentFile('browser://documents/new.pdf'))
            .rejects.toBeInstanceOf(BrowserRecentFilesStorageUnavailableError);

        expect(repository.cleanupEvictedRecentRefs).not.toHaveBeenCalled();
        expect(JSON.parse(
            globalThis.localStorage.getItem(BROWSER_RECENT_FILES_STORAGE_KEY)!,
        )).toEqual(existingRecentFiles);
    });
});
