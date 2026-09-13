import type { TDocumentRef } from '@contracts/documentRef';
import type { Ref } from 'vue';
import type { TPaneDirection } from '@contracts/editorPanes';
import type { IWorkspaceExpose } from '@app/types/workspaceExpose';
import type { TWindowTabsAction } from '@contracts/windowTabs';
import type { IDocumentsMenuCapability } from '@contracts/electronApiDocuments';
import type { ISettingsCapability } from '@contracts/settingsPlatformFeature';
import type { IUpdatesCapability } from '@contracts/updatesPlatformFeature';
import type { IDjvuCapability } from '@contracts/djvuPlatformFeature';
import type { IWindowTabsCapability } from '@contracts/windowTabsPlatformFeature';
import { BrowserLogger } from '@app/utils/browserLogger';
import {
    invokeWorkspaceExposeCommand,
    workspaceExposeMenuCommandDescriptors,
    type TWorkspaceExposeMethod,
} from '@app/modules/workspace-shell/expose/workspaceExposeDescriptors';

export interface ITabsMenuBindingApi {
    documentMenu: IDocumentsMenuCapability;
    settings: ISettingsCapability;
    updates?: IUpdatesCapability | undefined;
    djvu: IDjvuCapability;
    windowTabs: IWindowTabsCapability;
}

export interface ITabsMenuBindingDeps {
    activeWorkspace: Ref<IWorkspaceExpose | null>;
    activeTabId: Ref<string | null>;
    createTab: () => { id: string };
    handleCloseTab: (tabId: string) => Promise<void>;
    handleFallbackToolbarOpenFile: () => Promise<void>;
    openPathInAppropriateTab: (path: TDocumentRef) => Promise<boolean>;
    openPathsInAppropriateTab: (paths: TDocumentRef[]) => Promise<void>;
    clearRecentFiles: () => Promise<void>;
    loadRecentFiles: () => Promise<void>;
    checkForUpdates: () => Promise<void> | void;
    splitEditor: (direction: TPaneDirection) => Promise<void> | void;
    focusPane: (direction: TPaneDirection) => void;
    moveActiveTab: (direction: TPaneDirection) => Promise<void> | void;
    copyActiveTab: (direction: TPaneDirection) => Promise<void> | void;
    handleWindowTabsAction: (action: TWindowTabsAction) => Promise<void> | void;
    toggleAssistant: () => void;
}

type TCleanup = () => void;
type TMenuRunAction = (actionName: string, action: () => unknown) => void;
type TNoArgMenuRegister = (handler: () => void) => unknown;
type TWorkspaceMenuApi = Partial<IDocumentsMenuCapability> | Partial<IDjvuCapability>;
/**
 * A stale preload (dev-mode version mismatch) can be missing whole capabilities
 * or individual bindings, so every registration is treated as optional.
 */
type TStalePreloadMenuApi = {
    [TKey in keyof ITabsMenuBindingApi]?: Partial<NonNullable<ITabsMenuBindingApi[TKey]>> | undefined;
};

function toCleanup(value: unknown): TCleanup | null {
    return typeof value === 'function' ? value as TCleanup : null;
}

function getNoArgDocumentMenuRegister(
    menuApi: TWorkspaceMenuApi | undefined,
    key: string,
): TNoArgMenuRegister | null {
    const register = (menuApi as Record<string, unknown> | undefined)?.[key];
    return typeof register === 'function' ? register as TNoArgMenuRegister : null;
}

function resolveWorkspaceMenuApi(
    menuApi: TStalePreloadMenuApi,
    source: 'documentMenu' | 'djvu' | undefined,
) {
    const menuApis: Record<'documentMenu' | 'djvu', TWorkspaceMenuApi | undefined> = {
        documentMenu: menuApi.documentMenu,
        djvu: menuApi.djvu,
    };
    return menuApis[source ?? 'documentMenu'];
}

function runWorkspaceMenuCommand(
    deps: ITabsMenuBindingDeps,
    commandName: TWorkspaceExposeMethod,
) {
    const workspace = deps.activeWorkspace.value;
    if (!workspace) {
        return undefined;
    }

    return invokeWorkspaceExposeCommand(workspace, commandName) as unknown;
}

