import {describe, expect, it} from 'vitest';
import {BrowserHeavyWorkerAdmission, resolveBrowserHeavyWorkerLimit} from '@app/platform/browser-api/browserWorkerAdmission';

const FIREFOX_DESKTOP_UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:136.0) Gecko/20100101 Firefox/136.0';
const SAFARI_MAC_UA =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const SAFARI_IOS_UA =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const CHROME_DESKTOP_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36';

describe('browserHeavyWorkerAdmission', () => {
    it('scales aggregate heavy-worker limits across Chromium, Firefox, WebKit, and constrained devices', () => {
        // Explicit low memory, mobile, or low CPU stay at 2 (1 batch + 1 interactive reserve).
        expect(resolveBrowserHeavyWorkerLimit({deviceMemory: 4, hardwareConcurrency: 16, userAgent: CHROME_DESKTOP_UA})).toBe(2);
        expect(resolveBrowserHeavyWorkerLimit({deviceMemory: 2, hardwareConcurrency: 8, userAgent: CHROME_DESKTOP_UA})).toBe(2);
        expect(resolveBrowserHeavyWorkerLimit({hardwareConcurrency: 6, userAgent: SAFARI_IOS_UA})).toBe(2);
        expect(resolveBrowserHeavyWorkerLimit({hardwareConcurrency: 2, userAgent: FIREFOX_DESKTOP_UA})).toBe(2);
        expect(resolveBrowserHeavyWorkerLimit({lowMemory: true, hardwareConcurrency: 16, userAgent: FIREFOX_DESKTOP_UA})).toBe(2);

        // WebKit desktop omits deviceMemory and caps at 6 to protect shared/linear memory (even if deviceMemory is reported).
        expect(resolveBrowserHeavyWorkerLimit({hardwareConcurrency: 16, userAgent: SAFARI_MAC_UA})).toBe(6);
        expect(resolveBrowserHeavyWorkerLimit({deviceMemory: 8, hardwareConcurrency: 12, userAgent: SAFARI_MAC_UA})).toBe(6);
        expect(resolveBrowserHeavyWorkerLimit({hardwareConcurrency: 4, userAgent: SAFARI_MAC_UA})).toBe(3);

        // Firefox desktop (deviceMemory === undefined) and Chromium (deviceMemory >= 8) scale up to 8.
        expect(resolveBrowserHeavyWorkerLimit({hardwareConcurrency: 16, userAgent: FIREFOX_DESKTOP_UA})).toBe(8);
        expect(resolveBrowserHeavyWorkerLimit({deviceMemory: 8, hardwareConcurrency: 16, userAgent: CHROME_DESKTOP_UA})).toBe(8);
        expect(resolveBrowserHeavyWorkerLimit({deviceMemory: 8, hardwareConcurrency: 6, userAgent: CHROME_DESKTOP_UA})).toBe(5);
    });

    it('enforces the aggregate concurrency cap across OCR, scan cleanup, search, and page ops while reserving an interactive slot', async () => {
        const admission = new BrowserHeavyWorkerAdmission(() => 3);
        const gates = [
            Promise.withResolvers<string>(),
            Promise.withResolvers<string>(),
            Promise.withResolvers<string>(),
            Promise.withResolvers<string>(),
        ];
        const started: string[] = [];

        // With limit=3 and interactive reserve=1, batch tasks can hold at most 2 slots.
        const ocr1 = admission.run({category: 'ocr', priority: 'batch'}, () => {
            started.push('ocr-1');
            return gates[0]!.promise;
        });
        const cleanup1 = admission.run({category: 'scan-cleanup', priority: 'batch'}, () => {
            started.push('cleanup-1');
            return gates[1]!.promise;
        });
        const ocrQueued = admission.run({category: 'ocr', priority: 'batch'}, () => {
            started.push('ocr-2');
            return gates[2]!.promise;
        });

        expect(started).toEqual(['ocr-1', 'cleanup-1']);
        expect(admission.snapshot()).toMatchObject({
            active: 2,
            activeByCategory: {ocr: 1, 'scan-cleanup': 1, search: 0, 'page-ops': 0},
            queuedInteractive: 0,
            queuedBatch: 1,
            limit: 3,
        });

        // Interactive search claims the reserved 3rd slot immediately without waiting behind queued OCR.
        const search1 = admission.run({category: 'search', priority: 'interactive'}, () => {
            started.push('search-1');
            return gates[3]!.promise;
        });
        expect(started).toEqual(['ocr-1', 'cleanup-1', 'search-1']);

        // A second interactive page-ops request queues ahead of the waiting batch OCR task.
        const pageOpsGate = Promise.withResolvers<string>();
        const pageOps1 = admission.run({category: 'page-ops', priority: 'interactive'}, () => {
            started.push('page-ops-1');
            return pageOpsGate.promise;
        });
        expect(admission.snapshot()).toMatchObject({
            active: 3,
            queuedInteractive: 1,
            queuedBatch: 1,
        });

        // Releasing search-1 admits queued interactive page-ops-1 BEFORE queued batch ocr-2.
        gates[3]!.resolve('search-done');
        await expect(search1).resolves.toBe('search-done');
        await Promise.resolve();
        expect(started).toEqual(['ocr-1', 'cleanup-1', 'search-1', 'page-ops-1']);

        // Releasing cleanup-1 leaves active=2 (ocr-1 + page-ops-1), which still fills the batch ceiling (2).
        // Releasing ocr-1 drops active to 1, allowing queued batch ocr-2 to start.
        gates[1]!.resolve('cleanup-done');
        await expect(cleanup1).resolves.toBe('cleanup-done');
        expect(started).toEqual(['ocr-1', 'cleanup-1', 'search-1', 'page-ops-1']);

        gates[0]!.resolve('ocr-1-done');
        await expect(ocr1).resolves.toBe('ocr-1-done');
        await Promise.resolve();
        expect(started).toEqual(['ocr-1', 'cleanup-1', 'search-1', 'page-ops-1', 'ocr-2']);

        gates[2]!.resolve('ocr-2-done');
        pageOpsGate.resolve('page-ops-done');
        await expect(ocrQueued).resolves.toBe('ocr-2-done');
        await expect(pageOps1).resolves.toBe('page-ops-done');
        expect(admission.snapshot()).toMatchObject({
            active: 0,
            activeByCategory: {ocr: 0, 'scan-cleanup': 0, search: 0, 'page-ops': 0},
            queuedInteractive: 0,
            queuedBatch: 0,
        });
    });

    it('evicts aborted queued requests immediately and makes release idempotent', async () => {
        const admission = new BrowserHeavyWorkerAdmission(() => 2);
        const holdRelease = await admission.acquire({category: 'ocr', priority: 'batch'});
        const interactiveRelease = await admission.acquire({category: 'page-ops', priority: 'interactive'});

        const controller = new AbortController();
        let ran = false;
        const canceled = admission.run(
            {
                category: 'search',
                priority: 'interactive',
                signal: controller.signal,
                createAbortError: () => new Error('ERR_BROWSER_SEARCH_CANCELED'),
            },
            async () => {
                ran = true;
                return 'never';
            },
        );

        expect(admission.snapshot().queuedInteractive).toBe(1);
        controller.abort();
        await expect(canceled).rejects.toThrow('ERR_BROWSER_SEARCH_CANCELED');
        expect(ran).toBe(false);
        expect(admission.snapshot().queuedInteractive).toBe(0);

        // Idempotent double release must not corrupt active counters.
        holdRelease();
        holdRelease();
        interactiveRelease();
        interactiveRelease();
        expect(admission.snapshot()).toMatchObject({
            active: 0,
            activeByCategory: {ocr: 0, 'scan-cleanup': 0, search: 0, 'page-ops': 0},
        });
    });

    it('never dispatches a queued request that aborts in the microtask window after slot grant', async () => {
        const admission = new BrowserHeavyWorkerAdmission(() => 1);
        const holdRelease = await admission.acquire({category: 'page-ops', priority: 'interactive'});

        const controller = new AbortController();
        let started = false;
        const queued = admission.run(
            {
                category: 'search',
                priority: 'interactive',
                signal: controller.signal,
                createAbortError: () => new Error('ERR_BROWSER_SEARCH_CANCELED'),
            },
            async () => {
                started = true;
                return 'unexpected';
            },
        );

        // Release grants the slot synchronously, then abort fires in the same turn
        // before the `.then()` dispatch microtask runs.
        holdRelease();
        controller.abort();

        await expect(queued).rejects.toThrow('ERR_BROWSER_SEARCH_CANCELED');
        expect(started).toBe(false);
        expect(admission.snapshot()).toMatchObject({
            active: 0,
            queuedInteractive: 0,
            queuedBatch: 0,
        });
    });

    it('enforces per-category limits without hoarding aggregate slots from unrelated categories', async () => {
        const admission = new BrowserHeavyWorkerAdmission(() => 4);
        const gates = [Promise.withResolvers<string>(), Promise.withResolvers<string>(), Promise.withResolvers<string>()];
        const started: string[] = [];

        const p1 = admission.run({category: 'page-ops', priority: 'interactive', categoryLimit: 2}, () => {
            started.push('page-ops-1');
            return gates[0]!.promise;
        });
        const p2 = admission.run({category: 'page-ops', priority: 'interactive', categoryLimit: 2}, () => {
            started.push('page-ops-2');
            return gates[1]!.promise;
        });
        const p3 = admission.run({category: 'page-ops', priority: 'interactive', categoryLimit: 2}, () => {
            started.push('page-ops-3');
            return gates[2]!.promise;
        });

        expect(started).toEqual(['page-ops-1', 'page-ops-2']);
        expect(admission.snapshot()).toMatchObject({
            active: 2,
            activeByCategory: {'page-ops': 2},
            queuedInteractive: 1,
        });

        // A queued page-ops waiter blocked only by its own categoryLimit must not block
        // an interactive search OR an unrelated batch OCR job when aggregate slots are free.
        const searchGate = Promise.withResolvers<string>();
        const search = admission.run({category: 'search', priority: 'interactive', categoryLimit: 1}, () => {
            started.push('search-1');
            return searchGate.promise;
        });
        const ocrGate = Promise.withResolvers<string>();
        const ocr = admission.run({category: 'ocr', priority: 'batch'}, () => {
            started.push('ocr-1');
            return ocrGate.promise;
        });
        expect(started).toEqual(['page-ops-1', 'page-ops-2', 'search-1']);

        // With limit=4 (batch ceiling=3), once search-1 finishes (active=2), ocr-1 can claim a batch slot
        // while page-ops-3 stays queued on page-ops categoryLimit=2.
        searchGate.resolve('search-done');
        await expect(search).resolves.toBe('search-done');
        await Promise.resolve();
        expect(started).toEqual(['page-ops-1', 'page-ops-2', 'search-1', 'ocr-1']);

        // Finishing page-ops-1 admits page-ops-3 immediately.
        gates[0]!.resolve('p1');
        await expect(p1).resolves.toBe('p1');
        await Promise.resolve();
        expect(started).toEqual(['page-ops-1', 'page-ops-2', 'search-1', 'ocr-1', 'page-ops-3']);

        gates[1]!.resolve('p2');
        gates[2]!.resolve('p3');
        ocrGate.resolve('ocr-done');
        await Promise.all([p2, p3, ocr]);
        expect(admission.snapshot().active).toBe(0);
    });

    it('rejects a queued runDeferred waiter if a pagehide reset fires in the same turn as a synchronous release', async () => {
        const fakeWindow = new EventTarget();
        const previousWindow = globalThis.window;
        Object.defineProperty(globalThis, 'window', {configurable: true, writable: true, value: fakeWindow});
        try {
            const admission = new BrowserHeavyWorkerAdmission(() => 1);
            let firstRelease: (() => void) | null = null;
            // Register an earlier pagehide listener that releases the active slot BEFORE
            // admission's own listener runs (simulating an owner pool terminating its worker first).
            fakeWindow.addEventListener('pagehide', () => {
                firstRelease?.();
            });

            const firstGate = Promise.withResolvers<string>();
            const first = admission.runDeferred({category: 'scan-cleanup', priority: 'interactive'}, (release) => {
                firstRelease = release;
                return firstGate.promise;
            });

            let queuedStarted = false;
            const queued = admission.runDeferred({category: 'scan-cleanup', priority: 'interactive'}, (release) => {
                queuedStarted = true;
                release();
                return Promise.resolve('should-not-start');
            });

            const event = new Event('pagehide');
            Object.defineProperty(event, 'persisted', {value: false});
            fakeWindow.dispatchEvent(event);

            await expect(queued).rejects.toMatchObject({code: 'BROWSER_WORKER_RESET'});
            expect(queuedStarted).toBe(false);
            expect(admission.snapshot()).toMatchObject({
                active: 0,
                queuedInteractive: 0,
                queuedBatch: 0,
            });
            firstGate.resolve('done');
            await first;
        } finally {
            Object.defineProperty(globalThis, 'window', {configurable: true, writable: true, value: previousWindow});
        }
    });
});
