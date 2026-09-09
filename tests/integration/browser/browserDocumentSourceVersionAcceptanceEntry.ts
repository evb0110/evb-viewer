// fallow-ignore-file unused-file -- bundled by browserDocumentSourceVersionAcceptance.test.ts for Chromium.

import {browserDocumentStore} from '@app/platform/browserDocumentStore';
import {pickFiles} from '@app/platform/browser-api/browserFilePickerAdapter';
import {PDFDocument} from 'pdf-lib';

async function createPdfBytes(title: string, addSecondPage = false) {
    const document = await PDFDocument.create();
    document.setTitle(title);
    document.addPage([
        240,
        240,
    ]);
    if (addSecondPage) document.addPage([
        240,
        240,
    ]);
    return document.save();
}

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
    await browserDocumentStore.touchRecentFile(firstRef);
    const dirtyRef = await browserDocumentStore.cloneAsWorkingCopy(firstRef);
    const dirtyBytes = Uint8Array.of(37, 80, 68, 70, 1);
    await browserDocumentStore.writeForBootstrap(dirtyRef, dirtyBytes, 'browser-source-version-acceptance');
    currentFile = new File([replacementBytes], 'source-version.pdf', {
        lastModified: 200,
        type: 'application/pdf',
    });
    const reopenedRef = await browserDocumentStore.refreshSourceVersionIfChanged(firstRef);
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

async function runBrowserPickerAndRecentAcceptance() {
    const firstPdfRaw = await createPdfBytes('first physical version');
    const secondPdfRaw = await createPdfBytes('second physical version');
    const equalSize = Math.max(firstPdfRaw.length, secondPdfRaw.length);
    const firstPdf = new Uint8Array(equalSize);
    firstPdf.set(firstPdfRaw);
    firstPdf.fill(0x20, firstPdfRaw.length);
    const secondPdf = new Uint8Array(equalSize);
    secondPdf.set(secondPdfRaw);
    secondPdf.fill(0x20, secondPdfRaw.length);
    const changedSizePdf = await createPdfBytes('third physical version', true);
    let currentFile = new File([firstPdf], 'picker-recent-source.pdf', {
        lastModified: 100,
        type: 'application/pdf',
    });
    const handle = {
        kind: 'file' as const,
        name: currentFile.name,
        getFile: async () => currentFile,
        isSameEntry: async () => true,
        createWritable: async () => createEmptyFileSystemWritableFileStream(),
        createSyncAccessHandle: async () => {
            throw new Error('Synchronous access is not part of this browser fixture');
        },
    } satisfies FileSystemFileHandle;
    Object.defineProperty(window, 'showOpenFilePicker', {
        configurable: true,
        value: async () => [handle],
    });
    try {
        const openPickedFile = async () => {
            const picked = (await pickFiles({accept: 'application/pdf'}))[0];
            if (!picked) throw new Error('Picker did not return a file');
            const ref = await browserDocumentStore.registerFile(picked.file, {
                kind: 'source',
                saveKind: 'pdf',
                ...(picked.handle ? {saveHandle: picked.handle} : {}),
            });
            return ref;
        };
        const firstRef = await openPickedFile();
        const dirtyRef = await browserDocumentStore.cloneAsWorkingCopy(firstRef);
        const dirtyBytes = Uint8Array.of(37, 80, 68, 70, 1);
        await browserDocumentStore.writeForBootstrap(dirtyRef, dirtyBytes, 'browser-picker-acceptance');
        const firstWorkingBytes = await browserDocumentStore.read(firstRef);
        currentFile = new File([secondPdf], currentFile.name, {
            lastModified: 200,
            type: 'application/pdf',
        });
        const secondRef = await openPickedFile();
        const secondWorkingBytes = await browserDocumentStore.read(secondRef);
        const retainedDirtyBytes = await browserDocumentStore.read(dirtyRef);
        await browserDocumentStore.touchRecentFile(secondRef);
        const recent = browserDocumentStore.getRecentFiles();
        const recentPath = recent[0]?.originalPath;
        if (!recentPath) throw new Error('Recent Files did not contain the reopened PDF');
        const recentBytes = await browserDocumentStore.read(recentPath);
        const changedSizeFileBytes = changedSizePdf.slice().buffer as ArrayBuffer;
        currentFile = new File([changedSizeFileBytes], currentFile.name, {
            lastModified: 300,
            type: 'application/pdf',
        });
        const thirdRef = await openPickedFile();
        const thirdWorkingBytes = await browserDocumentStore.read(thirdRef);

        const largeBytes = new Uint8Array(16 * 1024 * 1024 + 33);
        largeBytes.fill(0x42);
        largeBytes[largeBytes.length - 1] = 0x24;
        const largeFile = new File([largeBytes], 'large-chunked-source.pdf', {lastModified: 400});
        const largeRef = await browserDocumentStore.registerFile(largeFile, {
            kind: 'source',
            saveKind: 'pdf',
        });
        const largeRange = await browserDocumentStore.readRange(largeRef, largeBytes.length - 8, 8);

        const deniedFile = new File([firstPdf], 'denied-picker-source.pdf', {lastModified: 500});
        Object.defineProperty(deniedFile, 'arrayBuffer', {
            configurable: true,
            value: async () => { throw new DOMException('Read permission denied', 'NotAllowedError'); },
        });
        let denied = false;
        try {
            await browserDocumentStore.registerFile(deniedFile, {
                kind: 'source',
                saveKind: 'pdf',
            });
        } catch (error) {
            denied = error instanceof DOMException && error.name === 'NotAllowedError';
        }
        const retryRef = await browserDocumentStore.registerFile(
            new File([firstPdf], deniedFile.name, {lastModified: 501}),
            {
                kind: 'source',
                saveKind: 'pdf',
            },
        );
        const retryBytes = await browserDocumentStore.read(retryRef);
        return {
            firstLength: firstWorkingBytes.length,
            secondLength: secondWorkingBytes.length,
            thirdLength: thirdWorkingBytes.length,
            firstPrefix: Array.from(firstWorkingBytes.slice(0, 5)),
            secondPrefix: Array.from(secondWorkingBytes.slice(0, 5)),
            thirdPrefix: Array.from(thirdWorkingBytes.slice(0, 5)),
            dirtyFirstUnchanged: Array.from(retainedDirtyBytes).join(',') === Array.from(dirtyBytes).join(','),
            recentReopened: recentPath === secondRef && recentBytes.length === secondWorkingBytes.length,
            equalSizeReplacement: secondWorkingBytes.length === firstWorkingBytes.length
            && Array.from(secondWorkingBytes).join(',') !== Array.from(firstWorkingBytes).join(','),
            changedSizeReplacement: thirdWorkingBytes.length !== secondWorkingBytes.length,
            largeRange: Array.from(largeRange),
            denied,
            retryComplete: retryBytes.length === firstPdf.length,
        };
    } finally {
        // The browser context owns this isolated IndexedDB fixture and closes
        // immediately after the acceptance journey completes.
        Reflect.deleteProperty(window, 'showOpenFilePicker');
    }
}

