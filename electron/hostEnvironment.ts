import {
    BrowserWindow,
    screen,
} from 'electron';
import type {
    Event,
    Input,
    Rectangle,
} from 'electron';
import {
    HOST_PLATFORM_FEATURE,
    type IHostEnvironmentSnapshot,
    type IHostZenModeState,
    type THostPlatform,
} from '@contracts/hostPlatformFeature';
import { writeHostBugReportBundle } from '@electron/writeHostBugReportBundle';
import type { TFeatureMainBindings } from '@contracts/platformFeature';
import { getAllRegisteredAppWindows } from '@electron/window/registry';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';

const logger = createLogger('host-env');

const ZEN_EXIT_SETTLE_MS = 140;
const ZEN_STATE_EVENT_TIMEOUT_MS = 220;

interface IZenWindowPlacement {
    bounds: Rectangle;
    wasMaximized: boolean;
}

const zenWindowPlacementByWindow = new WeakMap<BrowserWindow, IZenWindowPlacement>();
const zenExitInProgressByWindow = new WeakSet<BrowserWindow>();
interface IHostEnvironmentBroadcastState {
    timeout: ReturnType<typeof setTimeout> | null;
    lastSentSnapshot: IHostEnvironmentSnapshot | null;
}
const hostEnvironmentBroadcastStateByWindow = new WeakMap<BrowserWindow, IHostEnvironmentBroadcastState>();

function resolvePlatform(): THostPlatform {
    if (process.platform === 'darwin') {
        return 'darwin';
    }
    if (process.platform === 'win32') {
        return 'win32';
    }
    return 'linux';
}

function readScaleFactorForWindow(window: BrowserWindow | null) {
    try {
        if (window && !window.isDestroyed()) {
            const bounds = window.getBounds();
            const display = screen.getDisplayNearestPoint({
                x: bounds.x + Math.floor(bounds.width / 2),
                y: bounds.y + Math.floor(bounds.height / 2),
            });
            return display.scaleFactor;
        }
    } catch (error) {
        logger.warn(`Failed to read window display scale factor: ${getErrorMessage(error)}`);
    }

    try {
        return screen.getPrimaryDisplay().scaleFactor;
    } catch (error) {
        logger.warn(`Failed to read primary display scale factor: ${getErrorMessage(error)}`);
        return 1;
    }
}

function snapshotHostEnvironmentForWindow(window: BrowserWindow | null): IHostEnvironmentSnapshot {
    return {
        platform: resolvePlatform(),
        osScaleFactor: readScaleFactorForWindow(window),
    };
}

function isWindowInHostZenMode(window: BrowserWindow) {
    return process.platform === 'darwin'
        ? window.isSimpleFullScreen() || window.isFullScreen()
        : window.isFullScreen();
}

function delay(ms: number) {
    return new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        timer.unref();
    });
}

function focusZenWindowContents(window: BrowserWindow) {
    if (window.isDestroyed()) {
        return;
    }

    try {
        window.focus();
        window.webContents.focus();
    } catch (error) {
        logger.warn(`Failed to focus zen window contents: ${getErrorMessage(error)}`);
    }
}

function captureZenWindowPlacement(window: BrowserWindow) {
    if (zenWindowPlacementByWindow.has(window)) {
        return;
    }

    try {
        zenWindowPlacementByWindow.set(window, {
            bounds: window.getBounds(),
            wasMaximized: window.isMaximized(),
        });
    } catch (error) {
        logger.warn(`Failed to capture pre-zen window placement: ${getErrorMessage(error)}`);
    }
}

function resolveZenRestoreBounds(placement: IZenWindowPlacement) {
    if (!placement.wasMaximized) {
        return placement.bounds;
    }

    try {
        return screen.getDisplayMatching(placement.bounds).workArea;
    } catch (error) {
        logger.warn(`Failed to resolve maximized restore bounds: ${getErrorMessage(error)}`);
        return placement.bounds;
    }
}

function restoreZenWindowPlacement(
    window: BrowserWindow,
    options: { preservePlacement?: boolean } = {},
) {
    if (window.isDestroyed() || isWindowInHostZenMode(window)) {
        return;
    }

    const placement = zenWindowPlacementByWindow.get(window);
    if (!placement) {
        return;
    }

    try {
        window.setBounds(resolveZenRestoreBounds(placement), false);
        focusZenWindowContents(window);
    } catch (error) {
        logger.warn(`Failed to restore pre-zen window placement: ${getErrorMessage(error)}`);
    }

    if (options.preservePlacement !== true) {
        zenWindowPlacementByWindow.delete(window);
    }
}

