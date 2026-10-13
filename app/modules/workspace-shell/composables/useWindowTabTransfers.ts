import type { IDocumentOperationOwnership } from '@app/types/documentOperationKind';
import type { Ref } from 'vue';
import type {
    IWindowTabTransferSessionState,
    IWindowTabIncomingTransfer,
    TSplitPayload,
    TWindowTabTransferTarget,
} from '@contracts/windowTabs';
import type { TEditorLayoutNode } from '@contracts/editorPanes';
import type {ITab} from '@app/types/tabs';
import { BrowserLogger } from '@app/utils/browserLogger';
import { collectMergeTabOrder } from '@app/modules/workspace-shell/window-tabs/collectMergeTabOrder';
import { shouldCloseSourceWindowAfterTransfer } from '@app/modules/workspace-shell/window-tabs/shouldCloseSourceWindowAfterTransfer';
import { cleanupSplitPayloadSnapshot } from '@app/modules/workspace-shell/splits/cleanupSplitPayloadSnapshot';
import {
    canUseNativeWindowTabTransfers,
    getWindowTabsCapability,
} from '@app/utils/platformWindowTabs';
import { getErrorMessage } from '@app/utils/error';
import { withTimeout } from 'es-toolkit/promise';
import { createDocumentSessionTransferState } from '@app/modules/workspace-shell/document-sessions/createDocumentSessionTransferState';
import {
    describeTabDocument,
    identityHasDocument,
    snapshotOccupiesTab,
    type IWorkspaceDocumentController,
} from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import type { TWorkspaceCommandTarget } from '@app/modules/workspace-shell/document-sessions/workspaceCommandTarget';
import type { TWorkspaceDocumentSessions } from '@app/modules/workspace-shell/document-sessions/useWorkspaceDocumentSessions';
import { rememberReadingView } from '@app/modules/workspace-shell/document-sessions/recentReadingView';

interface IPaneLike {
    paneId: string;
    activeTabId: string | null;
    tabIds: string[];
}

type TSourceTransferOutcome = 'success' | 'failed' | 'window-closed';

interface IIncomingTransferTargetTab {
    tabId: string;
    created: boolean;
    previousActiveTabId: string | null;
}

interface IIncomingTransferTarget {
    pane: IPaneLike;
    transactionId: string;
    commandTarget: TWorkspaceCommandTarget | null;
    tab: IIncomingTransferTargetTab;
    previousActivePaneId: string | null;
}

interface IPreparedTransferItem {
    tabId: string;
    payload: TSplitPayload;
    commandTarget: TWorkspaceCommandTarget | null;
    session: IWindowTabTransferSessionState | null;
    mutationFrontier: string | null;
}

interface IRestoreWorkspacePayloadOptions {
    retainPayloadOnFailure?: boolean;
    target: IIncomingTransferTarget;
}

interface IUseWindowTabTransfersOptions {
    activePaneId: Ref<string | null>;
    panes: Ref<IPaneLike[]>;
    tabs: Ref<ITab[]>;
    layout: Ref<TEditorLayoutNode | null>;
    createTab: (options: {
        paneId?: string;
        activate?: boolean;
    }) => ITab;
    getPaneById: (paneId: string | null | undefined) => IPaneLike | null;
    getTabById: (tabId: string | null | undefined) => ITab | null;
    getPaneByTabId: (tabId: string) => IPaneLike | null;
    activatePane: (paneId: string) => void;
    activateTab: (paneId: string, tabId: string) => void;
    removeTabFromState: (tabId: string) => void;
    cleanupEmptyPanes: () => void;
    closeTabInState: (paneId: string, tabId: string) => void;
    documentSessions: TWorkspaceDocumentSessions;
    workspaceRestoreTracker: {
        start: (tabId: string) => void;
        finish: (tabId: string) => void;
    };
    handleCloseTab: (paneId: string, tabId: string) => Promise<void>;
    handoffActiveTabBeforeClose: (paneId: string, tabId: string) => Promise<void>;
}

