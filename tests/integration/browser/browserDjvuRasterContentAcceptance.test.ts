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

beforeAll(async () => {
    await mkdir(join(process.cwd(), '.devkit'), {recursive: true});
    temporaryDirectory = await mkdtemp(join(process.cwd(), '.devkit/browser-djvu-raster-content-'));
    bundlePath = join(temporaryDirectory, 'entry.js');
    await build({
        bundle: true,
        entryPoints: [resolve(process.cwd(), 'tests/integration/browser/browserDjvuRasterContentAcceptanceEntry.ts')],
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
    const assets = new Map([
        [
            '/browserPdfCombine.worker.ts',
            {
                type: 'text/javascript',
                bytes: await readFile(workerPath),
            },
        ],
        [
            '/vendor/djvujs/djvu.js',
            {
                type: 'text/javascript',
                bytes: await readFile(resolve(process.cwd(), 'public/vendor/djvujs/djvu.js')),
            },
        ],
        [
            '/fixtures/bitonal-faint-pencil.djvu',
            {
                type: 'application/octet-stream',
                bytes: await readFile(resolve(process.cwd(), 'tests/fixtures/djvu/sources/bitonal-faint-pencil.djvu')),
            },
        ],
        [
            '/wasm/evb-pdf-image-combine.wasm',
            {
                type: 'application/wasm',
                bytes: await readFile(resolve(process.cwd(), 'public/wasm/evb-pdf-image-combine.wasm')),
            },
        ],
    ]);
    server = createServer((request, response) => {
        const asset = assets.get(request.url ?? '');
        response.writeHead(200, {'content-type': asset?.type ?? 'text/html'});
        response.end(asset?.bytes ?? '<!doctype html><title>DjVu scan pixel acceptance</title>');
    });
    await new Promise<void>((resolveListen, rejectListen) => {
        server.once('error', rejectListen);
        server.listen(0, '127.0.0.1', resolveListen);
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('DjVu scan pixel acceptance server did not bind');
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

describe('browser compact DjVu saved scan pixels', () => {
    it('retains visible source ink on both exact-size scan pages', async () => {
        const browser = await chromium.launch({headless: true});
        try {
            const page = await browser.newPage();
            await page.goto(origin);
            await page.addScriptTag({
                path: bundlePath,
                type: 'module',
            });
            await page.evaluate(async () => {
                const install = Reflect.get(globalThis, '__evbInstallDjvuRasterContentAcceptance');
                if (typeof install !== 'function') {
                    throw new Error('DjVu scan pixel acceptance entry point was not installed');
                }
                await install();
            });
            await page.getByRole('button', {name: 'Export compact PDF'}).click();
            await page.waitForFunction(() => Reflect.get(globalThis, '__evbDjvuRasterContentResult'));
            const result = await page.evaluate(() => Reflect.get(globalThis, '__evbDjvuRasterContentResult'));
            expect(result.error).toBeUndefined();
            expect(result.success).toBe(true);
            expect(result.sourceInkPixels).toHaveLength(2);
            expect(result.outputInkPixels).toHaveLength(2);
            for (const inkPixels of result.sourceInkPixels) {
                expect(inkPixels).toBeGreaterThan(0);
            }
            for (const inkPixels of result.outputInkPixels) {
                expect(inkPixels).toBeGreaterThan(0);
            }
        } finally {
            await browser.close();
        }
    }, 120_000);
});
