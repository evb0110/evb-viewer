import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { EventEmitter } from 'node:events';
import { createWindowSecurity } from '@electron/window/createWindowSecurity';
import type * as WindowRegistry from '@electron/window/registry';
import type * as StartupPhases from '@electron/window/rendererReady';
import type { TRendererStartupPhase } from '@contracts/windowTabsPlatformFeature';
import { createTestEventSender } from '@tests/helpers/electronEventEmitterHarness';

const mocks = vi.hoisted(() => ({
    automation: {hideWindow: true, noFocus: true},
    loadURL: vi.fn(async (_url: string) => {}),
    openExternal: vi.fn(async () => {}),
    setupContentSecurityPolicy: vi.fn(),
    showMessageBox: vi.fn<() => Promise<{response: number}>>(),
}));

vi.mock('electron', () => ({
    app: {isPackaged: true, focus: vi.fn()},
    get BrowserWindow() { return StartupBrowserWindow; },
    dialog: {showMessageBox: mocks.showMessageBox},
    ipcMain: new EventEmitter(),
    shell: {openExternal: mocks.openExternal},
}));
vi.mock('@electron/config', () => ({config: {
    automation: mocks.automation,
    isDev: false,
    renderer: {url: 'evb-viewer://app/electron', trustedUrl: 'evb-viewer://app/electron'},
    window: {title: 'EVB Viewer'},
}}));
vi.mock('@electron/features/diagnostics/public', () => ({captureMainFailure: vi.fn()}));
vi.mock('@electron/security/csp', () => ({setupContentSecurityPolicy: mocks.setupContentSecurityPolicy}));
vi.mock('@electron/te', () => ({te: (key: string) => key}));
vi.mock('@electron/utils/createLogger', () => ({createLogger: createLoggerMock}));
vi.mock('@electron/window/createWindowStartupOptions', () => ({createWindowStartupOptions: () => ({})}));
vi.mock('@electron/window/windowCloseHandshake', () => ({attachNativeWindowCloseHandshake: vi.fn()}));

function createWindowMock() {
    return {
        once: vi.fn(),
        webContents: {
            on: vi.fn(),
            setWindowOpenHandler: vi.fn(),
        },
    };
}

function createLoggerMock() {
    return {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    };
}

class StartupBrowserWindow extends EventEmitter {
    readonly id = 1;
    readonly webContents = Object.assign(createTestEventSender(this.id), {
        focus() {},
        setWindowOpenHandler() {},
    });

    private destroyed = false;

    async loadURL(url: string) {
        this.webContents.emit('did-start-navigation', {}, url, false, true);
        await mocks.loadURL(url);
    }

    isMaximized() { return true; }

    isVisible() { return true; }

    focus() {}

    isDestroyed() {
        return this.destroyed;
    }

    destroy() {
        this.destroyed = true;
        this.emit('closed');
    }
}

