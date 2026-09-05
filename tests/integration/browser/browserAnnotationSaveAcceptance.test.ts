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
let pageOpsWorkerBundlePath = '';
let temporaryDirectory = '';
let wasmBytes: Buffer;

beforeAll(async () => {
    await mkdir(join(process.cwd(), '.devkit'), {recursive: true});
    temporaryDirectory = await mkdtemp(join(process.cwd(), '.devkit/browser-annotation-save-'));
    bundlePath = join(temporaryDirectory, 'browser-annotation-save-acceptance.js');
    pageOpsWorkerBundlePath = join(temporaryDirectory, 'browser-page-ops.worker.js');
    await build({
        bundle: true,
        entryPoints: [resolve(process.cwd(), 'tests/integration/browser/browserAnnotationSaveAcceptanceEntry.ts')],
        format: 'esm',
        outfile: bundlePath,
        platform: 'browser',
        sourcemap: false,
        tsconfig: resolve(process.cwd(), 'tsconfig.json'),
    });
    await build({
        bundle: true,
        entryPoints: [resolve(process.cwd(), 'app/platform/browser-api/browserPageOps.worker.ts')],
        format: 'esm',
        outfile: pageOpsWorkerBundlePath,
        platform: 'browser',
        sourcemap: false,
        tsconfig: resolve(process.cwd(), 'tsconfig.json'),
    });
    wasmBytes = await readFile(resolve(process.cwd(), 'public/wasm/evb-pdf-page-ops.wasm'));
    const pageOpsWorkerBytes = await readFile(pageOpsWorkerBundlePath);
    server = createServer((_request, response) => {
        if (_request.url === '/wasm/evb-pdf-page-ops.wasm') {
            response.writeHead(200, {'content-type': 'application/wasm'});
            response.end(wasmBytes);
            return;
        }
        if (_request.url === '/browserPageOps.worker.ts') {
            response.writeHead(200, {'content-type': 'text/javascript'});
            response.end(pageOpsWorkerBytes);
            return;
        }
        response.writeHead(200, {'content-type': 'text/html'});
        response.end('<!doctype html><title>Browser annotation save acceptance</title>');
    });
    await new Promise<void>((resolveListen, rejectListen) => {
        server.once('error', rejectListen);
        server.listen(0, '127.0.0.1', resolveListen);
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('Browser annotation save acceptance harness did not bind a TCP port');
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

describe('browser annotation save acceptance in Chromium', () => {
    it('opens, edits, saves, and reopens under the cap, and rejects over-cap open and save', async () => {
        const browser = await chromium.launch({headless: true});
        try {
            const page = await browser.newPage();
            await page.goto(origin);
            await page.addScriptTag({
                path: bundlePath,
                type: 'module',
            });
            const result = await page.evaluate(async () => {
                const run = Reflect.get(globalThis, '__evbRunBrowserAnnotationSaveAcceptance');
                if (typeof run !== 'function') {
                    throw new Error('Browser annotation save acceptance entry point was not installed');
                }
                return run();
            });
            expect(result).toEqual({
                underCap: {
                    openedWithAnnotations: true,
                    canonicalWriterVerified: true,
                    savedAndReopened: true,
                },
                overCap: {
                    openMessage: expect.stringContaining('Use the native app for files this large.'),
                    saveMessage: expect.stringContaining('Use the native app for files this large.'),
                    openRejectedWithLocalizedCap: true,
                    saveRejectedWithLocalizedCap: true,
                },
            });
        } finally {
            await browser.close();
        }
    }, 120_000);
});
