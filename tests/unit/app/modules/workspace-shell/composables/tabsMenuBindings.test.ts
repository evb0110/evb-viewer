import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { delay } from 'es-toolkit/promise';
import { ref } from 'vue';
import type { IWorkspaceExpose } from '@app/types/workspaceExpose';
import { registerTabsMenuBindings } from '@app/modules/workspace-shell/menu/registerTabsMenuBindings';
import { createElectronPlatformApiFixture } from '@tests/helpers/createElectronPlatformApiFixture';
import { createWorkspaceExposeFixture } from '@tests/unit/app/modules/workspace-shell/workspaceTestFixtures';

async function flushMicrotasks() {
    await Promise.resolve();
    await Promise.resolve();
    await delay(0);
}

function createDeferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((res) => {
        resolve = res;
    });

    return {
        promise,
        resolve,
    };
}

function createDeps(overrides: Partial<Parameters<typeof registerTabsMenuBindings>[1]> = {}) {
    return {
        activeWorkspace: ref<IWorkspaceExpose | null>(null),
        activeTabId: ref<string | null>(null),
        createTab: vi.fn(() => ({ id: 'tab-1' })),
        handleCloseTab: vi.fn(async (_tabId: string) => {}),
        handleFallbackToolbarOpenFile: vi.fn(async () => {}),
        openPathInAppropriateTab: vi.fn(async (_path: string) => true),
        openPathsInAppropriateTab: vi.fn(async (_paths: string[]) => {}),
        clearRecentFiles: vi.fn(async () => {}),
        loadRecentFiles: vi.fn(async () => {}),
        checkForUpdates: vi.fn(async () => {}),
        splitEditor: vi.fn(async (_direction) => {}),
        focusPane: vi.fn(),
        moveActiveTab: vi.fn(async (_direction) => {}),
        copyActiveTab: vi.fn(async (_direction) => {}),
        handleWindowTabsAction: vi.fn(async (_action) => {}),
        toggleAssistant: vi.fn(),
        ...overrides,
    } satisfies Parameters<typeof registerTabsMenuBindings>[1];
}

function createMenuApi() {
    let onMenuOpenPdf: (() => void) | null = null;
    let onMenuRepairSave: (() => void) | null = null;
    let onMenuOptimizePdfForInteraction: (() => void) | null = null;
    let onMenuPrint: (() => void) | null = null;
    let onMenuPrintCurrentPage: (() => void) | null = null;
    let onMenuOpenExternalPaths: ((paths: string[]) => void) | null = null;
    let onMenuOpenRecentFile: ((path: string) => void) | null = null;

    const menuApi = {
        onMenuOpenPdf: vi.fn((callback: () => void) => {
            onMenuOpenPdf = callback;
            return () => {
                onMenuOpenPdf = null;
            };
        }),
        onMenuRepairSave: vi.fn((callback: () => void) => {
            onMenuRepairSave = callback;
            return () => {
                onMenuRepairSave = null;
            };
        }),
        onMenuOptimizePdfForInteraction: vi.fn((callback: () => void) => {
            onMenuOptimizePdfForInteraction = callback;
            return () => {
                onMenuOptimizePdfForInteraction = null;
            };
        }),
        onMenuPrint: vi.fn((callback: () => void) => {
            onMenuPrint = callback;
            return () => {
                onMenuPrint = null;
            };
        }),
        onMenuPrintCurrentPage: vi.fn((callback: () => void) => {
            onMenuPrintCurrentPage = callback;
            return () => {
                onMenuPrintCurrentPage = null;
            };
        }),
        onMenuOpenExternalPaths: vi.fn((callback: (paths: string[]) => void) => {
            onMenuOpenExternalPaths = callback;
            return () => {
                onMenuOpenExternalPaths = null;
            };
        }),
        onMenuOpenRecentFile: vi.fn((callback: (path: string) => void) => {
            onMenuOpenRecentFile = callback;
            return () => {
                onMenuOpenRecentFile = null;
            };
        }),
    };
    const platformApi = createElectronPlatformApiFixture();
    Object.assign(platformApi.documentMenu, menuApi);
    const api = {
        documentMenu: platformApi.documentMenu,
        settings: platformApi.settings,
        updates: platformApi.updates,
        djvu: platformApi.djvu,
        windowTabs: platformApi.windowTabs,
    } satisfies Parameters<typeof registerTabsMenuBindings>[0];

    return {
        api,
        emitOpenPdf() {
            onMenuOpenPdf?.();
        },
        emitRepairSave() {
            onMenuRepairSave?.();
        },
        emitOptimizePdfForInteraction() {
            onMenuOptimizePdfForInteraction?.();
        },
        emitPrint() {
            onMenuPrint?.();
        },
        emitPrintCurrentPage() {
            onMenuPrintCurrentPage?.();
        },
        emitExternalPaths(paths: string[]) {
            onMenuOpenExternalPaths?.(paths);
        },
        emitRecentFile(path: string) {
            onMenuOpenRecentFile?.(path);
        },
    };
}

