import {tmpdir} from 'node:os';
import path from 'node:path';
import {
    mkdir,
    mkdtemp,
    readFile,
    rm,
    writeFile,
} from 'node:fs/promises';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    sendEnvelope,
    sendSentrySourcemapCanaries,
} from '@scripts/release/send-sentry-sourcemap-canaries.mjs';
import {DIAGNOSTIC_EVENT_DEFINITIONS} from '@contracts/diagnostics/diagnosticCodes';
import {getPrivateSourcemapManifestPath} from '@scripts/release/stage-private-sourcemaps.mjs';
import { makeDsn } from '@sentry/core';

const canaryDsn = makeDsn('https://public@o123.ingest.de.sentry.io/42');
if (canaryDsn === undefined) {
    throw new Error('Canary DSN fixture failed to parse');
}
const sourceMapCanary = DIAGNOSTIC_EVENT_DEFINITIONS.SENTRY_SOURCE_MAP_CANARY;

const roots: string[] = [];
const identity = {
    target: 'desktop',
    release: 'evb-viewer-desktop@1.2.3',
    dist: 'macos-arm64',
    environment: 'test',
} as const;

async function setup() {
    const root = await mkdtemp(path.join(tmpdir(), 'evb-sentry-canary-'));
    roots.push(root);
    const manifestPath = getPrivateSourcemapManifestPath({
        projectRoot: root,
        identity,
    });
    const stageRoot = path.dirname(manifestPath);
    await mkdir(path.join(stageRoot, 'maps/dist-electron'), {recursive: true});
    await writeFile(path.join(stageRoot, 'maps/dist-electron/main.js.map'), JSON.stringify({
        version: 3,
        file: 'main.js',
        sources: ['../../electron/main.ts'],
        names: ['start'],
        mappings: 'AAAAA',
        debug_id: '12345678-1234-5678-9abc-123456789abc',
    }));
    await writeFile(manifestPath, JSON.stringify({
        schemaVersion: 2,
        identity,
        bundles: [{
            bundle: 'dist-electron/main.js',
            role: 'electron-main',
            sources: ['electron/main.ts'],
            stagedMapPath: 'maps/dist-electron/main.js.map',
        }],
    }));
    return root;
}

function environment(overrides: Record<string, string> = {}) {
    return {
        EVB_SENTRY_TARGET: 'desktop',
        EVB_SENTRY_RELEASE: identity.release,
        EVB_SENTRY_DIST: identity.dist,
        EVB_SENTRY_ENVIRONMENT: identity.environment,
        SENTRY_DESKTOP_DSN: 'https://public@o123.ingest.de.sentry.io/42',
        ...overrides,
    };
}

afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, {
        recursive: true,
        force: true,
    })));
});

