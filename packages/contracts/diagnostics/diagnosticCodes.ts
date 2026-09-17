/* eslint-disable @typescript-eslint/naming-convention */

export {DIAGNOSTIC_EVENT_DEFINITIONS} from './diagnosticEventDefinitions.js';

export const DIAGNOSTIC_OPERATIONS = [
    'renderer-error',
    'main-error',
    'console-error',
    'startup-crash',
] as const;

export type DiagnosticOperation = typeof DIAGNOSTIC_OPERATIONS[number];

export const DIAGNOSTIC_GROUPING_POLICIES = ['code-and-top-frame'] as const;

export type DiagnosticGroupingPolicy = typeof DIAGNOSTIC_GROUPING_POLICIES[number];

export const DIAGNOSTIC_STACK_POLICIES = [
    'source',
    'call-site',
] as const;

export type DiagnosticStackPolicy = typeof DIAGNOSTIC_STACK_POLICIES[number];

export type DiagnosticContextFieldDefinition =
    | {
        readonly kind: 'enum';
        readonly values: readonly string[];
    }
    | {readonly kind: 'boolean';}
    | {
        readonly kind: 'integer';
        readonly min: number;
        readonly max: number;
    };

export type DiagnosticContextDefinition = Readonly<Record<
    string,
    DiagnosticContextFieldDefinition
>>;

export interface IDiagnosticDefinition<
    TContext extends DiagnosticContextDefinition = DiagnosticContextDefinition,
> {
    readonly exceptionType: string;
    readonly exceptionValue: string;
    readonly operation: DiagnosticOperation;
    readonly defaultSeverity: 'error' | 'fatal';
    readonly grouping: DiagnosticGroupingPolicy;
    readonly stackPolicy: DiagnosticStackPolicy;
    readonly context: TContext;
}

const MAX_DIAGNOSTIC_ATTEMPT = 100;

const GENERIC_DIAGNOSTIC_CONTEXT = {
    phase: {
        kind: 'enum',
        values: [
            'bootstrap',
            'operation',
            'shutdown',
        ],
    },
    attempt: {
        kind: 'integer',
        min: 0,
        max: MAX_DIAGNOSTIC_ATTEMPT,
    },
    recovered: {kind: 'boolean'},
} as const satisfies DiagnosticContextDefinition;

const NATIVE_PDF_VIEWER_PHASES = [
    'initialize',
    'resume',
] as const;

const PDF_RECOVERY_PHASES = [
    'render',
    'coordinate',
] as const;

const PDF_SEARCH_OPERATIONS = [
    'apply-highlights',
    'scroll-current-match',
] as const;

const ASYNC_GUARD_CATEGORIES = ['user-visible-operation'] as const;

const RENDERER_ERROR_GUARD_SOURCES = [
    'vue',
    'window',
    'unhandled-rejection',
] as const;

const RUNTIME_ERROR_LOG_STREAM_PHASES = [
    'legacy-error-projection',
    'subscription-initialization',
] as const;

export const SCAN_CLEANUP_DIAGNOSTIC_STAGES = [
    'renderer-settings',
    'renderer-run',
    'renderer-result',
    'job-service',
    'detection',
    'preview-composition',
    'retention-io',
    'preview-rendering',
    'worker-task',
    'worker',
] as const;

export type TScanCleanupDiagnosticStage = typeof SCAN_CLEANUP_DIAGNOSTIC_STAGES[number];

export const SCAN_CLEANUP_DIAGNOSTIC_ERROR_CODES = [
    'unknown',
    'SCAN_CLEANUP_OUTPUT_MISSING',
    'SCAN_CLEANUP_PDF_VALIDATION_FAILED',
    'SCAN_CLEANUP_CONTRACT_VIOLATION',
    'SCAN_CLEANUP_STREAMING_EVIDENCE_INVALID',
    'SCAN_CLEANUP_INVALID_PAGE_SCOPE',
    'encrypted',
    'needs-password',
    'too-large',
    'corrupt-xref',
    'unsupported-filter',
    'invalid-request',
    'io',
    'timeout',
    'panic',
    'native-failure',
    'tools-unavailable',
    'insufficient-scratch',
    'canceled',
    'detection-results-unavailable',
    'internal',
] as const;

export type TScanCleanupDiagnosticErrorCode = typeof SCAN_CLEANUP_DIAGNOSTIC_ERROR_CODES[number];

const SCAN_CLEANUP_INTERNAL_DIAGNOSTIC_ERROR_CODES = [
    'SCAN_CLEANUP_OUTPUT_MISSING',
    'SCAN_CLEANUP_PDF_VALIDATION_FAILED',
    'SCAN_CLEANUP_CONTRACT_VIOLATION',
    'SCAN_CLEANUP_STREAMING_EVIDENCE_INVALID',
] as const;

const SCAN_CLEANUP_DOCUMENT_DIAGNOSTIC_ERROR_CODES = [
    'SCAN_CLEANUP_INVALID_PAGE_SCOPE',
    'encrypted',
    'needs-password',
    'too-large',
    'corrupt-xref',
    'unsupported-filter',
    'invalid-request',
] as const;

