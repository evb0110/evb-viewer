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
    role?: string;
    type?: string;
    checked?: boolean;
    click?: (item: unknown, window?: unknown) => unknown;
    submenu?: IMenuItemLike[] | unknown;
}

interface IMenuPerWindowStateTestWindow {
    id: number;
    webContents: {
        send: ReturnType<typeof vi.fn>;
        copy: ReturnType<typeof vi.fn>;
        cut: ReturnType<typeof vi.fn>;
        paste: ReturnType<typeof vi.fn>;
        selectAll: ReturnType<typeof vi.fn>;
        undo: ReturnType<typeof vi.fn>;
        redo: ReturnType<typeof vi.fn>;
        executeJavaScript: ReturnType<typeof vi.fn>;
        isDestroyed: ReturnType<typeof vi.fn>;
    };
    close: () => void;
    isDestroyed: () => boolean;
    getTitle: () => string;
    on: (event: string, handler: (...args: unknown[]) => void) => IMenuPerWindowStateTestWindow;
}

const mocks = vi.hoisted(() => ({
    windows: [] as IMenuPerWindowStateTestWindow[],
    buildFromTemplate: vi.fn((template: unknown) => ({
        popup: vi.fn(),
        template,
    })),
    setApplicationMenu: vi.fn(),
    appListeners: new Map<string, (...args: unknown[]) => void>(),
    createWindow: ((_id: number, _title: string): IMenuPerWindowStateTestWindow => {
        throw new Error('createWindow mock not initialized');
    }),
    focusWindow: ((_window: IMenuPerWindowStateTestWindow | null): void => {
        throw new Error('focusWindow mock not initialized');
    }),
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
            cut: vi.fn(),
            paste: vi.fn(),
            selectAll: vi.fn(),
            undo: vi.fn(),
            redo: vi.fn(),
            executeJavaScript: vi.fn(async () => false),
            isDestroyed: vi.fn(() => false),
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
    mocks.focusWindow = (window: IMenuPerWindowStateTestWindow | null) => {
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

vi.mock('@electron/window/registry', () => ({
    getAllRegisteredAppWindows: () => mocks.windows,
    getWindowByIdFromRegistry: (windowId: number) =>
        mocks.windows.find(window => window.id === windowId) ?? null,
}));

vi.mock('@electron/recentFiles', () => ({getRecentFilesSync: () => []}));

vi.mock('@electron/te', () => ({te: (key: string) => key}));

vi.mock('@electron/config', () => ({config: {isMac: false}}));

const {
    setupMenu,
    setMenuDocumentState,
    setMenuTabCount,
    refreshMenu,
} = await import('@electron/menu');

function getLastMenuTemplate() {
    const lastCall = mocks.buildFromTemplate.mock.calls.at(-1);
    return (lastCall?.[0] as IMenuItemLike[] | undefined) ?? [];
}

async function waitForMenuClickTasks() {
    await Promise.resolve();
    await Promise.resolve();
}

function isSaveEnabled(template: IMenuItemLike[]) {
    const fileMenu = template.find(item => item.label === 'menu.file');
    const submenu = Array.isArray(fileMenu?.submenu) ? fileMenu.submenu : [];
    const saveItem = submenu.find(item => item.label === 'menu.save');
    return Boolean(saveItem?.enabled);
}

function isSaveAsEnabled(template: IMenuItemLike[]) {
    const fileMenu = template.find(item => item.label === 'menu.file');
    const submenu = Array.isArray(fileMenu?.submenu) ? fileMenu.submenu : [];
    const saveAsItem = submenu.find(item => item.label === 'menu.saveAs');
    return Boolean(saveAsItem?.enabled);
}

function isRepairSaveEnabled(template: IMenuItemLike[]) {
    const fileMenu = template.find(item => item.label === 'menu.file');
    const submenu = Array.isArray(fileMenu?.submenu) ? fileMenu.submenu : [];
    const repairSaveItem = submenu.find(item => item.label === 'menu.repairAndSave');
    return Boolean(repairSaveItem?.enabled);
}

function isOptimizePdfEnabled(template: IMenuItemLike[]) {
    const fileMenu = template.find(item => item.label === 'menu.file');
    const submenu = Array.isArray(fileMenu?.submenu) ? fileMenu.submenu : [];
    const optimizeItem = submenu.find(item => item.label === 'menu.optimizePdfForInteraction');
    return Boolean(optimizeItem?.enabled);
}

function getFileMenuSubmenu(template: IMenuItemLike[]) {
    const fileMenu = template.find(item => item.label === 'menu.file');
    return Array.isArray(fileMenu?.submenu) ? fileMenu.submenu : [];
}

function getExportMenuSubmenu(template: IMenuItemLike[]) {
    const exportMenu = getFileMenuSubmenu(template).find(item => item.label === 'menu.export');
    return Array.isArray(exportMenu?.submenu) ? exportMenu.submenu : [];
}

function isMoveToNewWindowEnabled(template: IMenuItemLike[]) {
    const windowMenu = template.find(item => item.label === 'menu.window');
    const submenu = Array.isArray(windowMenu?.submenu) ? windowMenu.submenu : [];
    const moveItem = submenu.find(item => item.label === 'menu.moveActiveTabToNewWindow');
    return Boolean(moveItem?.enabled);
}

function getEditMenuSubmenu(template: IMenuItemLike[]) {
    const editMenu = template.find(item => item.label === 'menu.edit');
    return Array.isArray(editMenu?.submenu) ? editMenu.submenu : [];
}

function getViewMenuSubmenu(template: IMenuItemLike[]) {
    const viewMenu = template.find(item => item.label === 'menu.view');
    return Array.isArray(viewMenu?.submenu) ? viewMenu.submenu : [];
}

function getPagesMenuSubmenu(template: IMenuItemLike[]) {
    const pagesMenu = template.find(item => item.label === 'menu.pages');
    return Array.isArray(pagesMenu?.submenu) ? pagesMenu.submenu : [];
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

    it('disables save while keeping document actions enabled when a document is clean', () => {
        const firstWindow = mocks.createWindow(1, 'First Window');
        mocks.windows.push(firstWindow);
        mocks.focusWindow(firstWindow);

        setupMenu();
        setMenuDocumentState(1, {
            hasDocument: true,
            canSave: false,
        });

        const template = getLastMenuTemplate();
        const fileSubmenu = getFileMenuSubmenu(template);

        expect(isSaveEnabled(template)).toBe(false);
        expect(isSaveAsEnabled(template)).toBe(true);
        expect(isRepairSaveEnabled(template)).toBe(true);
        expect(isOptimizePdfEnabled(template)).toBe(true);
        expect(fileSubmenu.find(item => item.label === 'menu.print')?.enabled).toBe(true);
    });

    it('tracks save-as availability separately from document and save state', () => {
        const firstWindow = mocks.createWindow(1, 'First Window');
        mocks.windows.push(firstWindow);
        mocks.focusWindow(firstWindow);

        setupMenu();
        setMenuDocumentState(1, {
            hasDocument: true,
            canSave: true,
            canSaveAs: false,
        });

        let template = getLastMenuTemplate();
        expect(isSaveEnabled(template)).toBe(true);
        expect(isSaveAsEnabled(template)).toBe(false);

        setMenuDocumentState(1, {
            hasDocument: true,
            canSave: false,
            canSaveAs: true,
        });

        template = getLastMenuTemplate();
        expect(isSaveEnabled(template)).toBe(false);
        expect(isSaveAsEnabled(template)).toBe(true);
    });

    it('tracks optimize availability separately from repair availability', () => {
        const firstWindow = mocks.createWindow(1, 'First Window');
        mocks.windows.push(firstWindow);
        mocks.focusWindow(firstWindow);

        setupMenu();
        setMenuDocumentState(1, {
            hasDocument: true,
            canSave: false,
            canRepairSave: true,
            canOptimizePdf: false,
        });

        let template = getLastMenuTemplate();
        expect(isRepairSaveEnabled(template)).toBe(true);
        expect(isOptimizePdfEnabled(template)).toBe(false);

        setMenuDocumentState(1, {
            hasDocument: true,
            canSave: false,
            canRepairSave: true,
            canOptimizePdf: true,
        });

        template = getLastMenuTemplate();
        expect(isOptimizePdfEnabled(template)).toBe(true);
    });

    it('disables move-to-new-window when focused window has one tab', () => {
        const firstWindow = mocks.createWindow(1, 'First Window');
        const secondWindow = mocks.createWindow(2, 'Second Window');

        mocks.windows.push(
            firstWindow,
            secondWindow,
        );

        mocks.focusWindow(firstWindow);
        setupMenu();

        setMenuTabCount(1, 1);

        let template = getLastMenuTemplate();
        expect(isMoveToNewWindowEnabled(template)).toBe(false);

        setMenuTabCount(1, 2);
        template = getLastMenuTemplate();
        expect(isMoveToNewWindowEnabled(template)).toBe(true);
    });

    it('keeps native edit roles available for focused text inputs', () => {
        const window = mocks.createWindow(1, 'Window');

        mocks.windows.push(window);
        mocks.focusWindow(window);
        setupMenu();

        const roles = getEditMenuSubmenu(getLastMenuTemplate())
            .map(item => item.role)
            .filter(Boolean);

        expect(roles).toEqual(expect.arrayContaining([
            'cut',
            'copy',
            'paste',
        ]));
    });

    it('installs the built native application menu instead of clearing it', () => {
        const window = mocks.createWindow(1, 'Window');

        mocks.windows.push(window);
        mocks.focusWindow(window);
        setupMenu();

        const builtMenu = mocks.buildFromTemplate.mock.results.at(-1)?.value;
        expect(builtMenu).toBeDefined();
        expect(mocks.setApplicationMenu).toHaveBeenLastCalledWith(builtMenu);
        expect(mocks.setApplicationMenu).not.toHaveBeenCalledWith(null);
    });

    it('adds print current page to the native file menu', () => {
        const window = mocks.createWindow(1, 'Window');

        mocks.windows.push(window);
        mocks.focusWindow(window);
        setupMenu();
        setMenuDocumentState(1, true);

        const printCurrentPageItem = getFileMenuSubmenu(getLastMenuTemplate())
            .find(item => item.label === 'menu.printCurrentPage');

        expect(printCurrentPageItem?.enabled).toBe(true);
        printCurrentPageItem?.click?.({}, window);
        expect(window.webContents.send).toHaveBeenCalledWith('menu:printCurrentPage');
    });

    it('shows a capability-aware checked continuous-scroll command', () => {
        const window = mocks.createWindow(1, 'Window');
        mocks.windows.push(window);
        mocks.focusWindow(window);
        setupMenu();

        setMenuDocumentState(1, {
            hasDocument: true,
            canSave: false,
            interactive: true,
            canContinuousScroll: true,
            continuousScroll: true,
        });

        const item = getViewMenuSubmenu(getLastMenuTemplate())
            .find(candidate => candidate.label === 'zoom.continuousScroll');
        expect(item).toMatchObject({
            enabled: true,
            type: 'checkbox',
            checked: true,
        });
        item?.click?.({}, window);
        expect(window.webContents.send).toHaveBeenCalledWith('menu:toggleContinuousScroll');
    });

    it('shows whole-document view rotation commands separately from page mutation', () => {
        const window = mocks.createWindow(1, 'Window');
        mocks.windows.push(window);
        mocks.focusWindow(window);
        setupMenu();

        setMenuDocumentState(1, {
            hasDocument: true,
            canSave: false,
            interactive: true,
            supportsPdfMutation: false,
            canMutatePages: false,
            supportsViewRotation: true,
            viewRotation: 90,
        });

        const viewItems = getViewMenuSubmenu(getLastMenuTemplate());
        expect(viewItems.find(item => item.label === 'menu.rotateViewClockwise')).toMatchObject({enabled: true});
        expect(viewItems.find(item => item.label === 'menu.rotateViewCounterclockwise')).toMatchObject({enabled: true});
        expect(getPagesMenuSubmenu(getLastMenuTemplate())).toHaveLength(0);

        viewItems.find(item => item.label === 'menu.rotateViewClockwise')?.click?.({}, window);
        viewItems.find(item => item.label === 'menu.rotateViewCounterclockwise')?.click?.({}, window);
        expect(window.webContents.send).toHaveBeenCalledWith('menu:viewRotationCw');
        expect(window.webContents.send).toHaveBeenCalledWith('menu:viewRotationCcw');
    });

    it('disables View commands while the active document is still opening', () => {
        const window = mocks.createWindow(1, 'Window');
        mocks.windows.push(window);
        mocks.focusWindow(window);
        setupMenu();

        setMenuDocumentState(1, {
            hasDocument: true,
            canSave: false,
            interactive: false,
            canContinuousScroll: true,
            continuousScroll: true,
        });

        const viewItems = getViewMenuSubmenu(getLastMenuTemplate());
        expect(viewItems.find(item => item.label === 'menu.zoomIn')?.enabled).toBe(false);
        expect(viewItems.find(item => item.label === 'zoom.continuousScroll')?.enabled).toBe(false);
    });

    it('routes undo to the focused text input instead of the document action', async () => {
        const window = mocks.createWindow(1, 'Window');
        window.webContents.executeJavaScript.mockResolvedValueOnce(true);

        mocks.windows.push(window);
        mocks.focusWindow(window);
        setupMenu();
        setMenuDocumentState(1, true);

        const undoItem = getEditMenuSubmenu(getLastMenuTemplate())
            .find(item => item.label === 'menu.undo');
        undoItem?.click?.({}, window);
        await waitForMenuClickTasks();

        expect(window.webContents.undo).toHaveBeenCalledOnce();
        expect(window.webContents.send).not.toHaveBeenCalledWith('menu:undo');
    });

    it.each([
        true,
        false,
    ])('routes Select All to the focused annotation editor only when eligible=%s', async (annotationFocused) => {
        const window = mocks.createWindow(1, 'Window');
        window.webContents.executeJavaScript.mockResolvedValueOnce(annotationFocused);
        mocks.windows.push(window);
        mocks.focusWindow(window);
        setupMenu();
        setMenuDocumentState(1, true);

        const item = getEditMenuSubmenu(getLastMenuTemplate())
            .find(candidate => candidate.label === 'menu.selectAll');
        expect(item).toBeDefined();
        item?.click?.({}, window);
        await waitForMenuClickTasks();

        if (annotationFocused) {
            expect(window.webContents.send).toHaveBeenCalledWith('menu:select-all');
            expect(window.webContents.selectAll).not.toHaveBeenCalled();
        } else {
            expect(window.webContents.selectAll).toHaveBeenCalledOnce();
            expect(window.webContents.send).not.toHaveBeenCalledWith('menu:select-all');
        }
    });

    it('does not run Select All after its target window closes', async () => {
        const window = mocks.createWindow(1, 'Window');
        window.webContents.executeJavaScript.mockImplementationOnce(async () => {
            window.close();
            return false;
        });
        mocks.windows.push(window);
        mocks.focusWindow(window);
        setupMenu();
        const item = getEditMenuSubmenu(getLastMenuTemplate())
            .find(candidate => candidate.label === 'menu.selectAll');
        expect(item).toBeDefined();
        item?.click?.({}, window);
        await waitForMenuClickTasks();
        expect(window.webContents.selectAll).not.toHaveBeenCalled();
        expect(window.webContents.send).not.toHaveBeenCalled();
    });

    it('does not invoke native undo when the window closes during the text focus probe', async () => {
        const window = mocks.createWindow(1, 'Window');
        window.webContents.executeJavaScript.mockImplementationOnce(async () => {
            window.close();
            return true;
        });

        mocks.windows.push(window);
        mocks.focusWindow(window);
        setupMenu();
        setMenuDocumentState(1, true);

        const undoItem = getEditMenuSubmenu(getLastMenuTemplate())
            .find(item => item.label === 'menu.undo');
        undoItem?.click?.({}, window);
        await waitForMenuClickTasks();

        expect(window.webContents.undo).not.toHaveBeenCalled();
        expect(window.webContents.send).not.toHaveBeenCalledWith('menu:undo');
    });

    it('routes undo to the document action when text input is not focused', async () => {
        const window = mocks.createWindow(1, 'Window');
        window.webContents.executeJavaScript.mockResolvedValueOnce(false);

        mocks.windows.push(window);
        mocks.focusWindow(window);
        setupMenu();
        setMenuDocumentState(1, true);

        const undoItem = getEditMenuSubmenu(getLastMenuTemplate())
            .find(item => item.label === 'menu.undo');
        undoItem?.click?.({}, window);
        await waitForMenuClickTasks();

        expect(window.webContents.undo).not.toHaveBeenCalled();
        expect(window.webContents.send).toHaveBeenCalledWith('menu:undo');
    });

    it('replaces the multi-level pane matrix with two direct pane-creation commands', () => {
        const window = mocks.createWindow(1, 'Window');
        mocks.windows.push(window);
        mocks.focusWindow(window);
        setupMenu();

        setMenuDocumentState(1, {
            hasDocument: false,
            canSave: false,
            canCreatePane: true,
        });

        const viewItems = getViewMenuSubmenu(getLastMenuTemplate());
        expect(viewItems.find(item => item.label === 'menu.editorPanes')).toBeUndefined();
        expect(viewItems.filter(item => item.label === 'menu.newPaneRight')).toHaveLength(1);
        expect(viewItems.filter(item => item.label === 'menu.newPaneDown')).toHaveLength(1);
        expect(viewItems.some(item => item.label?.includes('focusPane'))).toBe(false);

        setMenuDocumentState(1, {
            hasDocument: false,
            canSave: false,
            canCreatePane: false,
        });

        const disabledViewItems = getViewMenuSubmenu(getLastMenuTemplate());
        expect(disabledViewItems.find(item => item.label === 'menu.newPaneRight')?.enabled).toBe(false);
        expect(disabledViewItems.find(item => item.label === 'menu.newPaneDown')?.enabled).toBe(false);
    });

    it('keeps developer tools in the View menu after pane commands', () => {
        const window = mocks.createWindow(1, 'Window');
        mocks.windows.push(window);
        mocks.focusWindow(window);
        setupMenu();

        const viewItems = getViewMenuSubmenu(getLastMenuTemplate());
        const devToolsIndex = viewItems.findIndex(item => item.role === 'toggleDevTools');

        expect(devToolsIndex).toBeGreaterThan(0);
        expect(viewItems[devToolsIndex - 2]?.label).toBe('menu.newPaneDown');
        expect(viewItems[devToolsIndex - 1]).toMatchObject({type: 'separator'});
    });

    it('shows Pages only for mutable PDFs and requires a valid selection', () => {
        const window = mocks.createWindow(1, 'Window');
        mocks.windows.push(window);
        mocks.focusWindow(window);
        setupMenu();

        setMenuDocumentState(1, {
            hasDocument: true,
            canSave: false,
            supportsPdfMutation: false,
        });
        expect(getLastMenuTemplate().find(item => item.label === 'menu.pages')).toBeUndefined();

        setMenuDocumentState(1, {
            hasDocument: true,
            canSave: false,
            supportsPdfMutation: true,
            canMutatePages: true,
            selectedPageCount: 0,
            totalPages: 3,
        });
        let pagesItems = getPagesMenuSubmenu(getLastMenuTemplate());
        expect(pagesItems.find(item => item.label === 'menu.deleteSelectedPages')?.enabled).toBe(false);
        expect(pagesItems.find(item => item.label === 'menu.rotateClockwise')?.enabled).toBe(false);
        expect(pagesItems.find(item => item.label === 'menu.insertPages')?.enabled).toBe(true);

        setMenuDocumentState(1, {
            hasDocument: true,
            canSave: false,
            supportsPdfMutation: true,
            canMutatePages: true,
            selectedPageCount: 2,
            totalPages: 3,
        });
        pagesItems = getPagesMenuSubmenu(getLastMenuTemplate());
        expect(pagesItems.find(item => item.label === 'menu.deleteSelectedPages')?.enabled).toBe(true);
        expect(pagesItems.find(item => item.label === 'menu.extractSelectedPages')?.enabled).toBe(true);

        setMenuDocumentState(1, {
            hasDocument: true,
            canSave: false,
            supportsPdfMutation: true,
            canMutatePages: true,
            selectedPageCount: 3,
            totalPages: 3,
        });
        pagesItems = getPagesMenuSubmenu(getLastMenuTemplate());
        expect(pagesItems.find(item => item.label === 'menu.deleteSelectedPages')?.enabled).toBe(false);
    });

    it('reports current fit and page-layout state with native radio items', () => {
        const window = mocks.createWindow(1, 'Window');
        mocks.windows.push(window);
        mocks.focusWindow(window);
        setupMenu();

        setMenuDocumentState(1, {
            hasDocument: true,
            canSave: false,
            interactive: true,
            supportsViewMode: true,
            viewMode: 'facing',
            isFitWidthActive: true,
        });

        const viewItems = getViewMenuSubmenu(getLastMenuTemplate());
        expect(viewItems.find(item => item.label === 'menu.fitWidth')).toMatchObject({
            type: 'radio',
            checked: true,
        });
        expect(viewItems.find(item => item.label === 'menu.facingPages')).toMatchObject({
            type: 'radio',
            checked: true,
        });
        expect(viewItems.find(item => item.label === 'menu.singlePage')?.checked).toBe(false);
    });

    it('omits inapplicable exports and assistant controls', () => {
        const window = mocks.createWindow(1, 'Window');
        mocks.windows.push(window);
        mocks.focusWindow(window);
        setupMenu();

        setMenuDocumentState(1, {
            hasDocument: true,
            canSave: false,
            supportsExportDocx: false,
            supportsRasterExport: true,
            canExportRaster: true,
            canToggleAssistant: false,
        });

        const fileItems = getFileMenuSubmenu(getLastMenuTemplate());
        const exportMenu = fileItems.find(item => item.label === 'menu.export');
        const exportItems = Array.isArray(exportMenu?.submenu) ? exportMenu.submenu : [];
        expect(exportItems.map((item: IMenuItemLike) => item.label)).toEqual([
            'menu.exportImages',
            'menu.exportMultiPageTiff',
        ]);
        expect(getViewMenuSubmenu(getLastMenuTemplate()).find(item => item.label === 'menu.assistant')).toBeUndefined();
    });

    it('keeps native DOCX export enabled as Cancel while it is running', () => {
        const window = mocks.createWindow(1, 'Window');
        mocks.windows.push(window);
        mocks.focusWindow(window);
        setupMenu();

        setMenuDocumentState(1, {
            hasDocument: true,
            canSave: false,
            supportsExportDocx: true,
            canExportDocx: true,
        });
        expect(getExportMenuSubmenu(getLastMenuTemplate()).find((item: IMenuItemLike) => item.label === 'menu.exportDocx')).toMatchObject({enabled: true});

        setMenuDocumentState(1, {
            hasDocument: true,
            canSave: false,
            supportsExportDocx: true,
            canExportDocx: true,
            isExportingDocx: true,
        });
        expect(getExportMenuSubmenu(getLastMenuTemplate()).find((item: IMenuItemLike) => item.label === 'ocr.cancel')).toMatchObject({enabled: true});
    });

    it('uses active-tab applicability for close and window transfer commands', () => {
        const window = mocks.createWindow(1, 'Window');
        mocks.windows.push(window);
        mocks.focusWindow(window);
        setupMenu();
        setMenuTabCount(1, 2);

        setMenuDocumentState(1, {
            hasDocument: false,
            canSave: false,
            canCloseTab: false,
            canTransferActiveTab: false,
        });

        expect(getFileMenuSubmenu(getLastMenuTemplate()).find(item => item.label === 'menu.closeTab')?.enabled).toBe(false);
        expect(isMoveToNewWindowEnabled(getLastMenuTemplate())).toBe(false);
    });
});
