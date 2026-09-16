import {execFileSync} from 'node:child_process';
import {
    mkdir,
    mkdtemp,
    readFile,
    rm,
    writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {getErrorMessage} from '@contracts/getErrorMessage.ts';
import {DIAGNOSTIC_EVENT_DEFINITIONS} from '@contracts/diagnostics/diagnosticCodes';
import {getCanaryEventId} from '@scripts/release/send-sentry-sourcemap-canaries.mjs';
import {verifySentrySourcemapCanaries} from '@scripts/release/verify-sentry-sourcemap-canaries.mjs';
import {getPrivateSourcemapManifestPath} from '@scripts/release/stage-private-sourcemaps.mjs';

const roots: string[] = [];
const sourceMapCanary = DIAGNOSTIC_EVENT_DEFINITIONS.SENTRY_SOURCE_MAP_CANARY;
const identity = {
    target: 'web',
    release: 'evb-viewer-web@1.2.3',
    dist: 'preview-fixture',
    environment: 'preview',
} as const;
const evidence = {
    bundle: '.vercel/output/static/_nuxt/example.js',
    codeFile: 'https://evb-viewer.invalid/_nuxt/example.js',
    debugId: '12345678-1234-5678-9abc-123456789abc',
    eventId: getCanaryEventId(identity, '.vercel/output/static/_nuxt/example.js'),
    expectedFunction: 'start',
    expectedLine: 1,
    expectedSource: 'app/example.ts',
    role: 'browser-renderer',
};
interface IFixtureReceipt {
    events: Array<Record<string, unknown>>;
    skippedBundles: Array<Record<string, unknown>>;
    [key: string]: unknown;
}

async function setupReceipt() {
    const root = await mkdtemp(path.join(tmpdir(), 'evb-sentry-verify-'));
    roots.push(root);
    const stageRoot = path.dirname(getPrivateSourcemapManifestPath({
        projectRoot: root,
        identity,
    }));
    const stagedMapPath = 'maps/.vercel/output/static/_nuxt/example.js.map';
    await mkdir(path.join(stageRoot, path.dirname(stagedMapPath)), {recursive: true});
    await writeFile(path.join(stageRoot, stagedMapPath), `${JSON.stringify({
        debug_id: evidence.debugId,
        file: 'example.js',
        mappings: 'AAAAA',
        names: ['start'],
        sources: ['../../../../app/example.ts'],
        version: 3,
    })}\n`);
    await writeFile(path.join(stageRoot, 'manifest.json'), `${JSON.stringify({
        bundles: [{
            bundle: evidence.bundle,
            role: evidence.role,
            sources: [evidence.expectedSource],
            stagedMapPath,
        }],
        identity,
        schemaVersion: 1,
    })}\n`);
    await mkdir(stageRoot, {recursive: true});
    await writeFile(path.join(stageRoot, 'canary-receipt.json'), `${JSON.stringify({
        events: [evidence],
        identity,
        schemaVersion: 2,
        skippedBundles: [],
    })}\n`);
    return root;
}

async function rewriteReceipt(
    root: string,
    mutate: (receipt: IFixtureReceipt, stageRoot: string) => void | Promise<void>,
) {
    const stageRoot = path.dirname(getPrivateSourcemapManifestPath({
        projectRoot: root,
        identity,
    }));
    const receiptPath = path.join(stageRoot, 'canary-receipt.json');
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as IFixtureReceipt;
    await mutate(receipt, stageRoot);
    await writeFile(receiptPath, `${JSON.stringify(receipt)}\n`);
}

function environment() {
    return {
        EVB_SENTRY_TARGET: identity.target,
        EVB_SENTRY_RELEASE: identity.release,
        EVB_SENTRY_DIST: identity.dist,
        EVB_SENTRY_ENVIRONMENT: identity.environment,
        SENTRY_VERIFICATION_TOKEN: 'private-verification-token',
        SENTRY_ORG: 'private-organization',
        SENTRY_WEB_PROJECT: 'private-web-project',
    };
}

function debugPayload(overrides: Record<string, unknown> = {}) {
    return {
        dist: identity.dist,
        exceptions: [{frames: [{
            debug_id_process: {
                debug_id: evidence.debugId,
                uploaded_source_file_with_correct_debug_id: true,
                uploaded_source_map_with_correct_debug_id: true,
            },
            release_process: {
                abs_path: evidence.codeFile,
                matching_source_file_names: ['~/_nuxt/example.js'],
                matching_source_map_name: '~/_nuxt/example.js.map',
                source_file_lookup_result: 'found',
                source_map_lookup_result: 'found',
            },
        }]}],
        release: identity.release,
        ...overrides,
    };
}

function eventPayload({
    context = [[
        1,
        'throw new Error("fixture");',
    ]],
    ...overrides
}: {context?: unknown[] | null} & Record<string, unknown> = {}) {
    return {
        dist: identity.dist,
        entries: [{
            data: {values: [{stacktrace: {frames: [{
                absPath: evidence.expectedSource,
                context,
                filename: evidence.expectedSource,
                function: 'evbViewerSourceMapCanary',
                inApp: true,
                lineNo: evidence.expectedLine,
            }]}}]},
            type: 'exception',
        }],
        environment: null,
        eventID: evidence.eventId,
        logger: null,
        release: {version: identity.release},
        tags: [
            {
                key: sourceMapCanary.tagKey,
                value: sourceMapCanary.tagValue,
            },
            {
                key: 'bundle_role',
                value: evidence.role,
            },
            {
                key: 'environment',
                value: identity.environment,
            },
            {
                key: 'logger',
                value: sourceMapCanary.logger,
            },
        ],
        ...overrides,
    };
}

function runtimeEventPayload(overrides: Record<string, unknown> = {}) {
    return {
        dist: identity.dist,
        entries: [{
            data: {values: [{stacktrace: {frames: [{
                absPath: 'app/plugins/rendererErrorGuard.client.ts',
                context: [[
                    42,
                    'const receipt = captureFailure();',
                ]],
                filename: 'app/plugins/rendererErrorGuard.client.ts',
                function: 'captureFailure',
                inApp: true,
                lineNo: 42,
            }]}}]},
            type: 'exception',
        }],
        environment: identity.environment,
        eventID: 'abcdefabcdefabcdefabcdefabcdefab',
        logger: 'evb-viewer.diagnostics',
        release: {version: identity.release},
        tags: [
            {
                key: 'evb_schema',
                value: 'evb-diagnostic-v1',
            },
            {
                key: 'evb_probe',
                value: 'packaged-smoke',
            },
            {
                key: 'diagnostic_runtime',
                value: 'electron-renderer',
            },
        ],
        ...overrides,
    };
}

afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, {
        force: true,
        recursive: true,
    })));
});