describe('Sentry source-map canaries', () => {
    it('retries transient ingest responses with bounded server-directed backoff', async () => {
        const responses = [
            new Response(null, {status: 503}),
            new Response(null, {
                headers: {'retry-after': '0'},
                status: 429,
            }),
            new Response(null, {status: 200}),
        ];
        const fetchImpl = vi.fn(async () => responses.shift() ?? new Response(null, {status: 500}));
        const sleep = vi.fn(async () => undefined);

        await sendEnvelope({event_id: 'a'.repeat(32)}, canaryDsn, {
            fetchImpl,
            sleep,
        });

        expect(fetchImpl).toHaveBeenCalledTimes(3);
        expect(sleep).toHaveBeenNthCalledWith(1, 500);
        expect(sleep).toHaveBeenNthCalledWith(2, 0);
    });

    it('does not retry a permanent ingest rejection', async () => {
        const fetchImpl = vi.fn(async () => new Response(null, {status: 400}));
        const sleep = vi.fn();

        await expect(sendEnvelope(
            {event_id: 'a'.repeat(32)},
            canaryDsn,
            {
                fetchImpl,
                sleep,
            },
        )).rejects.toThrow('HTTP 400 after 1 attempt');
        expect(fetchImpl).toHaveBeenCalledOnce();
        expect(sleep).not.toHaveBeenCalled();
    });

    it('bounds retries for transport failures', async () => {
        const fetchImpl = vi.fn(async () => {
            throw new Error('temporary network failure');
        });
        const sleep = vi.fn(async () => undefined);

        await expect(sendEnvelope(
            {event_id: 'a'.repeat(32)},
            canaryDsn,
            {
                fetchImpl,
                sleep,
            },
        )).rejects.toThrow('failed after 5 attempts');
        expect(fetchImpl).toHaveBeenCalledTimes(5);
        expect(sleep).toHaveBeenCalledTimes(4);
    });

    it('sends one closed deterministic Debug-ID event per project-source bundle', async () => {
        const root = await setup();
        const sentEvents: unknown[] = [];
        const sendEvent = vi.fn(async (event: unknown) => {
            sentEvents.push(event);
        });
        const receipt = await sendSentrySourcemapCanaries({
            environment: environment(),
            projectRoot: root,
            sendEvent,
        });

        expect(sendEvent).toHaveBeenCalledOnce();
        expect(sentEvents[0]).toMatchObject({
            release: identity.release,
            dist: identity.dist,
            environment: 'test',
            tags: {
                evb_schema: 'evb-diagnostic-v1',
                [sourceMapCanary.tagKey]: sourceMapCanary.tagValue,
            },
            fingerprint: [
                sourceMapCanary.fingerprintPrefix,
                identity.target,
                identity.release,
                identity.dist,
                identity.environment,
                'dist-electron/main.js',
            ],
            exception: {values: [{
                type: sourceMapCanary.exceptionType,
                value: sourceMapCanary.exceptionValue,
                stacktrace: {frames: [{
                    abs_path: 'dist-electron/main.js',
                    filename: 'dist-electron/main.js',
                }]},
            }]},
            debug_meta: {images: [{
                type: 'sourcemap',
                code_file: 'dist-electron/main.js',
                debug_id: '12345678-1234-5678-9abc-123456789abc',
            }]},
        });
        expect(receipt.events).toEqual([expect.objectContaining({
            bundle: 'dist-electron/main.js',
            codeFile: 'dist-electron/main.js',
            debugId: '12345678-1234-5678-9abc-123456789abc',
            eventId: '04995a5e89a5929ac242aeab0f01598f',
            expectedFunction: 'start',
            expectedLine: 1,
            expectedSource: 'electron/main.ts',
        })]);
        const written = await readFile(path.join(
            path.dirname(getPrivateSourcemapManifestPath({
                projectRoot: root,
                identity,
            })),
            'canary-receipt.json',
        ), 'utf8');
        expect(written).not.toContain('ingest.de.sentry.io');
        expect(written).not.toContain('public@');
    });

    it('records generated or vendor-only bundles that cannot prove an EVB mapping', async () => {
        const root = await setup();
        const manifestPath = getPrivateSourcemapManifestPath({
            projectRoot: root,
            identity,
        });
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {bundles: Array<Record<string, unknown>>};
        manifest.bundles.unshift({
            bundle: 'dist-electron/vendor.js',
            role: 'electron-main',
            sources: [],
            stagedMapPath: 'maps/dist-electron/vendor.js.map',
        });
        await writeFile(manifestPath, JSON.stringify(manifest));
        const sendEvent = vi.fn();

        const receipt = await sendSentrySourcemapCanaries({
            environment: environment(),
            projectRoot: root,
            sendEvent,
        });

        expect(sendEvent).toHaveBeenCalledOnce();
        expect(receipt.skippedBundles).toEqual([{
            bundle: 'dist-electron/vendor.js',
            reason: 'no-project-source',
            role: 'electron-main',
        }]);
    });

    it('uses the deployed browser URL shape for Vercel static bundles', async () => {
        const webIdentity = {
            target: 'web',
            release: 'evb-viewer-web@1.2.3',
            dist: 'preview-fixture',
            environment: 'preview',
        } as const;
        const root = await mkdtemp(path.join(tmpdir(), 'evb-sentry-web-canary-'));
        roots.push(root);
        const manifestPath = getPrivateSourcemapManifestPath({
            projectRoot: root,
            identity: webIdentity,
        });
        const stageRoot = path.dirname(manifestPath);
        const mapPath = 'maps/.vercel/output/static/_nuxt/app.js.map';
        await mkdir(path.join(stageRoot, path.dirname(mapPath)), {recursive: true});
        await writeFile(path.join(stageRoot, mapPath), JSON.stringify({
            version: 3,
            file: 'app.js',
            sources: ['../../../../app/app.ts'],
            names: ['start'],
            mappings: 'AAAAA',
            debug_id: '12345678-1234-5678-9abc-123456789abc',
        }));
        await writeFile(manifestPath, JSON.stringify({
            schemaVersion: 2,
            identity: webIdentity,
            bundles: [{
                bundle: '.vercel/output/static/_nuxt/app.js',
                role: 'browser-renderer',
                sources: ['app/app.ts'],
                stagedMapPath: mapPath,
            }],
        }));
        const sentEvents: unknown[] = [];
        const sendEvent = vi.fn(async (event: unknown) => {
            sentEvents.push(event);
        });

        await sendSentrySourcemapCanaries({
            environment: {
                EVB_SENTRY_TARGET: 'web',
                EVB_SENTRY_RELEASE: webIdentity.release,
                EVB_SENTRY_DIST: webIdentity.dist,
                EVB_SENTRY_ENVIRONMENT: webIdentity.environment,
                SENTRY_BROWSER_DSN: 'https://public@o123.ingest.de.sentry.io/42',
            },
            projectRoot: root,
            sendEvent,
        });

        expect(sentEvents[0]).toMatchObject({
            exception: {values: [{stacktrace: {frames: [{
                abs_path: 'https://evb-viewer.invalid/_nuxt/app.js',
                filename: 'https://evb-viewer.invalid/_nuxt/app.js',
            }]}}]},
            debug_meta: {images: [{code_file: 'https://evb-viewer.invalid/_nuxt/app.js'}]},
        });
    });

    it('uses the deployed browser URL shape for Vercel function bundles', async () => {
        const webIdentity = {
            target: 'web',
            release: 'evb-viewer-web@1.2.3',
            dist: 'preview-function-fixture',
            environment: 'preview',
        } as const;
        const root = await mkdtemp(path.join(tmpdir(), 'evb-sentry-function-canary-'));
        roots.push(root);
        const manifestPath = getPrivateSourcemapManifestPath({
            projectRoot: root,
            identity: webIdentity,
        });
        const stageRoot = path.dirname(manifestPath);
        const mapPath = 'maps/.vercel/output/functions/__fallback.func/chunks/_/index.mjs.map';
        await mkdir(path.join(stageRoot, path.dirname(mapPath)), {recursive: true});
        await writeFile(path.join(stageRoot, mapPath), JSON.stringify({
            version: 3,
            file: 'index.mjs',
            sources: ['../../../../../../server/index.ts'],
            names: ['start'],
            mappings: 'AAAAA',
            debug_id: '12345678-1234-5678-9abc-123456789abc',
        }));
        await writeFile(manifestPath, JSON.stringify({
            schemaVersion: 2,
            identity: webIdentity,
            bundles: [{
                bundle: '.vercel/output/functions/__fallback.func/chunks/_/index.mjs',
                role: 'nitro-server',
                sources: ['server/index.ts'],
                stagedMapPath: mapPath,
            }],
        }));
        const sentEvents: unknown[] = [];
        const sendEvent = vi.fn(async (event: unknown) => {
            sentEvents.push(event);
        });

        await sendSentrySourcemapCanaries({
            environment: {
                EVB_SENTRY_TARGET: 'web',
                EVB_SENTRY_RELEASE: webIdentity.release,
                EVB_SENTRY_DIST: webIdentity.dist,
                EVB_SENTRY_ENVIRONMENT: webIdentity.environment,
                SENTRY_BROWSER_DSN: 'https://public@o123.ingest.de.sentry.io/42',
            },
            projectRoot: root,
            sendEvent,
        });

        expect(sentEvents[0]).toMatchObject({
            exception: {values: [{stacktrace: {frames: [{
                abs_path: 'https://evb-viewer.invalid/__fallback.func/chunks/_/index.mjs',
                filename: 'https://evb-viewer.invalid/__fallback.func/chunks/_/index.mjs',
            }]}}]},
            debug_meta: {images: [{code_file: 'https://evb-viewer.invalid/__fallback.func/chunks/_/index.mjs'}]},
        });
    });

    it('records a project-source map with no usable mappings instead of aborting later canaries', async () => {
        const root = await setup();
        const manifestPath = getPrivateSourcemapManifestPath({
            projectRoot: root,
            identity,
        });
        const stageRoot = path.dirname(manifestPath);
        await writeFile(path.join(stageRoot, 'maps/dist-electron/empty.js.map'), JSON.stringify({
            version: 3,
            file: 'empty.js',
            sources: ['../../electron/empty.ts'],
            names: [],
            mappings: '',
            debug_id: '87654321-4321-6789-abcd-987654321abc',
        }));
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {bundles: Array<Record<string, unknown>>};
        manifest.bundles.unshift({
            bundle: 'dist-electron/empty.js',
            role: 'electron-main',
            sources: ['electron/empty.ts'],
            stagedMapPath: 'maps/dist-electron/empty.js.map',
        });
        await writeFile(manifestPath, JSON.stringify(manifest));
        const sendEvent = vi.fn();

        const receipt = await sendSentrySourcemapCanaries({
            environment: environment(),
            projectRoot: root,
            sendEvent,
        });

        expect(sendEvent).toHaveBeenCalledOnce();
        expect(receipt.skippedBundles).toEqual([{
            bundle: 'dist-electron/empty.js',
            reason: 'no-project-mapping',
            role: 'electron-main',
        }]);
    });

    it('rejects production without the explicit one-run override', async () => {
        const root = await setup();
        await expect(sendSentrySourcemapCanaries({
            environment: environment({EVB_SENTRY_ENVIRONMENT: 'production'}),
            projectRoot: root,
            sendEvent: vi.fn(),
        })).rejects.toThrow('explicit one-run override');
    });

    it('rejects a source-map path outside the private stage', async () => {
        const root = await setup();
        const manifestPath = getPrivateSourcemapManifestPath({
            projectRoot: root,
            identity,
        });
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {bundles: Array<{stagedMapPath: string}>};
        manifest.bundles[0]!.stagedMapPath = '../../outside.map';
        await writeFile(manifestPath, JSON.stringify(manifest));

        await expect(sendSentrySourcemapCanaries({
            environment: environment(),
            projectRoot: root,
            sendEvent: vi.fn(),
        })).rejects.toThrow('escapes the private source-map stage');
    });
});
