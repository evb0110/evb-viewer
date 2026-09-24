import { getErrorMessage } from '@app/utils/error';
import type {
    ComputedRef,
    Ref,
} from 'vue';
import { uniq } from 'es-toolkit/array';
import { BrowserLogger } from '@app/utils/browserLogger';
import {
    waitForVisualFrames,
    waitUntilIdle,
} from '@app/utils/asyncHelpers';
import { tabHasDocumentHint } from '@app/modules/workspace-shell/tabs/tabHasDocumentHint';
import { workspaceHasPdf } from '@app/modules/workspace-shell/state/workspaceHasPdf';
import { hasWorkspaceViewerDocumentCapabilities } from '@app/modules/workspace-shell/viewers/workspaceViewerAdapters';
import type { IEditorPaneState } from '@contracts/editorPanes';
import { parseTabId } from '@contracts/windowTabs';
import type { ITab } from '@app/types/tabs';
import type { TDirtyCloseDecision } from '@app/modules/workspace-shell/composables/useDirtyTabCloseDialog';
import type { IWorkspaceExpose } from '@app/types/workspaceExpose';
import type {
    IWorkspaceRestoreTrackerLike,
    IWorkspaceSplitCacheLike,
} from '@app/modules/workspace-shell/composables/workspaceSplitTypes';
import type { IWorkspaceDocumentRecord } from '@app/modules/workspace-shell/state/workspaceDocumentRecord';
import type { IWorkspaceDocumentController } from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';