export type TScanCleanupDiagnosticFailureClass =
    | 'internal-invariant'
    | 'user-document'
    | 'native-runtime'
    | 'unknown';

export function getScanCleanupDiagnosticErrorCode(value: unknown): TScanCleanupDiagnosticErrorCode {
    const candidate = value !== null && typeof value === 'object' && 'code' in value
        ? (value as {code?: unknown}).code
        : value;
    return typeof candidate === 'string'
        && SCAN_CLEANUP_DIAGNOSTIC_ERROR_CODES.some(code => code === candidate)
        ? candidate as TScanCleanupDiagnosticErrorCode
        : 'unknown';
}

export function getScanCleanupDiagnosticFailureClass(value: unknown): TScanCleanupDiagnosticFailureClass {
    const code = getScanCleanupDiagnosticErrorCode(value);
    if (SCAN_CLEANUP_INTERNAL_DIAGNOSTIC_ERROR_CODES.some(candidate => candidate === code)) {
        return 'internal-invariant';
    }
    if (SCAN_CLEANUP_DOCUMENT_DIAGNOSTIC_ERROR_CODES.some(candidate => candidate === code)) {
        return 'user-document';
    }
    if (code !== 'unknown') {
        return 'native-runtime';
    }
    return 'unknown';
}

const SCAN_CLEANUP_DIAGNOSTIC_CONTEXT = {
    stage: {
        kind: 'enum',
        values: SCAN_CLEANUP_DIAGNOSTIC_STAGES,
    },
    errorCode: {
        kind: 'enum',
        values: SCAN_CLEANUP_DIAGNOSTIC_ERROR_CODES,
    },
    failureClass: {
        kind: 'enum',
        values: [
            'internal-invariant',
            'user-document',
            'native-runtime',
            'unknown',
        ],
    },
} as const satisfies DiagnosticContextDefinition;

export const PROCESS_GONE_TYPES = [
    'gpu',
    'utility',
    'renderer',
    'zygote',
    'sandbox-helper',
    'pepper-plugin',
    'pepper-plugin-broker',
    'other',
] as const;

const PROCESS_GONE_TYPE_BY_ELECTRON_TYPE: Readonly<Record<string, typeof PROCESS_GONE_TYPES[number]>> = {
    GPU: 'gpu',
    Utility: 'utility',
    Renderer: 'renderer',
    Zygote: 'zygote',
    'Sandbox helper': 'sandbox-helper',
    'Pepper Plugin': 'pepper-plugin',
    'Pepper Plugin Broker': 'pepper-plugin-broker',
};

export const PROCESS_GONE_REASONS = [
    'clean-exit',
    'abnormal-exit',
    'killed',
    'crashed',
    'oom',
    'launch-failed',
    'integrity-failure',
    'other',
] as const;

export const PROCESS_GONE_EXIT_CODE_MIN = -1;
export const PROCESS_GONE_EXIT_CODE_MAX = 255;
export const MAX_RENDERER_RECOVERY_ATTEMPTS = 3;
export const GPU_SAFE_MODE_CRASH_COUNT_MIN = 2;
export const GPU_SAFE_MODE_CRASH_COUNT_MAX = 100;

const RENDERER_RECOVERY_TRIGGERS = [
    'renderer-gone',
    'unresponsive-automation',
    'unresponsive-dialog-reload',
    'unresponsive-dialog-fallback',
] as const;

const UNRESPONSIVE_RECOVERY_TRIGGERS = [
    'unresponsive-automation',
    'unresponsive-dialog-reload',
    'unresponsive-dialog-fallback',
    'unresponsive-dialog-prompt',
] as const;

const UNHANDLED_REJECTION_SUBSYSTEMS = [
    'agent',
    'djvu',
    'documents',
    'ocr',
    'search',
    'unknown',
] as const;

const CHILD_PROCESS_GONE_CONTEXT = {
    processType: {
        kind: 'enum',
        values: PROCESS_GONE_TYPES,
    },
    reason: {
        kind: 'enum',
        values: PROCESS_GONE_REASONS,
    },
    exitCode: {
        kind: 'integer',
        min: PROCESS_GONE_EXIT_CODE_MIN,
        max: PROCESS_GONE_EXIT_CODE_MAX,
    },
} as const satisfies DiagnosticContextDefinition;

const RENDERER_PROCESS_GONE_CONTEXT = {
    reason: {
        kind: 'enum',
        values: PROCESS_GONE_REASONS,
    },
    exitCode: {
        kind: 'integer',
        min: PROCESS_GONE_EXIT_CODE_MIN,
        max: PROCESS_GONE_EXIT_CODE_MAX,
    },
} as const satisfies DiagnosticContextDefinition;

const RENDERER_RECOVERY_CONTEXT = {
    trigger: {
        kind: 'enum',
        values: RENDERER_RECOVERY_TRIGGERS,
    },
    recoveryAttempt: {
        kind: 'integer',
        min: 1,
        max: MAX_RENDERER_RECOVERY_ATTEMPTS,
    },
} as const satisfies DiagnosticContextDefinition;

