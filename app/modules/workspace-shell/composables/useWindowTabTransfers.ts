import type { Ref } from 'vue';
import type {
    ITransferredTabState,
    IWindowTabTransferSessionState,
    IWindowTabIncomingTransfer,
    TSplitPayload,
    TWindowTabTransferTarget,
} from '@contracts/windowTabs';
import type { TEditorLayoutNode } from '@contracts/editorPanes';
import type {ITab} from '@app/types/tabs';
import type { IWorkspaceExpose } from '@app/types/workspaceExpose';
import { BrowserLogger } from '@app/utils/browserLogger';
import { collectMergeTabOrder } from '@app/modules/workspace-shell/window-tabs/collectMergeTabOrder';
import { shouldCloseSourceWindowAfterTransfer } from '@app/modules/workspace-shell/window-tabs/shouldCloseSourceWindowAfterTransfer';
import { workspaceHasPdf } from '@app/modules/workspace-shell/state/workspaceHasPdf';
import { cleanupSplitPayloadSnapshot } from '@app/modules/workspace-shell/splits/cleanupSplitPayloadSnapshot';
import {
    canUseNativeWindowTabTransfers,
    getWindowTabsCapability,
} from '@app/utils/platformWindowTabs';
import { getErrorMessage } from '@app/utils/error';
import { parseSessionId } from '@contracts/shared';
import { withTimeout } from 'es-toolkit/promise';
import { createWorkspaceSplitCacheSessionState } from '@app/modules/workspace-shell/document-sessions/createWorkspaceSplitCacheSessionState';
import type { IWorkspaceDocumentController } from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import type { TWorkspaceCommandTarget } from '@app/modules/workspace-shell/document-sessions/workspaceCommandTarget';
import { resolveDocumentRefBackend } from '@app/utils/documentRef';

interface IPaneLike {
    paneId: string;
    activeTabId: string | null;
    tabIds: string[];
}

type TSourceTransferOutcome = 'success' | 'failed' | 'window-closed';

interface IIncomingTransferTargetTab {
    tabId: string;
    created: boolean;
    previousTabState: Partial<ITab> | null;
    previousActiveTabId: string | null;
}

interface IIncomingTransferTarget {
    pane: IPaneLike;
    tab: IIncomingTransferTargetTab;
    previousActivePaneId: string | null;
}

interface IPreparedTransferItem {
    tabId: string;
    payload: TSplitPayload;
    commandTarget: TWorkspaceCommandTarget | null;
    session: IWindowTabTransferSessionState | null;
}

interface IRestoreWorkspacePayloadOptions {retainPayloadOnFailure?: boolean;}

interface IUseWindowTabTransfersOptions {
    activePaneId: Ref<string | null>;
    panes: Ref<IPaneLike[]>;
    tabs: Ref<ITab[]>;
    layout: Ref<TEditorLayoutNode | null>;
    createTab: (options: {
        paneId?: string;
        activate?: boolean;
        initial?: Partial<ITab>;
    }) => ITab;
    getPaneById: (paneId: string | null | undefined) => IPaneLike | null;
    getTabById: (tabId: string | null | undefined) => ITab | null;
    getPaneByTabId: (tabId: string) => IPaneLike | null;
    activatePane: (paneId: string) => void;
    activateTab: (paneId: string, tabId: string) => void;
    removeTabFromState: (tabId: string) => void;
    updateTab: (tabId: string, updates: Partial<ITab>) => void;
    cleanupEmptyPanes: () => void;
    closeTabInState: (paneId: string, tabId: string) => void;
    workspaceRefs: Ref<Map<string, IWorkspaceExpose>>;
    documentSessionsByTabId?: Ref<Record<string, IWorkspaceDocumentController>>;
    waitForWorkspace: (tabId: string, timeoutMs?: number) => Promise<IWorkspaceExpose | null>;
    workspaceRestoreTracker: {
        start: (tabId: string) => void;
        finish: (tabId: string) => void;
    };
    handleCloseTab: (paneId: string, tabId: string) => Promise<void>;
    handoffActiveTabBeforeClose: (paneId: string, tabId: string) => Promise<void>;
}

