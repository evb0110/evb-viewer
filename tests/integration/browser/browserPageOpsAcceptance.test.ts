import {
    mkdir,
    mkdtemp,
    readFile,
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

let server: Server;
let origin = '';
let temporaryDirectory = '';

// The page loads the entry as a module; the page-ops and store workers it starts resolve beside it, as in the app.
const SERVED = {
    '/entry.js': 'entry.js',
    '/browserPageOps.worker.ts': 'page-ops-worker.js',
    '/opfsStore.worker.ts': 'opfs-store-worker.js',
} as const;

beforeAll(async () => {
    await mkdir(join(process.cwd(), '.devkit'), {recursive: true});
    temporaryDirectory = await mkdtemp(join(process.cwd(), '.devkit/browser-page-ops-'));
    const bundle = (entry: string, outfile: string) => build({
        bundle: true,
        entryPoints: [resolve(process.cwd(), entry)],
        format: 'esm',
        outfile: join(temporaryDirectory, outfile),
        platform: 'browser',
        sourcemap: false,
        tsconfig: resolve(process.cwd(), 'tsconfig.json'),
    });
    await Promise.all([
        bundle('tests/integration/browser/browserPageOpsAcceptanceEntry.ts', SERVED['/entry.js']),
        bundle('app/platform/browser-api/browserPageOps.worker.ts', SERVED['/browserPageOps.worker.ts']),
        bundle('app/platform/browser/opfsStore.worker.ts', SERVED['/opfsStore.worker.ts']),
    ]);
    const files: Record<string, {path: string; type: string}> = {
        ...Object.fromEntries(Object.entries(SERVED).map(([url, name]) => [url, {path: join(temporaryDirectory, name), type: 'text/javascript'}])),
        '/wasm/evb-pdf-page-ops.wasm': {path: resolve(process.cwd(), 'public/wasm/evb-pdf-page-ops.wasm'), type: 'application/wasm'},
        '/pdf.worker.mjs': {path: resolve(process.cwd(), 'node_modules/pdfjs-dist/build/pdf.worker.mjs'), type: 'text/javascript'},
    };
    server = createServer((request, response) => {
        const file = files[request.url ?? ''];
        if (!file) {
            response.writeHead(200, {'content-type': 'text/html'});
            response.end('<!doctype html><title>Browser page-ops acceptance</title><script type="module" src="/entry.js"></script>');
            return;
        }
        void readFile(file.path).then((body) => {
            response.writeHead(200, {'content-type': file.type});
            response.end(body);
        });
    });
    await new Promise<void>((resolveListen, rejectListen) => {
        server.once('error', rejectListen);
        server.listen(0, '127.0.0.1', resolveListen);
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('Browser page-ops acceptance harness did not bind a TCP port');
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

async function openHarness(page: Page) {
    await page.goto(origin);
    await page.waitForFunction(() => Boolean(Reflect.get(globalThis, '__evbLargePageOps')));
}

describe('browser page-ops capability acceptance in Chromium', () => {
    it('saves, reopens, and remaps outlines and page labels for delete, reorder, and insert', async () => {
        const browser = await chromium.launch({headless: true});
        try {
            const page = await browser.newPage();
            await openHarness(page);
            const results = await page.evaluate(async () => {
                const run = Reflect.get(globalThis, '__evbRunBrowserPageOpsAcceptance');
                if (typeof run !== 'function') {
                    throw new Error('Browser page-ops acceptance entry point was not installed');
                }
                return run();
            });
            expect(results).toEqual([
                {
                    operation: 'delete',
                    resurrectionRegression: false,
                    pageCount: 2,
                    labels: [
                        '1',
                        'II',
                    ],
                    outlineDestinationPage: 2,
                    outlineDestinationWasDeleted: false,
                },
                {
                    operation: 'reorder',
                    resurrectionRegression: false,
                    pageCount: 3,
                    labels: [
                        'II',
                        '1',
                        'I',
                    ],
                    outlineDestinationPage: 1,
                    outlineDestinationWasDeleted: false,
                },
                {
                    // Unlabelled source pages join the destination numbering range.
                    operation: 'insert',
                    resurrectionRegression: false,
                    pageCount: 4,
                    labels: [
                        '1',
                        '2',
                        'I',
                        'II',
                    ],
                    outlineDestinationPage: 4,
                    outlineDestinationWasDeleted: false,
                },
                {
                    operation: 'delete',
                    resurrectionRegression: true,
                    pageCount: 2,
                    labels: [
                        '1',
                        'II',
                    ],
                    outlineDestinationPage: 0,
                    outlineDestinationWasDeleted: true,
                },
            ]);
            const bookmarks = await page.evaluate(async () => {
                const run = Reflect.get(globalThis, '__evbRunBrowserBookmarkSaveAcceptance');
                if (typeof run !== 'function') throw new Error('Browser bookmark save entry point was not installed');
                return run();
            });
            expect(bookmarks).toEqual([
                3,
                10_000,
            ].map(count => ({
                count,
                reopenedCount: count,
                renamedTitle: 'Large web saved',
                unchangedTitles: true,
            })));
        } finally {
            await browser.close();
        }
    }, 120_000);

    it('reads the outline and the page labels each on its own', async () => {
        const browser = await chromium.launch({headless: true});
        try {
            const page = await browser.newPage();
            await openHarness(page);
            const results = await page.evaluate(async () => {
                const run = Reflect.get(globalThis, '__evbRunBrowserCatalogPartsAcceptance');
                if (typeof run !== 'function') {
                    throw new Error('Browser catalog-parts acceptance entry point was not installed');
                }
                return run();
            });
            expect(results).toEqual([
                {
                    broken: 'page labels',
                    bookmarks: ['Chapter'],
                    pageLabels: 'unreadable',
                },
                {
                    broken: 'outline',
                    bookmarks: 'unreadable',
                    pageLabels: ['r'],
                },
            ]);
        } finally {
            await browser.close();
        }
    }, 120_000);

    // The page tool reads and writes files, so a document past the 512 MiB its 32-bit memory once capped is edited
    // whole. Each operation is read back by PDF.js after a reload: page count, order, bookmark and labels.
    it('edits a document larger than 512 MiB with each page-structure operation', async () => {
        // A profile on disk: an off-the-record context keeps its origin private file system in memory.
        const context = await chromium.launchPersistentContext(await mkdtemp(join(temporaryDirectory, 'profile-')), {headless: true});
        try {
            let page = await context.newPage();
            await openHarness(page);
            type TLarge = Record<string, (...args: unknown[]) => Promise<unknown>>;
            const call = (target: Page, name: string, ...args: unknown[]) => target.evaluate(([scenario, values]) => {
                const scenarios = Reflect.get(globalThis, '__evbLargePageOps') as TLarge;
                return scenarios[scenario as string]!(...values as unknown[]);
            }, [name, args] as const);
            const pageCount = 24;
            const size = await call(page, 'createFixture', 'large.pdf', pageCount, 25 * 1024 * 1024) as number;
            expect(size).toBeGreaterThan(512 * 1024 * 1024);
            const widths = Array.from({length: pageCount}, (_, index) => 100 + index);
            const roman = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII', 'XIV', 'XV', 'XVI', 'XVII', 'XVIII', 'XIX', 'XX', 'XXI', 'XXII'];
            const small = await call(page, 'storeSmallPdf', 'insert.pdf') as string;
            const results: Record<string, unknown> = {};
            for (const operation of ['delete', 'reorder', 'insert', 'merge', 'extract'] as const) {
                const ref = await call(page, 'open', 'large.pdf') as string;
                const run = await call(page, 'run', operation, ref, pageCount, operation === 'extract' ? 'extract-out' : small) as {result: unknown; error?: unknown};
                expect(run.error).toBeUndefined();
                results[operation] = {ref, result: run.result};
            }
            // A reload: the documents are read back from the store by a new page.
            await page.close();
            page = await context.newPage();
            await openHarness(page);
            const inspect = (operation: string) => {
                const {ref, result} = results[operation] as {ref: string; result: {destPath?: string} | string};
                const target = operation === 'merge' ? result as string : operation === 'extract' ? 'extract-out.pdf' : ref;
                return call(page, 'inspect', target);
            };
            expect(await inspect('delete')).toMatchObject({
                pageCount: pageCount - 1,
                widths: widths.filter((_, index) => index !== 1),
                outlinePage: 2,
                labels: ['1', ...roman.slice(0, pageCount - 2)],
            });
            expect(await inspect('reorder')).toMatchObject({
                pageCount,
                widths: widths.toReversed(),
                outlinePage: pageCount - 2,
                labels: [...roman.slice(0, pageCount - 2).toReversed(), '2', '1'],
            });
            expect(await inspect('insert')).toMatchObject({
                pageCount: pageCount + 1,
                widths: [100, 999, ...widths.slice(1)],
                outlinePage: 4,
                // Insertion continues the decimal range through the following base page.
                labels: ['1', '2', '3', ...roman.slice(0, pageCount - 2)],
            });
            expect(await inspect('merge')).toMatchObject({
                pageCount: pageCount + 1,
                widths: [...widths, 999],
                outlinePage: 3,
            });
            expect(await inspect('extract')).toMatchObject({
                pageCount: 3,
                widths: [100, 102, 100 + pageCount - 1],
                labels: ['1', 'I', roman[pageCount - 3]],
            });
        } finally {
            await context.close();
        }
    }, 600_000);
});
