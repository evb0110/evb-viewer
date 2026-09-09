import { EventEmitter } from 'events';
import type {
    BrowserWindow,
    IpcMainInvokeEvent,
    WebContents,
} from 'electron';
import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type {
    IAgentWorkspaceSnapshot,
    IAgentWorkspaceSnapshotRequest,
} from '@contracts/agent';
import { AGENT_PLATFORM_FEATURE } from '@contracts/agentPlatformFeature';
import { requireIsoTimestamp } from '@contracts/timestamps';
import { requireTabId } from '@contracts/windowTabs';
import type * as AgentWorkspaceBridgeModule from '@electron/features/agent/workspaceBridge';

const mocks = vi.hoisted(() => ({fromWebContents: vi.fn()}));

vi.mock('electron', () => ({BrowserWindow: {fromWebContents: mocks.fromWebContents}}));

const {
    DEFAULT_AGENT_REQUEST_TIMEOUT_MS,
    LONG_AGENT_COMMAND_REQUEST_TIMEOUT_MS,
    requestAgentCommand,
    requestAgentWorkspaceSnapshot,
    resolveAgentCommandRequestTimeoutMs,
    submitAgentCommandResponse,
    submitAgentWorkspaceSnapshotResponse,
}: typeof AgentWorkspaceBridgeModule = await import('@electron/features/agent/workspaceBridge');

interface IFakeWebContents extends EventEmitter {
    isDestroyed: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
}

interface IFakeWindow extends EventEmitter {
    id: number;
    isDestroyed: ReturnType<typeof vi.fn>;
    webContents: IFakeWebContents;
}

function createFakeWindow(id = 101): IFakeWindow {
    const webContents: IFakeWebContents = Object.assign(new EventEmitter(), {
        isDestroyed: vi.fn(() => false),
        send: vi.fn(),
    });

    const window: IFakeWindow = Object.assign(new EventEmitter(), {
        id,
        isDestroyed: vi.fn(() => false),
        webContents,
    });
    return window;
}

function isWebContentsTestDouble(value: IFakeWebContents): value is IFakeWebContents & WebContents {
    return typeof value.isDestroyed === 'function'
        && typeof value.once === 'function'
        && typeof value.on === 'function'
        && typeof value.removeListener === 'function'
        && typeof value.send === 'function';
}

function isBrowserWindowTestDouble(value: IFakeWindow): value is IFakeWindow & BrowserWindow {
    return typeof value.id === 'number'
        && typeof value.isDestroyed === 'function'
        && typeof value.once === 'function'
        && typeof value.removeListener === 'function'
        && isWebContentsTestDouble(value.webContents);
}

function toBrowserWindow(window: IFakeWindow) {
    // The bridge only reads the members checked here from this Electron double.
    if (!isBrowserWindowTestDouble(window)) {
        throw new Error('Invalid BrowserWindow test double');
    }
    return window;
}

function createResponseEvent(window: IFakeWindow): Pick<IpcMainInvokeEvent, 'sender'> {
    // The response bridge only reads sender from this IPC event double.
    if (!isWebContentsTestDouble(window.webContents)) {
        throw new Error('Invalid WebContents test double');
    }
    return {sender: window.webContents};
}

function isSnapshotRequest(value: unknown): value is IAgentWorkspaceSnapshotRequest & {windowId: number} {
    return typeof value === 'object'
        && value !== null
        && 'requestId' in value
        && typeof value.requestId === 'string'
        && 'windowId' in value
        && typeof value.windowId === 'number'
        && (
            !('lastSeenRevision' in value)
            || value.lastSeenRevision === undefined
            || typeof value.lastSeenRevision === 'number'
        );
}

function getSnapshotRequest(window: IFakeWindow, index = 0) {
    const sendCalls: ReadonlyArray<readonly unknown[]> = window.webContents.send.mock.calls;
    const request: unknown = sendCalls[index]?.[1];
    if (!isSnapshotRequest(request)) {
        throw new Error(`Expected snapshot request at send call ${index}`);
    }
    return request;
}

