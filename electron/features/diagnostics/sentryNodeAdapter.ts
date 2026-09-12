import {
    createTransport,
    createEventEnvelope,
    createStackParser,
    getEnvelopeEndpointWithUrlEncodedAuth,
    getFilenameToDebugIdMap,
    makeDsn,
    nodeStackLineParser,
    type Event,
    type Transport,
} from '@sentry/core';
import {request as requestHttps} from 'node:https';
import {
    appendFileSync,
    closeSync,
    fstatSync,
    openSync,
    readdirSync,
    readSync,
} from 'node:fs';
import {
    isAbsolute,
    join,
    relative,
    resolve,
} from 'node:path';
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
import type {IMainDiagnosticsTransport} from '@electron/features/diagnostics/mainFailureReporter';

const EU_SENTRY_INGEST_HOST_PATTERN = /(?:^|\.)ingest\.de\.sentry\.io$/u;

interface INodeEnvelopeTransportOptions {
    readonly url: string;
    readonly recordDroppedEvent: () => void;
}

type TSentryTransportFactory = (options: INodeEnvelopeTransportOptions) => Transport;

export interface ISentryNodeAuditEntry {
    readonly code: DiagnosticRecord['code'];
    readonly dist: SentryBuildIdentity['dist'];
    readonly environment: SentryBuildIdentity['environment'];
    readonly eventId: DiagnosticRecord['eventId'];
    readonly itemType: 'event';
    readonly phase: 'accepted' | 'attempted' | 'rejected';
    readonly release: SentryBuildIdentity['release'];
    readonly runtime: DiagnosticRecord['runtime'];
}

export interface ISentryNodeAdapterOptions {
    dsn: string;
    identity: SentryBuildIdentity;
    appVersion: string;
    platform?: string;
    architecture?: string;
    runtimeVersions?: {
        electron?: string;
        chrome?: string;
        node?: string;
    };
    makeTransport?: TSentryTransportFactory;
    audit?: (entry: ISentryNodeAuditEntry) => void;
    resolveFilenameDebugIds?: () => Readonly<Record<string, string>>;
    rendererStaticRoot?: string;
}

export type TSentryNodeRuntimeOptions = Omit<
    ISentryNodeAdapterOptions,
    'dsn' | 'identity'
>;

function majorVersion(value: string | undefined) {
    const match = value?.match(/^(\d+)/u);
    return match?.[1];
}

function requireEuDsn(value: string) {
    const candidate = value.trim();
    let parsed: URL;
    try {
        parsed = new URL(candidate);
    } catch {
        throw new Error('Desktop diagnostics require a valid EU Sentry DSN');
    }
    if (
        parsed.protocol !== 'https:'
        || parsed.username.length === 0
        || parsed.password.length > 0
        || !EU_SENTRY_INGEST_HOST_PATTERN.test(parsed.hostname)
        || !/^\/\d+\/?$/u.test(parsed.pathname)
    ) {
        throw new Error('Desktop diagnostics require a valid EU Sentry DSN');
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
        throw new Error('Desktop diagnostics require a valid EU Sentry DSN');
    }
    return dsn;
}

const RENDERER_CHUNK_TRAILER_BYTES = 256;
const RENDERER_CHUNK_DEBUG_ID_PATTERN = /\/\/# debugId=([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\s*$/iu;

function readChunkTrailer(path: string) {
    const descriptor = openSync(path, 'r');
    try {
        const size = fstatSync(descriptor).size;
        const length = Math.min(size, RENDERER_CHUNK_TRAILER_BYTES);
        const buffer = Buffer.alloc(length);
        readSync(descriptor, buffer, 0, length, size - length);
        return buffer.toString('utf8');
    } finally {
        closeSync(descriptor);
    }
}

/**
 * Renderer chunks run in another process, so the SDK's in-process Debug ID
 * registry never sees them. Their injected `//# debugId=` trailers are read
 * from the packaged bundle instead and keyed the way renderer frames name them.
 */
