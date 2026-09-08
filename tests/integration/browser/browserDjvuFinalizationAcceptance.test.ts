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
let djvuBytes: Buffer;
let djvuScriptBytes: Buffer;

beforeAll(async () => {
    await mkdir(join(process.cwd(), '.devkit'), {recursive: true});
    temporaryDirectory = await mkdtemp(join(process.cwd(), '.devkit/browser-djvu-finalization-'));
    bundlePath = join(temporaryDirectory, 'browser-djvu-finalization-acceptance.js');
    await build({
        bundle: true,
        entryPoints: [resolve(process.cwd(), 'tests/integration/browser/browserDjvuFinalizationAcceptanceEntry.ts')],
        format: 'iife',
        outfile: bundlePath,
        platform: 'browser',
        sourcemap: false,
        tsconfig: resolve(process.cwd(), 'tsconfig.json'),
    });
    djvuBytes = await readFile(resolve(process.cwd(), 'tests/fixtures/djvu/sources/bitonal-faint-pencil.djvu'));
    djvuScriptBytes = await readFile(resolve(process.cwd(), 'public/vendor/djvujs/djvu.js'));
    server = createServer((_request, response) => {
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
            await page.addScriptTag({path: bundlePath});
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
});
