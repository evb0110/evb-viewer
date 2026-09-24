import type {
    ComputedRef,
    Ref,
} from 'vue';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TSplitPayload } from '@contracts/windowTabs';
import { parseTabId } from '@contracts/windowTabs';
import type {
    IEditorPaneState,
    TPaneDirection,
} from '@contracts/editorPanes';
import type { ITab } from '@app/types/tabs';
import type {
    ITabContextAvailability,
    TDirectionalCommandAvailability,
    TDirectionalTabContextCommand,
    TTabContextCommand,
} from '@app/types/tabContextMenu';
import { hasElectronAPI } from '@app/utils/platform';
import { isBrowserDocumentRef } from '@app/utils/documentRef';
import { getDocumentWindowCapability } from '@app/utils/platformDocuments';
import { waitForVisualFrames } from '@app/utils/asyncHelpers';
import type { IWorkspaceSplitCacheLike } from '@app/modules/workspace-shell/composables/workspaceSplitTypes';
import type { IWorkspaceDocumentController } from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';

const DIRECTION_ORDER = [
    'left',
    'right',
    'up',
    'down',
] as const satisfies readonly TPaneDirection[];

interface IUseAppShellDirectionalTabsOptions {
    activePaneId: Ref<string | null>;
    panes: Ref<IEditorPaneState[]>;
    tabs: Ref<ITab[]>;
    documentSessionsByTabId: Ref<Record<string, IWorkspaceDocumentController>>;
    isTabTransitionBusy: ComputedRef<boolean>;
    getPaneById: (paneId: string | null | undefined) => IEditorPaneState | null;
    getTabById: (tabId: string | null | undefined) => ITab | null;
    findDirectionalPane: (sourcePaneId: string, direction: TPaneDirection, wrap?: boolean) => IEditorPaneState | null;
    focusPane: (direction: TPaneDirection, wrap?: boolean) => string | null;
    splitPane: (sourcePaneId: string, direction: TPaneDirection) => string | null;
    moveTabToPane: (
        tabId: string,
        targetPaneId: string,
        activate?: boolean,
        targetIndex?: number | null,
    ) => boolean;
    createTab: (options: {
        paneId?: string | null;
        activate?: boolean;
    }) => ITab;
    activatePane: (paneId: string) => void;
    activateTab: (paneId: string, tabId: string) => void;
    removeTabFromState: (tabId: string) => void;
    cleanupEmptyPanes: () => void;
    workspaceSplitCache: IWorkspaceSplitCacheLike;
    isSingletonPlaceholderCloseBlocked: (paneId: string, tabId: string) => boolean;
    enqueueTabTransition: <T>(task: () => Promise<T>) => Promise<T>;
    setWorkspaceLayoutResizing?: ((value: boolean) => void) | undefined;
    captureWorkspacePayload: (tabId: string) => Promise<TSplitPayload | null>;
    restoreWorkspacePayload: (tabId: string, payload: TSplitPayload | null) => Promise<boolean>;
    moveTabToNewWindow: (tabId: string) => Promise<void>;
    moveTabToWindow: (windowId: number, tabId: string) => Promise<void>;
    handleCloseTab: (paneId: string, tabId: string) => Promise<void>;
}

type TStaticTabContextCommand = Exclude<TTabContextCommand, TDirectionalTabContextCommand>;
type TStaticTabContextCommandWithoutTargetWindow = Exclude<TStaticTabContextCommand, { kind: 'move-to-window' }>;

function createDirectionalAvailability(value: boolean): TDirectionalCommandAvailability {
    return {
        left: value,
        right: value,
        up: value,
        down: value,
    };
}

function hasTabs(pane: IEditorPaneState | null | undefined) {
    return Boolean(pane && pane.tabIds.length > 0);
}

