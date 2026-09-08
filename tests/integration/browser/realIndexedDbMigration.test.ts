import {
    mkdtemp,
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
let temporaryDirectory = '';
let origin = '';
let server: Server;

const RECOVERY_DATABASE_NAME = 'evb-viewer-browser-documents';
const ISSUE_489_PDF_TEXT = '%PDF-1.4\n% issue-489 synthetic dirty PDF\n';
const ISSUE_489_PDF_REF = 'browser://documents/issue-489-dirty.pdf';
const CLAIM_ADMISSION_BARRIER_GLOBAL = '__issue489ClaimAdmissionBarrier';

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

async function armRecoveryTransactionAdmissionBarrier(page: Page) {
    await page.evaluate((barrierGlobal) => {
        const factory = indexedDB;
        const originalOpen = factory.open;
        const transactionDescriptor = Object.getOwnPropertyDescriptor(
            IDBDatabase.prototype,
            'transaction',
        );
        if (!transactionDescriptor || typeof transactionDescriptor.value !== 'function') {
            throw new Error('The Chromium IndexedDB transaction method is not patchable.');
        }

        let interceptedOpen = false;
        let successHandler: ((event: Event) => void) | null = null;
        let successEvent: Event | null = null;
        let openRestored = false;
        let transactionRestored = false;
        let requestProxy: IDBOpenDBRequest | null = null;

        const state = {
            ready: false,
            transactionAdmitted: false,
            released: false,
            operation: null as Promise<unknown> | null,
            release: () => {
                state.released = true;
                flushSuccess();
            },
            cleanup: () => {
                if (!openRestored) {
                    Object.defineProperty(factory, 'open', {
                        configurable: true,
                        value: originalOpen,
                        writable: true,
                    });
                    openRestored = true;
                }
                if (!transactionRestored) {
                    Object.defineProperty(IDBDatabase.prototype, 'transaction', transactionDescriptor);
                    transactionRestored = true;
                }
                Reflect.deleteProperty(globalThis, barrierGlobal);
            },
        };

        const flushSuccess = () => {
            if (!state.released || !successHandler || !successEvent || !requestProxy) {
                return;
            }
            const handler = successHandler;
            const event = successEvent;
            successHandler = null;
            successEvent = null;
            if (!openRestored) {
                Object.defineProperty(factory, 'open', {
                    configurable: true,
                    value: originalOpen,
                    writable: true,
                });
                openRestored = true;
            }
            handler.call(requestProxy, event);
        };

        const openForProduction = (...args: [string, number?]) => Reflect.apply(originalOpen, factory, args);
        const onOpenSuccess = (event: Event) => {
            state.ready = true;
            successEvent = event;
            flushSuccess();
        };
        const openWithBarrier = (...args: [string, number?]) => {
            if (interceptedOpen) {
                return openForProduction(...args);
            }
            interceptedOpen = true;
            const request = openForProduction(...args);
            requestProxy = new Proxy(request, {
                get(target, property, _receiver) {
                    if (property === 'onsuccess') {
                        return successHandler;
                    }
                    return Reflect.get(target, property, target);
                },
                set(target, property, value) {
                    if (property === 'onsuccess') {
                        successHandler = typeof value === 'function'
                            ? value as (event: Event) => void
                            : null;
                        Reflect.set(target, property, successHandler ? onOpenSuccess : null, target);
                        flushSuccess();
                        return true;
                    }
                    return Reflect.set(target, property, value, target);
                },
            });
            return requestProxy;
        };

        const originalTransaction = transactionDescriptor.value as IDBDatabase['transaction'];
        const transactionWithAdmissionProbe = function(
            this: IDBDatabase,
            nameOrNames: string | string[],
            mode?: IDBTransactionMode,
            options?: IDBTransactionOptions,
        ) {
            const names = typeof nameOrNames === 'string' ? [nameOrNames] : nameOrNames;
            if ((mode ?? 'readonly') === 'readwrite' && names.includes('workspace-recovery')) {
                state.transactionAdmitted = true;
            }
            return originalTransaction.call(this, nameOrNames, mode, options);
        };

        Object.defineProperty(factory, 'open', {
            configurable: true,
            value: openWithBarrier,
            writable: true,
        });
        Object.defineProperty(IDBDatabase.prototype, 'transaction', {
            ...transactionDescriptor,
            value: transactionWithAdmissionProbe,
        });
        Reflect.set(globalThis, barrierGlobal, state);
    }, CLAIM_ADMISSION_BARRIER_GLOBAL);
}

async function waitForRecoveryTransactionAdmissionBarrier(page: Page) {
    await page.waitForFunction((barrierGlobal) => {
        const barrier = Reflect.get(globalThis, barrierGlobal) as {ready?: boolean} | undefined;
        return barrier?.ready === true;
    }, CLAIM_ADMISSION_BARRIER_GLOBAL);
}

async function readRecoveryTransactionAdmissionBarrier(page: Page) {
    return page.evaluate((barrierGlobal) => {
        const barrier = Reflect.get(globalThis, barrierGlobal) as {
            ready: boolean;
            transactionAdmitted: boolean;
        } | undefined;
        if (!barrier) {
            throw new Error('The recovery transaction admission barrier is not installed.');
        }
        return {
            ready: barrier.ready,
            transactionAdmitted: barrier.transactionAdmitted,
        };
    }, CLAIM_ADMISSION_BARRIER_GLOBAL);
}

async function startClaimAtAdmissionBarrier(
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
            throw new Error('The recovery transaction admission barrier is not installed.');
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
        barrierGlobal: CLAIM_ADMISSION_BARRIER_GLOBAL,
        generation,
        leaseRevision,
        now,
        sourceOwner: sourceOwnerId,
        targetOwner: targetOwnerId,
    });
}

