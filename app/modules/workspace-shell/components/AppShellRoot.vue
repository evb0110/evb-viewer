<template>
    <div
        class="app-shell-root h-screen min-w-0 flex flex-col bg-[var(--app-window-bg)]"
        :class="{ 'is-zen-mode': isFullscreen }"
    >
        <div v-if="showBrowserInstallHint" class="browser-install-hint">
            <UIcon name="i-ph-download-simple" class="browser-install-icon" />
            <a
                :href="browserInstallUrl"
                target="_blank"
                rel="noreferrer"
                class="browser-install-link"
                @click="handleBrowserInstallHintClick"
            >
                {{ t('webApp.installDesktop') }}
                <UIcon name="i-ph-arrow-up-right" class="browser-install-link-icon" />
            </a>
            <span class="browser-install-divider" />
            <button
                type="button"
                class="browser-install-dismiss"
                :aria-label="t('webApp.dismissInstallDesktop')"
                @click="dismissBrowserInstallHint('manual')"
            >
                <UIcon name="i-ph-x" class="browser-install-dismiss-icon" />
            </button>
        </div>
        <div v-show="!activeToolPage" class="editor-global-toolbar-shell">
            <ShellWorkspaceToolbar
                v-show="showShellToolbar"
                :snapshot="shellToolbarSnapshot"
                :has-pdf="shellToolbarHasPdf"
                :ocr-document-revision="shellToolbarOcrDocumentRevision"
                :ocr-popup-open="shellToolbarOcrPopupOpen"
                :ocr-working-copy-path="shellToolbarOcrWorkingCopyPath"
                :zoom-dropdown-open="shellToolbarZoomDropdownOpen"
                :page-dropdown-open="shellToolbarPageDropdownOpen"
                :overflow-menu-open="shellToolbarOverflowMenuOpen"
                :app-menu-open="shellToolbarAppMenuOpen"
                :is-fullscreen="isFullscreen"
                :fullscreen-supported="fullscreenSupported"
                v-on="fallbackToolbarCommandListeners"
                @update:ocr-popup-open="shellToolbarOcrPopupOpen = $event"
                @update:zoom-dropdown-open="shellToolbarZoomDropdownOpen = $event"
                @update:page-dropdown-open="shellToolbarPageDropdownOpen = $event"
                @update:overflow-menu-open="shellToolbarOverflowMenuOpen = $event"
                @update:app-menu-open="shellToolbarAppMenuOpen = $event"
                @update:zoom="shellToolbarZoom = $event"
                @update:effective-zoom="shellToolbarEffectiveZoom = $event"
                @update:zoom-mode="shellToolbarZoomMode = $event"
                @update:fit-mode="shellToolbarFitMode = $event"
                @update:view-mode="shellToolbarViewMode = $event"
                @open-file="handleFallbackToolbarOpenFile"
                @open-settings="openSettingsPage"
                @combine-files="openCombinePage"
                @toggle-fullscreen="handleToggleFullscreen"
                @set-view-mode="handleShellToolbarOverflowSetViewMode"
            />
            <div
                v-show="!showShellToolbar"
                id="editor-global-toolbar-host"
                ref="globalToolbarHostRef"
                class="editor-global-toolbar-host"
            />
        </div>

        <div v-show="!activeToolPage" class="workspace-main-shell">
            <EditorPanesHost
                :layout="layout"
                :panes="panes"
                :tabs="tabs"
                :active-pane-id="activePaneId"
                :is-tab-transition-busy="isTabTransitionBusy"
                :presentation-fallback-tab-id="presentationFallbackTabId"
                :tab-context-availability-by-pane="tabContextAvailabilityByPane"
                :start-section-by-tab-id="startSectionByTabId"
                :tab-lifecycle-by-id="tabLifecycleById"
                :document-sessions-by-tab-id="documentSessionsByTabId"
                :zen-mode="isFullscreen"
                :zen-active-tab-id="activeTabId"
                :is-fullscreen="isFullscreen"
                :fullscreen-supported="fullscreenSupported"
                :is-workspace-layout-resizing="isWorkspaceLayoutResizing"
                @activate-pane="activatePane"
                @activate-tab="activateTab"
                @close-tab="handleCloseTab"
                @new-tab="createTabInPane"
                @reorder-tab="moveTabWithinPane"
                @move-tab-direction="handleTabMoveDirection"
                @tab-context-command="handleTabContextCommand"
                @update-tab-start-section="setTabStartSection"
                @open-in-new-tab="handleOpenInNewTab"
                @request-close-tab="handleCloseTab"
                @open-settings="openSettingsPage"
                @open-combine="openCombinePage"
                @toggle-fullscreen="handleToggleFullscreen"
                @update-split-ratio="setSplitRatio"
                @update-layout-resizing="isEditorPanesResizing = $event"
            />
            <AgentAssistantPanel
                v-if="assistantPanelEnabled && assistantPanelOpen && !isFullscreen"
                :chat-scope="assistantChatScope"
                :is-chat-scope-pending="assistantChatScopePending"
                :has-active-document="assistantHasActiveDocument"
                :has-any-document="assistantHasAnyDocument"
                :active-document-name="assistantActiveDocumentName"
                :width="assistantPanelWidth"
                :is-resizing="isAssistantPanelResizing"
                @resize-start="startAssistantPanelResize"
                @close="assistantPanelOpen = false"
            />
        </div>

        <CombinePdfPage
            v-if="activeToolPage === 'combine'"
            :open-result="handleCombineOpenResult"
            @close="closeToolPage"
        />

        <div v-show="!activeToolPage" id="editor-global-status-host" class="editor-global-status-host" />
        <DirtyTabCloseDialog
            :open="dirtyTabCloseDialogOpen"
            :mode="dirtyTabCloseDialogMode"
            :target-name="dirtyTabCloseTargetName"
            @update:open="dirtyTabCloseDialogOpen = $event"
            @discard="resolveDirtyTabCloseDialog('discard')"
            @save="resolveDirtyTabCloseDialog('save')"
        />
        <DocumentPasswordDialog />
        <UnencryptedSaveDialog
            :open="unencryptedSaveNoticeOpen"
            :dont-show-again="unencryptedSaveNoticeDontShowAgain"
            @update:open="handleUnencryptedSaveNoticeOpenUpdate"
            @update:dont-show-again="handleUnencryptedSaveNoticeDontShowAgainUpdate"
            @continue="confirmUnencryptedSaveNotice"
            @cancel="cancelUnencryptedSaveNotice"
        />
        <AppUpdatesDialog
            :open="updatesDialog.open"
            :phase="updatesDialog.phase"
            :title="updatesDialogBindings.updatesDialogTitle"
            :description="updatesDialogBindings.updatesDialogDescription"
            :progress-percent="updatesDialog.phase === 'downloading' ? updatesDialog.percent : null"
            :available="updatesDialog.kind === 'available'"
            :ready="updatesDialog.kind === 'ready'"
            :failure="updatesDialogBindings.updatesDialogFailurePresentation"
            @update:open="updatesDialog.open = $event"
            @defer="updatesDialogBindings.handleDeferUpdate"
            @download="updatesDialogBindings.handleDownloadUpdate"
            @skip="updatesDialogBindings.handleSkipUpdate"
            @install="updatesDialogBindings.handleInstallUpdate"
        />
    </div>
