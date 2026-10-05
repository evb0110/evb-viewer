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
        on: ReturnType<typeof vi.fn>;
        removeListener: ReturnType<typeof vi.fn>;
        send: ReturnType<typeof vi.fn>;
    };
    focus: ReturnType<typeof vi.fn>;
    getBounds: ReturnType<typeof vi.fn<() => IHostZenEscapeTestBounds>>;
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
    const MockBrowserWindow = {getFocusedWindow: vi.fn(() => {
        return mocks.focusedWindow;
    })};

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
                on: vi.fn(),
                removeListener: vi.fn(),
                send: vi.fn(),
            },
            focus: vi.fn(() => {
                mocks.focusedWindow = window;
            }),
            getBounds: vi.fn(() => bounds),
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
                };
            }),
            getDisplayNearestPoint: vi.fn(() => ({scaleFactor: 1})),
            getPrimaryDisplay: vi.fn(() => ({scaleFactor: 1})),
            on: vi.fn(),
        },
    };
});

vi.mock('@electron/window/registry', () => ({getAllRegisteredAppWindows: vi.fn(() => [])}));
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

        await expect(restoreHostNormalWindowForWindow(window as never)).resolves.toEqual({
            fullScreen: false,
            maximized: false,
            supported: true,
        });
        // Already normal: nothing to leave, same answer.
        await expect(restoreHostNormalWindowForWindow(window as never)).resolves.toEqual({
            fullScreen: false,
            maximized: false,
            supported: true,
        });
        expect(window.focus).not.toHaveBeenCalled();

        const stuck = mocks.createWindow(5);
        stuck.maximized = true;
        stuck.honorsUnmaximize = false;
        await expect(restoreHostNormalWindowForWindow(stuck as never)).resolves.toEqual({
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
