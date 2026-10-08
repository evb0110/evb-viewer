import {
    mkdtemp,
    readFile,
    rm,
} from 'node:fs/promises';
import {
    createServer,
    type Server,
} from 'node:http';
import {tmpdir} from 'node:os';
import {
    join,
    resolve,
} from 'node:path';
import {build} from 'esbuild';
import type * as BrowserDocumentIdb from '../../../app/platform/browser/browserDocumentIdb';
import type * as BrowserDocumentRepository from '../../../app/platform/browser/browserDocumentRepository';
import type * as BrowserDocumentMaintenance from '../../../app/platform/browser/browserDocumentMaintenance';
import {
    chromium,
    type Page,
} from 'playwright';
import {
    afterAll,
    beforeAll,
    describe,
    expect,
    it,
} from 'vitest';

let bundlePath = '';
let recoveryBundlePath = '';
let documentBundlePath = '';
let maintenanceBundlePath = '';
let pdfFixture: number[] = [];
let temporaryDirectory = '';
let origin = '';
let server: Server;

const RECOVERY_DATABASE_NAME = 'evb-viewer-browser-documents';
const ISSUE_489_PDF_TEXT = '%PDF-1.4\n% issue-489 synthetic dirty PDF\n';
const ISSUE_489_PDF_REF = 'browser://documents/issue-489-dirty.pdf';
const RECOVERY_TRANSACTION_BOUNDARY_BARRIER_GLOBAL = '__issue489RecoveryTransactionBoundaryBarrier';

interface IRecoveryMutationResult {
    saved: boolean;
    generation: number;
}

interface IRecoveryClaimResult {
    claimed: boolean;
    generation: number;
}

function buildRecoveryCheckpoint(capturedAt: number, fileName: string) {
    return {
        version: 1,
        capturedAt,
        activePaneId: 'pane-issue-489',
        activeTabId: 'tab-issue-489',
        layout: {
            type: 'leaf',
            paneId: 'pane-issue-489',
        },
        panes: [{
            paneId: 'pane-issue-489',
            tabIds: ['tab-issue-489'],
            activeTabId: 'tab-issue-489',
        }],
        tabs: [{
            tabId: 'tab-issue-489',
            paneId: 'pane-issue-489',
            fileName,
            sourceRef: ISSUE_489_PDF_REF,
            workingCopyRef: ISSUE_489_PDF_REF,
            requiresSaveAsOnFirstSave: true,
            isDirty: true,
            isDjvu: false,
            currentPage: 1,
            zoom: 1,
            zoomMode: 'custom',
        }],
    };
}

async function observeRecoveryTransactionAdmission(page: Page) {
    await page.evaluate((barrierGlobal) => {
        const existing = Reflect.get(globalThis, barrierGlobal);
        if (existing) {
            throw new Error('The recovery transaction admission observer is already installed.');
        }
        const transactionDescriptor = Object.getOwnPropertyDescriptor(
            IDBDatabase.prototype,
            'transaction',
        );
        if (!transactionDescriptor || typeof transactionDescriptor.value !== 'function') {
            throw new Error('The Chromium IndexedDB transaction method is not patchable.');
        }

        let transactionRestored = false;

        const state = {
            transactionAdmitted: false,
            operation: null as Promise<unknown> | null,
            cleanup: () => {
                if (!transactionRestored) {
                    Object.defineProperty(IDBDatabase.prototype, 'transaction', transactionDescriptor);
                    transactionRestored = true;
                }
                Reflect.deleteProperty(globalThis, barrierGlobal);
            },
        };

        const originalTransaction = transactionDescriptor.value as IDBDatabase['transaction'];
        const transactionAtProductionBoundary = function(
            this: IDBDatabase,
            nameOrNames: string | string[],
            mode?: IDBTransactionMode,
            options?: IDBTransactionOptions,
        ) {
            const names = typeof nameOrNames === 'string' ? [nameOrNames] : nameOrNames;
            const transaction = originalTransaction.call(this, nameOrNames, mode, options);
            if ((mode ?? 'readonly') === 'readwrite' && names.includes('workspace-recovery')) {
                state.transactionAdmitted = true;
            }
            return transaction;
        };

        Object.defineProperty(IDBDatabase.prototype, 'transaction', {
            ...transactionDescriptor,
            value: transactionAtProductionBoundary,
        });
        Reflect.set(globalThis, barrierGlobal, state);
    }, RECOVERY_TRANSACTION_BOUNDARY_BARRIER_GLOBAL);
}

async function waitForRecoveryTransactionAdmission(page: Page) {
    await page.waitForFunction((barrierGlobal) => {
        const barrier = Reflect.get(globalThis, barrierGlobal) as {transactionAdmitted?: boolean} | undefined;
        return barrier?.transactionAdmitted === true;
    }, RECOVERY_TRANSACTION_BOUNDARY_BARRIER_GLOBAL);
}

async function readRecoveryTransactionAdmission(page: Page) {
    return page.evaluate((barrierGlobal) => {
        const barrier = Reflect.get(globalThis, barrierGlobal) as {transactionAdmitted: boolean;} | undefined;
        if (!barrier) {
            throw new Error('The recovery transaction boundary barrier is not installed.');
        }
        return {transactionAdmitted: barrier.transactionAdmitted};
    }, RECOVERY_TRANSACTION_BOUNDARY_BARRIER_GLOBAL);
}

async function startClaimAfterTransactionAdmissionObservation(
    page: Page,
    sourceOwnerId: string,
    targetOwnerId: string,
    generation: number,
    leaseRevision: number,
    now: number,
) {
    await page.evaluate(({
        barrierGlobal,
        generation: expectedGeneration,
        leaseRevision: expectedLeaseRevision,
        now: claimNow,
        sourceOwner,
        targetOwner,
    }) => {
        const barrier = Reflect.get(globalThis, barrierGlobal) as {operation: Promise<unknown> | null} | undefined;
        if (!barrier) {
            throw new Error('The recovery transaction boundary barrier is not installed.');
        }
        const store = Reflect.get(globalThis, 'EvbBrowserWorkspaceRecovery') as {claimBrowserWorkspaceRecoveryOwner: (
            sourceOwnerId: string,
            targetOwnerId: string,
            generation: number,
            leaseRevision: number,
        ) => Promise<unknown>};
        const originalDateNow = Date.now;
        const installedDateNow = () => claimNow;
        Date.now = installedDateNow;
        barrier.operation = store.claimBrowserWorkspaceRecoveryOwner(
            sourceOwner,
            targetOwner,
            expectedGeneration,
            expectedLeaseRevision,
        ).finally(() => {
            if (Date.now === installedDateNow) Date.now = originalDateNow;
        });
    }, {
        barrierGlobal: RECOVERY_TRANSACTION_BOUNDARY_BARRIER_GLOBAL,
        generation,
        leaseRevision,
        now,
        sourceOwner: sourceOwnerId,
        targetOwner: targetOwnerId,
    });
}

