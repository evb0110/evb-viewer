import type { Ref } from 'vue';
import { useEventListener } from '@vueuse/core';
import type { TDocumentRef } from '@contracts/documentRef';
import type {
    IEvbTestCommandResult,
    IEvbTestApi,
    IEvbTestWorkspaceDebugState,
} from '@app/types/evbTestApi';
import type {
    IWorkspaceAutomationStateSnapshot,
    IWorkspaceExpose,
    IWorkspaceToolbarSnapshot,
} from '@app/types/workspaceExpose';
import {
    shouldPreferDesktopPlatform,
    waitForDesktopPlatformBridge,
} from '@app/utils/platform';
import { BrowserLogger } from '@app/utils/browserLogger';
import { useFatalRuntimeError } from '@app/composables/useFatalRuntimeError';
import { useFailureToast } from '@app/composables/useFailureToast';
import { getOrCaptureRendererBootstrapFailure } from '@app/utils/getOrCaptureRendererBootstrapFailure';
import { traceRendererStartup } from '@app/utils/traceRendererStartup';
import { registerTabsMenuBindings } from '@app/modules/workspace-shell/menu/registerTabsMenuBindings';
import type { ITabsMenuBindingDeps } from '@app/modules/workspace-shell/menu/registerTabsMenuBindings';
import { getDocumentMenuCapability } from '@app/utils/platformDocuments';
import { getSettingsCapability } from '@app/utils/getSettingsCapability';
import { getUpdatesCapability } from '@app/utils/platformUpdates';
import { getDjvuCapability } from '@app/utils/getDjvuCapability';
import { getWindowTabsCapability } from '@app/utils/platformWindowTabs';
import { shouldHandleRendererMenuAccelerators } from '@app/utils/shouldHandleRendererMenuAccelerators';
import { guardAsync } from '@app/utils/asyncGuard';
import type { ITab } from '@app/types/tabs';
import { restoreWorkspaceCheckpoint } from '@app/modules/workspace-shell/checkpoint/restoreWorkspaceCheckpoint';
import type { TWorkspaceDocumentSessions } from '@app/modules/workspace-shell/document-sessions/useWorkspaceDocumentSessions';
import {
    getWorkspaceViewerChunkTargetsForPaths,
    scheduleDesktopViewerWarmup,
    warmupDesktopViewerChunkForPaths,
    type IDesktopViewerWarmupHandle,
} from '@app/modules/workspace-shell/viewers/warmupDesktopViewerChunks';
import { resolveStartupWorkProfile } from '@app/utils/startupWorkProfile';
import { registerDirectOpenAutomationDelegate } from '@app/modules/workspace-shell/automation/directOpenAutomationDispatcher';
import {
    getAutomationEvents,
    onAutomationEvent,
    waitForAutomationEvent,
} from '@app/modules/workspace-shell/automation/automationReadinessEvents';
import { isAutomationSession } from '@app/utils/isAutomationSession';

const STARTUP_OPEN_CLAIMED_EVENT_NAME = 'evb:startup-open-claimed';
type TTabKeyboardShortcutAction = 'new-tab' | 'close-tab' | 'next-tab' | 'previous-tab';
type TRendererDocumentShortcutAction = 'open-file' | 'save-as' | 'export-docx' | 'undo' | 'redo';
type TRendererDocumentCommandShortcutAction = Exclude<TRendererDocumentShortcutAction, 'open-file'>;
const RENDERER_MENU_SHORTCUT_ACTIONS: Partial<Record<string, TTabKeyboardShortcutAction>> = {
    t: 'new-tab',
    w: 'close-tab',
};
const RENDERER_DOCUMENT_SHORTCUT_COMMANDS: Record<TRendererDocumentCommandShortcutAction, keyof IWorkspaceExpose> = {
    'save-as': 'handleSaveAs',
    'export-docx': 'handleExportDocx',
    undo: 'handleUndo',
    redo: 'handleRedo',
};