async function runBrowserRealInputPickerRecentAcceptance() {
    const first = (await pickFiles({
        accept: 'application/pdf',
        preferFileSystemAccess: false,
    }))[0];
    if (!first) throw new Error('Real Chromium input picker returned no first file');
    const firstRef = await browserDocumentStore.registerFile(first.file, {
        kind: 'source',
        saveKind: 'pdf',
    });
    const dirtyRef = await browserDocumentStore.cloneAsWorkingCopy(firstRef);
    await browserDocumentStore.writeForBootstrap(dirtyRef, Uint8Array.of(1, 2, 3), 'real-picker-acceptance');
    const second = (await pickFiles({
        accept: 'application/pdf',
        preferFileSystemAccess: false,
    }))[0];
    if (!second) throw new Error('Real Chromium input picker returned no replacement file');
    const secondRef = await browserDocumentStore.registerFile(second.file, {
        kind: 'source',
        saveKind: 'pdf',
    });
    await browserDocumentStore.touchRecentFile(secondRef);
    const recent = await browserDocumentStore.recoverRecentFilesIfStorageMissing();
    const recentRef = recent[0]?.originalPath;
    if (!recentRef) throw new Error('Real picker did not persist Recent Files');
    const [
        firstBytes,
        secondBytes,
        recentBytes,
        dirtyBytes,
    ] = await Promise.all([
        browserDocumentStore.read(firstRef),
        browserDocumentStore.read(secondRef),
        browserDocumentStore.read(recentRef),
        browserDocumentStore.read(dirtyRef),
    ]);
    return {
        dirtyBytes: Array.from(dirtyBytes),
        firstLength: firstBytes.length,
        recentRefIsReplacement: recentRef === secondRef,
        recentBytes: Array.from(recentBytes.slice(0, 8)),
        secondLength: secondBytes.length,
    };
}

