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
import {chromium} from 'playwright';
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
let wasmBytes: Buffer;

beforeAll(async () => {
    await mkdir(join(process.cwd(), '.devkit'), {recursive: true});
    temporaryDirectory = await mkdtemp(join(process.cwd(), '.devkit/browser-page-ops-'));
    bundlePath = join(temporaryDirectory, 'browser-page-ops-acceptance.js');
    await build({
        bundle: true,
        entryPoints: [resolve(process.cwd(), 'tests/integration/browser/browserPageOpsAcceptanceEntry.ts')],
        format: 'iife',
        outfile: bundlePath,
        platform: 'browser',
        sourcemap: false,
        tsconfig: resolve(process.cwd(), 'tsconfig.json'),
    });
    wasmBytes = await readFile(resolve(process.cwd(), 'public/wasm/evb-pdf-page-ops.wasm'));
    server = createServer((_request, response) => {
        if (_request.url === '/wasm/evb-pdf-page-ops.wasm') {
            response.writeHead(200, {'content-type': 'application/wasm'});
            response.end(wasmBytes);
            return;
        }
        response.writeHead(200, {'content-type': 'text/html'});
        response.end('<!doctype html><title>Browser page-ops acceptance</title>');
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

describe('browser page-ops capability acceptance in Chromium', () => {
    it('saves, reopens, and remaps outlines and page labels for delete, reorder, and insert', async () => {
        const browser = await chromium.launch({headless: true});
        try {
            const page = await browser.newPage();
            await page.goto(origin);
            await page.addScriptTag({path: bundlePath});
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
        } finally {
            await browser.close();
        }
    }, 120_000);

    it('reads the outline and the page labels each on its own', async () => {
        const browser = await chromium.launch({headless: true});
        try {
            const page = await browser.newPage();
            await page.goto(origin);
            await page.addScriptTag({path: bundlePath});
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
});
