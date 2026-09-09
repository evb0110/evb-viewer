import type * as TViMockOriginalModule from '@electron/utils/error';

import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

interface IHostZenEscapeTestWindow {
    id: number;
    webContents: {
        focus: ReturnType<typeof vi.fn>;
        on: ReturnType<typeof vi.fn>;
        removeListener: ReturnType<typeof vi.fn>;
        send: ReturnType<typeof vi.fn>;
    };
    focus: ReturnType<typeof vi.fn>;
    getBounds: ReturnType<typeof vi.fn>;
    isDestroyed: ReturnType<typeof vi.fn>;
    isFocused: ReturnType<typeof vi.fn>;
    isFullScreen: ReturnType<typeof vi.fn>;
    isMaximized: ReturnType<typeof vi.fn>;
    isSimpleFullScreen: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    once: ReturnType<typeof vi.fn>;
    removeListener: ReturnType<typeof vi.fn>;
    setBounds: ReturnType<typeof vi.fn>;
    setFullScreen: ReturnType<typeof vi.fn>;
    setSimpleFullScreen: ReturnType<typeof vi.fn>;
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
        const window: IHostZenEscapeTestWindow = {
            id,
            webContents: {
                focus: vi.fn(),
                on: vi.fn(),
                removeListener: vi.fn(),
                send: vi.fn(),
            },
            focus: vi.fn(),
            getBounds: vi.fn(() => ({
                x: 0,
                y: 0,
                width: 800,
                height: 600,
            })),
            isDestroyed: vi.fn(() => false),
            isFocused: vi.fn(() => mocks.focusedWindow === window),
            isFullScreen: vi.fn(() => fullScreen),
            isMaximized: vi.fn(() => false),
            isSimpleFullScreen: vi.fn(() => simpleFullScreen),
            on: vi.fn(),
            once: vi.fn(),
            removeListener: vi.fn(),
            setBounds: vi.fn(),
            setFullScreen: vi.fn((active: boolean) => {
                fullScreen = active;
            }),
            setSimpleFullScreen: vi.fn((active: boolean) => {
                simpleFullScreen = active;
            }),
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
            getDisplayMatching: vi.fn(() => {
                return {workArea: {
                    x: 0,
                    y: 0,
                    width: 800,
                    height: 600,
                }};
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
