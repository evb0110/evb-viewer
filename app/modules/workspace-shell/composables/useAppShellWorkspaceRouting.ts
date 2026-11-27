import type {Ref} from 'vue';
import {uniq} from 'es-toolkit/array';
import {BrowserLogger} from '@app/utils/browserLogger';
import {markStartupMetricOnce} from '@app/utils/startupMetrics';
import {logPdfRenderTrace} from '@app/utils/pdfRenderTrace';
import {readPdfPageShape} from '@app/modules/workspace-shell/composables/document-session/resolvePdfOpeningGeometry';
import {reportStartupFirstView} from '@app/modules/workspace-shell/composables/useWorkspaceStartupReadiness';
import type {IEditorPaneState} from '@contracts/editorPanes';
import type {ITab} from '@app/types/tabs';
import {parseDocumentRef, type TDocumentRef} from '@contracts/documentRef';
import type {TOpenFileResult} from '@contracts/electronApiDocuments';
import type {TWindowTabsAction} from '@contracts/windowTabs';
import type {ITabLifecycleState} from '@app/modules/workspace-shell/tabs/tabSessionStoreTypes';
import type {TWorkspaceDocumentSessions} from '@app/modules/workspace-shell/document-sessions/useWorkspaceDocumentSessions';
import {
    snapshotOccupiesTab,
    type IWorkspaceDocumentSnapshot,
} from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import {describeDocumentTarget, describeOpenResult} from '@app/modules/workspace-shell/document-sessions/describeDocumentTarget';

type TWorkspaceOpenDocumentTarget = TDocumentRef | TOpenFileResult;

interface IUseAppShellWorkspaceRoutingOptions {
    activePaneId: Ref<string | null>;
    activeTabId: Ref<string | null>;
    documentSessions: TWorkspaceDocumentSessions;
    tabLifecycleById: Readonly<Ref<Record<string, ITabLifecycleState>>>;
    createTab: (options: {paneId?: string | null; activate?: boolean}) => ITab;
    getTabById: (tabId: string | null | undefined) => ITab | null;
    removeTabFromState: (tabId: string) => void;
    resolveTabForAction: (tabId: string | undefined) => {
        tab: ITab;
        pane: IEditorPaneState;
    } | null;
    handleCloseTab: (paneId: string, tabId: string) => Promise<void>;
    moveTabToNewWindow: (tabId: string) => Promise<void>;
    moveTabToWindow: (windowId: number, tabId: string) => Promise<void>;
    mergeWindowInto: (windowId: number) => Promise<void>;
}

