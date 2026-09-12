// fallow-ignore-file unused-file -- bundled by browserDocumentLiveLeaseAcceptance.test.ts for Chromium.

import {
    BROWSER_LIVE_LEASES_STORE,
    DOCUMENTS_STORE,
} from '@app/platform/browser/browserDocumentConstants';
import {
    loadAllRecordKeysAvailability,
    loadRecordAvailability,
    runObjectStoresTransaction,loadBrowserTransferAuthority,
} from '@app/platform/browser/browserDocumentIdb';
import {loadAllChunkKeysAvailability} from '@app/platform/browser/browserDocumentChunks';
import {browserDocumentStore} from '@app/platform/browser/browserDocumentRepository';
import {
    createBrowserDocumentLiveLease,
    releaseBrowserDocumentLiveLease,
    saveBrowserDocumentLiveLease,
    setBrowserDocumentLiveLeaseSuspended,
} from '@app/platform/browser/browserDocumentLeaseStore';
import {sweepBrowserDocumentMaintenance} from '@app/platform/browser/browserDocumentMaintenance';
import {writeRecentFilesToStorage} from '@app/platform/browser/browserRecentFilesStore';
import {browserWindowTabsCapability} from '@app/platform/browserWindowTabs';

const OWNER_ID = 'window:482-live-lease';
const INLINE_BYTES = Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8);
const SOURCE_BYTES = Uint8Array.of(11, 12, 13, 14, 15, 16, 17, 18);
const GENERATED_BYTES = Uint8Array.of(41, 42, 43, 44);

let ownerGeneration: number | null = null;
let liveRefs: {
    inlineSource: string;
    chunkedSource: string;
    generatedWorking: string;
} | null = null;
let dirtyTransferObservation: {
    phase: 'none' | 'provisional' | 'committed';
    beforeAck: number[];
    afterAck: number[];
} = {
    phase: 'none',
    beforeAck: [],
    afterAck: [],
};

async function setLeaseHeartbeat(heartbeatAt: number) {
    const committed = await runObjectStoresTransaction<boolean>(
        [BROWSER_LIVE_LEASES_STORE],
        'readwrite',
        (transaction, setResult) => {
            const store = transaction.objectStore(BROWSER_LIVE_LEASES_STORE);
            const request = store.get(`owner:${OWNER_ID}`);
            request.onsuccess = () => {
                const lease = request.result as Record<string, unknown> | undefined;
                if (!lease) {
                    setResult(false);
                    return;
                }
                store.put({
                    ...lease,
                    heartbeatAt,
                });
                setResult(true);
            };
        },
    );
    if (committed !== true) {
        throw new Error('Live lease heartbeat fixture mutation did not commit');
    }
}

async function agePendingGeneratedRecord(ref: string) {
    const committed = await runObjectStoresTransaction<boolean>(
        [DOCUMENTS_STORE],
        'readwrite',
        (transaction, setResult) => {
            const store = transaction.objectStore(DOCUMENTS_STORE);
            const request = store.get(ref);
            request.onsuccess = () => {
                const record = request.result as Record<string, unknown> | undefined;
                if (!record) {
                    setResult(false);
                    return;
                }
                store.put({
                    ...record,
                    pendingChunkUpdatedAt: 1,
                });
                setResult(true);
            };
        },
    );
    if (committed !== true) {
        throw new Error('Generated record age fixture mutation did not commit');
    }
}

async function inspectRefs(refs: string[]) {
    const recordResults = await Promise.all(refs.map(ref => loadRecordAvailability(ref)));
    const chunkResult = await loadAllChunkKeysAvailability();
    const chunkKeys = chunkResult.available && Array.isArray(chunkResult.value)
        ? chunkResult.value.filter((key): key is string => typeof key === 'string')
        : [];
    return {
        records: recordResults.map(result => (
            result.available
            && result.value !== null
            && result.value !== undefined
        )),
        chunkKeyCounts: refs.map(ref => chunkKeys.filter(key => key.startsWith(`${ref}::`)).length),
    };
}