export const useAppShellDirectionalTabs = (options: IUseAppShellDirectionalTabsOptions) => {
    const {
        activePaneId,
        panes,
        tabs,
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
        isSingletonPlaceholderCloseBlocked,
        enqueueTabTransition,
        captureWorkspacePayload,
        restoreWorkspacePayload,
        moveTabToNewWindow,
        moveTabToWindow,
        handleCloseTab,
    } = options;

    const canTransferTabsAcrossWindows = computed(() => hasElectronAPI());

    function getDirectionalTargetPane(sourcePaneId: string, direction: TPaneDirection) {
        return findDirectionalPane(sourcePaneId, direction, false);
    }

    function buildDirectionalCommandAvailability(
        pane: IEditorPaneState,
        hasActiveTab: boolean,
        transitionsBusy: boolean,
    ) {
        const focus = createDirectionalAvailability(false);
        const move = createDirectionalAvailability(false);
        const copy = createDirectionalAvailability(false);

        for (const direction of DIRECTION_ORDER) {
            const focusTarget = findDirectionalPane(pane.paneId, direction, true);
            const directionalTarget = getDirectionalTargetPane(pane.paneId, direction);
            const hasUsableDirectionalPane = hasTabs(directionalTarget);
            const canUseDirectionalPane = hasActiveTab && hasUsableDirectionalPane && !transitionsBusy;

            focus[direction] = panes.value.length > 1 && hasTabs(focusTarget) && !transitionsBusy;
            move[direction] = canUseDirectionalPane;
            copy[direction] = canUseDirectionalPane;
        }

        return {
            focus,
            move,
            copy,
        };
    }

    function buildTabContextAvailabilityForPane(
        pane: IEditorPaneState,
        transitionsBusy: boolean,
    ): ITabContextAvailability {
        const activeTabIdForPane = pane.activeTabId;
        const hasActiveTab = Boolean(activeTabIdForPane);
        const closeBlocked = activeTabIdForPane
            ? isSingletonPlaceholderCloseBlocked(pane.paneId, activeTabIdForPane)
            : false;
        const {
            focus,
            move,
            copy,
        } = buildDirectionalCommandAvailability(pane, hasActiveTab, transitionsBusy);

        return {
            split: createDirectionalAvailability(hasActiveTab && !transitionsBusy),
            splitEmpty: createDirectionalAvailability(!transitionsBusy),
            focus,
            move,
            copy,
            canClose: hasActiveTab && !transitionsBusy && !closeBlocked,
            canCreate: true,
            canMoveToNewWindow: canTransferTabsAcrossWindows.value && tabs.value.length > 1 && !transitionsBusy,
            canMoveToWindow: canTransferTabsAcrossWindows.value && !transitionsBusy,
        };
    }

    async function captureActiveTabPayload() {
        const sourcePane = getPaneById(activePaneId.value);
        const sourceTabId = sourcePane?.activeTabId ?? null;
        const sourceTab = getTabById(sourceTabId);
        if (!sourcePane || !sourceTabId || !sourceTab) {
            return null;
        }

        const payload = await captureWorkspacePayload(sourceTabId);
        if (!payload) {
            return null;
        }

        return {
            payload,
            sourcePane,
            sourceTab,
            sourceTabId,
        };
    }

    const tabContextAvailabilityByPane = computed<Record<string, ITabContextAvailability>>(() => {
        const result: Record<string, ITabContextAvailability> = {};
        const transitionsBusy = isTabTransitionBusy.value;

        for (const pane of panes.value) {
            result[pane.paneId] = buildTabContextAvailabilityForPane(pane, transitionsBusy);
        }

        return result;
    });

    async function splitEditor(direction: TPaneDirection) {
        options.setWorkspaceLayoutResizing?.(true);
        await nextTick();
        try {
            await enqueueTabTransition(() => {
                const sourcePane = getPaneById(activePaneId.value);
                if (!sourcePane) {
                    return Promise.resolve();
                }
                const newPaneId = splitPane(sourcePane.paneId, direction);
                if (!newPaneId) {
                    return Promise.resolve();
                }

                createTab({
                    paneId: newPaneId,
                    activate: true,
                });
                activatePane(newPaneId);
                return Promise.resolve();
            });
            await nextTick();
            // The split state can trigger a second layout and ResizeObserver
            // delivery after the first Vue patch. Keep the viewer's resize
            // fence open through both visual frames so its existing semantic
            // anchor restore runs before the browser paints the settled track.
            await waitForVisualFrames({frames: 2});
        } finally {
            options.setWorkspaceLayoutResizing?.(false);
            // Releasing the resize fence schedules one more layout and
            // ResizeObserver delivery. Keep the split transition alive for
            // those painted frames so the retained document anchor settles
            // before callers observe the completed split.
            await waitForVisualFrames({frames: 2});
        }
    }

    async function splitEditorEmpty(direction: TPaneDirection) {
        await splitEditor(direction);
    }

    function focusEditorPane(direction: TPaneDirection) {
        if (isTabTransitionBusy.value) {
            return;
        }
        focusPane(direction, true);
    }

    function ensureTargetPaneForDirection(direction: TPaneDirection) {
        const sourcePane = getPaneById(activePaneId.value);
        if (!sourcePane) {
            return null;
        }

        const existing = getDirectionalTargetPane(sourcePane.paneId, direction);
        if (!existing || existing.tabIds.length === 0) {
            return null;
        }

        return {
            sourcePane,
            targetPaneId: existing.paneId,
        };
    }

    async function moveActiveTab(direction: TPaneDirection, targetIndex?: number | null) {
        await enqueueTabTransition(() => {
            const sourcePane = getPaneById(activePaneId.value);
            const sourceTabId = sourcePane?.activeTabId ?? null;
            if (!sourcePane || !sourceTabId) {
                return Promise.resolve();
            }

            const route = ensureTargetPaneForDirection(direction);
            if (!route) {
                return Promise.resolve();
            }

            if (targetIndex === undefined) {
                moveTabToPane(sourceTabId, route.targetPaneId, true);
            } else {
                moveTabToPane(sourceTabId, route.targetPaneId, true, targetIndex);
            }
            return Promise.resolve();
        });
    }

    async function copyActiveTab(direction: TPaneDirection) {
        await enqueueTabTransition(async () => {
            const route = ensureTargetPaneForDirection(direction);
            if (!route) {
                return;
            }

            const activeTabPayload = await captureActiveTabPayload();
            if (!activeTabPayload) {
                return;
            }
            const {
                payload,
                sourcePane,
                sourceTabId,
            } = activeTabPayload;

            const targetTab = createTab({
                paneId: route.targetPaneId,
                activate: true,
            });

            const restored = await restoreWorkspacePayload(targetTab.id, payload);
            if (!restored) {
                removeTabFromState(targetTab.id);
                activateTab(sourcePane.paneId, sourceTabId);
                return;
            }

            activateTab(route.targetPaneId, targetTab.id);
            cleanupEmptyPanes();
        });
    }

    async function closeOtherTabs(paneId: string, tabId: string) {
        const pane = getPaneById(paneId);
        if (!pane) {
            return;
        }
        const targetIds = pane.tabIds.filter(id => id !== tabId);
        for (const id of targetIds) {
            await handleCloseTab(paneId, id);
        }
    }

    async function closeTabsToRight(paneId: string, tabId: string) {
        const pane = getPaneById(paneId);
        if (!pane) {
            return;
        }
        const parsedTabId = parseTabId(tabId);
        if (parsedTabId === null) {
            return;
        }
        const index = pane.tabIds.indexOf(parsedTabId);
        if (index < 0) {
            return;
        }
        const targetIds = pane.tabIds.slice(index + 1);
        for (const id of targetIds) {
            await handleCloseTab(paneId, id);
        }
    }

    function getTabFilePath(tabId: string): TDocumentRef | null {
        const path = options.documentSessionsByTabId.value[tabId]?.snapshot.value.identity.originalPath ?? null;
        return typeof path === 'string' && path.trim().length > 0 && !isBrowserDocumentRef(path)
            ? path
            : null;
    }

    async function revealTabInFolder(tabId: string) {
        const path = getTabFilePath(tabId);
        if (path === null) {
            return;
        }
        try {
            await getDocumentWindowCapability().showItemInFolder(path);
        } catch {
            // Best-effort; revealing in the file manager can fail if the file moved.
        }
    }

    async function copyTabPath(tabId: string) {
        const path = getTabFilePath(tabId);
        if (path === null) {
            return;
        }
        try {
            await globalThis.navigator.clipboard.writeText(path);
        } catch {
            // Best-effort; clipboard access can be denied.
        }
    }

    function isDirectionalContextCommand(command: TTabContextCommand): command is TDirectionalTabContextCommand {
        return 'direction' in command;
    }

    function getStaticContextCommandRunner(
        paneId: string,
        tabId: string,
        command: TStaticTabContextCommand,
    ) {
        if (command.kind === 'move-to-window') {
            return () => enqueueTabTransition(() => moveTabToWindow(command.targetWindowId, tabId));
        }

        const handlers = {
            'new-tab': () => {
                createTab({
                    paneId,
                    activate: true,
                });
                return Promise.resolve();
            },
            'close-tab': () => handleCloseTab(paneId, tabId),
            'close-others': () => closeOtherTabs(paneId, tabId),
            'close-right': () => closeTabsToRight(paneId, tabId),
            'reveal-in-folder': () => revealTabInFolder(tabId),
            'copy-path': () => copyTabPath(tabId),
            'move-to-new-window': () => enqueueTabTransition(() => moveTabToNewWindow(tabId)),
        } satisfies Record<TStaticTabContextCommandWithoutTargetWindow['kind'], () => Promise<void>>;

        return handlers[command.kind];
    }

    async function runDirectionalContextCommand(command: TDirectionalTabContextCommand) {
        const handlers = {
            split: splitEditor,
            'split-empty': splitEditorEmpty,
            focus: (direction) => {
                focusEditorPane(direction);
                return Promise.resolve();
            },
            move: moveActiveTab,
            copy: copyActiveTab,
        } satisfies Record<TDirectionalTabContextCommand['kind'], (direction: TPaneDirection) => Promise<void>>;

        await handlers[command.kind](command.direction);
    }

    async function handleTabContextCommand(
        paneId: string,
        tabId: string,
        command: TTabContextCommand,
    ) {
        const pane = getPaneById(paneId);
        if (!pane) {
            return;
        }

        activatePane(paneId);
        activateTab(paneId, tabId);
        await runTabContextCommand(paneId, tabId, command);
    }

    async function runTabContextCommand(
        paneId: string,
        tabId: string,
        command: TTabContextCommand,
    ) {
        if (isDirectionalContextCommand(command)) {
            await runDirectionalContextCommand(command);
            return;
        }

        await getStaticContextCommandRunner(paneId, tabId, command)();
    }

    function handleTabMoveDirection(
        paneId: string,
        tabId: string,
        direction: 'left' | 'right',
        targetIndex?: number | null,
    ) {
        const pane = getPaneById(paneId);
        const parsedTabId = parseTabId(tabId);
        if (!pane || parsedTabId === null || !pane.tabIds.includes(parsedTabId)) {
            return;
        }

        activatePane(paneId);
        activateTab(paneId, tabId);
        void moveActiveTab(direction, targetIndex);
    }

    function cleanup() {
        // Stable lifecycle hook retained for the shell binding.
    }

    return {
        tabContextAvailabilityByPane,
        splitEditor,
        splitEditorEmpty,
        focusEditorPane,
        moveActiveTab,
        copyActiveTab,
        handleTabContextCommand,
        handleTabMoveDirection,
        cleanup,
    };
};