const UNRESPONSIVE_RENDERER_CONTEXT = {
    automated: {kind: 'boolean'},
    recoveryAttempt: {
        kind: 'integer',
        min: 0,
        max: MAX_RENDERER_RECOVERY_ATTEMPTS,
    },
} as const satisfies DiagnosticContextDefinition;

const UNHANDLED_REJECTION_CONTEXT = {subsystem: {
    kind: 'enum',
    values: UNHANDLED_REJECTION_SUBSYSTEMS,
}} as const satisfies DiagnosticContextDefinition;

const UNRESPONSIVE_RECOVERY_CONTEXT = {
    trigger: {
        kind: 'enum',
        values: UNRESPONSIVE_RECOVERY_TRIGGERS,
    },
    recoveryAttempt: {
        kind: 'integer',
        min: 1,
        max: MAX_RENDERER_RECOVERY_ATTEMPTS,
    },
} as const satisfies DiagnosticContextDefinition;

const ASSISTANT_FAILURE_ACTIONS = [
    'refresh',
    'install',
    'login',
    'cancel',
    'switch-provider',
    'load',
    'scope-refresh',
    'send',
    'retry',
    'interrupt',
    'reset',
    'mcp-refresh',
    'mcp-update',
    'mcp-install',
] as const;

const UPDATE_FAILURE_ACTIONS = [
    'load',
    'check',
    'download',
    'install',
    'defer',
    'skip',
    'status',
] as const;

const ASSISTANT_FAILURE_CONTEXT = {action: {
    kind: 'enum',
    values: ASSISTANT_FAILURE_ACTIONS,
}} as const satisfies DiagnosticContextDefinition;

const UPDATE_FAILURE_CONTEXT = {action: {
    kind: 'enum',
    values: UPDATE_FAILURE_ACTIONS,
}} as const satisfies DiagnosticContextDefinition;

const MAIN_LOCALE_CODES = [
    'en',
    'ru',
    'fr',
    'de',
    'es',
    'it',
    'pt',
    'pt-BR',
    'nl',
] as const;

const EXTERNAL_OPEN_CONTEXT = {phase: {
    kind: 'enum',
    values: ['prepare-window'],
}} as const satisfies DiagnosticContextDefinition;

const CODEX_MCP_INTEGRATION_CONTEXT = {action: {
    kind: 'enum',
    values: [
        'enable',
        'disable',
    ],
}} as const satisfies DiagnosticContextDefinition;

const ELECTRON_LOCALE_LOAD_CONTEXT = {locale: {
    kind: 'enum',
    values: MAIN_LOCALE_CODES,
}} as const satisfies DiagnosticContextDefinition;

const RECENT_FILES_LOAD_CONTEXT = {phase: {
    kind: 'enum',
    values: [
        'read',
        'parse',
    ],
}} as const satisfies DiagnosticContextDefinition;

const UPDATE_CHECK_CONTEXT = {origin: {
    kind: 'enum',
    values: [
        'auto',
        'manual',
    ],
}} as const satisfies DiagnosticContextDefinition;

const UPDATE_STARTUP_CONTEXT = {
    phase: {
        kind: 'enum',
        values: [
            'installation',
            'renderer-readiness',
        ],
    },
    attempt: {
        kind: 'integer',
        min: 1,
        max: MAX_DIAGNOSTIC_ATTEMPT,
    },
} as const satisfies DiagnosticContextDefinition;

const NATIVE_PDF_VIEWER_CONTEXT = {phase: {
    kind: 'enum',
    values: NATIVE_PDF_VIEWER_PHASES,
}} as const satisfies DiagnosticContextDefinition;

const PDF_RECOVERY_CONTEXT = {phase: {
    kind: 'enum',
    values: PDF_RECOVERY_PHASES,
}} as const satisfies DiagnosticContextDefinition;

const PDF_SEARCH_CONTEXT = {operation: {
    kind: 'enum',
    values: PDF_SEARCH_OPERATIONS,
}} as const satisfies DiagnosticContextDefinition;

const ASYNC_GUARD_CONTEXT = {category: {
    kind: 'enum',
    values: ASYNC_GUARD_CATEGORIES,
}} as const satisfies DiagnosticContextDefinition;

const RENDERER_ERROR_GUARD_CONTEXT = {source: {
    kind: 'enum',
    values: RENDERER_ERROR_GUARD_SOURCES,
}} as const satisfies DiagnosticContextDefinition;

const RUNTIME_ERROR_LOG_STREAM_CONTEXT = {phase: {
    kind: 'enum',
    values: RUNTIME_ERROR_LOG_STREAM_PHASES,
}} as const satisfies DiagnosticContextDefinition;

export function normalizeProcessGoneReason(reason: string) {
    return PROCESS_GONE_REASONS.find(candidate => candidate === reason) ?? 'other';
}

export function normalizeProcessGoneType(type: string) {
    return PROCESS_GONE_TYPE_BY_ELECTRON_TYPE[type] ?? 'other';
}

