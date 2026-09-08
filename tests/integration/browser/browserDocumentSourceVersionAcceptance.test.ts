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
    temporaryDirectory = await mkdtemp(join(process.cwd(), '.devkit/browser-document-source-version-'));
    bundlePath = join(temporaryDirectory, 'browser-document-source-version-acceptance.js');
    await build({
        bundle: true,
        entryPoints: [resolve(process.cwd(), 'tests/integration/browser/browserDocumentSourceVersionAcceptanceEntry.ts')],
        format: 'iife',
        outfile: bundlePath,
        platform: 'browser',
        sourcemap: false,
        tsconfig: resolve(process.cwd(), 'tsconfig.json'),
    });
    server = createServer((_request, response) => {
        response.writeHead(200, {'content-type': 'text/html'});
        response.end('<!doctype html><title>Browser source version acceptance</title>');
    });
    await new Promise<void>((resolveListen, rejectListen) => {
        server.once('error', rejectListen);
        server.listen(0, '127.0.0.1', resolveListen);
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('Browser source version acceptance harness did not bind a TCP port');
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

describe('browser source version acceptance in Chromium', () => {
    it('opens current physical bytes while retaining the dirty prior version', async () => {
        const browser = await chromium.launch({headless: true});
        try {
            const page = await browser.newPage();
            await page.goto(origin);
            await page.addScriptTag({path: bundlePath});
            const result = await page.evaluate(async () => {
                const run = Reflect.get(globalThis, '__evbRunBrowserDocumentSourceVersionAcceptance');
                if (typeof run !== 'function') {
                    throw new Error('Browser source version acceptance entry point was not installed');
                }
                return run();
            });
            expect(result).toEqual({
                firstBytes: [
                    37,
                    80,
                    68,
                    70,
                ],
                reopenedBytes: [
                    37,
                    80,
                    68,
                    71,
                ],
                dirtyBytes: [
                    37,
                    80,
                    68,
                    70,
                    1,
                ],
                reopenedIsFresh: true,
                dirtySourceRefIsOriginal: true,
            });
        } finally {
            await browser.close();
        }
    }, 120_000);
});
