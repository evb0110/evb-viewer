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
    temporaryDirectory = await mkdtemp(join(process.cwd(), '.devkit/browser-document-maintenance-'));
    bundlePath = join(temporaryDirectory, 'browser-document-maintenance-acceptance.js');
    await build({
        bundle: true,
        entryPoints: [resolve(process.cwd(), 'tests/integration/browser/browserDocumentMaintenanceAcceptanceEntry.ts')],
        format: 'iife',
        outfile: bundlePath,
        platform: 'browser',
        sourcemap: false,
        tsconfig: resolve(process.cwd(), 'tsconfig.json'),
    });
    server = createServer((_request, response) => {
        response.writeHead(200, {'content-type': 'text/html'});
        response.end('<!doctype html><title>Browser maintenance acceptance</title>');
    });
    await new Promise<void>((resolveListen, rejectListen) => {
        server.once('error', rejectListen);
        server.listen(0, '127.0.0.1', resolveListen);
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('Browser maintenance acceptance harness did not bind a TCP port');
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

describe('browser document maintenance acceptance in Chromium', () => {
    it('keeps inline and chunked Recent Files sources across a cross-window sweep', async () => {
        const browser = await chromium.launch({headless: true});
        try {
            const context = await browser.newContext();
            const pageA = await context.newPage();
            const pageB = await context.newPage();
            await Promise.all([
                pageA.goto(origin),
                pageB.goto(origin),
            ]);
            await Promise.all([
                pageA.addScriptTag({path: bundlePath}),
                pageB.addScriptTag({path: bundlePath}),
            ]);
            const setup = await pageA.evaluate(async () => {
                const run = Reflect.get(globalThis, '__evbCreateMaintenanceAcceptanceDocuments');
                if (typeof run !== 'function') throw new Error('Maintenance setup entry point missing');
                return run();
            });
            const retainedRefs = setup.refs.slice(0, 2);
            const maintenance = pageA.evaluate(async (refs: string[]) => {
                const run = Reflect.get(globalThis, '__evbRunMaintenanceWindow');
                if (typeof run !== 'function') throw new Error('Maintenance entry point missing');
                return run(refs);
            }, setup.refs);
            const touch = pageB.evaluate(async (refs: string[]) => {
                const run = Reflect.get(globalThis, '__evbRunMaintenanceTouchWindow');
                if (typeof run !== 'function') throw new Error('Maintenance touch entry point missing');
                return run(refs);
            }, retainedRefs);
            const [
                touchResult,
                maintenanceResult,
            ] = await Promise.all([
                touch,
                maintenance,
            ]);
            expect(touchResult.recentFiles).toEqual(expect.arrayContaining(retainedRefs));
            expect(maintenanceResult).toEqual({
                inline: {
                    exists: true,
                    length: 8,
                    prefix: setup.hashes.inlinePrefix,
                },
                chunked: {
                    exists: true,
                    length: 8,
                    prefix: setup.hashes.chunkedPrefix,
                },
                recentFiles: retainedRefs,
            });
            await pageA.reload();
            await pageA.addScriptTag({path: bundlePath});
            const reloaded = await pageA.evaluate(async ({
                orphan,
                retained,
            }: {
                orphan: string;
                retained: string[]
            }) => {
                const read = Reflect.get(globalThis, '__evbReadMaintenanceDocument');
                const exists = Reflect.get(globalThis, '__evbExistsMaintenanceDocument');
                if (typeof read !== 'function' || typeof exists !== 'function') {
                    throw new Error('Maintenance read entry point missing after reload');
                }
                const persistedRecent = Reflect.get(globalThis, '__evbReadPersistedMaintenanceRecent');
                if (typeof persistedRecent !== 'function') {
                    throw new Error('Maintenance persisted Recent entry point missing after reload');
                }
                return {
                    retained: await Promise.all(retained.map(ref => read(ref))),
                    orphanExists: await exists(orphan),
                    persistedRecent: await persistedRecent(),
                };
            }, {
                orphan: setup.refs[2],
                retained: retainedRefs,
            });
            expect(reloaded).toEqual({
                orphanExists: false,
                retained: [
                    {
                        exists: true,
                        length: 8,
                        prefix: setup.hashes.inlinePrefix,
                    },
                    {
                        exists: true,
                        length: 8,
                        prefix: setup.hashes.chunkedPrefix,
                    },
                ],
                persistedRecent: {
                    refs: retainedRefs,
                    proofs: [
                        {
                            exists: true,
                            length: 8,
                            prefix: setup.hashes.inlinePrefix,
                        },
                        {
                            exists: true,
                            length: 8,
                            prefix: setup.hashes.chunkedPrefix,
                        },
                    ],
                },
            });
            const persistence = await pageA.evaluate(async (ref: string) => {
                const run = Reflect.get(globalThis, '__evbRunRecentPersistenceFailureRetry');
                if (typeof run !== 'function') throw new Error('Recent persistence retry entry point missing');
                return run(ref);
            }, retainedRefs[0]);
            expect(persistence).toEqual({
                failed: true,
                retryCommitted: true,
            });
        } finally {
            await browser.close();
        }
    }, 120_000);
});