</template>
<script setup lang="ts">
import type { IWorkspaceOpenFailure } from '@app/types/workspaceExpose';
import { useFailureToast } from '@app/composables/useFailureToast';
import { useEventListener } from '@vueuse/core';
import { logicNot } from '@vueuse/math';
import { guardAsync } from '@app/utils/asyncGuard';
import { createDisposalFlag } from '@app/utils/createDisposalFlag';
import { resolveAppWindowTitle } from '@app/utils/appWindowTitle';
import { traceRendererStartup } from '@app/utils/traceRendererStartup';
import { syncBrowserWindowTitle } from '@app/platform/browserWindowTabs';
import { getWindowTabsCapability } from '@app/utils/platformWindowTabs';
import AppUpdatesDialog from '@app/modules/workspace-shell/components/AppUpdatesDialog.vue';
import DirtyTabCloseDialog from '@app/modules/workspace-shell/components/DirtyTabCloseDialog.vue';
import DocumentPasswordDialog from '@app/modules/workspace-shell/components/DocumentPasswordDialog.vue';
import UnencryptedSaveDialog from '@app/modules/workspace-shell/components/UnencryptedSaveDialog.vue';
import EditorPanesHost from '@app/modules/workspace-shell/components/EditorPanesHost.vue';
import ShellWorkspaceToolbar from '@app/modules/workspace-shell/components/ShellWorkspaceToolbar.vue';
import { useAppShellDirectionalTabs } from '@app/modules/workspace-shell/composables/useAppShellDirectionalTabs';
import { useAppShellLifecycle } from '@app/modules/workspace-shell/composables/useAppShellLifecycle';
import { useAppShellTabLifecycle } from '@app/modules/workspace-shell/composables/useAppShellTabLifecycle';
import { useAppShellUpdatesDialog } from '@app/modules/workspace-shell/composables/useAppShellUpdatesDialog';
import { useAppShellWorkspaceRouting } from '@app/modules/workspace-shell/composables/useAppShellWorkspaceRouting';
import { useExternalFileDrop } from '@app/modules/workspace-shell/composables/useExternalFileDrop';
import { useDirtyTabCloseDialog } from '@app/modules/workspace-shell/composables/useDirtyTabCloseDialog';
import { useNativeWindowCloseHandshake } from '@app/modules/workspace-shell/composables/useNativeWindowCloseHandshake';
import { useShellWorkspaceToolbar } from '@app/modules/workspace-shell/composables/useShellWorkspaceToolbar';
import { useAppShellMenuSync } from '@app/modules/workspace-shell/composables/useMenuSync';
import { useWorkspaceShellState } from '@app/modules/workspace-shell/composables/useWorkspaceShellState';
import { useWorkspaceDocumentSessions } from '@app/modules/workspace-shell/document-sessions/useWorkspaceDocumentSessions';
import {
    describeTabDocument,
    snapshotOccupiesTab,
} from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import { useWorkspaceToolbarContentPresence } from '@app/modules/workspace-shell/composables/useWorkspaceToolbarContentPresence';
import { useTabsShellBindings } from '@app/modules/workspace-shell/composables/useTabsShellBindings';
import { useAgentWorkspaceSnapshot } from '@app/modules/workspace-shell/composables/useAgentWorkspaceSnapshot';
import { useAssistantPanelResize } from '@app/modules/workspace-shell/composables/useAssistantPanelResize';
import { useAppUpdates } from '@app/composables/useAppUpdates';
import { useRuntimeEnvironment } from '@app/composables/useRuntimeEnvironment';
import { useEditorPanesManager } from '@app/modules/workspace-shell/composables/useEditorPanesManager';
import { useWorkspaceRestoreTracker } from '@app/modules/workspace-shell/composables/useWorkspaceRestoreTracker';
import { installAppShellE2EHooks } from '@app/modules/workspace-shell/automation/installAppShellE2EHooks';
import { isAutomationSession } from '@app/utils/isAutomationSession';
import { useWorkspaceSplitCache } from '@app/modules/workspace-shell/composables/useWorkspaceSplitCache';
import { useAppShellResilience } from '@app/modules/workspace-shell/composables/useAppShellResilience';
import { useWorkspaceMemoryPressureMonitor } from '@app/modules/workspace-shell/composables/useWorkspaceMemoryPressureMonitor';
import { useUnencryptedSaveNotice } from '@app/modules/workspace-shell/composables/useUnencryptedSaveNotice';
import { useAppShellToolPages } from '@app/modules/workspace-shell/composables/useAppShellToolPages';
import { useWindowTabTransfers } from '@app/modules/workspace-shell/composables/useWindowTabTransfers';
import { useBrowserInstallHint } from '@app/modules/workspace-shell/composables/useBrowserInstallHint';
import { useBrowserDirtyUnloadGuard } from '@app/modules/workspace-shell/composables/useShutdownSaveFlushReporting';
import { useDirectOpenAutomationDispatcherShell } from '@app/modules/workspace-shell/automation/directOpenAutomationDispatcher';
import {
    flushScanCleanupDocumentPreferencesStore,
    flushScanCleanupPreferencesStore,
} from '@app/modules/scan-cleanup/public/runtime';
import { resolveTabLifecycleStates } from '@app/modules/workspace-shell/tabs/resolveTabLifecycleStates';
import { createFallbackToolbarCommandListeners } from '@app/modules/workspace-shell/expose/createFallbackToolbarCommandListeners';
import { useScanCleanupRunCoordinator } from '@app/modules/workspace-shell/composables/useScanCleanupRunCoordinator';
import { pruneStartSectionByTabId } from '@app/modules/workspace-shell/tabs/pruneStartSectionByTabId';
import type { TPdfViewMode } from '@contracts/shared';
import type { IAgentAssistantChatScope } from '@contracts/agent';
import type { TStartSection } from '@app/types/startSection';
import type { IHostZenModeState } from '@contracts/hostPlatformFeature';
import { parseTabId } from '@contracts/windowTabs';
import { getHostCapability } from '@app/utils/getHostCapability';
import { waitForDesktopPlatformBridge } from '@app/utils/platform';
import { getDocumentWindowCapability } from '@app/utils/platformDocuments';
import { resolveDocumentRefBackend } from '@app/utils/documentRef';
traceRendererStartup('index.vue script setup start');
useDirectOpenAutomationDispatcherShell();
// User-initiated surfaces load on first open; split policy: warmupDesktopViewerChunks.ts.
const AgentAssistantPanel = defineAsyncComponent(() =>
    import('@app/modules/agent-panel/public/component-exports/agentAssistantPanel').then(module => module.AgentAssistantPanel));
