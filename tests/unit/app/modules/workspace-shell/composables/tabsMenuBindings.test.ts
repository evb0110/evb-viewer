// @vitest-environment happy-dom
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { delay } from 'es-toolkit/promise';
import { computed, ref, shallowRef } from 'vue';
import {useAppShellDirectionalTabs} from '@app/modules/workspace-shell/composables/useAppShellDirectionalTabs';
import {cast} from '@tests/helpers/cast';
import {requireDocumentRef} from '@contracts/documentRef';
import type { IWorkspaceExpose } from '@app/types/workspaceExpose';
import { registerTabsMenuBindings } from '@app/modules/workspace-shell/menu/registerTabsMenuBindings';
import { routeRecentFile } from '@app/modules/workspace-shell/composables/useTabsShellBindings';
import type { IWorkspaceDocumentController } from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
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
        isActive: ref(true),
        activeWorkspace: ref<IWorkspaceExpose | null>(null),
        activeTabId: ref<string | null>(null),
        createTab: vi.fn(() => ({ id: 'tab-1' })),
        handleCloseTab: vi.fn(async (_tabId: string) => {}),
        handleFallbackToolbarOpenFile: vi.fn(async () => {}),
        openRecentInAppropriateTab: vi.fn(async (_path: string) => true),
        openPathsInAppropriateTab: vi.fn(async (_paths: string[]) => {}),
        clearRecentFiles: vi.fn(async () => {}),
        loadRecentFiles: vi.fn(async () => {}),
        checkForUpdates: vi.fn(async () => {}),
        openNewPane: vi.fn(async (_direction) => {}),
        handleWindowTabsAction: vi.fn(async (_action) => {}),
        toggleAssistant: vi.fn(),
        ...overrides,
    } satisfies Parameters<typeof registerTabsMenuBindings>[1];
}

// Menu events and the workspace command each one must run.
const MENU_COMMANDS = [
    ['documentMenu', 'onMenuSave', 'handleSave'],
    ['documentMenu', 'onMenuSaveAs', 'handleSaveAs'],
    ['documentMenu', 'onMenuUndo', 'handleUndo'],
    ['documentMenu', 'onMenuZoomIn', 'handleZoomIn'],
    ['documentMenu', 'onMenuViewModeFacing', 'handleViewModeFacing'],
    ['documentMenu', 'onMenuRotateCw', 'handleRotateCw'],
    ['djvu', 'onMenuConvertToPdf', 'handleConvertToPdf'],
] as const;

