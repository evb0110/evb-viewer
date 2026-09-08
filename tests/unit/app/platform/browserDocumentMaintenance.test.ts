import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const documentIdbMocks = vi.hoisted(() => ({
    deleteRecord: vi.fn(async () => undefined),
    loadAllRecordKeysAvailability: vi.fn(),
    loadRecordAvailability: vi.fn(),
    recoveryRecordsAtDelete: [] as Array<{snapshotRefs: string[]}>,
    documentsAtDelete: [] as unknown[],
    runObjectStoresTransaction: vi.fn(async (
        _stores: string[],
        _mode: string,
        run: (transaction: unknown, setResult: (value: unknown) => void) => void,
    ) => {
        let result: unknown = null;
        const recentFilesLockRequest = {result: undefined} as {
            result: unknown;
            onsuccess?: () => void;
        };
        const recoveryRequest = {result: documentIdbMocks.recoveryRecordsAtDelete} as {
            result: unknown;
            onsuccess?: () => void;
        };
        const documentsRequest = {result: documentIdbMocks.documentsAtDelete} as {
            result: unknown;
            onsuccess?: () => void;
        };
        const transaction = {objectStore: (name: string) => ({
            getAll: () => name.includes('document') ? documentsRequest : recoveryRequest,
            get: () => recentFilesLockRequest,
            delete: name.includes('chunk')
                ? chunkMocks.deleteChunkRecord
                : documentIdbMocks.deleteRecord,
        })};
        run(transaction, value => { result = value; });
        recoveryRequest.onsuccess?.();
        documentsRequest.onsuccess?.();
        recentFilesLockRequest.onsuccess?.();
        return result;
    }),
}));

const chunkMocks = vi.hoisted(() => ({
    createChunkKey: vi.fn((ref: string, index: number, generation?: string) => (
        generation ? `${ref}::${generation}::${index}` : `${ref}::${index}`
    )),
    deleteChunkRecord: vi.fn(async () => undefined),
    loadAllChunkKeys: vi.fn(async () => []),
    loadAllChunkKeysAvailability: vi.fn(async () => ({
        available: true,
        value: [] as IDBValidKey[] | null,
    })),
    parseChunkKey: vi.fn(),
}));

const recentFilesStoreMocks = vi.hoisted(() => ({
    BROWSER_RECENT_FILES_STORAGE_LOCK_KEY: '__evb_recent_files_storage_lock__',
    hasRecentFilesStorageSnapshot: vi.fn(() => false),
    pruneRecentFiles: vi.fn((recentFiles: unknown[]) => ({
        recentFiles,
        evictedRefs: [] as string[],
    })),
    readRecentFilesFromStorage: vi.fn((): Array<{
        originalPath: string;
        backend: 'browser';
        fileName: string;
        timestamp: number;
        fileSize: number;
    }> => []),
    tryHasRecentFilesStorageSnapshot: vi.fn(() => false),
    tryReadRecentFilesFromStorage: vi.fn((): Array<{
        originalPath: string;
        backend: 'browser';
        fileName: string;
        timestamp: number;
        fileSize: number;
    }> => []),
    runSerializedRecentFilesStorageMutation: vi.fn(async () => undefined),
    writeRecentFilesToStorage: vi.fn(),
}));
const recoveryMocks = vi.hoisted(() => ({loadBrowserWorkspaceRecoveryLeasedRefs: vi.fn(async () => new Set<string>())}));

vi.mock('@app/platform/browser/browserDocumentIdb', () => documentIdbMocks);
vi.mock('@app/platform/browser/browserDocumentChunks', () => chunkMocks);
vi.mock('@app/platform/browser/browserRecentFilesStore', () => recentFilesStoreMocks);
vi.mock('@app/platform/browser/browserWorkspaceRecoveryStore', () => recoveryMocks);

