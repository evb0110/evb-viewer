import type * as TViMockOriginalModule from '@electron/config/constants';
import type * as TViMockOriginalModule2 from '@electron/features/diagnostics/public';

import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { CORE_IPC_EVENT_CHANNELS } from '@electron/platform-ipc/coreContract';

const mocks = vi.hoisted(() => {
    class MockBrowserWindow {
        static windows: MockBrowserWindow[] = [];

        static nextId = 1;

        static getAllWindows() {
            return [...MockBrowserWindow.windows];
        }

        static fromId(windowId: number) {
            return MockBrowserWindow.windows.find(window => window.id === windowId) ?? null;
        }

        readonly id = MockBrowserWindow.nextId++;

        readonly options: unknown;

        private destroyed = false;

        private maximized = false;

        private visible = false;

        private readonly handlers = new Map<string, Array<(...args: unknown[]) => void>>();

        readonly webContents = {
            focus: vi.fn(),
            forcefullyCrashRenderer: vi.fn(),
            getURL: vi.fn(() => 'evb-viewer://app/electron'),
            executeJavaScript: vi.fn(async () => undefined),
            isDestroyed: vi.fn(() => this.destroyed),
            send: vi.fn(),
            on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
                const existing = this.handlers.get(`webContents:${event}`) ?? [];
                existing.push(handler);
                this.handlers.set(`webContents:${event}`, existing);
            }),
            once: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
                const wrapped = (...args: unknown[]) => {
                    this.removeListener(`webContents:${event}`, wrapped);
                    handler(...args);
                };
                const existing = this.handlers.get(`webContents:${event}`) ?? [];
                existing.push(wrapped);
                this.handlers.set(`webContents:${event}`, existing);
            }),
            removeListener: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
                this.removeListener(`webContents:${event}`, handler);
            }),
            setVisualZoomLevelLimits: vi.fn(async () => {}),
            setWindowOpenHandler: vi.fn(),
            setZoomFactor: vi.fn(),
            setZoomLevel: vi.fn(),
        };

        constructor(options: unknown) {
            this.options = options;
            MockBrowserWindow.windows.push(this);
        }

        loadURL = (...args: Parameters<typeof mocks.loadURL>) => mocks.loadURL(...args);

        destroy = vi.fn(() => {
            this.destroyed = true;
            this.emit('closed');
        });

        close = vi.fn(() => {
            const event = {preventDefault: vi.fn()};
            this.emit('close', event);
            if (event.preventDefault.mock.calls.length === 0) {
                this.destroy();
            }
        });

        focus = vi.fn();

        isDestroyed() {
            return this.destroyed;
        }

        isMaximized() {
            return this.maximized;
        }

        isVisible() {
            return this.visible;
        }

        maximize = vi.fn(() => {
            this.maximized = true;
            this.visible = true;
        });

        on(event: string, handler: (...args: unknown[]) => void) {
            const existing = this.handlers.get(event) ?? [];
            existing.push(handler);
            this.handlers.set(event, existing);
            return this;
        }

        once(event: string, handler: (...args: unknown[]) => void) {
            const wrapped = (...args: unknown[]) => {
                this.removeListener(event, wrapped);
                handler(...args);
            };
            const existing = this.handlers.get(event) ?? [];
            existing.push(wrapped);
            this.handlers.set(event, existing);
            return this;
        }

        emit(event: string, ...args: unknown[]) {
            const handlers = [...(this.handlers.get(event) ?? [])];
            for (const handler of handlers) {
                handler(...args);
            }
            return handlers.length > 0;
        }

        emitWebContents(event: string, ...args: unknown[]) {
            const handlers = [...(this.handlers.get(`webContents:${event}`) ?? [])];
            for (const handler of handlers) {
                handler(...args);
            }
            return handlers.length > 0;
        }

        show = vi.fn(() => {
            this.visible = true;
        });

        setMenuBarVisibility = vi.fn();

        private removeListener(event: string, handler: (...args: unknown[]) => void) {
            const existing = this.handlers.get(event) ?? [];
            this.handlers.set(event, existing.filter(listener => listener !== handler));
        }
    }

    return {
        BrowserWindow: MockBrowserWindow,
        app: {
            focus: vi.fn(),
            isPackaged: true,
        },
        ipcMain: {
            on: vi.fn(),
            removeListener: vi.fn(),
        },
        clearCache: vi.fn(async () => {}),
        dialog: { showMessageBox: vi.fn(async () => ({ response: 0 })) },
        loadURL: vi.fn(async (_url?: string) => {}),
        logger: {
            debug: vi.fn(),
            error: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
        },
        config: {
            automation: {
                hideWindow: true,
                noFocus: false,
            },
            isDev: false,
            isMac: false,
            renderer: {
                trustedOrigin: 'evb-viewer://app',
                trustedUrl: 'evb-viewer://app/electron',
                url: 'evb-viewer://app/electron',
            },
            server: {url: 'http://127.0.0.1:3235'},
            window: {
                backgroundColor: '#fff',
                height: 800,
                title: 'EVB Viewer',
                width: 1200,
            },
        },
        openExternal: vi.fn(async () => {}),
        setupContentSecurityPolicy: vi.fn(),
        te: vi.fn((key: string) => key),
        reporter: {capture: vi.fn()},
        getMainFailureReporter: vi.fn(() => ({
            getPreference: () => 'granted',
            capture: mocks.reporter.capture,
        })),
    };
});

