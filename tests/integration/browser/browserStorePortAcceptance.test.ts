import {
    mkdir,
    mkdtemp,
    readFile,
    rm,
    writeFile,
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
    firefox,
    webkit,
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

beforeAll(async () => {
    await mkdir(join(process.cwd(), '.devkit'), {recursive: true});
    temporaryDirectory = await mkdtemp(join(process.cwd(), '.devkit/browser-store-port-'));
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
        bundle('tests/integration/browser/browserStorePortAcceptanceEntry.ts', 'entry.js'),
        bundle('app/platform/browser/opfsStore.worker.ts', 'opfs-store-worker.js'),
    ]);
    server = createServer((request, response) => {
        const name = request.url === '/entry.js' ? 'entry.js' : request.url === '/opfs-store-worker.js' ? 'opfs-store-worker.js' : null;
        if (!name) {
            response.writeHead(200, {'content-type': 'text/html'});
            response.end('<!doctype html><title>Browser store port</title><script type="module" src="/entry.js"></script>');
            return;
        }
        void readFile(join(temporaryDirectory, name)).then((body) => {
            response.writeHead(200, {'content-type': 'text/javascript'});
            response.end(body);
        });
    });
    await new Promise<void>((resolveListen, rejectListen) => {
        server.once('error', rejectListen);
        server.listen(0, '127.0.0.1', resolveListen);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('The store port harness did not bind a TCP port');
    origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
    if (server) await new Promise<void>(resolveClose => server.close(() => resolveClose()));
    await rm(temporaryDirectory, {force: true, recursive: true});
});

// The storage adapter on each engine's origin private file system: the operations the core uses, the core's
// crash recovery over them, one writer per file across contexts, and reading a large document page by page.
describe('browser store port on the origin private file system', () => {
    it.each([
        ['chromium', chromium],
        ['firefox', firefox],
        ['webkit', webkit],
    ] as const)('%s', async (engine, browserType) => {
        const profile = await mkdtemp(join(temporaryDirectory, `${engine}-`));
        const context = await browserType.launchPersistentContext(profile, {headless: true});
        try {
            const page = context.pages()[0] ?? await context.newPage();
            await page.goto(origin);
            await page.waitForFunction(() => Boolean(Reflect.get(globalThis, '__evbStorePortAcceptance')));
            const run = (scenario: string, ...args: unknown[]) => page.evaluate(([name, values]) => {
                const scenarios = Reflect.get(globalThis, '__evbStorePortAcceptance') as Record<string, (...input: unknown[]) => Promise<unknown>>;
                return scenarios[name as string]!(...values as unknown[]);
            }, [scenario, args] as const);

            expect(await run('portBasics')).toEqual({
                manifest: '{"v":2}',
                afterReplace: ['manifest.json'],
                grown: 13,
                middle: [5, 6, 7, 8],
                pastEnd: [11, 12],
                truncated: 4,
                copiedBytes: [0, 1, 2, 3],
                copiedInBytes: [7, 8, 9],
                copyOntoExisting: false,
                listed: ['manifest.json', 'r1.bin', 'r2.bin', 'r3.bin'],
                missingList: [],
                missingRead: false,
                afterRemove: [],
            });
            expect(await run('coreRecovery')).toEqual({
                appended: 'committed',
                drafts: 'stored',
                length: 200_015,
                expectedLength: 200_015,
                bytesIntact: true,
                draftsAfter: {note: 'unsaved note'},
                dirty: true,
                files: ['manifest.json', 'r1.pdf'],
            });
            expect(await run('exclusive')).toEqual({
                otherContext: expect.stringMatching(/^(NoModificationAllowedError|InvalidStateError)$/u),
                sameContext: 'refused',
                afterRelease: true,
            });
            const large = await run('largeRead', 1024) as Record<string, unknown>;
            // Evidence for the reader: throughput of a 1 GiB document read page by page through the store worker.
            await writeFile(join(process.cwd(), '.devkit', `store-port-1gib-${engine}.json`), JSON.stringify(large, null, 2));
            expect(large).toMatchObject({
                readBytes: 1024 * 1024 * 1024,
                randomBytes: 512 * 256 * 1024,
                firstOfChunk: [3],
            });
        } finally {
            await context.close();
        }
    }, 300_000);
});
