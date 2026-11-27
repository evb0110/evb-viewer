const noop = () => {};
const noopAsync = async () => undefined;

function createNativeImage() {
    return {
        crop: () => createNativeImage(),
        getSize: () => ({
            height: 1,
            width: 1,
        }),
        isEmpty: () => false,
        resize: () => createNativeImage(),
        toPNG: () => Buffer.alloc(0),
    };
}

export const app = {
    commandLine: {
        appendSwitch: noop,
        getSwitchValue: () => '',
        hasSwitch: () => false,
    },
    exit: noop,
    getAppPath: () => process.cwd(),
    getName: () => 'EVB Viewer',
    getPath: (_name: string) => '/tmp',
    getVersion: () => '0.0.0-test',
    isPackaged: false,
    on: noop,
    once: noop,
    quit: noop,
    setName: noop,
    whenReady: async () => app,
};

export class BrowserWindow {
    static getAllWindows() {
        return [];
    }

    webContents = {
        getURL: () => '',
        on: noop,
        once: noop,
        openDevTools: noop,
        send: noop,
        setWindowOpenHandler: () => ({action: 'deny' as const}),
    };

    close = noop;
    destroy = noop;
    focus = noop;
    isDestroyed = () => false;
    loadURL = noopAsync;
    on = noop;
    once = noop;
    setMenu = noop;
    setMenuBarVisibility = noop;
    setTitle = noop;
    show = noop;
}

export const clipboard = {
    readText: () => '',
    writeText: noop,
};

export const contextBridge = {exposeInMainWorld: noop};

export const dialog = {
    showErrorBox: noop,
    showMessageBox: async () => ({response: 0}),
    showOpenDialog: async () => ({
        canceled: true,
        filePaths: [],
    }),
    showSaveDialog: async () => ({
        canceled: true,
        filePath: undefined,
    }),
};

export const ipcMain = {
    handle: noop,
    on: noop,
    removeAllListeners: noop,
    removeHandler: noop,
};

export const ipcRenderer = {
    invoke: noopAsync,
    off: noop,
    on: noop,
    once: noop,
    removeAllListeners: noop,
    removeListener: noop,
    send: noop,
};

export const Menu = {
    buildFromTemplate: () => ({
        closePopup: noop,
        items: [],
        popup: noop,
    }),
    setApplicationMenu: noop,
};

export function MenuItem(_options: Record<string, unknown> = {}) {}

export const nativeImage = {createFromPath: () => createNativeImage()};

export const screen = {
    getPrimaryDisplay: () => ({
        scaleFactor: 1,
        workAreaSize: {
            height: 900,
            width: 1440,
        },
    }),
};

export const session = {
    defaultSession: {
        clearCache: noopAsync,
        protocol: {registerFileProtocol: noop},
        setDisplayMediaRequestHandler: noop,
        setPermissionCheckHandler: noop,
        setPermissionRequestHandler: noop,
        webRequest: {
            onBeforeSendHeaders: noop,
            onHeadersReceived: noop,
        },
    },
};

export const shell = {
    openExternal: noopAsync,
    showItemInFolder: noop,
};

export const systemPreferences = {getUserDefault: () => ''};