function readRendererChunkDebugIds(staticRoot: string): Record<string, string> {
    const debugIds: Record<string, string> = {};
    let chunkNames: string[];
    try {
        chunkNames = readdirSync(join(staticRoot, '_nuxt'));
    } catch {
        return debugIds;
    }
    for (const chunkName of chunkNames) {
        if (!chunkName.endsWith('.js')) {
            continue;
        }
        try {
            const debugId = RENDERER_CHUNK_DEBUG_ID_PATTERN.exec(readChunkTrailer(join(staticRoot, '_nuxt', chunkName)))?.[1];
            if (debugId !== undefined) {
                debugIds[`_nuxt/${chunkName}`] = debugId;
            }
        } catch {
            // A chunk that cannot be read simply stays unsymbolicated.
        }
    }
    return debugIds;
}

function createDefaultFilenameDebugIdResolver(rendererStaticRoot: string | undefined) {
    const stackParser = createStackParser(nodeStackLineParser());
    let rendererDebugIds: Record<string, string> | null = null;
    return () => {
        rendererDebugIds ??= rendererStaticRoot === undefined ? {} : readRendererChunkDebugIds(rendererStaticRoot);
        return {
            ...getFilenameToDebugIdMap(stackParser),
            ...rendererDebugIds,
        };
    };
}

function buildRuntimeContext(options: ISentryNodeAdapterOptions) {
    const electronMajor = majorVersion(options.runtimeVersions?.electron);
    const chromiumMajor = majorVersion(options.runtimeVersions?.chrome);
    const nodeMajor = majorVersion(options.runtimeVersions?.node);
    return {
        app_version: options.appVersion,
        platform: options.platform ?? 'unknown',
        architecture: options.architecture ?? 'unknown',
        ...(electronMajor === undefined ? {} : {electron_major: electronMajor}),
        ...(chromiumMajor === undefined ? {} : {chromium_major: chromiumMajor}),
        ...(nodeMajor === undefined ? {} : {node_major: nodeMajor}),
    };
}

function isSuccessfulResponse(value: Awaited<ReturnType<Transport['send']>>) {
    return typeof value.statusCode === 'number'
        && value.statusCode >= 200
        && value.statusCode < 300;
}

function writeAudit(
    audit: ISentryNodeAdapterOptions['audit'],
    record: DiagnosticRecord,
    identity: SentryBuildIdentity,
    phase: ISentryNodeAuditEntry['phase'],
) {
    try {
        audit?.({
            code: record.code,
            dist: identity.dist,
            environment: identity.environment,
            eventId: record.eventId,
            itemType: 'event',
            phase,
            release: identity.release,
            runtime: record.runtime,
        });
    } catch {
        // An automation audit sink is observational and never changes delivery.
    }
}

function createEnvironmentAuditSink(): ISentryNodeAdapterOptions['audit'] {
    if (
        process.env.EVB_ENABLE_DIAGNOSTICS_CANARY !== '1'
        || !process.env.EVB_AUTOMATION_SESSION_NAME?.trim()
    ) {
        return undefined;
    }
    const userDataPath = process.env.EVB_AUTOMATION_USER_DATA_DIR?.trim();
    const auditPath = process.env.EVB_DIAGNOSTICS_CANARY_AUDIT_FILE?.trim();
    if (!userDataPath || !auditPath) {
        return undefined;
    }
    const root = resolve(userDataPath);
    const target = resolve(auditPath);
    const relativeTarget = relative(root, target);
    if (
        relativeTarget.length === 0
        || relativeTarget.startsWith('..')
        || isAbsolute(relativeTarget)
    ) {
        return undefined;
    }

    return entry => {
        appendFileSync(target, `${JSON.stringify(entry)}\n`, {encoding: 'utf8'});
    };
}

