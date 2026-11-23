import { getErrorMessage } from '@app/utils/error';
import type {
    ComputedRef,
    Ref,
} from 'vue';
import { uniq } from 'es-toolkit/array';
import { BrowserLogger } from '@app/utils/browserLogger';
import { until } from '@vueuse/core';
import { hasWorkspaceViewerDocumentCapabilities } from '@app/modules/workspace-shell/viewers/workspaceViewerAdapters';
import type { IEditorPaneState } from '@contracts/editorPanes';
import { parseTabId } from '@contracts/windowTabs';
import type { ITab } from '@app/types/tabs';
import type { TDirtyCloseDecision } from '@app/modules/workspace-shell/composables/useDirtyTabCloseDialog';
import type { IWorkspaceRestoreTrackerLike } from '@app/modules/workspace-shell/composables/useWorkspaceRestoreTracker';
import {
    snapshotOccupiesTab,
    type IWorkspaceDocumentController,
} from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import { rememberReadingView } from '@app/modules/workspace-shell/document-sessions/recentReadingView';
import type { TChangeWorkspaceLayout } from '@app/modules/workspace-shell/composables/workspaceLayoutChange';

interface IUseAppShellTabLifecycleOptions {
    panes: Ref<IEditorPaneState[]>;
    tabs: Ref<ITab[]>;
    activePaneId: Ref<string | null>;
    activeTabId: Ref<string | null>;
    documentSessionsByTabId: Ref<Record<string, IWorkspaceDocumentController>>;
    workspaceRestoreTracker: IWorkspaceRestoreTrackerLike;
    getPaneById: (paneId: string | null | undefined) => IEditorPaneState | null;
    getTabById: (tabId: string | null | undefined) => ITab | null;
    getPaneByTabId: (tabId: string | null | undefined) => IEditorPaneState | null;
    activatePane: (paneId: string) => void;
    activateTab: (paneId: string, tabId: string) => void;
    closeTab: (paneId: string, tabId: string) => void;
    closePane: (paneId: string) => void;
    requestDirtyTabCloseConfirmation: (tabId: string) => Promise<TDirtyCloseDecision>;
    changeWorkspaceLayout: TChangeWorkspaceLayout;
}

type TEndRelease = ReturnType<IWorkspaceDocumentController['releaseJobs']> | null;
type TLayoutFence = Parameters<Parameters<TChangeWorkspaceLayout>[0]>[0];

interface ICloseHandoffTarget {
    paneId: string;
    tabId: string;
}

interface ITabTransitionReportContext {
    action: string;
    paneId?: string;
    tabId?: string;
}

interface IResolvedTabForAction {
    tab: ITab;
    pane: IEditorPaneState;
}

function serializeTransitionError(error: unknown) {
    if (error instanceof Error) {
        return {
            name: error.name,
            message: getErrorMessage(error),
            stack: error.stack,
        };
    }
    return error;
}

interface IUseAppShellTabLifecycleResult {
    isTabTransitionBusy: ComputedRef<boolean>;
    enqueueTabTransition: <T>(task: () => Promise<T>, context?: ITabTransitionReportContext) => Promise<T>;
    removeTabFromState: (tabId: string) => void;
    cleanupEmptyPanes: () => void;
    isSingletonPlaceholderCloseBlocked: (paneId: string, tabId: string) => boolean;
    resolveTabForAction: (tabId: string | undefined) => IResolvedTabForAction | null;
    closeTabInState: (paneId: string, tabId: string) => void;
    handoffActiveTabBeforeClose: (paneId: string, tabId: string) => void;
    handleCloseTab: (paneId: string, tabId: string) => Promise<void>;
}

