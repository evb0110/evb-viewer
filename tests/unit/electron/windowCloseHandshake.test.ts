import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { IpcMainEvent } from 'electron';
import {
    CORE_IPC_EVENT_CHANNELS,
    CORE_IPC_SEND_CHANNELS,
} from '@electron/platform-ipc/coreContract';
import {
    attachNativeWindowCloseHandshake,
    NATIVE_WINDOW_CLOSE_HANDSHAKE_TIMEOUT_MS,
} from '@electron/window/windowCloseHandshake';
import {createRawIpcRegistrationAudit} from '@electron/platform-ipc/rawIpcRegistration';

type TResponseHandler = (event: IpcMainEvent, payload: unknown) => void;
interface ITestIpcMain {
    on(channel: string, handler: TResponseHandler): ITestIpcMain;
    removeListener(channel: string, handler: TResponseHandler): ITestIpcMain;
}
interface ISharedIpcHarness {
    responseHandlers: Set<TResponseHandler>;
    ipcMain: ITestIpcMain;
}

function createHarness(options: {
    shouldBypass?: () => boolean;
    timeoutMs?: number;
    windowId?: number;
    shared?: ISharedIpcHarness;
    rawIpcRegistrationAudit?: ReturnType<typeof createRawIpcRegistrationAudit>;
} = {}) {
    const windowHandlers = new Map<string, Array<(...args: unknown[]) => void>>();
    const responseHandlers = options.shared?.responseHandlers ?? new Set<TResponseHandler>();
    const webContentsHandlers = new Map<string, Set<(...args: unknown[]) => void>>();
    const webContents = {
        isDestroyed: vi.fn(() => false),
        send: vi.fn(),
        on(event: string, handler: (...args: unknown[]) => void) {
            const handlers = webContentsHandlers.get(event) ?? new Set();
            handlers.add(handler);
            webContentsHandlers.set(event, handlers);
            return webContents;
        },
        removeListener(event: string, handler: (...args: unknown[]) => void) {
            webContentsHandlers.get(event)?.delete(handler);
            return webContents;
        },
    };
    function emitWebContentsEvent(event: string, ...args: unknown[]) {
        for (const handler of [...(webContentsHandlers.get(event) ?? [])]) {
            handler(...args);
        }
    }
    const logger = {warn: vi.fn()};
    const rawIpcRegistrationAudit = options.rawIpcRegistrationAudit ?? createRawIpcRegistrationAudit();

    const window = {
        id: options.windowId ?? 7,
        webContents,
        isDestroyed: vi.fn(() => false),
        on(event: string, handler: (...args: unknown[]) => void) {
            const handlers = windowHandlers.get(event) ?? [];
            handlers.push(handler);
            windowHandlers.set(event, handlers);
            return window;
        },
        once(event: string, handler: (...args: unknown[]) => void) {
            const wrapped = (...args: unknown[]) => {
                removeWindowHandler(event, wrapped);
                handler(...args);
            };
            const handlers = windowHandlers.get(event) ?? [];
            handlers.push(wrapped);
            windowHandlers.set(event, handlers);
            return window;
        },
        close: vi.fn(() => {
            const event = {preventDefault: vi.fn()};
            emitWindowEvent('close', event);
            if (event.preventDefault.mock.calls.length === 0) {
                emitWindowEvent('closed');
            }
        }),
    };

    function removeWindowHandler(event: string, handler: (...args: unknown[]) => void) {
        const handlers = windowHandlers.get(event) ?? [];
        windowHandlers.set(event, handlers.filter(candidate => candidate !== handler));
    }

    function emitWindowEvent(event: string, ...args: unknown[]) {
        for (const handler of [...(windowHandlers.get(event) ?? [])]) {
            handler(...args);
        }
    }

    const localIpcMain = {} as ITestIpcMain;
    localIpcMain.on = vi.fn((channel: string, handler: TResponseHandler): ITestIpcMain => {
        if (channel === CORE_IPC_SEND_CHANNELS.windowCloseResponse) {
            responseHandlers.add(handler);
        }
        return localIpcMain;
    });
    localIpcMain.removeListener = vi.fn((channel: string, handler: TResponseHandler): ITestIpcMain => {
        if (channel === CORE_IPC_SEND_CHANNELS.windowCloseResponse) {
            responseHandlers.delete(handler);
        }
        return localIpcMain;
    });
    const ipcMain = options.shared?.ipcMain ?? localIpcMain;

    const cleanup = attachNativeWindowCloseHandshake(
        window as never,
        {
            createRequestId: (() => {
                let nextId = 0;
                return () => `close-request-${++nextId}`;
            })(),
            ipcMain: ipcMain as never,
            logger,
            rawIpcRegistrationAudit,
            ...(options.shouldBypass ? {shouldBypass: options.shouldBypass} : {}),
            ...(options.timeoutMs === undefined ? {} : {timeoutMs: options.timeoutMs}),
        },
    );

    return {
        cleanup,
        emitResponse(payload: unknown, sender: unknown = webContents) {
            for (const handler of [...responseHandlers]) {
                handler({sender} as never, payload);
            }
        },
        emitWebContentsEvent,
        emitWindowEvent,
        ipcMain,
        webContentsHandlers,
        logger,
        rawIpcRegistrationAudit,
        responseHandlers,
        webContents,
        window,
    };
}