export function normalizeProcessGoneExitCode(exitCode: number) {
    return Number.isSafeInteger(exitCode)
        && exitCode >= PROCESS_GONE_EXIT_CODE_MIN
        && exitCode <= PROCESS_GONE_EXIT_CODE_MAX
        ? exitCode
        : undefined;
}

export function normalizeDiagnosticAttempt(attempt: number) {
    if (!Number.isSafeInteger(attempt)) {
        return 1;
    }
    return Math.min(MAX_DIAGNOSTIC_ATTEMPT, Math.max(1, attempt));
}

export const DIAGNOSTIC_DEFINITIONS = {
    UNCLASSIFIED_RENDERER_ERROR: {
        exceptionType: 'RendererDiagnosticError',
        exceptionValue: 'Unclassified renderer error',
        operation: 'renderer-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'call-site',
        context: GENERIC_DIAGNOSTIC_CONTEXT,
    },
    RENDERER_ERROR_GUARD_FAILED: {
        exceptionType: 'RendererErrorGuardFailed',
        exceptionValue: 'Renderer error guard failed',
        operation: 'renderer-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'call-site',
        context: RENDERER_ERROR_GUARD_CONTEXT,
    },
    RENDERER_RUNTIME_ERROR_LOG_STREAM_FAILED: {
        exceptionType: 'RendererRuntimeErrorLogStreamFailed',
        exceptionValue: 'Renderer runtime error log stream failed',
        operation: 'renderer-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'call-site',
        context: RUNTIME_ERROR_LOG_STREAM_CONTEXT,
    },
    UNCLASSIFIED_MAIN_ERROR: {
        exceptionType: 'MainDiagnosticError',
        exceptionValue: 'Unclassified main error',
        operation: 'main-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'call-site',
        context: GENERIC_DIAGNOSTIC_CONTEXT,
    },
    UNCLASSIFIED_CONSOLE_ERROR: {
        exceptionType: 'ConsoleDiagnosticError',
        exceptionValue: 'Unclassified console error',
        operation: 'console-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'call-site',
        context: GENERIC_DIAGNOSTIC_CONTEXT,
    },
    NITRO_ANALYTICS_DATABASE_INITIALIZATION_FAILED: {
        exceptionType: 'NitroAnalyticsDatabaseInitializationFailure',
        exceptionValue: 'Analytics database initialization failed',
        operation: 'main-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'source',
        context: {},
    },
    NITRO_ANALYTICS_INSERT_FAILED: {
        exceptionType: 'NitroAnalyticsInsertFailure',
        exceptionValue: 'Analytics event storage failed',
        operation: 'main-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'source',
        context: {},
    },
    RENDERER_OCR_BACKEND_FAILED: {
        exceptionType: 'RendererOcrBackendFailed',
        exceptionValue: 'Renderer OCR backend failed',
        operation: 'renderer-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'call-site',
        context: {},
    },
    RENDERER_OCR_RUN_FAILED: {
        exceptionType: 'RendererOcrRunFailed',
        exceptionValue: 'Renderer OCR run failed',
        operation: 'renderer-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'call-site',
        context: {},
    },
    RENDERER_NATIVE_PDF_VIEWER_FAILED: {
        exceptionType: 'RendererNativePdfViewerFailed',
        exceptionValue: 'Renderer native PDF viewer failed',
        operation: 'renderer-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'call-site',
        context: NATIVE_PDF_VIEWER_CONTEXT,
    },
    RENDERER_PDF_OUTLINE_LOAD_FAILED: {
        exceptionType: 'RendererPdfOutlineLoadFailed',
        exceptionValue: 'Renderer PDF outline load failed',
        operation: 'renderer-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'call-site',
        context: {},
    },
    RENDERER_PDF_RANGE_READ_FAILED: {
        exceptionType: 'RendererPdfRangeReadFailed',
        exceptionValue: 'Renderer PDF range read failed',
        operation: 'renderer-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'call-site',
        context: {},
    },
    RENDERER_PDF_IMAGE_RASTERIZATION_FAILED: {
        exceptionType: 'RendererPdfImageRasterizationFailed',
        exceptionValue: 'Renderer PDF image rasterization failed',
        operation: 'renderer-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'call-site',
        context: {},
    },
    RENDERER_PDF_INITIAL_RENDER_RECOVERY_FAILED: {
        exceptionType: 'RendererPdfInitialRenderRecoveryFailed',
        exceptionValue: 'Renderer PDF initial-render recovery failed',
        operation: 'renderer-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'call-site',
        context: PDF_RECOVERY_CONTEXT,
    },
    RENDERER_PDF_PAGE_RENDER_FAILED: {
        exceptionType: 'RendererPdfPageRenderFailed',
        exceptionValue: 'Renderer PDF page render failed',
        operation: 'renderer-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'call-site',
        context: {},
    },
    RENDERER_PDF_SEARCH_OPERATION_FAILED: {
        exceptionType: 'RendererPdfSearchOperationFailed',
        exceptionValue: 'Renderer PDF search operation failed',
        operation: 'renderer-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'call-site',
        context: PDF_SEARCH_CONTEXT,
    },
    RENDERER_PDF_VIEWPORT_PLACEMENT_FAILED: {
        exceptionType: 'RendererPdfViewportPlacementFailed',
        exceptionValue: 'Renderer PDF viewport placement failed',
        operation: 'renderer-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'call-site',
        context: {},
    },
    RENDERER_PDF_DOCUMENT_LOAD_FAILED: {
        exceptionType: 'RendererPdfDocumentLoadFailed',
        exceptionValue: 'Renderer PDF document load failed',
        operation: 'renderer-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'call-site',
        context: {},
    },
    RENDERER_BROWSER_EVENT_SUBSCRIPTION_FAILED: {
        exceptionType: 'RendererBrowserEventSubscriptionFailed',
        exceptionValue: 'Renderer browser event subscription failed',
        operation: 'renderer-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'call-site',
        context: {},
    },
    RENDERER_IPC_EVENT_DECODE_FAILED: {
        exceptionType: 'RendererIpcEventDecodeFailed',
        exceptionValue: 'Renderer IPC event decode failed',
        operation: 'renderer-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'call-site',
        context: {},
    },
    RENDERER_ASYNC_GUARD_FAILED: {
        exceptionType: 'RendererAsyncGuardFailed',
        exceptionValue: 'Renderer async guard failed',
        operation: 'renderer-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'call-site',
        context: ASYNC_GUARD_CONTEXT,
    },
    MAIN_STARTUP_CRASH: {
        exceptionType: 'MainStartupCrash',
        exceptionValue: 'Main startup crash',
        operation: 'startup-crash',
        defaultSeverity: 'fatal',
        grouping: 'code-and-top-frame',
        stackPolicy: 'source',
        context: {},
    },
    MAIN_CHILD_PROCESS_GONE: {
        exceptionType: 'MainChildProcessGone',
        exceptionValue: 'Main child process gone',
        operation: 'main-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'call-site',
        context: CHILD_PROCESS_GONE_CONTEXT,
    },
    MAIN_RENDERER_PROCESS_GONE: {
        exceptionType: 'MainRendererProcessGone',
        exceptionValue: 'Main renderer process gone',
        operation: 'main-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'call-site',
        context: RENDERER_PROCESS_GONE_CONTEXT,
    },
    MAIN_PRELOAD_ERROR: {
        exceptionType: 'MainPreloadError',
        exceptionValue: 'Main preload error',
        operation: 'main-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'call-site',
        context: {hasStack: {kind: 'boolean'}},
    },
    MAIN_UNRESPONSIVE_RENDERER: {
        exceptionType: 'MainUnresponsiveRenderer',
        exceptionValue: 'Main unresponsive renderer',
        operation: 'main-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'call-site',
        context: UNRESPONSIVE_RENDERER_CONTEXT,
    },
    MAIN_RENDERER_RECOVERY_FAILED: {
        exceptionType: 'MainRendererRecoveryFailed',
        exceptionValue: 'Main renderer recovery failed',
        operation: 'main-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'call-site',
        context: RENDERER_RECOVERY_CONTEXT,
    },
    MAIN_UNRESPONSIVE_RECOVERY_FAILED: {
        exceptionType: 'MainUnresponsiveRecoveryFailed',
        exceptionValue: 'Main unresponsive recovery failed',
        operation: 'main-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'call-site',
        context: UNRESPONSIVE_RECOVERY_CONTEXT,
    },
    MAIN_GPU_SAFE_MODE_RECOVERY: {
        exceptionType: 'MainGpuSafeModeRecovery',
        exceptionValue: 'Main GPU safe-mode recovery',
        operation: 'main-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'call-site',
        context: {
            safeMode: {kind: 'boolean'},
            action: {
                kind: 'enum',
                values: [
                    'relaunch',
                    'failed',
                ],
            },
            crashCount: {
                kind: 'integer',
                min: GPU_SAFE_MODE_CRASH_COUNT_MIN,
                max: GPU_SAFE_MODE_CRASH_COUNT_MAX,
            },
        },
    },
    MAIN_UNHANDLED_REJECTION: {
        exceptionType: 'MainUnhandledRejection',
        exceptionValue: 'Main unhandled promise rejection',
        operation: 'main-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'call-site',
        context: UNHANDLED_REJECTION_CONTEXT,
    },
    MAIN_UNHANDLED_REJECTION_RECOVERY: {
        exceptionType: 'MainUnhandledRejectionRecovery',
        exceptionValue: 'Main unhandled rejection subsystem recovery',
        operation: 'main-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'call-site',
        context: UNHANDLED_REJECTION_CONTEXT,
    },
    SETTINGS_LOAD_FAILED: {
        exceptionType: 'SettingsLoadFailed',
        exceptionValue: 'Settings load failed',
        operation: 'renderer-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'call-site',
        context: {},
    },
    MAIN_EXTERNAL_OPEN_FAILED: {
        exceptionType: 'MainExternalOpenFailed',
        exceptionValue: 'Main external open failed',
        operation: 'main-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'call-site',
        context: EXTERNAL_OPEN_CONTEXT,
    },
    MAIN_ATOMIC_REPLACE_RESTORE_FAILED: {
        exceptionType: 'MainAtomicReplaceRestoreFailed',
        exceptionValue: 'Main atomic replace restore failed',
        operation: 'main-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'call-site',
        context: {},
    },
    SETTINGS_SAVE_FAILED: {
        exceptionType: 'SettingsSaveFailed',
        exceptionValue: 'Settings save failed',
        operation: 'renderer-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'call-site',
        context: {},
    },
    MAIN_CODEX_MCP_INTEGRATION_FAILED: {
        exceptionType: 'MainCodexMcpIntegrationFailed',
        exceptionValue: 'Main Codex MCP integration failed',
        operation: 'main-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'call-site',
        context: CODEX_MCP_INTEGRATION_CONTEXT,
    },
    MAIN_DOCUMENT_REVEAL_FAILED: {
        exceptionType: 'MainDocumentRevealFailed',
        exceptionValue: 'Main document reveal failed',
        operation: 'main-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'call-site',
        context: {},
    },
    ASSISTANT_ACTION_FAILED: {
        exceptionType: 'AssistantActionFailed',
        exceptionValue: 'Assistant action failed',
        operation: 'renderer-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'call-site',
        context: ASSISTANT_FAILURE_CONTEXT,
    },
    UPDATE_OPERATION_FAILED: {
        exceptionType: 'UpdateOperationFailed',
        exceptionValue: 'Update operation failed',
        operation: 'renderer-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'call-site',
        context: UPDATE_FAILURE_CONTEXT,
    },
    RENDERER_STARTUP_WARMUP_FAILED: {
        exceptionType: 'RendererStartupWarmupFailed',
        exceptionValue: 'Renderer startup warmup failed',
        operation: 'renderer-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'call-site',
        context: {},
    },
    RENDERER_DEVELOPMENT_HMR_FAILED: {
        exceptionType: 'RendererDevelopmentHmrFailed',
        exceptionValue: 'Renderer development hot reload failed',
        operation: 'renderer-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'call-site',
        context: {},
    },
    RENDERER_DJVU_OPERATION_FAILED: {
        exceptionType: 'RendererDjvuOperationFailed',
        exceptionValue: 'Renderer DjVu operation failed',
        operation: 'renderer-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'call-site',
        context: {},
    },
    RENDERER_PDF_COMBINE_OPERATION_FAILED: {
        exceptionType: 'RendererPdfCombineOperationFailed',
        exceptionValue: 'Renderer PDF combine operation failed',
        operation: 'renderer-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'call-site',
        context: {},
    },
    RENDERER_ANNOTATION_OPERATION_FAILED: {
        exceptionType: 'RendererAnnotationOperationFailed',
        exceptionValue: 'Renderer annotation operation failed',
        operation: 'renderer-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'call-site',
        context: {},
    },
    RENDERER_PDF_PAGE_OPERATION_FAILED: {
        exceptionType: 'RendererPdfPageOperationFailed',
        exceptionValue: 'Renderer PDF page operation failed',
        operation: 'renderer-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'call-site',
        context: {},
    },
    RENDERER_SCAN_CLEANUP_OPERATION_FAILED: {
        exceptionType: 'RendererScanCleanupOperationFailed',
        exceptionValue: 'Renderer scan cleanup operation failed',
        operation: 'renderer-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'call-site',
        context: SCAN_CLEANUP_DIAGNOSTIC_CONTEXT,
    },
    RENDERER_WORKSPACE_OPERATION_FAILED: {
        exceptionType: 'RendererWorkspaceOperationFailed',
        exceptionValue: 'Renderer workspace operation failed',
        operation: 'renderer-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'call-site',
        context: {},
    },
    RENDERER_TAB_TRANSFER_OPERATION_FAILED: {
        exceptionType: 'RendererTabTransferOperationFailed',
        exceptionValue: 'Renderer tab transfer operation failed',
        operation: 'renderer-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'call-site',
        context: {},
    },
    RENDERER_SEARCH_WORKER_FAILED: {
        exceptionType: 'RendererSearchWorkerFailed',
        exceptionValue: 'Renderer search worker failed',
        operation: 'renderer-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'call-site',
        context: {},
    },
    RENDERER_PDF_SERIALIZATION_WORKER_FAILED: {
        exceptionType: 'RendererPdfSerializationWorkerFailed',
        exceptionValue: 'Renderer PDF serialization worker failed',
        operation: 'renderer-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'call-site',
        context: {},
    },
    MAIN_ELECTRON_LOCALE_LOAD_FAILED: {
        exceptionType: 'MainElectronLocaleLoadFailed',
        exceptionValue: 'Main Electron locale load failed',
        operation: 'main-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'call-site',
        context: ELECTRON_LOCALE_LOAD_CONTEXT,
    },
    MAIN_RECENT_FILES_LOAD_FAILED: {
        exceptionType: 'MainRecentFilesLoadFailed',
        exceptionValue: 'Main recent-files load failed',
        operation: 'main-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'call-site',
        context: RECENT_FILES_LOAD_CONTEXT,
    },
    MAIN_RECENT_FILES_RECOVERY_FAILED: {
        exceptionType: 'MainRecentFilesRecoveryFailed',
        exceptionValue: 'Main recent-files recovery failed',
        operation: 'main-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'call-site',
        context: {},
    },
    MAIN_RECENT_FILES_SAVE_FAILED: {
        exceptionType: 'MainRecentFilesSaveFailed',
        exceptionValue: 'Main recent-files save failed',
        operation: 'main-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'call-site',
        context: {},
    },
    MAIN_UPDATE_CHECK_FAILED: {
        exceptionType: 'MainUpdateCheckFailed',
        exceptionValue: 'Main update check failed',
        operation: 'main-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'call-site',
        context: UPDATE_CHECK_CONTEXT,
    },
    MAIN_UPDATE_DOWNLOAD_FAILED: {
        exceptionType: 'MainUpdateDownloadFailed',
        exceptionValue: 'Main update download failed',
        operation: 'main-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'call-site',
        context: {},
    },
    MAIN_UPDATE_INSTALL_FAILED: {
        exceptionType: 'MainUpdateInstallFailed',
        exceptionValue: 'Main update install failed',
        operation: 'main-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'call-site',
        context: {},
    },
    MAIN_UPDATE_INSTALL_PREPARATION_FAILED: {
        exceptionType: 'MainUpdateInstallPreparationFailed',
        exceptionValue: 'Main update install preparation failed',
        operation: 'main-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'call-site',
        context: {},
    },
    MAIN_UPDATE_STARTUP_FAILED: {
        exceptionType: 'MainUpdateStartupFailed',
        exceptionValue: 'Main update startup failed',
        operation: 'main-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'call-site',
        context: UPDATE_STARTUP_CONTEXT,
    },
    MAIN_SHUTDOWN_SAVE_FLUSH_FAILED: {
        exceptionType: 'MainShutdownSaveFlushFailed',
        exceptionValue: 'Main shutdown save flush failed',
        operation: 'main-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'call-site',
        context: {},
    },
    MAIN_STARTUP_INITIALIZATION_FAILED: {
        exceptionType: 'MainStartupInitializationFailed',
        exceptionValue: 'Main startup initialization failed',
        operation: 'main-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'call-site',
        context: {},
    },
    MAIN_SHUTDOWN_FAILED: {
        exceptionType: 'MainShutdownFailed',
        exceptionValue: 'Main shutdown operation failed',
        operation: 'main-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'call-site',
        context: {},
    },
    MAIN_DJVU_EXPORT_FAILED: {
        exceptionType: 'MainDjvuExportFailed',
        exceptionValue: 'Main DjVu export failed',
        operation: 'main-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'call-site',
        context: {},
    },
    MAIN_IMAGE_EXPORT_FAILED: {
        exceptionType: 'MainImageExportFailed',
        exceptionValue: 'Main image export failed',
        operation: 'main-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'call-site',
        context: {},
    },
    MAIN_DJVU_VIEWING_FAILED: {
        exceptionType: 'MainDjvuViewingFailed',
        exceptionValue: 'Main DjVu viewing failed',
        operation: 'main-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'call-site',
        context: {},
    },
    MAIN_DOCUMENT_OPEN_FAILED: {
        exceptionType: 'MainDocumentOpenFailed',
        exceptionValue: 'Main document open failed',
        operation: 'main-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'call-site',
        context: {},
    },
    MAIN_SCAN_CLEANUP_FAILED: {
        exceptionType: 'MainScanCleanupFailed',
        exceptionValue: 'Main scan cleanup failed',
        operation: 'main-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'call-site',
        context: SCAN_CLEANUP_DIAGNOSTIC_CONTEXT,
    },
    MAIN_SEARCH_WORKER_FAILED: {
        exceptionType: 'MainSearchWorkerFailed',
        exceptionValue: 'Main search worker failed',
        operation: 'main-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'call-site',
        context: {},
    },
    MAIN_WORKING_COPY_CLEANUP_FAILED: {
        exceptionType: 'MainWorkingCopyCleanupFailed',
        exceptionValue: 'Main working copy cleanup failed',
        operation: 'main-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'call-site',
        context: {},
    },
    MAIN_OCR_OPERATION_FAILED: {
        exceptionType: 'MainOcrOperationFailed',
        exceptionValue: 'Main OCR operation failed',
        operation: 'main-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'call-site',
        context: {},
    },
    MAIN_RENDERER_LOG_BRIDGE_FAILED: {
        exceptionType: 'MainRendererLogBridgeFailed',
        exceptionValue: 'Main renderer log bridge failed',
        operation: 'main-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'call-site',
        context: {},
    },
    MAIN_DEFAULT_VIEWER_PROMPT_FAILED: {
        exceptionType: 'MainDefaultViewerPromptFailed',
        exceptionValue: 'Main default viewer prompt failed',
        operation: 'main-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'call-site',
        context: {},
    },
    MAIN_SETTINGS_OPERATION_FAILED: {
        exceptionType: 'MainSettingsOperationFailed',
        exceptionValue: 'Main settings operation failed',
        operation: 'main-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'call-site',
        context: {},
    },
    MAIN_DETACHED_PROCESS_FAILED: {
        exceptionType: 'MainDetachedProcessFailed',
        exceptionValue: 'Main detached process failed',
        operation: 'main-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'call-site',
        context: {},
    },
    MAIN_WORKER_TASK_FAILED: {
        exceptionType: 'MainWorkerTaskFailed',
        exceptionValue: 'Main worker task failed',
        operation: 'main-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'call-site',
        context: {},
    },
    MAIN_WINDOW_OPERATION_FAILED: {
        exceptionType: 'MainWindowOperationFailed',
        exceptionValue: 'Main window operation failed',
        operation: 'main-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'call-site',
        context: {},
    },
    MAIN_WORKSPACE_CHECKPOINT_FAILED: {
        exceptionType: 'MainWorkspaceCheckpointFailed',
        exceptionValue: 'Main workspace checkpoint failed',
        operation: 'main-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'call-site',
        context: {},
    },
    MAIN_PROCESS_RECOVERY_FAILED: {
        exceptionType: 'MainProcessRecoveryFailed',
        exceptionValue: 'Main process recovery failed',
        operation: 'main-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'call-site',
        context: {},
    },
} as const satisfies Readonly<Record<string, IDiagnosticDefinition>>;