const DEFAULT_CAPTURE_TIMEOUT_MS = 4000;

export const useWindowTabTransfers = (options: IUseWindowTabTransfersOptions) => {
    const { t } = useTypedI18n();

    function getDocumentSession(tabId: string | null | undefined) {
        return options.documentSessions.getSession(tabId);
    }

    async function waitForWorkspace(tabId: string) {
        return await getDocumentSession(tabId)?.getView(tabId)?.whenMounted() ?? null;
    }

    function tabHoldsDocument(tabId: string) {
        const snapshot = getDocumentSession(tabId)?.snapshot.value;
        return snapshot !== undefined && identityHasDocument(snapshot.identity);
    }

    function getTransferSessionState(tabId: string): IWindowTabTransferSessionState | null {
        return createDocumentSessionTransferState(getDocumentSession(tabId));
    }

    function isCommandTargetCurrent(
        session: IWorkspaceDocumentController | null,
        target: TWorkspaceCommandTarget | null,
    ) {
        return !target || session?.validateCommandTarget(target).ok === true;
    }

    // A pane holding only an empty tab gives that tab to the transfer.
    function findReusableTransferTab(targetPane: IPaneLike) {
        const existingTab = targetPane.tabIds.length === 1 ? options.getTabById(targetPane.tabIds[0]) : null;
        const session = getDocumentSession(existingTab?.id);
        return existingTab && session && !snapshotOccupiesTab(session.snapshot.value) ? existingTab : null;
    }

    function createIncomingTransferTargetTab(targetPane: IPaneLike): IIncomingTransferTargetTab {
        const createdTab = options.createTab({
            paneId: targetPane.paneId,
            activate: true,
        });

        return {
            tabId: createdTab.id,
            created: true,
            previousActiveTabId: targetPane.activeTabId,
        };
    }

    function reuseIncomingTransferTargetTab(targetPane: IPaneLike, existingTab: ITab): IIncomingTransferTargetTab {
        const previousActiveTabId = targetPane.activeTabId;
        options.activatePane(targetPane.paneId);
        options.activateTab(targetPane.paneId, existingTab.id);
        return {
            tabId: existingTab.id,
            created: false,
            previousActiveTabId,
        };
    }

    function resolveIncomingTransferTargetTab(targetPaneId: string): IIncomingTransferTargetTab | null {
        const targetPane = options.getPaneById(targetPaneId);
        if (!targetPane) {
            return null;
        }

        const existingTab = findReusableTransferTab(targetPane);
        if (existingTab) {
            return reuseIncomingTransferTargetTab(targetPane, existingTab);
        }

        return createIncomingTransferTargetTab(targetPane);
    }

    function acknowledgeTransfer(transferId: string, success: boolean, error?: string) {
        return getWindowTabsCapability().transferAck({
            transferId,
            success,
            ...(error ? {error} : {}),
        });
    }

    function resolveIncomingTransferTargetPane() {
        return options.getPaneById(options.activePaneId.value) ?? options.panes.value[0] ?? null;
    }

    function removeCreatedTransferTab(targetTab: {
        tabId: string;
        created: boolean;
    }) {
        if (targetTab.created) {
            options.removeTabFromState(targetTab.tabId);
        }
    }

    function activateIncomingTransferTab(targetPaneId: string, targetTabId: string) {
        options.activatePane(targetPaneId);
        options.activateTab(targetPaneId, targetTabId);
    }

    function isIncomingTransferSessionCurrent(targetTabId: string, transfer: IWindowTabIncomingTransfer) {
        const expected = transfer.session;
        if (!expected) {
            return true;
        }
        const snapshot = getDocumentSession(targetTabId)?.snapshot.value ?? null;
        // A newly claimed target is intentionally empty until the durable
        // transfer decision commits. It has no document instance to compare
        // yet. A non-empty instance here means another document owns the
        // target, so reject the transfer before it can restore anything.
        if (!snapshot?.identity.documentInstanceId) {
            return true;
        }
        return (expected.documentInstanceId ?? null) === (snapshot?.identity.documentInstanceId ?? null);
    }

    async function prepareIncomingTransferTarget(transfer: IWindowTabIncomingTransfer): Promise<IIncomingTransferTarget | null> {
        const targetPane = resolveIncomingTransferTargetPane();
        if (!targetPane) {
            await acknowledgeTransfer(transfer.transferId, false, t('tabs.transferErrors.noTargetPane'));
            return null;
        }

        const targetTab = resolveIncomingTransferTargetTab(targetPane.paneId);
        if (!targetTab) {
            await acknowledgeTransfer(transfer.transferId, false, t('tabs.transferErrors.noTargetTab'));
            return null;
        }

        const session = getDocumentSession(targetTab.tabId)!;
        const target: IIncomingTransferTarget = {
            pane: targetPane,
            // The controller occupies the tab synchronously, before this async
            // preparation returns and before another incoming event picks a tab.
            transactionId: session.claimOpen({
                kind: transfer.payload.kind === 'pdfSnapshot' && transfer.payload.isDirty ? 'restore' : 'open',
                target: transfer.tab,
            }, () => {
                target.commandTarget = session.createCommandTarget(targetTab.tabId);
            }),
            commandTarget: null,
            tab: targetTab,
            previousActivePaneId: options.activePaneId.value,
        };
        return target;
    }

    function restoreTransferFocus(target: IIncomingTransferTarget) {
        const previousPaneId = target.previousActivePaneId;
        if (!previousPaneId) {
            return;
        }

        const previousPane = options.getPaneById(previousPaneId);
        options.activatePane(previousPaneId);
        const previousTabId = previousPane?.activeTabId ?? null;
        if (previousTabId) {
            options.activateTab(previousPaneId, previousTabId);
        }
    }

    async function rollbackIncomingTransferTarget(
        target: IIncomingTransferTarget,
        payload: TSplitPayload,
        shouldCleanupPayload = true,
        closeRestoredWorkspace = false,
        ownership?: IDocumentOperationOwnership,
    ) {
        const snapshot = getDocumentSession(target.tab.tabId)?.snapshot.value;
        if ((snapshot?.activeTransaction && snapshot.activeTransaction.id !== target.transactionId)
            || (!closeRestoredWorkspace && snapshot?.phase === 'presented')) {
            return;
        }
        if (closeRestoredWorkspace && tabHoldsDocument(target.tab.tabId)) {
            await getDocumentSession(target.tab.tabId)?.close({
                persist: false,
                ...(ownership ? {ownership} : {}),
            });
        }

        if (target.tab.created) {
            removeCreatedTransferTab(target.tab);
            restoreTransferFocus(target);
            if (shouldCleanupPayload) {
                await cleanupSplitPayloadSnapshot(payload, {
                    logSection: 'tabs',
                    context: 'rollback-created-incoming-transfer-tab',
                    metadata: { tabId: target.tab.tabId },
                });
            }
            return;
        }

        if (target.tab.previousActiveTabId) {
            options.activateTab(target.pane.paneId, target.tab.previousActiveTabId);
        }
        restoreTransferFocus(target);
        if (shouldCleanupPayload) {
            await cleanupSplitPayloadSnapshot(payload, {
                logSection: 'tabs',
                context: 'rollback-incoming-transfer-tab',
                metadata: { tabId: target.tab.tabId },
            });
        }
    }

    async function captureWorkspaceTransferItem(
        tabId: string,
        ownership: IDocumentOperationOwnership,
        timeoutMs = DEFAULT_CAPTURE_TIMEOUT_MS,
    ): Promise<IPreparedTransferItem | null> {
        const session = getDocumentSession(tabId);
        let captureResultClaimed = false;
        const capturePromise = (async (): Promise<IPreparedTransferItem | null> => {
            const workspace = await waitForWorkspace(tabId);
            if (!workspace) {
                return null;
            }
            // An opening source owns a pending identity. Stable inactive
            // views can transfer without repainting their evicted pixels.
            if (session?.snapshot.value.activeTransaction) {
                await workspace.waitForDocumentOpenSettled();
            }
            await session?.prepareTransfer();
            const commandTarget = session?.createCommandTarget(tabId) ?? null;
            const mutationFrontier = session?.readMutationFrontier() ?? null;
            const payload = await workspace.captureSplitPayload(undefined, ownership.assertCurrent);
            if (!isCommandTargetCurrent(session, commandTarget)) {
                await cleanupSplitPayloadSnapshot(payload, {
                    logSection: 'tabs',
                    context: 'capture-workspace-payload-stale-session',
                    metadata: { tabId },
                });
                return null;
            }

            const snapshot = workspace.getToolbarSnapshot();
            const transferPayload = payload.kind === 'pdfSnapshot'
                ? {
                    ...payload,
                    viewState: {
                        zoom: snapshot.zoom,
                        zoomMode: snapshot.zoomMode,
                        viewMode: snapshot.viewMode,
                        viewRotation: snapshot.viewRotation,
                        showSidebar: snapshot.showSidebar,
                        continuousScroll: snapshot.continuousScroll,
                    },
                }
                : payload;

            return {
                tabId,
                payload: transferPayload,
                commandTarget,
                mutationFrontier,
                session: getTransferSessionState(tabId),
            };
        })();

        try {
            const result = await withTimeout(() => capturePromise, timeoutMs);
            captureResultClaimed = true;
            return result;
        } catch (error) {
            void capturePromise.then(async (lateResult) => {
                if (!captureResultClaimed && lateResult) {
                    await cleanupSplitPayloadSnapshot(lateResult.payload, {
                        logSection: 'tabs',
                        context: 'capture-workspace-payload-late-result',
                        metadata: { tabId },
                    });
                }
            }).catch(() => undefined);
            BrowserLogger.error('tabs', 'Failed to capture split payload', {
                tabId,
                error,
            }, {code: 'RENDERER_TAB_TRANSFER_OPERATION_FAILED'});
            return null;
        }
    }

    async function tryRestoreWorkspacePayload(tabId: string, payload: TSplitPayload, target: IIncomingTransferTarget) {
        try {
            const workspace = await waitForWorkspace(tabId);
            const session = getDocumentSession(tabId);
            if (!workspace || !session || session.snapshot.value.activeTransaction?.id !== target.transactionId) {
                return null;
            }
            const outcome = await workspace.restoreSplitPayload(payload, target.transactionId, () => {
                const commandTarget = target.commandTarget;
                return () => commandTarget !== null && isCommandTargetCurrent(session, commandTarget);
            });
            if (outcome.status !== 'opened') {
                BrowserLogger.warn('tabs', 'Split payload restore returned a non-success outcome', {
                    tabId,
                    payloadKind: payload.kind,
                    status: outcome.status,
                });
                return null;
            }
            const commandTarget = target.commandTarget;
            await nextTick();
            if (!commandTarget || !isCommandTargetCurrent(session, commandTarget)) {
                return null;
            }

            if (payload.kind === 'pdfSnapshot' && payload.viewState) {
                const viewState = payload.viewState;
                workspace.restoreViewState({
                    ...viewState,
                    currentPage: null,
                });
                if (workspace.getToolbarSnapshot().showSidebar !== viewState.showSidebar) {
                    workspace.handleToggleSidebar();
                }
            }

            if (payload.kind === 'pdfSnapshot' && !tabHoldsDocument(tabId)) {
                BrowserLogger.warn('tabs', 'Split payload restore finished without an opened document', {
                    tabId,
                    payloadKind: payload.kind,
                });
                return null;
            }

            return commandTarget;
        } catch (error) {
            BrowserLogger.error('tabs', 'Failed to restore split payload', {
                tabId,
                payloadKind: payload.kind,
                error,
            }, {code: 'RENDERER_TAB_TRANSFER_OPERATION_FAILED'});
            return null;
        }
    }

    async function restoreWorkspacePayload(
        tabId: string,
        payload: TSplitPayload | null,
        restoreOptions: IRestoreWorkspacePayloadOptions,
    ) {
        if (!payload) {
            return null;
        }
        if (payload.kind === 'empty') {
            BrowserLogger.warn('tabs', 'Rejected empty split payload for workspace restore', { tabId });
            return null;
        }

        options.workspaceRestoreTracker.start(tabId);
        let restored: TWorkspaceCommandTarget | null = null;
        try {
            restored = await tryRestoreWorkspacePayload(tabId, payload, restoreOptions.target);
            return restored;
        } finally {
            if (!restored && !restoreOptions.retainPayloadOnFailure) {
                await cleanupSplitPayloadSnapshot(payload, {
                    logSection: 'tabs',
                    context: 'restore-workspace-payload',
                    metadata: {tabId},
                });
            }
            options.workspaceRestoreTracker.finish(tabId);
        }
    }

    async function finalizeTransferredSourceTab(paneId: string, tabId: string, ownership: IDocumentOperationOwnership, ownsSource: () => boolean): Promise<TSourceTransferOutcome> {
        // The departing view's place is remembered while it and its source still exist.
        const session = getDocumentSession(tabId);
        options.workspaceRestoreTracker.start(tabId);
        try {
            await rememberReadingView(session, tabId);
            await options.handoffActiveTabBeforeClose(paneId, tabId);
            if (!ownsSource()) return 'failed';
            if (session && tabHoldsDocument(tabId) && session.views.value.size <= 1) {
                try {
                    if (!await session.close({
                        persist: false,
                        ownership,
                        assertCurrent: () => { if (!ownsSource()) throw new Error(t('tabs.transferErrors.sourceChanged')); },
                    })) return 'failed';
                } catch (error) {
                    BrowserLogger.error('tabs', 'Failed to close source workspace after transfer', {
                        tabId,
                        error,
                    }, {code: 'RENDERER_TAB_TRANSFER_OPERATION_FAILED'});
                    return 'failed';
                }
            }
            return 'success';
        } finally {
            options.workspaceRestoreTracker.finish(tabId);
        }
    }

    async function transferPreparedTabToTarget(
        item: IPreparedTransferItem,
        target: TWindowTabTransferTarget,
        ownership: IDocumentOperationOwnership,
    ): Promise<TSourceTransferOutcome> {
        const {
            tabId, payload, commandTarget, mutationFrontier,
        } = item;
        const session = getDocumentSession(tabId);
        let sourcePane = options.getPaneByTabId(tabId);
        let transferId: string | null = null;
        let result: TSourceTransferOutcome = 'failed';
        try {
            if (!session || !sourcePane || !isCommandTargetCurrent(session, commandTarget)) return result;
            const transfer = await getWindowTabsCapability().transfer({
                target,
                tab: describeTabDocument(session.snapshot.value),
                payload,
                ...(item.session === null ? {} : {session: item.session}),
            });
            if (!transfer.success) throw new Error(transfer.error ?? t('tabs.transferErrors.restoreFailed'));
            transferId = transfer.transferId;
            if (!isCommandTargetCurrent(session, commandTarget) || session.readMutationFrontier() !== mutationFrontier) {
                throw new Error(t('tabs.transferErrors.sourceChanged'));
            }
            sourcePane = options.getPaneByTabId(tabId);
            if (!sourcePane) throw new Error(t('tabs.transferErrors.sourceChanged'));
            result = await finalizeTransferredSourceTab(sourcePane.paneId, tabId, ownership, () => (
                isCommandTargetCurrent(session, commandTarget) && session.readMutationFrontier() === mutationFrontier
            ));
            if (result !== 'success') throw new Error(t('tabs.transferErrors.sourceChanged'));
            if (canUseNativeWindowTabTransfers() && !await acknowledgeTransfer(transferId, true)) {
                throw new Error(t('tabs.transferErrors.restoreFailed'));
            }
            const closesWindow = shouldCloseSourceWindowAfterTransfer(options.tabs.value.length, true);
            options.closeTabInState(options.getPaneByTabId(tabId)?.paneId ?? sourcePane.paneId, tabId);
            options.cleanupEmptyPanes();
            return closesWindow && await getWindowTabsCapability().closeCurrentWindow() ? 'window-closed' : result;
        } catch (error) {
            result = 'failed';
            BrowserLogger.warn('tabs', 'Cross-window transfer failed', {
                tabId,
                target,
                error,
            });
            if (transferId && canUseNativeWindowTabTransfers()) await acknowledgeTransfer(transferId, false, getErrorMessage(error));
            // A rejected decision can arrive after the owned close. The source
            // tab still exists, and the broker gives its snapshot back to it.
            if (session && getDocumentSession(tabId) === session && sourcePane && !tabHoldsDocument(tabId) && payload.kind !== 'empty') {
                activateIncomingTransferTab(sourcePane.paneId, tabId);
                const workspace = await waitForWorkspace(tabId);
                const transactionId = session.claimOpen({
                    kind: 'restore',
                    target: {
                        fileName: payload.kind === 'pdfSnapshot' ? payload.fileName : null,
                        originalPath: payload.kind === 'pdfSnapshot' ? payload.originalPath : payload.sourcePath,
                        isDjvu: payload.kind === 'djvu',
                    },
                });
                await workspace?.restoreSplitPayload(payload, transactionId);
                if (payload.kind === 'pdfSnapshot' && payload.viewState) {
                    workspace?.restoreViewState({
                        ...payload.viewState,
                        currentPage: payload.currentPage ?? null,
                    });
                }
            }
            session?.reportFailure({
                message: `${t('tabs.transferErrors.rolledBack')} ${getErrorMessage(error)}`,
                failure: null,
            });
            return result;
        } finally {
            if (result === 'failed' && tabHoldsDocument(tabId) && !(payload.kind === 'pdfSnapshot' && session?.snapshot.value.identity.workingCopyPath === payload.snapshotPath)) {
                await cleanupSplitPayloadSnapshot(payload, {
                    logSection: 'tabs',
                    context: 'transfer-rolled-back',
                    metadata: {tabId},
                });
            }
        }
    }

    async function transferTabToTarget(tabId: string, target: TWindowTabTransferTarget): Promise<TSourceTransferOutcome> {
        const session = getDocumentSession(tabId);
        if (!session) return 'failed';
        return session.operationLease.runExclusive('tab-transfer', async (ownership) => {
            const item = await captureWorkspaceTransferItem(tabId, ownership);
            if (!item || (tabHoldsDocument(tabId) && item.payload.kind === 'empty')) {
                session.reportFailure({
                    message: t('tabs.transferErrors.rolledBack'),
                    failure: null,
                });
                return 'failed' as const;
            }
            return transferPreparedTabToTarget(item, target, ownership);
        });
    }

    async function moveTabToNewWindow(tabId?: string) {
        const resolvedTabId = tabId;
        if (!resolvedTabId) {
            return;
        }
        await transferTabToTarget(resolvedTabId, {kind: 'new-window'});
    }

    async function moveTabToWindow(targetWindowId: number, tabId?: string) {
        const resolvedTabId = tabId;
        if (!resolvedTabId) {
            return;
        }
        await transferTabToTarget(resolvedTabId, {
            kind: 'window',
            windowId: targetWindowId,
        });
    }

    async function mergeWindowInto(targetWindowId: number) {
        const orderedTabIds = collectMergeTabOrder(options.layout.value, options.panes.value, options.tabs.value);
        for (const tabId of orderedTabIds) {
            const result = await transferTabToTarget(tabId, {
                kind: 'window',
                windowId: targetWindowId,
            });
            if (result !== 'success') return;
        }
    }

    async function processIncomingTabTransfer(transfer: IWindowTabIncomingTransfer, target: IIncomingTransferTarget) {
        let transferCommitted = false;
        try {
            if (!isIncomingTransferSessionCurrent(target.tab.tabId, transfer)) {
                await rollbackIncomingTransferTarget(target, transfer.payload);
                await acknowledgeTransfer(transfer.transferId, false, t('tabs.transferErrors.restoreFailed'));
                return;
            }
            if (canUseNativeWindowTabTransfers()) {
                const restored = await restoreWorkspacePayload(target.tab.tabId, transfer.payload, {
                    retainPayloadOnFailure: true,
                    target,
                });
                if (!restored || !isCommandTargetCurrent(getDocumentSession(target.tab.tabId), restored)) {
                    await rollbackIncomingTransferTarget(target, transfer.payload, false);
                    await acknowledgeTransfer(transfer.transferId, false, t('tabs.transferErrors.restoreFailed'));
                    return;
                }
                const session = getDocumentSession(target.tab.tabId);
                const commandTarget = restored;
                const committed = await session!.operationLease.runExclusive('tab-transfer', async (ownership) => {
                    const accepted = await acknowledgeTransfer(transfer.transferId, true);
                    if (!accepted && isCommandTargetCurrent(session, commandTarget)) {
                        await rollbackIncomingTransferTarget(target, transfer.payload, false, true, ownership);
                    }
                    return accepted;
                });
                if (!committed) return;
                transferCommitted = true;
            } else {
                const committed = await acknowledgeTransfer(transfer.transferId, true);
                if (committed === null) {
                    return;
                }
                if (!committed) {
                    await cleanupSplitPayloadSnapshot(transfer.payload, {
                        logSection: 'tabs',
                        context: 'incoming-transfer-aborted-before-restore',
                        metadata: {tabId: target.tab.tabId},
                    });
                    if (target.tab.created) removeCreatedTransferTab(target.tab);
                    return;
                }
                transferCommitted = true;
                const restored = await restoreWorkspacePayload(target.tab.tabId, transfer.payload, {
                    retainPayloadOnFailure: true,
                    target,
                });
                if (!restored) {
                    return;
                }
            }
            // The browser capability ACK is source-authorized only after its
            // shared transfer decision commits. Apply the tab state only
            // after the committed payload becomes the editable workspace.
            activateIncomingTransferTab(target.pane.paneId, target.tab.tabId);
        } catch (error) {
            BrowserLogger.error('tabs', 'Unhandled incoming tab transfer failure', {
                transferId: transfer.transferId,
                error,
            }, {code: 'RENDERER_TAB_TRANSFER_OPERATION_FAILED'});

            if (transferCommitted) {
                return;
            }
            if (target) {
                await rollbackIncomingTransferTarget(target, transfer.payload, false, true);
            }
            await acknowledgeTransfer(transfer.transferId, false, getErrorMessage(error));
        } finally {
            const session = getDocumentSession(target?.tab.tabId);
            if (session?.snapshot.value.activeTransaction?.id === target?.transactionId) {
                session?.markFailed(null);
            }
        }
    }

    async function handleIncomingTabTransfer(transfer: IWindowTabIncomingTransfer) {
        const target = await prepareIncomingTransferTarget(transfer);
        if (!target) return;
        return processIncomingTabTransfer(transfer, target);
    }

    return {
        handleIncomingTabTransfer,
        moveTabToNewWindow,
        moveTabToWindow,
        mergeWindowInto,
    };
};