interface IUseTabsShellBindingsOptions extends ITabsMenuBindingDeps {
    tabs: Ref<ITab[]>;
    workspaceRefs: Ref<Map<string, IWorkspaceExpose>>;
    isStartupOpenClaimPending: Ref<boolean>;
    activateTab: (tabId: string) => void;
    beginOpenPathsInAppropriateTab: (paths: TDocumentRef[]) => Promise<TDocumentRef[]>;
    restoreWorkspaceCheckpointGraph: Parameters<typeof restoreWorkspaceCheckpoint>[1]['restoreGraph'];
    documentSessions: TWorkspaceDocumentSessions;
    transferActiveTabToWindow?: (windowId: number) => Promise<unknown>;
}

export const useTabsShellBindings = (options: IUseTabsShellBindingsOptions) => {
    const route = useRoute();
    const { t } = useTypedI18n();
    const { setFatalRuntimeError } = useFatalRuntimeError();
    const { presentFailureToast } = useFailureToast();
    const {
        tabs,
        workspaceRefs,
        isStartupOpenClaimPending,
        activeTabId,
        activeWorkspace,
        createTab,
        activateTab,
        handleCloseTab,
        handleFallbackToolbarOpenFile,
        openPathInAppropriateTab,
        openPathsInAppropriateTab,
        beginOpenPathsInAppropriateTab,
        restoreWorkspaceCheckpointGraph,
        documentSessions,
        transferActiveTabToWindow,
        clearRecentFiles,
        loadRecentFiles,
        checkForUpdates,
        splitEditor,
        focusPane,
        moveActiveTab,
        copyActiveTab,
        handleWindowTabsAction,
        toggleAssistant,
    } = options;

    const menuCleanups: Array<() => void> = [];
    const debugHandleSave = () => activeWorkspace.value?.handleSave() ?? Promise.resolve();
    let installedTestApi: IEvbTestApi | null = null;
    let cleanupDirectOpenDelegate: (() => void) | null = null;

    function readWorkspaceSnapshot(
        tabId: string | null | undefined,
        workspace: IWorkspaceExpose | null,
    ): IWorkspaceToolbarSnapshot | null {
        try {
            const liveSnapshot = workspace?.getToolbarSnapshot() ?? null;
            if (liveSnapshot) {
                return liveSnapshot;
            }
        } catch (error) {
            BrowserLogger.warn('tabs-shell', 'Failed to read workspace toolbar snapshot for automation API', error);
        }

        // A tab without a mounted workspace keeps its last published view.
        return documentSessions.getSession(tabId)?.toolbarSnapshot.value ?? null;
    }

    function readWorkspaceAutomationState(
        workspace: IWorkspaceExpose | null,
    ): IWorkspaceAutomationStateSnapshot | Record<string, never> {
        try {
            return workspace?.getAutomationStateSnapshot() ?? {};
        } catch (error) {
            BrowserLogger.warn('tabs-shell', 'Failed to read workspace automation state', error);
            return {};
        }
    }

    function unwrapAutomationValue(value: unknown) {
        const unwrapped = value
        && typeof value === 'object'
        && 'value' in value
            ? (value as { value?: unknown }).value
            : value;
        return unwrapped instanceof Set ? Array.from(unwrapped) : unwrapped;
    }

    function createEvbTestApi(): IEvbTestApi {
        const getActiveWorkspaceHandle = () => activeWorkspace.value;

        function readActiveWorkspaceStateValues<TValues extends Record<string, unknown> = Record<string, unknown>>(
            propertyNames: string[],
        ): TValues {
            const workspace = getActiveWorkspaceHandle();
            const automationState = readWorkspaceAutomationState(workspace) as Record<string, unknown>;
            const workspaceRecord = workspace as Record<string, unknown> | null;
            const values: Record<string, unknown> = {};

            for (const propertyName of propertyNames) {
                if (propertyName in automationState) {
                    values[propertyName] = automationState[propertyName];
                    continue;
                }

                values[propertyName] = unwrapAutomationValue(workspaceRecord?.[propertyName]);
            }

            return values as TValues;
        }

        function readActiveWorkspaceCommand(commandName: string) {
            const command: unknown = (getActiveWorkspaceHandle() as Record<string, unknown> | null)?.[commandName];
            return typeof command === 'function' ? command as (...args: unknown[]) => unknown : null;
        }

        const callActiveWorkspaceSyncCommand = <TResult = unknown>(
            commandName: string,
            args: unknown[] = [],
        ): IEvbTestCommandResult<TResult> => {
            const command = readActiveWorkspaceCommand(commandName);
            return command
                ? {
                    called: true,
                    value: (command(...args) ?? null) as TResult | null,
                }
                : {
                    called: false,
                    value: null,
                };
        };

        const callActiveWorkspaceCommand = async <TResult = unknown>(
            commandName: string,
            args: unknown[] = [],
        ): Promise<IEvbTestCommandResult<TResult>> => {
            const command = readActiveWorkspaceCommand(commandName);
            return command
                ? {
                    called: true,
                    value: (await Promise.resolve(command(...args)) ?? null) as TResult | null,
                }
                : {
                    called: false,
                    value: null,
                };
        };

        return {
            openFile: openPathInAppropriateTab,
            openFiles: openPathsInAppropriateTab,
            getAutomationEvents,
            onAutomationEvent,
            waitForAutomationEvent,
            getActiveTabId: () => activeTabId.value,
            getActiveWorkspaceHandle,
            getActiveToolbarSnapshot: () => readWorkspaceSnapshot(activeTabId.value, getActiveWorkspaceHandle()),
            isStartupOpenClaimPending: () => isStartupOpenClaimPending.value,
            readActiveWorkspaceStateValues,
            splitEditor: async direction => {
                await splitEditor(direction);
            },
            callActiveWorkspaceCommand,
            callActiveWorkspaceSyncCommand,
            listTargetWindows: () => getWindowTabsCapability().listTargetWindows(),
            ...(transferActiveTabToWindow === undefined ? {} : {transferActiveTabToWindow}),
            collectWorkspaceDebugState: (): IEvbTestWorkspaceDebugState => {
                const activeWorkspaceHandle = getActiveWorkspaceHandle();
                return {
                    activeTabId: activeTabId.value,
                    activeToolbarSnapshot: readWorkspaceSnapshot(activeTabId.value, activeWorkspaceHandle),
                    activeWorkspaceState: readWorkspaceAutomationState(activeWorkspaceHandle),
                    workspaceCount: workspaceRefs.value.size,
                    workspaces: Array.from(
                        workspaceRefs.value.entries(),
                    ).map(([
                        tabId,
                        workspace,
                    ]) => ({
                        automationStateKeys: Object.keys(readWorkspaceAutomationState(workspace)),
                        exposedKeys: Object.keys(workspace),
                        isActive: tabId === activeTabId.value,
                        tabId,
                        toolbarSnapshot: readWorkspaceSnapshot(tabId, workspace),
                    })),
                };
            },
            waitForActiveDocumentOpenSettled: async () => {
                const workspace = getActiveWorkspaceHandle();
                if (!workspace) {
                    return false;
                }
                await workspace.waitForDocumentOpenSettled();
                return true;
            },
        };
    }

    function installAutomationTestApi() {
        if (!isAutomationSession()) {
            return;
        }

        installedTestApi = createEvbTestApi();
        window.__evbTestApi = installedTestApi;
    }

    function dispatchStartupOpenClaimed(pathCount: number) {
        if (typeof window === 'undefined') {
            return;
        }

        window.dispatchEvent(new CustomEvent(STARTUP_OPEN_CLAIMED_EVENT_NAME, {detail: { pathCount }}));
    }

    function cycleTab(direction: number) {
        if (tabs.value.length <= 1 || !activeTabId.value) {
            return;
        }
        const currentIndex = tabs.value.findIndex(t => t.id === activeTabId.value);
        if (currentIndex < 0) {
            return;
        }
        const nextIndex = (currentIndex + direction + tabs.value.length) % tabs.value.length;
        const nextTab = tabs.value[nextIndex];
        if (nextTab) {
            activateTab(nextTab.id);
        }
    }

    function resolveRendererMenuShortcutAction(event: KeyboardEvent) {
        const mod = event.metaKey || event.ctrlKey;
        const key = event.key.toLowerCase();
        return mod && !event.shiftKey
            ? RENDERER_MENU_SHORTCUT_ACTIONS[key] ?? null
            : null;
    }

    function isEditableShortcutTarget(target: EventTarget | null) {
        if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) {
            return false;
        }

        return Boolean(
            target.isContentEditable === true
            || Boolean(target.closest('[contenteditable="true"], [contenteditable=""]'))
            || Boolean(target.closest('input, textarea, select')),
        );
    }

    function resolveRendererDocumentShortcutAction(event: KeyboardEvent): TRendererDocumentShortcutAction | null {
        if (!shouldHandleRendererMenuAccelerators()) {
            return null;
        }

        const mod = event.metaKey || event.ctrlKey;
        if (!mod || event.altKey) {
            return null;
        }

        const key = event.key.toLowerCase();
        if (key === 'o' && !event.shiftKey) {
            return 'open-file';
        }

        if (key === 's' && event.shiftKey) {
            return 'save-as';
        }

        if (key === 'e' && event.shiftKey) {
            return 'export-docx';
        }

        if (key === 'z') {
            if (isEditableShortcutTarget(event.target)) {
                return null;
            }
            return event.shiftKey ? 'redo' : 'undo';
        }

        if (key === 'y' && !event.shiftKey && !isEditableShortcutTarget(event.target)) {
            return 'redo';
        }

        return null;
    }

    function resolveCtrlTabShortcutAction(event: KeyboardEvent): TTabKeyboardShortcutAction | null {
        if (event.ctrlKey && event.key === 'Tab' && !event.shiftKey) {
            return 'next-tab';
        }

        if (event.ctrlKey && event.key === 'Tab' && event.shiftKey) {
            return 'previous-tab';
        }

        return null;
    }

    function resolveTabKeyboardShortcutAction(event: KeyboardEvent): TTabKeyboardShortcutAction | null {
        // In Electron these accelerators are handled by the app menu.
        // Keep renderer-level handlers only as a non-Electron fallback.
        if (shouldHandleRendererMenuAccelerators()) {
            const rendererAction = resolveRendererMenuShortcutAction(event);
            if (rendererAction) {
                return rendererAction;
            }
        }

        return resolveCtrlTabShortcutAction(event);
    }

    function runTabKeyboardShortcutAction(action: TTabKeyboardShortcutAction) {
        if (action === 'new-tab') {
            createTab();
        } else if (action === 'close-tab') {
            if (activeTabId.value) {
                void handleCloseTab(activeTabId.value);
            }
        } else {
            cycleTab(action === 'next-tab' ? 1 : -1);
        }
    }

    function runRendererDocumentShortcutAction(action: TRendererDocumentShortcutAction) {
        const guard = (operation: unknown) => {
            guardAsync(Promise.resolve(operation), {
                category: 'user-visible-operation',
                scope: 'tabs-shell',
                message: `Renderer document shortcut failed: ${action}`,
            });
        };

        if (action === 'open-file') {
            guard(handleFallbackToolbarOpenFile());
            return;
        }

        const workspace = activeWorkspace.value;
        if (!workspace) {
            guard(Promise.resolve());
            return;
        }

        const command = workspace[RENDERER_DOCUMENT_SHORTCUT_COMMANDS[action]] as (() => unknown) | undefined;
        guard(command?.());
    }

    function handleTabKeyboardShortcut(event: KeyboardEvent) {
        const documentAction = resolveRendererDocumentShortcutAction(event);
        if (documentAction) {
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            runRendererDocumentShortcutAction(documentAction);
            return;
        }

        const action = resolveTabKeyboardShortcutAction(event);
        if (!action) {
            return;
        }

        event.preventDefault();
        runTabKeyboardShortcutAction(action);
    }

    const stopTabKeyboardShortcutListener = useEventListener(
        typeof window !== 'undefined' ? window : undefined,
        'keydown',
        handleTabKeyboardShortcut,
        {capture: true},
    );
    const lifecycle: { isDisposed: boolean } = { isDisposed: false };
    let rendererReadyNotified = false;
    let desktopViewerWarmupHandle: IDesktopViewerWarmupHandle | null = null;

    function notifyRendererReadyAndScheduleViewerWarmup() {
        if (rendererReadyNotified) {
            return;
        }
        rendererReadyNotified = true;
        getWindowTabsCapability().notifyRendererReady();
        const profile = resolveStartupWorkProfile();
        desktopViewerWarmupHandle = scheduleDesktopViewerWarmup({
            isDesktopRuntime: shouldPreferDesktopPlatform(route.path),
            strategy: profile.desktopViewerWarmupStrategy,
        });
        void desktopViewerWarmupHandle?.completion.catch(error => BrowserLogger.warn(
            'tabs-shell',
            'Background viewer warmup failed',
            error,
        ));
    }

    // Recovery is best effort. The main process refuses a checkpoint it
    // cannot authorize and keeps it as evidence; a refused or failed restore
    // reports the lost session and lets startup continue.
    async function restoreStartupWorkspaceCheckpoint(windowTabsCapability: ReturnType<typeof getWindowTabsCapability>) {
        try {
            const workspaceCheckpoint = typeof windowTabsCapability.claimWorkspaceCheckpoint === 'function'
                ? await windowTabsCapability.claimWorkspaceCheckpoint()
                : null;
            if (lifecycle.isDisposed.valueOf()) {
                return;
            }
            if (workspaceCheckpoint) {
                traceRendererStartup('tabs shell restoring workspace checkpoint', {tabCount: workspaceCheckpoint.tabs.length});
                const failedCheckpointPaths = await restoreWorkspaceCheckpoint(workspaceCheckpoint, {
                    activeTabId,
                    documentSessions,
                    restoreGraph: restoreWorkspaceCheckpointGraph,
                    activateTab,
                });
                if (lifecycle.isDisposed.valueOf()) {
                    return;
                }
                if (failedCheckpointPaths.length === 0) {
                    await windowTabsCapability.acknowledgeWorkspaceCheckpoint();
                } else {
                    BrowserLogger.warn(
                        'tabs-shell',
                        'Workspace checkpoint restore was incomplete; keeping recovery evidence',
                        {failedPathCount: failedCheckpointPaths.length},
                    );
                }
            }
        } catch (error) {
            if (lifecycle.isDisposed.valueOf()) {
                return;
            }
            const failure = BrowserLogger.error('tabs-shell', 'Workspace checkpoint restore failed', error, {code: 'RENDERER_WORKSPACE_OPERATION_FAILED'});
            presentFailureToast({
                failure,
                title: t('errors.workspace.sessionRestoreTitle'),
                description: t('errors.workspace.sessionRestoreDescription'),
                // Startup can still be covered by its overlay; the notice
                // must outlast it.
                persistent: true,
            });
        }
    }

    onMounted(() => {
        lifecycle.isDisposed = false;
        const onMountedStart = performance.now();
        traceRendererStartup('tabs shell onMounted start');
        isStartupOpenClaimPending.value = true;
        traceRendererStartup('tabs shell initial tab available', {tabCount: tabs.value.length});

        if (typeof window !== 'undefined') {
            cleanupDirectOpenDelegate = registerDirectOpenAutomationDelegate(openPathInAppropriateTab);
            (window as Window & { __handleSave?: () => Promise<unknown> }).__handleSave = debugHandleSave;
            installAutomationTestApi();
        }

        void (async () => {
            const shouldWaitForDesktopBridge = shouldPreferDesktopPlatform(route.path);
            const bridgeReady = await waitForDesktopPlatformBridge({shouldWait: shouldWaitForDesktopBridge});
            if (lifecycle.isDisposed.valueOf()) {
                return;
            }
            traceRendererStartup('tabs shell platform bridge resolved', {
                bridgeReady,
                routePath: route.path,
                shouldWaitForDesktopBridge,
            });

            const windowTabsCapability = getWindowTabsCapability();
            const registeredMenuCleanups = registerTabsMenuBindings({
                documentMenu: getDocumentMenuCapability(),
                settings: getSettingsCapability(),
                updates: getUpdatesCapability(),
                djvu: getDjvuCapability(),
                windowTabs: windowTabsCapability,
            }, {
                activeWorkspace,
                activeTabId,
                createTab,
                handleCloseTab,
                handleFallbackToolbarOpenFile,
                openPathInAppropriateTab,
                openPathsInAppropriateTab,
                clearRecentFiles,
                loadRecentFiles,
                checkForUpdates,
                splitEditor,
                focusPane,
                moveActiveTab,
                copyActiveTab,
                handleWindowTabsAction,
                toggleAssistant,
            });
            if (lifecycle.isDisposed.valueOf()) {
                registeredMenuCleanups.forEach(cleanup => cleanup());
                return;
            }
            menuCleanups.push(...registeredMenuCleanups);
            traceRendererStartup('tabs shell menu bindings registered');

            await restoreStartupWorkspaceCheckpoint(windowTabsCapability);
            if (lifecycle.isDisposed.valueOf()) {
                return;
            }

            const startupExternalPaths = await windowTabsCapability.claimPendingExternalOpenPaths();
            if (lifecycle.isDisposed.valueOf()) {
                return;
            }
            dispatchStartupOpenClaimed(startupExternalPaths.length);
            if (startupExternalPaths.length > 0) {
                traceRendererStartup('tabs shell claimed startup external paths', {pathCount: startupExternalPaths.length});
                const targets = getWorkspaceViewerChunkTargetsForPaths(startupExternalPaths);
                const matchingWarmupTraceData = {
                    pathCount: startupExternalPaths.length,
                    targets,
                };
                traceRendererStartup('startup matching viewer warmup started', matchingWarmupTraceData);
                try {
                    await warmupDesktopViewerChunkForPaths({
                        isDesktopRuntime: shouldPreferDesktopPlatform(route.path),
                        paths: startupExternalPaths,
                    });
                } catch (error) {
                    BrowserLogger.warn('tabs-shell', 'Matching viewer warmup failed; opening without prefetch', error);
                }
                traceRendererStartup('startup matching viewer warmup settled', matchingWarmupTraceData);
                const failedPaths = await beginOpenPathsInAppropriateTab(startupExternalPaths);
                await windowTabsCapability.acknowledgePendingExternalOpenPaths(failedPaths);
                if (lifecycle.isDisposed.valueOf()) {
                    return;
                }
            }
            isStartupOpenClaimPending.value = false;
            await nextTick();
            if (lifecycle.isDisposed.valueOf()) {
                return;
            }
            traceRendererStartup('tabs shell dispatching app:rendererReady');
            notifyRendererReadyAndScheduleViewerWarmup();
        })().catch((error) => {
            if (lifecycle.isDisposed.valueOf()) {
                return;
            }
            const presentation = getOrCaptureRendererBootstrapFailure({
                error,
                key: 'workspace-startup',
                message: 'Renderer startup preparation failed',
                section: 'tabs-shell',
                title: t('errors.runtime.title'),
            });
            setFatalRuntimeError('startup', presentation);
            dispatchStartupOpenClaimed(0);
            isStartupOpenClaimPending.value = false;
            traceRendererStartup('tabs shell dispatching app:rendererReady');
            notifyRendererReadyAndScheduleViewerWarmup();
        });

        traceRendererStartup('tabs shell onMounted finished', {durationMs: Math.round(performance.now() - onMountedStart)});
    });

    onUnmounted(() => {
        lifecycle.isDisposed = true;
        desktopViewerWarmupHandle?.cancel();
        desktopViewerWarmupHandle = null;
        cleanupDirectOpenDelegate?.();
        cleanupDirectOpenDelegate = null;
        if (typeof window !== 'undefined' && (window as Window & { __handleSave?: unknown }).__handleSave === debugHandleSave) {
            delete (window as Window & { __handleSave?: () => Promise<unknown> }).__handleSave;
        }
        if (typeof window !== 'undefined' && window.__evbTestApi === installedTestApi) {
            delete window.__evbTestApi;
        }
        menuCleanups.forEach(cleanup => cleanup());
        menuCleanups.splice(0, menuCleanups.length);
        stopTabKeyboardShortcutListener();
    });
};
