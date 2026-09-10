import type {
    ComputedRef,
    Ref,
} from 'vue';
import { uniq } from 'es-toolkit/array';
import { BrowserLogger } from '@app/utils/browserLogger';
import { markStartupMetricOnce } from '@app/utils/startupMetrics';
import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';
import { buildPendingTabDocumentHint } from '@app/modules/workspace-shell/tabs/buildPendingTabDocumentHint';
import { tabHasDocumentHint } from '@app/modules/workspace-shell/tabs/tabHasDocumentHint';
import { workspaceHasPdf } from '@app/modules/workspace-shell/state/workspaceHasPdf';
import { hasWorkspaceViewerDocumentCapabilities } from '@app/modules/workspace-shell/viewers/workspaceViewerAdapters';
import type { IEditorPaneState } from '@contracts/editorPanes';
import type { ITab } from '@app/types/tabs';
import type { IWorkspaceExpose } from '@app/types/workspaceExpose';
import {
    parseDocumentRef,
    type TDocumentRef,
} from '@contracts/documentRef';
import type { TOpenFileResult } from '@contracts/electronApiDocuments';
import {
    getDocumentFilesCapability,
    getDocumentOpenCapability,
} from '@app/utils/platformDocuments';
import { readRecentOpenExactGeometry } from '@app/modules/workspace-shell/host/recentOpenGeometryReadiness';
import type { TWindowTabsAction } from '@contracts/windowTabs';
import type { IWorkspaceDocumentRecord } from '@app/modules/workspace-shell/state/workspaceDocumentRecord';

interface IResolvedTabAction {
    tab: ITab;
    pane: IEditorPaneState;
}

interface IUseAppShellWorkspaceRoutingOptions {
    activePaneId: Ref<string | null>;
    activeTabId: Ref<string | null>;
    activeWorkspace: ComputedRef<IWorkspaceExpose | null>;
    presentationFallbackTabId: Ref<string | null>;
    workspaceRefs: Ref<Map<string, IWorkspaceExpose>>;
    waitForWorkspace: (tabId: string, timeoutMs?: number) => Promise<IWorkspaceExpose | null>;
    getDocumentRecord: (tabId: string | null | undefined) => IWorkspaceDocumentRecord | null;
    createTab: (options: {
        paneId?: string | null;
        activate?: boolean;
        initial?: Partial<ITab>;
    }) => ITab;
    getTabById: (tabId: string | null | undefined) => ITab | null;
    updateTab: (tabId: string, updates: Partial<ITab>) => void;
    removeTabFromState: (tabId: string) => void;
    resolveTabForAction: (tabId: string | undefined) => IResolvedTabAction | null;
    handleCloseTab: (paneId: string, tabId: string) => Promise<void>;
    moveTabToNewWindow: (tabId: string) => Promise<void>;
    moveTabToWindow: (windowId: number, tabId: string) => Promise<void>;
    mergeWindowInto: (windowId: number) => Promise<void>;
}

type TWorkspaceOpenDocumentTarget = TDocumentRef | TOpenFileResult;

interface IOpenInExistingTabOptions {
    documentHintAlreadySeeded?: boolean;
    reuseAlreadyReserved?: boolean;
}

interface ISeededTabDocumentHint {
    pending: Partial<ITab>;
    previous: Pick<ITab, 'fileName' | 'originalPath' | 'isDjvu'>;
}

const DOCUMENT_OPEN_RECOVERY_TIMEOUT_MS = 800;
const DOCUMENT_OPEN_RECOVERY_POLL_INTERVAL_MS = 50;
const COLD_OPEN_GEOMETRY_TIMEOUT_MS = 750;
const COLD_OPEN_GEOMETRY_TIMEOUT = Symbol('cold-open-geometry-timeout');