describe('main window startup phases', () => {
    const interactive = {phase: 'shell-interactive'} as const;
    const timedOut = {phase: 'failed', reason: 'timed-out'} as const;
    let getRegisteredMainWindow: typeof WindowRegistry.getRegisteredMainWindow;
    let getWindowStartupPhase: typeof StartupPhases.getWindowStartupPhase;
    let publishWindowStartupPhase: typeof StartupPhases.publishWindowStartupPhase;
    let resetWindowStartupPhase: typeof StartupPhases.resetWindowStartupPhase;
    let subscribeWindowStartupPhase: typeof StartupPhases.subscribeWindowStartupPhase;

    async function startWindow() {
        const {createAppWindow} = await import('@electron/window');
        const startup = createAppWindow({waitForInitialRendererReady: true});
        const outcome = startup.then(() => 'interactive' as const, (error: unknown) => error);
        const window = getRegisteredMainWindow()!;
        await vi.advanceTimersByTimeAsync(0);
        return {window, outcome};
    }

    function endRenderer(window: NonNullable<ReturnType<typeof getRegisteredMainWindow>>) {
        window.webContents.emit('render-process-gone', {}, {reason: 'crashed', exitCode: 1});
    }

    async function startWindowWithNativePrompts() {
        mocks.automation.hideWindow = false;
        mocks.automation.noFocus = false;
        const {createAppWindow} = await import('@electron/window');
        const startup = createAppWindow({showStartupPlaceholder: false});
        const window = getRegisteredMainWindow()!;
        // Bootstrap resets the window's phase on a replacement main-frame navigation.
        window.webContents.on('did-start-navigation', () => resetWindowStartupPhase(window.id));
        await startup;
        return window;
    }

    beforeEach(async () => {
        vi.resetModules();
        ({getRegisteredMainWindow} = await import('@electron/window/registry'));
        ({
            getWindowStartupPhase,
            publishWindowStartupPhase,
            resetWindowStartupPhase,
            subscribeWindowStartupPhase,
        } = await import('@electron/window/rendererReady'));
        vi.useFakeTimers();
        mocks.automation.hideWindow = true;
        mocks.automation.noFocus = true;
        mocks.loadURL.mockReset();
        mocks.setupContentSecurityPolicy.mockReset();
        mocks.showMessageBox.mockReset();
    });

    afterEach(() => {
        getRegisteredMainWindow()?.destroy();
        vi.useRealTimers();
    });

    it('keeps startup pending when a main-frame load is aborted', async () => {
        const {window, outcome} = await startWindow();
        window.webContents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'evb-viewer://app/electron', true);
        expect(getWindowStartupPhase(window.id)).toBeNull();

        publishWindowStartupPhase(window.id, interactive);
        expect(await outcome).toBe('interactive');
    });

    it('does not publish a startup phase for a load failure after interactivity', async () => {
        const {window, outcome} = await startWindow();
        publishWindowStartupPhase(window.id, interactive);
        expect(await outcome).toBe('interactive');

        window.webContents.emit('did-start-navigation', {}, 'evb-viewer://app/electron/reload', false, true);
        window.webContents.emit('did-fail-load', {}, -6, 'ERR_FILE_NOT_FOUND', 'evb-viewer://app/electron/reload', true);
        expect(getWindowStartupPhase(window.id)).toEqual(interactive);
        expect(window.isDestroyed()).toBe(false);
    });

    it('keeps the original startup deadline after an early renderer exit', async () => {
        const {window, outcome} = await startWindow();
        const phases: TRendererStartupPhase[] = [];
        subscribeWindowStartupPhase(window.id, {onPhase: phase => phases.push(phase), requestReveal: () => false});

        await vi.advanceTimersByTimeAsync(10_000);
        endRenderer(window);
        await vi.advanceTimersByTimeAsync(19_999);
        expect(phases).toEqual([]);
        expect(window.isDestroyed()).toBe(false);

        await vi.advanceTimersByTimeAsync(1);
        expect(phases).toEqual([timedOut]);
        expect(await outcome).toEqual(new Error('Renderer startup timed out after 30000ms'));
    });

    it('settles on a recovered interactive shell and cancels the startup deadline', async () => {
        const {window, outcome} = await startWindow();
        endRenderer(window);
        await vi.advanceTimersByTimeAsync(0);
        expect(getWindowStartupPhase(window.id)).toBeNull();
        expect(window.isDestroyed()).toBe(false);

        publishWindowStartupPhase(window.id, interactive);
        expect(await outcome).toBe('interactive');
        await vi.advanceTimersByTimeAsync(30_000);
        expect(getWindowStartupPhase(window.id)).toEqual(interactive);
        expect(window.isDestroyed()).toBe(false);
    });

    it('reports renderer-gone when the window has used all three startup recoveries', async () => {
        const {window, outcome} = await startWindow();
        const phases: TRendererStartupPhase[] = [];
        subscribeWindowStartupPhase(window.id, {onPhase: phase => phases.push(phase), requestReveal: () => false});

        for (let recovery = 0; recovery < 3; recovery += 1) {
            endRenderer(window);
            await vi.advanceTimersByTimeAsync(0);
            expect(phases).toEqual([]);
            expect(window.isDestroyed()).toBe(false);
        }

        endRenderer(window);
        expect(phases).toEqual([{phase: 'failed', reason: 'renderer-gone'}]);
        expect(await outcome).toEqual(new Error('Renderer startup failed (renderer-gone)'));
    });

    it('can reload a stalled recovery and offer recovery again at the next startup deadline', async () => {
        const stalledRecovery = Promise.withResolvers<void>();
        const firstPrompt = Promise.withResolvers<{response: number}>();
        const secondPrompt = Promise.withResolvers<{response: number}>();
        mocks.showMessageBox
            .mockReturnValueOnce(firstPrompt.promise)
            .mockReturnValueOnce(secondPrompt.promise);
        const window = await startWindowWithNativePrompts();
        mocks.loadURL.mockReturnValueOnce(stalledRecovery.promise);
        endRenderer(window);
        await vi.advanceTimersByTimeAsync(0);
        expect(mocks.loadURL).toHaveBeenCalledTimes(2);

        await vi.advanceTimersByTimeAsync(30_000);
        expect(getWindowStartupPhase(window.id)).toEqual(timedOut);
        expect(mocks.showMessageBox).toHaveBeenCalledTimes(1);

        firstPrompt.resolve({response: 1});
        await vi.advanceTimersByTimeAsync(0);
        expect(mocks.loadURL).toHaveBeenCalledTimes(3);
        expect(getWindowStartupPhase(window.id)).toBeNull();

        await vi.advanceTimersByTimeAsync(29_999);
        expect(mocks.showMessageBox).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(getWindowStartupPhase(window.id)).toEqual(timedOut);
        expect(mocks.showMessageBox).toHaveBeenCalledTimes(2);
        expect(window.isDestroyed()).toBe(false);
    });

    it.each([
        {action: 'Close', response: 0},
        {action: 'Reload', response: 1},
    ])('ignores a stale $action response after the shell becomes interactive', async ({response}) => {
        const prompt = Promise.withResolvers<{response: number}>();
        mocks.showMessageBox.mockReturnValueOnce(prompt.promise);
        const window = await startWindowWithNativePrompts();
        await vi.advanceTimersByTimeAsync(30_000);
        expect(getWindowStartupPhase(window.id)).toEqual(timedOut);
        expect(mocks.showMessageBox).toHaveBeenCalledTimes(1);

        publishWindowStartupPhase(window.id, interactive);
        prompt.resolve({response});
        await vi.advanceTimersByTimeAsync(0);

        expect(window.isDestroyed()).toBe(false);
        expect(mocks.loadURL).toHaveBeenCalledTimes(1);
        expect(getWindowStartupPhase(window.id)).toEqual(interactive);
    });

    it('retries failed CSP setup before loading the renderer on Reload', async () => {
        const prompt = Promise.withResolvers<{response: number}>();
        mocks.showMessageBox.mockReturnValueOnce(prompt.promise);
        mocks.setupContentSecurityPolicy.mockImplementationOnce(() => {
            throw new Error('Could not read startup CSP hashes');
        });

        const window = await startWindowWithNativePrompts();
        expect(getWindowStartupPhase(window.id)).toEqual({phase: 'failed', reason: 'load-failed'});
        expect(mocks.loadURL).not.toHaveBeenCalled();
        expect(mocks.showMessageBox).toHaveBeenCalledTimes(1);

        prompt.resolve({response: 1});
        await vi.advanceTimersByTimeAsync(0);
        expect(mocks.setupContentSecurityPolicy).toHaveBeenCalledTimes(2);
        expect(mocks.loadURL).toHaveBeenCalledExactlyOnceWith('evb-viewer://app/electron');
        expect(mocks.setupContentSecurityPolicy.mock.invocationCallOrder[1])
            .toBeLessThan(mocks.loadURL.mock.invocationCallOrder[0]!);
    });
});