describe('verifySentrySourcemapCanaries', () => {
    it('normalizes Error and non-Error values for release diagnostics', () => {
        expect(getErrorMessage(new Error('fixture error'))).toBe('fixture error');
        expect(getErrorMessage('fixture value')).toBe('fixture value');
    });

    it('loads as a standalone Node release script', () => {
        const output = execFileSync(
            process.execPath,
            [
                '--input-type=module',
                '-e',
                'await import(process.argv[1]); process.stdout.write("loaded")',
                pathToFileURL(path.resolve(
                    process.cwd(),
                    'scripts/release/verify-sentry-sourcemap-canaries.mjs',
                )).href,
            ],
            {encoding: 'utf8'},
        );

        expect(output).toBe('loaded');
    });

    it('verifies a processed runtime renderer event instead of requiring a canary receipt', async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'evb-sentry-runtime-verify-'));
        roots.push(root);
        const fetchImpl = vi.fn(async () => new Response(
            JSON.stringify(runtimeEventPayload()),
            {
                headers: {'content-type': 'application/json'},
                status: 200,
            },
        ));

        await expect(verifySentrySourcemapCanaries({
            environment: {
                ...environment(),
                EVB_SENTRY_RUNTIME_EVENT_ID: 'abcdefabcdefabcdefabcdefabcdefab',
            },
            fetchImpl,
            projectRoot: root,
            sleep: vi.fn(async () => undefined),
        })).resolves.toMatchObject({
            eventId: 'abcdefabcdefabcdefabcdefabcdefab',
            status: 'verified',
        });
        expect(fetchImpl).toHaveBeenCalledOnce();
        const receiptText = await readFile(path.join(
            path.dirname(getPrivateSourcemapManifestPath({
                projectRoot: root,
                identity,
            })),
            'runtime-event-verification-receipt.json',
        ), 'utf8');
        expect(receiptText).toContain('verified');
        expect(receiptText).not.toContain('private-verification-token');
    });

    it('verifies source-map lookup and processed source context for every event', async () => {
        const root = await setupReceipt();
        const fetchImpl = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => new Response(
            JSON.stringify(String(url).includes('/source-map-debug/')
                ? debugPayload()
                : eventPayload()),
            {
                headers: {'content-type': 'application/json'},
                status: 200,
            },
        ));

        const result = await verifySentrySourcemapCanaries({
            environment: environment(),
            fetchImpl,
            projectRoot: root,
            sleep: vi.fn(async () => undefined),
        });

        expect(result).toMatchObject({
            failureCount: 0,
            verifiedCount: 1,
        });
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({headers: {authorization: 'Bearer private-verification-token'}});
        const receiptText = await readFile(path.join(
            path.dirname(getPrivateSourcemapManifestPath({
                projectRoot: root,
                identity,
            })),
            'canary-verification-receipt.json',
        ), 'utf8');
        expect(receiptText).not.toContain('private-verification-token');
        expect(receiptText).not.toContain('private-organization');
        expect(receiptText).toContain('verified');
    });

    it('waits for processing before accepting a canary', async () => {
        const root = await setupReceipt();
        const responses = [
            debugPayload({exceptions: [{frames: [{release_process: {
                abs_path: evidence.codeFile,
                matching_source_file_names: [],
                source_file_lookup_result: 'missing',
                source_map_lookup_result: 'missing',
            }}]}]}),
            debugPayload(),
            eventPayload({context: null}),
            debugPayload(),
            eventPayload(),
        ];
        const fetchImpl = vi.fn(async () => new Response(
            JSON.stringify(responses.shift()),
            {
                headers: {'content-type': 'application/json'},
                status: 200,
            },
        ));
        const sleep = vi.fn(async () => undefined);

        await expect(verifySentrySourcemapCanaries({
            environment: environment(),
            fetchImpl,
            projectRoot: root,
            sleep,
        })).resolves.toMatchObject({verifiedCount: 1});
        expect(fetchImpl).toHaveBeenCalledTimes(5);
        expect(sleep).toHaveBeenNthCalledWith(1, 1_000);
        expect(sleep).toHaveBeenNthCalledWith(2, 2_000);
    });

    it('uses processed-event symbolication when release-path lookup is incomplete', async () => {
        const root = await setupReceipt();
        const debugIdProcess = debugPayload().exceptions[0]!.frames[0]!.debug_id_process;
        const fetchImpl = vi.fn(async (url: RequestInfo | URL) => new Response(
            JSON.stringify(String(url).includes('/source-map-debug/')
                ? debugPayload({exceptions: [{frames: [{
                    debug_id_process: debugIdProcess,
                    release_process: {
                        abs_path: evidence.codeFile,
                        matching_source_file_names: [evidence.codeFile],
                        matching_source_map_name: null,
                        source_file_lookup_result: 'unsuccessful',
                        source_map_lookup_result: 'unsuccessful',
                    },
                }]}]})
                : eventPayload()),
            {
                headers: {'content-type': 'application/json'},
                status: 200,
            },
        ));

        await expect(verifySentrySourcemapCanaries({
            environment: environment(),
            fetchImpl,
            projectRoot: root,
            sleep: vi.fn(async () => undefined),
        })).resolves.toMatchObject({
            failureCount: 0,
            verifiedCount: 1,
        });
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('rejects terminal event identity mismatches without retrying', async () => {
        const cases = [
            {
                payload: eventPayload({release: {version: 'evb-viewer-web@other'}}),
                reason: 'event release or distribution mismatch',
            },
            {
                payload: eventPayload({environment: 'other'}),
                reason: 'event environment does not match the canary receipt',
            },
            {
                payload: eventPayload({logger: 'other.logger'}),
                reason: 'event is not the expected source-map canary',
            },
            {
                payload: eventPayload({
                    environment: identity.environment,
                    logger: sourceMapCanary.logger,
                    tags: [{
                        key: sourceMapCanary.tagKey,
                        value: 'other',
                    }],
                }),
                reason: 'event is not the expected source-map canary',
            },
        ];

        for (const {
            payload,
            reason,
        } of cases) {
            const root = await setupReceipt();
            const fetchImpl = vi.fn(async (url: RequestInfo | URL) => new Response(
                JSON.stringify(String(url).includes('/source-map-debug/')
                    ? debugPayload()
                    : payload),
                {
                    headers: {'content-type': 'application/json'},
                    status: 200,
                },
            ));
            const sleep = vi.fn(async () => undefined);

            await expect(verifySentrySourcemapCanaries({
                environment: environment(),
                fetchImpl,
                projectRoot: root,
                sleep,
            })).rejects.toThrow(reason);
            expect(fetchImpl).toHaveBeenCalledTimes(2);
            expect(sleep).not.toHaveBeenCalled();
        }
    });

    it('rejects receipts that do not cover the staged manifest', async () => {
        const cases: Array<{
            mutate: (receipt: IFixtureReceipt, stageRoot: string) => void | Promise<void>;
            reason: string;
        }> = [
            {
                mutate: receipt => {
                    receipt.events[0]!.bundle = 'unknown.js';
                },
                reason: 'contains an unknown bundle',
            },
            {
                mutate: receipt => {
                    receipt.events[0]!.eventId = 'a'.repeat(32);
                },
                reason: 'does not match the build manifest',
            },
            {
                mutate: async (_receipt, stageRoot) => {
                    const mapPath = path.join(stageRoot, 'maps/.vercel/output/static/_nuxt/example.js.map');
                    const map = JSON.parse(await readFile(mapPath, 'utf8')) as Record<string, unknown>;
                    map.debug_id = 'abcdefab-cdef-abcd-efab-cdefabcdefab';
                    await writeFile(mapPath, `${JSON.stringify(map)}\n`);
                },
                reason: 'does not match the staged source map',
            },
            {
                mutate: receipt => {
                    receipt.events = [];
                    receipt.skippedBundles = [{
                        bundle: evidence.bundle,
                        reason: 'no-project-source',
                    }];
                },
                reason: 'misclassifies a mapped bundle',
            },
        ];

        for (const {
            mutate,
            reason,
        } of cases) {
            const root = await setupReceipt();
            await rewriteReceipt(root, mutate);
            const fetchImpl = vi.fn();

            await expect(verifySentrySourcemapCanaries({
                environment: environment(),
                fetchImpl,
                projectRoot: root,
                sleep: vi.fn(async () => undefined),
            })).rejects.toThrow(reason);
            expect(fetchImpl).not.toHaveBeenCalled();
        }
    });

    it('writes a sanitized failure receipt and rejects unresolved symbolication', async () => {
        const root = await setupReceipt();
        const unresolvedDebugPayload = debugPayload({exceptions: [{frames: [{
            debug_id_process: {
                debug_id: evidence.debugId,
                uploaded_source_file_with_correct_debug_id: true,
                uploaded_source_map_with_correct_debug_id: true,
            },
            release_process: {
                abs_path: evidence.codeFile,
                matching_source_file_names: ['~/_nuxt/example.js'],
                matching_source_map_name: null,
                source_file_lookup_result: 'unsuccessful',
                source_map_lookup_result: 'unsuccessful',
            },
        }]}]});
        const fetchImpl = vi.fn(async (url: RequestInfo | URL) => new Response(
            JSON.stringify(String(url).includes('/source-map-debug/')
                ? unresolvedDebugPayload
                : eventPayload({context: null})),
            {
                headers: {'content-type': 'application/json'},
                status: 200,
            },
        ));

        await expect(verifySentrySourcemapCanaries({
            environment: environment(),
            fetchImpl,
            projectRoot: root,
            sleep: vi.fn(async () => undefined),
        })).rejects.toThrow('failed for 1 of 1');
        const receiptText = await readFile(path.join(
            path.dirname(getPrivateSourcemapManifestPath({
                projectRoot: root,
                identity,
            })),
            'canary-verification-receipt.json',
        ), 'utf8');
        expect(receiptText).toContain('symbolicated frame has no source context');
        expect(receiptText).not.toContain('private-verification-token');
    });
});