async function setupLiveLeaseAcceptance() {
    writeRecentFilesToStorage([]);
    const created = await createBrowserDocumentLiveLease(OWNER_ID);
    const inlineSource = await browserDocumentStore.createStoredDocument(
        'live-lease-inline.pdf',
        INLINE_BYTES,
        {
            kind: 'source',
            retention: 'durable',
            mimeType: 'application/pdf',
        },
    );
    const chunkedSource = await browserDocumentStore.createStoredDocument(
        'live-lease-source.pdf',
        SOURCE_BYTES,
        {
            kind: 'source',
            retention: 'durable',
            mimeType: 'application/pdf',
            storageMode: 'chunked',
            chunkSize: 4,
        },
    );
    const generatedWorking = await browserDocumentStore.cloneAsWorkingCopy(
        chunkedSource,
        'live-lease-generated.pdf',
    );
    await browserDocumentStore.prepareChunkedDocument(generatedWorking, {chunkSize: 4});
    await browserDocumentStore.writeChunk(generatedWorking, 0, GENERATED_BYTES);
    const sourceEntry = await browserDocumentStore.requireEntry(chunkedSource);
    const generatedEntry = await browserDocumentStore.requireEntry(generatedWorking);
    const refs = {
        inlineSource,
        chunkedSource,
        generatedWorking,
    };
    const dependencies = [
        {ref: inlineSource},
        ...(sourceEntry.chunkGeneration
            ? [{
                ref: chunkedSource,
                chunkGeneration: sourceEntry.chunkGeneration,
            }]
            : []),
        {ref: generatedWorking},
        ...(generatedEntry.pendingChunkGeneration
            ? [{
                ref: generatedWorking,
                chunkGeneration: generatedEntry.pendingChunkGeneration,
            }]
            : []),
    ];
    const active = await saveBrowserDocumentLiveLease(
        created.ownerId,
        created.generation,
        'active',
        dependencies,
    );
    ownerGeneration = active.generation;
    liveRefs = refs;
    await agePendingGeneratedRecord(generatedWorking);
    await setLeaseHeartbeat(1);
    return {
        refs,
        createdGeneration: created.generation,
        activeGeneration: active.generation,
        activeStatus: active.status,
        dependencies,
    };
}

async function suspendLiveLeaseAcceptance() {
    if (ownerGeneration === null || !liveRefs) {
        throw new Error('Live lease acceptance was not initialized');
    }
    const suspended = await setBrowserDocumentLiveLeaseSuspended(
        OWNER_ID,
        ownerGeneration,
        true,
        [
            {ref: liveRefs.inlineSource},
            {ref: liveRefs.chunkedSource},
            {ref: liveRefs.generatedWorking},
        ],
    );
    ownerGeneration = suspended.generation;
    await setLeaseHeartbeat(1);
    return {
        generation: suspended.generation,
        status: suspended.status,
    };
}

async function resumeLiveLeaseAcceptance() {
    if (ownerGeneration === null || !liveRefs) {
        throw new Error('Live lease acceptance was not initialized');
    }
    const resumed = await setBrowserDocumentLiveLeaseSuspended(
        OWNER_ID,
        ownerGeneration,
        false,
        [
            {ref: liveRefs.inlineSource},
            {ref: liveRefs.chunkedSource},
            {ref: liveRefs.generatedWorking},
        ],
    );
    ownerGeneration = resumed.generation;
    await setLeaseHeartbeat(1);
    return {
        generation: resumed.generation,
        status: resumed.status,
    };
}

async function initializeAndSweepFromAnotherStore(serializedRefs?: string) {
    if (serializedRefs) {
        liveRefs = JSON.parse(serializedRefs) as typeof liveRefs;
    }
    if (!liveRefs) {
        const keysResult = await loadAllRecordKeysAvailability();
        const keys = keysResult.available && Array.isArray(keysResult.value)
            ? keysResult.value.filter((key): key is string => typeof key === 'string')
            : [];
        const records = await Promise.all(keys.map(key => loadRecordAvailability(key)));
        const refsByName = new Map(
            records.flatMap(result => {
                const record = result.available && result.value !== null
                    ? result.value as {
                        fileName?: unknown;
                        ref?: unknown
                    }
                    : null;
                return typeof record?.fileName === 'string' && typeof record.ref === 'string'
                    ? [[
                        record.fileName,
                        record.ref,
                    ] as const]
                    : [];
            }),
        );
        liveRefs = {
            inlineSource: refsByName.get('live-lease-inline.pdf') ?? '',
            chunkedSource: refsByName.get('live-lease-source.pdf') ?? '',
            generatedWorking: refsByName.get('live-lease-generated.pdf') ?? '',
        };
    }
    await browserDocumentStore.requireEntry(liveRefs.inlineSource);
    await browserDocumentStore.requireEntry(liveRefs.generatedWorking);
    await sweepBrowserDocumentMaintenance(new Map());
    return inspectRefs(Object.values(liveRefs));
}