async function waitForHostZenModeState(window: BrowserWindow, active: boolean) {
    if (window.isDestroyed() || isWindowInHostZenMode(window) === active) {
        return;
    }

    await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            if (active) {
                window.removeListener('enter-full-screen', finish);
            } else {
                window.removeListener('leave-full-screen', finish);
            }
            resolve();
        };
        const timer = setTimeout(finish, ZEN_STATE_EVENT_TIMEOUT_MS);
        timer.unref();
        if (active) {
            window.once('enter-full-screen', finish);
        } else {
            window.once('leave-full-screen', finish);
        }
    });
}

function snapshotHostZenModeForWindow(window: BrowserWindow | null): IHostZenModeState {
    if (!window || window.isDestroyed()) {
        return {
            active: false,
            supported: false,
        };
    }

    return {
        active: isWindowInHostZenMode(window),
        supported: true,
    };
}

export async function setHostZenModeForWindow(
    window: BrowserWindow | null,
    active: boolean,
): Promise<IHostZenModeState> {
    if (!window || window.isDestroyed()) {
        return {
            active: false,
            supported: false,
        };
    }

    const currentlyActive = isWindowInHostZenMode(window);
    if (active) {
        if (!currentlyActive) {
            captureZenWindowPlacement(window);
        }

        if (process.platform === 'darwin') {
            window.setSimpleFullScreen(true);
        } else {
            window.setFullScreen(true);
        }
        focusZenWindowContents(window);

        const snapshot = {
            active: true,
            supported: true,
        };
        broadcastHostZenModeForWindow(window, snapshot);
        return snapshot;
    } else {
        zenExitInProgressByWindow.add(window);
        try {
            if (process.platform === 'darwin') {
                if (window.isSimpleFullScreen()) {
                    window.setSimpleFullScreen(false);
                }
                if (window.isFullScreen()) {
                    window.setFullScreen(false);
                }
            } else {
                window.setFullScreen(false);
            }

            restoreZenWindowPlacement(window, {preservePlacement: true});
            await waitForHostZenModeState(window, false);
            restoreZenWindowPlacement(window, {preservePlacement: true});
            await delay(ZEN_EXIT_SETTLE_MS);
            restoreZenWindowPlacement(window);
        } finally {
            zenExitInProgressByWindow.delete(window);
        }
    }

    const snapshot = {
        active: isWindowInHostZenMode(window),
        supported: true,
    };
    broadcastHostZenModeForWindow(window, snapshot);
    return snapshot;
}

export const hostMainBindings = {
    snapshotHostEnvironmentForWindow: context => snapshotHostEnvironmentForWindow(
        BrowserWindow.fromWebContents(context.sender),
    ),
    snapshotHostZenModeForWindow: context => snapshotHostZenModeForWindow(BrowserWindow.fromWebContents(context.sender)),
    setHostZenModeForWindow: (context, active) =>
        setHostZenModeForWindow(BrowserWindow.fromWebContents(context.sender), active),
    writeHostBugReportBundleForWindow: (context, bundle) =>
        writeHostBugReportBundle(BrowserWindow.fromWebContents(context.sender), bundle),
} satisfies TFeatureMainBindings<typeof HOST_PLATFORM_FEATURE, Electron.IpcMainInvokeEvent>;

function broadcastHostEnvironmentForWindow(window: BrowserWindow) {
    if (window.isDestroyed()) {
        return;
    }
    const snapshot = snapshotHostEnvironmentForWindow(window);
    const state = getHostEnvironmentBroadcastState(window);
    if (state.lastSentSnapshot && areHostEnvironmentSnapshotsEqual(state.lastSentSnapshot, snapshot)) {
        return;
    }
    try {
        window.webContents.send(HOST_PLATFORM_FEATURE.eventChannels.onEnvironmentChange, snapshot);
        state.lastSentSnapshot = snapshot;
    } catch (error) {
        logger.warn(`Failed to send host environment update: ${getErrorMessage(error)}`);
    }
}

function areHostEnvironmentSnapshotsEqual(
    left: IHostEnvironmentSnapshot,
    right: IHostEnvironmentSnapshot,
) {
    return left.platform === right.platform
        && left.osScaleFactor === right.osScaleFactor;
}

