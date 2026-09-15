/* eslint-disable @typescript-eslint/naming-convention */

import {
    describe,
    expect,
    expectTypeOf,
    it,
} from 'vitest';
import * as fc from 'fast-check';
import {
    DIAGNOSTIC_CODES,
    DIAGNOSTIC_DEFINITIONS,
    DIAGNOSTIC_EVENT_DEFINITIONS,
    decodeDiagnosticContext,
    type DiagnosticCode,
    type DiagnosticContext,
} from '@contracts/diagnostics/diagnosticCodes';
import {
    createDiagnosticEventId,
    DIAGNOSTIC_EVENT_ID_HEX_LENGTH,
    parseDiagnosticEventId,
} from '@contracts/diagnostics/diagnosticEventId';
import {
    decodeDiagnosticRecord,
    DIAGNOSTIC_RECORD_SCHEMA_VERSION,
    MAX_DIAGNOSTIC_RECORD_FRAMES,
    type DiagnosticRecord,
} from '@contracts/diagnostics/diagnosticRecord';
import {
    decodeDiagnosticsSuppressedCount,
    DIAGNOSTICS_MAX_SUPPRESSED_COUNT,
} from '@contracts/diagnostics/diagnosticsCapability';
import {
    decodeStartupCrashMarkerRecord,
    STARTUP_CRASH_MARKER_SCHEMA_VERSION,
    type StartupCrashMarkerRecord,
} from '@contracts/diagnostics/startupCrashMarker';
import {
    type CaptureFailureInput,
    decodeFailureReceipt,
    type ExpectedOutcome,
    type FailureReceipt,
    getFailureReceipt,
    type LocalFailureDetail,
    isExpectedOutcome,
} from '@contracts/diagnostics/failureReceipt';
import {decodeDebugLogEntry} from '@contracts/electronApiCommon';
import {requireEpochMs} from '@contracts/timestamps';
import {createCaptureTransport} from '@tests/helpers/createCaptureTransport';

const VALID_EVENT_ID = parseDiagnosticEventId('a'.repeat(DIAGNOSTIC_EVENT_ID_HEX_LENGTH))!;

const BASE_FRAME = {
    module: 'app/modules/viewer.ts',
    function: 'openDocument',
    line: 12,
    column: 8,
} as const;

const BASE_RECORD: DiagnosticRecord<'UNCLASSIFIED_RENDERER_ERROR'> = {
    schemaVersion: DIAGNOSTIC_RECORD_SCHEMA_VERSION,
    eventId: VALID_EVENT_ID,
    code: 'UNCLASSIFIED_RENDERER_ERROR',
    severity: 'error',
    runtime: 'electron-renderer',
    operation: 'renderer-error',
    occurredAt: requireEpochMs(1_757_000_000_000),
    frames: [BASE_FRAME],
    context: {
        phase: 'operation',
        attempt: 2,
        recovered: false,
    },
};

const FORBIDDEN_SENTINELS = [
    'forbidden exception message: secret-document.pdf',
    'forbidden console argument [object Object]',
    'forbidden UI string',
    '/Users/example/Documents/secret-document.pdf',
    'C:\\Users\\example\\Documents\\secret-document.pdf',
    'https://example.test/private?token=forbidden#fragment',
] as const;

const FORBIDDEN_OBJECTS = [
    {
        message: FORBIDDEN_SENTINELS[0],
        path: FORBIDDEN_SENTINELS[3],
        nested: {value: FORBIDDEN_SENTINELS[5]},
    },
    {
        cause: {stack: FORBIDDEN_SENTINELS[1]},
        data: [FORBIDDEN_SENTINELS[2]],
    },
] as const;

const FORBIDDEN_VALUES = fc.oneof(
    fc.constantFrom(...FORBIDDEN_SENTINELS),
    fc.constantFrom(...FORBIDDEN_OBJECTS),
);

function copyBaseRecord(): Record<string, unknown> {
    return {
        ...BASE_RECORD,
        frames: BASE_RECORD.frames.map(frame => ({...frame})),
        context: {...BASE_RECORD.context},
    };
}