/** Decides which tab a document opens in and asks that tab's controller to open it. */
export const useAppShellWorkspaceRouting = (options: IUseAppShellWorkspaceRoutingOptions) => {
    const {activePaneId, activeTabId, documentSessions, createTab} = options;

    function createTabInPane(paneId: string) {
        createTab({
            paneId,
            activate: true,
        });
    }

    function canReuseTab(tabId: string | null) {
        const session = documentSessions.getSession(tabId);
        return session !== null && !snapshotOccupiesTab(session.snapshot.value);
    }

    function readFailure(tabId: string) {
        return documentSessions.getSession(tabId)?.snapshot.value.failure ?? null;
    }

    function isTargetMatchingSession(target: TWorkspaceOpenDocumentTarget, snapshot: IWorkspaceDocumentSnapshot) {
        const {identity} = snapshot;
        if (typeof target === 'string') {
            return identity.originalPath === target || identity.documentRef === target;
        }
        if (target.kind === 'pdf') {
            return (
                identity.workingCopyPath === target.workingPath ||
                identity.originalPath === target.originalPath ||
                identity.documentRef === target.originalPath
            );
        }
        if (target.kind === 'djvu') {
            return identity.originalPath === target.originalPath;
        }
        return false;
    }

    async function openInTab(tabId: string, target: TWorkspaceOpenDocumentTarget, signal?: AbortSignal) {
        const session = documentSessions.getSession(tabId);
        if (!session || signal?.aborted) {
            return false;
        }
        // A tab that is not shown opens its file when it is; until then it
        // only names it.
        if (typeof target === 'string' && options.tabLifecycleById.value[tabId]?.shouldMountHost === false) {
            const described = describeDocumentTarget(target);
            session.assign({
                fileName: described.fileName ?? null,
                originalPath: target,
                isDjvu: described.isDjvu === true,
                isDirty: false,
                deferredReaderOpen: true,
            });
            return true;
        }
        const view = session.getView(tabId);
        // The page's shape is asked for now, so the answer arrives while a new
        // tab's workspace mounts instead of after its open is claimed.
        const pageShape = typeof target === 'string' ? readPdfPageShape(target) : null;
        // This tab's own view opens the document once mounted. Until then the
        // open claims the tab, so no other open reuses it; a view that failed
        // or was removed answers null, and a claim another owner took is lost.
        const mounted = view?.mountedWorkspace.value ?? null;
        const claim =
            mounted || !view
                ? null
                : session.claimOpen(
                      typeof target === 'string'
                          ? {
                                kind: 'open',
                                target: describeDocumentTarget(target),
                            }
                          : describeOpenResult(target),
                  );
        let workspace = mounted;
        if (!workspace && view) {
            if (!signal) {
                workspace = await view.whenMounted();
            } else {
                let onAbort: (() => void) | null = null;
                try {
                    workspace = await Promise.race([
                        view.whenMounted(),
                        new Promise<null>((resolve) => {
                            if (signal.aborted) {
                                resolve(null);
                                return;
                            }
                            onAbort = () => resolve(null);
                            signal.addEventListener('abort', onAbort, {once: true});
                        }),
                    ]);
                } finally {
                    if (onAbort) {
                        signal.removeEventListener('abort', onAbort);
                    }
                }
            }
        }
        const claimed = claim === null || session.snapshot.value.activeTransaction?.id === claim;
        if (!workspace || session.getView(tabId) !== view || !claimed || signal?.aborted) {
            if (claim && claimed) {
                session.markFailed(null);
            }
            return false;
        }
        const preOpenInstanceId = session.snapshot.value.identity.documentInstanceId;
        const openPromise =
            typeof target === 'string'
                ? workspace.handleOpenFileDirectWithPersist(target, pageShape)
                : workspace.handleOpenFileWithResult(target);
        if (!signal) {
            return openPromise;
        }
        // Keep the abort signal bound to the workspace's open transaction so
        // timeout and presentation settle the same claim: canceling before
        // presentation aborts the transaction, while an already-committed
        // presentation settles as success.
        const openTransactionId = session.snapshot.value.activeTransaction?.id ?? null;
        let settled = false;
        let onAbort: (() => void) | null = null;
        try {
            return await new Promise<boolean>((resolve, reject) => {
                const finish = (opened: boolean) => {
                    if (settled) {
                        return;
                    }
                    settled = true;
                    resolve(opened);
                };
                const fail = (error: unknown) => {
                    if (settled) {
                        return;
                    }
                    settled = true;
                    reject(error);
                };
                const handleAbort = () => {
                    if (settled) {
                        return;
                    }
                    const currentSession = documentSessions.getSession(tabId);
                    const snap = currentSession?.snapshot.value;
                    const presentedThisOpen =
                        currentSession === session &&
                        snap !== undefined &&
                        snap.phase === 'presented' &&
                        snap.activeTransaction === null &&
                        snap.failure === null &&
                        snap.identity.documentInstanceId !== null &&
                        snap.identity.documentInstanceId !== preOpenInstanceId;
                    if (presentedThisOpen) {
                        finish(true);
                        return;
                    }
                    if (
                        currentSession === session &&
                        snap?.activeTransaction !== null &&
                        (openTransactionId === null || snap?.activeTransaction.id === openTransactionId)
                    ) {
                        session.markFailed(null);
                    }
                    finish(false);
                };
                onAbort = handleAbort;
                signal.addEventListener('abort', handleAbort, {once: true});
                openPromise.then(finish, fail);
                if (signal.aborted) {
                    handleAbort();
                }
            });
        } finally {
            if (onAbort) {
                signal.removeEventListener('abort', onAbort);
            }
        }
    }

    async function handleFallbackToolbarOpenFile() {
        const workspace = (await documentSessions.activeDocumentView.value?.whenMounted()) ?? null;
        if (workspace) {
            await workspace.handleOpenFileFromUi();
            return;
        }
        const fallbackTab = createTab({
            paneId: activePaneId.value,
            activate: true,
        });
        const fallbackWorkspace = (await documentSessions.getView(fallbackTab.id)?.whenMounted()) ?? null;
        if (!fallbackWorkspace) {
            options.removeTabFromState(fallbackTab.id);
            return;
        }
        await fallbackWorkspace.handleOpenFileFromUi();
    }

    // The new tab shows its own opening, as an open in the current tab does.
    // A document that does not open takes its tab with it and says why.
    async function handleOpenInNewTab(
        target: TWorkspaceOpenDocumentTarget,
        paneId?: string,
        placement: {
            activate: boolean;
            signal?: AbortSignal;
        } = {activate: true},
    ) {
        if (placement.signal?.aborted) {
            return false;
        }
        const outgoingTabId = activeTabId.value;
        const tab = createTab({
            paneId: paneId ?? activePaneId.value,
            activate: placement.activate,
        });
        let opened = false;
        try {
            opened = await openInTab(tab.id, target, placement.signal);
        } catch (error) {
            BrowserLogger.error(
                'workspace-routing',
                'New-tab document open failed',
                {
                    error,
                    tabId: tab.id,
                },
                {code: 'RENDERER_WORKSPACE_OPERATION_FAILED'},
            );
        }
        // If an aborted open already committed file state before presentation
        // settled, close that unpresented document so the tab does not stay open
        // after timeout reports failure. Another open or document keeps its tab.
        if (!opened && placement.signal?.aborted) {
            const abortedSession = documentSessions.getSession(tab.id);
            if (
                abortedSession &&
                abortedSession.snapshot.value.activeTransaction === null &&
                !canReuseTab(tab.id) &&
                isTargetMatchingSession(target, abortedSession.snapshot.value)
            ) {
                logPdfRenderTrace('pdf-open-replacement-rollback', {
                    failedTabId: tab.id,
                    restoredTabId: outgoingTabId,
                });
                // Start closing while the workspace view is still attached, then unmount
                // the tab immediately so a slow close cannot leave the aborted document
                // open or painting in the UI.
                const closePromise = abortedSession.close({}).catch(() => undefined);
                options.removeTabFromState(tab.id);
                await closePromise;
                return false;
            }
        }
        if (!opened && canReuseTab(tab.id)) {
            logPdfRenderTrace('pdf-open-replacement-rollback', {
                failedTabId: tab.id,
                restoredTabId: outgoingTabId,
            });
            options.removeTabFromState(tab.id);
        }
        return opened;
    }

    // A document that failed fails the same way in any tab, so it is reported
    // where it happened instead of retried in a new tab.
    async function openDocumentInAppropriateTab(target: TWorkspaceOpenDocumentTarget) {
        const tabId = activeTabId.value;
        if (tabId && canReuseTab(tabId)) {
            return openInTab(tabId, target);
        }
        return handleOpenInNewTab(target, activePaneId.value ?? undefined);
    }

    async function openResultInAppropriateTab(result: TOpenFileResult) {
        return openDocumentInAppropriateTab(result);
    }

    async function openPathInAppropriateTab(path: TDocumentRef) {
        const routeStartedAt = performance.now();
        logPdfRenderTrace('pdf-open-route-start', {
            path,
            immediateWorkspaceClaim: true,
        });
        let opened = false;
        try {
            opened = await openDocumentInAppropriateTab(path);
            return opened;
        } finally {
            logPdfRenderTrace('pdf-open-route-capability-end', {
                path,
                elapsedMs: performance.now() - routeStartedAt,
                failed: !opened,
                resultKind: null,
                immediateWorkspaceClaim: true,
            });
        }
    }

    function normalizeOpenPaths(paths: TDocumentRef[]) {
        return uniq(
            paths.flatMap((path) => {
                const parsed = path.trim().length > 0 ? parseDocumentRef(path) : null;
                return parsed === null ? [] : [parsed];
            }),
        );
    }

    async function openPathsInAppropriateTab(paths: TDocumentRef[]) {
        for (const [index, path] of normalizeOpenPaths(paths).entries()) {
            try {
                await openDocumentInAppropriateTab(path);
            } catch (error) {
                BrowserLogger.warn('workspace-routing', 'Failed to open dropped/external path in its own tab', {
                    path,
                    pathIndex: index,
                    error,
                });
            }
        }
    }

    /**
     * Opens the files the app was launched with. The first reuses the empty
     * startup tab; each other file gets its own tab, and the last one is
     * shown: the startup overlay ends when its open presents its first view.
     * Returns the paths no tab could take, for the main process to retry.
     */
    async function beginOpenPathsInAppropriateTab(paths: TDocumentRef[]) {
        const normalizedPaths = normalizeOpenPaths(paths);
        if (normalizedPaths.length === 0) {
            return [];
        }
        markStartupMetricOnce('evb:document-open-started');

        const reusableTabId = activeTabId.value && canReuseTab(activeTabId.value) ? activeTabId.value : null;
        const tabIds = normalizedPaths.map((_path, index) =>
            index === 0 && reusableTabId
                ? reusableTabId
                : createTab({
                      paneId: activePaneId.value,
                      activate: index === normalizedPaths.length - 1,
                  }).id,
        );
        const opens = normalizedPaths.map((path, index) => openInTab(tabIds[index]!, path));
        void reportStartupFirstView(opens.at(-1)!);
        const results = await Promise.allSettled(
            opens.map(async (opening, index) => {
                const tabId = tabIds[index]!;
                if (await opening) {
                    return;
                }
                const failure = readFailure(tabId);
                if (tabId !== reusableTabId && canReuseTab(tabId)) {
                    options.removeTabFromState(tabId);
                }
                if (!failure) {
                    throw new Error('Startup tab was not available for external open');
                }
            }),
        );
        return results.flatMap((result, index) => {
            if (result.status === 'fulfilled') {
                return [];
            }
            BrowserLogger.warn('workspace-routing', 'Failed to begin startup external path open', {
                path: normalizedPaths[index],
                pathIndex: index,
                error: result.reason as unknown,
            });
            return [normalizedPaths[index]!];
        });
    }

    async function handleWindowTabsAction(action: TWindowTabsAction) {
        if (action.kind === 'merge-window-into') {
            await options.mergeWindowInto(action.targetWindowId);
            return;
        }
        const resolved = options.resolveTabForAction(action.tabId);
        if (!resolved) {
            return;
        }
        if (action.kind === 'close-tab') {
            await options.handleCloseTab(resolved.pane.paneId, resolved.tab.id);
        } else if (action.kind === 'move-tab-to-new-window') {
            await options.moveTabToNewWindow(resolved.tab.id);
        } else {
            await options.moveTabToWindow(action.targetWindowId, resolved.tab.id);
        }
    }

    return {
        createTabInPane,
        handleFallbackToolbarOpenFile,
        handleOpenInNewTab,
        openResultInAppropriateTab,
        openPathInAppropriateTab,
        openPathsInAppropriateTab,
        beginOpenPathsInAppropriateTab,
        handleWindowTabsAction,
    };
};
