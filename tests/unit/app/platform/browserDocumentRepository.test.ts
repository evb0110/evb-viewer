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
        const documents = Array.from(database?.getStoreRecords('documents').values() ?? []);
        const chunks = Array.from(database?.getStoreRecords('document-chunks').values() ?? []);
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
        const documents = Array.from(database?.getStoreRecords('documents').values() ?? []);
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
});