function assignForbiddenValue(location: string, value: unknown) {
    const candidate = copyBaseRecord();
    switch (location) {
        case 'schemaVersion':
        case 'eventId':
        case 'code':
        case 'severity':
        case 'runtime':
        case 'operation':
        case 'occurredAt':
            candidate[location] = value;
            break;
        case 'frames':
            candidate.frames = value;
            break;
        case 'frame':
            (candidate.frames as unknown[])[0] = value;
            break;
        case 'frame.module':
        case 'frame.function':
        case 'frame.line':
        case 'frame.column':
            (candidate.frames as Array<Record<string, unknown>>)[0]![location.slice('frame.'.length)] = value;
            break;
        case 'context.phase':
        case 'context.attempt':
        case 'context.recovered':
            (candidate.context as Record<string, unknown>)[location.slice('context.'.length)] = value;
            break;
        case 'context':
            candidate.context = value;
            break;
        default:
            throw new Error(`Unhandled diagnostic test location: ${location}`);
    }
    return candidate;
}

describe('diagnostic contracts', () => {
    it('keeps debug-log failure references closed and restricted to ERROR entries', () => {
        const failureRef = {
            eventId: VALID_EVENT_ID,
            code: 'UNCLASSIFIED_MAIN_ERROR' as const,
            severity: 'error' as const,
        };
        const entry = {
            source: 'main',
            message: '[ERROR] main failure',
            timestamp: '2026-09-03T00:00:00.000Z',
            level: 'ERROR' as const,
            failureRef,
        };

        expect(decodeDebugLogEntry(entry)).toEqual({
            ...entry,
            failureRef: {...failureRef},
        });
        expect(decodeDebugLogEntry({
            ...entry,
            level: 'WARN',
        })).toBeNull();
        expect(decodeDebugLogEntry({
            ...entry,
            failureRef: {
                ...failureRef,
                unexpected: true,
            },
        })).toBeNull();
        expect(decodeDebugLogEntry({
            ...entry,
            extra: true,
        })).toBeNull();
        expect(decodeDebugLogEntry({
            ...entry,
            failureRef: {
                ...failureRef,
                eventId: 'not-an-event-id',
            },
        })).toBeNull();
        expect(decodeDebugLogEntry({
            ...entry,
            failureRef: {
                ...failureRef,
                severity: 'warning',
            },
        })).toBeNull();
    });

    it('rejects reference-free ERROR entries', () => {
        expect(decodeDebugLogEntry({
            source: 'legacy-main',
            message: '[ERROR] legacy failure',
            timestamp: '2026-09-03T00:00:00.000Z',
            level: 'ERROR',
        })).toBeNull();
    });

    it('decodes only the bounded renderer suppression count beside a closed record', () => {
        expect(decodeDiagnosticsSuppressedCount(undefined)).toBe(0);
        expect(decodeDiagnosticsSuppressedCount(0)).toBe(0);
        expect(decodeDiagnosticsSuppressedCount(DIAGNOSTICS_MAX_SUPPRESSED_COUNT)).toBe(10_000);
        expect(decodeDiagnosticsSuppressedCount(-1)).toBeNull();
        expect(decodeDiagnosticsSuppressedCount(10_001)).toBeNull();
        expect(decodeDiagnosticsSuppressedCount(1.5)).toBeNull();
        expect(decodeDiagnosticsSuppressedCount('1')).toBeNull();
    });

    it('derives the closed code union from one registry', () => {
        expect(DIAGNOSTIC_CODES).toEqual([
            'UNCLASSIFIED_RENDERER_ERROR',
            'RENDERER_ERROR_GUARD_FAILED',
            'RENDERER_RUNTIME_ERROR_LOG_STREAM_FAILED',
            'UNCLASSIFIED_MAIN_ERROR',
            'UNCLASSIFIED_CONSOLE_ERROR',
            'NITRO_ANALYTICS_DATABASE_INITIALIZATION_FAILED',
            'NITRO_ANALYTICS_INSERT_FAILED',
            'RENDERER_OCR_BACKEND_FAILED',
            'RENDERER_OCR_RUN_FAILED',
            'RENDERER_NATIVE_PDF_VIEWER_FAILED',
            'RENDERER_PDF_OUTLINE_LOAD_FAILED',
            'RENDERER_PDF_RANGE_READ_FAILED',
            'RENDERER_PDF_IMAGE_RASTERIZATION_FAILED',
            'RENDERER_PDF_INITIAL_RENDER_RECOVERY_FAILED',
            'RENDERER_PDF_PAGE_RENDER_FAILED',
            'RENDERER_PDF_SEARCH_OPERATION_FAILED',
            'RENDERER_PDF_VIEWPORT_PLACEMENT_FAILED',
            'RENDERER_PDF_DOCUMENT_LOAD_FAILED',
            'RENDERER_BROWSER_EVENT_SUBSCRIPTION_FAILED',
            'RENDERER_ASYNC_GUARD_FAILED',
            'MAIN_STARTUP_CRASH',
            'MAIN_CHILD_PROCESS_GONE',
            'MAIN_RENDERER_PROCESS_GONE',
            'MAIN_PRELOAD_ERROR',
            'MAIN_UNRESPONSIVE_RENDERER',
            'MAIN_RENDERER_RECOVERY_FAILED',
            'MAIN_UNRESPONSIVE_RECOVERY_FAILED',
            'MAIN_GPU_SAFE_MODE_RECOVERY',
            'MAIN_UNHANDLED_REJECTION',
            'MAIN_UNHANDLED_REJECTION_RECOVERY',
            'SETTINGS_LOAD_FAILED',
            'MAIN_EXTERNAL_OPEN_FAILED',
            'MAIN_ATOMIC_REPLACE_RESTORE_FAILED',
            'SETTINGS_SAVE_FAILED',
            'MAIN_CODEX_MCP_INTEGRATION_FAILED',
            'MAIN_DOCUMENT_REVEAL_FAILED',
            'ASSISTANT_ACTION_FAILED',
            'UPDATE_OPERATION_FAILED',
            'RENDERER_STARTUP_WARMUP_FAILED',
            'RENDERER_DEVELOPMENT_HMR_FAILED',
            'RENDERER_DJVU_OPERATION_FAILED',
            'RENDERER_PDF_COMBINE_OPERATION_FAILED',
            'RENDERER_ANNOTATION_OPERATION_FAILED',
            'RENDERER_PDF_PAGE_OPERATION_FAILED',
            'RENDERER_SCAN_CLEANUP_OPERATION_FAILED',
            'RENDERER_WORKSPACE_OPERATION_FAILED',
            'RENDERER_TAB_TRANSFER_OPERATION_FAILED',
            'RENDERER_SEARCH_WORKER_FAILED',
            'RENDERER_PDF_SERIALIZATION_WORKER_FAILED',
            'MAIN_ELECTRON_LOCALE_LOAD_FAILED',
            'MAIN_RECENT_FILES_LOAD_FAILED',
            'MAIN_RECENT_FILES_RECOVERY_FAILED',
            'MAIN_RECENT_FILES_SAVE_FAILED',
            'MAIN_UPDATE_CHECK_FAILED',
            'MAIN_UPDATE_DOWNLOAD_FAILED',
            'MAIN_UPDATE_INSTALL_FAILED',
            'MAIN_UPDATE_INSTALL_PREPARATION_FAILED',
            'MAIN_UPDATE_STARTUP_FAILED',
            'MAIN_SHUTDOWN_SAVE_FLUSH_FAILED',
            'MAIN_STARTUP_INITIALIZATION_FAILED',
            'MAIN_SHUTDOWN_FAILED',
            'MAIN_DJVU_EXPORT_FAILED',
            'MAIN_IMAGE_EXPORT_FAILED',
            'MAIN_DJVU_VIEWING_FAILED',
            'MAIN_DOCUMENT_OPEN_FAILED',
            'MAIN_SCAN_CLEANUP_FAILED',
            'MAIN_SEARCH_WORKER_FAILED',
            'MAIN_WORKING_COPY_CLEANUP_FAILED',
            'MAIN_OCR_OPERATION_FAILED',
            'MAIN_RENDERER_LOG_BRIDGE_FAILED',
            'MAIN_DEFAULT_VIEWER_PROMPT_FAILED',
            'MAIN_SETTINGS_OPERATION_FAILED',
            'MAIN_DETACHED_PROCESS_FAILED',
            'MAIN_WORKER_TASK_FAILED',
            'MAIN_WINDOW_OPERATION_FAILED',
            'MAIN_WORKSPACE_CHECKPOINT_FAILED',
            'MAIN_PROCESS_RECOVERY_FAILED',
        ]);
        expect(Object.keys(DIAGNOSTIC_DEFINITIONS)).toEqual(DIAGNOSTIC_CODES);
        expect(Object.values(DIAGNOSTIC_DEFINITIONS).every(definition => (
            definition.grouping === 'code-and-top-frame'
            && (definition.stackPolicy === 'source' || definition.stackPolicy === 'call-site')
            && !Object.hasOwn(definition, 'message')
        ))).toBe(true);
    });

    it('keeps synthetic Sentry event identity in the shared diagnostics registry', () => {
        expect(DIAGNOSTIC_EVENT_DEFINITIONS.SENTRY_SOURCE_MAP_CANARY).toEqual({
            exceptionType: 'EVBViewerSourceMapCanary',
            exceptionValue: 'EVB Viewer source-map canary',
            fingerprintPrefix: 'evb-viewer-sourcemap-canary-v8',
            logger: 'evb-viewer.sourcemap-canary',
            tagKey: 'evb_canary',
            tagValue: 'sourcemap-v8',
        });
    });

    it('decodes only the bounded context declared by the registry', () => {
        expect(decodeDiagnosticContext('UNCLASSIFIED_RENDERER_ERROR', {
            phase: 'bootstrap',
            attempt: 0,
            recovered: true,
        })).toEqual({
            phase: 'bootstrap',
            attempt: 0,
            recovered: true,
        });
        expect(decodeDiagnosticContext('UNCLASSIFIED_RENDERER_ERROR', {phase: 'invalid'})).toBeNull();
        expect(decodeDiagnosticContext('UNCLASSIFIED_RENDERER_ERROR', {attempt: 101})).toBeNull();
        expect(decodeDiagnosticContext('UNCLASSIFIED_RENDERER_ERROR', {attempt: Number.POSITIVE_INFINITY})).toBeNull();
        expect(decodeDiagnosticContext('UNCLASSIFIED_RENDERER_ERROR', {unexpected: true})).toBeNull();
        expect(decodeDiagnosticContext('MAIN_STARTUP_CRASH', {attempt: 1})).toBeNull();
    });

    it('decodes the bounded context for remaining Electron main failure owners', () => {
        expect(decodeDiagnosticContext('MAIN_EXTERNAL_OPEN_FAILED', {phase: 'prepare-window'})).toEqual({phase: 'prepare-window'});
        expect(decodeDiagnosticContext('MAIN_CODEX_MCP_INTEGRATION_FAILED', {action: 'disable'})).toEqual({action: 'disable'});
        expect(decodeDiagnosticContext('MAIN_CODEX_MCP_INTEGRATION_FAILED', {action: 'start'})).toBeNull();
        expect(decodeDiagnosticContext('MAIN_ELECTRON_LOCALE_LOAD_FAILED', {locale: 'pt-BR'})).toEqual({locale: 'pt-BR'});
        expect(decodeDiagnosticContext('MAIN_ELECTRON_LOCALE_LOAD_FAILED', {locale: 'ja'})).toBeNull();
        expect(decodeDiagnosticContext('MAIN_RECENT_FILES_LOAD_FAILED', {phase: 'parse'})).toEqual({phase: 'parse'});
        expect(decodeDiagnosticContext('MAIN_UPDATE_CHECK_FAILED', {origin: 'manual'})).toEqual({origin: 'manual'});
        expect(decodeDiagnosticContext('MAIN_UPDATE_STARTUP_FAILED', {
            phase: 'renderer-readiness',
            attempt: 3,
        })).toEqual({
            phase: 'renderer-readiness',
            attempt: 3,
        });
        expect(decodeDiagnosticContext('MAIN_UPDATE_STARTUP_FAILED', {
            phase: 'renderer-readiness',
            attempt: 0,
        })).toBeNull();
        expect(decodeDiagnosticContext('MAIN_UPDATE_STARTUP_FAILED', {
            phase: 'renderer-readiness',
            attempt: 101,
        })).toBeNull();
    });

    it('keeps renderer failure contexts bounded to their owning operation', () => {
        expect(decodeDiagnosticContext('RENDERER_NATIVE_PDF_VIEWER_FAILED', {phase: 'resume'})).toEqual({phase: 'resume'});
        expect(decodeDiagnosticContext('RENDERER_NATIVE_PDF_VIEWER_FAILED', {phase: 'load'})).toBeNull();
        expect(decodeDiagnosticContext('RENDERER_ERROR_GUARD_FAILED', {source: 'window'})).toEqual({source: 'window'});
        expect(decodeDiagnosticContext('RENDERER_ERROR_GUARD_FAILED', {source: 'console'})).toBeNull();
        expect(decodeDiagnosticContext('RENDERER_RUNTIME_ERROR_LOG_STREAM_FAILED', {phase: 'legacy-error-projection'})).toEqual({phase: 'legacy-error-projection'});
        expect(decodeDiagnosticContext('RENDERER_RUNTIME_ERROR_LOG_STREAM_FAILED', {phase: 'subscription-initialization'})).toEqual({phase: 'subscription-initialization'});
        expect(decodeDiagnosticContext('RENDERER_PDF_INITIAL_RENDER_RECOVERY_FAILED', {phase: 'coordinate'})).toEqual({phase: 'coordinate'});
        expect(decodeDiagnosticContext('RENDERER_PDF_SEARCH_OPERATION_FAILED', {operation: 'scroll-current-match'})).toEqual({operation: 'scroll-current-match'});
        expect(decodeDiagnosticContext('RENDERER_PDF_SEARCH_OPERATION_FAILED', {operation: 'search-all'})).toBeNull();
        expect(decodeDiagnosticContext('RENDERER_ASYNC_GUARD_FAILED', {category: 'user-visible-operation'})).toEqual({category: 'user-visible-operation'});
        expect(decodeDiagnosticContext('RENDERER_ASYNC_GUARD_FAILED', {category: 'background-diagnostic'})).toBeNull();
        expect(decodeDiagnosticContext('RENDERER_OCR_RUN_FAILED', {requestId: 'private'})).toBeNull();
    });

    it('keeps process-death and recovery context closed and bounded', () => {
        expect(decodeDiagnosticContext('MAIN_CHILD_PROCESS_GONE', {
            processType: 'utility',
            reason: 'crashed',
            exitCode: 9,
        })).toEqual({
            processType: 'utility',
            reason: 'crashed',
            exitCode: 9,
        });
        expect(decodeDiagnosticContext('MAIN_CHILD_PROCESS_GONE', {
            processType: 'Utility',
            reason: 'crashed',
            exitCode: 9,
        })).toBeNull();
        expect(decodeDiagnosticContext('MAIN_RENDERER_PROCESS_GONE', {
            reason: 'oom',
            exitCode: 255,
        })).toEqual({
            reason: 'oom',
            exitCode: 255,
        });
        expect(decodeDiagnosticContext('MAIN_RENDERER_PROCESS_GONE', {
            reason: 'oom',
            exitCode: 256,
        })).toBeNull();
        expect(decodeDiagnosticContext('MAIN_PRELOAD_ERROR', {hasStack: true})).toEqual({hasStack: true});
        expect(decodeDiagnosticContext('MAIN_UNRESPONSIVE_RENDERER', {
            automated: true,
            recoveryAttempt: 0,
        })).toEqual({
            automated: true,
            recoveryAttempt: 0,
        });
        expect(decodeDiagnosticContext('MAIN_RENDERER_RECOVERY_FAILED', {
            trigger: 'renderer-gone',
            recoveryAttempt: 3,
        })).toEqual({
            trigger: 'renderer-gone',
            recoveryAttempt: 3,
        });
        expect(decodeDiagnosticContext('MAIN_RENDERER_RECOVERY_FAILED', {
            trigger: 'renderer-gone',
            recoveryAttempt: 0,
        })).toBeNull();
        expect(decodeDiagnosticContext('MAIN_UNRESPONSIVE_RECOVERY_FAILED', {
            trigger: 'unresponsive-automation',
            recoveryAttempt: 1,
        })).toEqual({
            trigger: 'unresponsive-automation',
            recoveryAttempt: 1,
        });
        expect(decodeDiagnosticContext('MAIN_UNRESPONSIVE_RECOVERY_FAILED', {
            trigger: 'renderer-gone',
            recoveryAttempt: 1,
        })).toBeNull();
        expect(decodeDiagnosticContext('MAIN_PRELOAD_ERROR', {
            hasStack: true,
            preloadPath: '/private/secret/preload.cjs',
        })).toBeNull();
        expect(decodeDiagnosticContext('MAIN_GPU_SAFE_MODE_RECOVERY', {
            safeMode: false,
            action: 'relaunch',
            crashCount: 2,
        })).toEqual({
            safeMode: false,
            action: 'relaunch',
            crashCount: 2,
        });
        expect(decodeDiagnosticContext('MAIN_GPU_SAFE_MODE_RECOVERY', {
            safeMode: false,
            action: 'relaunch',
            crashCount: 101,
        })).toBeNull();
        expect(decodeDiagnosticContext('MAIN_UNHANDLED_REJECTION', {subsystem: 'search'})).toEqual({subsystem: 'search'});
        expect(decodeDiagnosticContext('MAIN_UNHANDLED_REJECTION_RECOVERY', {subsystem: 'unknown'})).toEqual({subsystem: 'unknown'});
    });

    it('creates unique lowercase 128-bit occurrence IDs', () => {
        const ids = Array.from({length: 128}, () => createDiagnosticEventId());
        expect(new Set(ids).size).toBe(ids.length);
        expect(ids.every(id => /^[0-9a-f]{32}$/u.test(id))).toBe(true);
    });

    it.each([
        '',
        'A'.repeat(32),
        'a'.repeat(31),
        'a'.repeat(33),
        `${'a'.repeat(31)}g`,
        ' a'.repeat(16),
        null,
        42,
    ])('rejects malformed event ID %s', value => {
        expect(parseDiagnosticEventId(value)).toBeNull();
    });

    it('strictly decodes and rebuilds a diagnostic record', () => {
        const decoded = decodeDiagnosticRecord(BASE_RECORD);
        expect(decoded).toEqual(BASE_RECORD);
        expect(decoded).not.toBe(BASE_RECORD);
        expect(decoded?.frames).not.toBe(BASE_RECORD.frames);
        expect(decoded?.context).not.toBe(BASE_RECORD.context);
    });

    it.each([
        [
            'schemaVersion',
            {
                ...BASE_RECORD,
                schemaVersion: 2,
            },
        ],
        [
            'extra key',
            {
                ...BASE_RECORD,
                extra: true,
            },
        ],
        [
            'event ID',
            {
                ...BASE_RECORD,
                eventId: 'not-an-event-id',
            },
        ],
        [
            'code',
            {
                ...BASE_RECORD,
                code: 'UNKNOWN_CODE',
            },
        ],
        [
            'severity',
            {
                ...BASE_RECORD,
                severity: 'warning',
            },
        ],
        [
            'runtime',
            {
                ...BASE_RECORD,
                runtime: 'unknown-runtime',
            },
        ],
        [
            'operation',
            {
                ...BASE_RECORD,
                operation: 'unknown-operation',
            },
        ],
        [
            'timestamp',
            {
                ...BASE_RECORD,
                occurredAt: Number.NaN,
            },
        ],
        [
            'context',
            {
                ...BASE_RECORD,
                context: {
                    phase: 'operation',
                    unexpected: true,
                },
            },
        ],
        [
            'frame',
            {
                ...BASE_RECORD,
                frames: [{
                    ...BASE_FRAME,
                    module: '/Users/example/private.ts',
                }],
            },
        ],
        [
            'frame extra key',
            {
                ...BASE_RECORD,
                frames: [{
                    ...BASE_FRAME,
                    raw: 'raw stack',
                }],
            },
        ],
    ])('rejects malformed record: %s', (_label, value) => {
        expect(decodeDiagnosticRecord(value)).toBeNull();
    });

    it('rejects oversized and sparse frame arrays', () => {
        const oversized = {
            ...BASE_RECORD,
            frames: Array.from({length: MAX_DIAGNOSTIC_RECORD_FRAMES + 1}, () => BASE_FRAME),
        };
        expect(decodeDiagnosticRecord(oversized)).toBeNull();

        const sparse = [BASE_FRAME] as Array<typeof BASE_FRAME | undefined>;
        sparse.length = 2;
        expect(decodeDiagnosticRecord({
            ...BASE_RECORD,
            frames: sparse,
        })).toBeNull();

        const augmented = [BASE_FRAME];
        Object.assign(augmented, {unexpected: true});
        expect(decodeDiagnosticRecord({
            ...BASE_RECORD,
            frames: augmented,
        })).toBeNull();
    });

    it('rejects partial, corrupt, and extra-field startup markers', () => {
        const marker: StartupCrashMarkerRecord = {
            schemaVersion: STARTUP_CRASH_MARKER_SCHEMA_VERSION,
            eventId: VALID_EVENT_ID,
            code: 'MAIN_STARTUP_CRASH',
            frames: [BASE_FRAME],
            timestamp: requireEpochMs(1_757_000_000_000),
            release: 'evb-viewer-desktop@0.1.449',
            dist: 'macos-arm64',
        };
        expect(decodeStartupCrashMarkerRecord(marker)).toEqual(marker);
        expect(decodeStartupCrashMarkerRecord(marker)).not.toBe(marker);
        expect(decodeStartupCrashMarkerRecord(marker)?.frames).not.toBe(marker.frames);
        expect(decodeStartupCrashMarkerRecord({
            ...marker,
            message: 'forbidden',
        })).toBeNull();
        expect(decodeStartupCrashMarkerRecord({
            ...marker,
            schemaVersion: 2,
        })).toBeNull();
        expect(decodeStartupCrashMarkerRecord({
            ...marker,
            code: 'UNCLASSIFIED_MAIN_ERROR',
        })).toBeNull();
        expect(decodeStartupCrashMarkerRecord({
            ...marker,
            release: '/Users/private',
        })).toBeNull();
        expect(decodeStartupCrashMarkerRecord({
            ...marker,
            dist: 'linux/x64',
        })).toBeNull();
        expect(decodeStartupCrashMarkerRecord({eventId: VALID_EVENT_ID})).toBeNull();
    });

    it('keeps local failure details out of the transport record type', () => {
        type IsAssignable<TFrom, TTo> = [TFrom] extends [TTo] ? true : false;
        type HasLocalDetail = 'local' extends keyof DiagnosticRecord ? true : false;
        expectTypeOf<IsAssignable<FailureReceipt, ExpectedOutcome>>().toEqualTypeOf<false>();
        expectTypeOf<IsAssignable<ExpectedOutcome, FailureReceipt>>().toEqualTypeOf<false>();
        expectTypeOf<HasLocalDetail>().toEqualTypeOf<false>();
        expectTypeOf<LocalFailureDetail>().toMatchTypeOf<{
            source: string;
            message: string;
        }>();
        expect(isExpectedOutcome({
            kind: 'expected',
            code: 'canceled',
        })).toBe(true);
        expect(isExpectedOutcome({
            kind: 'expected',
            code: 'unknown',
        })).toBe(false);
        expect(isExpectedOutcome({
            kind: 'expected',
            code: 'canceled',
            extra: true,
        })).toBe(false);
    });

    it('strictly decodes direct and embedded failure receipts', () => {
        const receipt: FailureReceipt = {
            eventId: VALID_EVENT_ID,
            code: 'UNCLASSIFIED_RENDERER_ERROR',
            occurredAt: requireEpochMs(1_757_000_000_000),
            severity: 'error',
        };

        expect(decodeFailureReceipt(receipt)).toEqual(receipt);
        expect(decodeFailureReceipt(receipt)).not.toBe(receipt);
        expect(getFailureReceipt({failure: receipt})).toEqual(receipt);
        expect(getFailureReceipt({failure: {
            ...receipt,
            raw: 'forbidden',
        }})).toBeUndefined();
        expect(getFailureReceipt({failure: {eventId: VALID_EVENT_ID}})).toBeUndefined();
        expect(getFailureReceipt(receipt)).toBeUndefined();
    });

    it('rejects forbidden sentinel values before the capture transport records them', () => {
        const locations = [
            'schemaVersion',
            'eventId',
            'code',
            'severity',
            'runtime',
            'operation',
            'occurredAt',
            'frames',
            'frame',
            'frame.module',
            'frame.function',
            'frame.line',
            'frame.column',
            'context',
            'context.phase',
            'context.attempt',
            'context.recovered',
        ] as const;
        const transport = createCaptureTransport<DiagnosticRecord>();

        fc.assert(fc.property(
            FORBIDDEN_VALUES,
            fc.constantFrom(...locations),
            (sentinel, location) => {
                const decoded = decodeDiagnosticRecord(assignForbiddenValue(location, sentinel));
                if (decoded !== null) {
                    transport.send(decoded);
                }
                expect(transport.events).toHaveLength(0);
            },
        ));
    });

    it('rejects forbidden marker values at every persisted string field', () => {
        const transport = createCaptureTransport<StartupCrashMarkerRecord>();
        fc.assert(fc.property(
            FORBIDDEN_VALUES,
            fc.constantFrom('schemaVersion', 'eventId', 'code', 'frames', 'frame', 'timestamp', 'release', 'dist'),
            (sentinel, field) => {
                const marker: Record<string, unknown> = {
                    schemaVersion: STARTUP_CRASH_MARKER_SCHEMA_VERSION,
                    eventId: VALID_EVENT_ID,
                    code: 'MAIN_STARTUP_CRASH',
                    frames: [BASE_FRAME],
                    timestamp: 1_757_000_000_000,
                    release: 'evb-viewer-desktop@0.1.449',
                    dist: 'macos-arm64',
                };
                if (field === 'frame') {
                    (marker.frames as unknown[])[0] = sentinel;
                } else if (field === 'frames') {
                    marker.frames = sentinel;
                } else {
                    marker[field] = sentinel;
                }
                const decoded = decodeStartupCrashMarkerRecord(marker);
                if (decoded !== null) {
                    transport.capture(decoded);
                }
                expect(transport.events).toHaveLength(0);
            },
        ));
    });

    it('type-checks only known codes and context keys', () => {
        type RendererContext = DiagnosticContext<'UNCLASSIFIED_RENDERER_ERROR'>;
        type UnknownCode = Extract<'UNKNOWN_CODE', DiagnosticCode>;
        expectTypeOf<UnknownCode>().toEqualTypeOf<never>();
        expectTypeOf<RendererContext>().toMatchTypeOf<{
            phase?: 'bootstrap' | 'operation' | 'shutdown';
            attempt?: number;
            recovered?: boolean;
        }>();

        const validInput: CaptureFailureInput<'UNCLASSIFIED_RENDERER_ERROR'> = {
            code: 'UNCLASSIFIED_RENDERER_ERROR',
            context: {},
            local: {
                source: 'test',
                message: 'local-only detail',
            },
        };
        expect(validInput.code).toBe('UNCLASSIFIED_RENDERER_ERROR');
    });
});

// @ts-expect-error DiagnosticContext only accepts keys from the closed registry.
const _UNKNOWN_CONTEXT_KEY: DiagnosticContext<'UNCLASSIFIED_RENDERER_ERROR'> = {unknown: true};

// @ts-expect-error DiagnosticCode is derived from DIAGNOSTIC_DEFINITIONS.
const _UNKNOWN_CODE: DiagnosticCode = 'UNKNOWN_CODE';

// @ts-expect-error Empty startup context accepts no arbitrary keys.
const _UNKNOWN_STARTUP_CONTEXT: DiagnosticContext<'MAIN_STARTUP_CRASH'> = {attempt: 1};