const CombinePdfPage = defineAsyncComponent(() => import('@app/components/combine/CombinePdfPage.vue'));
const editorPanesManager = useEditorPanesManager({isTabEmpty: tabId => isTabEmpty(tabId)});
const {
    panes,
    tabs,
    layout,
    activePaneId,
    activeTabId,
    restoreWorkspaceCheckpointGraph,
    ensureAtLeastOneTab,
    getPaneById,
    getTabById,
    getPaneByTabId,
    activatePane,
    activateTab: activateEditorTab,
    createTab,
    closeTab,
    moveTabWithinPane,
    splitPane,
    closePane,
    setSplitRatio,
    focusPane,
    findDirectionalPane,
    moveTabToPane,
} = editorPanesManager;
ensureAtLeastOneTab();
const { t } = useTypedI18n();
const toast = useToast();
const { presentFailureToast } = useFailureToast();

// An open that failed in a tab that was then removed, such as a new tab for a
// dropped file, has no Start page left to show why; tell the user once here.
function reportOpenFailure(fileName: string | null, failure: IWorkspaceOpenFailure) {
    const description = fileName ? `${fileName}: ${failure.message}` : failure.message;
    if (failure.failure) {
        presentFailureToast({
            failure: failure.failure,
            title: t('errors.file.open'),
            description,
        });
        return;
    }
    toast.add({
        color: 'neutral',
        title: t('errors.file.open'),
        description,
    });
}
const {
    settings: appSettings,
    save: saveAppSettings,
    updateSetting,
} = useSettings();

