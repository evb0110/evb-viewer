import {
    BrowserWindow,
    type IpcMainInvokeEvent,
} from 'electron';
import type {
    IAgentCommandRequest,
    IAgentCommandResponse,
    IAgentCommandExecutionScope,
    IAgentRendererAck,
    IAgentWorkspaceSnapshot,
    IAgentWorkspaceSnapshotRequest,
    IAgentWorkspaceSnapshotResponse,
    TAgentCommand,
    TAgentRendererAckReason,
} from '@contracts/agent';
import { isAgentWorkspaceSnapshot } from '@contracts/isAgentWorkspaceSnapshot';
import { isRecord } from '@contracts/runtimeGuards';
import {
    createRequestId,
    parseRequestId,
    type TRequestId,
} from '@contracts/shared';
import {
    sendAgentCommandCancelRequest,
    sendAgentCommandRequest,
    sendAgentWorkspaceSnapshotRequest,
} from '@electron/features/agent/main/agentRendererEvents';
import { getErrorMessage } from '@electron/utils/error';

export const DEFAULT_AGENT_REQUEST_TIMEOUT_MS = 10_000;
export const LONG_AGENT_COMMAND_REQUEST_TIMEOUT_MS = 180_000;

const LONG_RUNNING_AGENT_ACTION_IDS = new Set([
    'file.save',
    'file.save_as',
    'file.repair_save',
    'file.optimize_for_interaction',
    'ocr.start',
    'export.docx',
    'export.images',
    'export.multi_page_tiff',
    'page_ops.convert_to_pdf',
]);

interface ICachedWorkspaceSnapshot {
    generation: number;
    revision: number;
    snapshot: IAgentWorkspaceSnapshot;
}

interface IWorkspaceSnapshotLifecycle {
    generation: number;
    cleanup: () => void;
}

interface IPendingRequest<TResponse> {
    cancelRenderer?: () => void;
    windowId: number;
    timeout: NodeJS.Timeout;
    cleanupLifecycle: () => void;
    resolve(response: TResponse): void;
    reject(error: Error): void;
}

const pendingSnapshotRequests = new Map<TRequestId, IPendingRequest<IAgentWorkspaceSnapshot>>();
const pendingCommandRequests = new Map<TRequestId, IPendingRequest<Record<string, unknown>>>();
const snapshotCacheByWindowId = new Map<number, ICachedWorkspaceSnapshot>();
const snapshotLifecycleByWindowId = new Map<number, IWorkspaceSnapshotLifecycle>();
let nextSnapshotGeneration = 1;
type TAgentResponseSender = Pick<IpcMainInvokeEvent, 'sender'>;

function rejectPendingRequest<TResponse>(
    pendingMap: Map<TRequestId, IPendingRequest<TResponse>>,
    requestId: TRequestId,
    error: Error,
) {
    const pending = pendingMap.get(requestId);
    if (!pending) {
        return;
    }

    clearTimeout(pending.timeout);
    pending.cleanupLifecycle();
    pendingMap.delete(requestId);
    pending.reject(error);
}

function resolvePendingRequest<TResponse>(
    pendingMap: Map<TRequestId, IPendingRequest<TResponse>>,
    requestId: TRequestId,
    response: TResponse,
) {
    const pending = pendingMap.get(requestId);
    if (!pending) {
        return false;
    }

    clearTimeout(pending.timeout);
    pending.cleanupLifecycle();
    pendingMap.delete(requestId);
    pending.resolve(response);
    return true;
}