type TFileSystemAccessAcceptanceStage = 'first' | 'equal-size-replacement' | 'changed-size-replacement';

let fileSystemAccessFirstRef: string | null = null;
let fileSystemAccessDirtyRef: string | null = null;
let fileSystemAccessHandle: FileSystemFileHandle | null = null;

async function runBrowserRealFileSystemAccessAcceptance(stage: TFileSystemAccessAcceptanceStage) {
    const picked = (await pickFiles({
        accept: 'application/pdf',
        preferFileSystemAccess: true,
    }))[0];
    if (!picked?.handle) {
        throw new Error('Real File System Access picker did not return a FileSystemFileHandle');
    }

    if (stage === 'first') {
        fileSystemAccessFirstRef = null;
        fileSystemAccessDirtyRef = null;
        fileSystemAccessHandle = null;
        fileSystemAccessFirstRef = await browserDocumentStore.registerFile(picked.file, {
            kind: 'source',
            saveKind: 'pdf',
            saveHandle: picked.handle,
        });
        fileSystemAccessHandle = picked.handle;
        fileSystemAccessDirtyRef = await browserDocumentStore.cloneAsWorkingCopy(fileSystemAccessFirstRef);
        await browserDocumentStore.writeForBootstrap(
            fileSystemAccessDirtyRef,
            Uint8Array.of(1, 2, 3),
            'browser-file-system-access-acceptance',
        );
    } else {
        if (!fileSystemAccessFirstRef || !fileSystemAccessDirtyRef || !fileSystemAccessHandle) {
            throw new Error('File System Access acceptance did not start with a first selection');
        }
        const samePhysicalEntry = await fileSystemAccessHandle.isSameEntry(picked.handle);
        if (!samePhysicalEntry) {
            throw new Error('Replacement selection did not return the same physical file entry');
        }
        const replacementRef = await browserDocumentStore.registerFile(picked.file, {
            kind: 'source',
            saveKind: 'pdf',
            saveHandle: picked.handle,
        });
        if (stage === 'changed-size-replacement') {
            await browserDocumentStore.touchRecentFile(replacementRef);
        }
        const [
            firstBytes,
            replacementBytes,
            dirtyBytes,
        ] = await Promise.all([
            browserDocumentStore.read(fileSystemAccessFirstRef),
            browserDocumentStore.read(replacementRef),
            browserDocumentStore.read(fileSystemAccessDirtyRef),
        ]);
        return {
            dirtyBytes: Array.from(dirtyBytes),
            firstBytes: Array.from(firstBytes),
            handleName: picked.handle.name,
            replacementBytes: Array.from(replacementBytes),
            replacementRef,
            samePhysicalEntry,
            stage,
        };
    }

    return {
        firstRef: fileSystemAccessFirstRef,
        handleName: picked.handle.name,
        stage,
    };
}

async function readBrowserRealFileSystemAccessRecentAfterReload() {
    const recentFiles = await browserDocumentStore.recoverRecentFilesIfStorageMissing();
    const recentRef = recentFiles[0]?.originalPath;
    if (!recentRef) throw new Error('File System Access acceptance did not persist a Recent file');
    return {
        recentBytes: Array.from(await browserDocumentStore.read(recentRef)),
        recentRef,
    };
}

Reflect.set(globalThis, '__evbRunBrowserDocumentSourceVersionAcceptance', runBrowserDocumentSourceVersionAcceptance);
Reflect.set(globalThis, '__evbRunBrowserPickerAndRecentAcceptance', runBrowserPickerAndRecentAcceptance);
Reflect.set(globalThis, '__evbRunBrowserRealInputPickerRecentAcceptance', runBrowserRealInputPickerRecentAcceptance);
Reflect.set(globalThis, '__evbRunBrowserRealFileSystemAccessAcceptance', runBrowserRealFileSystemAccessAcceptance);
Reflect.set(globalThis, '__evbReadBrowserRealFileSystemAccessRecentAfterReload', readBrowserRealFileSystemAccessRecentAfterReload);
