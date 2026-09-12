import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {BrowserDocumentStore} from '@app/platform/browser/browserDocumentRepository';
import {createBrowserFileContentWitness} from '@app/platform/browser/createBrowserFileContentWitness';
import {
    BROWSER_LIVE_LEASES_STORE,
    BROWSER_DOCUMENT_CHUNK_SIZE,
    BROWSER_MAX_FULL_READ_BYTES,
    DB_NAME,
} from '@app/platform/browser/browserDocumentConstants';
import {
    createFileSystemFileHandle,
    FakeIndexedDbFactory,
    MemoryStorage,
} from '@tests/unit/app/platform/browserPlatformTestDoubles';

describe('BrowserDocumentStore source registration', () => {
    let indexedDbFactory: FakeIndexedDbFactory;

    beforeEach(() => {
        vi.unstubAllGlobals();
        indexedDbFactory = new FakeIndexedDbFactory();
        vi.stubGlobal('indexedDB', indexedDbFactory);
        vi.stubGlobal('window', {localStorage: new MemoryStorage()});
        vi.stubGlobal('document', {cookie: ''});
    });

    it.each([
        {
            name: 'same-size replacement',
            previousBytes: Uint8Array.of(37, 80, 68, 70),
            replacementBytes: Uint8Array.of(37, 80, 68, 71),
        },
        {
            name: 'changed-size replacement',
            previousBytes: Uint8Array.of(37, 80, 68, 70),
            replacementBytes: Uint8Array.of(37, 80, 68, 70, 9, 8, 7),
        },
    ])('binds a fresh source version to the selected $name', async ({
        previousBytes,
        replacementBytes,
    }) => {
        let currentFile = new File(
            [previousBytes],
            'reopen.pdf',
            {
                type: 'application/pdf',
                lastModified: 100,
            },
        );
        const handle = createFileSystemFileHandle({
            name: 'reopen.pdf',
            getFile: vi.fn(async () => currentFile),
        });
        const store = new BrowserDocumentStore();
        const previousRef = await store.registerFile(currentFile, {
            kind: 'source',
            saveKind: 'pdf',
            saveHandle: handle,
        });
        const dirtyWorkingRef = await store.cloneAsWorkingCopy(previousRef);
        const dirtyBytes = Uint8Array.of(37, 80, 68, 70, 1);
        await store.writeForBootstrap(dirtyWorkingRef, dirtyBytes, 'source-registration-test');

        currentFile = new File(
            [replacementBytes],
            'reopen.pdf',
            {
                type: 'application/pdf',
                lastModified: 200,
            },
        );
        const reopenedRef = await store.registerFile(currentFile, {
            kind: 'source',
            saveKind: 'pdf',
            saveHandle: handle,
        });

        expect(reopenedRef).not.toBe(previousRef);
        await expect(store.read(reopenedRef)).resolves.toEqual(replacementBytes);
        await expect(store.read(previousRef)).resolves.toEqual(previousBytes);
        await expect(store.read(dirtyWorkingRef)).resolves.toEqual(dirtyBytes);
        expect((await store.requireEntry(dirtyWorkingRef)).sourceRef).toBe(previousRef);
        expect((await store.requireEntry(reopenedRef)).saveHandle).toBe(handle);
    });

    it('keeps bytes, snapshot, witness, and opening revision coherent for a fresh source', async () => {
        const bytes = Uint8Array.from({length: 32}, (_value, index) => index + 1);
        const file = new File([bytes], 'coherent-source.pdf', {
            type: 'application/pdf',
            lastModified: 321,
        });
        const handle = createFileSystemFileHandle({
            name: file.name,
            getFile: vi.fn(async () => file),
        });
        const store = new BrowserDocumentStore();
        const ref = await store.registerFile(file, {
            kind: 'source',
            saveKind: 'pdf',
            saveHandle: handle,
        });

        const entry = await store.requireEntry(ref);
        const revision = await store.getDocumentRevision(ref);
        const contentSignature = await store.getContentSignature(ref);

        expect(entry.fileSnapshot).toBe(file);
        expect(entry.fileSize).toBe(bytes.byteLength);
        expect(entry.fileLastModified).toBe(file.lastModified);
        expect(entry.contentToken).toBe(await createBrowserFileContentWitness(file, bytes));
        expect(contentSignature).toContain(`:${entry.contentToken}:`);
        expect(revision.token).toBe(`drt1:browser:${entry.contentToken}`);
        await expect(store.readRange(ref, 7, 9)).resolves.toEqual(bytes.slice(7, 16));
        await expect(store.read(ref)).resolves.toEqual(bytes);
    });

    it('reopens fresh bytes after a prior physical witness refresh', async () => {
        let currentFile = new File([Uint8Array.of(37, 80, 68, 70)], 'witness-reopen.pdf', {
            type: 'application/pdf',
            lastModified: 100,
        });
        const handle = createFileSystemFileHandle({
            name: 'witness-reopen.pdf',
            getFile: vi.fn(async () => currentFile),
        });
        const store = new BrowserDocumentStore();
        const originalRef = await store.registerFile(currentFile, {
            kind: 'source',
            saveKind: 'pdf',
            saveHandle: handle,
        });
        const dirtyRef = await store.cloneAsWorkingCopy(originalRef);
        await store.writeForBootstrap(
            dirtyRef,
            Uint8Array.of(37, 80, 68, 70, 1),
            'witness-reopen-test',
        );

        currentFile = new File([Uint8Array.of(37, 80, 68, 71)], 'witness-reopen.pdf', {
            type: 'application/pdf',
            lastModified: 200,
        });
        await store.getDocumentRevision(originalRef);

        const reopenedRef = await store.refreshSourceVersionIfChanged(originalRef);

        expect(reopenedRef).not.toBe(originalRef);
        const reopenedEntry = await store.requireEntry(reopenedRef);
        expect(reopenedEntry.fileSnapshot).toBe(currentFile);
        expect(reopenedEntry.sourceBaseWitness).toBe(reopenedEntry.contentToken);
        expect(await store.getContentSignature(reopenedRef)).toContain(`:${reopenedEntry.contentToken}:`);
        await expect(store.read(reopenedRef)).resolves.toEqual(Uint8Array.of(37, 80, 68, 71));
        await expect(store.readRange(reopenedRef, 2, 2)).resolves.toEqual(Uint8Array.of(68, 71));
        await expect(store.read(originalRef)).resolves.toEqual(Uint8Array.of(37, 80, 68, 70));
        await expect(store.read(dirtyRef)).resolves.toEqual(Uint8Array.of(37, 80, 68, 70, 1));
    });

    it('rejects a materialized save when the physical source changed at equal size and mtime', async () => {
        const openingBytes = Uint8Array.of(37, 80, 68, 70, 1, 2);
        let currentFile = new File([openingBytes], 'materialized-source.pdf', {
            type: 'application/pdf',
            lastModified: 777,
        });
        const handle = createFileSystemFileHandle({
            name: 'materialized-source.pdf',
            getFile: vi.fn(async () => currentFile),
        });
        const store = new BrowserDocumentStore();
        const sourceRef = await store.registerFile(currentFile, {
            kind: 'source',
            saveKind: 'pdf',
            saveHandle: handle,
        });
        const workingRef = await store.cloneAsWorkingCopy(sourceRef);
        await store.writeForBootstrap(workingRef, Uint8Array.of(9, 8, 7), 'materialize-working-copy');

        // Older persisted source records may have the handle and content
        // witness without the redundant sourceWitness marker.
        delete (await store.requireEntry(sourceRef)).sourceWitness;

        const openingWitness = (await store.requireEntry(workingRef)).sourceBaseWitness;
        currentFile = new File([Uint8Array.of(
            37,
            80,
            68,
            71,
            1,
            2,
        )], 'materialized-source.pdf', {
            type: 'application/pdf',
            lastModified: 777,
        });
        const writer = vi.fn(async () => undefined);

        await expect(store.runDocumentMutationWithSource(
            workingRef,
            sourceRef,
            (await store.getDocumentRevision(workingRef)).token,
            async mutation => {
                await mutation.assertPhysicalSourceBaseCurrent();
                await writer();
                await mutation.writeSource(Uint8Array.of(9, 8, 7));
                return true;
            },
        )).rejects.toThrow('physical source changed');

        expect(openingWitness).toBeTruthy();
        expect(writer).not.toHaveBeenCalled();
        await expect(store.read(sourceRef)).resolves.toEqual(openingBytes);
        expect((await store.requireEntry(workingRef)).sourceBaseWitness).toBe(openingWitness);
    });

    it('refreshes a handle-backed source without inventing a new source version after save', async () => {
        const bytes = Uint8Array.of(37, 80, 68, 70, 1, 2);
        const file = new File([bytes], 'saved-source.pdf', {
            type: 'application/pdf',
            lastModified: 777,
        });
        const handle = createFileSystemFileHandle({
            name: file.name,
            getFile: vi.fn(async () => file),
        });
        const store = new BrowserDocumentStore();
        const sourceRef = await store.registerFile(file, {
            kind: 'source',
            saveKind: 'pdf',
            saveHandle: handle,
        });

        await store.replaceWithHandleBackedDocument(sourceRef, {
            fileSize: bytes.byteLength,
            saveHandle: handle,
            saveName: file.name,
        });

        await expect(store.refreshSourceVersionIfChanged(sourceRef)).resolves.toBe(sourceRef);
    });

    it('rolls back interrupted chunk ingestion before a complete retry', async () => {
        const bytes = new Uint8Array(BROWSER_MAX_FULL_READ_BYTES + 1);
        bytes.fill(0x5a);
        bytes[0] = 0x31;
        bytes[bytes.byteLength - 1] = 0x39;
        const interruptedFile = new File([bytes], 'interrupted-source.pdf', {
            type: 'application/pdf',
            lastModified: 400,
        });
        const originalSlice = interruptedFile.slice.bind(interruptedFile);
        vi.spyOn(interruptedFile, 'slice').mockImplementation((start, end, contentType) => {
            if (start === BROWSER_DOCUMENT_CHUNK_SIZE) {
                const failingChunk = new Blob([], {type: contentType ?? ''});
                vi.spyOn(failingChunk, 'arrayBuffer').mockRejectedValue(new Error('ingestion interrupted'));
                return failingChunk;
            }
            return originalSlice(start, end, contentType);
        });
        const store = new BrowserDocumentStore();

        const interruptedRef = await store.registerFile(interruptedFile, {
            kind: 'source',
            saveKind: 'pdf',
        });
        const interruptedEntry = await store.requireEntry(interruptedRef);
        expect(interruptedEntry.memoryOnly).toBe(true);
        expect(interruptedEntry.storageMode).toBe('handle');

        const database = indexedDbFactory.getDatabase(DB_NAME);
        expect(database).toBeDefined();
        const documents = Array.from(database!.getStoreRecords('documents').values());
        const chunks = Array.from(database!.getStoreRecords('document-chunks').values());
        expect(documents).not.toEqual(expect.arrayContaining([expect.objectContaining({fileName: 'interrupted-source.pdf'})]));
        expect(chunks).not.toEqual(expect.arrayContaining([expect.objectContaining({ref: interruptedRef})]));

        const retryFile = new File([bytes], 'interrupted-source.pdf', {
            type: 'application/pdf',
            lastModified: 401,
        });
        const retryRef = await store.registerFile(retryFile, {
            kind: 'source',
            saveKind: 'pdf',
        });
        const retryEntry = await store.requireEntry(retryRef);
        expect(retryEntry.storageMode).toBe('chunked');
        expect(retryEntry.memoryOnly).toBe(false);
        await expect(store.readRange(retryRef, 0, 1)).resolves.toEqual(Uint8Array.of(0x31));
        await expect(store.readRange(retryRef, bytes.byteLength - 1, 1)).resolves.toEqual(Uint8Array.of(0x39));
    });

    it('does not publish a denied source read and accepts the next complete retry', async () => {
        const bytes = Uint8Array.of(37, 80, 68, 70, 49);
        const deniedFile = new File([bytes], 'denied-source.pdf', {
            type: 'application/pdf',
            lastModified: 500,
        });
        vi.spyOn(deniedFile, 'arrayBuffer').mockRejectedValue(
            new DOMException('Read permission denied', 'NotAllowedError'),
        );
        const store = new BrowserDocumentStore();

        await expect(store.registerFile(deniedFile, {
            kind: 'source',
            saveKind: 'pdf',
        })).rejects.toMatchObject({name: 'NotAllowedError'});

        const database = indexedDbFactory.getDatabase(DB_NAME);
        expect(database).toBeDefined();
        const documents = Array.from(database!.getStoreRecords('documents').values());
        expect(documents).not.toEqual(expect.arrayContaining([expect.objectContaining({fileName: 'denied-source.pdf'})]));

        const retryRef = await store.registerFile(new File([bytes], 'denied-source.pdf', {
            type: 'application/pdf',
            lastModified: 501,
        }), {
            kind: 'source',
            saveKind: 'pdf',
        });
        await expect(store.read(retryRef)).resolves.toEqual(bytes);
        expect((await store.requireEntry(retryRef)).memoryOnly).toBe(false);
    });

    it('fences live lease lifecycle transitions through the repository owner', async () => {
        const store = new BrowserDocumentStore();
        const ref = await store.createStoredDocument(
            'leased.pdf',
            Uint8Array.of(1, 2, 3),
            {
                mimeType: 'application/pdf',
                kind: 'working',
                saveKind: 'pdf',
            },
        );
        const dependencies = [{ref}];

        const created = await store.createLiveLease('window:482', dependencies);
        const heartbeat = await store.heartbeatLiveLease(
            created.ownerId,
            created.generation,
            dependencies,
        );
        const suspended = await store.suspendLiveLease(
            heartbeat.ownerId,
            heartbeat.generation,
            dependencies,
        );
        const resumed = await store.resumeLiveLease(
            suspended.ownerId,
            suspended.generation,
            dependencies,
        );
        const released = await store.releaseLiveLease(
            resumed.ownerId,
            resumed.generation,
        );

        expect(created).toEqual(expect.objectContaining({
            ownerId: 'window:482',
            generation: 1,
            leaseRevision: 1,
            status: 'active',
            protectedDependencies: dependencies,
        }));
        expect(heartbeat.generation).toBe(created.generation + 1);
        expect(suspended.status).toBe('suspended');
        expect(resumed.status).toBe('active');
        expect(released).toEqual(expect.objectContaining({
            status: 'dead',
            protectedDependencies: [],
        }));
        expect(released.leaseRevision).toBe(resumed.leaseRevision + 1);

        await expect(store.heartbeatLiveLease(
            created.ownerId,
            created.generation,
            dependencies,
        )).rejects.toThrow('live lease mutation');

        const database = indexedDbFactory.getDatabase(DB_NAME);
        expect(database?.getStoreRecords(BROWSER_LIVE_LEASES_STORE).get('owner:window:482')).toEqual(
            expect.objectContaining({
                status: 'dead',
                generation: released.generation,
            }),
        );
    });

});