function createTargetWindowLifecycleCleanup<TResponse>(
    pendingMap: Map<TRequestId, IPendingRequest<TResponse>>,
    requestId: TRequestId,
    window: BrowserWindow,
    onLifecycleReject?: () => void,
) {
    const rejectForLifecycle = (reason: string) => {
        onLifecycleReject?.();
        rejectPendingRequest(
            pendingMap,
            requestId,
            new Error(`Agent renderer request was canceled because the target window ${reason}.`),
        );
    };
    const handleClosed = () => rejectForLifecycle('closed');
    const handleRenderGone = () => rejectForLifecycle('renderer exited');
    const handleNavigation = (
        _event: Electron.Event,
        _url: string,
        isInPlace: boolean,
        isMainFrame: boolean,
    ) => {
        if (isMainFrame && !isInPlace) {
            rejectForLifecycle('navigated');
        }
    };

    window.once('closed', handleClosed);
    window.webContents.once('render-process-gone', handleRenderGone);
    window.webContents.on('did-start-navigation', handleNavigation);

    return () => {
        window.removeListener('closed', handleClosed);
        window.webContents.removeListener('render-process-gone', handleRenderGone);
        window.webContents.removeListener('did-start-navigation', handleNavigation);
    };
}

function invalidateWorkspaceSnapshotLifecycle(
    windowId: number,
    lifecycle: IWorkspaceSnapshotLifecycle,
    reason: string,
) {
    if (snapshotLifecycleByWindowId.get(windowId) !== lifecycle) {
        return;
    }

    snapshotLifecycleByWindowId.delete(windowId);
    snapshotCacheByWindowId.delete(windowId);
    lifecycle.cleanup();

    for (const [
        requestId,
        pending,
    ] of pendingSnapshotRequests) {
        if (pending.windowId === windowId) {
            rejectPendingRequest(
                pendingSnapshotRequests,
                requestId,
                new Error(`Agent renderer request was canceled because the target window ${reason}.`),
            );
        }
    }
}

function createWorkspaceSnapshotLifecycle(window: BrowserWindow, generation: number) {
    function handleInvalidation(reason: string) {
        invalidateWorkspaceSnapshotLifecycle(window.id, lifecycle, reason);
    }
    function handleClosed() {
        handleInvalidation('closed');
    }
    function handleRenderGone() {
        handleInvalidation('renderer exited');
    }
    function handleNavigation(
        _event: Electron.Event,
        _url: string,
        isInPlace: boolean,
        isMainFrame: boolean,
    ) {
        if (isMainFrame && !isInPlace) {
            handleInvalidation('navigated');
        }
    }
    const lifecycle: IWorkspaceSnapshotLifecycle = {
        generation,
        cleanup: () => {
            window.removeListener('closed', handleClosed);
            window.webContents.removeListener('render-process-gone', handleRenderGone);
            window.webContents.removeListener('did-start-navigation', handleNavigation);
        },
    };

    window.once('closed', handleClosed);
    window.webContents.once('render-process-gone', handleRenderGone);
    window.webContents.on('did-start-navigation', handleNavigation);
    return lifecycle;
}

function ensureWorkspaceSnapshotLifecycle(window: BrowserWindow, generation: number) {
    const existing = snapshotLifecycleByWindowId.get(window.id);
    if (existing?.generation === generation) {
        return existing;
    }
    if (existing) {
        existing.cleanup();
        snapshotLifecycleByWindowId.delete(window.id);
    }
    const lifecycle = createWorkspaceSnapshotLifecycle(window, generation);
    snapshotLifecycleByWindowId.set(window.id, lifecycle);
    return lifecycle;
}

function createPendingRequest<TResponse>(
    pendingMap: Map<TRequestId, IPendingRequest<TResponse>>,
    requestId: TRequestId,
    window: BrowserWindow,
    timeoutMs: number,
    options: {
        cancelRenderer?: () => void;
        signal?: AbortSignal;
    } = {},
    onLifecycleReject?: () => void,
) {
    return new Promise<TResponse>((resolve, reject) => {
        const cleanupLifecycle = createTargetWindowLifecycleCleanup(
            pendingMap,
            requestId,
            window,
            onLifecycleReject,
        );
        const cleanupAbortSignal = () => {
            options.signal?.removeEventListener('abort', handleAbortSignal);
        };
        const cleanup = () => {
            cleanupLifecycle();
            cleanupAbortSignal();
        };
        const timeout = setTimeout(() => {
            options.cancelRenderer?.();
            rejectPendingRequest(
                pendingMap,
                requestId,
                new Error(`Agent renderer request timed out after ${timeoutMs}ms`),
            );
        }, timeoutMs);
        const handleAbortSignal = () => {
            options.cancelRenderer?.();
            rejectPendingRequest(
                pendingMap,
                requestId,
                new Error('Agent renderer request was aborted by the caller.'),
            );
        };
        pendingMap.set(requestId, {
            ...(options.cancelRenderer === undefined ? {} : {cancelRenderer: options.cancelRenderer}),
            windowId: window.id,
            timeout,
            cleanupLifecycle: cleanup,
            resolve,
            reject,
        });
        options.signal?.addEventListener('abort', handleAbortSignal, { once: true });
        if (options.signal?.aborted) {
            handleAbortSignal();
        }
    });
}