vi.mock('electron', () => ({
    BrowserWindow: mocks.BrowserWindow,
    app: mocks.app,
    dialog: mocks.dialog,
    ipcMain: mocks.ipcMain,
    session: {defaultSession: {clearCache: mocks.clearCache}},
    shell: {openExternal: mocks.openExternal},
}));

vi.mock('@electron/config', () => ({config: mocks.config}));

vi.mock('@electron/config/constants', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    WINDOW_RENDERER_READY_TIMEOUT_MS: 30_000,
}));
vi.mock('@electron/te', () => ({te: mocks.te}));

vi.mock('@electron/security/csp', () => ({setupContentSecurityPolicy: mocks.setupContentSecurityPolicy}));

vi.mock('@electron/utils/createLogger', () => ({createLogger: () => mocks.logger}));
vi.mock('@electron/resources/hostResourceProfile', () => ({
    encodeHostResourceProfileArgument: vi.fn(() => '--evb-host-resource-profile=test'),
    getHostResourceProfileSnapshot: vi.fn(() => ({})),
}));
vi.mock('@electron/features/diagnostics/public', async (importOriginal_1) => ({
    ...(await importOriginal_1<typeof TViMockOriginalModule2>()),
    captureMainFailure: (input: {code: string}) => mocks.reporter.capture(input),
    getMainFailureReporter: mocks.getMainFailureReporter,
}));

const windowFailureReceipt = {
    eventId: 'b'.repeat(32),
    code: 'MAIN_RENDERER_PROCESS_GONE',
    occurredAt: 1,
    severity: 'error',
};