function createRegistryMenuApi() {
    const callbacks = new Map<string, () => void>();
    const platformApi = createElectronPlatformApiFixture();
    let externalPaths: Parameters<typeof platformApi.documentMenu.onMenuOpenExternalPaths>[0] | undefined;
    let recentFile: Parameters<typeof platformApi.documentMenu.onMenuOpenRecentFile>[0] | undefined;
    const documentMenu = platformApi.documentMenu;
    const djvu = platformApi.djvu;

    for (const [source, register, commandName] of MENU_COMMANDS) {
        Object.defineProperty(source === 'djvu' ? djvu : documentMenu, register, {
            configurable: true,
            value: vi.fn((callback: () => void) => {
                callbacks.set(commandName, callback);
                return () => { callbacks.delete(commandName); };
            }),
        });
    }

    documentMenu.onMenuOpenExternalPaths = callback => {
        externalPaths = callback;
        return () => { externalPaths = undefined; };
    };
    documentMenu.onMenuOpenRecentFile = callback => {
        recentFile = callback;
        return () => { recentFile = undefined; };
    };
    return {
        emitExternalPaths: (paths: string[]) => externalPaths?.(paths.map(requireDocumentRef)),
        emitRecentFile: (path: string) => recentFile?.(requireDocumentRef(path)),
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
    it.each([
        true,
        false,
    ])('routes menu commands only while the shell is active (initially %s)', async (isActive) => {
        const workspaceCommands = createWorkspaceExposeFixture({hasPdf: true});
        const shellActive = ref(isActive);
        const deps = createDeps({
            isActive: shellActive,
            activeWorkspace: ref<IWorkspaceExpose | null>(workspaceCommands),
        });
        const menuApi = createRegistryMenuApi();

        registerTabsMenuBindings(menuApi.api, deps);
        for (const [
            ,
            ,
            commandName,
        ] of MENU_COMMANDS) {
            menuApi.emit(commandName);
            await flushMicrotasks();

            expect(workspaceCommands[commandName], commandName).toHaveBeenCalledTimes(Number(isActive));
        }
        shellActive.value = !isActive;
        for (const [
            ,, commandName,
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
        const menuApi = createRegistryMenuApi();

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
        const openRecentInAppropriateTab = vi
            .fn(async (_path: string) => true)
            .mockRejectedValueOnce(new Error('boom'))
            .mockResolvedValueOnce(true);
        const deps = createDeps({ openRecentInAppropriateTab });
        const menuApi = createRegistryMenuApi();

        registerTabsMenuBindings(menuApi.api, deps);

        menuApi.emitRecentFile('/docs/first.pdf');
        await flushMicrotasks();
        menuApi.emitRecentFile('/docs/second.pdf');
        await flushMicrotasks();

        expect(openRecentInAppropriateTab).toHaveBeenCalledTimes(2);
        expect(openRecentInAppropriateTab).toHaveBeenNthCalledWith(1, '/docs/first.pdf');
        expect(openRecentInAppropriateTab).toHaveBeenNthCalledWith(2, '/docs/second.pdf');
    });
});

const shell = vi.hoisted(() => ({showItemInFolder: vi.fn()}));
const platform = createElectronPlatformApiFixture({documentWindow: shell});
vi.mock('@app/utils/platform', () => ({getPlatformAPI: () => platform, hasElectronAPI: () => true}));
afterEach(() => {vi.unstubAllGlobals();});
describe('#1608 tab shell action feedback', () => {
    it.each([
        {kind: 'copy-path', outcome: 'reject'},
        {kind: 'reveal-in-folder', outcome: 'reject'},
        {kind: 'reveal-in-folder', outcome: 'false'},
    ] as const)('reports $kind failure ($outcome)', async ({kind, outcome}) => {
        const messages: string[] = [];
        vi.stubGlobal('useToast', () => ({add: (notice: {title: string; description?: string}) => {
            messages.push([notice.title, notice.description].filter(Boolean).join(' '));
        }}));
        const failure = new Error(kind === 'copy-path' ? 'Clipboard permission denied' : 'File manager unavailable');
        if (outcome === 'false') {shell.showItemInFolder.mockResolvedValue(false);}
        else {shell.showItemInFolder.mockRejectedValue(failure);}
        vi.stubGlobal('navigator', {clipboard: {writeText: async () => {throw failure;}}});
        const tabs = useAppShellDirectionalTabs(cast<Parameters<typeof useAppShellDirectionalTabs>[0]>({
            activePaneId: ref('pane-1'), panes: ref([]), tabs: ref([{id: 'tab-1'}]),
            documentSessionsByTabId: shallowRef({'tab-1': {snapshot: ref({identity: {originalPath: '/docs/a.pdf'}})}}),
            isTabTransitionBusy: computed(() => false), getPaneById: () => ({paneId: 'pane-1'}), activatePane: () => {}, activateTab: () => {},
        }));
        await tabs.handleTabContextCommand('pane-1', 'tab-1', {kind});
        expect(messages.join(' '), 'I1: clipboard/shell rejection must reach the user').toMatch(
            kind === 'copy-path' ? /cop|clipboard/i : /folder|reveal/i,
        );
    });

    it('shows Start, not the open tab, when a repeated Recent selection names a gone file', async () => {
        const path = requireDocumentRef('/docs/gone.pdf');
        const openTab = cast<IWorkspaceDocumentController>({
            file: shallowRef({originalPath: path}),
            snapshot: ref({phase: 'presented', activeTransaction: null}),
        });
        const activateTab = vi.fn();
        const open = vi.fn(async () => false);
        // The first selection removes the entry; the queued second finds nothing to remove.
        const forgetRecentFileIfMissing = vi.fn(async () => false).mockResolvedValueOnce(true);
        const route = {
            sessionsByTabId: () => ({'tab-open': openTab}),
            activateTab,
            forgetRecentFileIfMissing,
            statSource: vi.fn(async () => {
                throw new Error('ENOENT');
            }),
        };

        expect(await routeRecentFile(path, open, route)).toBe(false);
        expect(open).not.toHaveBeenCalled();
        await routeRecentFile(path, open, route);

        expect(activateTab).not.toHaveBeenCalled();
        expect(open).toHaveBeenCalledTimes(1);
    });
});