async function startHeartbeatAtAdmissionBarrier(
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
            throw new Error('The recovery transaction admission barrier is not installed.');
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
        barrierGlobal: CLAIM_ADMISSION_BARRIER_GLOBAL,
        heartbeatGeneration: generation,
        heartbeatNow: now,
        heartbeatOwner: ownerId,
    });
}

async function releaseRecoveryTransactionAdmissionBarrier(page: Page) {
    let result: {
        result: unknown;
        transactionAdmitted: boolean;
    };
    try {
        await page.evaluate((barrierGlobal) => {
            const barrier = Reflect.get(globalThis, barrierGlobal) as {release: () => void} | undefined;
            if (!barrier) {
                throw new Error('The recovery transaction admission barrier is not installed.');
            }
            barrier.release();
        }, CLAIM_ADMISSION_BARRIER_GLOBAL);
        result = await page.evaluate(async (barrierGlobal) => {
            const barrier = Reflect.get(globalThis, barrierGlobal) as {operation: Promise<unknown> | null} | undefined;
            if (!barrier?.operation) {
                throw new Error('The recovery operation was not started at the admission barrier.');
            }
            return {
                result: await barrier.operation,
                transactionAdmitted: (Reflect.get(globalThis, barrierGlobal) as {transactionAdmitted: boolean}).transactionAdmitted,
            };
        }, CLAIM_ADMISSION_BARRIER_GLOBAL);
    } finally {
        await page.evaluate((barrierGlobal) => {
            const barrier = Reflect.get(globalThis, barrierGlobal) as {cleanup: () => void} | undefined;
            barrier?.cleanup();
        }, CLAIM_ADMISSION_BARRIER_GLOBAL);
    }
    return result;
}

