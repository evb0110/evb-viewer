import { BrowserWindow } from 'electron';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { setupMenu } from '@electron/menu';

interface IMenuItemLike {
    click?: (item: unknown, window?: unknown) => unknown;
    label?: string;
    role?: string;
    submenu?: IMenuItemLike[] | unknown;
}


const mocks = vi.hoisted(() => ({
    buildFromTemplate: vi.fn((template: unknown) => ({template})),
    dialog: {
        showOpenDialog: vi.fn(async () => ({
            canceled: true,
            filePaths: [],
        })),
        showSaveDialog: vi.fn(async () => ({
            canceled: false,
            filePath: '/tmp/native-route-output',
        })),
    },
    emitRendererEvent: ((_channel: string, ..._args: unknown[]) => undefined),
    focusedWindow: null as unknown,
    isMac: false,
    lastMenuTemplate: [] as IMenuItemLike[],
    showAboutPanel: vi.fn(),
}));

vi.mock('electron', () => {
    class MockBrowserWindow {
        static fromWebContents(sender: unknown) {
            const focused = mocks.focusedWindow as MockBrowserWindow | null;
            return focused?.webContents === sender ? focused : null;
        }

        static getFocusedWindow() {
            return mocks.focusedWindow as MockBrowserWindow | null;
        }

        readonly id: number;

        readonly webContents = {
            copy: vi.fn(),
            cut: vi.fn(),
            executeJavaScript: vi.fn(async () => false),
            isDestroyed: vi.fn(() => false),
            paste: vi.fn(),
            redo: vi.fn(),
            selectAll: vi.fn(),
            send: vi.fn((channel: string, ...args: unknown[]) => mocks.emitRendererEvent(channel, ...args)),
            undo: vi.fn(),
        };

        constructor(id: number) {
            this.id = id;
        }

        getTitle() {
            return 'Routing Test';
        }

        isDestroyed() {
            return false;
        }

        on() {
            return this;
        }
    }

    return {
        app: {
            getPath: vi.fn(() => '/Users/Test/Documents'),
            on: vi.fn(),
            quit: vi.fn(),
            showAboutPanel: mocks.showAboutPanel,
        },
        BrowserWindow: MockBrowserWindow,
        dialog: mocks.dialog,
        Menu: {
            buildFromTemplate: vi.fn((template: IMenuItemLike[]) => {
                mocks.lastMenuTemplate = template;
                return mocks.buildFromTemplate(template);
            }),
            setApplicationMenu: vi.fn(),
        },
    };
});

vi.mock('@electron/config', () => ({config: {get isMac() { return mocks.isMac; }}}));
vi.mock('@electron/recentFiles', () => ({getRecentFilesSync: () => []}));
vi.mock('@electron/te', () => ({te: (key: string) => key}));
vi.mock('@electron/window/registry', () => ({
    getAllRegisteredAppWindows: () => mocks.focusedWindow ? [mocks.focusedWindow] : [],
    getWindowByIdFromRegistry: () => mocks.focusedWindow,
}));

function findMenuItem(menuLabel: string, itemLabel: string) {
    const menu = mocks.lastMenuTemplate.find(item => item.label === menuLabel);
    const submenu = Array.isArray(menu?.submenu) ? menu.submenu : [];
    const item = submenu.find(candidate => candidate.label === itemLabel);
    if (!item) {
        throw new Error(`Missing native menu item ${menuLabel} > ${itemLabel}`);
    }
    return item;
}

async function flushCommandRoute() {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
}

afterEach(() => {
    mocks.focusedWindow = null;
    mocks.isMac = false;
    mocks.lastMenuTemplate = [];
    vi.clearAllMocks();
});

describe('native menu and dialog routing', () => {
    it('keeps native About and opens Acknowledgements as a local renderer page', async () => {
        // The mocked BrowserWindow constructor accepts test ids, unlike Electron's options object.
        const window = new BrowserWindow(43 as never);
        mocks.focusedWindow = window;

        setupMenu();

        findMenuItem('menu.help', 'menu.about').click?.({}, window);
        expect(mocks.showAboutPanel).toHaveBeenCalledOnce();

        findMenuItem('menu.help', 'menu.acknowledgements').click?.({}, window);
        await flushCommandRoute();
        expect(window.webContents.executeJavaScript).toHaveBeenCalledWith(
            expect.stringContaining('window.history.pushState({}, \'\', \'/about\')'),
            true,
        );

        mocks.isMac = true;
        setupMenu();
        const appMenu = mocks.lastMenuTemplate[0];
        const appSubmenu = Array.isArray(appMenu?.submenu) ? appMenu.submenu : [];
        expect(appSubmenu[0]?.role).toBe('about');
        expect(findMenuItem('menu.help', 'menu.acknowledgements')).toBeDefined();
    });
});