async function startHeartbeatAfterTransactionAdmissionObservation(
    page: Page,
    ownerId: string,
    generation: number,
    now: number,
) {
    await page.evaluate(({
        barrierGlobal,
        heartbeatGeneration,
        heartbeatNow,
        heartbeatOwner,
    }) => {
        const barrier = Reflect.get(globalThis, barrierGlobal) as {operation: Promise<unknown> | null} | undefined;
        if (!barrier) {
            throw new Error('The recovery transaction boundary barrier is not installed.');
        }
        const store = Reflect.get(globalThis, 'EvbBrowserWorkspaceRecovery') as {touchBrowserWorkspaceRecovery: (
            ownerId: string,
            generation: number,
        ) => Promise<unknown>};
        const originalDateNow = Date.now;
        const installedDateNow = () => heartbeatNow;
        Date.now = installedDateNow;
        barrier.operation = store.touchBrowserWorkspaceRecovery(
            heartbeatOwner,
            heartbeatGeneration,
        ).finally(() => {
            if (Date.now === installedDateNow) Date.now = originalDateNow;
        });
    }, {
        barrierGlobal: RECOVERY_TRANSACTION_BOUNDARY_BARRIER_GLOBAL,
        heartbeatGeneration: generation,
        heartbeatNow: now,
        heartbeatOwner: ownerId,
    });
}

async function awaitRecoveryOperationResult<T>(page: Page) {
    let result: T;
    try {
        result = await page.evaluate(async (barrierGlobal) => {
            const barrier = Reflect.get(globalThis, barrierGlobal) as {operation: Promise<unknown> | null} | undefined;
            if (!barrier?.operation) {
                throw new Error('The recovery operation was not started at the transaction boundary.');
            }
            return barrier.operation;
        }, RECOVERY_TRANSACTION_BOUNDARY_BARRIER_GLOBAL) as T;
    } finally {
        await page.evaluate((barrierGlobal) => {
            const barrier = Reflect.get(globalThis, barrierGlobal) as {cleanup: () => void} | undefined;
            barrier?.cleanup();
        }, RECOVERY_TRANSACTION_BOUNDARY_BARRIER_GLOBAL);
    }
    return result;
}

beforeAll(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'evb-idb-migration-'));
    bundlePath = join(temporaryDirectory, 'browser-document-idb.js');
    recoveryBundlePath = join(temporaryDirectory, 'browser-workspace-recovery.js');
    documentBundlePath = join(temporaryDirectory, 'browser-documents.js');
    maintenanceBundlePath = join(temporaryDirectory, 'browser-maintenance.js');
    pdfFixture = Array.from(await readFile(resolve('tests/fixtures/electron/generated-text.pdf')));
    await build({
        bundle: true,
        entryPoints: [resolve(process.cwd(), 'app/platform/browser/browserDocumentIdb.ts')],
        format: 'iife',
        globalName: 'EvbBrowserDocumentIdb',
        outfile: bundlePath,
        platform: 'browser',
        sourcemap: false,
        tsconfig: resolve(process.cwd(), 'tsconfig.json'),
    });
    await build({
        bundle: true,
        entryPoints: [resolve(process.cwd(), 'app/platform/browser/browserWorkspaceRecoveryStore.ts')],
        format: 'iife',
        globalName: 'EvbBrowserWorkspaceRecovery',
        outfile: recoveryBundlePath,
        platform: 'browser',
        sourcemap: false,
        tsconfig: resolve(process.cwd(), 'tsconfig.json'),
    });
    for (const [
        entryPoint,
        globalName,
        outfile,
    ] of [
            [
                'app/platform/browser/browserDocumentRepository.ts',
                'EvbBrowserDocuments',
                documentBundlePath,
            ],
            [
                'app/platform/browser/browserDocumentMaintenance.ts',
                'EvbBrowserMaintenance',
                maintenanceBundlePath,
            ],
        ]) {
        await build({
            bundle: true,
            entryPoints: [resolve(process.cwd(), entryPoint!)],
            format: 'iife',
            globalName: globalName!,
            outfile: outfile!,
            platform: 'browser',
            sourcemap: false,
            tsconfig: resolve(process.cwd(), 'tsconfig.json'),
        });
    }
    server = createServer((_request, response) => {
        response.writeHead(200, {'content-type': 'text/html'});
        response.end('<!doctype html><title>IndexedDB migration harness</title>');
    });
    await new Promise<void>((resolveListen, rejectListen) => {
        server.once('error', rejectListen);
        server.listen(0, '127.0.0.1', resolveListen);
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('IndexedDB migration harness did not bind a TCP port');
    }
    origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
    await new Promise<void>(resolveClose => server.close(() => resolveClose()));
    await rm(temporaryDirectory, {
        force: true,
        recursive: true,
    });
});

