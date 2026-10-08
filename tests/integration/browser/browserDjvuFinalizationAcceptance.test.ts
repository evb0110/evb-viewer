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
import {PDF_COMBINE_MAX_OUTPUT_BYTES} from '@contracts/pdfCombineOutputPolicy';

let server: Server;
let origin = '';
let bundlePath = '';
let temporaryDirectory = '';
let djvuBytes: Buffer;
let djvuScriptBytes: Buffer;
let combineWorkerBytes: Buffer;
let combineWasmBytes: Buffer;

beforeAll(async () => {
    await mkdir(join(process.cwd(), '.devkit'), {recursive: true});
    temporaryDirectory = await mkdtemp(join(process.cwd(), '.devkit/browser-djvu-finalization-'));
    bundlePath = join(temporaryDirectory, 'browser-djvu-finalization-acceptance.js');
    await build({
        bundle: true,
        entryPoints: [resolve(process.cwd(), 'tests/integration/browser/browserDjvuFinalizationAcceptanceEntry.ts')],
        format: 'esm',
        outfile: bundlePath,
        platform: 'browser',
        sourcemap: false,
        tsconfig: resolve(process.cwd(), 'tsconfig.json'),
    });
    const workerPath = join(temporaryDirectory, 'browserPdfCombine.worker.ts');
    await build({
        bundle: true,
        entryPoints: [resolve(process.cwd(), 'app/platform/browser-api/browserPdfCombine.worker.ts')],
        format: 'esm',
        outfile: workerPath,
        platform: 'browser',
        sourcemap: false,
        tsconfig: resolve(process.cwd(), 'tsconfig.json'),
    });
    combineWorkerBytes = await readFile(workerPath);
    combineWasmBytes = await readFile(resolve(process.cwd(), 'public/wasm/evb-pdf-image-combine.wasm'));
    djvuBytes = await readFile(resolve(process.cwd(), 'tests/fixtures/djvu/sources/bitonal-faint-pencil.djvu'));
    djvuScriptBytes = await readFile(resolve(process.cwd(), 'public/vendor/djvujs/djvu.js'));
    server = createServer((_request, response) => {
        if (_request.url === '/browserPdfCombine.worker.ts') {
            response.writeHead(200, {'content-type': 'text/javascript'});
            response.end(combineWorkerBytes);
            return;
        }
        if (_request.url === '/wasm/evb-pdf-image-combine.wasm') {
            response.writeHead(200, {'content-type': 'application/wasm'});
            response.end(combineWasmBytes);
            return;
        }
        if (_request.url === '/vendor/djvujs/djvu.js') {
            response.writeHead(200, {'content-type': 'text/javascript'});
            response.end(djvuScriptBytes);
            return;
        }
        if (_request.url === '/fixtures/bitonal-faint-pencil.djvu') {
            response.writeHead(200, {'content-type': 'application/octet-stream'});
            response.end(djvuBytes);
            return;
        }
        response.writeHead(200, {'content-type': 'text/html'});
        response.end('<!doctype html><title>Browser DjVu finalization acceptance</title>');
    });
    await new Promise<void>((resolveListen, rejectListen) => {
        server.once('error', rejectListen);
        server.listen(0, '127.0.0.1', resolveListen);
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('Browser DjVu finalization acceptance harness did not bind a TCP port');
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

describe('browser DjVu finalization acceptance in Chromium', () => {
    it('converts a tracked DjVu fixture and reopens the generated PDF', async () => {
        const browser = await chromium.launch({headless: true});
        try {
            const page = await browser.newPage();
            await page.goto(origin);
            await page.addScriptTag({
                path: bundlePath,
                type: 'module',
            });
            const result = await page.evaluate(async () => {
                const run = Reflect.get(globalThis, '__evbRunBrowserDjvuFinalizationAcceptance');
                if (typeof run !== 'function') {
                    throw new Error('Browser DjVu finalization acceptance entry point was not installed');
                }
                return run();
            });
            expect(result).toEqual({
                sourceByteLength: 1564,
                openSuccess: true,
                openPageCount: 2,
                openTerminalStatus: 'completed',
                resultSuccess: true,
                terminalStatus: 'completed',
                generatedPdfHeader: '%PDF-',
                reopenedPageCount: 2,
            });
        } finally {
            await browser.close();
        }
    }, 120_000);

    it('exports compact bytes through the worker and cancels its pending WASM load with trusted input', async () => {
        const browser = await chromium.launch({headless: true});
        try {
            for (const cancel of [
                false,
                true,
            ]) {
                const page = await browser.newPage();
                try {
                    await page.goto(origin);
                    await page.addScriptTag({
                        path: bundlePath,
                        type: 'module',
                    });
                    await page.evaluate(async () => {
                        const install = Reflect.get(globalThis, '__evbInstallBrowserCompactDjvuAcceptance');
                        if (typeof install !== 'function') {
                            throw new Error('Compact DjVu acceptance controls were not installed');
                        }
                        await install();
                    });
                    const wasmRequested = Promise.withResolvers<undefined>();
                    const releaseWasm = Promise.withResolvers<undefined>();
                    if (cancel) {
                        // Hold only the worker's module response, giving a real
                        // Cancel click a deterministic pending request to abort.
                        await page.route('**/wasm/evb-pdf-image-combine.wasm', async (route) => {
                            wasmRequested.resolve(undefined);
                            await releaseWasm.promise;
                            await route.continue().catch(() => undefined);
                        });
                    }
                    try {
                        await page.locator('#compact-export').click();
                        if (cancel) {
                            await wasmRequested.promise;
                            await page.locator('#compact-cancel').click();
                        }
                        await page.waitForFunction(() => Reflect.has(globalThis, '__evbBrowserCompactDjvuAcceptanceResult'));
                        const result = await page.evaluate(() => Reflect.get(globalThis, '__evbBrowserCompactDjvuAcceptanceResult'));
                        if (cancel) {
                            expect(result).toMatchObject({
                                success: false,
                                expected: {
                                    kind: 'expected',
                                    code: 'canceled',
                                },
                                terminalStatus: 'canceled',
                                outputBytes: 0,
                            });
                        } else {
                            expect(result).toMatchObject({
                                success: true,
                                terminalStatus: 'completed',
                                generatedPdfHeader: '%PDF-',
                                pageSizes: [
                                    {
                                        width: 122.88,
                                        height: 122.88,
                                    },
                                    {
                                        width: 122.88,
                                        height: 122.88,
                                    },
                                ],
                                referenceMatches: true,
                            });
                            expect(result.outputBytes).toBeGreaterThan(0);
                            expect(result.outputBytes).toBeLessThanOrEqual(PDF_COMBINE_MAX_OUTPUT_BYTES);
                        }
                    } finally {
                        releaseWasm.resolve(undefined);
                    }
                } finally {
                    await page.close();
                }
            }
        } finally {
            await browser.close();
        }
    });
});