function sendAgentCommandCancel(window: BrowserWindow, requestId: TRequestId) {
    if (window.isDestroyed() || window.webContents.isDestroyed()) {
        return;
    }
    sendAgentCommandCancelRequest(window, {
        requestId,
        windowId: window.id,
    });
}

function assertUsableTargetWindow(window: BrowserWindow | null | undefined) {
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
        throw new Error('No live renderer window is available for the agent request.');
    }
    return window;
}

export function resolveAgentCommandRequestTimeoutMs(
    command: TAgentCommand,
    requestedTimeoutMs?: number,
) {
    if (requestedTimeoutMs !== undefined) {
        return requestedTimeoutMs;
    }

    if (
        command.name === 'run_action'
        && LONG_RUNNING_AGENT_ACTION_IDS.has(command.arguments.id)
    ) {
        return LONG_AGENT_COMMAND_REQUEST_TIMEOUT_MS;
    }

    return DEFAULT_AGENT_REQUEST_TIMEOUT_MS;
}

function getResponseSenderWindowId(event: TAgentResponseSender) {
    const sourceWindow = BrowserWindow.fromWebContents(event.sender);
    return sourceWindow && !sourceWindow.isDestroyed() ? sourceWindow.id : null;
}

function rejectRendererAck(reason: TAgentRendererAckReason): IAgentRendererAck {
    return {
        accepted: false,
        reason,
    };
}

function acceptRendererAck(): IAgentRendererAck {
    return { accepted: true };
}

function getRejectedAckForUnexpectedResponse<TResponse>(
    pendingMap: Map<TRequestId, IPendingRequest<TResponse>>,
    requestId: TRequestId,
    senderWindowId: number | null,
): IAgentRendererAck | null {
    if (senderWindowId === null) {
        return rejectRendererAck('unexpected-sender');
    }
    const pending = pendingMap.get(requestId);
    if (!pending) {
        return rejectRendererAck('unknown-request');
    }
    if (pending.windowId !== senderWindowId) {
        return rejectRendererAck('unexpected-sender');
    }
    return null;
}

function normalizeResponseError(response: { error?: string }) {
    const message = response.error?.trim();
    return message && message.length > 0 ? message : 'Agent renderer request failed.';
}

function isValidSnapshotResponse(response: unknown): response is IAgentWorkspaceSnapshotResponse {
    return isRecord(response)
        && parseRequestId(response.requestId) !== null
        && typeof response.ok === 'boolean'
        && (response.windowId === undefined || typeof response.windowId === 'number')
        && (response.revision === undefined || (
            typeof response.revision === 'number'
            && Number.isInteger(response.revision)
            && response.revision >= 0
        ))
        && (response.unchanged === undefined || typeof response.unchanged === 'boolean')
        && (response.snapshot === undefined || isAgentWorkspaceSnapshot(response.snapshot))
        && (response.error === undefined || typeof response.error === 'string');
}

function isValidCommandResponse(response: unknown): response is IAgentCommandResponse {
    return isRecord(response)
        && parseRequestId(response.requestId) !== null
        && typeof response.ok === 'boolean'
        && (response.windowId === undefined || typeof response.windowId === 'number')
        && (response.error === undefined || typeof response.error === 'string')
        && (response.result === undefined || isRecord(response.result));
}

