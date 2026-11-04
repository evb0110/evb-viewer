import {
    mkdir,
    mkdtemp,
    readFile,
    writeFile,
    rm,
} from 'node:fs/promises';
import {
    createServer,
    type Server,
    type ServerResponse,
} from 'node:http';
import {
    join,
    resolve,
} from 'node:path';
import {build} from 'esbuild';
import {decode as decodePng} from 'fast-png';
import {
    chromium, type Download,
} from 'playwright';
import UTIF, {type IUtifFrame} from 'utif';
import {
    afterAll,
    beforeAll,
    describe,
    expect,
    it,
} from 'vitest';
import {PDF_COMBINE_MAX_OUTPUT_BYTES} from '@contracts/pdfCombineOutputPolicy';

interface IBrowserImageExportAcceptance {
    head: number[];
    decodable: boolean;
    storedName: string;
    savedName: string;
    bytesBase64: string;
}

const PNG_SIGNATURE = [
    137,
    80,
    78,
    71,
];
const JPEG_SIGNATURE = [
    255,
    216,
    255,
];
const TIFF_SIGNATURE = [
    77,
    77,
    0,
    42,
];
const PAGE_DPI = {
    x: 300,
    y: 300,
};
const METERS_PER_INCH = 0.0254;
const PDFJS_ASSET_DIR = resolve(process.cwd(), 'public/pdf');

let server: Server;
let origin = '';
let bundlePath = '';
let boundedBundlePath = '';
let temporaryDirectory = '';
let djvuBytes: Buffer;
let mixedDpiDjvuBytes: Buffer;
let boundaryDjvuBytes: Buffer;
let djvuScriptBytes: Buffer;
let combineWorkerBytes: Buffer;
let combineWasmBytes: Buffer;

// Each reader decodes the saved bytes with a library or the format's own layout, not the writer's code.
function readPngDpi(bytes: Uint8Array) {
    const {resolution} = decodePng(bytes);
    // A pHYs chunk with unit 1 gives pixels per metre.
    if (resolution?.unit !== 1) {
        return null;
    }
    return {
        x: Math.round(resolution.x * METERS_PER_INCH),
        y: Math.round(resolution.y * METERS_PER_INCH),
    };
}

function readJpegDpi(bytes: Uint8Array) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const isJfif = view.getUint16(2) === 0xffe0 && String.fromCharCode(...bytes.subarray(6, 11)) === 'JFIF\0';
    // The JFIF APP0 segment holds the units at byte 13 and the densities at bytes 14 and 16.
    if (!isJfif || view.getUint8(13) !== 1) {
        return null;
    }
    return {
        x: view.getUint16(14),
        y: view.getUint16(16),
    };
}

function firstNumber(value: unknown) {
    if (!Array.isArray(value)) {
        return null;
    }
    const first: unknown = value[0];
    return typeof first === 'number' ? first : null;
}

function readTiffFrameDpi(frame: IUtifFrame) {
    // ResolutionUnit 2 means inches; UTIF stores each rational as a number.
    if (firstNumber(frame.t296) !== 2) {
        return null;
    }
    return {
        x: firstNumber(frame.t282),
        y: firstNumber(frame.t283),
    };
}

function bytesOf(result: IBrowserImageExportAcceptance) {
    return Buffer.from(result.bytesBase64, 'base64');
}