async function finalizeGeneratedDocument() {
    if (!liveRefs) {
        throw new Error('Live lease acceptance was not initialized');
    }
    await browserDocumentStore.finalizeChunkedDocument(liveRefs.generatedWorking, {
        fileSize: GENERATED_BYTES.byteLength,
        chunkCount: 1,
        chunkSize: GENERATED_BYTES.byteLength,
        saveName: 'live-lease-generated-final.pdf',
    });
    return {generation: ownerGeneration};
}

async function reopenGeneratedDocument(ref: string) {
    browserDocumentStore.unload(ref);
    return {bytes: Array.from(await browserDocumentStore.readRange(ref, 0, GENERATED_BYTES.byteLength))};
}

async function reclaimAfterConfirmedDeath() {
    if (ownerGeneration === null || !liveRefs) {
        throw new Error('Live lease acceptance was not initialized');
    }
    const released = await releaseBrowserDocumentLiveLease(OWNER_ID, ownerGeneration);
    ownerGeneration = released.generation;
    const originalDateNow = Date.now;
    Date.now = () => originalDateNow() + 11 * 60 * 1_000;
    try {
        await sweepBrowserDocumentMaintenance(new Map());
    } finally {
        Date.now = originalDateNow;
    }
    return {
        releaseStatus: released.status,
        releaseGeneration: released.generation,
        after: await inspectRefs(Object.values(liveRefs)),
    };
}

function prepareTransferReceiver() {
    browserWindowTabsCapability.notifyRendererReady();
    browserWindowTabsCapability.onIncomingTransfer(transfer => {
        void browserWindowTabsCapability.transferAck({
            transferId: transfer.transferId,
            success: true,
        });
    });
    return browserWindowTabsCapability.listTargetWindows();
}

async function transferEmptyTab() {
    browserWindowTabsCapability.notifyRendererReady();
    const result = await browserWindowTabsCapability.transfer({
        target: {
            kind: 'window',
            windowId: 2,
        },
        tab: {
            fileName: null,
            originalPath: null,
            isDirty: false,
            isDjvu: false,
        },
        payload: {kind: 'empty'},
        timeoutMs: 3_000,
    });
    return result;
}

function prepareDirtyTransferReceiver() {
    browserWindowTabsCapability.notifyRendererReady();
    browserWindowTabsCapability.onIncomingTransfer(transfer => {
        void (async () => {
            if (transfer.payload.kind !== 'pdfSnapshot') {
                return;
            }
            await browserDocumentStore.requireEntry(transfer.payload.snapshotPath);
            dirtyTransferObservation = {
                phase: 'provisional',
                beforeAck: Array.from(await browserDocumentStore.read(transfer.payload.snapshotPath)),
                afterAck: [],
            };
            const pending = await loadBrowserTransferAuthority(transfer.transferId);
            if (pending?.state !== 'pending') {
                throw new Error('Dirty transfer was editable before durable acknowledgement');
            }
            const committed = await browserWindowTabsCapability.transferAck({
                transferId: transfer.transferId,
                success: true,
            });
            if (!committed) {
                throw new Error('Dirty transfer did not receive durable commit');
            }
            const authority = await loadBrowserTransferAuthority(transfer.transferId);
            dirtyTransferObservation = {
                phase: authority?.state === 'committed' ? 'committed' : 'provisional',
                beforeAck: dirtyTransferObservation.beforeAck,
                afterAck: Array.from(await browserDocumentStore.read(transfer.payload.snapshotPath)),
            };
        })().catch(error => {
            void browserWindowTabsCapability.transferAck({
                transferId: transfer.transferId,
                success: false,
                error: String(error),
            });
        });
    });
    return browserWindowTabsCapability.listTargetWindows();
}

