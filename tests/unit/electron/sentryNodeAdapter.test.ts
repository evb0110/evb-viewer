import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    createTransport,
    type Transport,
} from '@sentry/core';
import {
    mkdtempSync,
    mkdirSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {requireDiagnosticRecord} from '@contracts/diagnostics/diagnosticRecord';
import {
    createSentryNodeDiagnosticsTransport,
    createSentryNodeDiagnosticsTransportFromEnvironment,
} from '@electron/features/diagnostics/sentryNodeAdapter';

const RECORD = requireDiagnosticRecord({
    schemaVersion: 1,
    eventId: '0123456789abcdef0123456789abcdef',
    code: 'MAIN_STARTUP_CRASH',
    severity: 'fatal',
    runtime: 'electron-main',
    operation: 'startup-crash',
    occurredAt: 1_735_689_600_000,
    frames: [{
        module: 'electron/main.ts',
        function: 'start',
        line: 42,
        column: 7,
    }],
    context: {},
});

function setup(
    resolveFilenameDebugIds?: () => Readonly<Record<string, string>>,
    statusCode: number | null = 200,
) {
    const envelopes: unknown[] = [];
    const send = vi.fn((envelope: unknown) => {
        envelopes.push(envelope);
        return Promise.resolve(statusCode === null ? {} : {statusCode});
    });
    const flush = vi.fn(() => Promise.resolve(true));
    const makeTransport = vi.fn(() => ({
        send,
        flush,
    } as Transport));
    const adapter = createSentryNodeDiagnosticsTransport({
        dsn: 'https://publickey@o123.ingest.de.sentry.io/456',
        identity: {
            target: 'desktop',
            release: 'evb-viewer-desktop@0.1.449',
            dist: 'macos-arm64',
            environment: 'test',
        },
        appVersion: '0.1.449',
        platform: 'darwin',
        architecture: 'arm64',
        runtimeVersions: {
            electron: '39.2.6',
            chrome: '142.0.7444.175',
            node: '22.21.1',
        },
        makeTransport,
        ...(resolveFilenameDebugIds === undefined ? {} : {resolveFilenameDebugIds}),
    });
    return {
        adapter,
        envelopes,
        send,
        flush,
        makeTransport,
    };
}

describe('Sentry Node diagnostics adapter', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('creates no process hooks, queue, or initialization envelope', () => {
        const beforeListeners = process.listeners('beforeExit');
        const uncaughtListeners = process.listeners('uncaughtException');
        const setupResult = setup();

        expect(setupResult.envelopes).toEqual([]);
        expect(setupResult.flush).not.toHaveBeenCalled();
        expect(process.listeners('beforeExit')).toEqual(beforeListeners);
        expect(process.listeners('uncaughtException')).toEqual(uncaughtListeners);
    });

    it('sends exactly one closed event item without forbidden input', async () => {
        const {
            adapter,
            envelopes,
        } = setup();
        const value = await adapter.send?.(RECORD, 3);

        expect(value).toBe(true);
        expect(envelopes).toHaveLength(1);
        const serialized = JSON.stringify(envelopes[0]);
        expect(serialized).toContain('evb-diagnostic-v1');
        expect(serialized).toContain('MainStartupCrash');
        expect(serialized).toContain('electron/main.ts');
        expect(serialized).toContain('"suppressedCount":3');
        expect(serialized).not.toContain('client_report');
        expect(serialized).not.toContain('secret-document.pdf');
        const envelope = envelopes[0] as [unknown, unknown[]];
        expect(envelope[1]).toHaveLength(1);
        expect((envelope[1][0] as [{type: string}, unknown])[0]).toEqual({type: 'event'});
    });

    it('does not accept a transport result without an explicit numeric status', async () => {
        const {adapter} = setup(undefined, null);

        await expect(adapter.send?.(RECORD)).resolves.toBe(false);
    });

    it('keeps the pinned core backoff and buffer drops out of accepted delivery', async () => {
        const audit = vi.fn();
        const requests: unknown[] = [];
        const responses: Array<(value: {
            statusCode: number;
            headers: {
                'x-sentry-rate-limits': string | null;
                'retry-after': string | null
            };
        }) => void> = [];
        const adapter = createSentryNodeDiagnosticsTransport({
            dsn: 'https://publickey@o123.ingest.de.sentry.io/456',
            identity: {
                target: 'desktop',
                release: 'evb-viewer-desktop@0.1.449',
                dist: 'macos-arm64',
                environment: 'test',
            },
            appVersion: '0.1.449',
            platform: 'darwin',
            architecture: 'arm64',
            audit,
            makeTransport: options => createTransport(
                {
                    ...options,
                    bufferSize: 16,
                },
                request => {
                    requests.push(request);
                    return new Promise(resolve => responses.push(resolve));
                },
            ),
        });

        const first = adapter.send?.(RECORD);
        expect(requests).toHaveLength(1);
        responses.shift()?.({
            statusCode: 200,
            headers: {
                'x-sentry-rate-limits': '60::error',
                'retry-after': null,
            },
        });
        await expect(first).resolves.toBe(true);

        const backoffRecord = requireDiagnosticRecord({
            ...RECORD,
            eventId: `${RECORD.eventId.slice(0, -2)}01`,
        });
        await Promise.resolve();
        const second = adapter.send?.(backoffRecord);
        await expect(second).resolves.toBe(false);
        expect(requests).toHaveLength(1);

        const pendingResponses: Array<(value: {statusCode: number}) => void> = [];
        const overflowAudit = vi.fn();
        const overflowAdapter = createSentryNodeDiagnosticsTransport({
            dsn: 'https://publickey@o123.ingest.de.sentry.io/456',
            identity: {
                target: 'desktop',
                release: 'evb-viewer-desktop@0.1.449',
                dist: 'macos-arm64',
                environment: 'test',
            },
            appVersion: '0.1.449',
            platform: 'darwin',
            architecture: 'arm64',
            audit: overflowAudit,
            makeTransport: options => createTransport(
                {
                    ...options,
                    bufferSize: 16,
                },
                () => new Promise(resolve => pendingResponses.push(resolve)),
            ),
        });
        const sends = Array.from({length: 17}, (_, index) => overflowAdapter.send?.(
            requireDiagnosticRecord({
                ...RECORD,
                eventId: `${RECORD.eventId.slice(0, -2)}${index.toString(16).padStart(2, '0')}`,
            }),
        ));

        expect(pendingResponses).toHaveLength(16);
        await expect(sends[16]).resolves.toBe(false);
        for (const resolve of pendingResponses) {
            resolve({statusCode: 200});
        }
        await expect(Promise.all(sends.slice(0, 16))).resolves.toEqual(
            Array.from({length: 16}, () => true),
        );
        expect(overflowAudit.mock.calls.filter(([entry]) => entry.phase === 'accepted'))
            .toHaveLength(16);
        expect(overflowAudit.mock.calls
            .filter(([entry]) => entry.phase === 'accepted')
            .map(([entry]) => entry.eventId))
            .not.toContain(`${RECORD.eventId.slice(0, -2)}10`);
    });

    it('emits content-free attempted and accepted audit records', async () => {
        const audit = vi.fn();
        const send = vi.fn(() => Promise.resolve({statusCode: 200}));
        const adapter = createSentryNodeDiagnosticsTransport({
            dsn: 'https://publickey@o123.ingest.de.sentry.io/456',
            identity: {
                target: 'desktop',
                release: 'evb-viewer-desktop@0.1.449',
                dist: 'macos-arm64',
                environment: 'test',
            },
            appVersion: '0.1.449',
            platform: 'darwin',
            architecture: 'arm64',
            audit,
            makeTransport: () => ({
                send,
                flush: () => Promise.resolve(true),
            } as Transport),
        });

        await expect(adapter.send?.(RECORD)).resolves.toBe(true);
        expect(audit).toHaveBeenCalledTimes(2);
        expect(audit.mock.calls.map(([entry]) => entry)).toEqual([
            expect.objectContaining({
                eventId: RECORD.eventId,
                itemType: 'event',
                phase: 'attempted',
            }),
            expect.objectContaining({
                eventId: RECORD.eventId,
                itemType: 'event',
                phase: 'accepted',
            }),
        ]);
        expect(JSON.stringify(audit.mock.calls)).not.toContain('secret-document.pdf');
    });

    it('attaches only validated Debug IDs for packaged application bundles', async () => {
        const packagedRecord = requireDiagnosticRecord({
            ...RECORD,
            frames: [{
                module: 'dist-electron/main.js',
                function: 'start',
                line: 42,
                column: 7,
            }],
        });
        const {
            adapter,
            envelopes,
        } = setup(() => ({
            'file:///Applications/EVB Viewer.app/Contents/Resources/app.asar/dist-electron/main.js':
                '12345678-1234-5678-9abc-123456789abc',
            'file:///Applications/EVB Viewer.app/Contents/Resources/app.asar/electron/private.ts':
                'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        }));

        await expect(adapter.send?.(packagedRecord)).resolves.toBe(true);
        const serialized = JSON.stringify(envelopes[0]);
        expect(serialized).toContain('"debug_meta":{"images":[{"type":"sourcemap","code_file":"dist-electron/main.js","debug_id":"12345678-1234-5678-9abc-123456789abc"}]}');
        expect(serialized).not.toContain('electron/private.ts');
        expect(serialized).not.toContain('/Applications/');
    });

    it('reads renderer chunk Debug IDs from the packaged static root', async () => {
        const staticRoot = mkdtempSync(join(tmpdir(), 'evb-sentry-static-'));
        mkdirSync(join(staticRoot, '_nuxt'));
        writeFileSync(
            join(staticRoot, '_nuxt', 'J6PDf5cZ.js'),
            'export{};\n//# sourceMappingURL=J6PDf5cZ.js.map\n//# debugId=9e0bfb94-c767-5157-a0ee-36646f10a0c7\n',
        );
        writeFileSync(join(staticRoot, '_nuxt', 'plain.js'), 'export{};\n');
        try {
            const rendererRecord = requireDiagnosticRecord({
                ...RECORD,
                code: 'RENDERER_STARTUP_WARMUP_FAILED',
                severity: 'error',
                runtime: 'electron-renderer',
                operation: 'renderer-error',
                frames: [
                    {
                        module: '_nuxt/J6PDf5cZ.js',
                        function: 'V',
                        line: 3,
                        column: 4_287,
                    },
                    {
                        module: '_nuxt/plain.js',
                        line: 1,
                    },
                ],
            });
            const envelopes: unknown[] = [];
            const adapter = createSentryNodeDiagnosticsTransport({
                dsn: 'https://publickey@o123.ingest.de.sentry.io/456',
                identity: {
                    target: 'desktop',
                    release: 'evb-viewer-desktop@0.1.449',
                    dist: 'macos-arm64',
                    environment: 'test',
                },
                appVersion: '0.1.449',
                makeTransport: () => ({
                    send: (envelope: unknown) => {
                        envelopes.push(envelope);
                        return Promise.resolve({statusCode: 200});
                    },
                    flush: () => Promise.resolve(true),
                } as Transport),
                rendererStaticRoot: staticRoot,
            });

            await expect(adapter.send?.(rendererRecord)).resolves.toBe(true);
            const serialized = JSON.stringify(envelopes[0]);
            expect(serialized).toContain('"debug_meta":{"images":[{"type":"sourcemap","code_file":"_nuxt/J6PDf5cZ.js","debug_id":"9e0bfb94-c767-5157-a0ee-36646f10a0c7"}]}');
            expect(serialized).not.toContain(staticRoot);
        } finally {
            rmSync(staticRoot, {
                recursive: true,
                force: true,
            });
        }
    });

    it('fails closed for non-EU, secret-bearing, and malformed DSNs', () => {
        for (const dsn of [
            'https://publickey@o123.ingest.us.sentry.io/456',
            'https://publickey:secret@o123.ingest.de.sentry.io/456',
            'not-a-dsn',
        ]) {
            expect(() => createSentryNodeDiagnosticsTransport({
                dsn,
                identity: {
                    target: 'desktop',
                    release: 'evb-viewer-desktop@0.1.449',
                    dist: 'macos-arm64',
                    environment: 'test',
                },
                appVersion: '0.1.449',
            })).toThrow();
        }
    });

    it('keeps desktop DSN and release environment reads inside the adapter root', async () => {
        vi.stubEnv('SENTRY_DESKTOP_DSN', 'https://publickey@o123.ingest.de.sentry.io/456');
        vi.stubEnv('EVB_SENTRY_RELEASE', 'evb-viewer-desktop@0.1.449');
        vi.stubEnv('EVB_SENTRY_DIST', 'macos-arm64');
        vi.stubEnv('EVB_SENTRY_ENVIRONMENT', 'test');
        const send = vi.fn(() => Promise.resolve({statusCode: 200}));
        const adapter = createSentryNodeDiagnosticsTransportFromEnvironment({
            appVersion: '0.1.449',
            platform: 'darwin',
            architecture: 'arm64',
            makeTransport: () => ({
                send,
                flush: () => Promise.resolve(true),
            } as Transport),
        });

        await expect(adapter.send?.(RECORD)).resolves.toBe(true);
        expect(send).toHaveBeenCalledOnce();
    });

    it('rejects malformed records before transport', () => {
        const {
            adapter,
            send,
        } = setup();
        expect(adapter.send?.({
            ...RECORD,
            request: {url: 'secret'},
        } as never)).toBe(false);
        expect(send).not.toHaveBeenCalled();
    });
});