async function flushDesktopSettings() {
    if (!await saveAppSettings()) {
        return false;
    }
    try {
        await flushScanCleanupDocumentPreferencesStore();
        await flushScanCleanupPreferencesStore();
        return true;
    } catch {
        return false;
    }
}
const {
    unencryptedSaveNoticeOpen,
    unencryptedSaveNoticeDontShowAgain,
    confirmUnencryptedSaveNotice,
    cancelUnencryptedSaveNotice,
} = useUnencryptedSaveNotice();

function handleUnencryptedSaveNoticeOpenUpdate(open: boolean) {
    if (!open) {
        cancelUnencryptedSaveNotice();
    }
}

function handleUnencryptedSaveNoticeDontShowAgainUpdate(value: boolean) {
    unencryptedSaveNoticeDontShowAgain.value = value;
}
const activeToolPage = ref<'combine' | null>(null);
const startSectionByTabId = ref<Record<string, TStartSection>>({});
const isStartupOpenClaimPending = ref(true);
const {
    isBrowserRuntime,
    isDesktopRuntime,
} = useRuntimeEnvironment();
const {
    browserInstallUrl,
    dismissBrowserInstallHint,
    handleBrowserInstallHintClick,
    showBrowserInstallHint,
} = useBrowserInstallHint({isBrowserRuntime});
const shouldWaitForDesktopBridge = logicNot(isBrowserRuntime);
const isFullscreen = ref(false);
const assistantPanel = useAssistantPanel();
const assistantPanelOpen = assistantPanel.isOpen;
const {
    panelWidth: assistantPanelWidth,
    isResizingPanel: isAssistantPanelResizing,
    startPanelResize: startAssistantPanelResize,
} = useAssistantPanelResize();
const isEditorPanesResizing = ref(false);
const isWorkspaceLayoutResizing = computed(() => isAssistantPanelResizing.value || isEditorPanesResizing.value);
const fullscreenSupported = ref(true);
let zenModeRequestInFlight = false;
const workspaceSplitCache = useWorkspaceSplitCache();
const workspaceMemoryBudget = useWorkspaceMemoryPressureMonitor();
const tabActivationOrder = ref<string[]>([]);
watch(activeTabId, (tabId) => {
    if (!tabId) {
        return;
    }
    tabActivationOrder.value = [
        tabId,
        ...tabActivationOrder.value.filter(candidate => candidate !== tabId),
    ];
}, { immediate: true });
watch(tabs, (nextTabs) => {
    const tabIds = new Set(nextTabs.map(tab => tab.id));
    tabActivationOrder.value = tabActivationOrder.value.filter(tabId => tabIds.has(tabId));
    const nextStartSectionByTabId = pruneStartSectionByTabId(startSectionByTabId.value, nextTabs);
    if (nextStartSectionByTabId !== startSectionByTabId.value) {
        startSectionByTabId.value = nextStartSectionByTabId;
    }
});
const tabLifecycleById = computed(() => Object.fromEntries(
    resolveTabLifecycleStates({
        activationOrder: tabActivationOrder.value,
        panes: panes.value,
        policy: appSettings.value.tabMemoryPolicy,
        tabs: tabs.value,
        dirtyTabIds: new Set(Object.values(documentSessionsByTabId.value)
            .filter(session => session.snapshot.value.dirty)
            .map(session => session.tabId)),
        tier: workspaceMemoryBudget.value.deviceTier,
        targetWarmViewers: workspaceMemoryBudget.value.targetWarmViewers,
    }).map(state => [
        state.tabId,
        state,
    ]),
));
const workspaceRestoreTracker = useWorkspaceRestoreTracker();
const {
    checkForUpdates,
    closeDialog: closeUpdatesDialog,
    deferUpdate,
    dialog: updatesDialog,
    dialogVersion: updatesDialogVersion,
    downloadUpdate,
    ensureInitialized: ensureUpdatesInitialized,
    installUpdateNow,
    skipUpdateVersion,
} = useAppUpdates();
const documentSessions = useWorkspaceDocumentSessions({
    activeTabId,
    tabs,
});
const {
    activeDocumentSession,
    activeWorkspace,
    documentSessionsByTabId,
    getSession: getDocumentSession,
    workspaceRefs,
} = documentSessions;
const {
    dirtyTabCloseDialogOpen,
    dirtyTabCloseDialogMode,
    dirtyTabCloseTargetName,
    requestDirtyTabCloseConfirmation,
    requestDirtyWindowCloseConfirmation,
    resolveDirtyTabCloseDialog,
} = useDirtyTabCloseDialog({getSession: getDocumentSession});
useNativeWindowCloseHandshake({
    documentSessionsByTabId,
    flushSettings: flushDesktopSettings,
    requestDirtyCloseConfirmation: requestDirtyWindowCloseConfirmation,
});
useBrowserDirtyUnloadGuard(() => isBrowserRuntime.value && Object.values(documentSessionsByTabId.value)
    .some(session => session.snapshot.value.dirty));
