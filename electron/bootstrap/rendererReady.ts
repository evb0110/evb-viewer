import type {BrowserWindow} from 'electron';

export function shouldResetRendererReadyOnNavigation(options: {isMainFrame: boolean; isInPlace: boolean}) {
    return options.isMainFrame && !options.isInPlace;
}

export function resolveExternalOpenDispatchWindow(options: {mainWindow: BrowserWindow | null; focusedWindow: BrowserWindow | null}) {
    return options.mainWindow ?? options.focusedWindow ?? null;
}