async function transferDirtyTab() {
    const originalPath = await browserDocumentStore.createStoredDocument(
        'transfer-original.pdf',
        Uint8Array.of(1, 2, 3),
        {
            kind: 'source',
            retention: 'durable',
            mimeType: 'application/pdf',
        },
    );
    const editedBytes = Uint8Array.of(90, 91, 92, 93);
    const snapshotPath = await browserDocumentStore.createStoredDocument(
        'transfer-dirty.pdf',
        editedBytes,
        {
            kind: 'working',
            retention: 'durable',
            mimeType: 'application/pdf',
            sourceRef: originalPath,
        },
    );
    browserWindowTabsCapability.notifyRendererReady();
    const result = await browserWindowTabsCapability.transfer({
        target: {
            kind: 'window',
            windowId: 2,
        },
        tab: {
            fileName: 'transfer-dirty.pdf',
            originalPath,
            isDirty: true,
            isDjvu: false,
        },
        payload: {
            kind: 'pdfSnapshot',
            fileName: 'transfer-dirty.pdf',
            originalPath,
            snapshotPath,
            isDirty: true,
        },
        timeoutMs: 3_000,
    });
    return result;
}

function readDirtyTransferObservation() {
    return dirtyTransferObservation;
}

async function waitForDirtyTransferCommit() {
    for (let attempt = 0; attempt < 40; attempt += 1) {
        if (dirtyTransferObservation.phase === 'committed') {
            return dirtyTransferObservation;
        }
        await new Promise<void>(resolve => setTimeout(resolve, 25));
    }
    return dirtyTransferObservation;
}

// Closing a page releases its lease lock, but the browser does that on its own
// schedule and a sweep issued straight after close can still observe the lock.
// Queuing an exclusive request behind the dying holder waits for exactly that
// release and nothing else, so the sweep that follows sees a settled state.
async function awaitLeaseOwnerLockReleased() {
    await navigator.locks.request(
        `evb-viewer:browser-lease-owner:${OWNER_ID}`,
        {mode: 'exclusive'},
        () => undefined,
    );
    return {released: true};
}

Reflect.set(globalThis, '__evbAwaitLeaseOwnerLockReleased', awaitLeaseOwnerLockReleased);
Reflect.set(globalThis, '__evbSetupLiveLeaseAcceptance', setupLiveLeaseAcceptance);
Reflect.set(globalThis, '__evbAgeLiveLeaseAcceptance', () => setLeaseHeartbeat(1));
Reflect.set(globalThis, '__evbSuspendLiveLeaseAcceptance', suspendLiveLeaseAcceptance);
Reflect.set(globalThis, '__evbResumeLiveLeaseAcceptance', resumeLiveLeaseAcceptance);
Reflect.set(globalThis, '__evbInitializeAndSweepLiveLeaseAcceptance', initializeAndSweepFromAnotherStore);
Reflect.set(globalThis, '__evbFinalizeLiveLeaseAcceptance', finalizeGeneratedDocument);
Reflect.set(globalThis, '__evbReopenLiveLeaseAcceptance', reopenGeneratedDocument);
Reflect.set(globalThis, '__evbReclaimLiveLeaseAcceptance', reclaimAfterConfirmedDeath);
Reflect.set(globalThis, '__evbPrepareTransferReceiver', prepareTransferReceiver);
Reflect.set(globalThis, '__evbTransferEmptyTab', transferEmptyTab);
Reflect.set(globalThis, '__evbPrepareDirtyTransferReceiver', prepareDirtyTransferReceiver);
Reflect.set(globalThis, '__evbTransferDirtyTab', transferDirtyTab);
Reflect.set(globalThis, '__evbReadDirtyTransferObservation', readDirtyTransferObservation);
Reflect.set(globalThis, '__evbWaitForDirtyTransferCommit', waitForDirtyTransferCommit);
