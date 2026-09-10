import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => {
    const consoleObserverCleanup = vi.fn();
    return {
        reportRuntimeError: vi.fn(),
        onDebugLog: vi.fn(),
        consoleObserverCleanup,
        installConsoleErrorObserver: vi.fn(() => ({cleanup: consoleObserverCleanup})),
        hasElectronAPI: vi.fn(() => false),
        isElectronUserAgent: vi.fn(() => false),
        getValidatedElectronPlatformApi: vi.fn((): unknown => undefined),
        waitForPreferredDesktopPlatformBridge: vi.fn(async () => ({
            bridgeReady: false,
            shouldWait: false,
        })),
    };
});

vi.mock('@app/utils/getSettingsCapability', () => ({getSettingsCapability: () => ({onDebugLog: mocks.onDebugLog})}));
vi.mock('@app/utils/platform', () => ({
    hasElectronAPI: mocks.hasElectronAPI,
    isElectronUserAgent: mocks.isElectronUserAgent,
    waitForPreferredDesktopPlatformBridge: mocks.waitForPreferredDesktopPlatformBridge,
}));
vi.mock('@app/utils/electronPlatformBridge', () => ({getValidatedElectronPlatformApi: mocks.getValidatedElectronPlatformApi}));

vi.mock('@app/composables/useRuntimeErrorReports', () => (
    {useRuntimeErrorReports: () => ({reportRuntimeError: mocks.reportRuntimeError})}
));

const browserLoggerMock = {
    error: vi.fn(),
    warnThrottled: vi.fn(),
};

vi.mock('@app/utils/browserLogger', () => ({BrowserLogger: browserLoggerMock}));
vi.mock('@app/utils/consoleErrorObserver', () => ({installConsoleErrorObserver: mocks.installConsoleErrorObserver}));

function installAutoImportStubs() {
    vi.stubGlobal('defineNuxtPlugin', (plugin: unknown) => plugin);
    vi.stubGlobal('useRuntimeErrorReports', () => ({reportRuntimeError: mocks.reportRuntimeError}));
    vi.stubGlobal('useCookie', () => ({value: 'en'}));
}

function createNuxtApp() {
    const hooks = new Map<string, () => void>();
    const originalUnmount = vi.fn();
    const previousErrorHandler = vi.fn();
    return {
        hooks,
        originalUnmount,
        previousErrorHandler,
        nuxtApp: {
            hook: vi.fn((name: string, callback: () => void) => {
                hooks.set(name, callback);
            }),
            vueApp: {
                config: {errorHandler: previousErrorHandler},
                unmount: originalUnmount,
            },
        },
    };
}

async function flushPluginTasks() {
    await Promise.resolve();
    await Promise.resolve();
}

