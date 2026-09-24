import type { Ref } from 'vue';
import { uniq } from 'es-toolkit/array';
import { BrowserLogger } from '@app/utils/browserLogger';
import { markStartupMetricOnce } from '@app/utils/startupMetrics';
import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';
import type { IEditorPaneState } from '@contracts/editorPanes';
import type { ITab } from '@app/types/tabs';
import type { IWorkspaceOpenFailure } from '@app/types/workspaceExpose';
import {
    parseDocumentRef,
    type TDocumentRef,
} from '@contracts/documentRef';
import type { TOpenFileResult } from '@contracts/electronApiDocuments';
import type { TWindowTabsAction } from '@contracts/windowTabs';
import type { ITabLifecycleState } from '@app/modules/workspace-shell/tabs/tabSessionStoreTypes';
import type { TWorkspaceDocumentSessions } from '@app/modules/workspace-shell/document-sessions/useWorkspaceDocumentSessions';
import { snapshotOccupiesTab } from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import { describeDocumentTarget } from '@app/modules/workspace-shell/document-sessions/describeDocumentTarget';

type TWorkspaceOpenDocumentTarget = TDocumentRef | TOpenFileResult;

interface IUseAppShellWorkspaceRoutingOptions {
    activePaneId: Ref<string | null>;
    activeTabId: Ref<string | null>;
    presentationFallbackTabId: Ref<string | null>;
    documentSessions: TWorkspaceDocumentSessions;
    tabLifecycleById: Readonly<Ref<Record<string, ITabLifecycleState>>>;
    createTab: (options: {
        paneId?: string | null;
        activate?: boolean;
    }) => ITab;
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
    /** Tells the user an open failed when no tab is left to show it. */
    reportOpenFailure?: (fileName: string | null, failure: IWorkspaceOpenFailure) => void;
}

/** Decides which tab a document opens in and asks that tab's controller to open it. */
export const useAppShellWorkspaceRouting = (options: IUseAppShellWorkspaceRoutingOptions) => {
    const {
        activePaneId,
        activeTabId,
        documentSessions,
        createTab,
    } = options;

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

    async function openInTab(tabId: string, target: TWorkspaceOpenDocumentTarget) {
        const session = documentSessions.getSession(tabId);
        if (!session) {
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
            });
            return true;
        }
        const workspace = await session.whenMounted();
        if (!workspace) {
            return false;
        }
        return typeof target === 'string'
            ? workspace.handleOpenFileDirectWithPersist(target)
            : workspace.handleOpenFileWithResult(target);
    }

    async function handleFallbackToolbarOpenFile() {
        const session = documentSessions.activeDocumentSession.value;
        const workspace = session ? await session.whenMounted() : null;
        if (workspace) {
            await workspace.handleOpenFileFromUi();
            return;
        }
        const fallbackTab = createTab({
            paneId: activePaneId.value,
            activate: true,
        });
        const fallbackWorkspace = await documentSessions.getSession(fallbackTab.id)?.whenMounted() ?? null;
        if (!fallbackWorkspace) {
            options.removeTabFromState(fallbackTab.id);
            return;
        }
        await fallbackWorkspace.handleOpenFileFromUi();
    }

    // The outgoing tab keeps painting until the new tab presents its document,
    // so an open never flashes an empty pane. A document that does not open
    // takes its tab with it and says why.
    async function handleOpenInNewTab(target: TWorkspaceOpenDocumentTarget, paneId?: string) {
        const outgoingTabId = activeTabId.value;
        options.presentationFallbackTabId.value = outgoingTabId;
        try {
            const tab = createTab({
                paneId: paneId ?? activePaneId.value,
                activate: true,
            });
            let opened = false;
            try {
                opened = await openInTab(tab.id, target);
            } catch (error) {
                BrowserLogger.error('workspace-routing', 'New-tab document open failed', {
                    error,
                    tabId: tab.id,
                }, {code: 'RENDERER_WORKSPACE_OPERATION_FAILED'});
            }
            if (!opened) {
                logPdfRenderTrace('pdf-open-replacement-rollback', {
                    failedTabId: tab.id,
                    restoredTabId: outgoingTabId,
                });
                const failure = readFailure(tab.id);
                options.removeTabFromState(tab.id);
                if (failure) {
                    options.reportOpenFailure?.(failure.fileName, failure);
                }
            }
            return opened;
        } finally {
            if (options.presentationFallbackTabId.value === outgoingTabId) {
                options.presentationFallbackTabId.value = null;
            }
        }
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
        return uniq(paths.flatMap((path) => {
            const parsed = path.trim().length > 0 ? parseDocumentRef(path) : null;
            return parsed === null ? [] : [parsed];
        }));
    }

    async function openPathsInAppropriateTab(paths: TDocumentRef[]) {
        for (const [
            index,
            path,
        ] of normalizeOpenPaths(paths).entries()) {
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
     * shown. Returns the paths no tab could take, for the main process to retry.
     */
    async function beginOpenPathsInAppropriateTab(paths: TDocumentRef[]) {
        const normalizedPaths = normalizeOpenPaths(paths);
        if (normalizedPaths.length === 0) {
            return [];
        }
        markStartupMetricOnce('evb:document-open-started');

        const reusableTabId = activeTabId.value && canReuseTab(activeTabId.value) ? activeTabId.value : null;
        const tabIds = normalizedPaths.map((_path, index) => (
            index === 0 && reusableTabId
                ? reusableTabId
                : createTab({
                    paneId: activePaneId.value,
                    activate: index === normalizedPaths.length - 1,
                }).id
        ));
        await nextTick();
        const results = await Promise.allSettled(normalizedPaths.map(async (path, index) => {
            const tabId = tabIds[index]!;
            if (await openInTab(tabId, path)) {
                return;
            }
            const failure = readFailure(tabId);
            if (tabId !== reusableTabId) {
                options.removeTabFromState(tabId);
                if (failure) {
                    options.reportOpenFailure?.(failure.fileName, failure);
                }
            }
            if (!failure) {
                throw new Error('Startup tab was not available for external open');
            }
        }));
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
