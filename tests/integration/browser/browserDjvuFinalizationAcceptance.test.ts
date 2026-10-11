import {
    mkdir,
    mkdtemp,
    readFile,
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
import {chromium} from 'playwright';
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
let temporaryDirectory = '';
let djvuBytes: Buffer;
let mixedDpiDjvuBytes: Buffer;
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
    mixedDpiDjvuBytes = await readFile(resolve(process.cwd(), 'tests/fixtures/djvu/sources/mixed-dpi.djvu'));
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
        if (_request.url === '/fixtures/mixed-dpi.djvu') {
            response.writeHead(200, {'content-type': 'application/octet-stream'});
            response.end(mixedDpiDjvuBytes);
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

    it('writes a multi-page DjVu TIFF under the chosen handle name with each page density', async () => {
        const browser = await chromium.launch({headless: true});
        try {
            const page = await browser.newPage();
            await page.goto(origin);
            await page.addScriptTag({
                path: bundlePath,
                type: 'module',
            });
            await page.waitForFunction(() => typeof Reflect.get(globalThis, '__evbRunBrowserDjvuMultiPageTiffExportAcceptance') === 'function');
            for (const chosenName of [
                'document.tiff',
                'doc.TIF',
            ]) {
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

    it('writes a multi-page PDF TIFF under the chosen handle name with both pages', async () => {
        const browser = await chromium.launch({headless: true});
        try {
            const page = await browser.newPage();
            await page.goto(origin);
            await page.addScriptTag({
                path: bundlePath,
                type: 'module',
            });
            await page.waitForFunction(() => typeof Reflect.get(globalThis, '__evbRunBrowserPdfMultiPageTiffExportAcceptance') === 'function');
            for (const chosenName of [
                'document.tiff',
                'doc.TIF',
            ]) {
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
                    ]) => Reflect.get(globalThis, entry)(name), [
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

});