function registerWorkspaceMenuActions(
    menuApi: TStalePreloadMenuApi,
    deps: ITabsMenuBindingDeps,
    runMenuAction: TMenuRunAction,
) {
    const cleanups: TCleanup[] = [];
    for (const binding of workspaceExposeMenuCommandDescriptors) {
        const register = getNoArgDocumentMenuRegister(resolveWorkspaceMenuApi(menuApi, binding.menu.source), binding.menu.register);
        const cleanup = toCleanup(register?.(() => {
            runMenuAction(binding.menu.actionName, () => runWorkspaceMenuCommand(deps, binding.name));
        }));
        if (cleanup) {
            cleanups.push(cleanup);
        }
    }

    return cleanups;
}

/**
 * Registers menu->renderer event handlers and returns unsubscribe callbacks.
 * Uses optional chaining on each binding so a stale preload (dev mode version
 * mismatch) degrades gracefully rather than crashing the renderer.
 */
export function registerTabsMenuBindings(
    menuApi: ITabsMenuBindingApi,
    deps: ITabsMenuBindingDeps,
) {
    const api: TStalePreloadMenuApi = menuApi;
    const documentMenu = api.documentMenu;
    let documentOpenQueue: Promise<void> = Promise.resolve();
    let disposed = false;

    const runMenuAction = (actionName: string, action: () => unknown) => {
        try {
            const result = action();
            if (result instanceof Promise) {
                void result.catch((error) => {
                    BrowserLogger.warn('tabs-menu', `Menu action failed: ${actionName}`, error);
                });
            }
        } catch (error) {
            BrowserLogger.warn('tabs-menu', `Menu action threw: ${actionName}`, error);
        }
    };

    const enqueueDocumentOpenAction = (
        actionName: string,
        action: () => Promise<unknown>,
    ) => {
        if (disposed) {
            return;
        }

        documentOpenQueue = documentOpenQueue
            .catch((error) => {
                BrowserLogger.warn('tabs-menu', 'Recovered poisoned document-open queue', error);
            })
            .then(async () => {
                if (disposed) {
                    return;
                }

                try {
                    await action();
                } catch (error) {
                    BrowserLogger.warn('tabs-menu', `Queued document open failed: ${actionName}`, error);
                }
            });
    };

    const cleanups = [
        documentMenu?.onMenuOpenPdf?.(() => {
            runMenuAction('open-pdf', () => deps.handleFallbackToolbarOpenFile());
        }),
        ...registerWorkspaceMenuActions(api, deps, runMenuAction),
        documentMenu?.onMenuOpenRecentFile?.((path) => {
            enqueueDocumentOpenAction('open-recent-file', () => deps.openPathInAppropriateTab(path));
        }),
        documentMenu?.onMenuOpenExternalPaths?.((paths) => {
            enqueueDocumentOpenAction('open-external-paths', () => deps.openPathsInAppropriateTab(paths));
        }),
        documentMenu?.onMenuClearRecentFiles?.(() => {
            runMenuAction('clear-recentFiles', async () => {
                await deps.clearRecentFiles();
                await deps.loadRecentFiles();
            });
        }),
        documentMenu?.onMenuToggleAssistant?.(() => {
            runMenuAction('toggle-assistant', () => deps.toggleAssistant());
        }),
        api.updates?.onMenuCheckForUpdates?.(() => {
            runMenuAction('check-for-updates', () => deps.checkForUpdates());
        }),
        api.windowTabs?.onMenuNewTab?.(() => {
            runMenuAction('new-tab', () => deps.createTab());
        }),
        api.windowTabs?.onMenuCloseTab?.(() => {
            runMenuAction('close-tab', () => {
                if (deps.activeTabId.value) {
                    return deps.handleCloseTab(deps.activeTabId.value);
                }
                return undefined;
            });
        }),
        api.windowTabs?.onMenuSplitEditor?.((direction) => {
            runMenuAction('split-editor', () => deps.splitEditor(direction));
        }),
        api.windowTabs?.onMenuFocusEditorPane?.((direction) => {
            runMenuAction('focus-editor-pane', () => deps.focusPane(direction));
        }),
        api.windowTabs?.onMenuMoveTabToPane?.((direction) => {
            runMenuAction('move-tab-to-pane', () => deps.moveActiveTab(direction));
        }),
        api.windowTabs?.onMenuCopyTabToPane?.((direction) => {
            runMenuAction('copy-tab-to-pane', () => deps.copyActiveTab(direction));
        }),
        api.windowTabs?.onWindowAction?.((action) => {
            runMenuAction('window-action', () => deps.handleWindowTabsAction(action));
        }),
    ].flatMap(cleanup => typeof cleanup === 'function' ? [cleanup] : []);

    return [
        ...cleanups,
        () => {
            disposed = true;
            documentOpenQueue = Promise.resolve();
        },
    ];
}