function getHostEnvironmentBroadcastState(window: BrowserWindow) {
    let state = hostEnvironmentBroadcastStateByWindow.get(window);
    if (!state) {
        state = {
            timeout: null,
            lastSentSnapshot: null,
        };
        hostEnvironmentBroadcastStateByWindow.set(window, state);
    }
    return state;
}

function scheduleHostEnvironmentBroadcastForWindow(window: BrowserWindow) {
    if (window.isDestroyed()) {
        return;
    }
    const state = getHostEnvironmentBroadcastState(window);
    if (state.timeout) {
        return;
    }
    state.timeout = setTimeout(() => {
        state.timeout = null;
        broadcastHostEnvironmentForWindow(window);
    }, 0);
    state.timeout.unref();
}

function broadcastHostZenModeForWindow(
    window: BrowserWindow,
    snapshot = snapshotHostZenModeForWindow(window),
) {
    if (window.isDestroyed()) {
        return;
    }

    try {
        window.webContents.send(HOST_PLATFORM_FEATURE.eventChannels.onZenModeChange, snapshot);
    } catch (error) {
        logger.warn(`Failed to send host zen mode update: ${getErrorMessage(error)}`);
    }
}

function broadcastHostEnvironmentToAllWindows() {
    for (const window of getAllRegisteredAppWindows()) {
        scheduleHostEnvironmentBroadcastForWindow(window);
    }
}

let displayWatcherInstalled = false;

export function installHostEnvironmentDisplayWatcher() {
    if (displayWatcherInstalled) {
        return;
    }
    displayWatcherInstalled = true;

    const handleDisplayChange = () => {
        broadcastHostEnvironmentToAllWindows();
    };

    screen.on('display-metrics-changed', handleDisplayChange);
    screen.on('display-added', handleDisplayChange);
    screen.on('display-removed', handleDisplayChange);
}

export function attachHostEnvironmentToWindow(window: BrowserWindow) {
    const webContents = window.webContents;
    const handleMove = () => {
        scheduleHostEnvironmentBroadcastForWindow(window);
    };
    const handleZenModeChange = () => {
        const isManagedExit = zenExitInProgressByWindow.has(window);
        restoreZenWindowPlacement(window, {preservePlacement: isManagedExit});
        if (isWindowInHostZenMode(window)) {
            focusZenWindowContents(window);
        }

        if (!isManagedExit) {
            broadcastHostZenModeForWindow(window);
        }
    };
    const handleBeforeInputEvent = (event: Event, input: Input) => {
        if (
            input.type !== 'keyDown'
            || input.key !== 'Escape'
            || !window.isFocused()
            || !isWindowInHostZenMode(window)
        ) {
            return;
        }

        event.preventDefault();
        void setHostZenModeForWindow(window, false).catch((error: unknown) => {
            logger.warn(`Failed to exit zen mode from Escape key: ${getErrorMessage(error)}`);
        });
    };

    window.on('move', handleMove);
    window.on('moved', handleMove);
    window.on('enter-full-screen', handleZenModeChange);
    window.on('leave-full-screen', handleZenModeChange);
    const handleInputEvent = (_event: Event, input: { type: string }) => {
        const boundary = input.type === 'gestureScrollBegin'
            ? 'begin'
            : input.type === 'gestureScrollEnd'
                ? 'end'
                : null;
        if (boundary !== null && !webContents.isDestroyed()) {
            webContents.send(HOST_PLATFORM_FEATURE.eventChannels.onWheelScrollSequenceChange, boundary);
        }
    };

    webContents.on('before-input-event', handleBeforeInputEvent);
    webContents.on('input-event', handleInputEvent);
    window.once('closed', () => {
        const hostEnvironmentBroadcastState = hostEnvironmentBroadcastStateByWindow.get(window);
        if (hostEnvironmentBroadcastState?.timeout) {
            clearTimeout(hostEnvironmentBroadcastState.timeout);
        }
        hostEnvironmentBroadcastStateByWindow.delete(window);
        window.removeListener('move', handleMove);
        window.removeListener('moved', handleMove);
        window.removeListener('enter-full-screen', handleZenModeChange);
        window.removeListener('leave-full-screen', handleZenModeChange);
        if (!webContents.isDestroyed()) {
            webContents.removeListener('before-input-event', handleBeforeInputEvent);
            webContents.removeListener('input-event', handleInputEvent);
        }
        zenWindowPlacementByWindow.delete(window);
        zenExitInProgressByWindow.delete(window);
    });
}