describe('browser document IndexedDB migration in Chromium', () => {
    it('upgrades a v1 database without losing its document records', async () => {
        const browser = await chromium.launch({headless: true});
        try {
            const page = await browser.newPage();
            await page.goto(origin);
            await page.evaluate(async () => {
                await new Promise<void>((resolveDelete) => {
                    const request = indexedDB.deleteDatabase('evb-viewer-browser-documents');
                    request.onsuccess = () => resolveDelete();
                    request.onerror = () => resolveDelete();
                });
                await new Promise<void>((resolveSeed, rejectSeed) => {
                    const request = indexedDB.open('evb-viewer-browser-documents', 1);
                    request.onupgradeneeded = () => {
                        request.result.createObjectStore('documents', {keyPath: 'ref'});
                    };
                    request.onerror = () => rejectSeed(request.error);
                    request.onsuccess = () => {
                        const database = request.result;
                        const transaction = database.transaction('documents', 'readwrite');
                        transaction.objectStore('documents').put({
                            ref: 'legacy-ref',
                            name: 'legacy.pdf',
                        });
                        transaction.onerror = () => rejectSeed(transaction.error);
                        transaction.oncomplete = () => {
                            database.close();
                            resolveSeed();
                        };
                    };
                });
            });
            await page.addScriptTag({path: bundlePath});

            const result = await page.evaluate(async () => {
                const productionModule = Reflect.get(globalThis, 'EvbBrowserDocumentIdb');
                if (typeof productionModule !== 'object' || productionModule === null) {
                    throw new Error('Browser document IDB module was not installed');
                }
                const upgradeBrowserDocumentDatabase = Reflect.get(productionModule, 'upgradeBrowserDocumentDatabase');
                if (typeof upgradeBrowserDocumentDatabase !== 'function') {
                    throw new TypeError('Browser document IDB upgrade function was not installed');
                }
                return new Promise<{
                    legacyName: string | null;
                    stores: string[];
                }>((resolveUpgrade, rejectUpgrade) => {
                    const request = indexedDB.open('evb-viewer-browser-documents', 3);
                    request.onupgradeneeded = () => upgradeBrowserDocumentDatabase(request.result);
                    request.onerror = () => rejectUpgrade(request.error);
                    request.onsuccess = () => {
                        const database = request.result;
                        const stores = Array.from(database.objectStoreNames);
                        const transaction = database.transaction('documents', 'readonly');
                        const getRequest = transaction.objectStore('documents').get('legacy-ref');
                        getRequest.onerror = () => rejectUpgrade(getRequest.error);
                        getRequest.onsuccess = () => {
                            const record = getRequest.result as {name?: string} | undefined;
                            database.close();
                            resolveUpgrade({
                                legacyName: record?.name ?? null,
                                stores,
                            });
                        };
                    };
                });
            });

            expect(result.stores).toEqual([
                'browser-live-leases',
                'browser-transfer-authority',
                'document-chunks',
                'documents',
                'workspace-recovery',
            ]);
            expect(result.legacyName).toBe('legacy.pdf');
        } finally {
            await browser.close();
        }
    }, 30_000);

    it('migrates inline bytes into compact metadata and preserves document reads through maintenance and reopen', async () => {
        const browser = await chromium.launch({headless: true});
        try {
            const page = await browser.newPage();
            await page.goto(origin);
            await page.evaluate(async fixture => {
                await new Promise<void>((resolveSeed, rejectSeed) => {
                    const request = indexedDB.open('evb-viewer-browser-documents', 5);
                    request.onupgradeneeded = () => {
                        for (const [
                            name,
                            keyPath,
                        ] of [
                                [
                                    'documents',
                                    'ref',
                                ],
                                [
                                    'document-chunks',
                                    'key',
                                ],
                                [
                                    'workspace-recovery',
                                    'id',
                                ],
                                [
                                    'browser-live-leases',
                                    'id',
                                ],
                                [
                                    'browser-transfer-authority',
                                    'id',
                                ],
                            ]) request.result.createObjectStore(name!, {keyPath: keyPath!});
                    };
                    request.onerror = () => rejectSeed(request.error);
                    request.onsuccess = () => {
                        const database = request.result;
                        const transaction = database.transaction([
                            'documents',
                            'document-chunks',
                        ], 'readwrite');
                        const documents = transaction.objectStore('documents');
                        for (let index = 0; index < 3; index += 1) {
                            const backing = new Uint8Array(2 * 1024 * 1024 + 8).fill(index + 1);
                            const data = backing.subarray(4, backing.length - 4);
                            documents.put({
                                ref: `browser://documents/bp03-${index}.pdf`,
                                fileName: `bp03-${index}.pdf`,
                                mimeType: 'application/pdf',
                                kind: 'source',
                                retention: 'durable',
                                data: index === 1 ? data.slice().buffer : data,
                                fileSize: data.byteLength,
                                fileLastModified: 100 + index,
                                updatedAt: 100 + index,
                                contentToken: `bp03-token-${index}`,
                                contentRevision: 7 + index,
                                saveName: `saved-${index}.pdf`,
                                saveKind: 'pdf',
                                saveHandle: null,
                                sourceBaseWitness: `bytes:opening-${index}`,
                                sourceWitness: true,
                                // Optional legacy values must still be decoded, not rewritten.
                                legacyExtra: {index},
                                ...(index === 2 ? {saveKind: 'invalid-legacy-kind'} : {}),
                                ...(index === 0 ? {
                                    storageMode: 'inline',
                                    chunkGeneration: 'legacy-active',
                                    pendingChunkGeneration: 'legacy-pending',
                                    pendingChunkCount: 1,
                                    pendingChunkSize: 4,
                                    pendingFileSize: 4,
                                    pendingChunkUpdatedAt: Date.now(),
                                } : {}),
                            });
                        }
                        documents.put({
                            ref: 'browser://documents/bp03-legacy-real.pdf',
                            fileName: 'legacy-real.pdf',
                            mimeType: 'application/pdf',
                            kind: 'source',
                            retention: 'durable',
                            data: Uint8Array.from(fixture),
                            fileSize: fixture.length,
                            updatedAt: 103,
                            contentToken: 'legacy-pdf-token',
                            contentRevision: 4,
                        });
                        const firstRef = 'browser://documents/bp03-0.pdf';
                        documents.put({
                            ref: 'browser://documents/bp03-proxy.pdf',
                            fileName: 'proxy.pdf',
                            mimeType: 'application/pdf',
                            kind: 'output',
                            retention: 'durable',
                            data: new Uint8Array(),
                            fileSize: 0,
                            updatedAt: 102,
                            sourceRef: firstRef,
                            storageMode: 'source-proxy',
                            contentToken: 'proxy-token',
                        });
                        const chunks = transaction.objectStore('document-chunks');
                        chunks.put({
                            key: `${firstRef}::legacy-pending::0`,
                            ref: firstRef,
                            generation: 'legacy-pending',
                            index: 0,
                            data: Uint8Array.of(9, 8, 7, 6),
                        });
                        transaction.onabort = () => rejectSeed(transaction.error);
                        transaction.oncomplete = () => { database.close(); resolveSeed(); };
                    };
                });
            }, pdfFixture);
            await page.addScriptTag({path: bundlePath});
            await page.addScriptTag({path: documentBundlePath});
            await page.addScriptTag({path: maintenanceBundlePath});
            const result = await page.evaluate(async (fixture) => {
                const idb = Reflect.get(globalThis, 'EvbBrowserDocumentIdb') as typeof BrowserDocumentIdb;
                const documents = Reflect.get(globalThis, 'EvbBrowserDocuments') as typeof BrowserDocumentRepository;
                const maintenance = Reflect.get(globalThis, 'EvbBrowserMaintenance') as typeof BrowserDocumentMaintenance;
                const first = await idb.loadRecordAvailability('browser://documents/bp03-0.pdf');
                const originalGet = IDBObjectStore.prototype.get;
                const originalGetAll = IDBObjectStore.prototype.getAll;
                let documentPayloadBytes = 0;
                const observe = (store: IDBObjectStore, request: IDBRequest) => {
                    if (store.name === 'documents') request.addEventListener('success', () => {
                        const values = Array.isArray(request.result) ? request.result : [request.result];
                        for (const value of values) {
                            if (value?.data instanceof Uint8Array || value?.data instanceof ArrayBuffer) {
                                documentPayloadBytes += value.data.byteLength;
                            }
                        }
                    });
                    return request;
                };
                IDBObjectStore.prototype.get = function(key) { return observe(this, originalGet.call(this, key)); };
                IDBObjectStore.prototype.getAll = function(...args: Parameters<IDBObjectStore['getAll']>) {
                    return observe(this, originalGetAll.apply(this, args));
                };
                let records;
                try {
                    records = await maintenance.loadBrowserPersistedDocumentRecordsResult();
                    await maintenance.sweepBrowserDocumentMaintenance(new Map());
                } finally {
                    IDBObjectStore.prototype.get = originalGet;
                    IDBObjectStore.prototype.getAll = originalGetAll;
                }
                const store = new documents.BrowserDocumentStore();
                const equal = (actual: Uint8Array, expected: Uint8Array) => actual.length === expected.length
                    && actual.every((byte, index) => byte === expected[index]);
                const byteEquality = [];
                for (let index = 0; index < 3; index += 1) {
                    const ref = `browser://documents/bp03-${index}.pdf`;
                    const expected = new Uint8Array(2 * 1024 * 1024).fill(index + 1);
                    byteEquality.push(equal(await store.read(ref), expected));
                    byteEquality.push(equal(await store.readRange(ref, expected.length - 17, 40), expected.slice(-17)));
                    const revision = await store.getDocumentRevision(ref);
                    byteEquality.push(revision.token === `drt1:browser:bp03-token-${index}` && revision.contentRevision === 7 + index);
                }
                byteEquality.push(equal(await store.readRange('browser://documents/bp03-proxy.pdf', 13, 19), new Uint8Array(19).fill(1)));
                const rawFirst = (await idb.loadRecordAvailability('browser://documents/bp03-0.pdf')).value;
                const rawThird = (await idb.loadRecordAvailability('browser://documents/bp03-2.pdf')).value;
                const pdf = Uint8Array.from(fixture);
                const migratedPdfEquality = equal(await store.read('browser://documents/bp03-legacy-real.pdf'), pdf)
                    && equal(await store.readRange('browser://documents/bp03-legacy-real.pdf', 137, 1024), pdf.slice(137, 1161));
                const ref = await store.registerFile(new File([pdf], 'bp03-real.pdf', {type: 'application/pdf'}));
                await store.touchRecentFile(ref);
                const working = await store.cloneAsWorkingCopy(ref);
                await store.setRetention(working, 'durable');
                await store.createLiveLease('bp03-controls', [{ref: working}]);
                const staged = await store.createStoredDocument('bp03-staged.pdf', pdf, {
                    mimeType: 'application/pdf',
                    kind: 'output',
                });
                await new Promise<void>((resolveRead, rejectRead) => {
                    const request = indexedDB.open('evb-viewer-browser-documents');
                    request.onerror = () => rejectRead(request.error);
                    request.onsuccess = () => {
                        const database = request.result;
                        const transaction = database.transaction('documents', 'readonly');
                        transaction.objectStore('documents').get(ref);
                        transaction.oncomplete = () => {database.close(); resolveRead();};
                        transaction.onabort = () => rejectRead(transaction.error);
                    };
                });
                await store.commitStagedDocument(staged, working, pdf, (await store.getDocumentRevision(staged)).token,
                    (await store.getDocumentRevision(working)).token);
                const stagedCommitted = !(await store.exists(staged)) && equal(await store.read(working), pdf);
                // A normal range crosses the shared 4-MiB layout boundary.
                const large = new Uint8Array(4 * 1024 * 1024 + 19);
                large.set(pdf);
                large.fill(0x5a, pdf.length);
                const largeRef = await store.registerFile(new File([large], 'bp03-large.pdf', {type: 'application/pdf'}));
                await store.touchRecentFile(largeRef);
                const crossChunkEquality = equal(await store.readRange(largeRef, 4 * 1024 * 1024 - 7, 26), large.slice(-26));
                const pdfHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(await store.read(ref)))))
                    .map(byte => byte.toString(16).padStart(2, '0')).join('');
                const textEquality = await store.readText(ref) === new TextDecoder().decode(pdf);
                const reopened = new documents.BrowserDocumentStore();
                const reopenEquality = equal(await reopened.read(ref), pdf) && equal(await reopened.read(working), pdf)
                    && equal(await reopened.readRange(largeRef, 4 * 1024 * 1024 - 7, 26), large.slice(-26));
                const metadataOnly = (await maintenance.loadBrowserPersistedDocumentRecordsResult()).records.every(record => record.data.length === 0);
                return {
                    first,
                    documentPayloadBytes,
                    records: records.records.length,
                    byteEquality,
                    migratedPdfEquality,
                    rawFirst,
                    rawThird,
                    stagedCommitted,
                    crossChunkEquality,
                    pdfHash,
                    textEquality,
                    reopenEquality,
                    metadataOnly,
                };
            }, pdfFixture);
            console.log('BP03 Chromium migration/control result', JSON.stringify(result));
            expect(result.first.available).toBe(true);
            expect(result.first.value).toEqual(expect.objectContaining({
                data: new Uint8Array(),
                storageMode: 'chunked',
            }));
            expect(result.documentPayloadBytes).toBe(0);
            expect(result.records).toBe(5);
            expect(result.byteEquality.every(Boolean)).toBe(true);
            expect(result.rawFirst).toEqual(expect.objectContaining({
                fileSize: 2 * 1024 * 1024,
                fileLastModified: 100,
                updatedAt: 100,
                contentToken: 'bp03-token-0',
                contentRevision: 7,
                saveName: 'saved-0.pdf',
                sourceBaseWitness: 'bytes:opening-0',
                sourceWitness: true,
                chunkGeneration: 'legacy-active',
                pendingChunkGeneration: 'legacy-pending',
                pendingChunkCount: 1,
                pendingChunkSize: 4,
                pendingFileSize: 4,
                legacyExtra: {index: 0},
            }));
            expect(result.rawThird).toEqual(expect.objectContaining({
                saveKind: 'invalid-legacy-kind',
                legacyExtra: {index: 2},
            }));
            expect(result).toEqual(expect.objectContaining({
                migratedPdfEquality: true,
                stagedCommitted: true,
                crossChunkEquality: true,
                textEquality: true,
                reopenEquality: true,
                metadataOnly: true,
                pdfHash: '210e73efa60299815141db447fe0a7caf99a205d86a7c514b13a7f7c4b94b955',
            }));
        } finally {
            await browser.close();
        }
    });

    it.each([
        'abort',
        'collision',
    ] as const)('rolls back the entire inline migration on %s and succeeds on the next open', async failure => {
        const browser = await chromium.launch({headless: true});
        try {
            const page = await browser.newPage();
            await page.goto(origin);
            await page.addScriptTag({path: bundlePath});
            const result = await page.evaluate(async (failureMode) => {
                const idb = Reflect.get(globalThis, 'EvbBrowserDocumentIdb') as typeof BrowserDocumentIdb;
                const ref = 'browser://documents/bp03-abort.pdf';
                const record = {
                    ref,
                    fileName: 'abort.pdf',
                    mimeType: 'application/pdf',
                    kind: 'source' as const,
                    data: Uint8Array.of(1, 2, 3),
                    fileSize: 3,
                    updatedAt: 1,
                    chunkGeneration: 'legacy-generation',
                };
                const collision = {
                    key: `${ref}::legacy-generation::0`,
                    ref,
                    index: 0,
                    generation: 'legacy-generation',
                    data: Uint8Array.of(9),
                };
                await new Promise<void>((resolveSeed, rejectSeed) => {
                    const request = indexedDB.open('evb-viewer-browser-documents', 5);
                    request.onupgradeneeded = () => {
                        request.result.createObjectStore('documents', {keyPath: 'ref'});
                        request.result.createObjectStore('document-chunks', {keyPath: 'key'});
                    };
                    request.onerror = () => rejectSeed(request.error);
                    request.onsuccess = () => {
                        const database = request.result;
                        const transaction = database.transaction([
                            'documents',
                            'document-chunks',
                        ], 'readwrite');
                        transaction.objectStore('documents').put(record);
                        if (failureMode === 'collision') transaction.objectStore('document-chunks').put(collision);
                        transaction.oncomplete = () => { database.close(); resolveSeed(); };
                        transaction.onabort = () => rejectSeed(transaction.error);
                    };
                });
                const originalAdd = IDBObjectStore.prototype.add;
                if (failureMode === 'abort') IDBObjectStore.prototype.add = function(value, key) {
                    const request = originalAdd.call(this, value, key);
                    if (this.name === 'document-chunks') request.addEventListener('success', () => this.transaction.abort());
                    return request;
                };
                let failedOpen;
                try {
                    failedOpen = await idb.loadRecordAvailability(ref);
                } finally {
                    IDBObjectStore.prototype.add = originalAdd;
                }
                const rollback = await new Promise<{
                    version: number;
                    record: unknown;
                    chunks: unknown[];
                    stores: string[]
                }>((resolveRead, rejectRead) => {
                    const request = indexedDB.open('evb-viewer-browser-documents');
                    request.onerror = () => rejectRead(request.error);
                    request.onsuccess = () => {
                        const database = request.result;
                        const transaction = database.transaction([
                            'documents',
                            'document-chunks',
                        ], 'readwrite');
                        const documentRequest = transaction.objectStore('documents').get(ref);
                        const chunksRequest = transaction.objectStore('document-chunks').getAll();
                        if (failureMode === 'collision') transaction.objectStore('document-chunks').delete(collision.key);
                        transaction.oncomplete = () => {
                            const snapshot = {
                                version: database.version,
                                record: documentRequest.result,
                                chunks: chunksRequest.result,
                                stores: Array.from(database.objectStoreNames),
                            };
                            database.close(); resolveRead(snapshot);
                        };
                        transaction.onabort = () => rejectRead(transaction.error);
                    };
                });
                const retry = await idb.loadRecordAvailability(ref);
                const chunks = await idb.withObjectStoreReadResult<unknown[]>('document-chunks', store => store.getAll());
                const newRef = 'browser://documents/bp03-uncommitted.pdf';
                const abortedWrite = await idb.runObjectStoresTransaction([
                    'documents',
                    'document-chunks',
                ], 'readwrite', transaction => {
                    idb.queueBrowserDocumentRecordWrite(transaction, {
                        ...record,
                        ref: newRef,
                        storageMode: 'inline',
                    });
                    throw new Error('Abort after bytes and metadata were queued.');
                });
                const uncommittedRecord = await idb.loadRecordAvailability(newRef);
                const chunksAfterAbort = await idb.withObjectStoreReadResult<unknown[]>('document-chunks', store => store.getAll());
                return {
                    failedOpen,
                    rollback,
                    retry,
                    chunks,
                    abortedWrite,
                    uncommittedRecord,
                    chunksAfterAbort,
                };
            }, failure);
            console.log(`BP03 Chromium ${failure} result`, JSON.stringify(result));
            expect(result.failedOpen).toEqual({
                available: false,
                value: null,
            });
            expect(result.rollback.version).toBe(5);
            expect(result.rollback.stores).toEqual([
                'document-chunks',
                'documents',
            ]);
            expect(result.rollback.record).toEqual(expect.objectContaining({
                data: Uint8Array.of(1, 2, 3),
                fileSize: 3,
                updatedAt: 1,
            }));
            expect(result.rollback.chunks).toHaveLength(failure === 'collision' ? 1 : 0);
            if (failure === 'collision') expect(result.rollback.chunks[0]).toEqual(expect.objectContaining({data: Uint8Array.of(9)}));
            expect(result.retry.available).toBe(true);
            expect(result.retry.value).toEqual(expect.objectContaining({
                data: new Uint8Array(),
                storageMode: 'chunked',
                chunkGeneration: 'legacy-generation',
            }));
            expect(result.chunks.value).toEqual([expect.objectContaining({data: Uint8Array.of(1, 2, 3)})]);
            expect(result.abortedWrite).toBeNull();
            expect(result.uncommittedRecord).toEqual({
                available: true,
                value: undefined,
            });
            expect(result.chunksAfterAbort).toEqual(result.chunks);
        } finally {
            await browser.close();
        }
    });

    it('preserves refused legacy rows and inconsistent inline bytes during a v1 upgrade', async () => {
        const browser = await chromium.launch({headless: true});
        try {
            const page = await browser.newPage();
            await page.goto(origin);
            await page.evaluate(async () => {
                await new Promise<void>((resolveSeed, rejectSeed) => {
                    const request = indexedDB.open('evb-viewer-browser-documents', 1);
                    request.onupgradeneeded = () => request.result.createObjectStore('documents', {keyPath: 'ref'});
                    request.onerror = () => rejectSeed(request.error);
                    request.onsuccess = () => {
                        const database = request.result;
                        const transaction = database.transaction('documents', 'readwrite');
                        const base = {
                            fileName: 'legacy.pdf',
                            mimeType: 'application/pdf',
                            kind: 'source',
                            updatedAt: 1,
                            fileSize: 3,
                            data: Uint8Array.of(1, 2, 3),
                        };
                        for (const record of [
                            {
                                ...base,
                                ref: 'browser://documents/valid.pdf',
                            },
                            {
                                ...base,
                                ref: 'browser://documents/mismatch.pdf',
                                fileSize: 2,
                            },
                            {
                                ...base,
                                ref: 'browser://documents/invalid.pdf',
                                fileSize: -1,
                            },
                            {
                                ...base,
                                ref: 'browser://documents/invalid-data.pdf',
                                data: [
                                    1,
                                    2,
                                    3,
                                ],
                            },
                            {
                                ref: 'legacy-ref',
                                name: 'old-name.pdf',
                                data: Uint8Array.of(9),
                            },
                        ]) transaction.objectStore('documents').put(record);
                        transaction.oncomplete = () => {database.close(); resolveSeed();};
                        transaction.onabort = () => rejectSeed(transaction.error);
                    };
                });
            });
            await page.addScriptTag({path: documentBundlePath});
            await page.addScriptTag({path: bundlePath});
            const result = await page.evaluate(async () => {
                const documents = Reflect.get(globalThis, 'EvbBrowserDocuments') as typeof BrowserDocumentRepository;
                const idb = Reflect.get(globalThis, 'EvbBrowserDocumentIdb') as typeof BrowserDocumentIdb;
                const invalid = await idb.loadRecordAvailability('browser://documents/invalid.pdf');
                const invalidData = await idb.loadRecordAvailability('browser://documents/invalid-data.pdf');
                const old = await idb.loadRecordAvailability('legacy-ref');
                const mismatch = await idb.loadRecordAvailability('browser://documents/mismatch.pdf');
                const store = new documents.BrowserDocumentStore();
                return {
                    invalid,
                    invalidData,
                    old,
                    mismatch,
                    validBytes: Array.from(await store.read('browser://documents/valid.pdf')),
                    mismatchBytes: Array.from(await store.read('browser://documents/mismatch.pdf')),
                    refused: await store.ensureEntry('browser://documents/invalid.pdf') === null
                        && await store.ensureEntry('browser://documents/invalid-data.pdf') === null,
                };
            });
            expect(result.invalid.value).toEqual(expect.objectContaining({
                fileSize: -1,
                data: Uint8Array.of(1, 2, 3),
            }));
            expect(result.invalidData.value).toEqual(expect.objectContaining({data: [
                1,
                2,
                3,
            ]}));
            expect(result.old.value).toEqual({
                ref: 'legacy-ref',
                name: 'old-name.pdf',
                data: Uint8Array.of(9),
            });
            expect(result.mismatch.value).toEqual(expect.objectContaining({
                fileSize: 2,
                data: Uint8Array.of(1, 2, 3),
            }));
            expect(result.validBytes).toEqual([
                1,
                2,
                3,
            ]);
            expect(result.mismatchBytes).toEqual([
                1,
                2,
                3,
            ]);
            expect(result.refused).toBe(true);
        } finally {
            await browser.close();
        }
    });

    it('isolates simultaneous window journals and enforces per-owner generations', async () => {
        const browser = await chromium.launch({headless: true});
        try {
            const page = await browser.newPage();
            await page.goto(origin);
            await page.evaluate(async () => {
                await new Promise<void>((resolveDelete) => {
                    const request = indexedDB.deleteDatabase('evb-viewer-browser-documents');
                    request.onsuccess = () => resolveDelete();
                    request.onerror = () => resolveDelete();
                });
            });
            await page.addScriptTag({path: recoveryBundlePath});

            const result = await page.evaluate(async () => {
                const store = Reflect.get(globalThis, 'EvbBrowserWorkspaceRecovery') as {
                    claimBrowserWorkspaceRecoveryOwner?: (
                        sourceOwnerId: string,
                        targetOwnerId: string,
                        generation: number,
                        leaseRevision?: number,
                    ) => Promise<unknown>;
                    loadBrowserWorkspaceRecoveries?: () => Promise<unknown>;
                    saveBrowserWorkspaceRecovery?: (
                        ownerId: string,
                        generation: number,
                        checkpoint: unknown,
                        snapshotRefs: string[],
                    ) => Promise<unknown>;
                };
                const buildCheckpoint = (tabId: string, snapshotRef: string, capturedAt: number) => ({
                    version: 1,
                    capturedAt,
                    activePaneId: `pane-${tabId}`,
                    activeTabId: tabId,
                    layout: {
                        type: 'leaf',
                        paneId: `pane-${tabId}`,
                    },
                    panes: [{
                        paneId: `pane-${tabId}`,
                        tabIds: [tabId],
                        activeTabId: tabId,
                    }],
                    tabs: [{
                        tabId,
                        paneId: `pane-${tabId}`,
                        fileName: `${tabId}.pdf`,
                        sourceRef: snapshotRef,
                        workingCopyRef: snapshotRef,
                        requiresSaveAsOnFirstSave: true,
                        isDirty: true,
                        isDjvu: false,
                        currentPage: 1,
                        zoom: 1,
                        zoomMode: 'custom',
                    }],
                });
                const save = store.saveBrowserWorkspaceRecovery!;
                const loadAll = store.loadBrowserWorkspaceRecoveries!;
                const ownerARef = 'browser://documents/window-a-recovery.pdf';
                const ownerBRef = 'browser://documents/window-b-recovery.pdf';
                const originalDateNow = Date.now;
                try {
                    Date.now = () => 0;
                    const first = await Promise.all([
                        save('window:100', 0, buildCheckpoint('tab-a', ownerARef, 1), [ownerARef]),
                        save('window:200', 0, buildCheckpoint('tab-b', ownerBRef, 2), [ownerBRef]),
                    ]);
                    Date.now = () => 30_000;
                    const stale = await save(
                        'window:100',
                        0,
                        buildCheckpoint('tab-a-stale', ownerARef, 3),
                        [ownerARef],
                    );
                    const claimed = await store.claimBrowserWorkspaceRecoveryOwner!(
                        'window:200',
                        'window:300',
                        1,
                    );
                    const recordsAfterFirstClaim = await loadAll();
                    const claimedRemaining = await store.claimBrowserWorkspaceRecoveryOwner!(
                        'window:100',
                        'window:400',
                        1,
                    );
                    const recordsAfterSecondClaim = await loadAll();
                    return {
                        claimed,
                        claimedRemaining,
                        first,
                        stale,
                        recordsAfterFirstClaim,
                        recordsAfterSecondClaim,
                    };
                } finally {
                    Date.now = originalDateNow;
                }
            });

            expect(result.first).toEqual([
                {
                    saved: true,
                    generation: 1,
                },
                {
                    saved: true,
                    generation: 1,
                },
            ]);
            expect(result.stale).toEqual({
                saved: false,
                generation: 1,
            });
            expect(result.claimed).toEqual({
                claimed: true,
                generation: 2,
            });
            expect(result.recordsAfterFirstClaim).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    ownerId: 'window:100',
                    generation: 1,
                }),
                expect.objectContaining({
                    ownerId: 'window:300',
                    generation: 2,
                }),
            ]));
            expect(result.claimedRemaining).toEqual({
                claimed: true,
                generation: 2,
            });
            expect(result.recordsAfterSecondClaim).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    ownerId: 'window:300',
                    generation: 2,
                }),
                expect.objectContaining({
                    ownerId: 'window:400',
                    generation: 2,
                }),
            ]));
        } finally {
            await browser.close();
        }
    }, 30_000);

    it('revalidates lease freshness across shared IndexedDB claim and heartbeat orders', async () => {
        const browser = await chromium.launch({headless: true});
        const context = await browser.newContext();
        const pageA = await context.newPage();
        const pageB = await context.newPage();
        try {
            await Promise.all([
                pageA.goto(origin),
                pageB.goto(origin),
            ]);
            await pageA.evaluate(async () => {
                await new Promise<void>((resolveDelete) => {
                    const request = indexedDB.deleteDatabase('evb-viewer-browser-documents');
                    request.onsuccess = () => resolveDelete();
                    request.onerror = () => resolveDelete();
                });
            });
            await Promise.all([
                pageA.addScriptTag({path: recoveryBundlePath}),
                pageB.addScriptTag({path: recoveryBundlePath}),
            ]);

            const initialCheckpoint = buildRecoveryCheckpoint(1, 'issue-489-dirty.pdf');
            const latestCheckpoint = buildRecoveryCheckpoint(2, 'issue-489-after-heartbeat.pdf');
            const initial = await pageA.evaluate(async ({
                checkpoint,
                databaseName,
                pdfRef,
                pdfText,
            }) => {
                const store = Reflect.get(globalThis, 'EvbBrowserWorkspaceRecovery') as {
                    saveBrowserWorkspaceRecovery: (
                        ownerId: string,
                        generation: number,
                        checkpoint: unknown,
                        snapshotRefs: string[],
                    ) => Promise<unknown>;
                    loadBrowserWorkspaceRecovery: (ownerId: string) => Promise<unknown>;
                };
                const originalDateNow = Date.now;
                Date.now = () => 0;
                try {
                    const saved = await store.saveBrowserWorkspaceRecovery(
                        'window:issue-489-a',
                        0,
                        checkpoint,
                        [pdfRef],
                    );
                    await new Promise<void>((resolvePut, rejectPut) => {
                        const request = indexedDB.open(databaseName);
                        request.onerror = () => rejectPut(request.error);
                        request.onsuccess = () => {
                            const database = request.result;
                            const transaction = database.transaction('documents', 'readwrite');
                            const bytes = new TextEncoder().encode(pdfText);
                            transaction.objectStore('documents').put({
                                ref: pdfRef,
                                fileName: 'issue-489-dirty.pdf',
                                mimeType: 'application/pdf',
                                kind: 'working',
                                retention: 'durable',
                                data: bytes,
                                fileSize: bytes.byteLength,
                                updatedAt: 0,
                                storageMode: 'inline',
                                chunkCount: 0,
                                chunkSize: 4 * 1024 * 1024,
                            });
                            transaction.onerror = () => rejectPut(transaction.error);
                            transaction.onabort = () => rejectPut(transaction.error);
                            transaction.oncomplete = () => {
                                database.close();
                                resolvePut();
                            };
                        };
                    });
                    return {
                        saved,
                        record: await store.loadBrowserWorkspaceRecovery('window:issue-489-a'),
                    };
                } finally {
                    Date.now = originalDateNow;
                }
            }, {
                checkpoint: initialCheckpoint,
                databaseName: RECOVERY_DATABASE_NAME,
                pdfRef: ISSUE_489_PDF_REF,
                pdfText: ISSUE_489_PDF_TEXT,
            });
            expect(initial.saved).toEqual({
                saved: true,
                generation: 1,
            });
            expect(initial.record).toEqual(expect.objectContaining({
                ownerId: 'window:issue-489-a',
                generation: 1,
                leaseRevision: 1,
                updatedAt: 0,
            }));

            // Barrier 1: B selects an expired record while A is paused before its heartbeat.
            const selected = await pageB.evaluate(async () => {
                const store = Reflect.get(globalThis, 'EvbBrowserWorkspaceRecovery') as {loadBrowserWorkspaceRecoveries: () => Promise<Array<{
                    ownerId: string;
                    generation: number;
                    leaseRevision: number;
                    checkpoint: unknown;
                    snapshotRefs: string[];
                    updatedAt: number;
                }>>;};
                const originalDateNow = Date.now;
                Date.now = () => 30_000;
                try {
                    const source = (await store.loadBrowserWorkspaceRecoveries())
                        .find(record => record.ownerId === 'window:issue-489-a');
                    return source ?? null;
                } finally {
                    Date.now = originalDateNow;
                }
            });
            expect(selected).toEqual(expect.objectContaining({
                ownerId: 'window:issue-489-a',
                generation: 1,
                leaseRevision: 1,
                updatedAt: 0,
            }));
            if (!selected) {
                throw new Error('The shared IndexedDB recovery selection was unexpectedly empty.');
            }

            // IndexedDB serializes readwrite transactions. The stale selection
            // has already committed, so admit and finish A's heartbeat before
            // admitting B's claim. This tests the legal heartbeat-before-claim
            // order without pretending the two operations can interleave inside
            // one transaction.
            await observeRecoveryTransactionAdmission(pageA);
            await startHeartbeatAfterTransactionAdmissionObservation(
                pageA,
                'window:issue-489-a',
                selected.generation,
                30_001,
            );
            await waitForRecoveryTransactionAdmission(pageA);
            expect(await readRecoveryTransactionAdmission(pageA)).toEqual({transactionAdmitted: true});
            const heartbeat = await awaitRecoveryOperationResult<IRecoveryMutationResult>(pageA);
            expect(heartbeat).toEqual({
                saved: true,
                generation: 1,
            });
            const heartbeatRecord = await pageA.evaluate(async () => {
                const store = Reflect.get(globalThis, 'EvbBrowserWorkspaceRecovery') as {loadBrowserWorkspaceRecovery: (ownerId: string) => Promise<unknown>};
                return store.loadBrowserWorkspaceRecovery('window:issue-489-a');
            });
            expect(heartbeatRecord).toEqual(expect.objectContaining({
                ownerId: 'window:issue-489-a',
                generation: 1,
                leaseRevision: 2,
                updatedAt: 30_001,
            }));

            // B now admits the production claim transaction using the revision
            // captured by its earlier stale selection.
            await observeRecoveryTransactionAdmission(pageB);
            await startClaimAfterTransactionAdmissionObservation(
                pageB,
                'window:issue-489-a',
                'window:issue-489-b',
                selected.generation,
                selected.leaseRevision,
                30_002,
            );
            await waitForRecoveryTransactionAdmission(pageB);
            expect(await readRecoveryTransactionAdmission(pageB)).toEqual({transactionAdmitted: true});

            const rejected = await awaitRecoveryOperationResult<IRecoveryClaimResult>(pageB);
            expect(rejected).toEqual({
                claimed: false,
                generation: 1,
            });
            const rejectedOwner = await pageB.evaluate(async () => {
                const store = Reflect.get(globalThis, 'EvbBrowserWorkspaceRecovery') as {loadBrowserWorkspaceRecovery: (ownerId: string) => Promise<unknown>};
                return store.loadBrowserWorkspaceRecovery('window:issue-489-a');
            });
            expect(rejectedOwner).toEqual(expect.objectContaining({
                ownerId: 'window:issue-489-a',
                generation: 1,
                leaseRevision: 2,
                updatedAt: 30_001,
                checkpoint: initialCheckpoint,
            }));
            await expect(pageB.evaluate(async () => {
                const store = Reflect.get(globalThis, 'EvbBrowserWorkspaceRecovery') as {loadBrowserWorkspaceRecovery: (ownerId: string) => Promise<unknown>};
                return store.loadBrowserWorkspaceRecovery('window:issue-489-b');
            })).resolves.toBeNull();

            const continued = await pageA.evaluate(async ({
                checkpoint,
                pdfRef,
            }) => {
                const store = Reflect.get(globalThis, 'EvbBrowserWorkspaceRecovery') as {
                    saveBrowserWorkspaceRecovery: (
                        ownerId: string,
                        generation: number,
                        checkpoint: unknown,
                        snapshotRefs: string[],
                    ) => Promise<unknown>;
                    touchBrowserWorkspaceRecovery: (
                        ownerId: string,
                        generation: number,
                    ) => Promise<unknown>;
                    loadBrowserWorkspaceRecovery: (ownerId: string) => Promise<unknown>;
                };
                const originalDateNow = Date.now;
                Date.now = () => 30_003;
                try {
                    const saved = await store.saveBrowserWorkspaceRecovery(
                        'window:issue-489-a',
                        1,
                        checkpoint,
                        [pdfRef],
                    );
                    Date.now = () => 30_004;
                    const heartbeat = await store.touchBrowserWorkspaceRecovery('window:issue-489-a', 2);
                    return {
                        saved,
                        heartbeat,
                        record: await store.loadBrowserWorkspaceRecovery('window:issue-489-a'),
                    };
                } finally {
                    Date.now = originalDateNow;
                }
            }, {
                checkpoint: latestCheckpoint,
                pdfRef: ISSUE_489_PDF_REF,
            });
            expect(continued.saved).toEqual({
                saved: true,
                generation: 2,
            });
            expect(continued.heartbeat).toEqual({
                saved: true,
                generation: 2,
            });
            expect(continued.record).toEqual(expect.objectContaining({
                ownerId: 'window:issue-489-a',
                generation: 2,
                leaseRevision: 4,
                updatedAt: 30_004,
                checkpoint: latestCheckpoint,
            }));

            const reopened = await context.newPage();
            await reopened.goto(origin);
            await reopened.addScriptTag({path: recoveryBundlePath});
            const readback = await reopened.evaluate(async ({
                databaseName,
                pdfRef,
            }) => {
                const store = Reflect.get(globalThis, 'EvbBrowserWorkspaceRecovery') as {loadBrowserWorkspaceRecovery: (ownerId: string) => Promise<unknown>;};
                const pdf = await new Promise<{
                    fileName?: string;
                    data?: number[]
                } | null>((resolvePdf, rejectPdf) => {
                    const request = indexedDB.open(databaseName);
                    request.onerror = () => rejectPdf(request.error);
                    request.onsuccess = () => {
                        const database = request.result;
                        const transaction = database.transaction('documents', 'readonly');
                        const getRequest = transaction.objectStore('documents').get(pdfRef);
                        getRequest.onerror = () => rejectPdf(getRequest.error);
                        getRequest.onsuccess = () => {
                            const record = getRequest.result as {
                                fileName?: string;
                                data?: Uint8Array
                            } | undefined;
                            database.close();
                            resolvePdf(record ? {
                                ...(record.fileName === undefined ? {} : {fileName: record.fileName}),
                                ...(record.data === undefined ? {} : {data: Array.from(record.data)}),
                            } : null);
                        };
                    };
                });
                return {
                    recovery: await store.loadBrowserWorkspaceRecovery('window:issue-489-a'),
                    pdf,
                };
            }, {
                databaseName: RECOVERY_DATABASE_NAME,
                pdfRef: ISSUE_489_PDF_REF,
            });
            await reopened.close();
            expect(readback.recovery).toEqual(expect.objectContaining({
                ownerId: 'window:issue-489-a',
                generation: 2,
                leaseRevision: 4,
                checkpoint: latestCheckpoint,
            }));
            expect(readback.pdf).toEqual({
                fileName: 'issue-489-dirty.pdf',
                data: Array.from(new TextEncoder().encode(ISSUE_489_PDF_TEXT)),
            });

            await pageA.evaluate(async () => {
                await new Promise<void>((resolveDelete) => {
                    const request = indexedDB.deleteDatabase('evb-viewer-browser-documents');
                    request.onsuccess = () => resolveDelete();
                    request.onerror = () => resolveDelete();
                });
            });

            const claimFirst = await pageA.evaluate(async ({
                checkpoint,
                pdfRef,
            }) => {
                const store = Reflect.get(globalThis, 'EvbBrowserWorkspaceRecovery') as {saveBrowserWorkspaceRecovery: (
                    ownerId: string,
                    generation: number,
                    checkpoint: unknown,
                    snapshotRefs: string[],
                ) => Promise<unknown>;};
                const originalDateNow = Date.now;
                Date.now = () => 0;
                try {
                    const saved = await store.saveBrowserWorkspaceRecovery(
                        'window:issue-489-claim-first',
                        0,
                        checkpoint,
                        [pdfRef],
                    );
                    return saved;
                } finally {
                    Date.now = originalDateNow;
                }
            }, {
                checkpoint: initialCheckpoint,
                pdfRef: ISSUE_489_PDF_REF,
            });
            expect(claimFirst).toEqual({
                saved: true,
                generation: 1,
            });

            const selectedForClaimFirst = await pageB.evaluate(async () => {
                const store = Reflect.get(globalThis, 'EvbBrowserWorkspaceRecovery') as {loadBrowserWorkspaceRecovery: (ownerId: string) => Promise<{
                    generation: number;
                    leaseRevision: number;
                } | null>;};
                const originalDateNow = Date.now;
                Date.now = () => 30_000;
                try {
                    return store.loadBrowserWorkspaceRecovery('window:issue-489-claim-first');
                } finally {
                    Date.now = originalDateNow;
                }
            });
            if (!selectedForClaimFirst) {
                throw new Error('The claim-first recovery selection was unexpectedly empty.');
            }

            // The second legal order commits B's claim before A attempts its
            // heartbeat. A's later heartbeat must observe the fence.
            await observeRecoveryTransactionAdmission(pageB);
            await startClaimAfterTransactionAdmissionObservation(
                pageB,
                'window:issue-489-claim-first',
                'window:issue-489-b',
                selectedForClaimFirst.generation,
                selectedForClaimFirst.leaseRevision,
                30_001,
            );
            await waitForRecoveryTransactionAdmission(pageB);
            expect(await readRecoveryTransactionAdmission(pageB)).toEqual({transactionAdmitted: true});
            const claimedFirst = await awaitRecoveryOperationResult<IRecoveryClaimResult>(pageB);
            expect(claimedFirst).toEqual({
                claimed: true,
                generation: 2,
            });

            await observeRecoveryTransactionAdmission(pageA);
            await startHeartbeatAfterTransactionAdmissionObservation(
                pageA,
                'window:issue-489-claim-first',
                selectedForClaimFirst.generation,
                30_002,
            );
            await waitForRecoveryTransactionAdmission(pageA);
            expect(await readRecoveryTransactionAdmission(pageA)).toEqual({transactionAdmitted: true});
            const claimedTarget = await pageB.evaluate(async () => {
                const store = Reflect.get(globalThis, 'EvbBrowserWorkspaceRecovery') as {loadBrowserWorkspaceRecovery: (ownerId: string) => Promise<unknown>};
                return store.loadBrowserWorkspaceRecovery('window:issue-489-b');
            });
            expect(claimedTarget).toEqual(expect.objectContaining({
                ownerId: 'window:issue-489-b',
                generation: 2,
                leaseRevision: 2,
                checkpoint: initialCheckpoint,
            }));

            const fencedHeartbeat = await awaitRecoveryOperationResult<IRecoveryMutationResult>(pageA);
            expect(fencedHeartbeat).toEqual({
                saved: false,
                generation: 0,
            });
            const fencedOldOwner = await pageA.evaluate(async ({
                checkpoint,
                generation,
                leaseRevision,
                pdfRef,
            }) => {
                const store = Reflect.get(globalThis, 'EvbBrowserWorkspaceRecovery') as {
                    saveBrowserWorkspaceRecovery: (
                        ownerId: string,
                        generation: number,
                        checkpoint: unknown,
                        snapshotRefs: string[],
                    ) => Promise<unknown>;
                    claimBrowserWorkspaceRecoveryOwner: (
                        sourceOwnerId: string,
                        targetOwnerId: string,
                        generation: number,
                        leaseRevision: number,
                    ) => Promise<unknown>;
                };
                const originalDateNow = Date.now;
                Date.now = () => 30_002;
                try {
                    return {
                        update: await store.saveBrowserWorkspaceRecovery(
                            'window:issue-489-claim-first',
                            generation,
                            checkpoint,
                            [pdfRef],
                        ),
                        competingClaim: await store.claimBrowserWorkspaceRecoveryOwner(
                            'window:issue-489-claim-first',
                            'window:issue-489-c',
                            generation,
                            leaseRevision,
                        ),
                    };
                } finally {
                    Date.now = originalDateNow;
                }
            }, {
                checkpoint: latestCheckpoint,
                generation: selectedForClaimFirst.generation,
                leaseRevision: selectedForClaimFirst.leaseRevision,
                pdfRef: ISSUE_489_PDF_REF,
            });
            expect({
                heartbeat: fencedHeartbeat,
                ...fencedOldOwner,
            }).toEqual({
                heartbeat: {
                    saved: false,
                    generation: 0,
                },
                update: {
                    saved: false,
                    generation: 0,
                },
                competingClaim: {
                    claimed: false,
                    generation: 0,
                },
            });

            const reopenedAfterClaim = await context.newPage();
            await reopenedAfterClaim.goto(origin);
            await reopenedAfterClaim.addScriptTag({path: recoveryBundlePath});
            const finalRecords = await reopenedAfterClaim.evaluate(async () => {
                const store = Reflect.get(globalThis, 'EvbBrowserWorkspaceRecovery') as {loadBrowserWorkspaceRecoveries: () => Promise<unknown>;};
                return store.loadBrowserWorkspaceRecoveries();
            });
            await reopenedAfterClaim.close();
            expect(finalRecords).toEqual(expect.arrayContaining([expect.objectContaining({
                ownerId: 'window:issue-489-b',
                generation: 2,
                leaseRevision: 2,
                checkpoint: initialCheckpoint,
            })]));
            expect(finalRecords).not.toEqual(expect.arrayContaining([expect.objectContaining({ownerId: 'window:issue-489-claim-first'})]));
        } finally {
            await context.close();
            await browser.close();
        }
    }, 30_000);
});
