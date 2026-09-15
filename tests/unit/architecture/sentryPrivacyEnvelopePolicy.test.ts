import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type {Transport as BrowserTransport} from '@sentry/core/browser';
import type {Transport as NodeTransport} from '@sentry/core';
import {createBrowserDiagnosticsTransport} from '@app/utils/browserDiagnosticsTransport';
import {createSentryNodeDiagnosticsTransport} from '@electron/features/diagnostics/sentryNodeAdapter';
import {
    buildSentryEvent,
    createSentryNitroAdapter,
    type TSentryNitroClientFactory,
} from '@server/utils/sentryNitroAdapter';
import {parseDiagnosticEventId} from '@contracts/diagnostics/diagnosticEventId';
import {DIAGNOSTIC_EVENT_DEFINITIONS} from '@contracts/diagnostics/diagnosticCodes';
import {
    requireDiagnosticRecord,
    type DiagnosticRecord,
} from '@contracts/diagnostics/diagnosticRecord';
import type {SentryBuildIdentity} from '@contracts/diagnostics/releaseIdentity.js';

const DESKTOP_IDENTITY: SentryBuildIdentity = {
    target: 'desktop',
    release: 'evb-viewer-desktop@0.1.449',
    dist: 'macos-arm64',
    environment: 'test',
};

const BROWSER_IDENTITY: SentryBuildIdentity = {
    target: 'web',
    release: 'evb-viewer-web@privacy-envelope-test',
    dist: 'production',
    environment: 'production',
};

const NITRO_IDENTITY: SentryBuildIdentity = {
    target: 'web',
    release: 'evb-viewer-web@privacy-envelope-test',
    dist: 'production',
    environment: 'production',
};

const NITRO_POLICY = {
    enabled: true,
    legitimateInterestsApproved: true,
    legalNoticePublished: true,
    dpaExecuted: true,
    accountHardened: true,
    retentionReady: true,
    objectionReady: true,
} as const;

const NITRO_RUNTIME_CONFIG = {sentry: {
    nitroDsn: 'https://public@o123.ingest.de.sentry.io/42',
    release: NITRO_IDENTITY.release,
    dist: NITRO_IDENTITY.dist,
    environment: NITRO_IDENTITY.environment,
    policy: NITRO_POLICY,
}} as const;

const NITRO_BUILD_CONFIGURATION = {
    dsn: NITRO_RUNTIME_CONFIG.sentry.nitroDsn,
    identity: NITRO_IDENTITY,
    policy: NITRO_POLICY,
} as const;

const FORBIDDEN_SENTINELS = Object.freeze({
    rawErrorText: 'SEN-GATE-03-raw-error-text',
    rawStack: 'SEN-GATE-03-raw-stack',
    consoleArgs: 'SEN-GATE-03-console-args',
    uiCopy: 'SEN-GATE-03-ui-copy',
    localFilePath: 'SEN-GATE-03-local-file-path',
    url: 'SEN-GATE-03-private-url',
    query: 'SEN-GATE-03-private-query',
    documentText: 'SEN-GATE-03-document-text',
    ocrText: 'SEN-GATE-03-ocr-text',
    annotationText: 'SEN-GATE-03-annotation-text',
    aiText: 'SEN-GATE-03-ai-text',
    request: 'SEN-GATE-03-request',
    headers: 'SEN-GATE-03-headers',
    cookies: 'SEN-GATE-03-cookies',
    body: 'SEN-GATE-03-body',
    ip: 'SEN-GATE-03-ip',
    user: 'SEN-GATE-03-user',
    email: 'SEN-GATE-03-email',
    account: 'SEN-GATE-03-account',
    device: 'SEN-GATE-03-device',
    breadcrumbs: 'SEN-GATE-03-breadcrumbs',
    attachments: 'SEN-GATE-03-attachments',
    minidumps: 'SEN-GATE-03-minidumps',
    replay: 'SEN-GATE-03-replay',
    spans: 'SEN-GATE-03-spans',
    profiles: 'SEN-GATE-03-profiles',
    metrics: 'SEN-GATE-03-metrics',
    logs: 'SEN-GATE-03-logs',
    sessions: 'SEN-GATE-03-sessions',
    clientReport: 'SEN-GATE-03-client-report',
});

