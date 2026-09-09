import {
    createEventEnvelope,
    getEnvelopeEndpointWithUrlEncodedAuth,
    getFilenameToDebugIdMap,
    makeDsn,
    type Event,
    type Transport,
} from '@sentry/core/browser';
import {
    defaultStackParser,
    makeFetchTransport,
} from '@sentry/browser';
import {
    decodeDiagnosticRecord,
    type DiagnosticRecord,
} from '@contracts/diagnostics/diagnosticRecord';
import {decodeDiagnosticsSuppressedCount} from '@contracts/diagnostics/diagnosticsCapability';
import {
    buildSentryClosedEvent,
    EVB_DIAGNOSTIC_SCHEMA_MARKER,
} from '@contracts/diagnostics/sentryClosedEvent';
import {
    assertSentryBuildIdentity,
    type SentryBuildIdentity,
} from '@contracts/diagnostics/releaseIdentity.js';
import type {IHostedDiagnosticsTransport} from '@app/utils/failureReporter';

const EU_SENTRY_INGEST_HOST_PATTERN = /(?:^|\.)ingest\.de\.sentry\.io$/u;

type TSentryTransportFactory = (options: Parameters<typeof makeFetchTransport>[0]) => Transport;

export interface IBrowserDiagnosticsTransportOptions {
    dsn: string;
    identity: SentryBuildIdentity;
    makeTransport?: TSentryTransportFactory;
    resolveFilenameDebugIds?: () => Readonly<Record<string, string>>;
}

function requireEuDsn(value: string) {
    const candidate = value.trim();
    let parsed: URL;
    try {
        parsed = new URL(candidate);
    } catch {
        throw new Error('Browser diagnostics require a valid EU Sentry DSN');
    }
    if (
        parsed.protocol !== 'https:'
        || parsed.username.length === 0
        || parsed.password.length > 0
        || !EU_SENTRY_INGEST_HOST_PATTERN.test(parsed.hostname)
        || !/^\/\d+\/?$/u.test(parsed.pathname)
    ) {
        throw new Error('Browser diagnostics require a valid EU Sentry DSN');
    }
    const dsn = makeDsn(candidate);
    if (
        dsn === undefined
        || dsn.protocol !== 'https'
        || typeof dsn.publicKey !== 'string'
        || dsn.publicKey.length === 0
        || Boolean(dsn.pass)
        || !EU_SENTRY_INGEST_HOST_PATTERN.test(dsn.host)
        || !/^\d+$/u.test(dsn.projectId)
    ) {
        throw new Error('Browser diagnostics require a valid EU Sentry DSN');
    }
    return dsn;
}

function isSuccessfulResponse(value: Awaited<ReturnType<Transport['send']>>) {
    return typeof value.statusCode === 'number'
        && value.statusCode >= 200
        && value.statusCode < 300;
}

export function createBrowserDiagnosticsTransport(
    options: IBrowserDiagnosticsTransportOptions,
): IHostedDiagnosticsTransport {
    const identity = assertSentryBuildIdentity(options.identity);
    if (identity.target !== 'web') {
        throw new Error('Browser diagnostics require an exact web build identity');
    }
    const dsn = requireEuDsn(options.dsn);
    const makeTransport = options.makeTransport ?? makeFetchTransport;
    const resolveFilenameDebugIds = options.resolveFilenameDebugIds
        ?? (() => getFilenameToDebugIdMap(defaultStackParser));
    const transport = makeTransport({
        url: getEnvelopeEndpointWithUrlEncodedAuth(dsn),
        recordDroppedEvent: () => undefined,
    });

    return Object.freeze({send: (value: DiagnosticRecord, inheritedSuppressedCount = 0) => {
        const record = decodeDiagnosticRecord(value);
        const suppressedCount = decodeDiagnosticsSuppressedCount(inheritedSuppressedCount);
        if (record === null || suppressedCount === null) {
            return false;
        }
        const event: Event = buildSentryClosedEvent(
            record,
            suppressedCount,
            identity,
            {target: 'hosted-browser'},
            resolveFilenameDebugIds(),
        );
        const markedEvent = event.tags?.evb_schema === EVB_DIAGNOSTIC_SCHEMA_MARKER
            ? buildSentryClosedEvent(
                record,
                suppressedCount,
                identity,
                {target: 'hosted-browser'},
                resolveFilenameDebugIds(),
            )
            : null;
        if (markedEvent === null) {
            return false;
        }
        try {
            return Promise.resolve(transport.send(createEventEnvelope(markedEvent, dsn)))
                .then(isSuccessfulResponse, () => false);
        } catch {
            return false;
        }
    }});
}

export function createConfiguredBrowserDiagnosticsTransport() {
    const publicConfig: unknown = useRuntimeConfig().public;
    const sentry = typeof publicConfig === 'object' && publicConfig !== null
        ? (publicConfig as Record<string, unknown>).sentry
        : null;
    const sentryRecord = typeof sentry === 'object' && sentry !== null
        ? sentry as Record<string, unknown>
        : {};
    const readString = (key: string) => {
        const value = sentryRecord[key];
        return typeof value === 'string' ? value : '';
    };
    return createBrowserDiagnosticsTransport({
        dsn: readString('dsn'),
        identity: {
            target: 'web',
            release: readString('release'),
            dist: readString('dist'),
            environment: readString('environment') as 'production' | 'preview' | 'development' | 'test',
        },
    });
}