// Menu events and the workspace command each one must run.
const MENU_COMMANDS = [
    [
        'documentMenu',
        'onMenuSave',
        'handleSave',
    ],
    [
        'documentMenu',
        'onMenuSaveAs',
        'handleSaveAs',
    ],
    [
        'documentMenu',
        'onMenuUndo',
        'handleUndo',
    ],
    [
        'documentMenu',
        'onMenuZoomIn',
        'handleZoomIn',
    ],
    [
        'documentMenu',
        'onMenuViewModeFacing',
        'handleViewModeFacing',
    ],
    [
        'documentMenu',
        'onMenuRotateCw',
        'handleRotateCw',
    ],
    [
        'djvu',
        'onMenuConvertToPdf',
        'handleConvertToPdf',
    ],
] as const;

function createRegistryMenuApi() {
    const callbacks = new Map<string, () => void>();
    const platformApi = createElectronPlatformApiFixture();
    const documentMenu = platformApi.documentMenu;
    const djvu = platformApi.djvu;

    for (const [
        source,
        register,
        commandName,
    ] of MENU_COMMANDS) {
        Object.defineProperty(source === 'djvu' ? djvu : documentMenu, register, {
            configurable: true,
            value: vi.fn((callback: () => void) => {
                callbacks.set(commandName, callback);
                return () => {
                    callbacks.delete(commandName);
                };
            }),
        });
    }

    return {
        api: {
            documentMenu,
            settings: platformApi.settings,
            updates: platformApi.updates,
            djvu,
            windowTabs: platformApi.windowTabs,
        } satisfies Parameters<typeof registerTabsMenuBindings>[0],
        emit(commandName: string) {
            callbacks.get(commandName)?.();
        },
    };
}

describe('registerTabsMenuBindings', () => {
    it('routes menu commands to the active workspace command surface', async () => {
        const workspaceCommands = createWorkspaceExposeFixture({hasPdf: true});
        const deps = createDeps({activeWorkspace: ref<IWorkspaceExpose | null>(workspaceCommands)});
        const menuApi = createRegistryMenuApi();

        registerTabsMenuBindings(menuApi.api, deps);
        for (const [
            ,
            ,
            commandName,
        ] of MENU_COMMANDS) {
            menuApi.emit(commandName);
            await flushMicrotasks();

            expect(workspaceCommands[commandName], commandName).toHaveBeenCalledTimes(1);
        }
    });

    it('serializes external open requests so later launches wait for the first one', async () => {
        const firstOpen = createDeferred();
        const secondOpen = createDeferred();
        const openPathsInAppropriateTab = vi
            .fn(async (_paths: string[]) => {})
            .mockImplementationOnce(async () => firstOpen.promise)
            .mockImplementationOnce(async () => secondOpen.promise);
        const deps = createDeps({ openPathsInAppropriateTab });
        const menuApi = createMenuApi();

        registerTabsMenuBindings(menuApi.api, deps);

        menuApi.emitExternalPaths(['/docs/first.pdf']);
        menuApi.emitExternalPaths(['/docs/second.pdf']);
        await flushMicrotasks();

        expect(openPathsInAppropriateTab).toHaveBeenCalledTimes(1);
        expect(openPathsInAppropriateTab).toHaveBeenNthCalledWith(1, ['/docs/first.pdf']);

        firstOpen.resolve();
        await flushMicrotasks();

        expect(openPathsInAppropriateTab).toHaveBeenCalledTimes(2);
        expect(openPathsInAppropriateTab).toHaveBeenNthCalledWith(2, ['/docs/second.pdf']);

        secondOpen.resolve();
        await flushMicrotasks();
    });

    it('keeps the queue flowing after a failed document-open request', async () => {
        const openPathInAppropriateTab = vi
            .fn(async (_path: string) => true)
            .mockRejectedValueOnce(new Error('boom'))
            .mockResolvedValueOnce(true);
        const deps = createDeps({ openPathInAppropriateTab });
        const menuApi = createMenuApi();

        registerTabsMenuBindings(menuApi.api, deps);

        menuApi.emitRecentFile('/docs/first.pdf');
        await flushMicrotasks();
        menuApi.emitRecentFile('/docs/second.pdf');
        await flushMicrotasks();

        expect(openPathInAppropriateTab).toHaveBeenCalledTimes(2);
        expect(openPathInAppropriateTab).toHaveBeenNthCalledWith(1, '/docs/first.pdf');
        expect(openPathInAppropriateTab).toHaveBeenNthCalledWith(2, '/docs/second.pdf');
    });
});