describe('native window close handshake', () => {
    beforeEach(() => {
        vi.useRealTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('records the real response listener and removes it on cleanup', () => {
        const harness = createHarness();

        expect(harness.rawIpcRegistrationAudit.getRegisteredNames())
            .toEqual(['window-close-response']);
        harness.cleanup();
        expect(harness.ipcMain.removeListener).toHaveBeenCalledWith(
            CORE_IPC_SEND_CHANNELS.windowCloseResponse,
            expect.any(Function),
        );
    });

    it('supports two live window listeners and cleans up both scoped registrations', () => {
        const audit = createRawIpcRegistrationAudit();
        const first = createHarness({
            rawIpcRegistrationAudit: audit,
            windowId: 1,
        });
        const second = createHarness({
            rawIpcRegistrationAudit: audit,
            windowId: 2,
            shared: {
                responseHandlers: first.responseHandlers,
                ipcMain: first.ipcMain,
            },
        });

        first.emitWindowEvent('close', {preventDefault: vi.fn()});
        second.emitWindowEvent('close', {preventDefault: vi.fn()});
        expect(first.webContents.send).toHaveBeenCalledWith(
            CORE_IPC_EVENT_CHANNELS.windowCloseRequest,
            {requestId: 'close-request-1'},
        );
        expect(second.webContents.send).toHaveBeenCalledWith(
            CORE_IPC_EVENT_CHANNELS.windowCloseRequest,
            {requestId: 'close-request-1'},
        );

        first.emitResponse({
            requestId: 'close-request-1',
            decision: 'save',
        }, first.webContents);
        second.emitResponse({
            requestId: 'close-request-1',
            decision: 'discard',
        }, second.webContents);
        expect(first.window.close).toHaveBeenCalledOnce();
        expect(second.window.close).toHaveBeenCalledOnce();

        first.cleanup();
        second.cleanup();
        expect(audit.getRegisteredNames()).toEqual([]);
        expect(first.responseHandlers).toHaveLength(0);
    });

    it.each([
        'save',
        'discard',
    ] as const)('allows an explicit %s decision to close the window', decision => {
        const harness = createHarness();
        const closeEvent = {preventDefault: vi.fn()};

        harness.emitWindowEvent('close', closeEvent);
        expect(closeEvent.preventDefault).toHaveBeenCalledOnce();
        expect(harness.webContents.send).toHaveBeenCalledWith(
            CORE_IPC_EVENT_CHANNELS.windowCloseRequest,
            {requestId: 'close-request-1'},
        );

        harness.emitResponse({
            requestId: 'close-request-1',
            decision,
        });

        expect(harness.window.close).toHaveBeenCalledOnce();
        expect(harness.ipcMain.removeListener).toHaveBeenCalledWith(
            CORE_IPC_SEND_CHANNELS.windowCloseResponse,
            expect.any(Function),
        );
    });

    it('does not leave a one-shot approval armed when another listener vetoes close', () => {
        const harness = createHarness();
        harness.window.on('close', (...args: unknown[]) => {
            const event = args[0] as {preventDefault(): void};
            event.preventDefault();
        });

        harness.emitWindowEvent('close', {preventDefault: vi.fn()});
        harness.emitResponse({
            requestId: 'close-request-1',
            decision: 'save',
        });
        harness.webContents.send.mockClear();

        harness.emitWindowEvent('close', {preventDefault: vi.fn()});

        expect(harness.webContents.send).toHaveBeenCalledWith(
            CORE_IPC_EVENT_CHANNELS.windowCloseRequest,
            {requestId: 'close-request-2'},
        );
        harness.cleanup();
    });

    it('keeps the window open for cancel and retries after a timeout', async () => {
        vi.useFakeTimers();
        const harness = createHarness({timeoutMs: 25});
        const firstCloseEvent = {preventDefault: vi.fn()};

        harness.emitWindowEvent('close', firstCloseEvent);
        harness.emitResponse({
            requestId: 'close-request-1',
            decision: 'cancel',
        });
        expect(harness.window.close).not.toHaveBeenCalled();

        harness.emitWindowEvent('close', {preventDefault: vi.fn()});
        harness.emitResponse({
            requestId: 'close-request-2',
            decision: 'save',
        }, {});
        harness.emitResponse({
            requestId: 'close-request-2',
            decision: 'invalid',
        });
        await vi.advanceTimersByTimeAsync(25);

        expect(harness.window.close).not.toHaveBeenCalled();
        expect(harness.logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('timed out after 25ms'),
        );

        harness.emitWindowEvent('close', {preventDefault: vi.fn()});
        expect(harness.webContents.send).toHaveBeenLastCalledWith(
            CORE_IPC_EVENT_CHANNELS.windowCloseRequest,
            {requestId: 'close-request-3'},
        );
    });

    it.each([
        'save',
        'discard',
    ] as const)('completes an acknowledged %s that arrives after the answer deadline', async decision => {
        vi.useFakeTimers();
        const harness = createHarness({timeoutMs: 25});

        harness.emitWindowEvent('close', {preventDefault: vi.fn()});
        harness.emitResponse({
            requestId: 'close-request-1',
            status: 'acknowledged',
        });
        await vi.advanceTimersByTimeAsync(1_000);
        harness.emitWindowEvent('close', {preventDefault: vi.fn()});
        expect(harness.webContents.send).toHaveBeenCalledOnce();
        expect(harness.window.close).not.toHaveBeenCalled();

        harness.emitResponse({
            requestId: 'close-request-1',
            decision,
        });

        expect(harness.window.close).toHaveBeenCalledOnce();
        expect(harness.logger.warn).not.toHaveBeenCalled();
    });

    it('keeps the window open for a late acknowledged cancel and asks again on the next close', async () => {
        vi.useFakeTimers();
        const harness = createHarness({timeoutMs: 25});

        harness.emitWindowEvent('close', {preventDefault: vi.fn()});
        harness.emitResponse({
            requestId: 'close-request-1',
            status: 'acknowledged',
        });
        await vi.advanceTimersByTimeAsync(1_000);
        harness.emitResponse({
            requestId: 'close-request-1',
            decision: 'cancel',
        });
        harness.emitWindowEvent('close', {preventDefault: vi.fn()});

        expect(harness.window.close).not.toHaveBeenCalled();
        expect(harness.webContents.send).toHaveBeenLastCalledWith(
            CORE_IPC_EVENT_CHANNELS.windowCloseRequest,
            {requestId: 'close-request-2'},
        );
    });

    it('never closes on an acknowledgment and ignores one from the wrong sender or request', async () => {
        vi.useFakeTimers();
        const harness = createHarness({timeoutMs: 25});

        harness.emitWindowEvent('close', {preventDefault: vi.fn()});
        harness.emitResponse({
            requestId: 'close-request-1',
            status: 'acknowledged',
        }, {});
        harness.emitResponse({
            requestId: 'close-request-other',
            status: 'acknowledged',
        });
        await vi.advanceTimersByTimeAsync(25);

        expect(harness.window.close).not.toHaveBeenCalled();
        expect(harness.logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('timed out after 25ms'),
        );
        harness.emitResponse({
            requestId: 'close-request-1',
            decision: 'save',
        });
        expect(harness.window.close).not.toHaveBeenCalled();
    });

    it.each([
        {
            name: 'renderer process loss',
            emit: (harness: ReturnType<typeof createHarness>) => harness.emitWebContentsEvent('render-process-gone', {}, {reason: 'crashed'}),
        },
        {
            name: 'main-frame replacement',
            emit: (harness: ReturnType<typeof createHarness>) => harness.emitWebContentsEvent('did-start-navigation', {}, 'app://reload', false, true),
        },
    ])('settles an acknowledged request on $name without closing', ({emit}) => {
        const harness = createHarness();

        harness.emitWindowEvent('close', {preventDefault: vi.fn()});
        harness.emitResponse({
            requestId: 'close-request-1',
            status: 'acknowledged',
        });
        emit(harness);
        harness.emitResponse({
            requestId: 'close-request-1',
            decision: 'save',
        });
        expect(harness.window.close).not.toHaveBeenCalled();

        harness.emitWindowEvent('close', {preventDefault: vi.fn()});
        expect(harness.webContents.send).toHaveBeenLastCalledWith(
            CORE_IPC_EVENT_CHANNELS.windowCloseRequest,
            {requestId: 'close-request-2'},
        );
    });

    it('keeps an acknowledged request through in-place and subframe navigation', () => {
        const harness = createHarness();

        harness.emitWindowEvent('close', {preventDefault: vi.fn()});
        harness.emitResponse({
            requestId: 'close-request-1',
            status: 'acknowledged',
        });
        harness.emitWebContentsEvent('did-start-navigation', {}, 'app://#hash', true, true);
        harness.emitWebContentsEvent('did-start-navigation', {}, 'about:blank', false, false);
        harness.emitResponse({
            requestId: 'close-request-1',
            decision: 'save',
        });

        expect(harness.window.close).toHaveBeenCalledOnce();
    });

    it('removes its renderer lifecycle listeners on cleanup', () => {
        const harness = createHarness();

        harness.cleanup();

        expect(harness.webContentsHandlers.get('render-process-gone')?.size ?? 0).toBe(0);
        expect(harness.webContentsHandlers.get('did-start-navigation')?.size ?? 0).toBe(0);
    });

    it('removes its renderer listeners when the destroyed window refuses property reads', () => {
        const harness = createHarness();
        // Electron throws "Object has been destroyed" for getters by 'closed'.
        Object.defineProperty(harness.window, 'webContents', {get() {
            throw new TypeError('Object has been destroyed');
        }});

        expect(() => harness.emitWindowEvent('closed')).not.toThrow();
        expect(harness.webContentsHandlers.get('render-process-gone')?.size ?? 0).toBe(0);
        expect(harness.webContentsHandlers.get('did-start-navigation')?.size ?? 0).toBe(0);
    });

    it('keeps the window open and logs an unavailable renderer decision', () => {
        const harness = createHarness();

        harness.emitWindowEvent('close', {preventDefault: vi.fn()});
        harness.emitResponse({
            requestId: 'close-request-1',
            status: 'unavailable',
            reason: 'multiple-handlers',
        });

        expect(harness.window.close).not.toHaveBeenCalled();
        expect(harness.logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('multiple-handlers'),
        );
    });

    it('fails closed when sending the request fails', () => {
        const harness = createHarness();
        harness.webContents.send.mockImplementationOnce(() => {
            throw new Error('renderer unavailable');
        });

        const closeEvent = {preventDefault: vi.fn()};
        harness.emitWindowEvent('close', closeEvent);

        expect(closeEvent.preventDefault).toHaveBeenCalledOnce();
        expect(harness.window.close).not.toHaveBeenCalled();
        expect(harness.logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('Failed to send close request'),
        );
    });

    it('lets coordinated shutdown bypass the user close handshake', () => {
        const harness = createHarness({shouldBypass: () => true});
        const closeEvent = {preventDefault: vi.fn()};

        harness.emitWindowEvent('close', closeEvent);

        expect(closeEvent.preventDefault).not.toHaveBeenCalled();
        expect(harness.webContents.send).not.toHaveBeenCalled();
    });

    it('uses a finite default timeout', () => {
        expect(NATIVE_WINDOW_CLOSE_HANDSHAKE_TIMEOUT_MS).toBeGreaterThan(0);
    });
});