function rejectPendingInvalidSnapshotResponse(
    event: TAgentResponseSender,
    rawResponse: unknown,
) {
    if (!isRecord(rawResponse)) {
        return;
    }

    const requestId = parseRequestId(rawResponse.requestId);
    if (requestId === null) {
        return;
    }
    const senderWindowId = getResponseSenderWindowId(event);
    const rejectedAck = getRejectedAckForUnexpectedResponse(
        pendingSnapshotRequests,
        requestId,
        senderWindowId,
    );
    if (rejectedAck !== null) {
        return;
    }

    rejectPendingRequest(
        pendingSnapshotRequests,
        requestId,
        new Error('Agent workspace snapshot response did not match the expected contract.'),
    );
}

export function requestAgentWorkspaceSnapshot(
    targetWindow: BrowserWindow | null | undefined,
    timeoutMs = DEFAULT_AGENT_REQUEST_TIMEOUT_MS,
    scope?: IAgentCommandExecutionScope,
    signal?: AbortSignal,
) {
    const window = assertUsableTargetWindow(targetWindow);
    if (signal?.aborted) {
        return Promise.reject(new Error('Agent renderer request was aborted by the caller.'));
    }
    const requestId = createRequestId('agent-snapshot');
    const cachedSnapshot = snapshotCacheByWindowId.get(window.id);
    const request: IAgentWorkspaceSnapshotRequest = {
        requestId,
        windowId: window.id,
        ...(scope === undefined ? {} : { scope }),
        ...(cachedSnapshot === undefined ? {} : { lastSeenRevision: cachedSnapshot.revision }),
    };
    const pending = createPendingRequest(
        pendingSnapshotRequests,
        requestId,
        window,
        timeoutMs,
        signal === undefined ? {} : {signal},
        () => {
            const lifecycle = snapshotLifecycleByWindowId.get(window.id);
            if (lifecycle) {
                invalidateWorkspaceSnapshotLifecycle(window.id, lifecycle, 'navigated');
            } else {
                snapshotCacheByWindowId.delete(window.id);
            }
        },
    );

    try {
        if (pendingSnapshotRequests.has(requestId)) {
            sendAgentWorkspaceSnapshotRequest(window, request);
        }
    } catch (error) {
        rejectPendingRequest(
            pendingSnapshotRequests,
            requestId,
            new Error(`Failed to send agent workspace snapshot request: ${getErrorMessage(error)}`),
        );
    }

    return pending;
}

export function requestAgentCommand(
    targetWindow: BrowserWindow | null | undefined,
    command: TAgentCommand,
    timeoutMs?: number,
    scope?: IAgentCommandExecutionScope,
    signal?: AbortSignal,
) {
    const window = assertUsableTargetWindow(targetWindow);
    if (signal?.aborted) {
        return Promise.reject(new Error('Agent renderer request was aborted by the caller.'));
    }
    const requestId = createRequestId('agent-command');
    const effectiveTimeoutMs = resolveAgentCommandRequestTimeoutMs(command, timeoutMs);
    const request: IAgentCommandRequest = {
        requestId,
        windowId: window.id,
        command,
        ...(scope === undefined ? {} : { scope }),
    };
    const pending = createPendingRequest(
        pendingCommandRequests,
        requestId,
        window,
        effectiveTimeoutMs,
        {
            cancelRenderer: () => sendAgentCommandCancel(window, requestId),
            ...(signal === undefined ? {} : {signal}),
        },
        () => sendAgentCommandCancel(window, requestId),
    );

    try {
        if (pendingCommandRequests.has(requestId)) {
            sendAgentCommandRequest(window, request);
        }
    } catch (error) {
        rejectPendingRequest(
            pendingCommandRequests,
            requestId,
            new Error(`Failed to send agent command request: ${getErrorMessage(error)}`),
        );
    }

    return pending;
}