export type DiagnosticCode = keyof typeof DIAGNOSTIC_DEFINITIONS;

export const DIAGNOSTIC_CODES = Object.freeze(
    Object.keys(DIAGNOSTIC_DEFINITIONS).filter(isDiagnosticDefinitionKey),
);

type InferDiagnosticContextField<TField extends DiagnosticContextFieldDefinition> =
    TField extends {
        readonly kind: 'enum';
        readonly values: ReadonlyArray<infer TValue>
    }
        ? Extract<TValue, string>
        : TField extends {readonly kind: 'boolean'}
            ? boolean
            : TField extends {readonly kind: 'integer'}
                ? number
                : never;

type DiagnosticContextForDefinition<
    TDefinition extends IDiagnosticDefinition,
> = {
    [TKey in keyof TDefinition['context']]?: InferDiagnosticContextField<TDefinition['context'][TKey]>;
} & (keyof TDefinition['context'] extends never ? Readonly<Record<string, never>> : unknown);

export type DiagnosticContext<C extends DiagnosticCode> = DiagnosticContextForDefinition<
    (typeof DIAGNOSTIC_DEFINITIONS)[C]
>;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return false;
    }
    try {
        const prototype = Reflect.getPrototypeOf(value);
        return prototype === Object.prototype || prototype === null;
    } catch {
        return false;
    }
}

