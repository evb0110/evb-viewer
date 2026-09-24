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

// Menu items that run a command on the active tab's workspace:
// [menu registration, command, action name, capability].
const WORKSPACE_MENU_COMMANDS: ReadonlyArray<readonly [string, keyof IWorkspaceExpose, string, ('documentMenu' | 'djvu')?]> = [
    [
        'onMenuSave',
        'handleSave',
        'save',
    ],
    [
        'onMenuRepairSave',
        'handleRepairSave',
        'repair-save',
    ],
    [
        'onMenuOptimizePdfForInteraction',
        'handleOptimizePdfForInteraction',
        'optimize-pdf-for-interaction',
    ],
    [
        'onMenuSaveAs',
        'handleSaveAs',
        'save-as',
    ],
    [
        'onMenuPrint',
        'handlePrint',
        'print',
    ],
    [
        'onMenuPrintCurrentPage',
        'handlePrintCurrentPage',
        'print-current-page',
    ],
    [
        'onMenuUndo',
        'handleUndo',
        'undo',
    ],
    [
        'onMenuRedo',
        'handleRedo',
        'redo',
    ],
    [
        'onMenuSelectAll',
        'handleSelectAll',
        'select-all',
    ],
    [
        'onMenuExportDocx',
        'handleExportDocx',
        'export-docx',
    ],
    [
        'onMenuExportImages',
        'handleExportImages',
        'export-images',
    ],
    [
        'onMenuExportMultiPageTiff',
        'handleExportMultiPageTiff',
        'export-multi-page-tiff',
    ],
    [
        'onMenuZoomIn',
        'handleZoomIn',
        'zoom-in',
    ],
    [
        'onMenuZoomOut',
        'handleZoomOut',
        'zoom-out',
    ],
    [
        'onMenuFitWidth',
        'handleFitWidth',
        'fit-width',
    ],
    [
        'onMenuFitHeight',
        'handleFitHeight',
        'fit-height',
    ],
    [
        'onMenuActualSize',
        'handleActualSize',
        'actual-size',
    ],
    [
        'onMenuToggleContinuousScroll',
        'handleToggleContinuousScroll',
        'toggle-continuous-scroll',
    ],
    [
        'onMenuInsertImageFromFile',
        'handleInsertImageFromFile',
        'insert-image-from-file',
    ],
    [
        'onMenuPasteImageFromClipboard',
        'handlePasteImageFromClipboard',
        'paste-image-from-clipboard',
    ],
    [
        'onMenuViewModeSingle',
        'handleViewModeSingle',
        'view-mode-single',
    ],
    [
        'onMenuViewModeFacing',
        'handleViewModeFacing',
        'view-mode-facing',
    ],
    [
        'onMenuViewModeFacingFirstSingle',
        'handleViewModeFacingFirstSingle',
        'view-mode-facing-first-single',
    ],
    [
        'onMenuViewRotationCw',
        'handleViewRotationCw',
        'view-rotation-cw',
    ],
    [
        'onMenuViewRotationCcw',
        'handleViewRotationCcw',
        'view-rotation-ccw',
    ],
    [
        'onMenuDeletePages',
        'handleDeletePages',
        'delete-pages',
    ],
    [
        'onMenuExtractPages',
        'handleExtractPages',
        'extract-pages',
    ],
    [
        'onMenuRotateCw',
        'handleRotateCw',
        'rotate-cw',
    ],
    [
        'onMenuRotateCcw',
        'handleRotateCcw',
        'rotate-ccw',
    ],
    [
        'onMenuInsertPages',
        'handleInsertPages',
        'insert-pages',
    ],
    [
        'onMenuConvertToPdf',
        'handleConvertToPdf',
        'convert-to-pdf',
        'djvu',
    ],
];

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
    commandName: keyof IWorkspaceExpose,
) {
    const command = deps.activeWorkspace.value?.[commandName] as (() => unknown) | undefined;
    return command?.();
}

function registerWorkspaceMenuActions(
    menuApi: TStalePreloadMenuApi,
    deps: ITabsMenuBindingDeps,
    runMenuAction: TMenuRunAction,
) {
    const cleanups: TCleanup[] = [];
    for (const [
        registerName,
        commandName,
        actionName,
        source,
    ] of WORKSPACE_MENU_COMMANDS) {
        const register = getNoArgDocumentMenuRegister(resolveWorkspaceMenuApi(menuApi, source), registerName);
        const cleanup = toCleanup(register?.(() => {
            runMenuAction(actionName, () => runWorkspaceMenuCommand(deps, commandName));
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