const FORBIDDEN_EVENT_KEYS = [
    'message',
    'transaction',
    'request',
    'user',
    'breadcrumbs',
    'attachments',
    'minidump',
    'replay',
    'replay_id',
    'spans',
    'profile',
    'profile_id',
    'metrics',
    'logs',
    'logentry',
    'sessions',
    'session',
    'client_report',
] as const;

const ALLOWED_EVENT_KEYS = new Set([
    'event_id',
    'timestamp',
    'level',
    'platform',
    'logger',
    'release',
    'dist',
    'environment',
    'fingerprint',
    'exception',
    'tags',
    'contexts',
    'debug_meta',
    'extra',
]);

const NITRO_RECORD_MARKER = '__evb_diagnostic_record';
const SOURCE_MAP_CANARY = DIAGNOSTIC_EVENT_DEFINITIONS.SENTRY_SOURCE_MAP_CANARY;

function createRecord(runtime: DiagnosticRecord['runtime'], eventId: string): DiagnosticRecord {
    const code = runtime === 'electron-main'
        ? 'MAIN_STARTUP_CRASH'
        : runtime === 'viewer-nitro'
            ? 'UNCLASSIFIED_MAIN_ERROR'
            : 'UNCLASSIFIED_CONSOLE_ERROR';
    const context = code === 'MAIN_STARTUP_CRASH'
        ? {}
        : {phase: 'operation'};
    return requireDiagnosticRecord({
        schemaVersion: 1,
        eventId: parseDiagnosticEventId(eventId),
        code,
        severity: code === 'MAIN_STARTUP_CRASH' ? 'fatal' : 'error',
        runtime,
        operation: code === 'MAIN_STARTUP_CRASH' ? 'startup-crash' : 'console-error',
        occurredAt: 1_735_689_600_000,
        frames: [{
            module: runtime === 'viewer-nitro'
                ? 'server/api/diagnostics.ts'
                : runtime === 'electron-main'
                    ? 'electron/main.ts'
                    : 'app/utils/consoleErrorObserver.ts',
            function: 'reportFailure',
            line: 42,
            column: 7,
        }],
        context,
    });
}

function createPollutedRecord(record: DiagnosticRecord) {
    return {
        ...record,
        rawErrorText: FORBIDDEN_SENTINELS.rawErrorText,
        stack: FORBIDDEN_SENTINELS.rawStack,
        cause: FORBIDDEN_SENTINELS.rawStack,
        consoleArgs: FORBIDDEN_SENTINELS.consoleArgs,
        uiCopy: FORBIDDEN_SENTINELS.uiCopy,
        localPath: FORBIDDEN_SENTINELS.localFilePath,
        url: FORBIDDEN_SENTINELS.url,
        query: FORBIDDEN_SENTINELS.query,
        documentText: FORBIDDEN_SENTINELS.documentText,
        ocrText: FORBIDDEN_SENTINELS.ocrText,
        annotationText: FORBIDDEN_SENTINELS.annotationText,
        aiText: FORBIDDEN_SENTINELS.aiText,
        request: {
            url: FORBIDDEN_SENTINELS.url,
            query: FORBIDDEN_SENTINELS.query,
            headers: FORBIDDEN_SENTINELS.headers,
            cookies: FORBIDDEN_SENTINELS.cookies,
            body: FORBIDDEN_SENTINELS.body,
            ip: FORBIDDEN_SENTINELS.ip,
        },
        user: {
            id: FORBIDDEN_SENTINELS.user,
            email: FORBIDDEN_SENTINELS.email,
            account: FORBIDDEN_SENTINELS.account,
            device: FORBIDDEN_SENTINELS.device,
        },
        breadcrumbs: FORBIDDEN_SENTINELS.breadcrumbs,
        attachments: FORBIDDEN_SENTINELS.attachments,
        minidump: FORBIDDEN_SENTINELS.minidumps,
        replay: FORBIDDEN_SENTINELS.replay,
        spans: FORBIDDEN_SENTINELS.spans,
        profiles: FORBIDDEN_SENTINELS.profiles,
        metrics: FORBIDDEN_SENTINELS.metrics,
        logs: FORBIDDEN_SENTINELS.logs,
        sessions: FORBIDDEN_SENTINELS.sessions,
        client_report: FORBIDDEN_SENTINELS.clientReport,
        context: {
            ...record.context,
            leaked: FORBIDDEN_SENTINELS.documentText,
        },
    };
}