describe('renderer hygiene plugins', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        vi.unstubAllGlobals();
        installAutoImportStubs();
        vi.stubGlobal('window', new EventTarget());
        Object.defineProperty(window, 'location', {
            configurable: true,
            value: { pathname: '/' },
        });
    });

    it('unsubscribes the runtime error log stream on app unmount and guards duplicate installs', async () => {
        const unsubscribe = vi.fn();
        mocks.onDebugLog.mockReturnValue(unsubscribe);
        const plugin = (await import('@app/plugins/runtimeErrorLogStream.client')).default as (app: unknown) => void;
        const harness = createNuxtApp();

        plugin(harness.nuxtApp);
        plugin(harness.nuxtApp);
        harness.hooks.get('app:mounted')?.();
        harness.hooks.get('app:mounted')?.();
        await flushPluginTasks();
        harness.nuxtApp.vueApp.unmount();

        expect(harness.nuxtApp.hook).toHaveBeenCalledTimes(1);
        expect(mocks.waitForPreferredDesktopPlatformBridge).toHaveBeenCalledWith({ routePath: '/' });
        expect(mocks.onDebugLog).toHaveBeenCalledTimes(1);
        expect(unsubscribe).toHaveBeenCalledTimes(1);
        expect(harness.originalUnmount).toHaveBeenCalledTimes(1);
    });

    it('waits for an Electron bridge before subscribing to runtime debug logs', async () => {
        const unsubscribe = vi.fn();
        let resolveBridge!: () => void;
        mocks.onDebugLog.mockReturnValue(unsubscribe);
        mocks.isElectronUserAgent.mockReturnValue(true);
        mocks.waitForPreferredDesktopPlatformBridge.mockReturnValue(new Promise((resolve) => {
            resolveBridge = () => resolve({
                bridgeReady: true,
                shouldWait: true,
            });
        }));
        Object.defineProperty(window, 'location', {
            configurable: true,
            value: { pathname: '/electron' },
        });
        Object.defineProperty(window, 'electronAPI', {
            configurable: true,
            value: { diagnostics: { onDebugLog: mocks.onDebugLog } },
        });
        mocks.getValidatedElectronPlatformApi.mockReturnValue({diagnostics: {onDebugLog: mocks.onDebugLog}} as never);
        const plugin = (await import('@app/plugins/runtimeErrorLogStream.client')).default as (app: unknown) => void;
        const harness = createNuxtApp();

        plugin(harness.nuxtApp);
        harness.hooks.get('app:mounted')?.();
        await flushPluginTasks();

        expect(mocks.onDebugLog).not.toHaveBeenCalled();

        resolveBridge();
        await flushPluginTasks();

        expect(mocks.waitForPreferredDesktopPlatformBridge).toHaveBeenCalledWith({ routePath: '/electron' });
        expect(mocks.onDebugLog).toHaveBeenCalledTimes(1);
        harness.nuxtApp.vueApp.unmount();
        expect(unsubscribe).toHaveBeenCalledTimes(1);
    });

    it('removes renderer guard listeners and restores the previous Vue error handler on unmount', async () => {
        const windowTarget = new EventTarget();
        const addEventListenerSpy = vi.spyOn(windowTarget, 'addEventListener');
        const removeEventListenerSpy = vi.spyOn(windowTarget, 'removeEventListener');
        vi.stubGlobal('window', windowTarget);
        const plugin = (await import('@app/plugins/rendererErrorGuard.client')).default as (app: unknown) => void;
        const harness = createNuxtApp();

        plugin(harness.nuxtApp);
        const installedErrorHandler = harness.nuxtApp.vueApp.config.errorHandler;
        const errorListener = addEventListenerSpy.mock.calls.find(([eventName]) => eventName === 'error')?.[1];
        const rejectionListener = addEventListenerSpy.mock.calls.find(
            ([eventName]) => eventName === 'unhandledrejection',
        )?.[1];
        plugin(harness.nuxtApp);
        harness.nuxtApp.vueApp.unmount();

        expect(addEventListenerSpy.mock.calls.map(([eventName]) => eventName)).toEqual([
            'storage',
            'focus',
            'pageshow',
            'error',
            'unhandledrejection',
        ]);
        expect(errorListener).toEqual(expect.any(Function));
        expect(rejectionListener).toEqual(expect.any(Function));
        expect(removeEventListenerSpy).toHaveBeenCalledWith('error', errorListener);
        expect(removeEventListenerSpy).toHaveBeenCalledWith('unhandledrejection', rejectionListener);
        expect(harness.nuxtApp.vueApp.config.errorHandler).toBe(harness.previousErrorHandler);
        expect(installedErrorHandler).not.toBe(harness.previousErrorHandler);
        expect(harness.originalUnmount).toHaveBeenCalledTimes(1);
        expect(mocks.installConsoleErrorObserver).toHaveBeenCalledOnce();
        expect(mocks.installConsoleErrorObserver).toHaveBeenCalledWith(expect.objectContaining({
            reporter: expect.any(Object),
            runtime: 'hosted-browser',
        }));
        expect(mocks.consoleObserverCleanup).toHaveBeenCalledOnce();
    });

    it('creates one receipt per Vue, window, and rejection failure, then passes that receipt to the logger and runtime card', async () => {
        const windowTarget = new EventTarget();
        const addEventListenerSpy = vi.spyOn(windowTarget, 'addEventListener');
        vi.stubGlobal('window', windowTarget);
        const plugin = (await import('@app/plugins/rendererErrorGuard.client')).default as (app: unknown) => void;
        const harness = createNuxtApp();

        plugin(harness.nuxtApp);
        const vueHandler = harness.nuxtApp.vueApp.config.errorHandler as (
            error: unknown,
            instance: null,
            info: string,
        ) => void;
        const windowHandler = addEventListenerSpy.mock.calls.find(([eventName]) => eventName === 'error')?.[1] as (
            event: ErrorEvent,
        ) => void;
        const rejectionHandler = addEventListenerSpy.mock.calls.find(([eventName]) => eventName === 'unhandledrejection')?.[1] as (
            event: PromiseRejectionEvent,
        ) => void;

        vueHandler(new Error('Vue failed'), null, 'render');
        windowHandler({
            message: 'Window failed',
            error: new Error('Window failed'),
            filename: 'app.vue',
            lineno: 1,
            colno: 1,
        } as ErrorEvent);
        rejectionHandler({reason: new Error('Promise failed')} as PromiseRejectionEvent);

        expect(browserLoggerMock.error).toHaveBeenCalledTimes(3);
        expect(mocks.reportRuntimeError).toHaveBeenCalledTimes(3);
        expect(harness.previousErrorHandler).toHaveBeenCalledOnce();
        for (const [presentation] of mocks.reportRuntimeError.mock.calls) {
            expect(presentation).toEqual(expect.objectContaining({failure: expect.objectContaining({eventId: expect.stringMatching(/^[0-9a-f]{32}$/u)})}));
        }
        for (const [
            , , data,
        ] of browserLoggerMock.error.mock.calls) {
            expect(data).toEqual(expect.objectContaining({failure: expect.objectContaining({eventId: expect.stringMatching(/^[0-9a-f]{32}$/u)})}));
        }
        expect(browserLoggerMock.error.mock.calls.map(([
            , , data,
        ]) => (
            (data as {failure?: {code?: string}}).failure?.code
        ))).toEqual([
            'RENDERER_ERROR_GUARD_FAILED',
            'RENDERER_ERROR_GUARD_FAILED',
            'RENDERER_ERROR_GUARD_FAILED',
        ]);
    });

    it('short circuits ignorable Vue, window, and rejection messages before an occurrence', async () => {
        const windowTarget = new EventTarget();
        const addEventListenerSpy = vi.spyOn(windowTarget, 'addEventListener');
        vi.stubGlobal('window', windowTarget);
        const plugin = (await import('@app/plugins/rendererErrorGuard.client')).default as (app: unknown) => void;
        const harness = createNuxtApp();
        const ignored = 'ResizeObserver loop limit exceeded';

        plugin(harness.nuxtApp);
        const vueHandler = harness.nuxtApp.vueApp.config.errorHandler as (
            error: unknown,
            instance: null,
            info: string,
        ) => void;
        const windowHandler = addEventListenerSpy.mock.calls.find(([eventName]) => eventName === 'error')?.[1] as (
            event: ErrorEvent,
        ) => void;
        const rejectionHandler = addEventListenerSpy.mock.calls.find(([eventName]) => eventName === 'unhandledrejection')?.[1] as (
            event: PromiseRejectionEvent,
        ) => void;

        vueHandler(new Error(ignored), null, 'render');
        windowHandler({
            message: ignored,
            error: new Error(ignored),
        } as ErrorEvent);
        rejectionHandler({reason: new Error(ignored)} as PromiseRejectionEvent);

        expect(browserLoggerMock.error).not.toHaveBeenCalled();
        expect(mocks.reportRuntimeError).not.toHaveBeenCalled();
        expect(browserLoggerMock.warnThrottled).toHaveBeenCalledTimes(3);
        expect(harness.previousErrorHandler).toHaveBeenCalledOnce();
    });
});