function createWorkspaceSnapshot(): IAgentWorkspaceSnapshot {
    return {
        capturedAt: requireIsoTimestamp('2026-06-22T00:00:00.000Z'),
        activePaneId: null,
        activeTabId: null,
        summary: {
            mode: 'empty-workspace',
            activeDocument: null,
            documentCount: 0,
            recentFileCount: 0,
            recentFilesResolved: true,
        },
        panes: [],
        tabs: [],
        recentFiles: [],
        layout: null,
    };
}

describe('agent workspace bridge', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('uses a renderer request timeout long enough for workspace settling', async () => {
        vi.useFakeTimers();
        try {
            const window = createFakeWindow();
            const pending = requestAgentWorkspaceSnapshot(toBrowserWindow(window))
                .then(() => null)
                .catch((error: unknown) => error);

            await vi.advanceTimersByTimeAsync(DEFAULT_AGENT_REQUEST_TIMEOUT_MS - 1);
            await expect(Promise.race([
                pending,
                Promise.resolve('pending'),
            ])).resolves.toBe('pending');

            await vi.advanceTimersByTimeAsync(1);
            const expectedMessage = `Agent renderer request timed out after ${DEFAULT_AGENT_REQUEST_TIMEOUT_MS}ms`;
            await expect(pending).resolves.toMatchObject({message: expectedMessage});
        } finally {
            vi.useRealTimers();
        }
    });

    it('rejects pending snapshot requests when the target window closes', async () => {
        const window = createFakeWindow();

        const pending = requestAgentWorkspaceSnapshot(toBrowserWindow(window), 30_000);
        window.emit('closed');

        await expect(pending).rejects.toThrow('target window closed');
    });

    it('rejects pending command requests when the target renderer exits', async () => {
        const window = createFakeWindow();

        const pending = requestAgentCommand(toBrowserWindow(window), {
            name: 'activate_tab',
            arguments: {tabId: requireTabId('tab-1')},
        }, 30_000);
        window.webContents.emit('render-process-gone');

        await expect(pending).rejects.toThrow('target window renderer exited');
    });

    it('sends a renderer cancel event when a command request times out', async () => {
        vi.useFakeTimers();
        try {
            const window = createFakeWindow();

            const pending = requestAgentCommand(toBrowserWindow(window), {
                name: 'activate_tab',
                arguments: {tabId: requireTabId('tab-1')},
            }).catch((error: unknown) => error);

            await vi.advanceTimersByTimeAsync(DEFAULT_AGENT_REQUEST_TIMEOUT_MS);

            await expect(pending).resolves.toMatchObject({message: `Agent renderer request timed out after ${DEFAULT_AGENT_REQUEST_TIMEOUT_MS}ms`});
            expect(window.webContents.send.mock.calls[0]?.[0])
                .toBe(AGENT_PLATFORM_FEATURE.eventChannels.onCommandRequest);
            expect(window.webContents.send.mock.calls[1]?.[0])
                .toBe(AGENT_PLATFORM_FEATURE.eventChannels.onCommandCancelRequest);
            expect(window.webContents.send.mock.calls[1]?.[1]).toMatchObject({
                requestId: expect.any(String),
                windowId: window.id,
            });
        } finally {
            vi.useRealTimers();
        }
    });

    it('lets long-running file save actions settle beyond the default command timeout', async () => {
        vi.useFakeTimers();
        try {
            const window = createFakeWindow();
            mocks.fromWebContents.mockReturnValue(window);

            const pending = requestAgentCommand(toBrowserWindow(window), {
                name: 'run_action',
                arguments: {
                    id: 'file.save',
                    input: {},
                },
            });

            await vi.advanceTimersByTimeAsync(DEFAULT_AGENT_REQUEST_TIMEOUT_MS);
            expect(window.webContents.send.mock.calls).toHaveLength(1);

            const request = window.webContents.send.mock.calls[0]?.[1];
            expect(request).toMatchObject({
                requestId: expect.any(String),
                windowId: window.id,
            });
            const requestId = typeof request === 'object' && request !== null && 'requestId' in request
                ? request.requestId
                : null;
            if (typeof requestId !== 'string') {
                throw new Error('Expected command request id');
            }

            expect(submitAgentCommandResponse(
                createResponseEvent(window),
                {
                    requestId,
                    windowId: window.id,
                    ok: true,
                    result: { saved: true },
                },
            )).toEqual({ accepted: true });

            await expect(pending).resolves.toEqual({ saved: true });
        } finally {
            vi.useRealTimers();
        }
    });

    it('uses command-specific timeouts for long-running file actions', () => {
        expect(resolveAgentCommandRequestTimeoutMs({
            name: 'run_action',
            arguments: { id: 'file.save' },
        })).toBe(LONG_AGENT_COMMAND_REQUEST_TIMEOUT_MS);
        expect(resolveAgentCommandRequestTimeoutMs({
            name: 'run_action',
            arguments: { id: 'file.repair_save' },
        })).toBe(LONG_AGENT_COMMAND_REQUEST_TIMEOUT_MS);
        expect(resolveAgentCommandRequestTimeoutMs({
            name: 'go_to_page',
            arguments: { page: 3 },
        })).toBe(DEFAULT_AGENT_REQUEST_TIMEOUT_MS);
        expect(resolveAgentCommandRequestTimeoutMs({
            name: 'run_action',
            arguments: { id: 'file.save' },
        }, 12_345)).toBe(12_345);
    });

    it('sends a renderer cancel event when the caller aborts a command request', async () => {
        const window = createFakeWindow();
        const abortController = new AbortController();

        const pending = requestAgentCommand(toBrowserWindow(window), {
            name: 'activate_tab',
            arguments: {tabId: requireTabId('tab-1')},
        }, DEFAULT_AGENT_REQUEST_TIMEOUT_MS, undefined, abortController.signal);
        abortController.abort();

        await expect(pending).rejects.toThrow('aborted by the caller');
        expect(window.webContents.send.mock.calls[1]?.[0])
            .toBe(AGENT_PLATFORM_FEATURE.eventChannels.onCommandCancelRequest);
    });

    it('rejects pre-aborted command requests without sending them to the renderer', async () => {
        const window = createFakeWindow();
        const abortController = new AbortController();
        abortController.abort();

        const pending = requestAgentCommand(toBrowserWindow(window), {
            name: 'activate_tab',
            arguments: {tabId: requireTabId('tab-1')},
        }, DEFAULT_AGENT_REQUEST_TIMEOUT_MS, undefined, abortController.signal);

        await expect(pending).rejects.toThrow('aborted by the caller');
        expect(window.webContents.send).not.toHaveBeenCalled();
    });

    it('rejects pre-aborted snapshot requests without sending them to the renderer', async () => {
        const window = createFakeWindow();
        const abortController = new AbortController();
        abortController.abort();

        const pending = requestAgentWorkspaceSnapshot(
            toBrowserWindow(window),
            DEFAULT_AGENT_REQUEST_TIMEOUT_MS,
            undefined,
            abortController.signal,
        );

        await expect(pending).rejects.toThrow('aborted by the caller');
        expect(window.webContents.send).not.toHaveBeenCalled();
    });

    it('rejects pending snapshot requests on main-frame navigation only', async () => {
        const window = createFakeWindow();

        const pending = requestAgentWorkspaceSnapshot(toBrowserWindow(window), 30_000);
        window.webContents.emit('did-start-navigation', {}, 'app://subframe', false, false);
        expect(window.webContents.send).toHaveBeenCalledOnce();

        window.webContents.emit('did-start-navigation', {}, 'app://reload', false, true);

        await expect(pending).rejects.toThrow('target window navigated');
    });

    it('cleans lifecycle listeners after accepting a snapshot response', async () => {
        const window = createFakeWindow(202);
        mocks.fromWebContents.mockReturnValue(window);
        const snapshot = createWorkspaceSnapshot();

        const pending = requestAgentWorkspaceSnapshot(toBrowserWindow(window), 30_000);
        const request = getSnapshotRequest(window);

        const accepted = submitAgentWorkspaceSnapshotResponse(
            createResponseEvent(window),
            {
                requestId: request.requestId,
                windowId: request.windowId,
                ok: true,
                snapshot,
            },
        );

        expect(accepted).toEqual({ accepted: true });
        await expect(pending).resolves.toBe(snapshot);
        expect(window.listenerCount('closed')).toBe(1);
        expect(window.webContents.listenerCount('render-process-gone')).toBe(1);
        expect(window.webContents.listenerCount('did-start-navigation')).toBe(1);
    });

    it('invalidates a completed snapshot after main-frame navigation', async () => {
        const window = createFakeWindow(707);
        mocks.fromWebContents.mockReturnValue(window);
        const firstSnapshot = createWorkspaceSnapshot();
        const secondSnapshot = {
            ...firstSnapshot,
            capturedAt: requireIsoTimestamp('2026-06-22T00:01:00.000Z'),
        };

        const firstPending = requestAgentWorkspaceSnapshot(toBrowserWindow(window), 30_000);
        const firstRequest = getSnapshotRequest(window);
        expect(submitAgentWorkspaceSnapshotResponse(
            createResponseEvent(window),
            {
                requestId: firstRequest.requestId,
                windowId: firstRequest.windowId,
                ok: true,
                revision: 1,
                snapshot: firstSnapshot,
            },
        )).toEqual({ accepted: true });
        await expect(firstPending).resolves.toBe(firstSnapshot);

        window.webContents.emit('did-start-navigation', {}, 'app://reload', false, true);
        expect(window.listenerCount('closed')).toBe(0);
        expect(window.webContents.listenerCount('render-process-gone')).toBe(0);
        expect(window.webContents.listenerCount('did-start-navigation')).toBe(0);

        const secondPending = requestAgentWorkspaceSnapshot(toBrowserWindow(window), 30_000);
        const secondRequest = getSnapshotRequest(window, 1);
        expect(secondRequest.lastSeenRevision).toBeUndefined();
        expect(submitAgentWorkspaceSnapshotResponse(
            createResponseEvent(window),
            {
                requestId: secondRequest.requestId,
                windowId: secondRequest.windowId,
                ok: true,
                revision: 1,
                snapshot: secondSnapshot,
            },
        )).toEqual({ accepted: true });
        await expect(secondPending).resolves.toBe(secondSnapshot);
    });

    it.each([
        [
            'renderer exit',
            (window: IFakeWindow) => window.webContents.emit('render-process-gone'),
        ],
        [
            'window close',
            (window: IFakeWindow) => window.emit('closed'),
        ],
    ])('invalidates a completed snapshot after %s', async (_name, emitLifecycleEvent) => {
        const window = createFakeWindow(_name === 'renderer exit' ? 708 : 709);
        mocks.fromWebContents.mockReturnValue(window);
        const snapshot = createWorkspaceSnapshot();

        const firstPending = requestAgentWorkspaceSnapshot(toBrowserWindow(window), 30_000);
        const firstRequest = getSnapshotRequest(window);
        expect(submitAgentWorkspaceSnapshotResponse(
            createResponseEvent(window),
            {
                requestId: firstRequest.requestId,
                windowId: firstRequest.windowId,
                ok: true,
                revision: 1,
                snapshot,
            },
        )).toEqual({ accepted: true });
        await expect(firstPending).resolves.toBe(snapshot);

        emitLifecycleEvent(window);
        const secondPending = requestAgentWorkspaceSnapshot(toBrowserWindow(window), 30_000);
        const secondRequest = getSnapshotRequest(window, 1);
        expect(secondRequest.lastSeenRevision).toBeUndefined();
        emitLifecycleEvent(window);
        await expect(secondPending).rejects.toThrow();
    });

    it('resolves unchanged snapshot responses from the per-window cache', async () => {
        const window = createFakeWindow(404);
        mocks.fromWebContents.mockReturnValue(window);
        const snapshot = createWorkspaceSnapshot();

        const firstPending = requestAgentWorkspaceSnapshot(toBrowserWindow(window), 30_000);
        const firstRequest = getSnapshotRequest(window);

        expect(firstRequest.lastSeenRevision).toBeUndefined();
        expect(submitAgentWorkspaceSnapshotResponse(
            createResponseEvent(window),
            {
                requestId: firstRequest.requestId,
                windowId: firstRequest.windowId,
                ok: true,
                revision: 7,
                snapshot,
            },
        )).toEqual({ accepted: true });
        await expect(firstPending).resolves.toBe(snapshot);

        const secondPending = requestAgentWorkspaceSnapshot(toBrowserWindow(window), 30_000);
        const secondRequest = getSnapshotRequest(window, 1);

        expect(secondRequest.lastSeenRevision).toBe(7);
        expect(submitAgentWorkspaceSnapshotResponse(
            createResponseEvent(window),
            {
                requestId: secondRequest.requestId,
                windowId: secondRequest.windowId,
                ok: true,
                revision: 7,
                unchanged: true,
            },
        )).toEqual({ accepted: true });
        await expect(secondPending).resolves.toBe(snapshot);
    });

    it('rejects unchanged snapshot responses when no cache exists', async () => {
        const window = createFakeWindow(505);
        mocks.fromWebContents.mockReturnValue(window);

        const pending = requestAgentWorkspaceSnapshot(toBrowserWindow(window), 30_000);
        const request = getSnapshotRequest(window);

        expect(submitAgentWorkspaceSnapshotResponse(
            createResponseEvent(window),
            {
                requestId: request.requestId,
                windowId: request.windowId,
                ok: true,
                revision: 1,
                unchanged: true,
            },
        )).toEqual({ accepted: true });

        await expect(pending).rejects.toThrow('no cached snapshot is available');
    });

    it('rejects malformed snapshot responses without poisoning the per-window cache', async () => {
        const window = createFakeWindow(606);
        mocks.fromWebContents.mockReturnValue(window);

        const pending = requestAgentWorkspaceSnapshot(toBrowserWindow(window), 30_000);
        const request = getSnapshotRequest(window);

        expect(submitAgentWorkspaceSnapshotResponse(
            createResponseEvent(window),
            {
                requestId: request.requestId,
                windowId: request.windowId,
                ok: true,
                revision: 7,
                snapshot: { tabs: [] },
            },
        )).toEqual({
            accepted: false,
            reason: 'invalid-payload',
        });

        await expect(pending).rejects.toThrow('did not match the expected contract');
        expect(window.listenerCount('closed')).toBe(0);
        expect(window.webContents.listenerCount('render-process-gone')).toBe(0);
        expect(window.webContents.listenerCount('did-start-navigation')).toBe(0);

        const nextPending = requestAgentWorkspaceSnapshot(toBrowserWindow(window), 30_000);
        const nextRequest = getSnapshotRequest(window, 1);
        const snapshot = createWorkspaceSnapshot();

        expect(nextRequest.lastSeenRevision).toBeUndefined();
        expect(submitAgentWorkspaceSnapshotResponse(
            createResponseEvent(window),
            {
                requestId: nextRequest.requestId,
                windowId: nextRequest.windowId,
                ok: true,
                revision: 8,
                snapshot,
            },
        )).toEqual({ accepted: true });

        await expect(nextPending).resolves.toBe(snapshot);
    });

    it('rejects snapshots with malformed deep members through the shared contract validator', async () => {
        const window = createFakeWindow(607);
        mocks.fromWebContents.mockReturnValue(window);
        const pending = requestAgentWorkspaceSnapshot(toBrowserWindow(window), 30_000);
        const request = getSnapshotRequest(window);

        expect(submitAgentWorkspaceSnapshotResponse(
            createResponseEvent(window),
            {
                requestId: request.requestId,
                windowId: request.windowId,
                ok: true,
                snapshot: {
                    ...createWorkspaceSnapshot(),
                    panes: [42],
                },
            },
        )).toEqual({
            accepted: false,
            reason: 'invalid-payload',
        });

        await expect(pending).rejects.toThrow('did not match the expected contract');
    });

    it('returns actionable acknowledgements for invalid and stale snapshot responses', () => {
        const window = createFakeWindow(303);
        mocks.fromWebContents.mockReturnValue(window);

        expect(submitAgentWorkspaceSnapshotResponse(
            createResponseEvent(window),
            {
                requestId: '',
                ok: true,
            },
        )).toEqual({
            accepted: false,
            reason: 'invalid-payload',
        });

        expect(submitAgentWorkspaceSnapshotResponse(
            createResponseEvent(window),
            {
                requestId: 'missing-request',
                ok: false,
            },
        )).toEqual({
            accepted: false,
            reason: 'unknown-request',
        });
    });
});
