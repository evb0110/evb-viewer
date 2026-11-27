interface IForegroundApplication {
    focus(options: {steal: true}): void;
}

interface IForegroundWindow {
    focus(): void;
    isDestroyed(): boolean;
    isMinimized(): boolean;
    isVisible(): boolean;
    restore(): void;
    show(): void;
    webContents: {focus(): void};
}

interface IFocusWindowForUserOptions {
    application: IForegroundApplication;
    noFocus: boolean;
    platform?: NodeJS.Platform;
}

export function focusWindowForUser(window: IForegroundWindow, options: IFocusWindowForUserOptions) {
    if (options.noFocus || window.isDestroyed()) {
        return;
    }

    if (window.isMinimized()) {
        window.restore();
    }
    if (!window.isVisible()) {
        window.show();
    }

    if ((options.platform ?? process.platform) === 'darwin') {
        options.application.focus({steal: true});
    }
    // macOS application activation can change the key window. Activate the app
    // first, then make the intended BrowserWindow key so its renderer receives
    // document focus as well.
    window.focus();
    window.webContents.focus();
}
