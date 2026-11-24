import type * as TViMockOriginalModule from '@electron/utils/error';

import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

interface IHostZenEscapeTestBounds {
    x: number;
    y: number;
    width: number;
    height: number;
}

interface IHostZenEscapeTestWindow {
    id: number;
    webContents: {
        focus: ReturnType<typeof vi.fn>;
        isDestroyed: ReturnType<typeof vi.fn>;
        on: ReturnType<typeof vi.fn>;
        removeListener: ReturnType<typeof vi.fn>;
        send: ReturnType<typeof vi.fn>;
    };
    focus: ReturnType<typeof vi.fn>;
    getBounds: ReturnType<typeof vi.fn<() => IHostZenEscapeTestBounds>>;
    getContentSize: ReturnType<typeof vi.fn>;
    setContentSize: ReturnType<typeof vi.fn>;
    isDestroyed: ReturnType<typeof vi.fn>;
    isFocused: ReturnType<typeof vi.fn>;
    isFullScreen: ReturnType<typeof vi.fn>;
    isMaximized: ReturnType<typeof vi.fn>;
    isSimpleFullScreen: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    once: ReturnType<typeof vi.fn>;
    removeListener: ReturnType<typeof vi.fn>;
    setBounds: ReturnType<typeof vi.fn<(bounds: IHostZenEscapeTestBounds) => void>>;
    setFullScreen: ReturnType<typeof vi.fn>;
    setSimpleFullScreen: ReturnType<typeof vi.fn>;
    unmaximize: ReturnType<typeof vi.fn>;
    maximized: boolean;
    /** Whether the window manager honors an unmaximize request. */
    honorsUnmaximize: boolean;
}

interface IBeforeInputTestEvent { preventDefault: () => void; }

interface IBeforeInputTestInput {
    type: string;
    key: string;
}

const mocks = vi.hoisted(() => ({
    focusedWindow: null as IHostZenEscapeTestWindow | null,
    globalShortcutRegister: vi.fn(),
    globalShortcutUnregister: vi.fn(),
    createWindow: ((_id: number): IHostZenEscapeTestWindow => {
        throw new Error('createWindow mock not initialized');
    }),
}));

vi.mock('electron', () => {
    const windowsByWebContents = new WeakMap<object, IHostZenEscapeTestWindow>();
    const MockBrowserWindow = {
        getFocusedWindow: vi.fn(() => {
            return mocks.focusedWindow;
        }),
        fromWebContents: vi.fn((webContents: object) => windowsByWebContents.get(webContents) ?? null),
    };

    mocks.createWindow = (id: number): IHostZenEscapeTestWindow => {
        let fullScreen = false;
        let simpleFullScreen = false;
        const onceListeners: Record<string, Array<() => void>> = {};
        const listeners: Record<string, Array<() => void>> = {};
        let bounds: IHostZenEscapeTestBounds = {
            x: 0,
            y: 0,
            width: 800,
            height: 600,
        };
        // Native state events arrive after the request, as the window manager sends them.
        const emit = (event: string) => queueMicrotask(() => {
            for (const listener of [
                ...(listeners[event] ?? []),
                ...(onceListeners[event]?.splice(0) ?? []),
            ]) {
                listener();
            }
        });
        const window: IHostZenEscapeTestWindow = {
            id,
            webContents: {
                focus: vi.fn(),
                isDestroyed: vi.fn(() => false),
                on: vi.fn(),
                removeListener: vi.fn(),
                send: vi.fn(),
            },
            focus: vi.fn(() => {
                mocks.focusedWindow = window;
            }),
            getBounds: vi.fn(() => bounds),
            // The content area is the window less its title bar.
            getContentSize: vi.fn(() => [
                bounds.width,
                bounds.height - TITLE_BAR_HEIGHT,
            ]),
            setContentSize: vi.fn((width: number, height: number) => {
                bounds = {
                    ...bounds,
                    width,
                    height: height + TITLE_BAR_HEIGHT,
                };
            }),
            isDestroyed: vi.fn(() => false),
            isFocused: vi.fn(() => mocks.focusedWindow === window),
            isFullScreen: vi.fn(() => fullScreen),
            isMaximized: vi.fn(() => window.maximized),
            isSimpleFullScreen: vi.fn(() => simpleFullScreen),
            on: vi.fn((event: string, listener: () => void) => {
                (listeners[event] ??= []).push(listener);
            }),
            once: vi.fn((event: string, listener: () => void) => {
                (onceListeners[event] ??= []).push(listener);
            }),
            removeListener: vi.fn(),
            setBounds: vi.fn((next: IHostZenEscapeTestBounds) => {
                bounds = next;
            }),
            setFullScreen: vi.fn((active: boolean) => {
                if (fullScreen === active) {
                    return;
                }
                fullScreen = active;
                bounds = active
                    ? {
                        x: 0,
                        y: 0,
                        width: 1280,
                        height: 800,
                    }
                    : bounds;
                emit(active ? 'enter-full-screen' : 'leave-full-screen');
            }),
            setSimpleFullScreen: vi.fn((active: boolean) => {
                simpleFullScreen = active;
            }),
            // The native event arrives after the request, as a window manager sends it.
            unmaximize: vi.fn(() => {
                if (!window.honorsUnmaximize) {
                    return;
                }
                window.maximized = false;
                emit('unmaximize');
            }),
            maximized: false,
            honorsUnmaximize: true,
        };
        windowsByWebContents.set(window.webContents, window);
        return window;
    };

    return {
        BrowserWindow: MockBrowserWindow,
        globalShortcut: {
            register: mocks.globalShortcutRegister,
            unregister: mocks.globalShortcutUnregister,
        },
        screen: {
            // A 1x primary display left of a 2x one at x = 1920.
            getDisplayMatching: vi.fn((rectangle: {x: number}) => {
                return {
                    scaleFactor: rectangle.x >= 1920 ? 2 : 1,
                    workArea: {
                        x: 0,
                        y: 0,
                        width: 800,
                        height: 600,
                    },
                    workAreaSize: {
                        width: 800,
                        height: 600,
                    },
                };
            }),
            getDisplayNearestPoint: vi.fn(() => ({scaleFactor: 1})),
            getPrimaryDisplay: vi.fn(() => ({scaleFactor: 1})),
            on: vi.fn(),
        },
    };
});

