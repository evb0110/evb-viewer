// fallow-ignore-file unused-file -- bundled by browserDocumentMaintenanceAcceptance.test.ts for Chromium.

import {sweepBrowserDocumentMaintenance} from '@app/platform/browser/browserDocumentMaintenance';
import {browserDocumentStore} from '@app/platform/browserDocumentStore';
import {createBrowserDocumentsFileCapability} from '@app/platform/browser-api/createBrowserDocumentsFileCapability';
import {parseDocumentRef} from '@contracts/documentRef';
import {createEpochMs} from '@contracts/timestamps';
import {
    runSerializedRecentFilesStorageMutation,
    writeRecentFilesToStorage,
} from '@app/platform/browser/browserRecentFilesStore';

const CHANNEL_NAME = 'evb-browser-maintenance-acceptance';

function waitForMessage(channel: BroadcastChannel, expected: string, timeoutMs = 30_000) {
    return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
            channel.removeEventListener('message', onMessage);
            reject(new Error(`Timed out waiting for maintenance message: ${expected}`));
        }, timeoutMs);
        const onMessage = (event: MessageEvent<unknown>) => {
            if (event.data === expected) {
                clearTimeout(timer);
                channel.removeEventListener('message', onMessage);
                resolve();
            }
        };
        channel.addEventListener('message', onMessage);
    });
}

async function readProof(ref: string) {
    const bytes = await browserDocumentStore.readRange(ref, 0, 8);
    return {
        exists: await browserDocumentStore.exists(ref),
        length: bytes.length,
        prefix: Array.from(bytes),
    };
}

async function readPersistedRecentProof() {
    const capability = createBrowserDocumentsFileCapability({clearSearchCaches: async () => undefined});
    const recentFiles = await capability.recentFiles.get();
    const refs = recentFiles.slice(0, 2).map(file => file.originalPath);
    const openedProofs = await Promise.all(refs.map(async ref => {
        const opened = await capability.openDocumentDirect(ref);
        if (!opened || opened.kind !== 'pdf') {
            throw new Error(`Persisted Recent file did not open: ${ref}`);
        }
        try {
            return await readProof(opened.workingPath);
        } finally {
            await browserDocumentStore.remove(opened.workingPath).catch(() => undefined);
        }
    }));
    return {
        openedProofs,
        refs,
        proofs: await Promise.all(refs.map(readProof)),
    };
}

async function runTouchWindow(refs: string[]) {
    const channel = new BroadcastChannel(CHANNEL_NAME);
    const readyBeacon = window.setInterval(() => channel.postMessage('touch-listener-ready'), 50);
    try {
        channel.postMessage('touch-listener-ready');
        await waitForMessage(channel, 'snapshot-ready');
        window.clearInterval(readyBeacon);
        await runSerializedRecentFilesStorageMutation(currentFiles => ({
            files: [
                ...refs.map((ref, index) => {
                    const originalPath = parseDocumentRef(ref);
                    if (!originalPath) throw new Error(`Invalid maintenance test ref: ${ref}`);
                    return {
                        originalPath,
                        backend: 'browser' as const,
                        fileName: `maintenance-${index}.pdf`,
                        timestamp: createEpochMs(2),
                        fileSize: index === 0 ? 32 : 4 * 1024 * 1024 + 17,
                    };
                }),
                ...currentFiles,
            ],
            value: undefined,
        }));
        channel.postMessage('touch-committed');
        return {recentFiles: browserDocumentStore.getRecentFiles().map(file => file.originalPath)};
    } finally {
        window.clearInterval(readyBeacon);
        channel.close();
    }
}

async function runMaintenanceWindow(refs: string[]) {
    const channel = new BroadcastChannel(CHANNEL_NAME);
    try {
        await waitForMessage(channel, 'touch-listener-ready');
        writeRecentFilesToStorage([]);
        await sweepBrowserDocumentMaintenance(new Map(), {beforeDestructiveTransaction: async () => {
            channel.postMessage('snapshot-ready');
            await waitForMessage(channel, 'touch-committed');
        }});
        return {
            inline: await readProof(refs[0] ?? ''),
            chunked: await readProof(refs[1] ?? ''),
            recentFiles: browserDocumentStore.getRecentFiles().map(file => file.originalPath),
        };
    } finally {
        channel.close();
    }
}

async function createAcceptanceDocuments() {
    const inlineBytes = Uint8Array.from({length: 32}, (_value, index) => index + 1);
    const chunkedBytes = new Uint8Array(4 * 1024 * 1024 + 17);
    chunkedBytes.fill(0x5a);
    chunkedBytes[chunkedBytes.length - 1] = 0x7b;
    const inline = await browserDocumentStore.createStoredDocument(
        'maintenance-inline.pdf',
        inlineBytes,
        {
            kind: 'source',
            retention: 'durable',
            mimeType: 'application/pdf',
        },
    );
    const chunked = await browserDocumentStore.createStoredDocument(
        'maintenance-chunked.pdf',
        chunkedBytes,
        {
            kind: 'source',
            retention: 'durable',
            mimeType: 'application/pdf',
        },
    );
    const orphan = await browserDocumentStore.createStoredDocument(
        'maintenance-orphan.pdf',
        Uint8Array.of(9, 8, 7, 6),
        {
            kind: 'source',
            retention: 'durable',
            mimeType: 'application/pdf',
        },
    );
    return {
        refs: [
            inline,
            chunked,
            orphan,
        ],
        hashes: {
            inlineLength: inlineBytes.length,
            inlinePrefix: Array.from(inlineBytes.slice(0, 8)),
            chunkedLength: chunkedBytes.length,
            chunkedPrefix: Array.from(chunkedBytes.slice(0, 8)),
        },
    };
}

async function runRecentPersistenceFailureRetry(ref: string) {
    const storage = window.localStorage;
    const originalSetItem = storage.setItem;
    Object.defineProperty(storage, 'setItem', {
        configurable: true,
        value: () => {
            throw new Error('synthetic Recent Files persistence failure');
        },
    });
    let failed = false;
    try {
        await runSerializedRecentFilesStorageMutation(currentFiles => ({
            files: currentFiles.filter(file => file.originalPath !== ref),
            value: undefined,
        }));
    } catch {
        failed = true;
    } finally {
        Object.defineProperty(storage, 'setItem', {
            configurable: true,
            value: originalSetItem,
        });
    }
    await runSerializedRecentFilesStorageMutation(currentFiles => ({
        files: currentFiles.filter(file => file.originalPath !== ref),
        value: true,
    }));
    return {
        failed,
        retryCommitted: browserDocumentStore.getRecentFiles().every(file => file.originalPath !== ref),
    };
}

Reflect.set(globalThis, '__evbCreateMaintenanceAcceptanceDocuments', createAcceptanceDocuments);
Reflect.set(globalThis, '__evbRunMaintenanceWindow', runMaintenanceWindow);
Reflect.set(globalThis, '__evbRunMaintenanceTouchWindow', runTouchWindow);
Reflect.set(globalThis, '__evbReadMaintenanceDocument', readProof);
Reflect.set(globalThis, '__evbReadPersistedMaintenanceRecent', readPersistedRecentProof);
Reflect.set(globalThis, '__evbExistsMaintenanceDocument', (ref: string) => browserDocumentStore.exists(ref));
Reflect.set(globalThis, '__evbRunRecentPersistenceFailureRetry', runRecentPersistenceFailureRetry);