function isDiagnosticDefinitionKey(value: unknown): value is DiagnosticCode {
    return typeof value === 'string' && Object.hasOwn(DIAGNOSTIC_DEFINITIONS, value);
}

export function isDiagnosticCode(value: unknown): value is DiagnosticCode {
    return isDiagnosticDefinitionKey(value);
}

export function isDiagnosticOperation(value: unknown): value is DiagnosticOperation {
    return typeof value === 'string'
        && DIAGNOSTIC_OPERATIONS.some(operation => operation === value);
}

function decodeContextField(
    definition: DiagnosticContextFieldDefinition,
    value: unknown,
): string | boolean | number | null {
    if (definition.kind === 'enum') {
        return typeof value === 'string' && definition.values.includes(value)
            ? value
            : null;
    }
    if (definition.kind === 'boolean') {
        return typeof value === 'boolean' ? value : null;
    }
    return typeof value === 'number'
        && Number.isSafeInteger(value)
        && value >= definition.min
        && value <= definition.max
        ? value
        : null;
}

export function decodeDiagnosticContext<C extends DiagnosticCode>(
    code: C,
    value: unknown,
): DiagnosticContext<C> | null;
export function decodeDiagnosticContext(
    code: DiagnosticCode,
    value: unknown,
): Record<string, unknown> | null {
    if (!isDiagnosticDefinitionKey(code) || !isPlainRecord(value)) {
        return null;
    }
    try {
        const definition: DiagnosticContextDefinition = DIAGNOSTIC_DEFINITIONS[code].context;
        const keys = Reflect.ownKeys(value);
        if (keys.some(key => typeof key !== 'string' || !Object.hasOwn(definition, key))) {
            return null;
        }

        const decoded: Record<string, unknown> = {};
        for (const key of keys) {
            if (typeof key !== 'string') {
                return null;
            }
            const field = definition[key];
            if (field === undefined) {
                return null;
            }
            const decodedField = decodeContextField(field, value[key]);
            if (decodedField === null) {
                return null;
            }
            decoded[key] = decodedField;
        }
        return decoded;
    } catch {
        return null;
    }
}