async function resolveColdOpenGeometry(result: TOpenFileResult) {
    if (result.kind !== 'pdf' || result.openingGeometry) {
        return result;
    }
    const readOpeningGeometry = getDocumentFilesCapability().getPdfOpeningGeometry;
    if (!readOpeningGeometry) {
        return result;
    }
    try {
        const openingGeometry = await Promise.race([
            readOpeningGeometry(result.workingPath),
            new Promise<typeof COLD_OPEN_GEOMETRY_TIMEOUT>((resolve) => {
                setTimeout(() => resolve(COLD_OPEN_GEOMETRY_TIMEOUT), COLD_OPEN_GEOMETRY_TIMEOUT_MS);
            }),
        ]);
        if (openingGeometry === COLD_OPEN_GEOMETRY_TIMEOUT) {
            BrowserLogger.debug('workspace-routing', 'Cold PDF opening geometry timed out', {
                timeoutMs: COLD_OPEN_GEOMETRY_TIMEOUT_MS,
                workingPath: result.workingPath,
            });
            return result;
        }
        return openingGeometry
            ? {
                ...result,
                openingGeometry,
            }
            : result;
    } catch (error) {
        BrowserLogger.debug('workspace-routing', 'Cold PDF opening geometry unavailable', {
            error,
            workingPath: result.workingPath,
        });
        return result;
    }
}

function readWorkspaceToolbarSnapshot(workspace: IWorkspaceExpose) {
    try {
        return workspace.getToolbarSnapshot();
    } catch (error) {
        BrowserLogger.warn('workspace-routing', 'Failed to read workspace toolbar snapshot', { error });
        return null;
    }
}