const globalToolbarHostRef = ref<HTMLElement | null>(null);
const presentationFallbackTabId = ref<string | null>(null);
const { hasWorkspaceToolbarContent } = useWorkspaceToolbarContentPresence(globalToolbarHostRef);
function activateTab(paneId: string, tabId: string) {
    activateEditorTab(paneId, tabId);
}
const activeTabDocument = computed(() => {
    const session = activeDocumentSession.value;
    return session ? describeTabDocument(session.snapshot.value) : null;
});
const shellState = useWorkspaceShellState({
    activeDocumentSession,
    tabs,
});
const {
    isTabTransitionBusy,
    enqueueTabTransition,
    removeTabFromState,
    cleanupEmptyPanes,
    isSingletonPlaceholderCloseBlocked,
    resolveTabForAction,
    closeTabInState,
    handoffActiveTabBeforeClose,
    handleCloseTab,
} = useAppShellTabLifecycle({
    panes,
    tabs,
    activePaneId,
    activeTabId,
    documentSessionsByTabId,
    workspaceSplitCache,
    workspaceRestoreTracker,
    getPaneById,
    getTabById,
    getPaneByTabId: (tabId) => (tabId ? getPaneByTabId(tabId) : null),
    activatePane,
    activateTab,
    closeTab,
    closePane,
    requestDirtyTabCloseConfirmation,
});
const {
    listeners: fallbackToolbarCommandListeners,
    run: runFallbackWorkspaceCommand,
} = createFallbackToolbarCommandListeners(activeWorkspace);
function activeWorkspaceHasDocument() {
    return shellState.activeWorkspaceHasDocument.value;
}
function handleToggleFullscreen() {
    if (!fullscreenSupported.value || (!isFullscreen.value && !activeWorkspaceHasDocument())) {
        return;
    }
    setZenMode(!isFullscreen.value);
}
function applyZenModeState(state: IHostZenModeState) {
    fullscreenSupported.value = state.supported;
    isFullscreen.value = state.active;
}

function setZenMode(active: boolean) {
    if (zenModeRequestInFlight || active === isFullscreen.value) {
        return;
    }

    const previousActive = isFullscreen.value;
    if (active) {
        isFullscreen.value = true;
    }
    zenModeRequestInFlight = true;

    guardAsync(
        getHostCapability().setZenMode(active)
            .then(applyZenModeState)
            .catch((error: unknown) => {
                isFullscreen.value = previousActive;
                throw error;
            })
            .finally(() => {
                zenModeRequestInFlight = false;
            }),
        {
            category: 'user-visible-operation',
            scope: 'shell',
            message: 'Failed to toggle zen mode',
        },
    );
}