function createPollutedEvent(record: DiagnosticRecord, identity: SentryBuildIdentity) {
    const marked = buildSentryEvent(record, identity, 4) as Record<string, unknown>;
    const markedExtra = marked.extra as Record<string, unknown>;
    return {
        ...marked,
        message: FORBIDDEN_SENTINELS.rawErrorText,
        transaction: `${FORBIDDEN_SENTINELS.url}?${FORBIDDEN_SENTINELS.query}`,
        exception: {values: [{
            type: FORBIDDEN_SENTINELS.rawErrorText,
            value: FORBIDDEN_SENTINELS.rawErrorText,
            stacktrace: {frames: [{
                filename: FORBIDDEN_SENTINELS.rawStack,
                function: FORBIDDEN_SENTINELS.rawStack,
                vars: FORBIDDEN_SENTINELS.documentText,
            }]},
        }]},
        request: {
            url: FORBIDDEN_SENTINELS.url,
            query_string: FORBIDDEN_SENTINELS.query,
            headers: {authorization: FORBIDDEN_SENTINELS.headers},
            cookies: FORBIDDEN_SENTINELS.cookies,
            data: FORBIDDEN_SENTINELS.body,
            client_ip: FORBIDDEN_SENTINELS.ip,
        },
        user: {
            id: FORBIDDEN_SENTINELS.user,
            email: FORBIDDEN_SENTINELS.email,
            username: FORBIDDEN_SENTINELS.account,
            ip_address: FORBIDDEN_SENTINELS.ip,
        },
        breadcrumbs: [{
            message: FORBIDDEN_SENTINELS.breadcrumbs,
            data: {args: FORBIDDEN_SENTINELS.consoleArgs},
        }],
        attachments: [{filename: FORBIDDEN_SENTINELS.attachments}],
        minidump: FORBIDDEN_SENTINELS.minidumps,
        replay: FORBIDDEN_SENTINELS.replay,
        replay_id: FORBIDDEN_SENTINELS.replay,
        spans: [{description: FORBIDDEN_SENTINELS.spans}],
        profile: {id: FORBIDDEN_SENTINELS.profiles},
        profile_id: FORBIDDEN_SENTINELS.profiles,
        metrics: {name: FORBIDDEN_SENTINELS.metrics},
        logs: [{message: FORBIDDEN_SENTINELS.logs}],
        logentry: {message: FORBIDDEN_SENTINELS.logs},
        sessions: [{id: FORBIDDEN_SENTINELS.sessions}],
        session: {id: FORBIDDEN_SENTINELS.sessions},
        client_report: {reason: FORBIDDEN_SENTINELS.clientReport},
        contexts: {
            ...(marked.contexts as Record<string, unknown>),
            device: {id: FORBIDDEN_SENTINELS.device},
            ui: {copy: FORBIDDEN_SENTINELS.uiCopy},
            document: {text: FORBIDDEN_SENTINELS.documentText},
            ocr: {text: FORBIDDEN_SENTINELS.ocrText},
            annotation: {text: FORBIDDEN_SENTINELS.annotationText},
            ai: {text: FORBIDDEN_SENTINELS.aiText},
        },
        extra: {
            ...markedExtra,
            rawErrorText: FORBIDDEN_SENTINELS.rawErrorText,
            rawStack: FORBIDDEN_SENTINELS.rawStack,
            consoleArgs: FORBIDDEN_SENTINELS.consoleArgs,
            uiCopy: FORBIDDEN_SENTINELS.uiCopy,
            localFilePath: FORBIDDEN_SENTINELS.localFilePath,
            url: FORBIDDEN_SENTINELS.url,
            query: FORBIDDEN_SENTINELS.query,
            documentText: FORBIDDEN_SENTINELS.documentText,
            ocrText: FORBIDDEN_SENTINELS.ocrText,
            annotationText: FORBIDDEN_SENTINELS.annotationText,
            aiText: FORBIDDEN_SENTINELS.aiText,
            request: FORBIDDEN_SENTINELS.request,
            headers: FORBIDDEN_SENTINELS.headers,
            cookies: FORBIDDEN_SENTINELS.cookies,
            body: FORBIDDEN_SENTINELS.body,
            ip: FORBIDDEN_SENTINELS.ip,
            user: FORBIDDEN_SENTINELS.user,
            email: FORBIDDEN_SENTINELS.email,
            account: FORBIDDEN_SENTINELS.account,
            device: FORBIDDEN_SENTINELS.device,
            breadcrumbs: FORBIDDEN_SENTINELS.breadcrumbs,
            attachments: FORBIDDEN_SENTINELS.attachments,
            minidumps: FORBIDDEN_SENTINELS.minidumps,
            replay: FORBIDDEN_SENTINELS.replay,
            spans: FORBIDDEN_SENTINELS.spans,
            profiles: FORBIDDEN_SENTINELS.profiles,
            metrics: FORBIDDEN_SENTINELS.metrics,
            logs: FORBIDDEN_SENTINELS.logs,
            sessions: FORBIDDEN_SENTINELS.sessions,
            client_report: FORBIDDEN_SENTINELS.clientReport,
        },
    };
}