describe('createWindowSecurity', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.setSystemTime(new Date('2026-06-21T00:00:00Z'));
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('tracks the current trusted renderer URL instead of a startup snapshot', () => {
        let trustedUrl = 'evb-viewer://app/electron';
        const security = createWindowSecurity({
            getTrustedRendererUrl: () => trustedUrl,
            logger: createLoggerMock(),
        });

        expect(security.isTrustedRendererUrl('evb-viewer://app/electron/settings')).toBe(true);

        trustedUrl = 'http://127.0.0.1:41001/electron';

        expect(security.isTrustedRendererUrl('http://127.0.0.1:41001/electron/settings')).toBe(true);
        expect(security.isTrustedRendererUrl('evb-viewer://app/electron/settings')).toBe(false);
    });

    it('rejects same-origin renderer URLs outside the configured app route', () => {
        const security = createWindowSecurity({
            getTrustedRendererUrl: () => 'http://127.0.0.1:41001/electron',
            logger: createLoggerMock(),
        });

        expect(security.isTrustedRendererUrl('http://127.0.0.1:41001/electron')).toBe(true);
        expect(security.isTrustedRendererUrl('http://127.0.0.1:41001/electron/viewer')).toBe(true);
        expect(security.isTrustedRendererUrl('http://127.0.0.1:41001/admin')).toBe(false);
        expect(security.isTrustedRendererUrl('http://127.0.0.1:41001/electronic')).toBe(false);
    });

    it('blocks unsupported protocols before delegating to shell.openExternal', () => {
        const logger = createLoggerMock();
        const security = createWindowSecurity({
            getTrustedRendererUrl: () => 'evb-viewer://app/electron',
            logger,
        });
        const window = createWindowMock();

        security.hardenWindowWebContents(window as never);

        const openHandler = window.webContents.setWindowOpenHandler.mock.calls[0]?.[0] as
            | ((details: {url: string;}) => {action: 'deny';})
            | undefined;

        expect(openHandler).toBeTypeOf('function');
        expect(openHandler?.({ url: 'javascript:alert(1)' })).toEqual({ action: 'deny' });
        expect(mocks.openExternal).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith(
            'Blocked window-open URL with unsupported protocol: javascript:alert(1)',
        );
    });

    it('throttles repeated window-open attempts by source and window instead of full URL', () => {
        vi.useFakeTimers();
        const logger = createLoggerMock();
        const security = createWindowSecurity({
            getTrustedRendererUrl: () => 'evb-viewer://app/electron',
            logger,
        });
        const window = createWindowMock();

        security.hardenWindowWebContents(window as never);

        const openHandler = window.webContents.setWindowOpenHandler.mock.calls[0]?.[0] as
            | ((details: {url: string;}) => {action: 'deny';})
            | undefined;
        expect(openHandler).toBeTypeOf('function');

        openHandler?.({url: 'https://example.com/docs?nonce=1'});
        openHandler?.({url: 'https://example.com/other?nonce=2'});
        openHandler?.({url: 'https://other.example.test/path?nonce=3'});

        expect(mocks.openExternal).toHaveBeenCalledOnce();
        expect(mocks.openExternal).toHaveBeenCalledWith('https://example.com/docs?nonce=1');
        expect(logger.warn).toHaveBeenCalledWith(
            'Blocked repeated window-open URL open: https://example.com/other?nonce=2',
        );
        expect(logger.warn).toHaveBeenCalledWith(
            'Blocked repeated window-open URL open: https://other.example.test/path?nonce=3',
        );

        vi.advanceTimersByTime(1_000);
        openHandler?.({url: 'https://example.com/after'});

        expect(mocks.openExternal).toHaveBeenCalledTimes(2);
        expect(mocks.openExternal).toHaveBeenLastCalledWith('https://example.com/after');
    });

    it('keeps external-open throttles scoped to each window and source', () => {
        vi.useFakeTimers();
        const security = createWindowSecurity({
            getTrustedRendererUrl: () => 'evb-viewer://app/electron',
            logger: createLoggerMock(),
        });
        const firstWindow = createWindowMock();
        const secondWindow = createWindowMock();

        security.hardenWindowWebContents(firstWindow as never);
        security.hardenWindowWebContents(secondWindow as never);

        const firstOpenHandler = firstWindow.webContents.setWindowOpenHandler.mock.calls[0]?.[0] as
            | ((details: {url: string;}) => {action: 'deny';})
            | undefined;
        const secondOpenHandler = secondWindow.webContents.setWindowOpenHandler.mock.calls[0]?.[0] as
            | ((details: {url: string;}) => {action: 'deny';})
            | undefined;
        const firstWillNavigate = firstWindow.webContents.on.mock.calls
            .find(([event]) => event === 'will-navigate')?.[1] as
            | ((event: {preventDefault: () => void;}, url: string) => void)
            | undefined;

        firstOpenHandler?.({url: 'https://example.com/from-first-window'});
        secondOpenHandler?.({url: 'https://example.com/from-second-window'});
        firstWillNavigate?.({preventDefault: vi.fn()}, 'https://example.com/from-navigation');

        expect(mocks.openExternal).toHaveBeenCalledTimes(3);
        expect(mocks.openExternal).toHaveBeenNthCalledWith(1, 'https://example.com/from-first-window');
        expect(mocks.openExternal).toHaveBeenNthCalledWith(2, 'https://example.com/from-second-window');
        expect(mocks.openExternal).toHaveBeenNthCalledWith(3, 'https://example.com/from-navigation');
    });

    it('hardens top-level navigation without blocking trusted renderer routes', async () => {
        vi.useFakeTimers();
        const logger = createLoggerMock();
        const security = createWindowSecurity({
            getTrustedRendererUrl: () => 'evb-viewer://app/electron',
            logger,
        });
        const window = createWindowMock();

        security.hardenWindowWebContents(window as never);

        const willNavigate = window.webContents.on.mock.calls.find(([event]) => event === 'will-navigate')?.[1] as
            | ((event: {preventDefault: () => void;}, url: string) => void)
            | undefined;
        expect(willNavigate).toBeTypeOf('function');

        const trustedEvent = {preventDefault: vi.fn()};
        willNavigate?.(trustedEvent, 'evb-viewer://app/electron/viewer');
        willNavigate?.(trustedEvent, 'about:blank');
        expect(trustedEvent.preventDefault).not.toHaveBeenCalled();

        const externalEvent = {preventDefault: vi.fn()};
        willNavigate?.(externalEvent, 'https://example.com/docs');
        expect(externalEvent.preventDefault).toHaveBeenCalledOnce();
        expect(mocks.openExternal).toHaveBeenCalledWith('https://example.com/docs');

        const javascriptEvent = {preventDefault: vi.fn()};
        willNavigate?.(javascriptEvent, 'javascript:alert(1)');
        expect(javascriptEvent.preventDefault).toHaveBeenCalledOnce();
        expect(mocks.openExternal).toHaveBeenCalledTimes(1);
        expect(logger.warn).toHaveBeenCalledWith(
            'Blocked navigation URL with unsupported protocol: javascript:alert(1)',
        );

        mocks.openExternal.mockRejectedValueOnce(new Error('launch failed'));
        vi.setSystemTime(new Date('2026-06-21T00:00:02Z'));
        willNavigate?.({preventDefault: vi.fn()}, 'https://example.com/fail');
        await vi.runAllTimersAsync();
        expect(logger.warn).toHaveBeenCalledWith(
            'Failed to open external URL (navigation): launch failed',
        );
    });
});