export const useAppShellTabLifecycle = (
    options: IUseAppShellTabLifecycleOptions,
): IUseAppShellTabLifecycleResult => {
    const {
        panes,
        tabs,
        activePaneId,
        activeTabId,
        documentSessionsByTabId,
        getPaneById,
        getTabById,
        getPaneByTabId,
        activatePane,
        activateTab,
        closeTab,
        closePane,
        requestDirtyTabCloseConfirmation,
    } = options;

    const { reportRuntimeError } = useRuntimeErrorReports();
    const { t } = useTypedI18n();
    const toast = useToast();
    const activeTabTransitions: Ref<number> = ref(0);
    const pendingCloseTransitions = new Map<string, Promise<unknown>>();
    const busyFeedbackToastIds = new Map<string, string | number>();
    let tabTransitionQueue: Promise<void> = Promise.resolve();

    const isTabTransitionBusy: ComputedRef<boolean> = computed(() => activeTabTransitions.value > 0);

    function reportTabTransitionError(error: unknown, context: ITabTransitionReportContext | undefined) {
        const details = {
            context: context ?? null,
            error: serializeTransitionError(error),
        };
        const failure = BrowserLogger.error('toolbar-transition', 'Tab transition failed', details, {code: 'RENDERER_TAB_TRANSFER_OPERATION_FAILED'});
        reportRuntimeError({
            failure,
            title: t('errors.runtime.title'),
        });
    }

    function enqueueTabTransition<T>(
        task: () => Promise<T>,
        context?: ITabTransitionReportContext,
    ): Promise<T> {
        const chained = tabTransitionQueue.then(async () => {
            activeTabTransitions.value += 1;
            try {
                await nextTick();
                return await task();
            } finally {
                await nextTick();
                activeTabTransitions.value = Math.max(0, activeTabTransitions.value - 1);
            }
        });
        const guarded = chained.catch((error: unknown) => {
            reportTabTransitionError(error, context);
            return undefined as T;
        });

        tabTransitionQueue = guarded.then(
            () => undefined,
            () => undefined,
        );

        return guarded;
    }

    function removeTabFromState(tabId: string) {
        const pane = getPaneByTabId(tabId);
        if (pane) {
            closeTab(pane.paneId, tabId);
        }
    }

    function cleanupEmptyPanes() {
        for (const pane of [...panes.value]) {
            if (panes.value.length <= 1) {
                break;
            }
            if (pane.tabIds.length === 0) {
                closePane(pane.paneId);
            }
        }
    }

    function getDocumentSession(tabId: string | null | undefined) {
        return tabId ? documentSessionsByTabId.value[tabId] ?? null : null;
    }

    function tabOccupied(tabId: string) {
        const session = getDocumentSession(tabId);
        return session !== null && snapshotOccupiesTab(session.snapshot.value);
    }

    function hasTabBusyOperation(tabId: string) {
        const session = getDocumentSession(tabId);
        const view = session?.getView(tabId);
        const toolbarSnapshot = view?.mountedWorkspace.value ? view.toolbarSnapshot.value : null;
        return session?.operationLease.isBusy.value === true || Boolean(toolbarSnapshot && (
            toolbarSnapshot.isAnySaving
            || toolbarSnapshot.isHistoryBusy
            || toolbarSnapshot.isExportingDocx
            || toolbarSnapshot.isPageOperationInProgress === true
        ));
    }

    function notifyTabBusy(tabId: string) {
        if (busyFeedbackToastIds.has(tabId)) {
            return;
        }

        const busyToast = toast.add({
            color: 'info',
            title: t('notifications.documentBusyTitle'),
            description: t('notifications.closingAfterPageProcessing'),
        });
        busyFeedbackToastIds.set(tabId, busyToast.id);
    }

    function clearTabBusyFeedback(tabId: string) {
        const toastId = busyFeedbackToastIds.get(tabId);
        if (toastId === undefined) {
            return;
        }

        toast.remove(toastId);
        busyFeedbackToastIds.delete(tabId);
    }

    // Keeps a long operation on the tab's current document from holding the
    // transition queue for other tabs. It decides nothing: Close's own lease
    // turn reads the document's state.
    async function waitForTabOperationsToSettle(tabId: string) {
        if (!hasTabBusyOperation(tabId)) return;
        notifyTabBusy(tabId);
        try {
            await until(() => hasTabBusyOperation(tabId)).toBe(false);
        } finally {
            clearTabBusyFeedback(tabId);
        }
    }

    function tabHasCloseableDocument(tabId: string | null | undefined) {
        const view = tabId ? getDocumentSession(tabId)?.getView(tabId) : null;
        return Boolean(view?.mountedWorkspace.value)
            && hasWorkspaceViewerDocumentCapabilities(view?.toolbarSnapshot.value.viewerCapabilities);
    }

    function isSingletonPlaceholderCloseBlocked(paneId: string, tabId: string) {
        if (tabs.value.length !== 1) {
            return false;
        }

        const pane = getPaneById(paneId);
        const parsedTabId = parseTabId(tabId);
        if (!pane || parsedTabId === null || pane.tabIds.length !== 1 || !pane.tabIds.includes(parsedTabId)) {
            return false;
        }

        return !tabOccupied(tabId);
    }

    function resolveTabForAction(tabId: string | undefined) {
        const resolvedTabId = tabId ?? activeTabId.value ?? undefined;
        if (!resolvedTabId) {
            return null;
        }

        const tab = getTabById(resolvedTabId);
        if (!tab) {
            return null;
        }

        const pane = getPaneByTabId(resolvedTabId);
        if (!pane) {
            return null;
        }

        return {
            tab,
            pane,
        };
    }

    function scoreTabDocumentReadiness(tabId: string) {
        if (tabHasCloseableDocument(tabId)) {
            return 3;
        }
        return tabOccupied(tabId) ? 2 : 1;
    }

    function pickBestTabCandidate(tabIds: Array<string | null | undefined>) {
        const uniqueTabIds = uniq(tabIds.flatMap(tabId => tabId ? [tabId] : []));

        let bestTabId: string | null = null;
        let bestScore = -1;
        for (const tabId of uniqueTabIds) {
            if (!getTabById(tabId)) {
                continue;
            }
            const score = scoreTabDocumentReadiness(tabId);
            if (score > bestScore) {
                bestScore = score;
                bestTabId = tabId;
            }
        }

        return bestTabId;
    }

    function pickSamePaneCloseReplacement(sourcePane: IEditorPaneState, tabId: string) {
        const parsedTabId = parseTabId(tabId);
        if (parsedTabId === null) {
            return null;
        }
        const closingTabIndex = sourcePane.tabIds.indexOf(parsedTabId);
        if (closingTabIndex === -1) {
            return null;
        }

        return pickBestTabCandidate([
            sourcePane.tabIds[closingTabIndex + 1],
            sourcePane.tabIds[closingTabIndex - 1],
            ...sourcePane.tabIds.filter(candidate => candidate !== parsedTabId),
        ]);
    }

    function pickCrossPaneCloseReplacement(sourcePaneId: string) {
        let bestTarget: (ICloseHandoffTarget & { score: number }) | null = null;

        for (const candidatePane of panes.value) {
            if (candidatePane.paneId === sourcePaneId || candidatePane.tabIds.length === 0) {
                continue;
            }

            const candidateTabId = pickBestTabCandidate([
                candidatePane.activeTabId,
                ...candidatePane.tabIds,
            ]);
            if (!candidateTabId) {
                continue;
            }

            const score = scoreTabDocumentReadiness(candidateTabId);
            if (!bestTarget || score > bestTarget.score) {
                bestTarget = {
                    paneId: candidatePane.paneId,
                    tabId: candidateTabId,
                    score,
                };
            }
        }

        return bestTarget
            ? {
                paneId: bestTarget.paneId,
                tabId: bestTarget.tabId,
            }
            : null;
    }

    function resolveCloseHandoffTarget(paneId: string, tabId: string) {
        if (activePaneId.value !== paneId || activeTabId.value !== tabId) {
            return null;
        }

        const sourcePane = getPaneById(paneId);
        if (!sourcePane) {
            return null;
        }

        const samePaneReplacement = pickSamePaneCloseReplacement(sourcePane, tabId);
        if (samePaneReplacement) {
            return {
                paneId: sourcePane.paneId,
                tabId: samePaneReplacement,
            };
        }

        return pickCrossPaneCloseReplacement(sourcePane.paneId);
    }

    // Selecting the replacement is the whole handoff. Its view mounts only while
    // shown and the user may select another tab first, so nothing waits for it.
    function activateHandoffTarget(paneId: string, tabId: string) {
        activatePane(paneId);
        activateTab(paneId, tabId);
    }

    function handoffActiveTabBeforeClose(paneId: string, tabId: string) {
        const target = resolveCloseHandoffTarget(paneId, tabId);
        if (target) {
            activateHandoffTarget(target.paneId, target.tabId);
        }
    }

    function closeTabInState(paneId: string, tabId: string) {
        closeTab(paneId, tabId);
    }

    /**
     * Removes the tab, then any pane left empty, and hands focus on. Removing
     * a split pane's last tab removes its pane: the grid replaces the split
     * with one slot and moves the remaining pane into it, as a split moves
     * the source pane, so the close fences that layout change. The final tab of
     * a closed document stays as the required empty-tab slot: it keeps its
     * mounted workspace, so Start stays actionable in the close commit.
     */
    async function commitTabClose(paneId: string, tabId: string, handoff: ICloseHandoffTarget | null, keepsFinalTab: boolean, fence: TLayoutFence) {
        const pane = getPaneByTabId(tabId) ?? getPaneById(paneId);
        const closesTab = pane !== null && !(keepsFinalTab && panes.value.length === 1 && pane.tabIds.length === 1 && pane.tabIds[0] === tabId);
        if (pane && closesTab && panes.value.length > 1 && pane.tabIds.length === 1) {
            await fence();
        }
        if (pane && closesTab) closeTabInState(pane.paneId, tabId);
        cleanupEmptyPanes();
        activateCloseHandoff(handoff);
    }

    function activateCloseHandoff(closeHandoffTarget: ICloseHandoffTarget | null) {
        if (!closeHandoffTarget) {
            return;
        }

        const targetTab = getTabById(closeHandoffTarget.tabId);
        const targetPane = getPaneById(closeHandoffTarget.paneId)
            ?? getPaneByTabId(closeHandoffTarget.tabId);
        const targetTabId = parseTabId(targetTab?.id);
        if (!targetTab || targetTabId === null || !targetPane || !targetPane.tabIds.includes(targetTabId)) {
            return;
        }

        activateHandoffTarget(targetPane.paneId, targetTab.id);
    }

    async function closeWorkspaceDocument(tabId: string, endRelease: TEndRelease) {
        const controller = getDocumentSession(tabId);
        // A Save or Cancel keeps the document, which publishes the revision its Close ended again first.
        return Boolean(controller && await controller.close({decide: async () => {
            const decision = await requestDirtyTabCloseConfirmation(tabId);
            endRelease?.(decision !== 'discard');
            return decision;
        }}));
    }

    async function closeTabDuringTransition(paneId: string, tabId: string, fence: TLayoutFence, endRelease: TEndRelease = null) {
        const tab = getTabById(tabId);
        if (!tab) {
            return;
        }

        const closeHandoffTarget = resolveCloseHandoffTarget(paneId, tabId);

        // A view of a document that another tab still shows closes alone: the
        // document, its unsaved work and its question stay with the other view.
        const closesDocument = (getDocumentSession(tabId)?.views.value.size ?? 0) < 2;
        // A document close remembers once at its commit; a lone view leaves
        // its document open and remembers only the view being removed.
        if (!closesDocument) {
            await rememberReadingView(getDocumentSession(tabId), tabId);
            // The other view may have let go of the document meanwhile; this
            // one is then its last and closes it, asking about unsaved work.
            if ((getDocumentSession(tabId)?.views.value.size ?? 0) < 2) {
                const endRelease = getDocumentSession(tabId)?.releaseJobs() ?? null;
                try {
                    await closeTabDuringTransition(paneId, tabId, fence, endRelease);
                } finally {
                    endRelease?.(true);
                }
                return;
            }
        }

        const closesDocumentInTab = closesDocument && tabOccupied(tabId);
        if (closesDocumentInTab && !await closeWorkspaceDocument(tabId, endRelease)) {
            return;
        }
        await commitTabClose(paneId, tabId, closeHandoffTarget, closesDocumentInTab, fence);
    }

    async function handleCloseTab(paneId: string, tabId: string) {
        const pending = pendingCloseTransitions.get(tabId);
        if (pending) {
            await pending;
            return;
        }

        if (isSingletonPlaceholderCloseBlocked(paneId, tabId)) {
            return;
        }

        const closing = getDocumentSession(tabId);
        // The last view's Close ends its document's running jobs until it decides, so a reader that never returns
        // cannot hold the question (#1598). A linked view's close takes no lease and waits for nothing.
        const endRelease = closing && closing.views.value.size < 2 ? closing.releaseJobs() : null;
        // A close that collapses a split ends once the views are placed, after
        // its tab transition, so the views see the fence fall with it.
        const transition = options.changeWorkspaceLayout(async (fence) => {
            if (endRelease) await waitForTabOperationsToSettle(tabId);
            await enqueueTabTransition(
                () => closeTabDuringTransition(paneId, tabId, fence, endRelease),
                {
                    action: 'close-tab',
                    paneId,
                    tabId,
                },
            );
        }).finally(() => endRelease?.(true));
        pendingCloseTransitions.set(tabId, transition);
        try {
            await transition;
        } finally {
            if (pendingCloseTransitions.get(tabId) === transition) {
                pendingCloseTransitions.delete(tabId);
            }
        }
    }

    return {
        isTabTransitionBusy,
        enqueueTabTransition,
        removeTabFromState,
        cleanupEmptyPanes,
        isSingletonPlaceholderCloseBlocked,
        resolveTabForAction,
        closeTabInState,
        handoffActiveTabBeforeClose,
        handleCloseTab,
    };
};