function createNodeEnvelopeTransport(options: INodeEnvelopeTransportOptions) {
    return createTransport({
        bufferSize: 16,
        recordDroppedEvent: options.recordDroppedEvent,
    }, request => new Promise((resolve, reject) => {
        const body = request.body;
        const outgoing = requestHttps(options.url, {
            method: 'POST',
            headers: {
                'content-type': 'application/x-sentry-envelope',
                'content-length': String(typeof body === 'string'
                    ? Buffer.byteLength(body)
                    : body.byteLength),
            },
        }, response => {
            response.resume();
            response.once('end', () => {
                resolve({
                    ...(response.statusCode === undefined ? {} : {statusCode: response.statusCode}),
                    headers: {
                        'retry-after': typeof response.headers['retry-after'] === 'string'
                            ? response.headers['retry-after']
                            : null,
                        'x-sentry-rate-limits': typeof response.headers['x-sentry-rate-limits'] === 'string'
                            ? response.headers['x-sentry-rate-limits']
                            : null,
                    },
                });
            });
        });
        outgoing.once('error', reject);
        outgoing.end(body);
    }));
}

export function createSentryNodeDiagnosticsTransport(
    options: ISentryNodeAdapterOptions,
): IMainDiagnosticsTransport {
    const identity = assertSentryBuildIdentity(options.identity);
    const appVersion = options.appVersion.trim();
    const platform = options.platform ?? 'unknown';
    const architecture = options.architecture ?? 'unknown';
    if (
        identity.target !== 'desktop'
        || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(appVersion)
        || identity.release !== `evb-viewer-desktop@${appVersion}`
        || ![
            'darwin',
            'linux',
            'win32',
            'unknown',
        ].includes(platform)
        || ![
            'arm64',
            'x64',
            'unknown',
        ].includes(architecture)
    ) {
        throw new Error('Desktop diagnostics require an exact desktop build identity');
    }
    const dsn = requireEuDsn(options.dsn);
    const makeTransport = options.makeTransport ?? createNodeEnvelopeTransport;
    const transport = makeTransport({
        url: getEnvelopeEndpointWithUrlEncodedAuth(dsn),
        recordDroppedEvent: () => undefined,
    });

    const resolveFilenameDebugIds = options.resolveFilenameDebugIds
        ?? createDefaultFilenameDebugIdResolver(options.rendererStaticRoot);

    return Object.freeze({
        isReady: true,
        send: (value: DiagnosticRecord, inheritedSuppressedCount = 0) => {
            const record = decodeDiagnosticRecord(value);
            const suppressedCount = decodeDiagnosticsSuppressedCount(inheritedSuppressedCount);
            if (record === null || suppressedCount === null) {
                return false;
            }
            const filenameToDebugId = resolveFilenameDebugIds();
            const event: Event = buildSentryClosedEvent(
                record,
                suppressedCount,
                identity,
                buildRuntimeContext(options),
                filenameToDebugId,
            );
            const markedEvent = event.tags?.evb_schema === EVB_DIAGNOSTIC_SCHEMA_MARKER
                ? buildSentryClosedEvent(
                    record,
                    suppressedCount,
                    identity,
                    buildRuntimeContext(options),
                    filenameToDebugId,
                )
                : null;
            if (markedEvent === null) {
                return false;
            }
            writeAudit(options.audit, record, identity, 'attempted');
            try {
                return Promise.resolve(transport.send(createEventEnvelope(markedEvent, dsn)))
                    .then((response) => {
                        const accepted = isSuccessfulResponse(response);
                        writeAudit(options.audit, record, identity, accepted ? 'accepted' : 'rejected');
                        return accepted;
                    }, () => {
                        writeAudit(options.audit, record, identity, 'rejected');
                        return false;
                    });
            } catch {
                writeAudit(options.audit, record, identity, 'rejected');
                return false;
            }
        },
    });
}

export function createSentryNodeDiagnosticsTransportFromEnvironment(
    options: TSentryNodeRuntimeOptions,
) {
    const audit = createEnvironmentAuditSink();
    return createSentryNodeDiagnosticsTransport({
        ...options,
        dsn: process.env.SENTRY_DESKTOP_DSN ?? '',
        identity: {
            target: 'desktop',
            release: process.env.EVB_SENTRY_RELEASE ?? '',
            dist: process.env.EVB_SENTRY_DIST ?? '',
            environment: process.env.EVB_SENTRY_ENVIRONMENT as SentryBuildIdentity['environment'],
        },
        ...(audit === undefined ? {} : {audit}),
    });
}