interface IUseAppShellTabLifecycleOptions {
    panes: Ref<IEditorPaneState[]>;
    tabs: Ref<ITab[]>;
    activePaneId: Ref<string | null>;
    activeTabId: Ref<string | null>;
    workspaceRefs: Ref<Map<string, IWorkspaceExpose>>;
    documentSessionsByTabId: Ref<Record<string, IWorkspaceDocumentController>>;
    getDocumentRecord: (tabId: string | null | undefined) => IWorkspaceDocumentRecord | null;
    workspaceSplitCache: IWorkspaceSplitCacheLike;
    workspaceRestoreTracker: IWorkspaceRestoreTrackerLike;
    getPaneById: (paneId: string | null | undefined) => IEditorPaneState | null;
    getTabById: (tabId: string | null | undefined) => ITab | null;
    getPaneByTabId: (tabId: string | null | undefined) => IEditorPaneState | null;
    activatePane: (paneId: string) => void;
    activateTab: (paneId: string, tabId: string) => void;
    closeTab: (paneId: string, tabId: string) => void;
    closePane: (paneId: string) => void;
    requestDirtyTabCloseConfirmation: (tabId: string) => Promise<TDirtyCloseDecision>;
}

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
    updateTab: (tabId: string, updates: Partial<ITab>) => void;
    removeTabFromState: (tabId: string) => void;
    cleanupEmptyPanes: () => void;
    isSingletonPlaceholderCloseBlocked: (paneId: string, tabId: string) => boolean;
    resolveTabForAction: (tabId: string | undefined) => IResolvedTabForAction | null;
    closeTabInState: (paneId: string, tabId: string) => void;
    handoffActiveTabBeforeClose: (paneId: string, tabId: string) => Promise<void>;
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
        workspaceRefs,
        documentSessionsByTabId,
        getDocumentRecord,
        workspaceSplitCache,
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

    function updateTab(tabId: string, updates: Partial<ITab>) {
        const tab = getTabById(tabId);
        if (!tab) {
            return;
        }

        Object.assign(tab, updates);
    }

    function removeTabFromState(tabId: string) {
        const pane = getPaneByTabId(tabId);
        if (pane) {
            closeTab(pane.paneId, tabId);
        }
        workspaceSplitCache.clear(tabId);
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

    // The retained singleton tab keeps its mounted workspace, so its record must
    // be returned to the empty-tab shape explicitly. Leaving the closed
    // document's identity behind keeps `tabHasDocumentHint` true, which the host
    // reads as an open still in flight and renders as a skeleton forever.
    function resetTabToPlaceholder(tabId: string) {
        const tab = getTabById(tabId);
        if (!tab) {
            return;
        }

        Object.assign(tab, {
            fileName: null,
            originalPath: null,
            documentInstanceId: null,
            isDirty: false,
            isDjvu: false,
        });
        // `originalBackend` is presence-encoded everywhere it is read, so the
        // empty-tab shape drops the key instead of holding an undefined value.
        delete tab.originalBackend;
        workspaceSplitCache.clear(tabId);
    }

    function isPlaceholderTab(tab: ITab) {
        return tab.fileName === null
            && tab.originalPath === null
            && !tab.isDirty
            && !tab.isDjvu;
    }

    function getDocumentSession(tabId: string | null | undefined) {
        return tabId ? documentSessionsByTabId.value[tabId] ?? null : null;
    }

    function hasTabBusyOperation(tabId: string) {
        const sessionBusy = getDocumentSession(tabId)?.operationLease.isBusy.value === true;
        const toolbarSnapshot = workspaceRefs.value.get(tabId)?.getToolbarSnapshot();
        return sessionBusy || Boolean(toolbarSnapshot && (
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

    async function waitForTabOperationsToSettle(tabId: string) {
        if (hasTabBusyOperation(tabId)) {
            notifyTabBusy(tabId);
        }

        try {
            return await waitUntilIdle(() => hasTabBusyOperation(tabId));
        } finally {
            clearTabBusyFeedback(tabId);
        }
    }

    function recordHasCloseableDocument(tabId: string | null | undefined) {
        const sessionCloseable = getDocumentSession(tabId)?.snapshot.value.closeable;
        if (sessionCloseable !== undefined) {
            return sessionCloseable;
        }

        const snapshot = getDocumentRecord(tabId)?.toolbarSnapshot;
        return hasWorkspaceViewerDocumentCapabilities(snapshot?.viewerCapabilities);
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

        const tab = getTabById(tabId);
        if (!tab || !isPlaceholderTab(tab)) {
            return false;
        }

        if (recordHasCloseableDocument(tabId)) {
            return false;
        }
        const workspace = workspaceRefs.value.get(tabId) ?? null;
        return !workspaceHasPdf(workspace);
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
        if (recordHasCloseableDocument(tabId)) {
            return 3;
        }

        const tab = getTabById(tabId);
        if (tab && tabHasDocumentHint(tab)) {
            return 2;
        }

        return 1;
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

    async function handoffActiveTabBeforeClose(paneId: string, tabId: string) {
        const target = resolveCloseHandoffTarget(paneId, tabId);
        if (!target) {
            return;
        }

        activatePane(target.paneId);
        activateTab(target.paneId, target.tabId);
        await nextTick();
    }

    function closeTabInState(paneId: string, tabId: string) {
        closeTab(paneId, tabId);
        workspaceSplitCache.clear(tabId);
    }

    function closeResolvedTabInState(paneId: string, tabId: string) {
        const resolvedPane = getPaneByTabId(tabId) ?? getPaneById(paneId);
        if (resolvedPane) {
            closeTabInState(resolvedPane.paneId, tabId);
        }
    }

    function shouldDeferCloseHandoff(
        sourcePane: IEditorPaneState | null,
        closeHandoffTarget: ICloseHandoffTarget | null,
    ) {
        return Boolean(
            sourcePane
            && closeHandoffTarget
            && sourcePane.tabIds.length === 1
            && closeHandoffTarget.paneId !== sourcePane.paneId,
        );
    }

    async function activateDeferredCloseHandoff(
        shouldDeferCrossPaneHandoff: boolean,
        closeHandoffTarget: ICloseHandoffTarget | null,
    ) {
        if (!shouldDeferCrossPaneHandoff || !closeHandoffTarget) {
            return;
        }

        const targetTab = getTabById(closeHandoffTarget.tabId);
        const targetPane = getPaneById(closeHandoffTarget.paneId)
            ?? getPaneByTabId(closeHandoffTarget.tabId);
        const targetTabId = parseTabId(targetTab?.id);
        if (!targetTab || targetTabId === null || !targetPane || !targetPane.tabIds.includes(targetTabId)) {
            return;
        }

        activatePane(targetPane.paneId);
        activateTab(targetPane.paneId, targetTab.id);
        await nextTick();
    }

    function resolveCloseHandoffContext(paneId: string, tabId: string) {
        const sourcePaneBeforeClose = getPaneById(paneId);
        const closeHandoffTarget = resolveCloseHandoffTarget(paneId, tabId);
        return {
            closeHandoffTarget,
            shouldDeferCrossPaneHandoff: shouldDeferCloseHandoff(sourcePaneBeforeClose, closeHandoffTarget),
        };
    }

    async function resolveClosePersistence(tabId: string, tab: ITab) {
        await waitForTabOperationsToSettle(tabId);

        const session = getDocumentSession(tabId);
        const record = getDocumentRecord(tabId);
        const isDirty = session ? session.snapshot.value.dirty : record?.tab.isDirty ?? tab.isDirty;
        if (!isDirty) {
            return false;
        }

        const decision = await requestDirtyTabCloseConfirmation(tabId);
        if (decision === 'cancel') {
            return null;
        }
        return decision === 'save';
    }

    function workspaceHasCloseableDocument(tabId: string, workspace: IWorkspaceExpose | undefined) {
        const sessionSnapshot = getDocumentSession(tabId)?.snapshot.value;
        const activeKind = sessionSnapshot?.activeTransaction?.kind;
        if (activeKind === 'open' || activeKind === 'restore' || activeKind === 'reload') {
            return true;
        }
        if (!workspace) {
            return false;
        }
        if (sessionSnapshot?.closeable === true) {
            return true;
        }
        if (recordHasCloseableDocument(tabId)) {
            return true;
        }
        return workspaceHasPdf(workspace)
            || hasWorkspaceViewerDocumentCapabilities(workspace.getToolbarSnapshot().viewerCapabilities);
    }

    async function closeWorkspaceDocument(
        paneId: string,
        tabId: string,
        workspace: IWorkspaceExpose | undefined,
        shouldPersistBeforeClose: boolean,
    ) {
        const controller = getDocumentSession(tabId);
        if (!controller && !workspace) {
            return;
        }
        const closed = controller
            ? await controller.close({persist: shouldPersistBeforeClose})
            : workspace
                ? await workspace.handleCloseFileFromUi({persist: shouldPersistBeforeClose})
                : false;

        // `closed` is the close call's own verdict and the only untainted one:
        // the toolbar snapshot still advertises a viewer adapter here, because
        // the host keeps a pending-document hint alive until this tab drops its
        // file name. Re-deriving "document gone" from that snapshot deadlocks.
        if (closed) {
            const pane = getPaneByTabId(tabId) ?? getPaneById(paneId);
            const retainMountedSingletonOwner = panes.value.length === 1
                && pane?.tabIds.length === 1
                && pane.tabIds[0] === tabId;
            // The final tab is already the product's required empty-tab slot.
            // Keep its mounted workspace/chassis authority instead of deleting
            // it and constructing an equivalent replacement asynchronously;
            // Recent-file commands then remain actionable in the close commit.
            if (retainMountedSingletonOwner) {
                resetTabToPlaceholder(tabId);
            } else {
                closeResolvedTabInState(paneId, tabId);
            }
        }
    }

    async function closeTabDuringTransition(paneId: string, tabId: string) {
        const tab = getTabById(tabId);
        if (!tab) {
            return;
        }

        const {
            closeHandoffTarget,
            shouldDeferCrossPaneHandoff,
        } = resolveCloseHandoffContext(paneId, tabId);

        const shouldPersistBeforeClose = await resolveClosePersistence(tabId, tab);
        if (shouldPersistBeforeClose === null) {
            return;
        }

        if (!shouldDeferCrossPaneHandoff) {
            await handoffActiveTabBeforeClose(paneId, tabId);
        }

        const workspace = workspaceRefs.value.get(tabId);
        if (workspaceHasCloseableDocument(tabId, workspace)) {
            await closeWorkspaceDocument(paneId, tabId, workspace, shouldPersistBeforeClose);
        } else {
            closeResolvedTabInState(paneId, tabId);
        }

        const paneCountBeforeCleanup = panes.value.length;
        cleanupEmptyPanes();
        await activateDeferredCloseHandoff(shouldDeferCrossPaneHandoff, closeHandoffTarget);
        if (panes.value.length < paneCountBeforeCleanup) {
            // Closing the last tab in a split changes the track width after the
            // Vue patch. Keep the transition fence open through the same two
            // painted frames used when creating the split so the retained
            // document anchor can be restored after the collapse settles.
            await waitForVisualFrames({frames: 2});
        }
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

        if (hasTabBusyOperation(tabId)) {
            notifyTabBusy(tabId);
        }

        const transition = (async () => {
            await waitForTabOperationsToSettle(tabId);
            await enqueueTabTransition(
                () => closeTabDuringTransition(paneId, tabId),
                {
                    action: 'close-tab',
                    paneId,
                    tabId,
                },
            );
        })();
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
        updateTab,
        removeTabFromState,
        cleanupEmptyPanes,
        isSingletonPlaceholderCloseBlocked,
        resolveTabForAction,
        closeTabInState,
        handoffActiveTabBeforeClose,
        handleCloseTab,
    };
};
