import {browserDocumentStore} from '@app/platform/browserDocumentStore';

function createEmptyFileSystemWritableFileStream(): FileSystemWritableFileStream {
    return Object.assign(new WritableStream(), {
        abort: async (_reason?: unknown) => {},
        close: async () => {},
        seek: async (_position: number) => {},
        truncate: async (_size: number) => {},
        write: async (_chunk: FileSystemWriteChunkType) => {},
    });
}

async function runBrowserDocumentSourceVersionAcceptance() {
    const firstBytes = Uint8Array.of(37, 80, 68, 70);
    const replacementBytes = Uint8Array.of(37, 80, 68, 71);
    let currentFile = new File([firstBytes], 'source-version.pdf', {
        lastModified: 100,
        type: 'application/pdf',
    });
    const handle = {
        kind: 'file' as const,
        name: 'source-version.pdf',
        getFile: async () => currentFile,
        isSameEntry: async () => true,
        createWritable: async () => createEmptyFileSystemWritableFileStream(),
        createSyncAccessHandle: async () => {
            throw new Error('Synchronous access is not part of this browser fixture');
        },
    } satisfies FileSystemFileHandle;
    const firstRef = await browserDocumentStore.registerFile(currentFile, {
        kind: 'source',
        saveKind: 'pdf',
        saveHandle: handle,
    });
    const dirtyRef = await browserDocumentStore.cloneAsWorkingCopy(firstRef);
    const dirtyBytes = Uint8Array.of(37, 80, 68, 70, 1);
    await browserDocumentStore.writeForBootstrap(dirtyRef, dirtyBytes, 'browser-source-version-acceptance');
    currentFile = new File([replacementBytes], 'source-version.pdf', {
        lastModified: 200,
        type: 'application/pdf',
    });
    const reopenedRef = await browserDocumentStore.registerFile(currentFile, {
        kind: 'source',
        saveKind: 'pdf',
        saveHandle: handle,
    });
    try {
        return {
            firstBytes: Array.from(await browserDocumentStore.read(firstRef)),
            reopenedBytes: Array.from(await browserDocumentStore.read(reopenedRef)),
            dirtyBytes: Array.from(await browserDocumentStore.read(dirtyRef)),
            reopenedIsFresh: reopenedRef !== firstRef,
            dirtySourceRefIsOriginal: (await browserDocumentStore.requireEntry(dirtyRef)).sourceRef === firstRef,
        };
    } finally {
        await browserDocumentStore.remove(dirtyRef).catch(() => undefined);
        await browserDocumentStore.remove(reopenedRef).catch(() => undefined);
        await browserDocumentStore.remove(firstRef).catch(() => undefined);
    }
}

Reflect.set(globalThis, '__evbRunBrowserDocumentSourceVersionAcceptance', runBrowserDocumentSourceVersionAcceptance);