const DEFAULT_CAPTURE_TIMEOUT_MS = 4000;
const MERGE_CAPTURE_TIMEOUT_MS = 4000;

function buildTransferredTabState(
    tab: ITab,
    session: IWorkspaceDocumentController | null,
): ITransferredTabState {
    const sessionTab = session?.toWorkspaceRecord().tab;
    const originalPath = sessionTab?.originalPath ?? tab.originalPath;
    const originalBackend = resolveDocumentRefBackend(originalPath);
    const documentInstanceId = sessionTab?.documentInstanceId ?? tab.documentInstanceId ?? null;
    return {
        fileName: sessionTab?.fileName ?? tab.fileName,
        originalPath,
        ...(originalBackend === undefined ? {} : {originalBackend}),
        documentInstanceId,
        isDirty: sessionTab?.isDirty ?? tab.isDirty,
        isDjvu: sessionTab?.isDjvu ?? tab.isDjvu,
    };
}

function isPlaceholderTab(tab: ITab) {
    return tab.fileName === null
        && tab.originalPath === null
        && !tab.isDirty
        && !tab.isDjvu;
}

function isOnlyOpenTargetTab(targetPane: IPaneLike) {
    return targetPane.tabIds.length === 1;
}

function canReuseIncomingTransferTab(
    tab: ITab | null,
    targetPane: IPaneLike,
    existingHasDocument: boolean,
): tab is ITab {
    return !!tab
        && isOnlyOpenTargetTab(targetPane)
        && isPlaceholderTab(tab)
        && !existingHasDocument;
}

function cloneTabTransferState(tab: ITab): Partial<ITab> {
    return {
        fileName: tab.fileName,
        originalPath: tab.originalPath,
        ...(tab.originalBackend === undefined ? {} : {originalBackend: tab.originalBackend}),
        documentInstanceId: tab.documentInstanceId ?? null,
        isDirty: tab.isDirty,
        isDjvu: tab.isDjvu,
    };
}