useEventListener(window, 'keydown', (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || !isFullscreen.value) {
        return;
    }

    event.preventDefault();
    event.stopPropagation();
    setZenMode(false);
}, { capture: true });

let unsubscribeZenModeChange: (() => void) | null = null;
const shellRootLifecycle = createDisposalFlag();
// Keep hook disposal paired with the component instance during dev HMR.
let cleanupAppShellE2EHooks: (() => void) | null = null;

onMounted(() => {
    guardAsync(
        (async () => {
            await waitForDesktopPlatformBridge({ shouldWait: !isBrowserRuntime.value });
            if (shellRootLifecycle.isDisposed()) {
                return;
            }
            await getHostCapability().getZenModeState().then(applyZenModeState);
            if (shellRootLifecycle.isDisposed()) {
                return;
            }
            const unsubscribe = getHostCapability().onZenModeChange(applyZenModeState);
            if (shellRootLifecycle.isDisposed()) {
                unsubscribe();
                return;
            }
            unsubscribeZenModeChange = unsubscribe;
        })(),
        {
            category: 'background-diagnostic',
            scope: 'shell',
            message: 'Failed to read zen mode state',
        },
    );

    if (isAutomationSession()) {
        cleanupAppShellE2EHooks = installAppShellE2EHooks({
            copyActiveTab,
            setTabMemoryPolicy: (policy) => {
                updateSetting('tabMemoryPolicy', policy);
            },
            splitEditor,
            splitEditorEmpty,
        });
    }
});

onUnmounted(() => {
    shellRootLifecycle.dispose();
    unsubscribeZenModeChange?.();
    unsubscribeZenModeChange = null;
    cleanupAppShellE2EHooks?.();
    cleanupAppShellE2EHooks = null;
});

const {
    shellToolbarAppMenuOpen,
    shellToolbarEffectiveZoom,
    shellToolbarFitMode,
    shellToolbarHasPdf,
    shellToolbarOcrDocumentRevision,
    shellToolbarOcrPopupOpen,
    shellToolbarOcrWorkingCopyPath,
    shellToolbarOverflowMenuOpen,
    shellToolbarPageDropdownOpen,
    shellToolbarSnapshot,
    shellToolbarViewMode,
    shellToolbarZoom,
    shellToolbarZoomMode,
    shellToolbarZoomDropdownOpen,
    handleShellToolbarOverflowSetViewMode: handleShellToolbarOverflowSetViewModeInternal,
    showShellToolbar,
} = useShellWorkspaceToolbar({
    activeDocumentSession,
    hasWorkspaceToolbarContent,
});

function handleShellToolbarOverflowSetViewMode(mode: TPdfViewMode) {
    handleShellToolbarOverflowSetViewModeInternal(mode, runFallbackWorkspaceCommand);
}
const updatesDialogBindings = reactive(useAppShellUpdatesDialog({
    updatesDialog,
    updatesDialogVersion,
    closeUpdatesDialog,
    deferUpdate,
    downloadUpdate,
    skipUpdateVersion,
    installUpdateNow,
}));

const {
    captureWorkspacePayload,
    restoreWorkspacePayload,
    handleIncomingTabTransfer,
    moveTabToNewWindow,
    moveTabToWindow,
    mergeWindowInto,
} = useWindowTabTransfers({
    activePaneId,
    panes,
    tabs,
    layout,
    createTab,
    getPaneById,
    getTabById,
    getPaneByTabId,
    activatePane,
    activateTab,
    removeTabFromState,
    cleanupEmptyPanes,
    closeTabInState,
    documentSessions,
    workspaceRestoreTracker,
    handleCloseTab,
    handoffActiveTabBeforeClose,
});
const {
    createTabInPane: createTabInPaneFromRouting,
    handleFallbackToolbarOpenFile,
    handleOpenInNewTab,
    openResultInAppropriateTab,
    openPathInAppropriateTab,
    openPathsInAppropriateTab,
    beginOpenPathsInAppropriateTab,
    handleWindowTabsAction,
} = useAppShellWorkspaceRouting({
    activePaneId,
    activeTabId,
    presentationFallbackTabId,
    documentSessions,
    tabLifecycleById,
    createTab,
    getTabById,
    removeTabFromState,
    resolveTabForAction,
    handleCloseTab,
    moveTabToNewWindow,
    moveTabToWindow,
    mergeWindowInto,
    reportOpenFailure,
});
useScanCleanupRunCoordinator(
    activeWorkspace,
    handleOpenInNewTab,
    isStartupOpenClaimPending,
    t,
    documentSessionsByTabId,
    activateTabById,
);
function createTabInPane(paneId: string) {
    createTabInPaneFromRouting(paneId);
}
function setTabStartSection(tabId: string, section: TStartSection) {
    startSectionByTabId.value = {
        ...startSectionByTabId.value,
        [tabId]: section,
    };
}

