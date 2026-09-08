import type {
    IpcMainInvokeEvent,
    IpcRenderer,
} from 'electron';
import { BrowserWindow } from 'electron';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';
import { registerTabsMenuBindings } from '@app/modules/workspace-shell/menu/registerTabsMenuBindings';
import {
    DOCUMENT_MENU_PLATFORM_FEATURE,
    DOCUMENT_PICKER_PLATFORM_FEATURE,
} from '@contracts/documentsPlatformFeature';
import { DJVU_PLATFORM_FEATURE } from '@contracts/djvuPlatformFeature';
import { SETTINGS_PLATFORM_FEATURE } from '@contracts/settingsPlatformFeature';
import { UPDATES_PLATFORM_FEATURE } from '@contracts/updatesPlatformFeature';
import { WINDOW_TABS_PLATFORM_FEATURE } from '@contracts/windowTabsPlatformFeature';
import { createDocumentsPreloadFileClient } from '@electron/features/documents/createDocumentsPreloadFileClient';
import { handleOpenPdfDialog } from '@electron/features/documents/main/documentOpenHandlers';
import { handleSavePdfDialog } from '@electron/features/documents/main/documentSaveDialogHandlers';
import { registerDocumentsIpcAdapter } from '@electron/features/documents/registerDocumentsIpcAdapter';
import {
    setMenuDocumentState,
    setupMenu,
} from '@electron/menu';
import { createPlatformFeaturePreloadClient } from '@electron/preload/ipcClient';
import { createDocumentsServiceFixture } from '@tests/unit/electron/helpers/createDocumentsServiceFixture';
import { createWorkspaceExposeFixture } from '@tests/unit/electron/helpers/createWorkspaceExposeFixture';

interface IMenuItemLike {
    click?: (item: unknown, window?: unknown) => unknown;
    label?: string;
    role?: string;
    submenu?: IMenuItemLike[] | unknown;
}

type TInvokeHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
type TRendererListener = (event: unknown, payload?: unknown) => void;
type TTestIpcRenderer = Pick<IpcRenderer, 'invoke' | 'on' | 'postMessage' | 'removeListener' | 'send'>;

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
    it('routes native menu commands through preload, workspace, IPC codecs, and the OS dialog boundary', async () => {
        const invokeHandlers = new Map<string, TInvokeHandler>();
        const listeners = new Map<string, Set<TRendererListener>>();
        // The mocked BrowserWindow constructor accepts test ids, unlike Electron's options object.
        const window = new BrowserWindow(42 as never);
        mocks.focusedWindow = window;

        const on = vi.fn();
        const removeListener = vi.fn();
        const ipcRenderer = {
            invoke: async (channel: string, ...args: unknown[]) => {
                const handler = invokeHandlers.get(channel);
                if (!handler) {
                    throw new Error(`Missing IPC handler for ${channel}`);
                }
                // The adapter only reads sender from this IPC event double.
                return handler({sender: window.webContents} as IpcMainInvokeEvent, ...args);
            },
            on,
            postMessage: vi.fn(),
            removeListener,
            send: vi.fn(),
        } satisfies TTestIpcRenderer;
        on.mockImplementation((channel: string, listener: TRendererListener) => {
            const channelListeners = listeners.get(channel) ?? new Set<TRendererListener>();
            channelListeners.add(listener);
            listeners.set(channel, channelListeners);
            return ipcRenderer;
        });
        removeListener.mockImplementation((channel: string, listener: TRendererListener) => {
            listeners.get(channel)?.delete(listener);
            return ipcRenderer;
        });
        mocks.emitRendererEvent = (channel: string, ...args: unknown[]) => {
            for (const listener of listeners.get(channel) ?? []) {
                // Renderer subscribers ignore the Electron event metadata in this harness.
                listener({}, args[0]);
            }
        };

        const service = createDocumentsServiceFixture({
            openDocumentDialog: handleOpenPdfDialog,
            onWorkingCopyBackingStatusChanged: vi.fn(() => () => {}),
            savePdfDialog: handleSavePdfDialog,
        });
        const registrar: Parameters<typeof registerDocumentsIpcAdapter>[0] = {handle: (channel, handler) => {
            invokeHandlers.set(channel, (...args: unknown[]) => Reflect.apply(handler, undefined, args));
        }};
        registerDocumentsIpcAdapter(
            registrar,
            service,
            {eventRegistrar: {on: vi.fn()}},
        );

        const documents = createDocumentsPreloadFileClient(ipcRenderer);
        const documentPicker = createPlatformFeaturePreloadClient(
            ipcRenderer,
            DOCUMENT_PICKER_PLATFORM_FEATURE,
            {
                getPathForFile: vi.fn(),
                getPathsForFiles: vi.fn(),
                registerFilesForOpen: vi.fn(),
            },
        );
        const documentMenu = createPlatformFeaturePreloadClient(
            ipcRenderer,
            DOCUMENT_MENU_PLATFORM_FEATURE,
        );
        let saveDialogResult: string | null = null;
        const print = vi.fn(async () => undefined);
        const deletePages = vi.fn();
        const selectAllAnnotations = vi.fn();
        const workspace = createWorkspaceExposeFixture({
            handleDeletePages: deletePages,
            handleSelectAll: selectAllAnnotations,
            handlePrint: print,
            handleSaveAs: async () => {
                saveDialogResult = await documents.savePdfDialog('native-route-output.pdf');
                return saveDialogResult !== null;
            },
        });
        const menuApi = {
            documentMenu,
            djvu: createPlatformFeaturePreloadClient(ipcRenderer, DJVU_PLATFORM_FEATURE),
            settings: {
                ...createPlatformFeaturePreloadClient(ipcRenderer, SETTINGS_PLATFORM_FEATURE),
                getDebugLogs: async () => [],
                onDebugLog: () => () => undefined,
                rendererLog: () => undefined,
            },
            updates: {
                ...createPlatformFeaturePreloadClient(ipcRenderer, UPDATES_PLATFORM_FEATURE),
                onMenuCheckForUpdates: () => () => undefined,
            },
            windowTabs: {
                ...createPlatformFeaturePreloadClient(ipcRenderer, WINDOW_TABS_PLATFORM_FEATURE),
                notifyRendererReady: () => undefined,
            },
        } satisfies Parameters<typeof registerTabsMenuBindings>[0];
        const menuDeps = {
            activeTabId: ref('tab-1'),
            activeWorkspace: ref(workspace),
            checkForUpdates: async () => undefined,
            clearRecentFiles: async () => undefined,
            copyActiveTab: () => undefined,
            createTab: () => ({id: 'tab-2'}),
            focusPane: () => undefined,
            handleCloseTab: async () => undefined,
            handleFallbackToolbarOpenFile: async () => {
                await documentPicker.openDocumentDialog();
            },
            handleWindowTabsAction: () => undefined,
            loadRecentFiles: async () => undefined,
            moveActiveTab: () => undefined,
            openPathInAppropriateTab: async () => true,
            openPathsInAppropriateTab: async () => undefined,
            splitEditor: () => undefined,
            toggleAssistant: () => undefined,
        } satisfies Parameters<typeof registerTabsMenuBindings>[1];
        registerTabsMenuBindings(menuApi, menuDeps);

        setupMenu();
        setMenuDocumentState(window.id, true);

        findMenuItem('menu.file', 'menu.openFile').click?.({}, window);
        await flushCommandRoute();
        expect(mocks.dialog.showOpenDialog).toHaveBeenCalledWith(window, expect.objectContaining({
            title: 'dialogs.openDocument',
            defaultPath: '/Users/Test/Documents',
            filters: [{
                name: 'dialogs.documentsFilter',
                extensions: expect.arrayContaining([
                    'pdf',
                    'djvu',
                    'djv',
                ]),
            }],
            properties: [
                'openFile',
                'multiSelections',
            ],
        }));

        findMenuItem('menu.file', 'menu.saveAs').click?.({}, window);
        await flushCommandRoute();
        expect(mocks.dialog.showSaveDialog).toHaveBeenCalledWith(window, {
            title: 'dialogs.savePdf',
            defaultPath: 'native-route-output.pdf',
            filters: [{
                name: 'dialogs.pdfFiles',
                extensions: ['pdf'],
            }],
        });
        expect(saveDialogResult).toBe('/tmp/native-route-output.pdf');

        findMenuItem('menu.file', 'menu.print').click?.({}, window);
        findMenuItem('menu.pages', 'menu.deleteSelectedPages').click?.({}, window);
        await flushCommandRoute();
        expect(print).toHaveBeenCalledOnce();
        expect(deletePages).toHaveBeenCalledOnce();

        vi.mocked(window.webContents.executeJavaScript).mockResolvedValueOnce(true);
        findMenuItem('menu.edit', 'menu.selectAll').click?.({}, window);
        await flushCommandRoute();
        expect(selectAllAnnotations).toHaveBeenCalledOnce();
        expect(window.webContents.selectAll).not.toHaveBeenCalled();

        findMenuItem('menu.edit', 'menu.selectAll').click?.({}, window);
        await flushCommandRoute();
        expect(window.webContents.selectAll).toHaveBeenCalledOnce();
        expect(selectAllAnnotations).toHaveBeenCalledOnce();
    });

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