describe('window runtime readiness', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        mocks.BrowserWindow.nextId = 1;
        mocks.BrowserWindow.windows.length = 0;
        mocks.loadURL.mockReset();
        mocks.loadURL.mockResolvedValue(undefined);
        mocks.dialog.showMessageBox.mockReset().mockResolvedValue({response: 0});
        mocks.reporter.capture.mockReset().mockImplementation((input: {code: string}) => ({
            ...windowFailureReceipt,
            code: input.code,
        }));
        mocks.config.automation.hideWindow = true;
        mocks.config.automation.noFocus = false;
        mocks.config.isDev = false;
        mocks.config.isMac = false;
        delete process.env.EVB_CLEAR_RENDERER_CACHE;
    });

    it('keeps the native menu bar visible on non-macOS windows', async () => {
        const { createAppWindow } = await import('@electron/window');

        await createAppWindow({ showStartupPlaceholder: false });

        const window = mocks.BrowserWindow.windows[0];
        expect(window?.options).toEqual(expect.objectContaining({autoHideMenuBar: false}));
        expect(window?.options).toEqual(expect.objectContaining({webPreferences: expect.objectContaining({
            additionalArguments: [
                '--evb-host-resource-profile=test',
                '--evb-diagnostics-policy=eyJtb2RlIjoiZ3JhbnRlZCJ9',
            ],
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            preload: expect.stringMatching(/preload\.cjs$/u),
        })}));
        expect(window?.setMenuBarVisibility).not.toHaveBeenCalled();
    });

    it('blocks a native close until the renderer returns a decision', async () => {
        const { createAppWindow } = await import('@electron/window');

        await createAppWindow({showStartupPlaceholder: false});

        const window = mocks.BrowserWindow.windows[0];
        const closeEvent = {preventDefault: vi.fn()};
        window?.emit('close', closeEvent);

        expect(closeEvent.preventDefault).toHaveBeenCalledOnce();
        expect(window?.webContents.send).toHaveBeenCalledWith(
            CORE_IPC_EVENT_CHANNELS.windowCloseRequest,
            expect.objectContaining({requestId: expect.any(String)}),
        );
    });

    it('keeps the native menu bar visible on macOS windows', async () => {
        mocks.config.isMac = true;
        const { createAppWindow } = await import('@electron/window');

        await createAppWindow({ showStartupPlaceholder: false });

        const window = mocks.BrowserWindow.windows[0];
        expect(window?.options).toEqual(expect.objectContaining({autoHideMenuBar: false}));
        expect(window?.setMenuBarVisibility).not.toHaveBeenCalled();
    });

    it('keeps hidden automation renderers painting without changing interactive window defaults', async () => {
        const { createAppWindow } = await import('@electron/window');

        await createAppWindow({ showStartupPlaceholder: false });
        expect(mocks.BrowserWindow.windows[0]?.options).toEqual(expect.objectContaining({
            paintWhenInitiallyHidden: true,
            webPreferences: expect.objectContaining({backgroundThrottling: false}),
        }));

        mocks.config.automation.hideWindow = false;
        await createAppWindow({ showStartupPlaceholder: false });
        expect(mocks.BrowserWindow.windows[1]?.options).not.toHaveProperty('paintWhenInitiallyHidden');
        expect(mocks.BrowserWindow.windows[1]?.options).not.toHaveProperty('webPreferences.backgroundThrottling');
    });

    it('waits for the initial rendererReady signal when requested', async () => {
        const { createAppWindow } = await import('@electron/window');
        const { markWindowRendererReady } = await import('@electron/window/rendererReady');

        const createPromise = createAppWindow({ waitForInitialRendererReady: true });
        await vi.waitFor(() => {
            expect(mocks.BrowserWindow.windows).toHaveLength(1);
        });

        markWindowRendererReady(1);

        await expect(createPromise).resolves.toBe(mocks.BrowserWindow.windows[0]);
    });

    it('keeps strict startup hidden until rendererReady', async () => {
        mocks.config.automation.hideWindow = false;
        const { createAppWindow } = await import('@electron/window');
        const { markWindowRendererReady } = await import('@electron/window/rendererReady');

        const createPromise = createAppWindow({ waitForInitialRendererReady: true });
        await vi.waitFor(() => {
            expect(mocks.BrowserWindow.windows).toHaveLength(1);
        });

        const window = mocks.BrowserWindow.windows[0];
        expect(mocks.loadURL).not.toHaveBeenCalledWith('about:blank');
        expect(window?.maximize).not.toHaveBeenCalled();
        expect(window?.isVisible()).toBe(false);

        window?.emitWebContents('did-finish-load');
        markWindowRendererReady(1);
        await createPromise;

        await vi.waitFor(() => {
            expect(window?.maximize).toHaveBeenCalledTimes(1);
        });
        expect(window?.isVisible()).toBe(true);
    });

    it('force-shows strict startup when rendererReady never arrives', async () => {
        vi.useFakeTimers();
        try {
            mocks.config.automation.hideWindow = false;
            const { createAppWindow } = await import('@electron/window');

            const createPromise = createAppWindow({ waitForInitialRendererReady: true });
            await vi.waitFor(() => {
                expect(mocks.BrowserWindow.windows).toHaveLength(1);
            });

            const window = mocks.BrowserWindow.windows[0];
            expect(window?.maximize).not.toHaveBeenCalled();

            await vi.advanceTimersByTimeAsync(15_000);

            expect(window?.maximize).toHaveBeenCalledTimes(1);
            expect(window?.isVisible()).toBe(true);

            window?.destroy();
            await expect(createPromise).rejects.toThrow('Window closed before renderer startup completed');
        } finally {
            vi.useRealTimers();
        }
    });

    it('cleans renderer-ready startup handlers when a hidden startup window closes', async () => {
        mocks.config.automation.hideWindow = false;
        const { createAppWindow } = await import('@electron/window');
        const { markWindowRendererReady } = await import('@electron/window/rendererReady');

        const createPromise = createAppWindow({ waitForInitialRendererReady: true });
        await vi.waitFor(() => {
            expect(mocks.BrowserWindow.windows).toHaveLength(1);
        });

        const window = mocks.BrowserWindow.windows[0];
        window?.destroy();

        await expect(createPromise).rejects.toThrow('Window closed before renderer startup completed');
        markWindowRendererReady(1);

        expect(window?.maximize).not.toHaveBeenCalled();
        expect(window?.webContents.removeListener).toHaveBeenCalledWith('did-start-navigation', expect.any(Function));
        expect(window?.webContents.removeListener).toHaveBeenCalledWith('did-finish-load', expect.any(Function));
        expect(window?.webContents.removeListener).toHaveBeenCalledWith('did-fail-load', expect.any(Function));
    });

    it('keeps dev strict startup hidden instead of showing the startup placeholder', async () => {
        mocks.config.automation.hideWindow = false;
        mocks.config.isDev = true;
        const { createAppWindow } = await import('@electron/window');
        const { markWindowRendererReady } = await import('@electron/window/rendererReady');

        const createPromise = createAppWindow({ waitForInitialRendererReady: true });
        await vi.waitFor(() => {
            expect(mocks.BrowserWindow.windows).toHaveLength(1);
        });

        const window = mocks.BrowserWindow.windows[0];
        expect(mocks.loadURL).not.toHaveBeenCalledWith('about:blank');
        expect(window?.maximize).not.toHaveBeenCalled();
        expect(window?.isVisible()).toBe(false);

        markWindowRendererReady(1);
        await createPromise;
        expect(window?.isVisible()).toBe(false);

        window?.destroy();
    });

    it('shows dev strict startup after in-place navigations settle', async () => {
        vi.useFakeTimers();
        try {
            mocks.config.automation.hideWindow = false;
            mocks.config.isDev = true;
            const { createAppWindow } = await import('@electron/window');
            const { markWindowRendererReady } = await import('@electron/window/rendererReady');

            const createPromise = createAppWindow({ waitForInitialRendererReady: true });
            const window = mocks.BrowserWindow.windows[0];
            expect(window).toBeDefined();
            expect(mocks.loadURL).not.toHaveBeenCalledWith('about:blank');

            window?.emitWebContents('did-finish-load');
            window?.emitWebContents('did-start-navigation', {}, mocks.config.renderer.url, true, true);
            markWindowRendererReady(1);
            await createPromise;

            expect(window?.maximize).not.toHaveBeenCalled();

            await vi.advanceTimersByTimeAsync(200);

            expect(window?.maximize).toHaveBeenCalledTimes(1);
            expect(window?.isVisible()).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it('creates the startup window before the renderer load completes', async () => {
        mocks.config.automation.hideWindow = false;
        let resolveLoad: () => void = () => {
            throw new Error('loadURL was not called');
        };
        mocks.loadURL.mockImplementation(async (url?: string) => {
            if (url === mocks.config.renderer.url) {
                await new Promise<void>((resolve) => {
                    resolveLoad = resolve;
                });
            }
        });
        const { createAppWindow } = await import('@electron/window');

        const createPromise = createAppWindow();
        await vi.waitFor(() => {
            expect(mocks.BrowserWindow.windows).toHaveLength(1);
        });

        const window = mocks.BrowserWindow.windows[0];
        await vi.waitFor(() => {
            expect(mocks.loadURL).toHaveBeenCalledWith(mocks.config.renderer.url);
        });

        resolveLoad();
        await expect(createPromise).resolves.toBe(window);
    });

    it('reports did-fail-load and loadURL rejection once for one initial load attempt', async () => {
        let rejectLoad: (error: Error) => void = () => {
            throw new Error('loadURL was not called');
        };
        const loadError = new Error('renderer bootstrap failed');
        mocks.loadURL.mockImplementation(async (url?: string) => {
            if (url === mocks.config.renderer.url) {
                await new Promise<void>((_resolve, reject) => {
                    rejectLoad = reject;
                });
            }
        });
        const { createAppWindow } = await import('@electron/window');

        const createPromise = createAppWindow({ waitForInitialRendererReady: true });
        await vi.waitFor(() => {
            expect(mocks.loadURL).toHaveBeenCalledWith(mocks.config.renderer.url);
        });

        const window = mocks.BrowserWindow.windows[0];
        window?.emitWebContents('did-start-navigation', {}, mocks.config.renderer.url, false, true);
        window?.emitWebContents(
            'did-fail-load',
            {},
            -105,
            'NAME_NOT_RESOLVED',
            mocks.config.renderer.url,
            true,
        );
        rejectLoad(loadError);

        await expect(createPromise).rejects.toThrow('Initial renderer load failed');
        expect(mocks.logger.error).toHaveBeenCalledTimes(1);
    });

    it('keeps a late initial loadURL rejection attached to its original attempt', async () => {
        let rejectLoad: (error: Error) => void = () => {
            throw new Error('loadURL was not called');
        };
        const loadError = new Error('late renderer bootstrap failure');
        mocks.loadURL.mockImplementation(async (url?: string) => {
            if (url === mocks.config.renderer.url) {
                await new Promise<void>((_resolve, reject) => {
                    rejectLoad = reject;
                });
            }
        });
        const { createAppWindow } = await import('@electron/window');

        const createPromise = createAppWindow({ showStartupPlaceholder: false });
        await vi.waitFor(() => {
            expect(mocks.loadURL).toHaveBeenCalledWith(mocks.config.renderer.url);
        });

        const window = mocks.BrowserWindow.windows[0];
        window?.emitWebContents('did-start-navigation', {}, mocks.config.renderer.url, false, true);
        window?.emitWebContents('did-start-navigation', {}, `${mocks.config.renderer.url}?later`, false, true);
        window?.emitWebContents(
            'did-fail-load',
            {},
            -2,
            'FAILED',
            `${mocks.config.renderer.url}?later`,
            true,
        );
        rejectLoad(loadError);

        await expect(createPromise).rejects.toThrow('late renderer bootstrap failure');
        expect(mocks.logger.error).toHaveBeenCalledTimes(2);
    });

    it('starts a second occurrence for a distinct later top-level navigation failure', async () => {
        const { createAppWindow } = await import('@electron/window');

        await createAppWindow({ showStartupPlaceholder: false });
        const window = mocks.BrowserWindow.windows[0];
        expect(window).toBeDefined();
        vi.clearAllMocks();

        window?.emitWebContents('did-start-navigation', {}, mocks.config.renderer.url, false, true);
        window?.emitWebContents(
            'did-fail-load',
            {},
            -105,
            'NAME_NOT_RESOLVED',
            mocks.config.renderer.url,
            true,
        );
        window?.emitWebContents('did-start-navigation', {}, `${mocks.config.renderer.url}?retry=1`, false, true);
        window?.emitWebContents(
            'did-fail-load',
            {},
            -2,
            'FAILED',
            `${mocks.config.renderer.url}?retry=1`,
            true,
        );

        expect(mocks.logger.error).toHaveBeenCalledTimes(2);
    });

    it('keeps in-place navigation and redirects on the current occurrence', async () => {
        const { createAppWindow } = await import('@electron/window');

        await createAppWindow({ showStartupPlaceholder: false });
        const window = mocks.BrowserWindow.windows[0];
        expect(window).toBeDefined();
        vi.clearAllMocks();

        window?.emitWebContents('did-start-navigation', {}, mocks.config.renderer.url, false, true);
        window?.emitWebContents('did-start-navigation', {}, `${mocks.config.renderer.url}#section`, true, true);
        window?.emitWebContents('will-redirect', {}, `${mocks.config.renderer.url}/redirected`, false, true);
        window?.emitWebContents(
            'did-fail-load',
            {},
            -105,
            'NAME_NOT_RESOLVED',
            `${mocks.config.renderer.url}/redirected`,
            true,
        );

        expect(mocks.logger.error).toHaveBeenCalledTimes(1);
    });

    it('does not create a load occurrence for a subframe failure', async () => {
        const { createAppWindow } = await import('@electron/window');

        await createAppWindow({ showStartupPlaceholder: false });
        const window = mocks.BrowserWindow.windows[0];
        expect(window).toBeDefined();
        const didFailLoadRegistrations = window?.webContents.on.mock.calls.filter(([event]) => event === 'did-fail-load');
        vi.clearAllMocks();

        window?.emitWebContents('did-start-navigation', {}, 'https://example.invalid/frame', false, false);
        window?.emitWebContents(
            'did-fail-load',
            {},
            -105,
            'NAME_NOT_RESOLVED',
            'https://example.invalid/frame',
            false,
        );

        expect(didFailLoadRegistrations).toHaveLength(1);
        expect(mocks.logger.error).not.toHaveBeenCalled();
    });

    it('keeps the renderer-ready timeout alive after force-show', async () => {
        vi.useFakeTimers();
        try {
            mocks.config.automation.hideWindow = false;
            const { createAppWindow } = await import('@electron/window');

            const createPromise = createAppWindow({ waitForInitialRendererReady: true });
            const createRejection = expect(createPromise).rejects.toThrow('Renderer startup timed out after 30000ms');
            await vi.waitFor(() => {
                expect(mocks.BrowserWindow.windows).toHaveLength(1);
            });

            const window = mocks.BrowserWindow.windows[0];
            await vi.advanceTimersByTimeAsync(15_000);

            expect(window?.isVisible()).toBe(true);
            expect(window?.maximize).toHaveBeenCalledTimes(1);

            await vi.advanceTimersByTimeAsync(15_000);

            await createRejection;
            expect(window?.destroy).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it('can show the real shell on first load without an about:blank placeholder', async () => {
        vi.useFakeTimers();
        try {
            mocks.config.automation.hideWindow = false;
            const { createAppWindow } = await import('@electron/window');

            const createdWindow = await createAppWindow({ showStartupPlaceholder: false });
            const window = mocks.BrowserWindow.windows.at(-1);

            expect(createdWindow).toBe(window);
            expect(window).toBeDefined();
            expect(mocks.loadURL).not.toHaveBeenCalledWith('about:blank');
            expect(mocks.loadURL).toHaveBeenCalledWith(mocks.config.renderer.url);
            expect(window?.isVisible()).toBe(false);

            window?.emitWebContents('did-finish-load');
            await vi.advanceTimersByTimeAsync(0);

            expect(window?.maximize).toHaveBeenCalledTimes(1);
            expect(window?.isVisible()).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not clear the dev renderer cache by default', async () => {
        mocks.config.isDev = true;
        const { createAppWindow } = await import('@electron/window');

        await createAppWindow();

        expect(mocks.clearCache).not.toHaveBeenCalled();
    });

    it('clears the dev renderer cache when explicitly requested', async () => {
        mocks.config.isDev = true;
        process.env.EVB_CLEAR_RENDERER_CACHE = '1';
        const { createAppWindow } = await import('@electron/window');

        await createAppWindow();

        expect(mocks.clearCache).toHaveBeenCalledTimes(1);
    });

    it('logs transient unresponsive renderer events as warnings', async () => {
        const { createAppWindow } = await import('@electron/window');

        await createAppWindow();
        const window = mocks.BrowserWindow.windows[0];
        expect(window).toBeDefined();
        vi.clearAllMocks();

        window?.emit('unresponsive');

        expect(mocks.logger.warn).toHaveBeenCalledWith('[renderer] window unresponsive (windowId=1)');
        expect(mocks.logger.error).not.toHaveBeenCalled();

        window?.emit('responsive');
    });

    it('owns one renderer-gone occurrence and reuses its receipt for the error projection', async () => {
        const { createAppWindow } = await import('@electron/window');

        await createAppWindow();
        const window = mocks.BrowserWindow.windows[0];
        expect(window).toBeDefined();
        vi.clearAllMocks();

        window?.emitWebContents('render-process-gone', {}, {
            exitCode: 1,
            reason: 'crashed',
        });
        await vi.waitFor(() => {
            expect(mocks.loadURL).toHaveBeenCalledTimes(1);
        });

        expect(mocks.reporter.capture).toHaveBeenCalledOnce();
        expect(mocks.reporter.capture).toHaveBeenCalledWith(expect.objectContaining({
            code: 'MAIN_RENDERER_PROCESS_GONE',
            operation: 'main-error',
            context: {
                reason: 'crashed',
                exitCode: 1,
            },
        }));
        expect(mocks.logger.error).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({eventId: windowFailureReceipt.eventId}));
    });

    it('does not duplicate an initial renderer death through the renderer-ready load owner', async () => {
        const { createAppWindow } = await import('@electron/window');
        const createPromise = createAppWindow({waitForInitialRendererReady: true});
        await vi.waitFor(() => {
            expect(mocks.BrowserWindow.windows).toHaveLength(1);
        });

        const window = mocks.BrowserWindow.windows[0];
        window?.emitWebContents('render-process-gone', {}, {
            exitCode: 1,
            reason: 'crashed',
        });
        window?.emitWebContents(
            'did-fail-load',
            {},
            -105,
            'NAME_NOT_RESOLVED',
            mocks.config.renderer.url,
            true,
        );

        await expect(createPromise).rejects.toThrow('Renderer process exited before startup completed');
        expect(mocks.reporter.capture).toHaveBeenCalledOnce();
        expect(mocks.reporter.capture).toHaveBeenCalledWith(expect.objectContaining({code: 'MAIN_RENDERER_PROCESS_GONE'}));
        expect(mocks.logger.error).toHaveBeenCalledOnce();
    });

    it('owns a failed renderer recovery load with its bounded trigger and attempt', async () => {
        const { createAppWindow } = await import('@electron/window');

        await createAppWindow();
        const window = mocks.BrowserWindow.windows[0];
        expect(window).toBeDefined();
        vi.clearAllMocks();
        mocks.loadURL.mockRejectedValueOnce(new Error('recovery load failed'));

        window?.emitWebContents('render-process-gone', {}, {
            exitCode: 1,
            reason: 'oom',
        });
        window?.emitWebContents('did-start-navigation', {}, mocks.config.renderer.url, false, true);
        window?.emitWebContents(
            'did-fail-load',
            {},
            -105,
            'NAME_NOT_RESOLVED',
            mocks.config.renderer.url,
            true,
        );
        await vi.waitFor(() => {
            expect(mocks.reporter.capture).toHaveBeenCalledTimes(2);
        });

        expect(mocks.reporter.capture.mock.calls.map(([input]) => input.code)).toEqual([
            'MAIN_RENDERER_PROCESS_GONE',
            'MAIN_RENDERER_RECOVERY_FAILED',
        ]);
        expect(mocks.reporter.capture.mock.calls[1]?.[0]).toEqual(expect.objectContaining({context: {
            trigger: 'renderer-gone',
            recoveryAttempt: 1,
        }}));
        expect(mocks.logger.error).toHaveBeenCalledTimes(2);
    });

    it('owns one bounded preload failure occurrence without sending its path or stack', async () => {
        const { createAppWindow } = await import('@electron/window');

        await createAppWindow();
        const window = mocks.BrowserWindow.windows[0];
        expect(window).toBeDefined();
        vi.clearAllMocks();
        const preloadError = new Error('preload secret stack');

        window?.emitWebContents('preload-error', {}, '/private/secret/preload.cjs', preloadError);

        expect(mocks.reporter.capture).toHaveBeenCalledOnce();
        expect(mocks.reporter.capture).toHaveBeenCalledWith(expect.objectContaining({
            code: 'MAIN_PRELOAD_ERROR',
            context: {hasStack: true},
            local: expect.objectContaining({
                source: 'window',
                cause: preloadError,
            }),
        }));
        expect(mocks.logger.error).toHaveBeenCalledWith(expect.stringContaining('preload secret stack'), expect.anything());
        const capturedInput = mocks.reporter.capture.mock.calls[0]?.[0] as {
            context: unknown;
            local: {message: string}
        };
        expect(capturedInput.context).toEqual({hasStack: true});
        expect(JSON.stringify(capturedInput.context)).not.toContain('/private/secret/preload.cjs');
        expect(capturedInput.local.message).toContain('/private/secret/preload.cjs');
    });

    it('reports delayed unresponsive recovery once and keeps its timer and reload behavior', async () => {
        vi.useFakeTimers();
        try {
            const { createAppWindow } = await import('@electron/window');

            await createAppWindow();
            const window = mocks.BrowserWindow.windows[0];
            expect(window).toBeDefined();
            vi.clearAllMocks();

            window?.emit('unresponsive');
            expect(mocks.reporter.capture).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(14_999);
            expect(mocks.reporter.capture).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(1);
            await vi.waitFor(() => {
                expect(mocks.loadURL).toHaveBeenCalledTimes(1);
            });

            expect(mocks.reporter.capture).toHaveBeenCalledOnce();
            expect(mocks.reporter.capture).toHaveBeenCalledWith(expect.objectContaining({
                code: 'MAIN_UNRESPONSIVE_RENDERER',
                context: {
                    automated: true,
                    recoveryAttempt: 0,
                },
            }));
            expect(mocks.logger.error).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({eventId: windowFailureReceipt.eventId}));
        } finally {
            vi.useRealTimers();
        }
    });

    it('reports an unresponsive prompt failure once and still uses the fallback reload', async () => {
        vi.useFakeTimers();
        try {
            mocks.config.automation.hideWindow = false;
            mocks.dialog.showMessageBox.mockRejectedValueOnce(new Error('dialog unavailable'));
            const { createAppWindow } = await import('@electron/window');

            await createAppWindow();
            const window = mocks.BrowserWindow.windows[0];
            expect(window).toBeDefined();
            vi.clearAllMocks();

            window?.emit('unresponsive');
            await vi.advanceTimersByTimeAsync(15_000);
            await vi.waitFor(() => {
                expect(mocks.loadURL).toHaveBeenCalledTimes(1);
            });

            expect(mocks.reporter.capture).toHaveBeenCalledTimes(2);
            expect(mocks.reporter.capture.mock.calls.map(([input]) => input.code)).toEqual([
                'MAIN_UNRESPONSIVE_RENDERER',
                'MAIN_UNRESPONSIVE_RECOVERY_FAILED',
            ]);
            expect(mocks.reporter.capture.mock.calls[1]?.[0]).toEqual(expect.objectContaining({context: {
                trigger: 'unresponsive-dialog-prompt',
                recoveryAttempt: 1,
            }}));
        } finally {
            vi.useRealTimers();
        }
    });

    it('uses the unresponsive recovery code when its reload fails', async () => {
        vi.useFakeTimers();
        try {
            const { createAppWindow } = await import('@electron/window');

            await createAppWindow();
            const window = mocks.BrowserWindow.windows[0];
            expect(window).toBeDefined();
            vi.clearAllMocks();
            mocks.loadURL.mockRejectedValueOnce(new Error('unresponsive reload failed'));

            window?.emit('unresponsive');
            await vi.advanceTimersByTimeAsync(15_000);
            await vi.waitFor(() => {
                expect(mocks.reporter.capture).toHaveBeenCalledTimes(2);
            });

            expect(mocks.reporter.capture.mock.calls.map(([input]) => input.code)).toEqual([
                'MAIN_UNRESPONSIVE_RENDERER',
                'MAIN_UNRESPONSIVE_RECOVERY_FAILED',
            ]);
            expect(mocks.reporter.capture.mock.calls[1]?.[0]).toEqual(expect.objectContaining({context: {
                trigger: 'unresponsive-automation',
                recoveryAttempt: 1,
            }}));
        } finally {
            vi.useRealTimers();
        }
    });

    it('keeps renderer death during teardown at info level with no occurrence', async () => {
        const { createAppWindow } = await import('@electron/window');

        await createAppWindow();
        const window = mocks.BrowserWindow.windows[0];
        expect(window).toBeDefined();
        vi.clearAllMocks();

        window?.destroy();
        window?.emitWebContents('render-process-gone', {}, {
            exitCode: 1,
            reason: 'killed',
        });
        window?.emitWebContents('preload-error', {}, '/private/preload.cjs', new Error('teardown'));

        expect(mocks.reporter.capture).not.toHaveBeenCalled();
        expect(mocks.logger.error).not.toHaveBeenCalled();
        expect(mocks.logger.info).toHaveBeenCalledTimes(2);
    });

    it('rearms renderer recovery after a completed reload while bounding crash loops', async () => {
        const { createAppWindow } = await import('@electron/window');

        await createAppWindow();
        const window = mocks.BrowserWindow.windows[0];
        expect(window).toBeDefined();
        vi.clearAllMocks();

        for (let attempt = 0; attempt < 4; attempt += 1) {
            window?.emitWebContents('render-process-gone', {}, {
                exitCode: 1,
                reason: 'crashed',
            });
            await vi.waitFor(() => {
                expect(mocks.loadURL).toHaveBeenCalledTimes(Math.min(attempt + 1, 3));
            });
        }

        expect(mocks.loadURL).toHaveBeenCalledTimes(3);
        expect(mocks.logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('attempt=3'),
        );
    });

    it('does not offer unresponsive recovery after exhausting the reload cap', async () => {
        vi.useFakeTimers();
        try {
            mocks.config.automation.hideWindow = false;
            const {createAppWindow} = await import('@electron/window');

            await createAppWindow();
            const window = mocks.BrowserWindow.windows[0];
            expect(window).toBeDefined();
            vi.clearAllMocks();

            for (let attempt = 0; attempt < 3; attempt += 1) {
                window?.emitWebContents('render-process-gone', {}, {
                    exitCode: 1,
                    reason: 'crashed',
                });
                await vi.waitFor(() => {
                    expect(mocks.loadURL).toHaveBeenCalledTimes(attempt + 1);
                });
            }
            window?.emit('unresponsive');
            await vi.advanceTimersByTimeAsync(15_000);

            expect(mocks.dialog.showMessageBox).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it('escalates persistent unresponsive renderers after the recovery delay', async () => {
        vi.useFakeTimers();
        try {
            mocks.config.automation.hideWindow = false;
            const { createAppWindow } = await import('@electron/window');

            await createAppWindow();
            const window = mocks.BrowserWindow.windows[0];
            expect(window).toBeDefined();
            vi.clearAllMocks();

            window?.emit('unresponsive');
            expect(mocks.logger.error).not.toHaveBeenCalled();

            await vi.advanceTimersByTimeAsync(15_000);

            expect(mocks.logger.error).toHaveBeenCalledWith(
                '[renderer] window remained unresponsive after 15000ms (windowId=1)',
                expect.objectContaining({eventId: windowFailureReceipt.eventId}),
            );
            expect(mocks.dialog.showMessageBox).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it('rejects strict startup when the initial loadURL call fails', async () => {
        const loadError = new Error('renderer bootstrap failed');
        const { createAppWindow } = await import('@electron/window');

        mocks.loadURL.mockImplementation(async (url?: string) => {
            if (url === mocks.config.renderer.url) {
                throw loadError;
            }
        });

        await expect(createAppWindow({ waitForInitialRendererReady: true }))
            .rejects
            .toThrow('Initial loadURL failed: renderer bootstrap failed');

        expect(mocks.BrowserWindow.windows[0]?.destroy).toHaveBeenCalledTimes(1);
    });
});