vi.mock('@electron/utils/createLogger', () => ({createLogger: () => ({warn: vi.fn()})}));
vi.mock('@electron/utils/error', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    getErrorMessage: (error: unknown) => String(error),
}));

// Linux and Windows fullscreen is the path whose native leave event restores placement.
async function withEventEmittingFullScreen(run: () => Promise<void>) {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', {value: 'linux'});
    try {
        await run();
    } finally {
        Object.defineProperty(process, 'platform', platform);
    }
}

function getBeforeInputHandler(window: IHostZenEscapeTestWindow) {
    return window.webContents.on.mock.calls
        .find(call => call[0] === 'before-input-event')?.[1] as
        | ((event: IBeforeInputTestEvent, input: IBeforeInputTestInput) => void)
        | undefined;
}

// A window frame, so a content size and a window size differ.
const TITLE_BAR_HEIGHT = 28;

describe('host environment zen Escape handling', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        mocks.focusedWindow = null;
    });

    it('exits only the focused zen window through window-scoped Escape handling', async () => {
        const {
            attachHostEnvironmentToWindow,
            setHostZenModeForWindow,
        } = await import('@electron/hostEnvironment');
        const firstWindow = mocks.createWindow(1);
        const secondWindow = mocks.createWindow(2);

        attachHostEnvironmentToWindow(firstWindow as never);
        attachHostEnvironmentToWindow(secondWindow as never);

        await setHostZenModeForWindow(firstWindow as never, true);
        await setHostZenModeForWindow(secondWindow as never, true);

        expect(mocks.globalShortcutRegister).not.toHaveBeenCalled();
        expect(mocks.globalShortcutUnregister).not.toHaveBeenCalled();

        const secondBeforeInput = getBeforeInputHandler(secondWindow);
        expect(secondBeforeInput).toBeTypeOf('function');

        const unfocusedEscapeEvent = {preventDefault: vi.fn()};
        mocks.focusedWindow = null;
        secondBeforeInput?.(unfocusedEscapeEvent, {
            type: 'keyDown',
            key: 'Escape',
        });
        await Promise.resolve();

        expect(unfocusedEscapeEvent.preventDefault).not.toHaveBeenCalled();

        const keyUpEscapeEvent = {preventDefault: vi.fn()};
        mocks.focusedWindow = secondWindow;
        secondBeforeInput?.(keyUpEscapeEvent, {
            type: 'keyUp',
            key: 'Escape',
        });
        await Promise.resolve();

        expect(keyUpEscapeEvent.preventDefault).not.toHaveBeenCalled();

        if (process.platform === 'darwin') {
            expect(secondWindow.setSimpleFullScreen).not.toHaveBeenCalledWith(false);
        } else {
            expect(secondWindow.setFullScreen).not.toHaveBeenCalledWith(false);
        }

        const focusedEscapeEvent = {preventDefault: vi.fn()};
        secondBeforeInput?.(focusedEscapeEvent, {
            type: 'keyDown',
            key: 'Escape',
        });
        await Promise.resolve();

        expect(focusedEscapeEvent.preventDefault).toHaveBeenCalledOnce();
        if (process.platform === 'darwin') {
            expect(firstWindow.setSimpleFullScreen).toHaveBeenCalledWith(true);
            expect(firstWindow.setSimpleFullScreen).not.toHaveBeenCalledWith(false);
            expect(secondWindow.setSimpleFullScreen).toHaveBeenCalledWith(false);
        } else {
            expect(firstWindow.setFullScreen).toHaveBeenCalledWith(true);
            expect(firstWindow.setFullScreen).not.toHaveBeenCalledWith(false);
            expect(secondWindow.setFullScreen).toHaveBeenCalledWith(false);
        }
    });

    it('coalesces duplicate unchanged host environment broadcasts', async () => {
        vi.useFakeTimers();
        try {
            const { attachHostEnvironmentToWindow } = await import('@electron/hostEnvironment');
            const window = mocks.createWindow(3);

            attachHostEnvironmentToWindow(window as never);
            const moveHandler = window.on.mock.calls
                .find(call => call[0] === 'move')?.[1] as (() => void) | undefined;
            expect(moveHandler).toBeTypeOf('function');

            moveHandler?.();
            moveHandler?.();
            await vi.advanceTimersByTimeAsync(0);

            let expectedPlatform = 'linux';
            if (process.platform === 'darwin') {
                expectedPlatform = 'darwin';
            } else if (process.platform === 'win32') {
                expectedPlatform = 'win32';
            }
            expect(window.webContents.send).toHaveBeenCalledOnce();
            expect(window.webContents.send).toHaveBeenCalledWith('host:environmentChanged', {
                platform: expectedPlatform,
                osScaleFactor: 1,
            });

            moveHandler?.();
            await vi.advanceTimersByTimeAsync(0);

            expect(window.webContents.send).toHaveBeenCalledOnce();
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('host environment startup argument', () => {
    it('describes the display the window bounds fall on, not the primary one', async () => {
        const { encodeHostEnvironmentArgument } = await import('@electron/hostEnvironment');
        const { readHostEnvironmentArgument } = await import('@electron/preload/readHostEnvironmentArgument');
        const readStartupScaleFactor = (bounds: {x: number}) => readHostEnvironmentArgument([encodeHostEnvironmentArgument({
            ...bounds,
            y: 200,
            width: 900,
            height: 700,
        })])?.osScaleFactor;

        expect(readStartupScaleFactor({x: 2400})).toBe(2);
        expect(readStartupScaleFactor({x: 100})).toBe(1);
    });

    it('leaves maximized before answering, and reports a window that stays maximized', async () => {
        const { restoreHostNormalWindowForWindow } = await import('@electron/hostEnvironment');
        const window = mocks.createWindow(4);
        window.maximized = true;

        const normal = {
            fullScreen: false,
            maximized: false,
            supported: true,
            contentSize: {
                width: 800,
                height: 600 - TITLE_BAR_HEIGHT,
            },
            workAreaSize: {
                width: 800,
                height: 600,
            },
        };
        await expect(restoreHostNormalWindowForWindow(window as never)).resolves.toEqual(normal);
        // Already normal: nothing to leave, same answer.
        await expect(restoreHostNormalWindowForWindow(window as never)).resolves.toEqual(normal);
        // A requested content area is given natively, whatever the frame.
        await expect(restoreHostNormalWindowForWindow(window as never, {
            width: 640,
            height: 480,
        })).resolves.toEqual({
            ...normal,
            contentSize: {
                width: 640,
                height: 480,
            },
        });
        // The window around it is the frame taller, not 480 high itself.
        expect(window.getBounds()).toMatchObject({
            width: 640,
            height: 480 + TITLE_BAR_HEIGHT,
        });
        expect(window.focus).not.toHaveBeenCalled();

        const stuck = mocks.createWindow(5);
        stuck.maximized = true;
        stuck.honorsUnmaximize = false;
        await expect(restoreHostNormalWindowForWindow(stuck as never)).resolves.toMatchObject({
            fullScreen: false,
            maximized: true,
            supported: true,
        });
        await expect(restoreHostNormalWindowForWindow(null)).resolves.toEqual({
            fullScreen: false,
            maximized: false,
            supported: false,
        });
    });

    it('leaves zen for the normal window without restoring or focusing its pre-zen placement', async () => {
        await withEventEmittingFullScreen(async () => {
            const {
                attachHostEnvironmentToWindow,
                restoreHostNormalWindowForWindow,
                setHostZenModeForWindow,
            } = await import('@electron/hostEnvironment');
            const window = mocks.createWindow(6);
            attachHostEnvironmentToWindow(window as never);
            await setHostZenModeForWindow(window as never, true);
            await new Promise(resolve => setTimeout(resolve, 0));
            mocks.focusedWindow = null;
            // The window moved while in zen; that is the bounds the resize measures from.
            window.setBounds({
                x: 10,
                y: 10,
                width: 1000,
                height: 700,
            });

            await expect(restoreHostNormalWindowForWindow(window as never)).resolves.toEqual({
                fullScreen: false,
                maximized: false,
                supported: true,
                contentSize: {
                    width: 1000,
                    height: 700 - TITLE_BAR_HEIGHT,
                },
                workAreaSize: {
                    width: 800,
                    height: 600,
                },
            });
            await new Promise(resolve => setTimeout(resolve, 0));

            expect(mocks.focusedWindow).toBeNull();
            expect(window.getBounds()).toEqual({
                x: 10,
                y: 10,
                width: 1000,
                height: 700,
            });
        });
    });

    it('still restores and focuses the pre-zen placement on an ordinary zen exit', async () => {
        await withEventEmittingFullScreen(async () => {
            const {
                attachHostEnvironmentToWindow,
                setHostZenModeForWindow,
            } = await import('@electron/hostEnvironment');
            const window = mocks.createWindow(7);
            attachHostEnvironmentToWindow(window as never);
            await setHostZenModeForWindow(window as never, true);
            mocks.focusedWindow = null;

            await expect(setHostZenModeForWindow(window as never, false)).resolves.toEqual({
                active: false,
                supported: true,
            });

            expect(mocks.focusedWindow).toBe(window);
            expect(window.getBounds()).toEqual({
                x: 0,
                y: 0,
                width: 800,
                height: 600,
            });
        });
    });
});

describe('host per-window raster budget broadcasts', () => {
    const MIB = 1024 ** 2;
    const GIB = 1024 ** 3;

    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        mocks.focusedWindow = null;
    });

    it('pushes updated per-window shares as windows register and unregister, and pushes initial share on load', async () => {
        const { initializeHostResourceProfile } = await import('@electron/resources/hostResourceProfile');
        const {
            registerAppWindow,
            unregisterAppWindow,
        } = await import('@electron/window/registry');
        const {
            attachHostEnvironmentToWindow,
            hostMainBindings,
            installHostEnvironmentDisplayWatcher,
        } = await import('@electron/hostEnvironment');

        initializeHostResourceProfile({
            app: { getGPUFeatureStatus: () => ({} as never) },
            performanceMode: 'auto',
            availableParallelism: () => 8,
            totalmem: () => 32 * GIB,
        });
        installHostEnvironmentDisplayWatcher();

        const firstWindow = mocks.createWindow(101);
        attachHostEnvironmentToWindow(firstWindow as never);
        registerAppWindow(firstWindow as never, { setAsMain: true });

        expect(firstWindow.webContents.send).toHaveBeenCalledWith('host:rasterBudgetChanged', {
            maxRasterSurfaceBytes: 1536 * MIB,
            hostPoolBytes: 1536 * MIB,
            windowCount: 1,
        });
        expect(hostMainBindings.snapshotHostRasterBudgetForWindow({ sender: firstWindow.webContents } as never)).toEqual({
            maxRasterSurfaceBytes: 1536 * MIB,
            hostPoolBytes: 1536 * MIB,
            windowCount: 1,
        });

        // Opening a second window halves both windows' shares immediately.
        const secondWindow = mocks.createWindow(102);
        attachHostEnvironmentToWindow(secondWindow as never);
        registerAppWindow(secondWindow as never);

        const twoWindowShare = {
            maxRasterSurfaceBytes: 768 * MIB,
            hostPoolBytes: 1536 * MIB,
            windowCount: 2,
        };
        expect(firstWindow.webContents.send).toHaveBeenLastCalledWith('host:rasterBudgetChanged', twoWindowShare);
        expect(secondWindow.webContents.send).toHaveBeenLastCalledWith('host:rasterBudgetChanged', twoWindowShare);
        expect(hostMainBindings.snapshotHostRasterBudgetForWindow({ sender: secondWindow.webContents } as never)).toEqual(twoWindowShare);

        // did-finish-load delivers the share even after an earlier broadcast (e.g. reload or late preload attach).
        const secondLoadHandler = secondWindow.webContents.on.mock.calls
            .find(call => call[0] === 'did-finish-load')?.[1] as (() => void) | undefined;
        expect(secondLoadHandler).toBeTypeOf('function');
        const sendCountBeforeLoad = secondWindow.webContents.send.mock.calls.length;
        secondLoadHandler?.();
        expect(secondWindow.webContents.send).toHaveBeenCalledTimes(sendCountBeforeLoad + 1);
        expect(secondWindow.webContents.send).toHaveBeenLastCalledWith('host:rasterBudgetChanged', twoWindowShare);

        // Closing/unregistering the second window restores the surviving window's full share.
        secondWindow.isDestroyed.mockReturnValue(true);
        secondWindow.webContents.isDestroyed.mockReturnValue(true);
        unregisterAppWindow(secondWindow.id);

        expect(firstWindow.webContents.send).toHaveBeenLastCalledWith('host:rasterBudgetChanged', {
            maxRasterSurfaceBytes: 1536 * MIB,
            hostPoolBytes: 1536 * MIB,
            windowCount: 1,
        });
        expect(secondWindow.webContents.send).toHaveBeenCalledTimes(sendCountBeforeLoad + 1);
    });

    it('skips destroyed webContents without throwing during broadcast', async () => {
        const { initializeHostResourceProfile } = await import('@electron/resources/hostResourceProfile');
        const { registerAppWindow } = await import('@electron/window/registry');
        const {
            broadcastHostRasterBudgetToAllWindows,
            installHostEnvironmentDisplayWatcher,
        } = await import('@electron/hostEnvironment');

        initializeHostResourceProfile({
            app: { getGPUFeatureStatus: () => ({} as never) },
            performanceMode: 'auto',
            availableParallelism: () => 8,
            totalmem: () => 16 * GIB,
        });
        installHostEnvironmentDisplayWatcher();

        const liveWindow = mocks.createWindow(201);
        const closingWindow = mocks.createWindow(202);
        closingWindow.webContents.isDestroyed.mockReturnValue(true);

        registerAppWindow(liveWindow as never, { setAsMain: true });
        registerAppWindow(closingWindow as never);
        expect(() => broadcastHostRasterBudgetToAllWindows()).not.toThrow();

        expect(closingWindow.webContents.send).not.toHaveBeenCalled();
        expect(liveWindow.webContents.send).toHaveBeenLastCalledWith('host:rasterBudgetChanged', {
            maxRasterSurfaceBytes: Math.floor(Math.floor(16 * GIB * 0.06) / 2),
            hostPoolBytes: Math.floor(16 * GIB * 0.06),
            windowCount: 2,
        });
    });

    it('notifies listeners and restores the surviving share when a destroyed window is pruned without unregisterAppWindow', async () => {
        const { initializeHostResourceProfile } = await import('@electron/resources/hostResourceProfile');
        const {
            getAllRegisteredAppWindows,
            getWindowByIdFromRegistry,
            registerAppWindow,
        } = await import('@electron/window/registry');
        const {
            attachHostEnvironmentToWindow,
            installHostEnvironmentDisplayWatcher,
        } = await import('@electron/hostEnvironment');

        initializeHostResourceProfile({
            app: { getGPUFeatureStatus: () => ({}) as never },
            performanceMode: 'auto',
            availableParallelism: () => 8,
            totalmem: () => 32 * GIB,
        });
        installHostEnvironmentDisplayWatcher();

        const firstWindow = mocks.createWindow(301);
        const secondWindow = mocks.createWindow(302);
        const thirdWindow = mocks.createWindow(303);
        const auxiliaryWindow = mocks.createWindow(304);

        attachHostEnvironmentToWindow(firstWindow as never);
        attachHostEnvironmentToWindow(secondWindow as never);
        attachHostEnvironmentToWindow(thirdWindow as never);
        attachHostEnvironmentToWindow(auxiliaryWindow as never);
        registerAppWindow(firstWindow as never, { setAsMain: true });
        registerAppWindow(secondWindow as never);
        registerAppWindow(thirdWindow as never);

        // Unregistered auxiliary windows must not receive raster budget pushes on did-finish-load.
        const auxiliaryLoadHandler = auxiliaryWindow.webContents.on.mock.calls
            .find(call => call[0] === 'did-finish-load')?.[1] as (() => void) | undefined;
        auxiliaryLoadHandler?.();
        expect(auxiliaryWindow.webContents.send).not.toHaveBeenCalledWith(
            'host:rasterBudgetChanged',
            expect.anything(),
        );

        // Destroy thirdWindow and prune via getAllRegisteredAppWindows() without calling unregisterAppWindow.
        thirdWindow.isDestroyed.mockReturnValue(true);
        thirdWindow.webContents.isDestroyed.mockReturnValue(true);
        expect(getAllRegisteredAppWindows()).toHaveLength(2);
        expect(firstWindow.webContents.send).toHaveBeenLastCalledWith('host:rasterBudgetChanged', {
            maxRasterSurfaceBytes: 768 * MIB,
            hostPoolBytes: 1536 * MIB,
            windowCount: 2,
        });

        // Destroy secondWindow and prune via getWindowByIdFromRegistry() without calling unregisterAppWindow.
        secondWindow.isDestroyed.mockReturnValue(true);
        secondWindow.webContents.isDestroyed.mockReturnValue(true);
        expect(getWindowByIdFromRegistry(secondWindow.id)).toBeNull();
        expect(firstWindow.webContents.send).toHaveBeenLastCalledWith('host:rasterBudgetChanged', {
            maxRasterSurfaceBytes: 1536 * MIB,
            hostPoolBytes: 1536 * MIB,
            windowCount: 1,
        });
    });

    it('unregisters and restores the surviving share when a registered window emits closed directly', async () => {
        const { initializeHostResourceProfile } = await import('@electron/resources/hostResourceProfile');
        const { registerAppWindow } = await import('@electron/window/registry');
        const { installHostEnvironmentDisplayWatcher } = await import('@electron/hostEnvironment');

        initializeHostResourceProfile({
            app: { getGPUFeatureStatus: () => ({}) as never },
            performanceMode: 'auto',
            availableParallelism: () => 8,
            totalmem: () => 32 * GIB,
        });
        installHostEnvironmentDisplayWatcher();

        const firstWindow = mocks.createWindow(401);
        const secondWindow = mocks.createWindow(402);
        registerAppWindow(firstWindow as never, { setAsMain: true });
        registerAppWindow(secondWindow as never);
        expect(firstWindow.webContents.send).toHaveBeenLastCalledWith('host:rasterBudgetChanged', {
            maxRasterSurfaceBytes: 768 * MIB,
            hostPoolBytes: 1536 * MIB,
            windowCount: 2,
        });

        const closedListener = secondWindow.once.mock.calls
            .find(call => call[0] === 'closed')?.[1] as (() => void) | undefined;
        expect(closedListener).toBeTypeOf('function');
        secondWindow.isDestroyed.mockReturnValue(true);
        secondWindow.webContents.isDestroyed.mockReturnValue(true);
        closedListener?.();

        expect(firstWindow.webContents.send).toHaveBeenLastCalledWith('host:rasterBudgetChanged', {
            maxRasterSurfaceBytes: 1536 * MIB,
            hostPoolBytes: 1536 * MIB,
            windowCount: 1,
        });
    });
});