function isTabEmpty(tabId: string) {
    const session = getDocumentSession(tabId);
    return !session || !snapshotOccupiesTab(session.snapshot.value);
}

const assistantHasActiveDocument = computed(() => (activeTabId.value ? !isTabEmpty(activeTabId.value) : false));
const assistantHasAnyDocument = computed(() => tabs.value.some(tab => !isTabEmpty(tab.id)));
const assistantActiveDocumentName = computed(() => assistantHasActiveDocument.value
    ? activeTabDocument.value?.fileName ?? null
    : null);
const assistantChatScopePending = computed(() => {
    const phase = activeDocumentSession.value?.snapshot.value.phase;
    return phase === 'opening' || phase === 'closing';
});
const assistantChatScope = computed<IAgentAssistantChatScope | null>(() => {
    const session = activeDocumentSession.value;
    const tabDocument = activeTabDocument.value;
    if (!session || !tabDocument || !assistantHasActiveDocument.value) {
        return null;
    }

    const tabId = parseTabId(session.tabId);
    if (tabId === null) {
        return null;
    }
    const identity = session.snapshot.value.identity;
    const documentSessionKey = identity.documentSessionKey;
    const documentInstanceId = identity.documentInstanceId;
    const documentRef = tabDocument.originalPath;
    const documentBackend = resolveDocumentRefBackend(documentRef);
    const documentIdentity = identity.revisionInfo;
    const commandTarget = session.createCommandTarget();
    const title = tabDocument.fileName ?? documentRef ?? null;
    return {
        kind: 'document',
        // Saved chats are looked up by this key after a relaunch, and every
        // open mints a new document session key, so the key follows the file.
        key: documentRef
            ? `document:${documentBackend ?? 'unknown'}:${documentRef}`
            : `tab:${tabId}`,
        title,
        tabId,
        ...(documentSessionKey ? { documentSessionKey } : {}),
        ...(documentInstanceId ? { documentInstanceId } : {}),
        ...(documentRef ? { documentRef } : {}),
        ...(documentBackend === undefined ? {} : {documentBackend}),
        ...(documentIdentity ? { documentIdentity } : {}),
        commandTarget,
    };
});
const assistantPanelEnabled = computed(() => isDesktopRuntime.value && appSettings.value.assistantPanelEnabled);
watch(assistantPanelEnabled, (enabled) => {
    if (!enabled) {
        assistantPanelOpen.value = false;
    }
});
watchEffect(() => {
    assistantPanel.isEnabled.value = assistantPanelEnabled.value && !isFullscreen.value;
    assistantPanel.hasActiveDocument.value = assistantHasActiveDocument.value;
});
function findEmptyTab() {
    if (activeTabId.value && isTabEmpty(activeTabId.value)) {
        return getTabById(activeTabId.value);
    }

    return tabs.value.find(tab => isTabEmpty(tab.id)) ?? null;
}
function activateTabById(tabId: string) {
    const pane = getPaneByTabId(tabId);
    if (!pane) {
        return;
    }

    activateTab(pane.paneId, tabId);
}

const {
    recentFiles,
    isResolved: recentFilesResolved,
    loadRecentFiles,
    clearRecentFiles,
} = useRecentFiles();

useAgentWorkspaceSnapshot({
    panes,
    tabs,
    layout,
    activePaneId,
    activeTabId,
    recentFiles,
    recentFilesResolved,
    documentSessionsByTabId,
    shouldWaitForDesktopBridge: () => shouldWaitForDesktopBridge.value,
    getPaneByTabId,
    activateTab,
});

useAppShellResilience({
    enabled: computed(() => isDesktopRuntime.value && !isStartupOpenClaimPending.value),
    browserEnabled: computed(() => isBrowserRuntime.value && !isStartupOpenClaimPending.value),
    editorPanesManager,
    documentSessionsByTabId,
});

