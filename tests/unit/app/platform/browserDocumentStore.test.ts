import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    BROWSER_MAX_FULL_READ_BYTES,
    BROWSER_MAX_RECENT_FILES_PERSISTED_BYTES,
    BrowserDocumentStore,
} from '@app/platform/browserDocumentStore';
import {
    createFileSystemFileHandle,
    FakeIndexedDbFactory,
    MemoryStorage,
} from '@tests/unit/app/platform/browserPlatformTestDoubles';
import {onBrowserDocumentPersistenceWarning} from '@app/platform/browser/browserDocumentPersistenceWarnings';

const PDF_SOURCE_OPTIONS = {
    mimeType: 'application/pdf',
    kind: 'source',
    saveKind: 'pdf',
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function createStoredPdf(
    store: BrowserDocumentStore,
    fileName: string,
    data: Uint8Array,
    options: Partial<Parameters<BrowserDocumentStore['createStoredDocument']>[2]> = {},
) {
    return store.createStoredDocument(fileName, data, {
        ...PDF_SOURCE_OPTIONS,
        ...options,
    });
}

describe('BrowserDocumentStore', () => {
    let indexedDbFactory: FakeIndexedDbFactory;
    let localStorage: MemoryStorage;

    beforeEach(() => {
        vi.unstubAllGlobals();
        indexedDbFactory = new FakeIndexedDbFactory();
        localStorage = new MemoryStorage();
        vi.stubGlobal('indexedDB', indexedDbFactory);
        vi.stubGlobal('window', {localStorage});
        vi.stubGlobal('document', {cookie: ''});
    });

    it('rehydrates persisted save targets with the original file handle', async () => {
        const handle = createFileSystemFileHandle({
            name: 'saved-report.pdf',
            getFile: vi.fn(async () => new File([], 'saved-report.pdf')),
        });
        const store = new BrowserDocumentStore();
        const ref = await store.createStoredDocument(
            'report.pdf',
            Uint8Array.of(1, 2, 3),
            {
                ...PDF_SOURCE_OPTIONS,
                saveHandle: handle,
            },
        );

        await store.assignSaveTarget(ref, 'saved-report.pdf', 'pdf', handle);
        await store.touchRecentFile(ref);

        const rehydratedStore = new BrowserDocumentStore();
        await expect(rehydratedStore.getSaveTarget(ref)).resolves.toEqual({
            saveName: 'saved-report.pdf',
            saveKind: 'pdf',
            saveHandle: handle,
        });
    });

    it('opens a fresh source version when a physical handle is reopened', async () => {
        const persistedHandle = createFileSystemFileHandle({
            name: 'same-entry.pdf',
            getFile: vi.fn(async () => new File([Uint8Array.of(1)], 'same-entry.pdf', {lastModified: 7})),
            isSameEntry: vi.fn(async (_candidate: FileSystemHandle) => false),
        });
        const reopenedHandle = createFileSystemFileHandle({
            name: 'same-entry.pdf',
            getFile: vi.fn(async () => new File([Uint8Array.of(1)], 'same-entry.pdf', {lastModified: 7})),
            isSameEntry: vi.fn(async (candidate: FileSystemHandle) => candidate === persistedHandle),
        });
        const firstWindow = new BrowserDocumentStore();
        const firstRef = await firstWindow.registerFile(
            new File([Uint8Array.of(1)], 'same-entry.pdf', {
                type: 'application/pdf',
                lastModified: 7,
            }),
            {
                kind: 'source',
                saveKind: 'pdf',
                saveHandle: persistedHandle,
            },
        );

        const secondWindow = new BrowserDocumentStore();
        const secondRef = await secondWindow.registerFile(
            new File([Uint8Array.of(1)], 'same-entry.pdf', {
                type: 'application/pdf',
                lastModified: 7,
            }),
            {
                kind: 'source',
                saveKind: 'pdf',
                saveHandle: reopenedHandle,
            },
        );

        expect(secondRef).not.toBe(firstRef);
        await expect(firstWindow.read(firstRef)).resolves.toEqual(Uint8Array.of(1));
        await expect(secondWindow.read(secondRef)).resolves.toEqual(Uint8Array.of(1));
    });

    it('forgets a replaced file handle before deduping a later registration', async () => {
        const handle = createFileSystemFileHandle({
            name: 'replaced.pdf',
            getFile: vi.fn(async () => new File([Uint8Array.of(1)], 'replaced.pdf')),
        });
        const store = new BrowserDocumentStore();
        const originalFile = new File([Uint8Array.of(1)], 'replaced.pdf', {type: 'application/pdf'});
        const originalRef = await store.registerFile(originalFile, {
            kind: 'source',
            saveKind: 'pdf',
            saveHandle: handle,
        });

        await store.registerFile(originalFile, {saveHandle: null});
        const nextRef = await store.registerFile(
            new File([Uint8Array.of(1)], 'replaced.pdf', {type: 'application/pdf'}),
            {
                kind: 'source',
                saveKind: 'pdf',
                saveHandle: handle,
            },
        );

        expect(nextRef).not.toBe(originalRef);
    });

    it('uses the latest save name when refreshing recent files', async () => {
        const handle = createFileSystemFileHandle({name: 'saved-report.pdf'});
        const store = new BrowserDocumentStore();
        const ref = await store.createStoredDocument(
            'report.pdf',
            Uint8Array.of(1, 2, 3),
            {
                ...PDF_SOURCE_OPTIONS,
                saveHandle: handle,
            },
        );

        await store.assignSaveTarget(ref, 'saved-report.pdf', 'pdf', handle);
        await store.touchRecentFile(ref);

        expect(store.getRecentFiles()).toEqual([expect.objectContaining({
            originalPath: ref,
            fileName: 'saved-report.pdf',
        })]);
    });

    it('dedupes stored recent files by original path', async () => {
        const store = new BrowserDocumentStore();
        const ref = await createStoredPdf(store, 'report.pdf', Uint8Array.of(1));
        localStorage.setItem('evb-viewer:browser:recentFiles', JSON.stringify([
            {
                originalPath: ref,
                fileName: 'report-new.pdf',
                timestamp: 3,
                fileSize: 1,
            },
            {
                originalPath: ref,
                fileName: 'report-old.pdf',
                timestamp: 1,
                fileSize: 1,
            },
        ]));

        expect(store.getRecentFiles()).toEqual([expect.objectContaining({
            originalPath: ref,
            fileName: 'report-new.pdf',
        })]);
    });

    it('rehydrates persisted bytes after unloading in-memory data', async () => {
        const store = new BrowserDocumentStore();
        const ref = await store.createStoredDocument(
            'report.pdf',
            Uint8Array.of(4, 5, 6),
            {...PDF_SOURCE_OPTIONS},
        );

        store.unload(ref);

        await expect(store.read(ref)).resolves.toEqual(Uint8Array.of(4, 5, 6));
    });

    it('reports unavailable storage separately from a missing persisted record', async () => {
        const store = new BrowserDocumentStore();
        const ref = await createStoredPdf(store, 'unavailable.pdf', Uint8Array.of(1));

        store.unload(ref);
        vi.stubGlobal('indexedDB', undefined);

        await expect(store.ensureEntryAvailability(ref)).resolves.toEqual({
            available: false,
            entry: null,
        });
        await expect(store.ensureEntry(ref)).resolves.toBeNull();
    });

    it('rehydrates persisted bytes after write with unloadAfterPersist', async () => {
        const store = new BrowserDocumentStore();
        const ref = await store.createStoredDocument(
            'report.pdf',
            Uint8Array.of(1, 1, 1),
            {...PDF_SOURCE_OPTIONS},
        );

        await store.write(ref, Uint8Array.of(7, 8, 9), { unloadAfterPersist: true });

        await expect(store.read(ref)).resolves.toEqual(Uint8Array.of(7, 8, 9));
    });

    it('does not reuse a stale source ref for a different file with the same name and size', async () => {
        const firstFile = new File([Uint8Array.of(1, 2, 3)], 'same.pdf', { type: 'application/pdf' });
        const secondFile = new File([Uint8Array.of(4, 5, 6)], 'same.pdf', { type: 'application/pdf' });
        const store = new BrowserDocumentStore();

        const firstRef = store.getRefForFile(firstFile);
        const sameInstanceRef = store.getRefForFile(firstFile);
        const secondRef = store.getRefForFile(secondFile);

        expect(sameInstanceRef).toBe(firstRef);
        expect(secondRef).not.toBe(firstRef);
        await expect(store.read(firstRef)).resolves.toEqual(Uint8Array.of(1, 2, 3));
        await expect(store.read(secondRef)).resolves.toEqual(Uint8Array.of(4, 5, 6));
    });

    it('keeps physical-handle authority while opening a replaced source version', async () => {
        const firstFile = new File([Uint8Array.of(1, 2, 3)], 'same-entry.pdf', { type: 'application/pdf' });
        const secondFile = new File([Uint8Array.of(4, 5, 6)], 'same-entry.pdf', { type: 'application/pdf' });
        const firstHandle = createFileSystemFileHandle({
            name: 'same-entry.pdf',
            isSameEntry: vi.fn(async (_other: FileSystemHandle) => true),
        });
        const secondHandle = createFileSystemFileHandle({name: 'same-entry.pdf'});
        const store = new BrowserDocumentStore();

        const firstRef = await store.registerFile(firstFile, {
            kind: 'source',
            saveKind: 'pdf',
            saveHandle: firstHandle,
        });
        const secondRef = await store.registerFile(secondFile, {
            kind: 'source',
            saveKind: 'pdf',
            saveHandle: secondHandle,
        });

        expect(secondRef).not.toBe(firstRef);
        await store.touchRecentFile(secondRef);
        expect(store.getRecentFiles().map(file => file.originalPath)).toEqual([secondRef]);
        await expect(store.read(firstRef)).resolves.toEqual(Uint8Array.of(1, 2, 3));
        await expect(store.read(secondRef)).resolves.toEqual(Uint8Array.of(4, 5, 6));
    });

    it('rejects a same-size same-mtime source replacement using the content witness', async () => {
        let currentBytes = Uint8Array.of(1, 2, 3, 4);
        const getFile = vi.fn(async () => new File(
            [currentBytes],
            'witness.pdf',
            {
                type: 'application/pdf',
                lastModified: 11,
            },
        ));
        const handle = createFileSystemFileHandle({
            name: 'witness.pdf',
            getFile,
        });
        const store = new BrowserDocumentStore();
        const ref = await store.registerFile(
            new File([currentBytes], 'witness.pdf', {
                type: 'application/pdf',
                lastModified: 11,
            }),
            {
                kind: 'source',
                saveKind: 'pdf',
                saveHandle: handle,
            },
        );
        const revision = await store.getDocumentRevision(ref);

        currentBytes = Uint8Array.of(9, 8, 7, 6);

        await expect(store.assertDocumentRevisionCurrent(ref, revision.token))
            .rejects
            .toMatchObject({code: 'STALE_REVISION'});
        await expect(store.read(ref)).resolves.toEqual(Uint8Array.of(1, 2, 3, 4));
        expect(getFile).toHaveBeenCalled();
    });

    it('rejects document creation when durable IndexedDB writes cannot commit', async () => {
        vi.stubGlobal('indexedDB', undefined);
        const store = new BrowserDocumentStore();

        await expect(createStoredPdf(store, 'failed.pdf', Uint8Array.of(1))).rejects.toThrow('IndexedDB document write did not commit');

        expect(store.getRecentFiles()).toEqual([]);
    });

    it('keeps picked files open in memory and reports a persistence warning when IndexedDB is unavailable', async () => {
        vi.stubGlobal('indexedDB', undefined);
        const warnings: string[] = [];
        const unsubscribe = onBrowserDocumentPersistenceWarning(({fileName}) => {
            warnings.push(fileName);
        });
        const store = new BrowserDocumentStore();
        const bytes = Uint8Array.of(7, 4, 1);

        const ref = await store.registerFile(new File(
            [bytes],
            'volatile.pdf',
            {type: 'application/pdf'},
        ));

        await expect(store.read(ref)).resolves.toEqual(bytes);
        expect(warnings).toEqual(['volatile.pdf']);
        unsubscribe();

        const rehydratedStore = new BrowserDocumentStore();
        await expect(rehydratedStore.ensureEntry(ref)).resolves.toBeNull();
    });

    it('does not unload a picked source when persistence falls back to memory', async () => {
        const bytes = Uint8Array.of(7, 4, 1);
        const store = new BrowserDocumentStore();
        vi.stubGlobal('indexedDB', undefined);
        const sourceRef = await store.registerFile(
            new File([bytes], 'volatile.pdf', {type: 'application/pdf'}),
            {
                kind: 'source',
                saveKind: 'pdf',
            },
        );

        expect((await store.requireEntry(sourceRef)).memoryOnly).toBe(true);
        vi.stubGlobal('indexedDB', indexedDbFactory);
        const workingRef = await store.cloneAsWorkingCopy(sourceRef);
        store.unload(sourceRef);

        await expect(store.read(workingRef)).resolves.toEqual(bytes);
        await expect(store.read(sourceRef)).resolves.toEqual(bytes);
    });

    it('keeps a memory-only working copy usable when IndexedDB is unavailable', async () => {
        const bytes = Uint8Array.of(2, 4, 6);
        vi.stubGlobal('indexedDB', undefined);
        const store = new BrowserDocumentStore();
        const sourceRef = await store.registerFile(new File([bytes], 'volatile.pdf', {type: 'application/pdf'}));

        const workingRef = await store.cloneAsWorkingCopy(sourceRef);

        expect((await store.requireEntry(workingRef)).memoryOnly).toBe(true);
        await expect(store.read(workingRef)).resolves.toEqual(bytes);
    });

    it('rolls back an in-memory write when the durable write cannot commit', async () => {
        const store = new BrowserDocumentStore();
        const ref = await store.createStoredDocument(
            'rollback.pdf',
            Uint8Array.of(1, 2, 3),
            {
                mimeType: 'application/pdf',
                kind: 'working',
                saveKind: 'pdf',
            },
        );

        vi.stubGlobal('indexedDB', undefined);

        const revision = await store.getDocumentRevision(ref);

        await expect(store.write(ref, Uint8Array.of(9, 8, 7), {expectedDocumentRevisionToken: revision.token})).rejects.toThrow('IndexedDB document write did not commit');
        await expect(store.read(ref)).resolves.toEqual(Uint8Array.of(1, 2, 3));
    });

    it('clears failed pending file loads instead of keeping a poisoned pendingLoad', async () => {
        const store = new BrowserDocumentStore();
        const file = new File([Uint8Array.of(1, 2, 3)], 'broken.pdf', {type: 'application/pdf'});
        vi.spyOn(file, 'arrayBuffer').mockImplementation(async () => {
            throw new Error('read failed');
        });

        const ref = store.getRefForFile(file);

        await expect(store.requireEntry(ref)).rejects.toThrow('Browser document not found');
        await expect(store.exists(ref)).resolves.toBe(false);
    });

    it('sweeps stale working copies and detached records on the next session', async () => {
        const store = new BrowserDocumentStore();
        const recentSourceRef = await createStoredPdf(store, 'recent.pdf', Uint8Array.of(1));
        await store.touchRecentFile(recentSourceRef);
        const staleWorkingRef = await store.cloneAsWorkingCopy(recentSourceRef);
        const orphanSourceRef = await store.createStoredDocument(
            'orphan.pdf',
            Uint8Array.of(2),
            {
                mimeType: 'application/pdf',
                kind: 'source',
                retention: 'transient',
                saveKind: 'pdf',
            },
        );
        const orphanOutputRef = await store.createStoredDocument(
            'orphan-output.pdf',
            Uint8Array.of(3),
            {
                mimeType: 'application/pdf',
                kind: 'output',
                retention: 'durable',
                saveKind: 'pdf',
            },
        );

        const rehydratedStore = new BrowserDocumentStore();

        await expect(rehydratedStore.exists(recentSourceRef)).resolves.toBe(true);
        await expect(rehydratedStore.exists(staleWorkingRef)).resolves.toBe(false);
        await expect(rehydratedStore.exists(orphanSourceRef)).resolves.toBe(false);
        await expect(rehydratedStore.exists(orphanOutputRef)).resolves.toBe(false);
    });

    it('sweeps durable non-recent source blobs on the next session', async () => {
        const store = new BrowserDocumentStore();
        const recentSourceRef = await createStoredPdf(store, 'recent.pdf', Uint8Array.of(1));
        const staleDurableRef = await createStoredPdf(store, 'stale.pdf', Uint8Array.of(2));

        await store.touchRecentFile(recentSourceRef);

        const rehydratedStore = new BrowserDocumentStore();

        await expect(rehydratedStore.exists(recentSourceRef)).resolves.toBe(true);
        await expect(rehydratedStore.exists(staleDurableRef)).resolves.toBe(false);
    });

    it('recovers recent files from durable persisted documents when browser recent storage is missing', async () => {
        const store = new BrowserDocumentStore();
        const firstRef = await createStoredPdf(store, 'first.pdf', Uint8Array.of(1));
        const secondRef = await createStoredPdf(store, 'second.pdf', Uint8Array.of(2));
        await store.touchRecentFile(firstRef);
        await store.touchRecentFile(secondRef);
        localStorage.clear();

        const rehydratedStore = new BrowserDocumentStore();
        const recoveredFiles = await rehydratedStore.recoverRecentFilesIfStorageMissing();

        expect(recoveredFiles.map(file => file.originalPath).sort()).toEqual([
            firstRef,
            secondRef,
        ].sort());
        await expect(rehydratedStore.exists(firstRef)).resolves.toBe(true);
        await expect(rehydratedStore.exists(secondRef)).resolves.toBe(true);
    });

    it('does not recover persisted documents after recent files are intentionally cleared', async () => {
        const store = new BrowserDocumentStore();
        const ref = await createStoredPdf(store, 'cleared.pdf', Uint8Array.of(1));
        await store.touchRecentFile(ref);
        await store.clearRecentFiles();

        const rehydratedStore = new BrowserDocumentStore();

        await expect(rehydratedStore.recoverRecentFilesIfStorageMissing()).resolves.toEqual([]);
        await expect(rehydratedStore.exists(ref)).resolves.toBe(false);
    });

    it('evicts old recent blobs once the persisted recent-file budget is exceeded', async () => {
        const firstHandle = createFileSystemFileHandle({name: 'first.pdf'});
        const secondHandle = createFileSystemFileHandle({name: 'second.pdf'});
        const thirdHandle = createFileSystemFileHandle({name: 'third.pdf'});
        const fileSize = Math.floor(BROWSER_MAX_RECENT_FILES_PERSISTED_BYTES / 2) + 1;
        const store = new BrowserDocumentStore();

        const firstRef = await store.createStoredDocument(
            'first.pdf',
            new Uint8Array(),
            {
                ...PDF_SOURCE_OPTIONS,
                saveHandle: firstHandle,
                storageMode: 'handle',
            },
        );
        await store.replaceWithHandleBackedDocument(firstRef, {
            fileSize,
            saveHandle: firstHandle,
            saveName: 'first.pdf',
        });
        await store.touchRecentFile(firstRef);

        const secondRef = await store.createStoredDocument(
            'second.pdf',
            new Uint8Array(),
            {
                ...PDF_SOURCE_OPTIONS,
                saveHandle: secondHandle,
                storageMode: 'handle',
            },
        );
        await store.replaceWithHandleBackedDocument(secondRef, {
            fileSize,
            saveHandle: secondHandle,
            saveName: 'second.pdf',
        });
        await store.touchRecentFile(secondRef);

        const thirdRef = await store.createStoredDocument(
            'third.pdf',
            new Uint8Array(),
            {
                ...PDF_SOURCE_OPTIONS,
                saveHandle: thirdHandle,
                storageMode: 'handle',
            },
        );
        await store.replaceWithHandleBackedDocument(thirdRef, {
            fileSize,
            saveHandle: thirdHandle,
            saveName: 'third.pdf',
        });
        await store.touchRecentFile(thirdRef);

        expect(store.getRecentFiles().map((file) => file.originalPath)).toEqual([thirdRef]);
        await expect(store.exists(firstRef)).resolves.toBe(false);
        await expect(store.exists(secondRef)).resolves.toBe(false);
        await expect(store.exists(thirdRef)).resolves.toBe(true);
    });

    it('removes a detached generated source after its working copy is cleaned up', async () => {
        const store = new BrowserDocumentStore();
        const generatedSourceRef = await store.createStoredDocument(
            'generated.pdf',
            Uint8Array.of(4, 5),
            {
                mimeType: 'application/pdf',
                kind: 'source',
                retention: 'transient',
                saveKind: 'pdf',
            },
        );
        const workingRef = await store.cloneAsWorkingCopy(generatedSourceRef);

        await store.remove(workingRef);
        await expect(store.cleanupDetachedDocument(generatedSourceRef)).resolves.toBe(true);
        await expect(store.exists(generatedSourceRef)).resolves.toBe(false);
    });

    it('removes a durable source after it falls out of recents and loses its working copy', async () => {
        const store = new BrowserDocumentStore();
        const sourceRef = await store.createStoredDocument(
            'saved.pdf',
            Uint8Array.of(7, 8),
            {...PDF_SOURCE_OPTIONS},
        );
        const workingRef = await store.cloneAsWorkingCopy(sourceRef);

        await store.touchRecentFile(sourceRef);
        await store.removeRecentFile(sourceRef);
        await store.remove(workingRef);

        await expect(store.cleanupDetachedDocument(sourceRef)).resolves.toBe(true);
        await expect(store.exists(sourceRef)).resolves.toBe(false);
    });

    it('keeps a source while a working copy still depends on it', async () => {
        const store = new BrowserDocumentStore();
        const sourceRef = await store.createStoredDocument(
            'source.pdf',
            Uint8Array.of(9),
            {
                mimeType: 'application/pdf',
                kind: 'source',
                retention: 'transient',
                saveKind: 'pdf',
            },
        );
        await store.cloneAsWorkingCopy(sourceRef);

        await expect(store.cleanupDetachedDocument(sourceRef)).resolves.toBe(false);
        await expect(store.exists(sourceRef)).resolves.toBe(true);
    });

    it('serializes dependent creation against detached-source cleanup', async () => {
        for (let index = 0; index < 6; index += 1) {
            const store = new BrowserDocumentStore();
            const sourceRef = await store.createStoredDocument(
                `race-source-${index}.pdf`,
                new Uint8Array([index]),
                {
                    mimeType: 'application/pdf',
                    kind: 'source',
                    retention: 'transient',
                    saveKind: 'pdf',
                },
            );
            const clone = () => store.cloneAsWorkingCopy(sourceRef);
            const cleanup = () => store.cleanupDetachedDocument(sourceRef);
            let clonePromise: Promise<string>;
            let cleanupPromise: Promise<boolean>;
            if (index % 2 === 0) {
                clonePromise = clone();
                cleanupPromise = cleanup();
            } else {
                cleanupPromise = cleanup();
                clonePromise = clone();
            }
            const [
                cloneResult,
                cleanupResult,
            ] = await Promise.allSettled([
                clonePromise,
                cleanupPromise,
            ]);

            if (cloneResult.status === 'fulfilled') {
                expect(cleanupResult).toEqual({
                    status: 'fulfilled',
                    value: false,
                });
                await expect(store.exists(sourceRef)).resolves.toBe(true);
                const dependent = await store.requireEntry(cloneResult.value);
                expect(dependent.sourceRef).toBe(sourceRef);
            } else {
                expect(cleanupResult).toEqual({
                    status: 'fulfilled',
                    value: true,
                });
                await expect(store.exists(sourceRef)).resolves.toBe(false);
            }
        }
    });

    it('clones a byte-backed document while atomically attaching it to its source', async () => {
        const store = new BrowserDocumentStore();
        const sourceRef = await store.createStoredDocument(
            'clone-source.pdf',
            Uint8Array.of(1, 2, 3),
            {
                mimeType: 'application/pdf',
                kind: 'source',
                retention: 'transient',
                saveKind: 'pdf',
            },
        );

        const dependentRef = await store.cloneStoredDocument(sourceRef, {
            fileName: 'dependent.pdf',
            kind: 'working',
            sourceRef,
            saveKind: 'pdf',
        });

        const dependent = await store.requireEntry(dependentRef);
        expect(dependent.sourceRef).toBe(sourceRef);
        await expect(store.cleanupDetachedDocument(sourceRef)).resolves.toBe(false);
    });

    it('serves range reads through source-proxy working copies', async () => {
        const store = new BrowserDocumentStore();
        const sourceRef = await store.createStoredDocument(
            'large.pdf',
            Uint8Array.of(1, 2, 3, 4, 5, 6),
            {...PDF_SOURCE_OPTIONS},
        );
        const workingRef = await store.cloneAsWorkingCopy(sourceRef);

        await expect(store.readRange(workingRef, 2, 3)).resolves.toEqual(Uint8Array.of(3, 4, 5));
        await expect(store.stat(workingRef)).resolves.toEqual({
            size: 6,
            modifiedAt: expect.any(Number),
        });
    });

    it('returns browser document revisions that follow source-proxy content changes', async () => {
        const store = new BrowserDocumentStore();
        const sourceRef = await createStoredPdf(store, 'revision-source.pdf', Uint8Array.of(1));
        const workingRef = await store.cloneAsWorkingCopy(sourceRef);
        const events: Array<{
            documentRef: string;
            previousToken?: string;
            token: string
        }> = [];
        const unsubscribe = store.onDocumentRevisionChanged((event) => {
            const revisionEvent: {
                documentRef: string;
                previousToken?: string;
                token: string
            } = {
                documentRef: event.documentRef,
                token: event.token,
            };
            if (event.previousToken !== undefined) {
                revisionEvent.previousToken = event.previousToken;
            }
            events.push(revisionEvent);
        });

        const initialRevision = await store.getDocumentRevision(workingRef);
        await store.write(sourceRef, Uint8Array.of(2));
        const nextRevision = await store.getDocumentRevision(workingRef);
        unsubscribe();

        expect(initialRevision).toMatchObject({
            version: 1,
            documentRef: workingRef,
            authority: 'browser-document-store',
            contentRevision: 1,
        });
        expect(initialRevision.token).toMatch(/^drt1:browser:/u);
        expect(nextRevision.documentRef).toBe(workingRef);
        expect(nextRevision.contentRevision).toBe(2);
        expect(nextRevision.token).not.toBe(initialRevision.token);
        expect(events).toEqual(expect.arrayContaining([
            expect.objectContaining({
                documentRef: sourceRef,
                previousToken: initialRevision.token,
                token: nextRevision.token,
            }),
            expect.objectContaining({
                documentRef: workingRef,
                previousToken: initialRevision.token,
                token: nextRevision.token,
            }),
        ]));
    });

    it('persists chunked documents and supports range reads without inline bytes', async () => {
        const store = new BrowserDocumentStore();
        const ref = await store.createStoredDocument(
            'chunked.pdf',
            new Uint8Array(),
            {
                mimeType: 'application/pdf',
                kind: 'output',
                retention: 'durable',
                saveKind: 'pdf',
            },
        );

        await store.prepareChunkedDocument(ref, { chunkSize: 4 });
        await store.writeChunk(ref, 0, Uint8Array.of(1, 2, 3, 4));
        await store.writeChunk(ref, 1, Uint8Array.of(5, 6, 7));
        await store.finalizeChunkedDocument(ref, {
            fileSize: 7,
            chunkCount: 2,
            chunkSize: 4,
        });

        await expect(store.readRange(ref, 3, 3)).resolves.toEqual(Uint8Array.of(4, 5, 6));
        await expect(store.read(ref)).resolves.toEqual(Uint8Array.of(1, 2, 3, 4, 5, 6, 7));
    });

    it('clones chunked documents without materializing them into inline storage', async () => {
        const store = new BrowserDocumentStore();
        const ref = await store.createStoredDocument(
            'chunked.pdf',
            new Uint8Array(),
            {
                mimeType: 'application/pdf',
                kind: 'output',
                retention: 'transient',
                saveKind: 'pdf',
            },
        );

        await store.prepareChunkedDocument(ref, { chunkSize: 4 });
        await store.writeChunk(ref, 0, Uint8Array.of(1, 2, 3, 4));
        await store.writeChunk(ref, 1, Uint8Array.of(5, 6, 7, 8));
        await store.finalizeChunkedDocument(ref, {
            fileSize: 8,
            chunkCount: 2,
            chunkSize: 4,
        });

        const cloneRef = await store.cloneStoredDocument(ref, {
            fileName: 'clone.pdf',
            kind: 'working',
            retention: 'transient',
            saveKind: 'pdf',
        });
        const cloneEntry = await store.requireEntry(cloneRef);

        expect(cloneEntry.storageMode).toBe('chunked');
        expect(cloneEntry.chunkCount).toBe(2);
        await expect(store.readRange(cloneRef, 2, 4)).resolves.toEqual(Uint8Array.of(3, 4, 5, 6));
    });

    it('removes partial chunked clone records when source chunk copy fails', async () => {
        const store = new BrowserDocumentStore();
        const ref = await store.createStoredDocument(
            'chunked.pdf',
            new Uint8Array(),
            {
                mimeType: 'application/pdf',
                kind: 'output',
                retention: 'transient',
                saveKind: 'pdf',
            },
        );

        await store.prepareChunkedDocument(ref, { chunkSize: 4 });
        await store.writeChunk(ref, 0, Uint8Array.of(1, 2, 3, 4));
        await store.writeChunk(ref, 1, Uint8Array.of(5, 6, 7, 8));
        await store.finalizeChunkedDocument(ref, {
            fileSize: 8,
            chunkCount: 2,
            chunkSize: 4,
        });

        const database = indexedDbFactory.getDatabase('evb-viewer-browser-documents');
        const chunks = database?.getStoreRecords('document-chunks');
        const missingChunkKey = Array.from(chunks?.entries() ?? []).find(([
            _key,
            chunk,
        ]) => (
            typeof chunk === 'object'
            && chunk !== null
            && 'ref' in chunk
            && chunk.ref === ref
            && 'index' in chunk
            && chunk.index === 1
        ))?.[0];
        expect(missingChunkKey).toBeTruthy();
        if (typeof missingChunkKey !== 'string') {
            throw new TypeError('Expected a stored chunk key for the corruption fixture');
        }
        chunks?.delete(missingChunkKey);

        await expect(store.cloneStoredDocument(ref, {
            fileName: 'clone.pdf',
            kind: 'working',
            retention: 'transient',
            saveKind: 'pdf',
        })).rejects.toThrow(`Browser document chunk missing: ${ref}#1`);

        const documents = Array.from(database?.getStoreRecords('documents').values() ?? []);
        expect(documents).not.toEqual(expect.arrayContaining([expect.objectContaining({ fileName: 'clone.pdf' })]));
        expect(Array.from(chunks?.values() ?? []).every((chunk) => (
            typeof chunk === 'object'
            && chunk !== null
            && 'ref' in chunk
            && chunk.ref === ref
        ))).toBe(true);
    });

    it('reads handle-backed documents lazily', async () => {
        const bytes = Uint8Array.of(9, 8, 7, 6, 5);
        const handle = createFileSystemFileHandle({
            name: 'lazy.pdf',
            getFile: vi.fn(async () => new File([bytes], 'lazy.pdf', { type: 'application/pdf' })),
        });
        const store = new BrowserDocumentStore();
        const ref = await store.createStoredDocument(
            'lazy.pdf',
            new Uint8Array(),
            {
                mimeType: 'application/pdf',
                kind: 'output',
                saveKind: 'pdf',
                saveHandle: handle,
                storageMode: 'handle',
            },
        );

        await store.replaceWithHandleBackedDocument(ref, {
            fileSize: bytes.byteLength,
            saveHandle: handle,
            saveName: 'lazy.pdf',
        });

        await expect(store.readRange(ref, 1, 3)).resolves.toEqual(Uint8Array.of(8, 7, 6));
        await expect(store.stat(ref)).resolves.toEqual({
            size: 5,
            modifiedAt: expect.any(Number),
        });
    });

    it('uses one browser File snapshot for sequential handle range reads', async () => {
        const firstFile = new File([Uint8Array.of(1, 2, 3, 4)], 'snapshot.pdf', {
            type: 'application/pdf',
            lastModified: 21,
        });
        const replacementFile = new File([Uint8Array.of(9, 9, 9, 9)], 'snapshot.pdf', {
            type: 'application/pdf',
            lastModified: 22,
        });
        const getFile = vi.fn()
            .mockResolvedValueOnce(firstFile)
            .mockResolvedValueOnce(replacementFile);
        const handle = createFileSystemFileHandle({
            name: 'snapshot.pdf',
            getFile,
        });
        const store = new BrowserDocumentStore();
        const ref = await store.createStoredDocument(
            'snapshot.pdf',
            new Uint8Array(),
            {
                ...PDF_SOURCE_OPTIONS,
                kind: 'output',
                saveHandle: handle,
                storageMode: 'handle',
            },
        );
        await store.replaceWithHandleBackedDocument(ref, {
            fileSize: firstFile.size,
            saveHandle: handle,
            saveName: 'snapshot.pdf',
        });

        await expect(store.readRange(ref, 0, 2)).resolves.toEqual(Uint8Array.of(1, 2));
        await expect(store.readRange(ref, 2, 2)).resolves.toEqual(Uint8Array.of(3, 4));
        expect(getFile).toHaveBeenCalledOnce();
    });

    it('mirrors picked source bytes even when a save handle is present', async () => {
        const bytes = Uint8Array.of(3, 1, 4);
        const handle = createFileSystemFileHandle({
            name: 'picked.pdf',
            getFile: vi.fn(async () => {
                throw new DOMException('Not allowed', 'NotAllowedError');
            }),
        });
        const file = new File([bytes], 'picked.pdf', { type: 'application/pdf' });
        const store = new BrowserDocumentStore();
        const ref = await store.registerFile(file, {
            kind: 'source',
            saveKind: 'pdf',
            saveHandle: handle,
        });

        const entry = await store.requireEntry(ref);
        expect(entry.storageMode).toBe('inline');

        store.unload(ref);

        await expect(store.read(ref)).resolves.toEqual(bytes);
        expect(handle.getFile).not.toHaveBeenCalled();
    });

    it('keeps source bytes readable after save-handle-backed source creation', async () => {
        const bytes = Uint8Array.of(6, 2, 5);
        const handle = createFileSystemFileHandle({
            name: 'saved.pdf',
            getFile: vi.fn(async () => {
                throw new DOMException('Not allowed', 'NotAllowedError');
            }),
        });
        const store = new BrowserDocumentStore();
        const ref = await store.createStoredDocument(
            'saved.pdf',
            bytes,
            {
                ...PDF_SOURCE_OPTIONS,
                saveHandle: handle,
                storageMode: 'handle',
            },
        );

        const entry = await store.requireEntry(ref);
        expect(entry.storageMode).toBe('inline');

        store.unload(ref);

        await expect(store.read(ref)).resolves.toEqual(bytes);
        expect(handle.getFile).not.toHaveBeenCalled();
    });

    it('hydrates legacy handle-backed sources before reopening them', async () => {
        const bytes = Uint8Array.of(8, 9, 7);
        const getFile = vi.fn(async () => new File([bytes], 'legacy.pdf', { type: 'application/pdf' }));
        const handle = createFileSystemFileHandle({
            name: 'legacy.pdf',
            getFile,
        });
        const store = new BrowserDocumentStore();
        const ref = await store.createStoredDocument(
            'legacy.pdf',
            new Uint8Array(),
            {
                ...PDF_SOURCE_OPTIONS,
                saveHandle: handle,
                storageMode: 'handle',
            },
        );

        await store.ensureByteBackedSource(ref);
        const entry = await store.requireEntry(ref);
        expect(entry.storageMode).toBe('inline');

        getFile.mockImplementation(async () => {
            throw new DOMException('Not allowed', 'NotAllowedError');
        });
        store.unload(ref);

        await expect(store.read(ref)).resolves.toEqual(bytes);
    });

    it('stores large file-only sources as chunked records', async () => {
        const bytes = new Uint8Array((16 * 1024 * 1024) + 1);
        bytes[0] = 4;
        bytes[bytes.byteLength - 1] = 9;
        const file = new File([bytes], 'large.pdf', { type: 'application/pdf' });
        const store = new BrowserDocumentStore();
        const ref = await store.registerFile(file, {
            kind: 'source',
            saveKind: 'pdf',
        });

        const entry = await store.requireEntry(ref);

        expect(entry.storageMode).toBe('chunked');
        expect(entry.data.byteLength).toBe(0);
        await expect(store.readRange(ref, 0, 1)).resolves.toEqual(Uint8Array.of(4));
        await expect(store.readRange(ref, bytes.byteLength - 1, 1)).resolves.toEqual(Uint8Array.of(9));
    });

    it('keeps large writes chunked instead of collapsing back to inline storage', async () => {
        const store = new BrowserDocumentStore();
        const ref = await store.createStoredDocument(
            'rewrite.pdf',
            Uint8Array.of(1),
            {
                mimeType: 'application/pdf',
                kind: 'working',
                saveKind: 'pdf',
            },
        );
        const largeBytes = new Uint8Array((16 * 1024 * 1024) + 1);
        largeBytes[0] = 3;
        largeBytes[largeBytes.byteLength - 1] = 7;
        const revision = await store.getDocumentRevision(ref);

        await store.write(ref, largeBytes, {expectedDocumentRevisionToken: revision.token});

        const entry = await store.requireEntry(ref);
        expect(entry.storageMode).toBe('chunked');
        expect(entry.data.byteLength).toBe(0);
        await expect(store.readRange(ref, 0, 1)).resolves.toEqual(Uint8Array.of(3));
        await expect(store.readRange(ref, largeBytes.byteLength - 1, 1)).resolves.toEqual(Uint8Array.of(7));
    });

    it('replaces chunk generations after a large rewrite and removes superseded chunks', async () => {
        const store = new BrowserDocumentStore();
        const firstBytes = new Uint8Array((16 * 1024 * 1024) + 1);
        firstBytes[0] = 1;
        firstBytes[firstBytes.byteLength - 1] = 2;
        const ref = await store.createStoredDocument('rewrite-generations.pdf', firstBytes, {
            mimeType: 'application/pdf',
            kind: 'working',
            saveKind: 'pdf',
        });
        const database = indexedDbFactory.getDatabase('evb-viewer-browser-documents');
        const firstChunkKeys = Array.from(database?.getStoreRecords('document-chunks').keys() ?? []);

        const secondBytes = new Uint8Array((16 * 1024 * 1024) + 1);
        secondBytes[0] = 3;
        secondBytes[secondBytes.byteLength - 1] = 4;
        const revision = await store.getDocumentRevision(ref);
        await store.write(ref, secondBytes, {expectedDocumentRevisionToken: revision.token});

        const secondChunkKeys = Array.from(database?.getStoreRecords('document-chunks').keys() ?? []);
        expect(secondChunkKeys).not.toEqual(firstChunkKeys);
        expect(secondChunkKeys.some(key => firstChunkKeys.includes(key))).toBe(false);
        await expect(store.readRange(ref, 0, 1)).resolves.toEqual(Uint8Array.of(3));
        await expect(store.readRange(ref, secondBytes.byteLength - 1, 1)).resolves.toEqual(Uint8Array.of(4));
    });

    it('keeps the previous chunk generation readable when a large rewrite is interrupted', async () => {
        const store = new BrowserDocumentStore();
        const firstBytes = new Uint8Array((16 * 1024 * 1024) + 1);
        firstBytes[0] = 1;
        firstBytes[firstBytes.byteLength - 1] = 2;
        const ref = await store.createStoredDocument('interrupted-rewrite.pdf', firstBytes, {
            mimeType: 'application/pdf',
            kind: 'working',
            saveKind: 'pdf',
        });
        const secondBytes = new Uint8Array((16 * 1024 * 1024) + 1);
        secondBytes[0] = 8;
        secondBytes[secondBytes.byteLength - 1] = 9;

        vi.stubGlobal('indexedDB', undefined);
        const revision = await store.getDocumentRevision(ref);
        await expect(store.write(ref, secondBytes, {expectedDocumentRevisionToken: revision.token}))
            .rejects
            .toThrow('IndexedDB document chunk write did not commit');
        vi.stubGlobal('indexedDB', indexedDbFactory);

        await expect(store.readRange(ref, 0, 1)).resolves.toEqual(Uint8Array.of(1));
        await expect(store.readRange(ref, firstBytes.byteLength - 1, 1)).resolves.toEqual(Uint8Array.of(2));

        store.unload(ref);

        await expect(store.readRange(ref, 0, 1)).resolves.toEqual(Uint8Array.of(1));
        await expect(store.readRange(ref, firstBytes.byteLength - 1, 1)).resolves.toEqual(Uint8Array.of(2));
    });

    it('does not publish manually written chunks until finalize succeeds', async () => {
        const store = new BrowserDocumentStore();
        const ref = await store.createStoredDocument(
            'manual-output.pdf',
            Uint8Array.of(9, 9, 9, 9),
            {
                mimeType: 'application/pdf',
                kind: 'output',
                retention: 'durable',
                saveKind: 'pdf',
            },
        );

        await store.prepareChunkedDocument(ref, { chunkSize: 4 });
        await store.writeChunk(ref, 0, Uint8Array.of(1, 2, 3, 4));

        await expect(store.read(ref)).resolves.toEqual(Uint8Array.of(9, 9, 9, 9));
        await store.touchRecentFile(ref);

        const rehydratedStore = new BrowserDocumentStore();
        await expect(rehydratedStore.read(ref)).resolves.toEqual(Uint8Array.of(9, 9, 9, 9));

        await store.prepareChunkedDocument(ref, { chunkSize: 4 });
        await store.writeChunk(ref, 0, Uint8Array.of(1, 2, 3, 4));
        await store.finalizeChunkedDocument(ref, {
            fileSize: 4,
            chunkCount: 1,
            chunkSize: 4,
        });

        await expect(store.read(ref)).resolves.toEqual(Uint8Array.of(1, 2, 3, 4));
    });

    it('persists a cross-window lease for manually written chunks until finalize', async () => {
        const store = new BrowserDocumentStore();
        const ref = await store.createStoredDocument(
            'cross-window-output.pdf',
            new Uint8Array(),
            {
                mimeType: 'application/pdf',
                kind: 'output',
                retention: 'transient',
                saveKind: 'pdf',
            },
        );

        await store.prepareChunkedDocument(ref, {chunkSize: 4});
        await store.writeChunk(ref, 0, Uint8Array.of(1, 2, 3, 4));

        const database = indexedDbFactory.getDatabase('evb-viewer-browser-documents');
        const persistedRecord = database?.getStoreRecords('documents').get(ref);
        expect(persistedRecord).toEqual(expect.objectContaining({
            pendingChunkGeneration: expect.any(String),
            pendingChunkCount: 1,
            pendingChunkSize: 4,
            pendingFileSize: 4,
            pendingChunkUpdatedAt: expect.any(Number),
        }));

        const otherWindowStore = new BrowserDocumentStore();
        await otherWindowStore.createStoredDocument(
            'maintenance-trigger.pdf',
            Uint8Array.of(9),
            {
                mimeType: 'application/pdf',
                kind: 'working',
                saveKind: 'pdf',
            },
        );

        const chunkRecords = Array.from(database?.getStoreRecords('document-chunks').values() ?? []);
        expect(chunkRecords).toEqual(expect.arrayContaining([expect.objectContaining({
            ref,
            index: 0,
        })]));
        await expect(otherWindowStore.read(ref)).resolves.toEqual(new Uint8Array());

        await store.finalizeChunkedDocument(ref, {
            fileSize: 4,
            chunkCount: 1,
            chunkSize: 4,
        });
        const finalizedRecord = database?.getStoreRecords('documents').get(ref);
        expect(finalizedRecord).not.toHaveProperty('pendingChunkGeneration');
    });

    it('rejects full reads for browser documents above the in-memory safety limit', async () => {
        const bytes = new Uint8Array(BROWSER_MAX_FULL_READ_BYTES + 1);
        bytes[0] = 5;
        bytes[bytes.byteLength - 1] = 8;
        const store = new BrowserDocumentStore();
        const ref = await createStoredPdf(store, 'huge.pdf', bytes);

        await expect(store.read(ref)).rejects.toThrow('Browser document is too large to load fully into memory');
        await expect(store.readRange(ref, 0, 1)).resolves.toEqual(Uint8Array.of(5));
        await expect(store.readRange(ref, bytes.byteLength - 1, 1)).resolves.toEqual(Uint8Array.of(8));
    });

    it('keeps an oversized picked file range-readable without reading the whole file in memory', async () => {
        const fileSize = BROWSER_MAX_FULL_READ_BYTES + 1;
        const file = new File([], 'oversized.pdf', {
            type: 'application/pdf',
            lastModified: 31,
        });
        Object.defineProperty(file, 'size', {
            configurable: true,
            value: fileSize,
        });
        const fullRead = vi.spyOn(file, 'arrayBuffer').mockImplementation(async () => {
            throw new Error('full file read should not be used');
        });
        vi.spyOn(file, 'slice').mockImplementation((start = 0, _end) => (
            new Blob([Uint8Array.of(start === 0 ? 5 : 8)], {type: 'application/pdf'})
        ));
        vi.stubGlobal('indexedDB', undefined);
        const store = new BrowserDocumentStore();

        const ref = await store.registerFile(file, {
            kind: 'source',
            saveKind: 'pdf',
        });

        const entry = await store.requireEntry(ref);
        expect(entry.memoryOnly).toBe(true);
        expect(entry.storageMode).toBe('handle');
        expect(fullRead).not.toHaveBeenCalled();
        await expect(store.readRange(ref, 0, 1)).resolves.toEqual(Uint8Array.of(5));
        await expect(store.readRange(ref, fileSize - 1, 1)).resolves.toEqual(Uint8Array.of(8));
        await expect(store.read(ref)).rejects.toThrow('Browser document is too large to load fully into memory');
    });

    it('clears partial chunk records when chunked output is aborted', async () => {
        const store = new BrowserDocumentStore();
        const ref = await store.createStoredDocument(
            'partial.pdf',
            new Uint8Array(),
            {
                mimeType: 'application/pdf',
                kind: 'output',
                retention: 'transient',
                saveKind: 'pdf',
            },
        );

        await store.prepareChunkedDocument(ref, { chunkSize: 4 });
        await store.writeChunk(ref, 0, Uint8Array.of(1, 2, 3, 4));
        await store.clearChunkedDocument(ref);

        const database = indexedDbFactory.getDatabase('evb-viewer-browser-documents');
        expect(database?.getStoreRecords('document-chunks').size ?? 0).toBe(0);
        await expect(store.read(ref)).resolves.toEqual(new Uint8Array());
    });

    it('uses fresh chunk generations when manual chunked output is prepared again', async () => {
        const store = new BrowserDocumentStore();
        const ref = await store.createStoredDocument(
            'regenerated.pdf',
            new Uint8Array(),
            {
                mimeType: 'application/pdf',
                kind: 'output',
                retention: 'transient',
                saveKind: 'pdf',
            },
        );
        const database = indexedDbFactory.getDatabase('evb-viewer-browser-documents');

        await store.prepareChunkedDocument(ref, { chunkSize: 4 });
        await store.writeChunk(ref, 0, Uint8Array.of(1, 2, 3, 4));
        const firstChunkKeys = Array.from(database?.getStoreRecords('document-chunks').keys() ?? []);
        await store.clearChunkedDocument(ref);
        await store.prepareChunkedDocument(ref, { chunkSize: 4 });
        await store.writeChunk(ref, 0, Uint8Array.of(5, 6, 7, 8));
        await store.finalizeChunkedDocument(ref, {
            fileSize: 4,
            chunkCount: 1,
            chunkSize: 4,
        });

        const secondChunkKeys = Array.from(database?.getStoreRecords('document-chunks').keys() ?? []);
        expect(secondChunkKeys).toHaveLength(1);
        expect(secondChunkKeys[0]).not.toBe(firstChunkKeys[0]);
        await expect(store.readRange(ref, 0, 4)).resolves.toEqual(Uint8Array.of(5, 6, 7, 8));
    });

    it('does not sweep a chunked source while file ingestion is still in progress', async () => {
        let releaseFirstChunk: () => void = () => {
            throw new Error('First chunk gate was not initialized');
        };
        const firstChunkReady = new Promise<void>((resolve) => {
            releaseFirstChunk = resolve;
        });
        const bytes = new Uint8Array((16 * 1024 * 1024) + 1);
        bytes[0] = 7;
        bytes[bytes.byteLength - 1] = 8;
        const file = new File([], 'pending-large.pdf', {type: 'application/pdf'});
        Object.defineProperty(file, 'size', {
            configurable: true,
            value: bytes.byteLength,
        });
        vi.spyOn(file, 'slice').mockImplementation((start = 0, end = bytes.byteLength) => {
            const chunk = new Blob([bytes.slice(start, end)], {type: 'application/pdf'});
            vi.spyOn(chunk, 'arrayBuffer').mockImplementation(async () => {
                if (start === 0) {
                    await firstChunkReady;
                }
                return bytes.slice(start, end).buffer;
            });
            return chunk;
        });
        const store = new BrowserDocumentStore();
        const ref = store.getRefForFile(file);

        await vi.waitFor(() => {
            expect(file.slice).toHaveBeenCalled();
        });

        await store.createStoredDocument('maintenance-trigger.pdf', Uint8Array.of(1), {
            mimeType: 'application/pdf',
            kind: 'working',
            saveKind: 'pdf',
        });
        releaseFirstChunk();

        await expect(store.readRange(ref, 0, 1)).resolves.toEqual(Uint8Array.of(7));
        await expect(store.readRange(ref, bytes.byteLength - 1, 1)).resolves.toEqual(Uint8Array.of(8));
    });

    it('retries document maintenance after a failed sweep', async () => {
        const sourceStore = new BrowserDocumentStore();
        const staleRef = await sourceStore.createStoredDocument(
            'stale-working.pdf',
            Uint8Array.of(1),
            {
                mimeType: 'application/pdf',
                kind: 'working',
                saveKind: 'pdf',
            },
        );
        const database = indexedDbFactory.getDatabase('evb-viewer-browser-documents');
        if (!database) {
            throw new Error('Expected browser document database');
        }
        const transaction = database.transaction.bind(database);
        const transactionSpy = vi.spyOn(database, 'transaction')
            .mockImplementation((name, mode) => {
                if (mode === 'readwrite') {
                    throw new Error('maintenance delete failed');
                }
                return transaction(name, mode);
            });
        const rehydratedStore = new BrowserDocumentStore();

        await expect(rehydratedStore.createStoredDocument(
            'first-trigger.pdf',
            Uint8Array.of(2),
            {
                mimeType: 'application/pdf',
                kind: 'working',
                saveKind: 'pdf',
            },
        )).rejects.toThrow('IndexedDB document delete did not commit');

        transactionSpy.mockRestore();
        await expect(rehydratedStore.createStoredDocument(
            'retry-trigger.pdf',
            Uint8Array.of(3),
            {
                mimeType: 'application/pdf',
                kind: 'working',
                saveKind: 'pdf',
            },
        )).resolves.toMatch(/^browser:\/\/documents\//u);
        expect(database.getStoreRecords('documents').has(staleRef)).toBe(false);
    });

    it('sweeps corrupt recent chunked documents with positive size and no chunk records', async () => {
        const store = new BrowserDocumentStore();
        const ref = await createStoredPdf(store, 'corrupt.pdf', Uint8Array.of(1));
        await store.touchRecentFile(ref);

        const database = indexedDbFactory.getDatabase('evb-viewer-browser-documents');
        const documents = database?.getStoreRecords('documents');
        const record = documents?.get(ref);
        expect(record).toBeTruthy();
        if (!isRecord(record)) {
            throw new TypeError('Expected a stored document record for the corruption fixture');
        }
        documents?.set(ref, {
            ...record,
            data: new Uint8Array(),
            storageMode: 'chunked',
            fileSize: 8,
            chunkCount: 0,
            chunkSize: 4,
        });

        const rehydratedStore = new BrowserDocumentStore();

        await expect(rehydratedStore.exists(ref)).resolves.toBe(false);
        expect(rehydratedStore.getRecentFiles()).toEqual([]);
    });
});
