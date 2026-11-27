import type {BrowserWindow} from 'electron';

type TAppWindowRegistryListener = () => void;

const appWindows = new Map<number, BrowserWindow>();
const registryListeners = new Set<TAppWindowRegistryListener>();
let mainWindowId: number | null = null;

function notifyRegistryListeners() {
    for (const listener of [...registryListeners]) {
        listener();
    }
}

export function onAppWindowRegistryChange(listener: TAppWindowRegistryListener) {
    registryListeners.add(listener);
    return () => {
        registryListeners.delete(listener);
    };
}

export function registerAppWindow(window: BrowserWindow, options: {setAsMain?: boolean} = {}) {
    const previous = appWindows.get(window.id);
    appWindows.set(window.id, window);

    const shouldSetMain = options.setAsMain ?? mainWindowId === null;
    if (shouldSetMain) {
        mainWindowId = window.id;
    }

    if (previous !== window) {
        if (typeof window.once === 'function') {
            const windowId = window.id;
            window.once('closed', () => {
                if (appWindows.get(windowId) === window) {
                    unregisterAppWindow(windowId);
                }
            });
        }
        notifyRegistryListeners();
    }
}

export function unregisterAppWindow(windowId: number) {
    const removed = appWindows.delete(windowId);
    const pruned = syncWindowRegistry();
    if (mainWindowId === windowId) {
        mainWindowId = appWindows.keys().next().value ?? null;
    }
    if (removed || pruned) {
        notifyRegistryListeners();
    }
}

function syncWindowRegistry() {
    let pruned = false;
    for (const windowId of appWindows.keys()) {
        const window = appWindows.get(windowId);
        if (!window || window.isDestroyed()) {
            appWindows.delete(windowId);
            pruned = true;
        }
    }

    if (mainWindowId !== null && !appWindows.has(mainWindowId)) {
        mainWindowId = appWindows.keys().next().value ?? null;
    }
    return pruned;
}

export function getWindowByIdFromRegistry(windowId: number) {
    const fromRegistry = appWindows.get(windowId);
    if (fromRegistry && !fromRegistry.isDestroyed()) {
        return fromRegistry;
    }

    if (appWindows.delete(windowId)) {
        if (mainWindowId === windowId) {
            mainWindowId = appWindows.keys().next().value ?? null;
        }
        notifyRegistryListeners();
    }
    return null;
}

export function getAllRegisteredAppWindows() {
    const pruned = syncWindowRegistry();
    const windows = Array.from(appWindows.values()).filter((window) => !window.isDestroyed());
    if (pruned) {
        notifyRegistryListeners();
    }
    return windows;
}

export function getRegisteredMainWindow() {
    if (mainWindowId !== null) {
        const mainWindow = getWindowByIdFromRegistry(mainWindowId);
        if (mainWindow) {
            return mainWindow;
        }
    }

    const fallback = getAllRegisteredAppWindows()[0] ?? null;
    if (fallback) {
        mainWindowId = fallback.id;
    }

    return fallback;
}