function assertNoForbiddenValues(value: unknown) {
    const serialized = JSON.stringify(value) ?? '';
    for (const sentinel of Object.values(FORBIDDEN_SENTINELS)) {
        expect(serialized).not.toContain(sentinel);
    }
}

function assertClosedEvent(event: object) {
    for (const key of Object.keys(event)) {
        expect(ALLOWED_EVENT_KEYS.has(key), `unexpected Sentry event key: ${key}`).toBe(true);
    }
    for (const key of FORBIDDEN_EVENT_KEYS) {
        expect(event).not.toHaveProperty(key);
    }
    const debugMeta = Reflect.get(event, 'debug_meta') as unknown;
    if (debugMeta !== undefined) {
        expect(debugMeta).toEqual({images: expect.any(Array)});
        const images = (debugMeta as {images: unknown[]}).images;
        for (const image of images) {
            expect(image).toEqual({
                type: 'sourcemap',
                code_file: expect.stringMatching(/^(?:_nuxt|dist-electron|server-bundle)\/[^?#:\\]+$/u),
                debug_id: expect.stringMatching(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu),
            });
            const codeFile = (image as {code_file: string}).code_file;
            expect(codeFile.split('/')).not.toContain('..');
            expect(codeFile.split('/')).not.toContain('.');
        }
    }
    assertNoForbiddenValues(event);
}

function readEventFromEnvelope(value: unknown) {
    expect(Array.isArray(value)).toBe(true);
    if (!Array.isArray(value)) {
        throw new Error('Sentry transport did not receive an envelope');
    }
    const items = value[1];
    expect(Array.isArray(items)).toBe(true);
    if (!Array.isArray(items)) {
        throw new Error('Sentry envelope has no item list');
    }
    expect(items).toHaveLength(1);
    const item = items[0];
    expect(Array.isArray(item)).toBe(true);
    if (!Array.isArray(item)) {
        throw new Error('Sentry envelope item is malformed');
    }
    expect(item[0]).toEqual({type: 'event'});
    expect(item[0]).not.toEqual(expect.objectContaining({type: 'client_report'}));
    const event = item[1];
    expect(typeof event).toBe('object');
    expect(event).not.toBeNull();
    if (typeof event !== 'object' || event === null || Array.isArray(event)) {
        throw new Error('Sentry event item has no object payload');
    }
    assertNoForbiddenValues(value);
    expect(JSON.stringify(value)).not.toContain('client_report');
    return event as Record<string, unknown>;
}

function createDesktopFixture() {
    const envelopes: unknown[] = [];
    const send = vi.fn((envelope: unknown) => {
        envelopes.push(envelope);
        return Promise.resolve({statusCode: 200});
    });
    const adapter = createSentryNodeDiagnosticsTransport({
        dsn: 'https://desktopkey@o123.ingest.de.sentry.io/456',
        identity: DESKTOP_IDENTITY,
        appVersion: '0.1.449',
        platform: 'darwin',
        architecture: 'arm64',
        makeTransport: () => ({
            send,
            flush: () => Promise.resolve(true),
        } as NodeTransport),
    });
    return {
        adapter,
        envelopes,
        send,
    };
}

function createBrowserFixture() {
    const envelopes: unknown[] = [];
    const send = vi.fn((envelope: unknown) => {
        envelopes.push(envelope);
        return Promise.resolve({statusCode: 200});
    });
    const adapter = createBrowserDiagnosticsTransport({
        dsn: 'https://browserkey@o123.ingest.de.sentry.io/457',
        identity: BROWSER_IDENTITY,
        makeTransport: () => ({
            send,
            flush: () => Promise.resolve(true),
        } as BrowserTransport),
    });
    return {
        adapter,
        envelopes,
        send,
    };
}

function createNitroFixture() {
    const capturedEvents: unknown[] = [];
    let capturedOptions: Parameters<TSentryNitroClientFactory>[0] | undefined;
    const clientFactory: TSentryNitroClientFactory = options => {
        capturedOptions = options;
        return {captureEvent: event => {
            capturedEvents.push(event);
            return event.event_id;
        }};
    };
    const adapter = createSentryNitroAdapter({
        clientFactory,
        buildConfiguration: NITRO_BUILD_CONFIGURATION,
        runtimeConfig: NITRO_RUNTIME_CONFIG,
    });
    return {
        adapter,
        capturedEvents,
        capturedOptions: () => capturedOptions,
    };
}

describe('SEN-GATE-03 privacy envelope policy', () => {
    it.each([
        'file:///Users/example/private.js',
        'https://evb-viewer.com/_nuxt/private.js',
        'dist-electron/../private.js',
        'server-bundle/chunks/../../private.js',
    ])('rejects a non-canonical source-map code file: %s', codeFile => {
        const image = {
            type: 'sourcemap',
            code_file: codeFile,
            debug_id: '11111111-1111-4111-8111-111111111111',
        };
        const event = {debug_meta: {images: [image]}};
        expect(() => assertClosedEvent(event)).toThrow();
    });

    it('accepts the closed canonical source-map image shape', () => {
        const image = {
            type: 'sourcemap',
            code_file: 'dist-electron/main.js',
            debug_id: '11111111-1111-4111-8111-111111111111',
        };
        const event = {debug_meta: {images: [image]}};
        expect(() => assertClosedEvent(event)).not.toThrow();
    });

    it('accepts a marked source-map canary with an isolated fingerprint', () => {
        const event = {
            event_id: 'a'.repeat(32),
            timestamp: 1_757_000_000,
            level: 'error',
            platform: 'javascript',
            logger: SOURCE_MAP_CANARY.logger,
            release: DESKTOP_IDENTITY.release,
            dist: DESKTOP_IDENTITY.dist,
            environment: DESKTOP_IDENTITY.environment,
            fingerprint: [
                SOURCE_MAP_CANARY.fingerprintPrefix,
                DESKTOP_IDENTITY.target,
                DESKTOP_IDENTITY.release,
                DESKTOP_IDENTITY.dist,
                DESKTOP_IDENTITY.environment,
                'dist-electron/main.js',
            ],
            exception: {values: [{
                type: SOURCE_MAP_CANARY.exceptionType,
                value: SOURCE_MAP_CANARY.exceptionValue,
                stacktrace: {frames: [{
                    abs_path: 'dist-electron/main.js',
                    filename: 'dist-electron/main.js',
                    module: 'dist-electron/main.js',
                    function: 'evbViewerSourceMapCanary',
                    lineno: 1,
                    colno: 1,
                    in_app: true,
                }]},
            }]},
            tags: {
                evb_schema: 'evb-diagnostic-v1',
                [SOURCE_MAP_CANARY.tagKey]: SOURCE_MAP_CANARY.tagValue,
                bundle_role: 'electron-main',
            },
            debug_meta: {images: [{
                type: 'sourcemap',
                code_file: 'dist-electron/main.js',
                debug_id: '11111111-1111-4111-8111-111111111111',
            }]},
        };

        expect(event.fingerprint[0]).toBe(SOURCE_MAP_CANARY.fingerprintPrefix);
        expect(event.tags[SOURCE_MAP_CANARY.tagKey]).toBe(SOURCE_MAP_CANARY.tagValue);
        expect(() => assertClosedEvent(event)).not.toThrow();
    });

    it('keeps the accepted desktop record to one event item with no forbidden payload', async () => {
        const fixture = createDesktopFixture();
        const record = createRecord('electron-main', '00000000000000000000000000000001');

        await expect(fixture.adapter.send?.(record, 4)).resolves.toBe(true);
        expect(fixture.send).toHaveBeenCalledOnce();
        const event = readEventFromEnvelope(fixture.envelopes[0]);

        expect(event).toMatchObject({
            event_id: record.eventId,
            tags: {evb_schema: 'evb-diagnostic-v1'},
            extra: {suppressedCount: 4},
        });
        assertClosedEvent(event);
    });

    it('keeps the accepted hosted-browser record to one event item with no forbidden payload', async () => {
        const fixture = createBrowserFixture();
        const record = createRecord('hosted-browser', '00000000000000000000000000000002');

        await expect(fixture.adapter.send(record, 4)).resolves.toBe(true);
        expect(fixture.send).toHaveBeenCalledOnce();
        const event = readEventFromEnvelope(fixture.envelopes[0]);

        expect(event).toMatchObject({
            event_id: record.eventId,
            tags: {evb_schema: 'evb-diagnostic-v1'},
            extra: {suppressedCount: 4},
        });
        assertClosedEvent(event);
    });

    it('keeps the accepted Nitro record to one sanitized event and disables client reports', () => {
        const fixture = createNitroFixture();
        const record = createRecord('viewer-nitro', '00000000000000000000000000000003');

        expect(fixture.adapter.send(record, 4)).toBe(record.eventId);
        expect(fixture.capturedEvents).toHaveLength(1);
        expect(fixture.capturedOptions()).toMatchObject({sendClientReports: false});

        const finalEvent = fixture.adapter.sanitizeEvent(fixture.capturedEvents[0]);
        expect(finalEvent).not.toBeNull();
        if (finalEvent === null) {
            return;
        }
        expect(finalEvent).toMatchObject({
            event_id: record.eventId,
            tags: {evb_schema: 'evb-diagnostic-v1'},
            contexts: {diagnostics: {suppressedCount: 4}},
        });
        assertClosedEvent(finalEvent);
    });

    it('drops malformed polluted records before every adapter transport', () => {
        const desktop = createDesktopFixture();
        const browser = createBrowserFixture();
        const nitro = createNitroFixture();
        const desktopRecord = createRecord('electron-main', '00000000000000000000000000000011');
        const browserRecord = createRecord('hosted-browser', '00000000000000000000000000000012');
        const nitroRecord = createRecord('viewer-nitro', '00000000000000000000000000000013');

        expect(desktop.adapter.send?.(
            createPollutedRecord(desktopRecord) as never,
        )).toBe(false);
        expect(browser.adapter.send(
            createPollutedRecord(browserRecord) as never,
        )).toBe(false);
        expect(nitro.adapter.send(
            createPollutedRecord(nitroRecord) as never,
        )).toBe(false);

        expect(desktop.envelopes).toHaveLength(0);
        expect(browser.envelopes).toHaveLength(0);
        expect(nitro.capturedEvents).toHaveLength(0);
    });

    it('drops unmarked and malformed Nitro events, then reconstructs polluted marked input', () => {
        const fixture = createNitroFixture();
        const record = createRecord('viewer-nitro', '00000000000000000000000000000021');
        const marked = buildSentryEvent(record, NITRO_IDENTITY, 4) as Record<string, unknown>;
        const markedExtra = marked.extra as Record<string, unknown>;

        expect(fixture.adapter.sanitizeEvent({message: FORBIDDEN_SENTINELS.rawErrorText})).toBeNull();
        expect(fixture.adapter.sanitizeEvent({
            ...marked,
            extra: {
                ...markedExtra,
                [NITRO_RECORD_MARKER]: {
                    ...record,
                    leaked: FORBIDDEN_SENTINELS.rawErrorText,
                },
            },
        })).toBeNull();

        const reconstructed = fixture.adapter.sanitizeEvent(
            createPollutedEvent(record, NITRO_IDENTITY),
        );
        expect(reconstructed).not.toBeNull();
        if (reconstructed === null) {
            return;
        }
        expect(reconstructed).not.toHaveProperty('extra');
        expect(reconstructed).not.toHaveProperty(NITRO_RECORD_MARKER);
        assertClosedEvent(reconstructed);
    });
});