export function submitAgentWorkspaceSnapshotResponse(
    event: TAgentResponseSender,
    rawResponse: unknown,
) {
    if (!isValidSnapshotResponse(rawResponse)) {
        rejectPendingInvalidSnapshotResponse(event, rawResponse);
        return rejectRendererAck('invalid-payload');
    }

    const senderWindowId = getResponseSenderWindowId(event);
    const rejectedAck = getRejectedAckForUnexpectedResponse(
        pendingSnapshotRequests,
        rawResponse.requestId,
        senderWindowId,
    );
    if (rejectedAck !== null) {
        return rejectedAck;
    }
    const pending = pendingSnapshotRequests.get(rawResponse.requestId);
    if (!pending) {
        return rejectRendererAck('unknown-request');
    }

    if (!rawResponse.ok) {
        rejectPendingRequest(
            pendingSnapshotRequests,
            rawResponse.requestId,
            new Error(normalizeResponseError(rawResponse)),
        );
        return acceptRendererAck();
    }

    if (rawResponse.unchanged === true) {
        const cachedSnapshot = snapshotCacheByWindowId.get(pending.windowId);
        if (!cachedSnapshot) {
            rejectPendingRequest(
                pendingSnapshotRequests,
                rawResponse.requestId,
                new Error('Agent workspace snapshot response was unchanged but no cached snapshot is available.'),
            );
            return acceptRendererAck();
        }
        if (
            rawResponse.revision !== undefined
            && rawResponse.revision !== cachedSnapshot.revision
        ) {
            rejectPendingRequest(
                pendingSnapshotRequests,
                rawResponse.requestId,
                new Error('Agent workspace snapshot response revision did not match the cached snapshot.'),
            );
            return acceptRendererAck();
        }
        resolvePendingRequest(
            pendingSnapshotRequests,
            rawResponse.requestId,
            cachedSnapshot.snapshot,
        );
        return acceptRendererAck();
    }

    if (!rawResponse.snapshot) {
        rejectPendingRequest(
            pendingSnapshotRequests,
            rawResponse.requestId,
            new Error('Agent workspace snapshot response did not include a snapshot.'),
        );
        return acceptRendererAck();
    }

    const cachedSnapshot = snapshotCacheByWindowId.get(pending.windowId);
    const previousRevision = cachedSnapshot?.revision ?? 0;
    const generation = cachedSnapshot?.generation ?? nextSnapshotGeneration++;
    const responseWindow = BrowserWindow.fromWebContents(event.sender);
    if (!responseWindow || responseWindow.isDestroyed()) {
        rejectPendingRequest(
            pendingSnapshotRequests,
            rawResponse.requestId,
            new Error('Agent workspace snapshot response came from a destroyed renderer.'),
        );
        return rejectRendererAck('unexpected-sender');
    }
    snapshotCacheByWindowId.set(pending.windowId, {
        generation,
        revision: rawResponse.revision ?? previousRevision + 1,
        snapshot: rawResponse.snapshot,
    });
    ensureWorkspaceSnapshotLifecycle(responseWindow, generation);
    resolvePendingRequest(
        pendingSnapshotRequests,
        rawResponse.requestId,
        rawResponse.snapshot,
    );
    return acceptRendererAck();
}

export function submitAgentCommandResponse(
    event: TAgentResponseSender,
    rawResponse: unknown,
) {
    if (!isValidCommandResponse(rawResponse)) {
        return rejectRendererAck('invalid-payload');
    }

    const senderWindowId = getResponseSenderWindowId(event);
    const rejectedAck = getRejectedAckForUnexpectedResponse(
        pendingCommandRequests,
        rawResponse.requestId,
        senderWindowId,
    );
    if (rejectedAck !== null) {
        return rejectedAck;
    }

    if (!rawResponse.ok) {
        rejectPendingRequest(
            pendingCommandRequests,
            rawResponse.requestId,
            new Error(normalizeResponseError(rawResponse)),
        );
        return acceptRendererAck();
    }

    resolvePendingRequest(
        pendingCommandRequests,
        rawResponse.requestId,
        rawResponse.result ?? {},
    );
    return acceptRendererAck();
}