describe('browserDocumentMaintenance', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        documentIdbMocks.loadAllRecordKeysAvailability.mockResolvedValue({
            available: false,
            value: null,
        });
        chunkMocks.loadAllChunkKeysAvailability.mockResolvedValue({
            available: true,
            value: [],
        });
        recoveryMocks.loadBrowserWorkspaceRecoveryLeasedRefs.mockResolvedValue(new Set());
        documentIdbMocks.recoveryRecordsAtDelete = [];
        documentIdbMocks.documentsAtDelete = [];
        recentFilesStoreMocks.writeRecentFilesToStorage.mockReturnValue(true);
        recentFilesStoreMocks.tryReadRecentFilesFromStorage.mockImplementation(
            () => recentFilesStoreMocks.readRecentFilesFromStorage(),
        );
    });

    it('retains a working document while the recovery journal leases it', async () => {
        const { sweepBrowserDocumentMaintenance } = await import('@app/platform/browser/browserDocumentMaintenance');
        const ref = 'browser://documents/recovery.pdf';
        documentIdbMocks.loadAllRecordKeysAvailability.mockResolvedValue({
            available: true,
            value: [ref],
        });
        documentIdbMocks.loadRecordAvailability.mockResolvedValue({
            available: true,
            value: {
                ref,
                fileName: 'recovery.pdf',
                mimeType: 'application/pdf',
                kind: 'working',
                retention: 'durable',
                data: Uint8Array.of(1),
                fileSize: 1,
                updatedAt: 1,
                storageMode: 'inline',
                chunkCount: 0,
                chunkSize: 4,
            },
        });
        recoveryMocks.loadBrowserWorkspaceRecoveryLeasedRefs.mockResolvedValue(new Set([ref]));

        await sweepBrowserDocumentMaintenance(new Map());

        expect(documentIdbMocks.deleteRecord).not.toHaveBeenCalledWith(ref);
    });

    it('rechecks a recovery lease committed while a destructive sweep is running', async () => {
        const { sweepBrowserDocumentMaintenance } = await import('@app/platform/browser/browserDocumentMaintenance');
        const ref = 'browser://documents/recovery-race.pdf';
        documentIdbMocks.loadAllRecordKeysAvailability.mockResolvedValue({
            available: true,
            value: [ref],
        });
        documentIdbMocks.loadRecordAvailability.mockResolvedValue({
            available: true,
            value: {
                ref,
                fileName: 'recovery-race.pdf',
                mimeType: 'application/pdf',
                kind: 'working',
                retention: 'transient',
                data: Uint8Array.of(1),
                fileSize: 1,
                updatedAt: 1,
                storageMode: 'inline',
                chunkCount: 0,
                chunkSize: 4,
            },
        });
        recoveryMocks.loadBrowserWorkspaceRecoveryLeasedRefs.mockResolvedValue(new Set());
        documentIdbMocks.recoveryRecordsAtDelete = [{snapshotRefs: [ref]}];

        await sweepBrowserDocumentMaintenance(new Map());

        expect(documentIdbMocks.deleteRecord).not.toHaveBeenCalledWith(ref);
    });

    it('skips maintenance pruning when persisted IndexedDB records are unavailable', async () => {
        const { sweepBrowserDocumentMaintenance } = await import('@app/platform/browser/browserDocumentMaintenance');
        const entries = new Map([[
            'browser://documents/source.pdf',
            {
                ref: 'browser://documents/source.pdf',
                pendingLoad: null,
            },
        ]]);

        await expect(sweepBrowserDocumentMaintenance(entries as never)).resolves.toBeUndefined();

        expect(documentIdbMocks.deleteRecord).not.toHaveBeenCalled();
        expect(chunkMocks.deleteChunkRecord).not.toHaveBeenCalled();
        expect(recentFilesStoreMocks.writeRecentFilesToStorage).not.toHaveBeenCalled();
        expect(entries.has('browser://documents/source.pdf')).toBe(true);
    });

    it('skips destructive maintenance when chunk keys are unavailable', async () => {
        const { sweepBrowserDocumentMaintenance } = await import('@app/platform/browser/browserDocumentMaintenance');
        const ref = 'browser://documents/chunked.pdf';
        documentIdbMocks.loadAllRecordKeysAvailability.mockResolvedValue({
            available: true,
            value: [ref],
        });
        documentIdbMocks.loadRecordAvailability.mockResolvedValue({
            available: true,
            value: {
                ref,
                fileName: 'chunked.pdf',
                mimeType: 'application/pdf',
                kind: 'source',
                retention: 'durable',
                data: new Uint8Array(),
                fileSize: 8,
                updatedAt: 1,
                storageMode: 'chunked',
                chunkCount: 2,
                chunkSize: 4,
                chunkGeneration: 'generation',
            },
        });
        chunkMocks.loadAllChunkKeysAvailability.mockResolvedValue({
            available: false,
            value: null,
        });
        const entries = new Map([[
            ref,
            {
                ref,
                pendingLoad: null,
            },
        ]]);

        await expect(sweepBrowserDocumentMaintenance(entries as never)).resolves.toBeUndefined();

        expect(recentFilesStoreMocks.pruneRecentFiles).not.toHaveBeenCalled();
        expect(recentFilesStoreMocks.writeRecentFilesToStorage).not.toHaveBeenCalled();
        expect(documentIdbMocks.deleteRecord).not.toHaveBeenCalled();
        expect(chunkMocks.deleteChunkRecord).not.toHaveBeenCalled();
        expect(entries.has(ref)).toBe(true);
    });

    it('does not use an uncommitted pruned list as deletion authority', async () => {
        const { sweepBrowserDocumentMaintenance } = await import('@app/platform/browser/browserDocumentMaintenance');
        const ref = 'browser://documents/retained.pdf';
        const recentFile = {
            originalPath: ref,
            backend: 'browser' as const,
            fileName: 'retained.pdf',
            timestamp: 1,
            fileSize: 1,
        };
        documentIdbMocks.loadAllRecordKeysAvailability.mockResolvedValue({
            available: true,
            value: [ref],
        });
        documentIdbMocks.loadRecordAvailability.mockResolvedValue({
            available: true,
            value: {
                ref,
                fileName: 'retained.pdf',
                mimeType: 'application/pdf',
                kind: 'source',
                retention: 'durable',
                data: Uint8Array.of(1),
                fileSize: 1,
                updatedAt: 1,
                storageMode: 'inline',
                chunkCount: 0,
                chunkSize: 4,
            },
        });
        recentFilesStoreMocks.hasRecentFilesStorageSnapshot.mockReturnValue(true);
        recentFilesStoreMocks.readRecentFilesFromStorage.mockReturnValue([recentFile]);
        recentFilesStoreMocks.pruneRecentFiles.mockReturnValue({
            recentFiles: [],
            evictedRefs: [ref],
        });
        recentFilesStoreMocks.writeRecentFilesToStorage.mockReturnValue(false);

        await sweepBrowserDocumentMaintenance(new Map());

        expect(documentIdbMocks.deleteRecord).not.toHaveBeenCalledWith(ref);
    });

    it('retains a freshly staged generation while another window finishes its metadata commit', async () => {
        const { sweepBrowserDocumentMaintenance } = await import('@app/platform/browser/browserDocumentMaintenance');
        const ref = 'browser://documents/staged.pdf';
        const generation = `${Date.now().toString(36)}-staged-generation`;
        const chunkKey = `${ref}::${generation}::0`;
        documentIdbMocks.loadAllRecordKeysAvailability.mockResolvedValue({
            available: true,
            value: [ref],
        });
        documentIdbMocks.loadRecordAvailability.mockResolvedValue({
            available: true,
            value: {
                ref,
                fileName: 'staged.pdf',
                mimeType: 'application/pdf',
                kind: 'output',
                retention: 'transient',
                data: new Uint8Array(),
                fileSize: 0,
                updatedAt: 1,
                storageMode: 'inline',
                chunkCount: 0,
                chunkSize: 4,
            },
        });
        chunkMocks.loadAllChunkKeysAvailability.mockResolvedValue({
            available: true,
            value: [chunkKey],
        });
        chunkMocks.parseChunkKey.mockReturnValue({
            ref,
            index: 0,
            generation,
        });

        await sweepBrowserDocumentMaintenance(new Map());

        expect(chunkMocks.parseChunkKey).toHaveBeenCalledWith(chunkKey);
        expect(chunkMocks.deleteChunkRecord).not.toHaveBeenCalled();
    });

    it('deletes an orphaned stale chunk generation', async () => {
        const { sweepBrowserDocumentMaintenance } = await import('@app/platform/browser/browserDocumentMaintenance');
        const ref = 'browser://documents/stale.pdf';
        const generation = `${(Date.now() - 11 * 60 * 1_000).toString(36)}-stale-generation`;
        const chunkKey = `${ref}::${generation}::0`;
        documentIdbMocks.loadAllRecordKeysAvailability.mockResolvedValue({
            available: true,
            value: [ref],
        });
        documentIdbMocks.loadRecordAvailability.mockResolvedValue({
            available: true,
            value: {
                ref,
                fileName: 'stale.pdf',
                mimeType: 'application/pdf',
                kind: 'output',
                retention: 'transient',
                data: new Uint8Array(),
                fileSize: 0,
                updatedAt: 1,
                storageMode: 'inline',
                chunkCount: 0,
                chunkSize: 4,
            },
        });
        chunkMocks.loadAllChunkKeysAvailability.mockResolvedValue({
            available: true,
            value: [chunkKey],
        });
        chunkMocks.parseChunkKey.mockReturnValue({
            ref,
            index: 0,
            generation,
        });

        await sweepBrowserDocumentMaintenance(new Map());

        expect(chunkMocks.parseChunkKey).toHaveBeenCalledWith(chunkKey);
        expect(chunkMocks.deleteChunkRecord).toHaveBeenCalledWith(chunkKey);
    });

    it.each([
        [
            'inline',
            1,
            0,
            undefined,
        ],
        [
            'chunked',
            8,
            2,
            'live-generation',
        ],
    ] as const)('reads current Recent Files state at destructive admission for %s sources', async (
        storageMode,
        fileSize,
        chunkCount,
        chunkGeneration,
    ) => {
        const {sweepBrowserDocumentMaintenance} = await import('@app/platform/browser/browserDocumentMaintenance');
        const ref = `browser://documents/recent-${storageMode}.pdf`;
        const record = {
            ref,
            fileName: `${storageMode}.pdf`,
            mimeType: 'application/pdf',
            kind: 'source',
            retention: 'durable',
            data: storageMode === 'inline' ? Uint8Array.of(1) : new Uint8Array(),
            fileSize,
            updatedAt: 1,
            storageMode,
            chunkCount,
            chunkSize: 4,
            ...(chunkGeneration ? {chunkGeneration} : {}),
        };
        documentIdbMocks.loadAllRecordKeysAvailability.mockResolvedValue({
            available: true,
            value: [ref],
        });
        documentIdbMocks.loadRecordAvailability.mockResolvedValue({
            available: true,
            value: record,
        });
        documentIdbMocks.documentsAtDelete = [record];
        recentFilesStoreMocks.tryHasRecentFilesStorageSnapshot.mockReturnValue(true);
        recentFilesStoreMocks.readRecentFilesFromStorage.mockReturnValue([{
            originalPath: ref,
            backend: 'browser',
            fileName: `${storageMode}.pdf`,
            timestamp: 2,
            fileSize,
        }]);
        if (chunkGeneration) {
            const chunkKeys = [
                `${ref}::${chunkGeneration}::0`,
                `${ref}::${chunkGeneration}::1`,
            ];
            chunkMocks.loadAllChunkKeysAvailability.mockResolvedValue({
                available: true,
                value: chunkKeys,
            });
            chunkMocks.parseChunkKey.mockImplementation((key: string) => ({
                ref,
                index: Number(key.split('::').at(-1)),
                generation: chunkGeneration,
            }));
        }

        await sweepBrowserDocumentMaintenance(new Map());

        expect(documentIdbMocks.deleteRecord).not.toHaveBeenCalledWith(ref);
        expect(chunkMocks.deleteChunkRecord).not.toHaveBeenCalled();
    });

    it('still reclaims a source with no current Recent Files reference', async () => {
        const {sweepBrowserDocumentMaintenance} = await import('@app/platform/browser/browserDocumentMaintenance');
        const ref = 'browser://documents/unreferenced.pdf';
        const record = {
            ref,
            fileName: 'unreferenced.pdf',
            mimeType: 'application/pdf',
            kind: 'source',
            retention: 'durable',
            data: Uint8Array.of(1),
            fileSize: 1,
            updatedAt: 1,
            storageMode: 'inline',
            chunkCount: 0,
            chunkSize: 4,
        };
        documentIdbMocks.loadAllRecordKeysAvailability.mockResolvedValue({
            available: true,
            value: [ref],
        });
        documentIdbMocks.loadRecordAvailability.mockResolvedValue({
            available: true,
            value: record,
        });
        documentIdbMocks.documentsAtDelete = [record];
        recentFilesStoreMocks.readRecentFilesFromStorage.mockReturnValue([]);

        await sweepBrowserDocumentMaintenance(new Map());

        expect(documentIdbMocks.deleteRecord).toHaveBeenCalledWith(ref);
    });
});
