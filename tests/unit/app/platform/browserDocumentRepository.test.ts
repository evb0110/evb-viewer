import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {BrowserDocumentStore} from '@app/platform/browser/browserDocumentRepository';
import {
    createFileSystemFileHandle,
    FakeIndexedDbFactory,
    MemoryStorage,
} from '@tests/unit/app/platform/browserPlatformTestDoubles';

describe('BrowserDocumentStore source registration', () => {
    beforeEach(() => {
        vi.unstubAllGlobals();
        vi.stubGlobal('indexedDB', new FakeIndexedDbFactory());
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
});