export const useAppShellWorkspaceRouting = (options: IUseAppShellWorkspaceRoutingOptions) => {
    const {
        activePaneId,
        activeTabId,
        activeWorkspace,
        presentationFallbackTabId,
        workspaceRefs,
        waitForWorkspace,
        getDocumentRecord,
        createTab,
        getTabById,
        updateTab,
        removeTabFromState,
        resolveTabForAction,
        handleCloseTab,
        moveTabToNewWindow,
        moveTabToWindow,
        mergeWindowInto,
    } = options;

    function createTabInPane(paneId: string) {
        createTab({
            paneId,
            activate: true,
        });
    }

    function recordOccupiesTab(record: IWorkspaceDocumentRecord | null) {
        if (!record) {
            return false;
        }

        const snapshot = record.toolbarSnapshot;
        return hasWorkspaceViewerDocumentCapabilities(snapshot.viewerCapabilities)
            || snapshot.isOpeningDocument === true
            || snapshot.hasOpenError === true
            || record.documentIdentity !== null
            || tabHasDocumentHint(record.tab);
    }

    function recordMatchesDocumentTarget(
        record: IWorkspaceDocumentRecord,
        pathOrResult: TWorkspaceOpenDocumentTarget,
    ) {
        const expected = buildPendingTabDocumentHint(pathOrResult);
        const matchesManagedPdf = typeof pathOrResult !== 'string'
            && pathOrResult.kind === 'pdf'
            && record.documentIdentity?.documentRef === pathOrResult.workingPath;
        const matchesOriginalPath = Boolean(
            expected.originalPath
            && record.tab.originalPath === expected.originalPath,
        );

        if (expected.fileName && record.tab.fileName !== expected.fileName) {
            return false;
        }

        return matchesManagedPdf || (typeof pathOrResult === 'string' && matchesOriginalPath);
    }

    function recordHasSettledDocumentEvidence(
        record: IWorkspaceDocumentRecord | null,
        pathOrResult: TWorkspaceOpenDocumentTarget,
    ) {
        if (!record || record.toolbarSnapshot.isOpeningDocument || record.toolbarSnapshot.hasOpenError) {
            return false;
        }

        return recordMatchesDocumentTarget(record, pathOrResult)
            && (
                record.toolbarSnapshot.initialVisualReady
                || record.toolbarSnapshot.hasPdf
                || hasWorkspaceViewerDocumentCapabilities(record.toolbarSnapshot.viewerCapabilities)
            );
    }

    function workspaceHasSettledDocumentEvidence(
        tabId: string,
        workspace: IWorkspaceExpose | null,
        pathOrResult: TWorkspaceOpenDocumentTarget,
    ) {
        if (recordHasSettledDocumentEvidence(getDocumentRecord(tabId), pathOrResult)) {
            return true;
        }

        if (!workspace) {
            return false;
        }

        const snapshot = readWorkspaceToolbarSnapshot(workspace);
        const documentState = workspace.getAutomationStateSnapshot();
        const targetMatches = typeof pathOrResult === 'string'
            ? documentState.originalPath === pathOrResult
            : pathOrResult.kind === 'pdf'
                ? documentState.workingCopyPath === pathOrResult.workingPath
                : documentState.originalPath === pathOrResult.originalPath;
        return Boolean(
            snapshot
            && !snapshot.isOpeningDocument
            && !snapshot.hasOpenError
            && targetMatches
            && (
                snapshot.initialVisualReady
                || snapshot.hasPdf
                || hasWorkspaceViewerDocumentCapabilities(snapshot.viewerCapabilities)
            ),
        );
    }

    async function waitForSettledDocumentEvidence(
        tabId: string,
        workspace: IWorkspaceExpose | null,
        pathOrResult: TWorkspaceOpenDocumentTarget,
    ) {
        const deadline = Date.now() + DOCUMENT_OPEN_RECOVERY_TIMEOUT_MS;
        while (Date.now() < deadline) {
            if (workspaceHasSettledDocumentEvidence(tabId, workspace, pathOrResult)) {
                return true;
            }

            await new Promise(resolve => setTimeout(resolve, DOCUMENT_OPEN_RECOVERY_POLL_INTERVAL_MS));
        }

        return workspaceHasSettledDocumentEvidence(tabId, workspace, pathOrResult);
    }

    function workspaceOccupiesTab(tabId: string, workspace: IWorkspaceExpose) {
        const record = getDocumentRecord(tabId);
        if (record) {
            return recordOccupiesTab(record);
        }

        if (workspaceHasPdf(workspace)) {
            return true;
        }

        const snapshot = readWorkspaceToolbarSnapshot(workspace);
        return hasWorkspaceViewerDocumentCapabilities(snapshot?.viewerCapabilities)
            || snapshot?.isOpeningDocument === true
            || snapshot?.hasOpenError === true;
    }

    function canReuseTabForDocument(tab: ITab | null, workspace: IWorkspaceExpose | null) {
        return Boolean(
            tab
            && !tabHasDocumentHint(tab)
            && !recordOccupiesTab(getDocumentRecord(tab.id))
            && (!workspace || !workspaceOccupiesTab(tab.id, workspace)),
        );
    }

    function normalizeOpenPaths(paths: TDocumentRef[]) {
        return uniq(paths.flatMap((path) => {
            const parsed = path.trim().length > 0 ? parseDocumentRef(path) : null;
            return parsed === null ? [] : [parsed];
        }));
    }

    async function resolveWorkspaceForTab(tabId: string | null) {
        if (!tabId) {
            return null;
        }
        return workspaceRefs.value.get(tabId) ?? waitForWorkspace(tabId);
    }

    function seedTabDocumentHint(tabId: string | null | undefined, pathOrResult: TWorkspaceOpenDocumentTarget): ISeededTabDocumentHint | null {
        if (!tabId) {
            return null;
        }

        const tab = getTabById(tabId);
        if (!tab || tabHasDocumentHint(tab)) {
            return null;
        }

        const pending = buildPendingTabDocumentHint(pathOrResult);
        const previous = {
            fileName: tab.fileName,
            originalPath: tab.originalPath,
            isDjvu: tab.isDjvu,
        };
        updateTab(tab.id, pending);
        delete tab.recoveryWorkingCopyPath;
        return {
            pending,
            previous,
        };
    }

    function replaceTabDocumentHint(tabId: string, pathOrResult: TWorkspaceOpenDocumentTarget): ISeededTabDocumentHint | null {
        const tab = getTabById(tabId);
        if (!tab) {
            return null;
        }

        const pending = buildPendingTabDocumentHint(pathOrResult);
        const previous = {
            fileName: tab.fileName,
            originalPath: tab.originalPath,
            isDjvu: tab.isDjvu,
        };
        updateTab(tab.id, pending);
        // The checkpoint target only protects the restore transaction. Once a
        // document hint has been accepted, a later close or open must not
        // inherit that old recovery path.
        delete tab.recoveryWorkingCopyPath;
        return {
            pending,
            previous,
        };
    }

    function tabStillShowsSeededDocumentHint(tab: ITab, hint: Partial<ITab>) {
        return tab.fileName === (hint.fileName ?? null)
            && tab.originalPath === (hint.originalPath ?? null)
            && tab.isDjvu === (hint.isDjvu ?? false);
    }

    function rollbackSeededTabDocumentHint(tabId: string, seededHint: ISeededTabDocumentHint | null) {
        if (!seededHint) {
            return;
        }

        const tab = getTabById(tabId);
        if (!tab || !tabStillShowsSeededDocumentHint(tab, seededHint.pending)) {
            return;
        }

        updateTab(tabId, seededHint.previous);
    }

    async function openDocumentInWorkspace(
        workspace: IWorkspaceExpose,
        pathOrResult: TWorkspaceOpenDocumentTarget,
    ) {
        if (typeof pathOrResult === 'string') {
            return workspace.handleOpenFileDirectWithPersist(pathOrResult);
        }

        return workspace.handleOpenFileWithResult(pathOrResult);
    }

    async function openInExistingTab(
        tabId: string,
        pathOrResult: TWorkspaceOpenDocumentTarget,
        openOptions: IOpenInExistingTabOptions = {},
    ) {
        const workspace = activeTabId.value === tabId
            ? activeWorkspace.value ?? await resolveWorkspaceForTab(tabId)
            : await resolveWorkspaceForTab(tabId);
        if (!workspace) {
            return false;
        }

        if (!openOptions.reuseAlreadyReserved && workspaceOccupiesTab(tabId, workspace)) {
            return false;
        }

        // The workspace must claim the open transaction before its display hint
        // changes. Otherwise DeferredDocumentWorkspaceHost interprets the live
        // hint as a restored-session command and opens the same path twice.
        const opened = await openDocumentInWorkspace(workspace, pathOrResult);
        const seededHint = opened && !openOptions.documentHintAlreadySeeded
            ? seedTabDocumentHint(tabId, pathOrResult)
            : null;
        if (opened) {
            return true;
        }

        if (await waitForSettledDocumentEvidence(tabId, workspace, pathOrResult)) {
            if (!openOptions.documentHintAlreadySeeded) {
                seedTabDocumentHint(tabId, pathOrResult);
            }
            BrowserLogger.warn('workspace-routing', 'Keeping existing tab after open returned false because document state settled', {tabId});
            return true;
        }

        rollbackSeededTabDocumentHint(tabId, seededHint);
        return false;
    }

    async function handleFallbackToolbarOpenFile() {
        const workspace = activeWorkspace.value ?? await resolveWorkspaceForTab(activeTabId.value);
        if (workspace) {
            await workspace.handleOpenFileFromUi();
            return;
        }

        const fallbackTab = createTab({
            paneId: activePaneId.value,
            activate: true,
        });
        const fallbackWorkspace = await waitForWorkspace(fallbackTab.id);
        if (!fallbackWorkspace) {
            removeTabFromState(fallbackTab.id);
            return;
        }
        await fallbackWorkspace.handleOpenFileFromUi();
    }

    async function handleOpenInNewTab(pathOrResult: TWorkspaceOpenDocumentTarget, paneId?: string) {
        const targetPaneId = paneId ?? activePaneId.value ?? undefined;
        const pendingHint = buildPendingTabDocumentHint(pathOrResult);
        const outgoingTabId = activeTabId.value;
        presentationFallbackTabId.value = outgoingTabId;
        try {
            const tab = createTab({
                ...(targetPaneId !== undefined ? { paneId: targetPaneId } : {}),
                activate: true,
                initial: {
                    fileName: pendingHint.fileName ?? null,
                    isDjvu: pendingHint.isDjvu ?? false,
                },
            });
            const workspace = await waitForWorkspace(tab.id);
            if (!workspace) {
                removeTabFromState(tab.id);
                return false;
            }

            let opened: boolean;
            try {
                opened = await openDocumentInWorkspace(workspace, pathOrResult);
            } catch (error) {
                BrowserLogger.error('workspace-routing', 'New-tab document open failed', {
                    error,
                    tabId: tab.id,
                }, {
                    code: 'RENDERER_WORKSPACE_OPERATION_FAILED',
                    context: {},
                });
                logPdfRenderTrace('pdf-open-replacement-rollback', {
                    failedTabId: tab.id,
                    restoredTabId: outgoingTabId,
                    reason: 'open-threw',
                });
                removeTabFromState(tab.id);
                return false;
            }
            if (!opened) {
                if (await waitForSettledDocumentEvidence(tab.id, workspace, pathOrResult)) {
                    replaceTabDocumentHint(tab.id, pathOrResult);
                    BrowserLogger.warn('workspace-routing', 'Keeping new tab after open returned false because document state settled', {tabId: tab.id});
                    return true;
                }

                logPdfRenderTrace('pdf-open-replacement-rollback', {
                    failedTabId: tab.id,
                    restoredTabId: outgoingTabId,
                    reason: 'open-did-not-settle',
                });
                removeTabFromState(tab.id);
                return false;
            }
            replaceTabDocumentHint(tab.id, pathOrResult);
            return true;
        } finally {
            if (presentationFallbackTabId.value === outgoingTabId) {
                presentationFallbackTabId.value = null;
            }
        }
    }

    async function openDocumentInAppropriateTab(pathOrResult: TWorkspaceOpenDocumentTarget) {
        const tabId = activeTabId.value;
        const tab = getTabById(tabId);
        const workspace = activeWorkspace.value;
        let attemptedExistingTabId: string | null = null;
        if (tab && canReuseTabForDocument(tab, workspace)) {
            attemptedExistingTabId = tab.id;
            const opened = await openInExistingTab(tab.id, pathOrResult);
            if (opened) {
                return true;
            }
        }

        const resolvedWorkspace = workspace ?? await resolveWorkspaceForTab(tabId);
        if (resolvedWorkspace && tabId && tabId !== attemptedExistingTabId && !workspaceOccupiesTab(tabId, resolvedWorkspace)) {
            const opened = await openDocumentInWorkspace(resolvedWorkspace, pathOrResult);
            const seededHint = opened ? seedTabDocumentHint(tabId, pathOrResult) : null;
            if (opened) {
                return true;
            }
            if (await waitForSettledDocumentEvidence(tabId, resolvedWorkspace, pathOrResult)) {
                seedTabDocumentHint(tabId, pathOrResult);
                return true;
            }
            rollbackSeededTabDocumentHint(tabId, seededHint);
        }

        return handleOpenInNewTab(pathOrResult, activePaneId.value ?? undefined);
    }

    async function openResultInAppropriateTab(result: TOpenFileResult) {
        return openDocumentInAppropriateTab(result);
    }

    async function openPathInAppropriateTab(path: TDocumentRef) {
        // The origin every open phase is measured from. Everything a user waits
        // for after picking a file happens after this point.
        const routeStartedAt = performance.now();
        const warmGeometry = readRecentOpenExactGeometry(path) !== null;
        logPdfRenderTrace('pdf-open-route-start', {
            path,
            warmGeometry,
        });
        if (warmGeometry) {
            // Recent/startup preparation already gave the host a validated,
            // revision-fenced frame. Preserve the latency-sensitive immediate
            // claim; its document flow may create the working copy in parallel.
            // Closed here with a zero-length span so the phase ledger reports a
            // skipped preflight rather than an unmeasured one.
            logPdfRenderTrace('pdf-open-route-capability-end', {
                path,
                elapsedMs: performance.now() - routeStartedAt,
                failed: false,
                resultKind: null,
                warmGeometry,
            });
            return openDocumentInAppropriateTab(path);
        }
        // A cold path is resolved by the main process before the workspace
        // claims its one opening-surface transaction. For PDFs this result
        // carries authoritative first-page geometry discovered from the
        // admitted working copy, so the host can begin atomically with
        // the exact frame instead of retargeting a later viewer-local shell.
        let result: TOpenFileResult | null;
        try {
            result = await getDocumentOpenCapability().openDocumentDirect(path);
            if (result) {
                result = await resolveColdOpenGeometry(result);
            }
        } catch (error) {
            // A rejected preflight ends the open here. Closing the span keeps
            // the phase ledger complete: a refused file reports as a measured
            // failure instead of an open that was never accounted for.
            logPdfRenderTrace('pdf-open-route-capability-end', {
                path,
                elapsedMs: performance.now() - routeStartedAt,
                failed: true,
                resultKind: null,
                warmGeometry,
            });
            throw error;
        }
        // Main-process preflight: admitting the file and staging a working
        // copy. On a large scanned PDF this is a whole-file copy, so it is the
        // first candidate whenever an open feels slow before anything paints.
        logPdfRenderTrace('pdf-open-route-capability-end', {
            path,
            elapsedMs: performance.now() - routeStartedAt,
            failed: false,
            hasOpeningGeometry: result?.kind === 'pdf' && result.openingGeometry !== undefined,
            resultKind: result?.kind ?? null,
            warmGeometry,
        });
        return result ? openDocumentInAppropriateTab(result) : false;
    }

    async function openPathInReservedTab(tabId: string, path: TWorkspaceOpenDocumentTarget) {
        const tab = getTabById(tabId);
        if (!tab) {
            return false;
        }
        const workspace = await resolveWorkspaceForTab(tabId);
        if (!workspace) {
            return false;
        }
        const opened = await openDocumentInWorkspace(workspace, path);
        const seededHint = opened ? replaceTabDocumentHint(tabId, path) : null;
        if (!opened) {
            if (await waitForSettledDocumentEvidence(tabId, workspace, path)) {
                replaceTabDocumentHint(tabId, path);
                BrowserLogger.warn('workspace-routing', 'Keeping reserved tab after open returned false because document state settled', {tabId});
                return true;
            }
            rollbackSeededTabDocumentHint(tabId, seededHint);
        }
        return opened;
    }

    async function openPathsInAppropriateTab(paths: TDocumentRef[]) {
        const normalizedPaths = normalizeOpenPaths(paths);
        if (normalizedPaths.length === 0) {
            return;
        }

        const initialActiveWorkspace = activeWorkspace.value;
        const initialActiveTab = getTabById(activeTabId.value);
        let canReuseActiveTab = canReuseTabForDocument(initialActiveTab, initialActiveWorkspace);

        for (const [
            index,
            path,
        ] of normalizedPaths.entries()) {
            try {
                if (canReuseActiveTab) {
                    const opened = await openDocumentInAppropriateTab(path);
                    canReuseActiveTab = !opened;
                    continue;
                }

                await handleOpenInNewTab(path, activePaneId.value ?? undefined);
            } catch (error) {
                const activeTab = getTabById(activeTabId.value);
                const currentActiveWorkspace = activeWorkspace.value ?? await resolveWorkspaceForTab(activeTabId.value);
                canReuseActiveTab = activeTab && currentActiveWorkspace
                    ? canReuseTabForDocument(activeTab, currentActiveWorkspace)
                    : false;
                BrowserLogger.warn('workspace-routing', 'Failed to open dropped/external path in its own tab', {
                    path,
                    pathIndex: index,
                    error,
                });
            }
        }
    }

    async function beginOpenPathsInAppropriateTab(paths: TDocumentRef[]) {
        const normalizedPaths = normalizeOpenPaths(paths);
        if (normalizedPaths.length === 0) {
            return [];
        }
        markStartupMetricOnce('evb:document-open-started');

        const startupOpenTasks: Array<Promise<void>> = [];
        const initialActiveWorkspace = activeWorkspace.value;
        const initialActiveTab = getTabById(activeTabId.value);
        let canReuseActiveTab = canReuseTabForDocument(initialActiveTab, initialActiveWorkspace);

        for (const [
            index,
            path,
        ] of normalizedPaths.entries()) {
            if (canReuseActiveTab && initialActiveTab) {
                canReuseActiveTab = false;
                startupOpenTasks.push((async () => {
                    const opened = await openInExistingTab(initialActiveTab.id, path, {reuseAlreadyReserved: true});
                    if (!opened) {
                        throw new Error('Startup active tab was not available for external open');
                    }
                })());
                continue;
            }

            const tab = createTab({
                paneId: activePaneId.value,
                activate: index === normalizedPaths.length - 1,
            });
            startupOpenTasks.push((async () => {
                const workspace = await waitForWorkspace(tab.id);
                if (!workspace) {
                    removeTabFromState(tab.id);
                    return;
                }
                const opened = await workspace.handleOpenFileDirectWithPersist(path);
                const seededHint = opened ? seedTabDocumentHint(tab.id, path) : null;
                if (!opened) {
                    if (await waitForSettledDocumentEvidence(tab.id, workspace, path)) {
                        seedTabDocumentHint(tab.id, path);
                        BrowserLogger.warn('workspace-routing', 'Keeping startup-created tab after open returned false because document state settled', {
                            tabId: tab.id,
                            pathIndex: index,
                        });
                        return;
                    }

                    rollbackSeededTabDocumentHint(tab.id, seededHint);
                    removeTabFromState(tab.id);
                    throw new Error('Startup tab document open did not complete');
                }
            })());
        }

        const startupOpenResults = await Promise.allSettled(startupOpenTasks);
        const failedPaths: TDocumentRef[] = [];
        for (const [
            index,
            result,
        ] of startupOpenResults.entries()) {
            if (result.status === 'rejected') {
                const reason: unknown = result.reason;
                const failedPath = normalizedPaths[index];
                if (failedPath) {
                    failedPaths.push(failedPath);
                }
                BrowserLogger.warn('workspace-routing', 'Failed to begin startup external path open', {
                    path: failedPath,
                    pathIndex: index,
                    error: reason,
                });
            }
        }

        await nextTick();
        return failedPaths;
    }

    async function handleWindowTabsAction(action: TWindowTabsAction) {
        if (action.kind === 'close-tab') {
            const resolved = resolveTabForAction(action.tabId);
            if (!resolved) {
                return;
            }
            await handleCloseTab(resolved.pane.paneId, resolved.tab.id);
            return;
        }

        if (action.kind === 'move-tab-to-new-window') {
            const resolved = resolveTabForAction(action.tabId);
            if (!resolved) {
                return;
            }
            await moveTabToNewWindow(resolved.tab.id);
            return;
        }

        if (action.kind === 'move-tab-to-window') {
            const resolved = resolveTabForAction(action.tabId);
            if (!resolved) {
                return;
            }
            await moveTabToWindow(action.targetWindowId, resolved.tab.id);
            return;
        }

        await mergeWindowInto(action.targetWindowId);
    }

    return {
        createTabInPane,
        handleFallbackToolbarOpenFile,
        handleOpenInNewTab,
        openResultInAppropriateTab,
        openPathInAppropriateTab,
        openPathInReservedTab,
        openPathsInAppropriateTab,
        beginOpenPathsInAppropriateTab,
        handleWindowTabsAction,
    };
};