beforeAll(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'evb-idb-migration-'));
    bundlePath = join(temporaryDirectory, 'browser-document-idb.js');
    recoveryBundlePath = join(temporaryDirectory, 'browser-workspace-recovery.js');
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
                'document-chunks',
                'documents',
                'workspace-recovery',
            ]);
            expect(result.legacyName).toBe('legacy.pdf');
        } finally {
            await browser.close();
        }
    }, 30_000);

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
                        const request = indexedDB.open(databaseName, 3);
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

            // Barrier 2: B has opened the database but cannot admit its claim transaction yet.
            await armRecoveryTransactionAdmissionBarrier(pageB);
            await startClaimAtAdmissionBarrier(
                pageB,
                'window:issue-489-a',
                'window:issue-489-b',
                selected.generation,
                selected.leaseRevision,
                60_002,
            );
            await waitForRecoveryTransactionAdmissionBarrier(pageB);
            expect(await readRecoveryTransactionAdmissionBarrier(pageB)).toEqual({
                ready: true,
                transactionAdmitted: false,
            });

            // Barrier 3: A renews while B is held immediately before claim admission.
            const heartbeat = await pageA.evaluate(async () => {
                const store = Reflect.get(globalThis, 'EvbBrowserWorkspaceRecovery') as {
                    touchBrowserWorkspaceRecovery: (
                        ownerId: string,
                        generation: number,
                    ) => Promise<unknown>;
                    loadBrowserWorkspaceRecovery: (ownerId: string) => Promise<unknown>;
                };
                const originalDateNow = Date.now;
                Date.now = () => 30_001;
                try {
                    return {
                        result: await store.touchBrowserWorkspaceRecovery('window:issue-489-a', 1),
                        record: await store.loadBrowserWorkspaceRecovery('window:issue-489-a'),
                    };
                } finally {
                    Date.now = originalDateNow;
                }
            });
            expect(heartbeat.result).toEqual({
                saved: true,
                generation: 1,
            });
            expect(heartbeat.record).toEqual(expect.objectContaining({
                ownerId: 'window:issue-489-a',
                generation: 1,
                leaseRevision: 2,
                updatedAt: 30_001,
            }));
            expect(await readRecoveryTransactionAdmissionBarrier(pageB)).toEqual({
                ready: true,
                transactionAdmitted: false,
            });

            // Barrier 4: B resumes its stale selection and the claim is fenced by the changed lease revision.
            const rejected = await releaseRecoveryTransactionAdmissionBarrier(pageB);
            expect(rejected.result).toEqual({
                claimed: false,
                generation: 1,
            });
            expect(rejected.transactionAdmitted).toBe(true);
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
                    const request = indexedDB.open(databaseName, 3);
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

            // The second order admits B's claim before A attempts its renewal.
            await armRecoveryTransactionAdmissionBarrier(pageB);
            await startClaimAtAdmissionBarrier(
                pageB,
                'window:issue-489-claim-first',
                'window:issue-489-b',
                selectedForClaimFirst.generation,
                selectedForClaimFirst.leaseRevision,
                30_001,
            );
            await waitForRecoveryTransactionAdmissionBarrier(pageB);
            expect(await readRecoveryTransactionAdmissionBarrier(pageB)).toEqual({
                ready: true,
                transactionAdmitted: false,
            });
            await armRecoveryTransactionAdmissionBarrier(pageA);
            await startHeartbeatAtAdmissionBarrier(
                pageA,
                'window:issue-489-claim-first',
                selectedForClaimFirst.generation,
                30_002,
            );
            await waitForRecoveryTransactionAdmissionBarrier(pageA);
            expect(await readRecoveryTransactionAdmissionBarrier(pageA)).toEqual({
                ready: true,
                transactionAdmitted: false,
            });
            const claimedFirst = await releaseRecoveryTransactionAdmissionBarrier(pageB);
            expect(claimedFirst.result).toEqual({
                claimed: true,
                generation: 2,
            });
            expect(claimedFirst.transactionAdmitted).toBe(true);
            expect(await readRecoveryTransactionAdmissionBarrier(pageA)).toEqual({
                ready: true,
                transactionAdmitted: false,
            });
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

            const fencedHeartbeat = await releaseRecoveryTransactionAdmissionBarrier(pageA);
            expect(fencedHeartbeat.result).toEqual({
                saved: false,
                generation: 0,
            });
            expect(fencedHeartbeat.transactionAdmitted).toBe(true);
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
                heartbeat: fencedHeartbeat.result,
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
