import type {IDebugLogEntry} from '@contracts/electronApiCommon';
import {
    DIAGNOSTICS_POLICY_HINTS,
    type IDiagnosticsRendererCapability,
    type IDiagnosticsStartupPolicy,
    type TDiagnosticsPolicyHint,
} from '@contracts/diagnostics/diagnosticsCapability';
import {isRecord} from '@contracts/runtimeGuards';
import type {
    IWindowCloseRequest,
    IWindowCloseResponse,
} from '@contracts/systemPlatformFeature';
import {
    parseRequestId,
    type TRequestId,
} from '@contracts/shared';

export const CORE_IPC_CHANNELS = {
    diagnosticsCanary: 'automation:diagnosticsCanary',
    rendererReady: 'app:rendererReady',
} as const;

const DIAGNOSTICS_CANARY_ACTIONS = [
    'main-error',
    'crash-main',
    'main-health',
] as const;

export type TDiagnosticsCanaryAction = typeof DIAGNOSTICS_CANARY_ACTIONS[number];

export function decodeDiagnosticsCanaryAction(value: unknown): TDiagnosticsCanaryAction | null {
    return typeof value === 'string'
        && (DIAGNOSTICS_CANARY_ACTIONS as readonly string[]).includes(value)
        ? value as TDiagnosticsCanaryAction
        : null;
}

export const CORE_IPC_EVENT_CHANNELS = {
    menuCheckForUpdates: 'menu:checkForUpdates',
    debugLog: 'debug:log',
    shutdownSaveFlushRequest: 'shutdown:saveFlushRequest',
    windowCloseRequest: 'window:closeRequest',
} as const;

export const CORE_IPC_SEND_CHANNELS = {
    ipcInvokeCanceled: 'ipc:invokeCanceled',
    rendererDiagnostic: 'renderer:diagnostic',
    rendererLog: 'renderer:log',
    shutdownSaveFlushResult: 'shutdown:saveFlushResult',
    windowCloseResponse: 'window:closeResponse',
} as const;

/**
 * `ipcRenderer.invoke` carries no metadata beside the handler's own arguments,
 * so a timed invoke appends its request id as a trailing argument under this
 * field. `createValidatedIpcMainRegistrar` strips it before the channel's own
 * decoder runs, and the renderer names the same id on `ipc:invokeCanceled`.
 */
export const IPC_INVOKE_REQUEST_ID_FIELD = '__evbIpcInvokeRequestId';

export function decodeIpcInvokeRequestId(value: unknown): TRequestId | null {
    if (!isRecord(value) || Object.keys(value).length !== 1) {
        return null;
    }
    return parseRequestId(value[IPC_INVOKE_REQUEST_ID_FIELD]);
}

export const DIAGNOSTICS_POLICY_ARGUMENT_PREFIX = '--evb-diagnostics-policy=';
export type {IDiagnosticsStartupPolicy} from '@contracts/diagnostics/diagnosticsCapability';

export type IPreloadDiagnosticsApi = IDiagnosticsRendererCapability;

export interface ICoreEventMap {
    [CORE_IPC_EVENT_CHANNELS.menuCheckForUpdates]: undefined;
    [CORE_IPC_EVENT_CHANNELS.debugLog]: IDebugLogEntry;
    [CORE_IPC_EVENT_CHANNELS.shutdownSaveFlushRequest]: IShutdownSaveFlushRequest;
    [CORE_IPC_EVENT_CHANNELS.windowCloseRequest]: IWindowCloseRequest;
}

function isDiagnosticsPolicyHint(value: unknown): value is TDiagnosticsPolicyHint {
    return typeof value === 'string'
        && (DIAGNOSTICS_POLICY_HINTS as readonly string[]).includes(value);
}

export function createDiagnosticsStartupPolicy(value: unknown): Readonly<IDiagnosticsStartupPolicy> {
    return Object.freeze({mode: isDiagnosticsPolicyHint(value) ? value : 'unknown'});
}

export function encodeDiagnosticsPolicyArgument(value: unknown) {
    const encoded = Buffer
        .from(JSON.stringify(createDiagnosticsStartupPolicy(value)), 'utf8')
        .toString('base64url');
    return `${DIAGNOSTICS_POLICY_ARGUMENT_PREFIX}${encoded}`;
}

export interface IShutdownSaveFlushRequest { requestId: TRequestId; }

export interface IShutdownSaveFlushResult {
    callbackCount: number;
    requestId: TRequestId;
    dirtyWorkingCopyPaths?: string[];
    error?: string;
    flushedWorkingCopyPaths?: string[];
}

function decodeShutdownPathList(value: unknown) {
    if (value === undefined) {
        return undefined;
    }
    if (!Array.isArray(value) || value.length > 1_024) {
        return null;
    }
    const paths = value.filter((path): path is string => (
        typeof path === 'string'
        && path.trim().length > 0
        && path.length <= 16_384
    ));
    return paths.length === value.length ? paths : null;
}

export function decodeShutdownSaveFlushResult(value: unknown): IShutdownSaveFlushResult | null {
    const requestId = isRecord(value) ? parseRequestId(value.requestId) : null;
    if (!isRecord(value)
        || requestId === null
        || requestId.length > 256
        || !Number.isSafeInteger(value.callbackCount)
        || (value.callbackCount as number) < 0
        || (value.callbackCount as number) > 1_024
        || (value.error !== undefined && (typeof value.error !== 'string' || value.error.length > 16_384))) {
        return null;
    }
    const dirtyWorkingCopyPaths = decodeShutdownPathList(value.dirtyWorkingCopyPaths);
    const flushedWorkingCopyPaths = decodeShutdownPathList(value.flushedWorkingCopyPaths);
    if (dirtyWorkingCopyPaths === null || flushedWorkingCopyPaths === null) {
        return null;
    }
    return {
        callbackCount: value.callbackCount as number,
        requestId,
        ...(dirtyWorkingCopyPaths === undefined ? {} : {dirtyWorkingCopyPaths}),
        ...(flushedWorkingCopyPaths === undefined ? {} : {flushedWorkingCopyPaths}),
        ...(typeof value.error === 'string' ? {error: value.error} : {}),
    };
}

export function decodeWindowCloseRequest(value: unknown): IWindowCloseRequest | null {
    const requestId = isRecord(value) ? parseRequestId(value.requestId) : null;
    if (!isRecord(value) || requestId === null || requestId.length > 256) {
        return null;
    }

    return {requestId};
}

export function decodeWindowCloseResponse(value: unknown): IWindowCloseResponse | null {
    const requestId = isRecord(value) ? parseRequestId(value.requestId) : null;
    if (!isRecord(value) || requestId === null || requestId.length > 256) {
        return null;
    }

    if (
        value.decision === 'save'
        || value.decision === 'discard'
        || value.decision === 'cancel'
    ) {
        return {
            decision: value.decision,
            requestId,
        };
    }

    if (
        value.status !== 'unavailable'
        || (
            value.reason !== 'no-handler'
            && value.reason !== 'multiple-handlers'
            && value.reason !== 'handler-error'
            && value.reason !== 'invalid-decision'
        )
    ) {
        return null;
    }

    return {
        requestId,
        status: 'unavailable',
        reason: value.reason,
    };
}
