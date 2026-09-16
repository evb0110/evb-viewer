import {DIAGNOSTIC_DEFINITIONS} from '@contracts/diagnostics/diagnosticCodes';
import type {DiagnosticRecord} from '@contracts/diagnostics/diagnosticRecord';
import type {SentryBuildIdentity} from '@contracts/diagnostics/releaseIdentity';
import {buildSentrySourceMapDebugImages} from '@contracts/diagnostics/sentryDebugImages';

export const EVB_DIAGNOSTIC_SCHEMA_MARKER = 'evb-diagnostic-v1';

export const EVB_SENTRY_RUNTIME_PROBE_ENV = 'EVB_SENTRY_RUNTIME_PROBE';
export const PACKAGED_SMOKE_RUNTIME_PROBE = Object.freeze({
    fingerprintPrefix: 'evb-viewer-packaged-smoke-v1',
    tagKey: 'evb_probe',
    tagValue: 'packaged-smoke',
});

export type TSentryRuntimeProbe = typeof PACKAGED_SMOKE_RUNTIME_PROBE.tagValue;

export function readSentryRuntimeProbe(value: unknown): TSentryRuntimeProbe | undefined {
    if (value === undefined || value === '') {
        return undefined;
    }
    if (value === PACKAGED_SMOKE_RUNTIME_PROBE.tagValue) {
        return PACKAGED_SMOKE_RUNTIME_PROBE.tagValue;
    }
    throw new Error('Unsupported Sentry runtime probe');
}

export function buildSentryClosedEvent(
    record: DiagnosticRecord,
    suppressedCount: number,
    identity: SentryBuildIdentity,
    runtimeContext: Readonly<Record<string, string | number>>,
    filenameToDebugId: Readonly<Record<string, string>>,
    runtimeProbe?: TSentryRuntimeProbe,
) {
    const definition = DIAGNOSTIC_DEFINITIONS[record.code];
    const topFrame = record.frames[0];
    const debugImages = buildSentrySourceMapDebugImages(record.frames, filenameToDebugId);

    return {
        event_id: record.eventId,
        timestamp: record.occurredAt / 1_000,
        level: record.severity,
        platform: 'javascript' as const,
        logger: 'evb-viewer.diagnostics',
        release: identity.release,
        dist: identity.dist,
        environment: identity.environment,
        fingerprint: [
            ...(runtimeProbe === PACKAGED_SMOKE_RUNTIME_PROBE.tagValue
                ? [PACKAGED_SMOKE_RUNTIME_PROBE.fingerprintPrefix]
                : []),
            record.runtime,
            record.code,
            topFrame?.module ?? 'no-application-frame',
        ],
        exception: {values: [{
            type: definition.exceptionType,
            value: definition.exceptionValue,
            stacktrace: {frames: [...record.frames].reverse().map(frame => ({
                filename: frame.module,
                module: frame.module,
                ...(frame.function === undefined ? {} : {function: frame.function}),
                ...(frame.line === undefined ? {} : {lineno: frame.line}),
                ...(frame.column === undefined ? {} : {colno: frame.column}),
                in_app: true,
            }))},
        }]},
        tags: {
            evb_schema: EVB_DIAGNOSTIC_SCHEMA_MARKER,
            diagnostic_code: record.code,
            diagnostic_runtime: record.runtime,
            ...(record.operation === undefined ? {} : {diagnostic_operation: record.operation}),
            ...(runtimeProbe === PACKAGED_SMOKE_RUNTIME_PROBE.tagValue
                ? {[PACKAGED_SMOKE_RUNTIME_PROBE.tagKey]: PACKAGED_SMOKE_RUNTIME_PROBE.tagValue}
                : {}),
        },
        contexts: {evb_runtime: runtimeContext},
        ...(debugImages.length === 0 ? {} : {debug_meta: {images: debugImages}}),
        extra: {
            schemaVersion: record.schemaVersion,
            context: Object.fromEntries(Object.entries(record.context)),
            ...(suppressedCount === 0 ? {} : {suppressedCount}),
        },
    };
}
