import {
    mkdir,
    mkdtemp,
    rm,
} from 'node:fs/promises';
import {
    createServer,
    type Server,
} from 'node:http';
import {
    join,
    resolve,
} from 'node:path';
import {build} from 'esbuild';
import {chromium} from 'playwright';
import type {Page} from 'playwright';
import {
    afterAll,
    beforeAll,
    describe,
    expect,
    it,
} from 'vitest';

let server: Server;
let origin = '';
let bundlePath = '';
let temporaryDirectory = '';

beforeAll(async () => {
    await mkdir(join(process.cwd(), '.devkit'), {recursive: true});
    temporaryDirectory = await mkdtemp(join(process.cwd(), '.devkit/browser-document-live-lease-'));
    bundlePath = join(temporaryDirectory, 'browser-document-live-lease-acceptance.js');
    await build({
        bundle: true,
        entryPoints: [resolve(process.cwd(), 'tests/integration/browser/browserDocumentLiveLeaseAcceptanceEntry.ts')],
        format: 'iife',
        outfile: bundlePath,
        platform: 'browser',
        sourcemap: false,
        tsconfig: resolve(process.cwd(), 'tsconfig.json'),
    });
    server = createServer((_request, response) => {
        response.writeHead(200, {'content-type': 'text/html'});
        response.end('<!doctype html><title>Browser live lease acceptance</title>');
    });
    await new Promise<void>((resolveListen, rejectListen) => {
        server.once('error', rejectListen);
        server.listen(0, '127.0.0.1', resolveListen);
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('Browser live lease acceptance harness did not bind a TCP port');
    }
    origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
    if (server) {
        await new Promise<void>(resolveClose => server.close(() => resolveClose()));
    }
    await rm(temporaryDirectory, {
        force: true,
        recursive: true,
    });
});

async function installEntry(page: Page) {
    await page.goto(origin);
    await page.addScriptTag({path: bundlePath});
}

async function installEntryAtWindow(page: Page, windowId: number) {
    await page.goto(`${origin}?evbWindowId=${String(windowId)}`);
    await page.addScriptTag({path: bundlePath});
}

async function callEntry<T>(page: Page, name: string, argument?: string): Promise<T> {
    const payload = argument === undefined
        ? {entryName: name}
        : {
            entryName: name,
            value: argument,
        };
    return page.evaluate<unknown, {
        entryName: string;
        value?: string
    }>(async ({
        entryName,
        value,
    }: {
        entryName: string;
        value?: string
    }) => {
        const entry = Reflect.get(globalThis, entryName);
        if (typeof entry !== 'function') {
            throw new Error(`Missing browser live lease entry point: ${entryName}`);
        }
        return entry(value);
    }, payload) as Promise<T>;
}

describe('browser document live lease acceptance in Chromium', () => {
    it('protects live source generations through staged reopen, suspend/resume, and confirmed orphan reclaim', async () => {
        const browser = await chromium.launch({headless: true});
        const context = await browser.newContext();
        const pageA = await context.newPage();
        const pageB = await context.newPage();
        try {
            await Promise.all([
                installEntry(pageA),
                installEntry(pageB),
            ]);
            const setup = await callEntry<{
                refs: {
                    inlineSource: string;
                    chunkedSource: string;
                    generatedWorking: string;
                };
                createdGeneration: number;
                activeGeneration: number;
                activeStatus: string;
                dependencies: Array<{
                    ref: string;
                    chunkGeneration?: string
                }>;
            }>(pageA, '__evbSetupLiveLeaseAcceptance');
            expect(setup.activeStatus).toBe('active');
            expect(setup.activeGeneration).toBe(setup.createdGeneration + 1);
            expect(setup.dependencies).toEqual(expect.arrayContaining([
                {ref: setup.refs.inlineSource},
                {
                    ref: setup.refs.chunkedSource,
                    chunkGeneration: expect.any(String),
                },
                {ref: setup.refs.generatedWorking},
            ]));

            const retainedWhileActive = await callEntry<{
                records: boolean[];
                chunkKeyCounts: number[];
            }>(pageB, '__evbInitializeAndSweepLiveLeaseAcceptance', JSON.stringify(setup.refs));
            expect(retainedWhileActive.records).toEqual([
                true,
                true,
                true,
            ]);
            expect(retainedWhileActive.chunkKeyCounts).toEqual([
                0,
                2,
                1,
            ]);

            const suspended = await callEntry<{
                generation: number;
                status: string
            }>(
                pageA,
                '__evbSuspendLiveLeaseAcceptance',
            );
            expect(suspended.status).toBe('suspended');
            expect(suspended.generation).toBe(setup.activeGeneration + 1);
            const retainedWhileSuspended = await callEntry<{
                records: boolean[];
                chunkKeyCounts: number[];
            }>(pageB, '__evbInitializeAndSweepLiveLeaseAcceptance');
            expect(retainedWhileSuspended.records).toEqual([
                true,
                true,
                true,
            ]);
            expect(retainedWhileSuspended.chunkKeyCounts).toEqual([
                0,
                2,
                1,
            ]);

            const resumed = await callEntry<{
                generation: number;
                status: string
            }>(
                pageA,
                '__evbResumeLiveLeaseAcceptance',
            );
            expect(resumed.status).toBe('active');
            expect(resumed.generation).toBe(suspended.generation + 1);
            const retainedAfterResume = await callEntry<{
                records: boolean[];
                chunkKeyCounts: number[];
            }>(pageB, '__evbInitializeAndSweepLiveLeaseAcceptance');
            expect(retainedAfterResume.records).toEqual([
                true,
                true,
                true,
            ]);
            expect(retainedAfterResume.chunkKeyCounts).toEqual([
                0,
                2,
                1,
            ]);

            const finalized = await callEntry<{generation: number | null}>(
                pageA,
                '__evbFinalizeLiveLeaseAcceptance',
            );
            expect(finalized.generation).toBe(resumed.generation);
            const reopened = await callEntry<{bytes: number[]}>(
                pageB,
                '__evbReopenLiveLeaseAcceptance',
                setup.refs.generatedWorking,
            );
            expect(reopened.bytes).toEqual([
                41,
                42,
                43,
                44,
            ]);

            const reclaimed = await callEntry<{
                releaseStatus: string;
                releaseGeneration: number;
                after: {
                    records: boolean[];
                    chunkKeyCounts: number[]
                };
            }>(pageA, '__evbReclaimLiveLeaseAcceptance');
            expect(reclaimed.releaseStatus).toBe('dead');
            expect(reclaimed.releaseGeneration).toBe(resumed.generation + 1);
            expect(reclaimed.after).toEqual({
                records: [
                    false,
                    false,
                    false,
                ],
                chunkKeyCounts: [
                    0,
                    0,
                    0,
                ],
            });
        } finally {
            await context.close();
            await browser.close();
        }
    }, 120_000);

    it('releases the records of a window that closed without releasing its lease', async () => {
        const browser = await chromium.launch({headless: true});
        const context = await browser.newContext();
        const pageA = await context.newPage();
        const pageB = await context.newPage();
        try {
            await Promise.all([
                installEntry(pageA),
                installEntry(pageB),
            ]);
            const setup = await callEntry<{refs: {
                inlineSource: string;
                chunkedSource: string;
                generatedWorking: string;
            };}>(pageA, '__evbSetupLiveLeaseAcceptance');
            const whileOwnerLives = await callEntry<{records: boolean[]}>(
                pageB,
                '__evbInitializeAndSweepLiveLeaseAcceptance',
                JSON.stringify(setup.refs),
            );
            expect(whileOwnerLives.records).toEqual([
                true,
                true,
                true,
            ]);

            await pageA.close();

            const afterOwnerDied = await callEntry<{
                records: boolean[];
                chunkKeyCounts: number[];
            }>(pageB, '__evbInitializeAndSweepLiveLeaseAcceptance');
            expect(afterOwnerDied.records).toEqual([
                false,
                false,
                false,
            ]);
            // The chunks outlive the records here on purpose: what still holds
            // them is the staged-generation grace window, a separate timer that
            // the confirmed-release case above skips by advancing the clock.
            expect(afterOwnerDied.chunkKeyCounts).toEqual([
                0,
                2,
                1,
            ]);
        } finally {
            await context.close();
            await browser.close();
        }
    });

    it('commits a real two-page transfer durably before accepting the target', async () => {
        const browser = await chromium.launch({headless: true});
        const context = await browser.newContext();
        const source = await context.newPage();
        const target = await context.newPage();
        try {
            await Promise.all([
                installEntryAtWindow(source, 1),
                installEntryAtWindow(target, 2),
            ]);
            await callEntry(target, '__evbPrepareTransferReceiver');
            const result = await callEntry<{
                transferId: string;
                success: boolean;
                targetWindowId: number;
            }>(source, '__evbTransferEmptyTab');
            expect(result).toMatchObject({
                success: true,
                targetWindowId: 2,
            });
        } finally {
            await context.close();
            await browser.close();
        }
    }, 120_000);

    it('keeps a dirty PDF provisional until commit and reopens edited bytes after source loss', async () => {
        const browser = await chromium.launch({headless: true});
        const context = await browser.newContext();
        const source = await context.newPage();
        const target = await context.newPage();
        try {
            await Promise.all([
                installEntryAtWindow(source, 1),
                installEntryAtWindow(target, 2),
            ]);
            await callEntry(target, '__evbPrepareDirtyTransferReceiver');
            const transfer = await callEntry<{
                transferId: string;
                success: boolean;
                targetWindowId: number;
            }>(source, '__evbTransferDirtyTab');
            expect(transfer).toEqual({
                transferId: expect.any(String),
                success: true,
                targetWindowId: 2,
            });
            const observation = await callEntry<{
                phase: string;
                beforeAck: number[];
                afterAck: number[];
            }>(target, '__evbWaitForDirtyTransferCommit');
            expect(observation).toEqual({
                phase: 'committed',
                beforeAck: [
                    90,
                    91,
                    92,
                    93,
                ],
                afterAck: [
                    90,
                    91,
                    92,
                    93,
                ],
            });
            await source.close();
        } finally {
            await context.close();
            await browser.close();
        }
    }, 120_000);
});