const {
    closeToolPage,
    handleCombineOpenResult,
    openCombinePage,
    openSettingsPage,
} = useAppShellToolPages({
    activePaneId,
    activeToolPage,
    activateTabById,
    createTab,
    findEmptyTab,
    openResultInAppropriateTab,
    setTabStartSection,
});
const {
    tabContextAvailabilityByPane,
    splitEditor,
    splitEditorEmpty,
    focusEditorPane,
    moveActiveTab,
    copyActiveTab,
    handleTabContextCommand,
    handleTabMoveDirection,
    cleanup: cleanupDirectionalTabs,
} = useAppShellDirectionalTabs({
    activePaneId,
    panes,
    tabs,
    documentSessionsByTabId,
    isTabTransitionBusy,
    getPaneById,
    getTabById,
    findDirectionalPane,
    focusPane,
    splitPane,
    moveTabToPane,
    createTab,
    activatePane,
    activateTab,
    removeTabFromState,
    cleanupEmptyPanes,
    workspaceSplitCache,
    isSingletonPlaceholderCloseBlocked,
    enqueueTabTransition,
    setWorkspaceLayoutResizing: value => { isEditorPanesResizing.value = value; },
    captureWorkspacePayload,
    restoreWorkspacePayload,
    moveTabToNewWindow,
    moveTabToWindow,
    handleCloseTab,
});

useAppShellMenuSync({
    activeDocumentSession,
    activePaneId,
    assistantPanelEnabled,
    shellState,
    tabContextAvailabilityByPane,
    tabs,
});

const { cleanup: cleanupExternalFileDrop } = useExternalFileDrop({
    openPathsInAppropriateTab,
    isEnabled: computed(() => activeToolPage.value === null),
});

const windowTitle = computed(() => resolveAppWindowTitle({
    appTitle: t('app.title'),
    webTitle: t('app.webTitle'),
    fileName: activeTabDocument.value?.fileName ?? null,
    isBrowserRuntime: isBrowserRuntime.value,
}));

let windowTitleSyncGeneration = 0;
watch(windowTitle, (nextTitle) => {
    if (!import.meta.client) {
        return;
    }

    if (isBrowserRuntime.value) {
        if (typeof document === 'undefined' || document.title === nextTitle) {
            return;
        }

        document.title = nextTitle;
        syncBrowserWindowTitle();
        return;
    }

    const generation = ++windowTitleSyncGeneration;
    guardAsync((async () => {
        await waitForDesktopPlatformBridge({ shouldWait: true });
        if (generation !== windowTitleSyncGeneration || nextTitle !== windowTitle.value) {
            return;
        }
        await getDocumentWindowCapability().setWindowTitle(nextTitle);
    })(), {
        category: 'background-diagnostic',
        scope: 'window-title',
        message: 'Failed to sync window title',
    });
}, { immediate: true });

useTabsShellBindings({
    tabs,
    workspaceRefs,
    activeTabId,
    activeWorkspace,
    createTab: () => {
        return createTab({ activate: true });
    },
    activateTab: (tabId) => {
        const pane = getPaneByTabId(tabId);
        if (pane) {
            activateTab(pane.paneId, tabId);
        }
    },
    handleCloseTab: async (tabId) => {
        const pane = getPaneByTabId(tabId);
        if (!pane) {
            return;
        }
        await handleCloseTab(pane.paneId, tabId);
    },
    handleFallbackToolbarOpenFile,
    openPathInAppropriateTab,
    openPathsInAppropriateTab,
    beginOpenPathsInAppropriateTab,
    restoreWorkspaceCheckpointGraph,
    documentSessions,
    transferActiveTabToWindow: async (windowId) => {
        const tabDocument = activeTabDocument.value;
        const workspace = activeWorkspace.value;
        if (!tabDocument || !workspace) {
            return {
                success: false,
                error: 'No active workspace is available for browser transfer acceptance.',
            };
        }
        const payload = await workspace.captureSplitPayload();
        return getWindowTabsCapability().transfer({
            target: {
                kind: 'window',
                windowId,
            },
            tab: {
                fileName: tabDocument.fileName,
                originalPath: tabDocument.originalPath,
                isDirty: tabDocument.isDirty,
                isDjvu: tabDocument.isDjvu,
            },
            payload,
        });
    },
    clearRecentFiles,
    loadRecentFiles,
    isStartupOpenClaimPending,
    checkForUpdates,
    splitEditor,
    focusPane: focusEditorPane,
    moveActiveTab,
    copyActiveTab,
    handleWindowTabsAction,
    toggleAssistant: () => assistantPanel.toggle(),
});
traceRendererStartup('index.vue setup wiring complete');
useAppShellLifecycle({
    dirtyTabCloseDialogOpen,
    updatesDialogOpen: computed(() => updatesDialog.value.open),
    cleanupEmptyPanes,
    ensureUpdatesInitialized: async () => {
        await ensureUpdatesInitialized();
    },
    handleIncomingTabTransfer,
    cleanupDirectionalTabs,
    cleanupExternalFileDrop,
    resolveDirtyTabCloseDialog,
    closeUpdatesDialog,
});
</script>
<style scoped src="./AppShellRoot.css"></style>