// pdf.js loads its worker and version stamp from the vendored directory; nothing outside it is served.
async function respondWithPdfjsAsset(requestUrl: string, response: ServerResponse) {
    const assetPath = resolve(PDFJS_ASSET_DIR, requestUrl.slice('/pdf/'.length));
    const bytes = assetPath.startsWith(`${PDFJS_ASSET_DIR}/`)
        ? await readFile(assetPath).catch(() => null)
        : null;
    if (bytes === null) {
        response.writeHead(404);
        response.end();
        return;
    }
    // A module worker is refused unless its script is served as JavaScript.
    response.writeHead(200, {'content-type': assetPath.endsWith('.mjs') ? 'text/javascript' : 'application/octet-stream'});
    response.end(bytes);
}

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
    // A small real-file fixture uses the production grouping algorithm at a
    // two-page boundary. The separate metadata test covers the 32-bit limit.
    const realTiffModule = resolve(process.cwd(), 'packages/pdf-core/tiffEncoding.ts');
    const boundedTiffModule = join(temporaryDirectory, 'bounded-tiff.ts');
    await writeFile(boundedTiffModule, `
        import * as real from ${JSON.stringify(realTiffModule)};
        export * from ${JSON.stringify(realTiffModule)};
        export function splitTiffPageDescriptorsForClassicLimit(pages, encoder) {
            return Reflect.get(real, 'splitTiffPageDescriptorsForClassicLimit')(pages, encoder,
                Reflect.get(real, 'estimateMultiPageTiffByteLength')(pages.slice(0, 2), encoder));
        }
    `);
    boundedBundlePath = join(temporaryDirectory, 'bounded-browser-export.js');
    await build({
        bundle: true,
        entryPoints: [resolve(process.cwd(), 'tests/integration/browser/browserDjvuFinalizationAcceptanceEntry.ts')],
        format: 'esm',
        outfile: boundedBundlePath,
        platform: 'browser',
        sourcemap: false,
        tsconfig: resolve(process.cwd(), 'tsconfig.json'),
        alias: {'@pdf-core/tiffEncoding': boundedTiffModule},
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
    const saveWorkers = new Map<string, Buffer>();
    for (const name of [
        'browserQpdfEngine.worker',
        'browserPageOps.worker',
    ]) {
        const path = join(temporaryDirectory, `${name}.js`);
        await build({
            bundle: true,
            entryPoints: [resolve(process.cwd(), `app/platform/browser-api/${name}.ts`)],
            format: 'esm',
            outfile: path,
            platform: 'browser',
            tsconfig: resolve(process.cwd(), 'tsconfig.json'),
        });
        saveWorkers.set(`/${name}.ts`, await readFile(path));
    }
    combineWasmBytes = await readFile(resolve(process.cwd(), 'public/wasm/evb-pdf-image-combine.wasm'));
    djvuBytes = await readFile(resolve(process.cwd(), 'tests/fixtures/djvu/sources/bitonal-faint-pencil.djvu'));
    mixedDpiDjvuBytes = await readFile(resolve(process.cwd(), 'tests/fixtures/djvu/sources/mixed-dpi.djvu'));
    boundaryDjvuBytes = await readFile(resolve(process.cwd(), 'tests/fixtures/djvu/sources/browser-boundary-501-pages.djvu'));
    djvuScriptBytes = await readFile(resolve(process.cwd(), 'public/vendor/djvujs/djvu.js'));
    server = createServer((_request, response) => {
        const pathname = new URL(_request.url ?? '/', 'http://localhost').pathname;
        const worker = saveWorkers.get(pathname);
        if (worker) {
            response.writeHead(200, {'content-type': 'text/javascript'});
            response.end(worker);
            return;
        }
        if (/^\/wasm\/(?:evb-qpdf\.(?:mjs|wasm)|evb-pdf-page-ops\.wasm)$/u.test(pathname)) {
            void readFile(resolve(process.cwd(), 'public', pathname.slice(1))).then(bytes => {
                response.writeHead(200, {'content-type': pathname.endsWith('.mjs') ? 'text/javascript' : 'application/wasm'});
                response.end(bytes);
            }, () => {response.writeHead(404); response.end();});
            return;
        }
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
        if (_request.url === '/fixtures/mixed-dpi.djvu') {
            response.writeHead(200, {'content-type': 'application/octet-stream'});
            response.end(mixedDpiDjvuBytes);
            return;
        }
        if (_request.url === '/fixtures/browser-boundary-501-pages.djvu') {
            response.writeHead(200, {'content-type': 'application/octet-stream'});
            response.end(boundaryDjvuBytes);
            return;
        }
        if (_request.url?.startsWith('/pdf/')) {
            void respondWithPdfjsAsset(_request.url, response);
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
            // An injected module script runs after it is attached, not before
            // addScriptTag resolves: wait for its entry point to exist.
            await page.waitForFunction(() => typeof Reflect.get(globalThis, '__evbRunBrowserDjvuFinalizationAcceptance') === 'function');
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
                    await page.waitForFunction(() => typeof Reflect.get(globalThis, '__evbInstallBrowserCompactDjvuAcceptance') === 'function');
                    await page.evaluate(async shouldCancel => {
                        const install = Reflect.get(globalThis, '__evbInstallBrowserCompactDjvuAcceptance');
                        if (typeof install !== 'function') {
                            throw new Error('Compact DjVu acceptance controls were not installed');
                        }
                        await install(1, !shouldCancel);
                    }, cancel);
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

    it('writes each DjVu image format that its chosen file name advertises', async () => {
        const browser = await chromium.launch({headless: true});
        try {
            const page = await browser.newPage();
            await page.goto(origin);
            await page.addScriptTag({
                path: bundlePath,
                type: 'module',
            });
            await page.waitForFunction(() => typeof Reflect.get(globalThis, '__evbRunBrowserDjvuImageExportAcceptance') === 'function');
            const runExport = (chosenName: string) => page.evaluate<IBrowserImageExportAcceptance, string>(
                name => Reflect.get(globalThis, '__evbRunBrowserDjvuImageExportAcceptance')(name),
                chosenName,
            );
            const pngResult = await runExport('page-001.png');
            const jpegResult = await runExport('page-001.jpg');
            const tiffResult = await runExport('page-001.tif');
            for (const name of [
                'chosen.TIF',
                'chosen.TIFF',
            ]) {
                const result = await runExport(name);
                expect(result.storedName).toBe(name);
                expect(UTIF.decode(bytesOf(result))).toHaveLength(1);
            }

            expect(pngResult).toMatchObject({
                head: PNG_SIGNATURE,
                decodable: true,
                storedName: 'page-001.png',
            });
            expect(jpegResult.head.slice(0, JPEG_SIGNATURE.length)).toEqual(JPEG_SIGNATURE);
            expect(jpegResult).toMatchObject({
                decodable: true,
                storedName: 'page-001.jpg',
            });
            // Chromium cannot decode TIFF; the big-endian header is the saved format.
            expect(tiffResult).toMatchObject({
                head: TIFF_SIGNATURE,
                storedName: 'page-001.tif',
            });
            expect(readPngDpi(bytesOf(pngResult))).toEqual(PAGE_DPI);
            expect(readJpegDpi(bytesOf(jpegResult))).toEqual(PAGE_DPI);
            expect(UTIF.decode(bytesOf(tiffResult)).map(readTiffFrameDpi)).toEqual([PAGE_DPI]);
        } finally {
            await browser.close();
        }
    });

    it('writes each PDF page image format that its chosen file name advertises', async () => {
        const browser = await chromium.launch({headless: true});
        try {
            const page = await browser.newPage();
            await page.goto(origin);
            await page.addScriptTag({
                path: bundlePath,
                type: 'module',
            });
            await page.waitForFunction(() => typeof Reflect.get(globalThis, '__evbRunBrowserPdfImageExportAcceptance') === 'function');
            const runExport = (chosenName: string) => page.evaluate<IBrowserImageExportAcceptance, string>(
                name => Reflect.get(globalThis, '__evbRunBrowserPdfImageExportAcceptance')(name),
                chosenName,
            );

            const pngResult = await runExport('page-001.png');
            const tiffResult = await runExport('page-001.tif');
            for (const name of [
                'chosen.TIF',
                'chosen.TIFF',
            ]) {
                const result = await runExport(name);
                expect(result.storedName).toBe(name);
                expect(UTIF.decode(bytesOf(result))).toHaveLength(1);
            }
            const jpegResult = await runExport('page-001.jpg');
            expect(pngResult).toMatchObject({
                head: PNG_SIGNATURE,
                decodable: true,
                storedName: 'page-001.png',
            });
            expect(tiffResult).toMatchObject({
                head: TIFF_SIGNATURE,
                storedName: 'page-001.tif',
            });
            expect(jpegResult.head.slice(0, JPEG_SIGNATURE.length)).toEqual(JPEG_SIGNATURE);
            expect(jpegResult).toMatchObject({
                decodable: true,
                storedName: 'page-001.jpg',
            });
        } finally {
            await browser.close();
        }
    });

    it('refuses a PDF Save As to an incompatible physical handle with the localized message', async () => {
        const browser = await chromium.launch({headless: true});
        try {
            const page = await browser.newPage();
            page.on('pageerror', error => console.log('[browser export acceptance]', error.message));
            await page.goto(origin);
            await page.addScriptTag({
                path: bundlePath,
                type: 'module',
            });
            await page.waitForFunction(() => typeof Reflect.get(globalThis, '__evbInstallTypedPdfSaveAcceptance') === 'function');
            await page.evaluate(() => Reflect.get(globalThis, '__evbInstallTypedPdfSaveAcceptance')());
            await page.locator('#typed-pdf-save').click();
            await page.waitForFunction(() => Reflect.has(globalThis, '__evbTypedSaveResult'));
            expect(await page.locator('#typed-save-message').innerText()).toBe('Le fichier n’a pas été enregistré. Choisissez un nom de fichier se terminant par .pdf.');
            const result = await page.evaluate(() => Reflect.get(globalThis, '__evbTypedSaveResult'));
            expect(result.saved).toBeNull();
            expect(result.bytes).toBe('sentinel bytes');
            expect(result.source).toBe(result.originalSource);
        } finally {
            await browser.close();
        }
    });

    it.each([
        1,
        2,
        3,
    ])('keeps every image from two overlapping folder exports: run %s', async () => {
        const browser = await chromium.launch({headless: true});
        try {
            const page = await browser.newPage();
            await page.goto(origin);
            await page.addScriptTag({
                path: bundlePath,
                type: 'module',
            });
            await page.waitForFunction(() => typeof Reflect.get(globalThis, '__evbInstallConcurrentFolderAcceptance') === 'function');
            await page.evaluate(() => Reflect.get(globalThis, '__evbInstallConcurrentFolderAcceptance')());
            await page.locator('#concurrent-folder-export').click();
            await page.waitForFunction(() => Boolean(document.querySelector('#concurrent-folder-result')?.textContent));
            const outcome = JSON.parse(await page.locator('#concurrent-folder-result').innerText()) as {
                results: Array<{success: boolean}>;
                savedPages: number;
                files: Array<{
                    name: string;
                    bytesBase64: string;
                    decodable: boolean
                }>;
            };
            expect(outcome.results.map(result => result.success)).toEqual([
                true,
                true,
            ]);
            expect(outcome.savedPages).toBe(2);
            expect(outcome.files.map(file => file.name)).toEqual([
                'document-pages-001-1.jpg',
                'document-pages-001.jpg',
                'document-pages-002-1.jpg',
                'document-pages-002.jpg',
            ]);
            for (const file of outcome.files) {
                expect(file.decodable).toBe(true);
                expect(Buffer.from(file.bytesBase64, 'base64').byteLength).toBeGreaterThan(100);
            }
        } finally {
            await browser.close();
        }
    });

    it.each([
        'encode',
        'open',
        'write',
        'replaced',
        'nonempty',
        'changed-empty',
        'abort-unknown',
        'close-unknown',
    ])('keeps completed folder images and only cleans a provably empty failed page: %s', async mode => {
        const browser = await chromium.launch({headless: true});
        try {
            const page = await browser.newPage();
            page.on('pageerror', error => console.log('[browser export acceptance]', error.message));
            await page.goto(origin);
            await page.addScriptTag({
                path: bundlePath,
                type: 'module',
            });
            await page.waitForFunction(() => typeof Reflect.get(globalThis, '__evbInstallFolderFailureAcceptance') === 'function');
            await page.evaluate(value => Reflect.get(globalThis, '__evbInstallFolderFailureAcceptance')(value), mode);
            await page.locator('#folder-failure-export').click();
            if (mode === 'encode') {
                const failedFiles = await page.evaluate(() => Reflect.get(globalThis, '__evbReadFailedFolderImages')());
                expect(failedFiles.map((file: {name: string}) => file.name)).toEqual(['document-pages-001.jpg']);
            }
            await expect.poll(() => page.locator('#folder-failure-result').textContent()).not.toBe('');
            const outcome = JSON.parse(await page.locator('#folder-failure-result').innerText()) as {
                error: string;
                failed: Array<{
                    name: string;
                    bytesBase64: string;
                    decodable: boolean
                }>;
                retried: Array<{
                    name: string;
                    bytesBase64: string;
                    decodable: boolean
                }>;
                retainedOutputs: boolean[];
            };
            expect(outcome.error).not.toBe('');
            const removesEmpty = [
                'encode',
                'open',
                'write',
            ].includes(mode);
            expect(outcome.failed.map(file => file.name)).toEqual(removesEmpty ? ['document-pages-001.jpg'] : [
                'document-pages-001.jpg',
                'document-pages-002.jpg',
            ]);
            expect(outcome.failed[0]?.decodable).toBe(true);
            expect(outcome.retainedOutputs.filter(Boolean)).toEqual([]);
            if (mode === 'replaced' || mode === 'nonempty') {
                expect(Buffer.from(outcome.failed[1]!.bytesBase64, 'base64').toString()).toBe('external revision');
            }
            if (mode === 'close-unknown') expect(outcome.failed[1]?.decodable).toBe(true);
            if (mode === 'encode') {
                expect(outcome.retried.map(file => file.name)).toEqual([
                    'document-pages-001-1.jpg',
                    'document-pages-001.jpg',
                    'document-pages-002.jpg',
                ]);
                expect(outcome.retried.every(file => file.decodable)).toBe(true);
                expect(outcome.retried.find(file => file.name === 'document-pages-001.jpg')?.bytesBase64).toBe(outcome.failed[0]!.bytesBase64);
            }
        } finally {
            await browser.close();
        }
    });

    it.each([
        [
            'pdf',
            'directory',
            false,
            false,
        ],
        [
            'pdf',
            'directory',
            true,
            false,
        ],
        [
            'pdf',
            'directory',
            false,
            true,
        ],
        [
            'pdf',
            'download',
            false,
            false,
        ],
        [
            'pdf',
            'cancel',
            false,
            false,
        ],
        [
            'djvu',
            'directory',
            false,
            false,
        ],
        [
            'djvu',
            'download',
            false,
            false,
        ],
    ] as const)('streams every bounded TIFF part with trusted input: %s %s collision=%s failure=%s', async (kind, destination, collision, failPage) => {
        const browser = await chromium.launch({headless: true});
        try {
            const page = await browser.newPage({acceptDownloads: true});
            await page.goto(origin);
            await page.addScriptTag({
                path: boundedBundlePath,
                type: 'module',
            });
            await page.waitForFunction(() => typeof Reflect.get(globalThis, '__evbInstallTiffPartsAcceptance') === 'function');
            await page.evaluate(([
                sourceKind,
                target,
                occupied,
                fail,
            ]) => Reflect.get(globalThis, '__evbInstallTiffPartsAcceptance')(sourceKind, target, occupied, fail), [
                kind,
                destination,
                collision,
                failPage,
            ] as const);
            const downloads: Download[] = [];
            const allDownloads = Promise.withResolvers<undefined>();
            page.on('download', download => {downloads.push(download); if (downloads.length === 3) allDownloads.resolve(undefined);});
            await page.locator('#tiff-parts-export').click();
            await page.waitForFunction(() => Boolean(document.querySelector('#tiff-parts-result')?.textContent));
            const outcome = JSON.parse(await page.locator('#tiff-parts-result').innerText()) as {
                result: {
                    success: boolean;
                    canceled?: boolean;
                    outputPaths?: string[];
                    error?: string
                };
                files: Array<{
                    name: string;
                    bytesBase64: string
                }>;
                progress: number[];
            };
            if (destination === 'cancel') {
                expect(outcome.result).toMatchObject({
                    success: false,
                    canceled: true,
                });
                expect(outcome.files).toEqual([]);
                expect(downloads).toEqual([]);
                return;
            }
            const base = kind === 'pdf' ? 'browser-pdf-image-export' : 'document';
            const extension = kind === 'pdf' ? 'tif' : 'tiff';
            if (failPage) {
                expect(outcome.result).toMatchObject({
                    success: false,
                    error: 'third page raster failed',
                });
                expect(outcome.files.map(file => file.name)).toEqual([`${base}-part-001.${extension}`]);
                expect(UTIF.decode(Buffer.from(outcome.files[0]!.bytesBase64, 'base64'))).toHaveLength(2);
                expect(outcome.progress.at(-1)).toBeLessThan(100);
                return;
            }
            expect(outcome.result.success).toBe(true);
            expect(outcome.result.outputPaths).toHaveLength(3);
            expect(outcome.progress.every((percent, index) => index === 0 || percent >= outcome.progress[index - 1]!)).toBe(true);
            expect(outcome.progress.at(-1)).toBe(100);
            let files: Array<{
                name: string;
                bytes: Uint8Array
            }>;
            if (destination === 'download') {
                await allDownloads.promise;
                files = await Promise.all(downloads.map(async download => {
                    const path = await download.path();
                    if (!path) throw new Error('Download did not finish');
                    return {
                        name: download.suggestedFilename(),
                        bytes: await readFile(path),
                    };
                }));
            } else {
                files = outcome.files.filter(file => !collision || file.name !== `${base}-part-001.${extension}`).map(file => ({
                    name: file.name,
                    bytes: Buffer.from(file.bytesBase64, 'base64'),
                }));
                if (collision) expect(Buffer.from(outcome.files.find(file => file.name === `${base}-part-001.${extension}`)!.bytesBase64, 'base64').toString()).toBe('earlier TIFF');
            }
            files.sort((a, b) => a.name.localeCompare(b.name));
            expect(files.map(file => file.name)).toEqual([
                `${base}-part-001${collision ? '-1' : ''}.${extension}`,
                `${base}-part-002.${extension}`,
                `${base}-part-003.${extension}`,
            ]);
            expect(files.map(file => UTIF.decode(file.bytes).length)).toEqual([
                2,
                2,
                1,
            ]);
            let pageNumber = 0;
            for (const file of files) {
                for (const frame of UTIF.decode(file.bytes)) {
                    const offset = firstNumber(frame.t273)!;
                    const length = firstNumber(frame.t279)!;
                    expect(offset).toBeGreaterThan(8);
                    expect(offset + length).toBeLessThanOrEqual(file.bytes.byteLength);
                    expect(readTiffFrameDpi(frame)).toEqual(kind === 'pdf' ? {
                        x: 144,
                        y: 144,
                    } : PAGE_DPI);
                    UTIF.decodeImage(file.bytes, frame);
                    const rgba = UTIF.toRGBA8(frame);
                    if (kind === 'pdf') expect(Math.abs(rgba[0]! - Math.round((pageNumber + 1) * 25.5))).toBeLessThanOrEqual(1);
                    pageNumber += 1;
                }
            }
            expect(pageNumber).toBe(5);
        } finally {
            await browser.close();
        }
    });

    it('writes a multi-page DjVu TIFF into the chosen folder with each page density', async () => {
        const browser = await chromium.launch({headless: true});
        try {
            const page = await browser.newPage();
            await page.goto(origin);
            await page.addScriptTag({
                path: bundlePath,
                type: 'module',
            });
            await page.waitForFunction(() => typeof Reflect.get(globalThis, '__evbRunBrowserDjvuMultiPageTiffExportAcceptance') === 'function');
            for (const chosenName of ['document.tiff']) {
                const result = await page.evaluate<{
                    bytesBase64: string;
                    storedName: string;
                    savedName: string;
                }, string>(
                    name => Reflect.get(globalThis, '__evbRunBrowserDjvuMultiPageTiffExportAcceptance')(name),
                    chosenName,
                );
                expect(result.storedName).toBe(chosenName);
                expect(result.savedName).toBe(chosenName);
                const frames = UTIF.decode(Buffer.from(result.bytesBase64, 'base64'));
                expect(frames.map(frame => ({
                    width: firstNumber(frame.t256),
                    height: firstNumber(frame.t257),
                    dpi: readTiffFrameDpi(frame),
                }))).toEqual([
                    {
                        width: 640,
                        height: 480,
                        dpi: {
                            x: 72,
                            y: 72,
                        },
                    },
                    {
                        width: 512,
                        height: 512,
                        dpi: PAGE_DPI,
                    },
                ]);
            }
        } finally {
            await browser.close();
        }
    });

    it('writes a multi-page PDF TIFF into the chosen folder with both pages', async () => {
        const browser = await chromium.launch({headless: true});
        try {
            const page = await browser.newPage();
            await page.goto(origin);
            await page.addScriptTag({
                path: bundlePath,
                type: 'module',
            });
            await page.waitForFunction(() => typeof Reflect.get(globalThis, '__evbRunBrowserPdfMultiPageTiffExportAcceptance') === 'function');
            for (const chosenName of ['browser-pdf-image-export.tif']) {
                const result = await page.evaluate<{
                    bytesBase64: string;
                    storedName: string;
                    savedName: string;
                }, string>(
                    name => Reflect.get(globalThis, '__evbRunBrowserPdfMultiPageTiffExportAcceptance')(name),
                    chosenName,
                );
                expect(result.storedName).toBe(chosenName);
                expect(result.savedName).toBe(chosenName);
                expect(UTIF.decode(Buffer.from(result.bytesBase64, 'base64'))).toHaveLength(2);
            }
        } finally {
            await browser.close();
        }
    });
    // T3: a multi-page TIFF holds every page. Its decoded pages once had to fit
    // 64 MiB: without a file handle always, and for DjVu even with one.
    it('writes multi-page TIFFs whose decoded pages exceed 64 MiB through a handle and as a download', async () => {
        const browser = await chromium.launch({headless: true});
        try {
            const page = await browser.newPage();
            await page.goto(origin);
            await page.addScriptTag({
                path: bundlePath,
                type: 'module',
            });
            await page.waitForFunction(() => typeof Reflect.get(globalThis, '__evbRunBrowserLargeMultiPageTiffExportAcceptance') === 'function');
            const runExport = (sourceKind: 'djvu' | 'pdf', pageCount: number) => page.evaluate<{
                success: boolean;
                error?: string;
                saved?: {
                    byteLength: number;
                    frames: Array<{
                        width: number;
                        height: number
                    }>
                } | null;
            }, [string, number]>(
                ([
                    kind,
                    count,
                ]) => Reflect.get(globalThis, '__evbRunBrowserLargeMultiPageTiffExportAcceptance')(kind, count),
                [
                    sourceKind,
                    pageCount,
                ],
            );

            // Seventy 512 x 512 DjVu pages decode to 70 MiB of RGBA.
            const djvu = await runExport('djvu', 70);
            expect(djvu).toMatchObject({success: true});
            expect(djvu.saved!.byteLength).toBeGreaterThan(70 * 1024 * 1024);
            expect(djvu.saved!.frames).toHaveLength(70);
            expect(djvu.saved!.frames.every(frame => frame.width === 512 && frame.height === 512)).toBe(true);

            // Ten Letter pages at 144 DPI decode to 74 MiB of RGBA.
            const download = page.waitForEvent('download');
            const pdf = await runExport('pdf', 10);
            expect(pdf).toMatchObject({success: true});
            const downloaded = await readFile((await (await download).path())!);
            expect((await download).suggestedFilename()).toBe('browser-letter-image-export.tif');
            expect(downloaded.byteLength).toBeGreaterThan(64 * 1024 * 1024);
            const frames = UTIF.decode(downloaded);
            expect(frames).toHaveLength(10);
            expect(frames.map(frame => [
                firstNumber(frame.t256),
                firstNumber(frame.t257),
            ])).toEqual(
                Array.from({length: 10}, () => [
                    1224,
                    1584,
                ]),
            );
        } finally {
            await browser.close();
        }
    }, 120_000);

    // T3: a page export writes every selected page after one destination
    // choice, as desktop does; it once asked for a file name for every page.
    it('exports several pages into one chosen folder under desktop names, or as one ZIP download', async () => {
        const browser = await chromium.launch({headless: true});
        try {
            const page = await browser.newPage();
            await page.goto(origin);
            await page.addScriptTag({
                path: bundlePath,
                type: 'module',
            });
            await page.waitForFunction(() => typeof Reflect.get(globalThis, '__evbRunBrowserBatchImageExportAcceptance') === 'function');
            const runExport = (sourceKind: 'djvu' | 'pdf', pageCount: number, withDirectoryPicker: boolean) => page.evaluate<{
                success: boolean;
                outputCount: number | null;
                prompts: {
                    directory: number;
                    save: number
                };
                files: Array<{
                    name: string;
                    head: number[];
                    text: string | null
                }>;
            }, [string, number, boolean]>(
                ([
                    kind,
                    count,
                    directory,
                ]) => Reflect.get(globalThis, '__evbRunBrowserBatchImageExportAcceptance')(kind, count, directory),
                [
                    sourceKind,
                    pageCount,
                    withDirectoryPicker,
                ],
            );

            const pdf = await runExport('pdf', 5, true);
            expect(pdf).toMatchObject({
                success: true,
                outputCount: 5,
                prompts: {
                    directory: 1,
                    save: 0,
                },
            });
            // The earlier export keeps its name and bytes; the new first page takes "-1".
            expect(pdf.files.map(file => file.name)).toEqual([
                'document-pages-001-1.jpg',
                'document-pages-001.jpg',
                'document-pages-002.jpg',
                'document-pages-003.jpg',
                'document-pages-004.jpg',
                'document-pages-005.jpg',
            ]);
            expect(pdf.files.find(file => file.name === 'document-pages-001.jpg')?.text).toBe('earlier export');
            expect(pdf.files.filter(file => file.name !== 'document-pages-001.jpg').every(file => file.head.join() === JPEG_SIGNATURE.join())).toBe(true);

            const djvu = await runExport('djvu', 3, true);
            expect(djvu).toMatchObject({
                success: true,
                outputCount: 3,
                prompts: {
                    directory: 1,
                    save: 0,
                },
            });
            expect(djvu.files.map(file => file.name)).toEqual([
                'document-pages-001.jpg',
                'document-pages-page-001.jpg',
                'document-pages-page-002.jpg',
                'document-pages-page-003.jpg',
            ]);

            const download = page.waitForEvent('download');
            const zipped = await runExport('pdf', 4, false);
            expect(zipped).toMatchObject({
                success: true,
                prompts: {
                    directory: 0,
                    save: 0,
                },
            });
            expect((await download).suggestedFilename()).toBe('document-pages.zip');
            const archive = await readFile((await (await download).path())!);
            // Walk the STORED local entries the archive opens with.
            const entries: Array<{
                name: string;
                head: number[]
            }> = [];
            for (let offset = 0; archive.readUInt32LE(offset) === 0x04034B50;) {
                const size = archive.readUInt32LE(offset + 18);
                const nameLength = archive.readUInt16LE(offset + 26);
                const dataStart = offset + 30 + nameLength + archive.readUInt16LE(offset + 28);
                entries.push({
                    name: archive.toString('utf8', offset + 30, offset + 30 + nameLength),
                    head: [...archive.subarray(dataStart, dataStart + 3)],
                });
                offset = dataStart + size;
            }
            expect(entries.map(entry => entry.name)).toEqual([
                'document-pages-001.jpg',
                'document-pages-002.jpg',
                'document-pages-003.jpg',
                'document-pages-004.jpg',
            ]);
            expect(entries.every(entry => entry.head.join() === JPEG_SIGNATURE.join())).toBe(true);
        } finally {
            await browser.close();
        }
    }, 120_000);

    it('exposes DjVu PNG density before image data to header readers', async () => {
        const browser = await chromium.launch({headless: true});
        try {
            const page = await browser.newPage();
            await page.goto(origin);
            await page.addScriptTag({
                path: bundlePath,
                type: 'module',
            });
            await page.waitForFunction(() => typeof Reflect.get(globalThis, '__evbRunBrowserDjvuImageExportAcceptance') === 'function');
            const result = await page.evaluate(() => Reflect.get(globalThis, '__evbRunBrowserDjvuImageExportAcceptance')('density.png'));
            const bytes = bytesOf(result);
            const types: string[] = [];
            for (let offset = 8; offset < bytes.length; offset += bytes.readUInt32BE(offset) + 12) {
                types.push(bytes.toString('ascii', offset + 4, offset + 8));
            }
            expect(types.filter(type => type === 'pHYs')).toHaveLength(1);
            expect(types.indexOf('pHYs')).toBeLessThan(types.indexOf('IDAT'));
            expect(readPngDpi(bytes)).toEqual(PAGE_DPI);
        } finally {
            await browser.close();
        }
    });

    it('preserves the physical 1 by 2 inch PDF page in every raster format', async () => {
        const browser = await chromium.launch({headless: true});
        try {
            const page = await browser.newPage();
            await page.goto(origin);
            await page.addScriptTag({
                path: bundlePath,
                type: 'module',
            });
            await page.waitForFunction(() => typeof Reflect.get(globalThis, '__evbRunBrowserPdfImageExportAcceptance') === 'function');
            for (const extension of [
                'png',
                'jpg',
                'tif',
            ]) {
                const result = await page.evaluate(ext => Reflect.get(globalThis, '__evbRunBrowserPdfImageExportAcceptance')(`density.${ext}`), extension);
                const bytes = bytesOf(result);
                const dpi = extension === 'png' ? readPngDpi(bytes) : extension === 'jpg' ? readJpegDpi(bytes) : readTiffFrameDpi(UTIF.decode(bytes)[0]!);
                expect(dpi, extension).toEqual({
                    x: 144,
                    y: 144,
                });
            }
            const result = await page.evaluate(() => Reflect.get(globalThis, '__evbRunBrowserPdfMultiPageTiffExportAcceptance')('density.tif'));
            expect(UTIF.decode(bytesOf(result)).map(frame => ({
                width: firstNumber(frame.t256),
                height: firstNumber(frame.t257),
                dpi: readTiffFrameDpi(frame),
            }))).toEqual(Array.from({length: 2}, () => ({
                width: 144,
                height: 288,
                dpi: {
                    x: 144,
                    y: 144,
                },
            })));
        } finally {
            await browser.close();
        }
    });

    it('refuses a non-TIFF handle before writing and restricts the save picker', async () => {
        const browser = await chromium.launch({headless: true});
        try {
            const page = await browser.newPage();
            await page.goto(origin);
            await page.addScriptTag({
                path: bundlePath,
                type: 'module',
            });
            await page.waitForFunction(() => typeof Reflect.get(globalThis, '__evbRunBrowserPdfMultiPageTiffExportAcceptance') === 'function');
            for (const runner of [
                '__evbRunBrowserDjvuMultiPageTiffExportAcceptance',
                '__evbRunBrowserPdfMultiPageTiffExportAcceptance',
            ]) {
                for (const chosenName of [
                    'doc.png',
                    'page.',
                    'x.tif.png',
                    'document',
                    'document.tiff ',
                ]) {
                    const result = await page.evaluate(([
                        name,
                        entry,
                    ]) => Reflect.get(globalThis, entry)(name, true), [
                        chosenName,
                        runner,
                    ] as const);
                    expect(result, `${runner}: ${chosenName}`).toMatchObject({
                        refused: true,
                        savedName: chosenName,
                        bytesBase64: '',
                    });
                    expect(result.error).toContain('.tif');
                    expect(result.pickerOptions).toMatchObject({excludeAcceptAllOption: true});
                    expect(result.pickerOptions.types.flatMap((type: {accept: Record<string, string[]>}) => Object.values(type.accept).flat())).toEqual([
                        '.tif',
                        '.tiff',
                    ]);
                }
            }
        } finally {
            await browser.close();
        }
    });

    it('keeps the other compact DjVu export intact after Cancel in one document', async () => {
        const browser = await chromium.launch({headless: true});
        const releaseWasm = Promise.withResolvers<undefined>();
        try {
            const page = await browser.newPage();
            // Both held requests must be admitted by the two-slot worker pool.
            await page.addInitScript(() => {
                Object.defineProperty(navigator, 'hardwareConcurrency', {get: () => 4});
            });
            await page.goto(origin);
            await page.addScriptTag({
                path: bundlePath,
                type: 'module',
            });
            await page.waitForFunction(() => typeof Reflect.get(globalThis, '__evbInstallBrowserCompactDjvuAcceptance') === 'function');
            await page.evaluate(async () => {
                await Reflect.get(globalThis, '__evbInstallBrowserCompactDjvuAcceptance')(2);
                // Hold the real encoding endpoint at its WASM fetch; count only
                // admitted requests to make the overlap deterministic.
                Reflect.set(globalThis, '__compactPosted', 0);
                const post = Worker.prototype.postMessage;
                Worker.prototype.postMessage = function(message, options) {
                    if (message.type === 'combinePdfs') Reflect.set(globalThis, '__compactPosted', Reflect.get(globalThis, '__compactPosted') + 1);
                    return post.call(this, message, Array.isArray(options) ? {transfer: options} : options);
                };
            });
            await page.route('**/wasm/evb-pdf-image-combine.wasm', async route => {
                await releaseWasm.promise;
                await route.continue().catch(() => undefined);
            });
            await page.locator('#compact-export').click();
            await page.locator('#compact-export-other').click();
            await page.waitForFunction(() => Reflect.get(globalThis, '__compactPosted') === 2);
            await page.locator('#compact-cancel').click();
            await expect.poll(() => page.locator('#compact-status').textContent()).toBe('Canceled');
            releaseWasm.resolve(undefined);
            await expect.poll(() => page.locator('#compact-status-other').textContent(), {timeout: 30_000}).toBe('Completed');
            const result = await page.evaluate(() => Reflect.get(globalThis, '__evbBrowserCompactDjvuAcceptanceResult-other'));
            expect(result).toMatchObject({
                success: true,
                terminalStatus: 'completed',
                generatedPdfHeader: '%PDF-',
                referenceMatches: true,
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
            });
            expect(result.outputBytes).toBeGreaterThan(0);
        } finally {
            releaseWasm.resolve(undefined);
            await browser.close();
        }
    }, 90_000);
});