export const useWindowTabTransfers = (options: IUseWindowTabTransfersOptions) => {
    const { t } = useTypedI18n();

    function getDocumentSession(tabId: string | null | undefined) {
        return tabId ? options.documentSessionsByTabId?.value[tabId] ?? null : null;
    }

    function getTransferSessionState(tabId: string): IWindowTabTransferSessionState | null {
        const state = createWorkspaceSplitCacheSessionState(getDocumentSession(tabId));
        if (!state) {
            return null;
        }
        const sessionId = parseSessionId(state.sessionId);
        return sessionId === null ? null : {
            ...state,
            sessionId,
        };
    }

    function isCommandTargetCurrent(
        session: IWorkspaceDocumentController | null,
        target: TWorkspaceCommandTarget | null,
    ) {
        return !target || session?.validateCommandTarget(target).ok === true;
    }

    function getIncomingTransferTabContext(targetPane: IPaneLike) {
        const existingTabId = targetPane.tabIds[0] ?? null;
        const existingTab = options.getTabById(existingTabId);
        const existingWorkspace = existingTabId ? options.workspaceRefs.value.get(existingTabId) ?? null : null;

        return {
            existingTab,
            existingHasDocument: workspaceHasPdf(existingWorkspace),
        };
    }

    function createIncomingTransferTargetTab(targetPane: IPaneLike): IIncomingTransferTargetTab {
        const createdTab = options.createTab({
            paneId: targetPane.paneId,
            activate: true,
        });

        return {
            tabId: createdTab.id,
            created: true,
            previousTabState: null,
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
            previousTabState: cloneTabTransferState(existingTab),
            previousActiveTabId,
        };
    }

    function resolveIncomingTransferTargetTab(targetPaneId: string): IIncomingTransferTargetTab | null {
        const targetPane = options.getPaneById(targetPaneId);
        if (!targetPane) {
            return null;
        }

        const {
            existingTab,
            existingHasDocument,
        } = getIncomingTransferTabContext(targetPane);
        if (canReuseIncomingTransferTab(existingTab, targetPane, existingHasDocument)) {
            return reuseIncomingTransferTargetTab(targetPane, existingTab);
        }

        return createIncomingTransferTargetTab(targetPane);
    }

    async function ackIncomingTransferFailure(transferId: string, error: string) {
        try {
            const acked = await getWindowTabsCapability().transferAck({
                transferId,
                success: false,
                error,
            });
            if (!acked) {
                BrowserLogger.warn('tabs', 'Incoming tab transfer failure ack was not accepted', {
                    transferId,
                    error,
                });
            }
        } catch (ackError) {
            BrowserLogger.warn('tabs', 'Failed to ack incoming tab transfer failure', {
                transferId,
                error,
                ackError,
            });
        }
    }

    async function ackIncomingTransferSuccess(transferId: string): Promise<boolean | null> {
        try {
            const acked = await getWindowTabsCapability().transferAck({
                transferId,
                success: true,
            });
            if (!acked) {
                BrowserLogger.warn('tabs', 'Incoming tab transfer success ack was not accepted', { transferId });
            }
            return acked;
        } catch (ackError) {
            BrowserLogger.warn('tabs', 'Failed to ack incoming tab transfer success', {
                transferId,
                ackError,
            });
            return null;
        }
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

    function applyIncomingTransferTabState(targetPaneId: string, targetTabId: string, transfer: IWindowTabIncomingTransfer) {
        options.updateTab(targetTabId, transfer.tab);
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

    async function prepareIncomingTransferTarget(transferId: string): Promise<IIncomingTransferTarget | null> {
        const targetPane = resolveIncomingTransferTargetPane();
        if (!targetPane) {
            await ackIncomingTransferFailure(transferId, t('tabs.transferErrors.noTargetPane'));
            return null;
        }

        const targetTab = resolveIncomingTransferTargetTab(targetPane.paneId);
        if (!targetTab) {
            await ackIncomingTransferFailure(transferId, t('tabs.transferErrors.noTargetTab'));
            return null;
        }

        return {
            pane: targetPane,
            tab: targetTab,
            previousActivePaneId: options.activePaneId.value,
        };
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
    ) {
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

        if (target.tab.previousTabState) {
            options.updateTab(target.tab.tabId, target.tab.previousTabState);
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
        timeoutMs = DEFAULT_CAPTURE_TIMEOUT_MS,
    ): Promise<IPreparedTransferItem | null> {
        const session = getDocumentSession(tabId);
        const commandTarget = session?.createCommandTarget() ?? null;
        if (!isCommandTargetCurrent(session, commandTarget)) {
            return null;
        }

        let captureResultClaimed = false;
        const capturePromise = (async (): Promise<IPreparedTransferItem | null> => {
            const workspace = await options.waitForWorkspace(tabId, timeoutMs);
            if (!workspace) {
                return null;
            }

            if (!isCommandTargetCurrent(session, commandTarget)) {
                return null;
            }

            const payload = await workspace.captureSplitPayload();
            if (!isCommandTargetCurrent(session, commandTarget)) {
                await cleanupSplitPayloadSnapshot(payload, {
                    logSection: 'tabs',
                    context: 'capture-workspace-payload-stale-session',
                    metadata: { tabId },
                });
                return null;
            }

            return {
                tabId,
                payload,
                commandTarget,
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
            }, {
                code: 'RENDERER_TAB_TRANSFER_OPERATION_FAILED',
                context: {},
            });
            return null;
        }
    }

    async function captureWorkspacePayload(
        tabId: string,
        timeoutMs = DEFAULT_CAPTURE_TIMEOUT_MS,
    ): Promise<TSplitPayload | null> {
        return (await captureWorkspaceTransferItem(tabId, timeoutMs))?.payload ?? null;
    }

    async function tryRestoreWorkspacePayload(tabId: string, payload: TSplitPayload) {
        try {
            const workspace = await options.waitForWorkspace(tabId);
            if (!workspace) {
                return false;
            }
            const outcome = await workspace.restoreSplitPayload(payload);
            if (outcome.status !== 'opened') {
                BrowserLogger.warn('tabs', 'Split payload restore returned a non-success outcome', {
                    tabId,
                    payloadKind: payload.kind,
                    status: outcome.status,
                });
                return false;
            }
            await nextTick();

            if (payload.kind === 'pdfSnapshot' && !workspaceHasPdf(workspace)) {
                BrowserLogger.warn('tabs', 'Split payload restore finished without an opened document', {
                    tabId,
                    payloadKind: payload.kind,
                });
                return false;
            }

            return true;
        } catch (error) {
            BrowserLogger.error('tabs', 'Failed to restore split payload', {
                tabId,
                payloadKind: payload.kind,
                error,
            }, {
                code: 'RENDERER_TAB_TRANSFER_OPERATION_FAILED',
                context: {},
            });
            return false;
        }
    }

    async function cleanupFailedRestorePayload(tabId: string, payload: TSplitPayload) {
        await cleanupSplitPayloadSnapshot(payload, {
            logSection: 'tabs',
            context: 'restore-workspace-payload',
            metadata: { tabId },
        });
    }

    async function restoreWorkspacePayload(
        tabId: string,
        payload: TSplitPayload | null,
        restoreOptions: IRestoreWorkspacePayloadOptions = {},
    ) {
        if (!payload) {
            return false;
        }
        if (payload.kind === 'empty') {
            BrowserLogger.warn('tabs', 'Rejected empty split payload for workspace restore', { tabId });
            return false;
        }

        options.workspaceRestoreTracker.start(tabId);
        let restored = false;
        try {
            restored = await tryRestoreWorkspacePayload(tabId, payload);
            return restored;
        } finally {
            if (!restored && !restoreOptions.retainPayloadOnFailure) {
                await cleanupFailedRestorePayload(tabId, payload);
            }
            options.workspaceRestoreTracker.finish(tabId);
        }
    }

    async function closeSourceWorkspaceWithoutPersist(paneId: string, tabId: string) {
        await options.handoffActiveTabBeforeClose(paneId, tabId);

        const workspace = options.workspaceRefs.value.get(tabId);
        if (!workspace || !workspaceHasPdf(workspace)) {
            return true;
        }

        options.workspaceRestoreTracker.start(tabId);
        try {
            return await getDocumentSession(tabId)?.close({persist: false})
                ?? await workspace.handleCloseFileFromUi({persist: false});
        } catch (error) {
            BrowserLogger.error('tabs', 'Failed to close source workspace after transfer', {
                tabId,
                error,
            }, {
                code: 'RENDERER_TAB_TRANSFER_OPERATION_FAILED',
                context: {},
            });
            return false;
        } finally {
            options.workspaceRestoreTracker.finish(tabId);
        }
    }

    async function finalizeTransferredSourceTab(paneId: string, tabId: string): Promise<TSourceTransferOutcome> {
        const sourceCloseSucceeded = await closeSourceWorkspaceWithoutPersist(paneId, tabId);
        if (!sourceCloseSucceeded) {
            return 'failed';
        }

        if (shouldCloseSourceWindowAfterTransfer(options.tabs.value.length, true)) {
            const closed = await getWindowTabsCapability().closeCurrentWindow();
            if (closed) {
                return 'window-closed';
            }
        }

        options.closeTabInState(paneId, tabId);
        options.cleanupEmptyPanes();
        return 'success';
    }

    async function transferPreparedTabToTarget(
        item: IPreparedTransferItem,
        target: TWindowTabTransferTarget,
    ): Promise<TSourceTransferOutcome> {
        const {
            tabId,
            payload,
            commandTarget,
        } = item;
        const tab = options.getTabById(tabId);
        const sourcePane = options.getPaneByTabId(tabId);
        if (!tab || !sourcePane) {
            await cleanupSplitPayloadSnapshot(payload, {
                logSection: 'tabs',
                context: 'transfer-tab-source-missing',
                metadata: {
                    tabId,
                    target,
                },
            });
            return 'failed';
        }

        if (!isCommandTargetCurrent(getDocumentSession(tab.id), commandTarget)) {
            await cleanupSplitPayloadSnapshot(payload, {
                logSection: 'tabs',
                context: 'transfer-tab-source-stale-before-transfer',
                metadata: {
                    tabId,
                    target,
                },
            });
            return 'failed';
        }

        let transferResult;
        try {
            transferResult = await getWindowTabsCapability().transfer({
                target,
                tab: buildTransferredTabState(tab, getDocumentSession(tab.id)),
                payload,
                ...(item.session === null ? {} : {session: item.session}),
            });
        } catch (error) {
            BrowserLogger.error('tabs', 'Cross-window transfer threw before completion', {
                tabId,
                target,
                error,
            }, {
                code: 'RENDERER_TAB_TRANSFER_OPERATION_FAILED',
                context: {},
            });
            await cleanupSplitPayloadSnapshot(payload, {
                logSection: 'tabs',
                context: 'transfer-tab-to-target-error',
                metadata: {
                    tabId,
                    target,
                },
            });
            return 'failed';
        }

        if (!transferResult.success) {
            BrowserLogger.warn('tabs', 'Cross-window transfer failed', {
                tabId,
                target,
                error: transferResult.error,
            });
            await cleanupSplitPayloadSnapshot(payload, {
                logSection: 'tabs',
                context: 'transfer-tab-to-target',
                metadata: {
                    tabId,
                    target,
                },
            });
            return 'failed';
        }

        if (!isCommandTargetCurrent(getDocumentSession(tab.id), commandTarget)) {
            BrowserLogger.warn('tabs', 'Cross-window transfer source changed before source cleanup', {
                tabId,
                target,
            });
            return 'failed';
        }

        return finalizeTransferredSourceTab(sourcePane.paneId, tab.id);
    }

    function tabRequiresNonEmptyTransferPayload(tab: ITab | null) {
        return Boolean(tab?.originalPath ?? tab?.fileName ?? tab?.isDirty ?? tab?.isDjvu);
    }

    function isValidTransferPayloadForTab(tab: ITab | null, payload: TSplitPayload) {
        return !(tabRequiresNonEmptyTransferPayload(tab) && payload.kind === 'empty');
    }

    async function transferTabToTarget(tabId: string, target: TWindowTabTransferTarget): Promise<TSourceTransferOutcome> {
        const item = await captureWorkspaceTransferItem(tabId);
        if (!item) {
            return 'failed';
        }
        const tab = options.getTabById(tabId);
        if (!isValidTransferPayloadForTab(tab, item.payload)) {
            BrowserLogger.warn('tabs', 'Rejected empty split payload for document tab transfer', {
                tabId,
                target,
                fileName: tab?.fileName ?? null,
                originalPath: tab?.originalPath ?? null,
                isDirty: tab?.isDirty ?? false,
                isDjvu: tab?.isDjvu ?? false,
            });
            return 'failed';
        }

        return transferPreparedTabToTarget(item, target);
    }

    async function cleanupPreparedMergeItems(items: IPreparedTransferItem[], context: string) {
        await Promise.all(items.map(item => cleanupSplitPayloadSnapshot(item.payload, {
            logSection: 'tabs',
            context,
            metadata: { tabId: item.tabId },
        })));
    }

    async function captureMergeTransferItems(orderedTabIds: string[]) {
        const sourceTabIds = orderedTabIds.filter(tabId => Boolean(options.getTabById(tabId)));
        const captures = await Promise.all(sourceTabIds.map(async (tabId): Promise<IPreparedTransferItem | null> => {
            return captureWorkspaceTransferItem(tabId, MERGE_CAPTURE_TIMEOUT_MS);
        }));
        const prepared = captures.filter((item): item is IPreparedTransferItem => item !== null);
        if (prepared.length !== sourceTabIds.length) {
            await cleanupPreparedMergeItems(prepared, 'merge-window-preflight-failed');
            return null;
        }

        return prepared;
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
        const preparedItems = await captureMergeTransferItems(orderedTabIds);
        if (!preparedItems) {
            return;
        }

        const pendingItems = new Map(preparedItems.map(item => [
            item.tabId,
            item,
        ]));
        for (const item of preparedItems) {
            pendingItems.delete(item.tabId);
            const result = await transferPreparedTabToTarget(item, {
                kind: 'window',
                windowId: targetWindowId,
            });

            if (result === 'failed' || result === 'window-closed') {
                await cleanupPreparedMergeItems([...pendingItems.values()], 'merge-window-aborted');
                return;
            }
        }
    }

    async function processIncomingTabTransfer(transfer: IWindowTabIncomingTransfer) {
        let target: IIncomingTransferTarget | null = null;
        let transferCommitted = false;
        try {
            target = await prepareIncomingTransferTarget(transfer.transferId);
            if (!target) {
                return;
            }

            if (!isIncomingTransferSessionCurrent(target.tab.tabId, transfer)) {
                await rollbackIncomingTransferTarget(target, transfer.payload);
                await ackIncomingTransferFailure(transfer.transferId, t('tabs.transferErrors.restoreFailed'));
                return;
            }
            if (canUseNativeWindowTabTransfers()) {
                const restored = await restoreWorkspacePayload(target.tab.tabId, transfer.payload, {retainPayloadOnFailure: true});
                if (!restored) {
                    await rollbackIncomingTransferTarget(target, transfer.payload, false);
                    await ackIncomingTransferFailure(transfer.transferId, t('tabs.transferErrors.restoreFailed'));
                    return;
                }
                const committed = await ackIncomingTransferSuccess(transfer.transferId);
                if (committed === null || !committed) {
                    await rollbackIncomingTransferTarget(target, transfer.payload, false);
                    return;
                }
                transferCommitted = true;
            } else {
                const committed = await ackIncomingTransferSuccess(transfer.transferId);
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
                const restored = await restoreWorkspacePayload(target.tab.tabId, transfer.payload, {retainPayloadOnFailure: true});
                if (!restored) {
                    return;
                }
            }
            // The browser capability ACK is source-authorized only after its
            // shared transfer decision commits. Apply the tab state only
            // after the committed payload becomes the editable workspace.
            applyIncomingTransferTabState(target.pane.paneId, target.tab.tabId, transfer);
        } catch (error) {
            BrowserLogger.error('tabs', 'Unhandled incoming tab transfer failure', {
                transferId: transfer.transferId,
                error,
            }, {
                code: 'RENDERER_TAB_TRANSFER_OPERATION_FAILED',
                context: {},
            });

            if (transferCommitted) {
                return;
            }
            if (target) {
                await rollbackIncomingTransferTarget(target, transfer.payload);
            }
            await ackIncomingTransferFailure(transfer.transferId, getErrorMessage(error));
        }
    }

    let incomingTransferTail = Promise.resolve();

    function handleIncomingTabTransfer(transfer: IWindowTabIncomingTransfer) {
        // Incoming transfers arrive as fire-and-forget IPC events, so two can
        // overlap. Target acquisition reuses a pane's placeholder tab but only
        // fills it a few awaits later, so overlapping transfers would both claim
        // the same placeholder and the second would clobber the first. Serialize
        // them so each transfer finishes claiming and restoring before the next
        // resolves its target.
        const run = incomingTransferTail.then(() => processIncomingTabTransfer(transfer));
        incomingTransferTail = run.catch(() => undefined);
        return run;
    }

    return {
        captureWorkspacePayload,
        restoreWorkspacePayload,
        handleIncomingTabTransfer,
        moveTabToNewWindow,
        moveTabToWindow,
        mergeWindowInto,
    };
};
