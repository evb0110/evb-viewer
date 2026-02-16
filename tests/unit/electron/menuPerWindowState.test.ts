import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

interface IMenuItemLike {
    label?: string;
    enabled?: boolean;
    submenu?: IMenuItemLike[] | unknown;
}

interface ITestWindow {
    id: number;
    isDestroyed: () => boolean;
    getTitle: () => string;
    on: (event: string, handler: (...args: unknown[]) => void) => ITestWindow;
}

const mocks = vi.hoisted(() => ({
    windows: [] as ITestWindow[],
    buildFromTemplate: vi.fn((template: unknown) => ({
        popup: vi.fn(),
        template,
    })),
    setApplicationMenu: vi.fn(),
    appListeners: new Map<string, (...args: unknown[]) => void>(),
    createWindow: ((_id: number, _title: string) => {
        throw new Error('createWindow mock not initialized');
    }) as (id: number, title: string) => ITestWindow,
    focusWindow: ((_window: ITestWindow | null) => {
        throw new Error('focusWindow mock not initialized');
    }) as (window: ITestWindow | null) => void,
}));

vi.mock('electron', () => {
    class MockBrowserWindow {
        static focusedWindow: MockBrowserWindow | null = null;

        readonly id: number;

        private title: string;

        private destroyed = false;

        private handlers = new Map<string, Array<(...args: unknown[]) => void>>();

        readonly webContents = {
            send: vi.fn(),
            copy: vi.fn(),
        };

        constructor(id: number, title: string) {
            this.id = id;
            this.title = title;
        }

        static getFocusedWindow() {
            return MockBrowserWindow.focusedWindow;
        }

        isDestroyed() {
            return this.destroyed;
        }

        getTitle() {
            return this.title;
        }

        on(event: string, handler: (...args: unknown[]) => void) {
            const existing = this.handlers.get(event) ?? [];
            existing.push(handler);
            this.handlers.set(event, existing);
            return this;
        }

        close() {
            this.destroyed = true;
            const listeners = this.handlers.get('closed') ?? [];
            for (const listener of listeners) {
                listener();
            }
        }
    }

    mocks.createWindow = (id: number, title: string) => new MockBrowserWindow(id, title);
    mocks.focusWindow = (window: ITestWindow | null) => {
        MockBrowserWindow.focusedWindow = window as MockBrowserWindow | null;
    };

    return {
        app: {
            on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
                mocks.appListeners.set(event, handler);
            }),
            quit: vi.fn(),
            showAboutPanel: vi.fn(),
        },
        BrowserWindow: MockBrowserWindow,
        Menu: {
            buildFromTemplate: mocks.buildFromTemplate,
            setApplicationMenu: mocks.setApplicationMenu,
        },
    };
});

vi.mock('@electron/window', () => ({
    getAllAppWindows: () => mocks.windows,
    getWindowById: (windowId: number) =>
        mocks.windows.find(window => window.id === windowId) ?? null,
}));

vi.mock('@electron/recent-files', () => ({getRecentFilesSync: () => []}));

vi.mock('@electron/i18n', () => ({te: (key: string) => key}));

vi.mock('@electron/config', () => ({config: {isMac: false}}));

const {
    setupMenu,
    setMenuDocumentState,
    refreshMenu,
} = await import('@electron/menu');

function getLastMenuTemplate() {
    const lastCall = mocks.buildFromTemplate.mock.calls.at(-1);
    return (lastCall?.[0] as IMenuItemLike[] | undefined) ?? [];
}

function isSaveEnabled(template: IMenuItemLike[]) {
    const fileMenu = template.find(item => item.label === 'menu.file');
    const submenu = Array.isArray(fileMenu?.submenu) ? fileMenu.submenu : [];
    const saveItem = submenu.find(item => item.label === 'menu.save');
    return Boolean(saveItem?.enabled);
}

describe('menu per-window document state', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.windows.length = 0;
        mocks.focusWindow(null);
    });

    it('uses focused window document state independently', () => {
        const firstWindow = mocks.createWindow(1, 'First Window');
        const secondWindow = mocks.createWindow(2, 'Second Window');

        mocks.windows.push(
            firstWindow,
            secondWindow,
        );

        mocks.focusWindow(firstWindow);
        setupMenu();

        setMenuDocumentState(1, true);
        setMenuDocumentState(2, false);

        let template = getLastMenuTemplate();
        expect(isSaveEnabled(template)).toBe(true);

        mocks.focusWindow(secondWindow);
        refreshMenu();

        template = getLastMenuTemplate();
        expect(isSaveEnabled(template)).toBe(false);

        setMenuDocumentState(2, true);
        template = getLastMenuTemplate();
        expect(isSaveEnabled(template)).toBe(true);

        mocks.focusWindow(firstWindow);
        refreshMenu();

        template = getLastMenuTemplate();
        expect(isSaveEnabled(template)).toBe(true);
    });
});
