import type { Ref } from 'vue';
import type {
    IAgentCommandCancelRequest,
    IAgentCommandExecutionScope,
    IAgentCommandRequest,
    IAgentCommandResponse,
    IAgentRendererAck,
    TAgentWorkspaceCommandTarget,
    IAgentWorkspaceSnapshot,
    IAgentWorkspaceSnapshotRequest,
    IAgentWorkspaceSnapshotResponse,
} from '@contracts/agent';
import type {
    IEditorPaneState,
    TEditorLayoutNode,
} from '@contracts/editorPanes';
import type { IDocumentRevisionInfo } from '@contracts/documentRevision';
import type { ITab } from '@app/types/tabs';
import type { IRecentFile } from '@contracts/shared';
import type { IWorkspaceAgentCommandContext } from '@app/types/workspaceExpose';
import { getAgentCapability } from '@app/utils/getAgentCapability';
import {
    isElectronUserAgent,
    waitForDesktopPlatformBridge,
} from '@app/utils/platform';
import { guardAsync } from '@app/utils/asyncGuard';
import { BrowserLogger } from '@app/utils/browserLogger';
import { getErrorMessage } from '@app/utils/error';
import { buildAgentWorkspaceSnapshot } from '@app/modules/workspace-shell/agent/buildAgentWorkspaceSnapshot';
import {
    describeTabDocument,
    type IWorkspaceDocumentController,
} from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import { resolveDocumentRefBackend } from '@app/utils/documentRef';

const AGENT_BRIDGE_RETRY_DELAY_MS = 250;

interface IUseAgentWorkspaceSnapshotOptions {
    panes: Ref<IEditorPaneState[]>;
    tabs: Ref<ITab[]>;
    layout: Ref<TEditorLayoutNode | null>;
    activePaneId: Ref<string | null>;
    activeTabId: Ref<string | null>;
    recentFiles?: Ref<IRecentFile[]>;
    recentFilesResolved?: Ref<boolean>;
    documentSessionsByTabId: Ref<Record<string, IWorkspaceDocumentController>>;
    shouldWaitForDesktopBridge: () => boolean;
    getPaneByTabId(tabId: string): IEditorPaneState | null;
    activateTab(paneId: string, tabId: string): void;
}

export const useAgentWorkspaceSnapshot = (options: IUseAgentWorkspaceSnapshotOptions) => {
    let unsubscribeWorkspaceSnapshotRequest: (() => void) | null = null;
    let unsubscribeCommandRequest: (() => void) | null = null;
    let unsubscribeCommandCancelRequest: (() => void) | null = null;
    const lifecycle: { isDisposed: boolean } = { isDisposed: false };
    let cachedSnapshotRevision = 0;
    let cachedSnapshotSignature = '';
    let cachedSnapshot: IAgentWorkspaceSnapshot | null = null;
    const activeCommandAbortControllers = new Map<string, AbortController>();

    function createToolbarSnapshotSignature(tabId: string) {
        const snapshot = options.documentSessionsByTabId.value[tabId]?.toolbarSnapshot.value;
        if (!snapshot) {
            return null;
        }

        return {
            hasPdf: snapshot.hasPdf,
            isDjvuMode: snapshot.isDjvuMode,
            isOpeningDocument: snapshot.isOpeningDocument,
            hasOpenError: snapshot.hasOpenError,
            currentPage: snapshot.currentPage,
            totalPages: snapshot.totalPages,
        };
    }

    function createDocumentSessionSignature(tabId: string) {
        const snapshot = options.documentSessionsByTabId.value[tabId]?.snapshot.value ?? null;
        if (!snapshot) {
            return null;
        }

        return {
            sessionId: snapshot.sessionId,
            sessionRevision: snapshot.sessionRevision,
            phase: snapshot.phase,
            documentSessionKey: snapshot.identity.documentSessionKey,
            documentInstanceId: snapshot.identity.documentInstanceId,
            documentRef: snapshot.identity.documentRef,
            documentBackend: resolveDocumentRefBackend(snapshot.identity.documentRef),
            documentRevisionToken: snapshot.identity.revisionInfo?.token ?? null,
            transactionId: snapshot.activeTransaction?.id ?? null,
            transactionKind: snapshot.activeTransaction?.kind ?? null,
            mounted: snapshot.mounted,
        };
    }

    function createSnapshotSignature() {
        return JSON.stringify({
            activePaneId: options.activePaneId.value,
            activeTabId: options.activeTabId.value,
            layout: options.layout.value,
            panes: options.panes.value.map(pane => ({
                paneId: pane.paneId,
                activeTabId: pane.activeTabId,
                tabIds: pane.tabIds,
            })),
            tabs: options.tabs.value.map(tab => ({
                id: tab.id,
                document: getTabSession(tab.id) ? describeTabDocument(getTabSession(tab.id)!.snapshot.value) : null,
                documentIdentity: getTabDocumentIdentity(tab.id),
                documentSession: createDocumentSessionSignature(tab.id),
                toolbar: createToolbarSnapshotSignature(tab.id),
            })),
            recentFiles: (options.recentFiles?.value ?? []).map(file => ({
                originalPath: file.originalPath,
                backend: file.backend,
                fileName: file.fileName,
                timestamp: file.timestamp,
                fileSize: file.fileSize,
            })),
            recentFilesResolved: options.recentFilesResolved?.value ?? false,
        });
    }

    function getCachedSnapshot() {
        const signature = createSnapshotSignature();
        if (cachedSnapshot && signature === cachedSnapshotSignature) {
            return {
                revision: cachedSnapshotRevision,
                snapshot: cachedSnapshot,
            };
        }

        cachedSnapshotSignature = signature;
        cachedSnapshotRevision += 1;
        cachedSnapshot = buildAgentWorkspaceSnapshot(options);
        return {
            revision: cachedSnapshotRevision,
            snapshot: cachedSnapshot,
        };
    }

    function createSnapshotResponse(request: IAgentWorkspaceSnapshotRequest): IAgentWorkspaceSnapshotResponse {
        const cached = getCachedSnapshot();
        if (
            request.lastSeenRevision !== undefined
            && request.lastSeenRevision === cached.revision
        ) {
            return {
                requestId: request.requestId,
                ...(request.windowId === undefined ? {} : { windowId: request.windowId }),
                ok: true,
                revision: cached.revision,
                unchanged: true,
            };
        }

        return {
            requestId: request.requestId,
            ...(request.windowId === undefined ? {} : { windowId: request.windowId }),
            ok: true,
            revision: cached.revision,
            snapshot: cached.snapshot,
        };
    }

    function createCommandErrorResponse(
        request: IAgentCommandRequest,
        error: unknown,
    ): IAgentCommandResponse {
        return {
            requestId: request.requestId,
            ...(request.windowId === undefined ? {} : { windowId: request.windowId }),
            ok: false,
            error: getErrorMessage(error),
        };
    }

    function logRejectedAck(kind: 'snapshot' | 'command', requestId: string, ack: IAgentRendererAck) {
        if (ack.accepted) {
            return;
        }
        BrowserLogger.warn('agent', `Agent ${kind} response was not accepted`, {
            requestId,
            reason: ack.reason ?? 'unknown-request',
        });
    }

    async function submitWorkspaceSnapshotWithAck(response: IAgentWorkspaceSnapshotResponse) {
        const ack = await getAgentCapability().submitWorkspaceSnapshot(response);
        logRejectedAck('snapshot', response.requestId, ack);
    }

    async function submitCommandResponseWithAck(response: IAgentCommandResponse) {
        const ack = await getAgentCapability().submitCommandResponse(response);
        logRejectedAck('command', response.requestId, ack);
    }

    async function activateTabForAgent(tabId: string) {
        const pane = options.getPaneByTabId(tabId);
        if (!pane) {
            throw new Error(`Tab ${tabId} is not open.`);
        }

        options.activateTab(pane.paneId, tabId);
        await nextTick();
        return pane.paneId;
    }

    function createAgentCommandAbortError() {
        const error = new Error('Agent command was aborted.');
        error.name = 'AbortError';
        return error;
    }

    function assertSignalActive(signal: AbortSignal) {
        if (signal.aborted) {
            throw createAgentCommandAbortError();
        }
    }

    function getTabDocumentIdentity(tabId: string): IDocumentRevisionInfo | null {
        return getTabSession(tabId)?.snapshot.value.identity.revisionInfo ?? null;
    }

    function getTabDocumentInstanceId(tabId: string) {
        return getTabSession(tabId)?.snapshot.value.identity.documentInstanceId ?? null;
    }

    function getTabDocumentRef(tabId: string) {
        return getTabSession(tabId)?.snapshot.value.identity.documentRef ?? null;
    }

    function getTabDocumentBackend(tabId: string) {
        return resolveDocumentRefBackend(getTabDocumentRef(tabId));
    }

    function getTabSession(tabId: string) {
        return options.documentSessionsByTabId.value[tabId] ?? null;
    }

    function getTabCommandTarget(tabId: string): TAgentWorkspaceCommandTarget | null {
        return getTabSession(tabId)?.createCommandTarget() ?? null;
    }

    function documentIdentityMatches(
        expected: IDocumentRevisionInfo | null,
        actual: IDocumentRevisionInfo | null,
    ) {
        if (!expected) {
            return true;
        }

        return actual?.documentRef === expected.documentRef && actual.token === expected.token;
    }

    function assertScopeMatchesTab(
        scope: IAgentCommandExecutionScope | undefined,
        tabId: string,
        strictRevision = true,
    ) {
        if (!scope) {
            return;
        }
        if (scope.tabId !== tabId) {
            throw new Error(`Agent command target tab changed: expected ${scope.tabId}, got ${tabId}.`);
        }

        assertCommandTargetCurrent(scope.commandTarget, strictRevision);

        if ((scope.documentInstanceId ?? null) !== getTabDocumentInstanceId(tabId)) {
            throw new Error('Agent command target document changed.');
        }

        const actualIdentity = getTabDocumentIdentity(tabId);
        if (scope.documentIdentity) {
            const matches = strictRevision
                ? documentIdentityMatches(scope.documentIdentity, actualIdentity)
                : actualIdentity?.documentRef === scope.documentIdentity.documentRef;
            if (!matches) {
                throw new Error('Agent command target document changed.');
            }
            return;
        }

        if (scope.documentRef !== null && getTabDocumentRef(tabId) !== scope.documentRef) {
            throw new Error('Agent command target document changed.');
        }

        if (scope.documentBackend !== undefined && getTabDocumentBackend(tabId) !== scope.documentBackend) {
            throw new Error('Agent command target document changed.');
        }
    }

    function assertCommandTargetCurrent(
        target: TAgentWorkspaceCommandTarget | null | undefined,
        strictRevision = true,
    ) {
        if (!target) {
            return;
        }

        const session = getTabSession(target.tabId);
        if (!session) {
            throw new Error('stale-command-target');
        }

        if (strictRevision) {
            const validation = session.validateCommandTarget(target);
            if (!validation.ok) {
                throw new Error('stale-command-target');
            }
            return;
        }

        const snapshot = unref(session.snapshot);
        if (
            target.tabId !== snapshot.tabId
            || target.sessionId !== snapshot.sessionId
            || target.documentRef !== snapshot.identity.documentRef
            || (target.documentInstanceId ?? null) !== snapshot.identity.documentInstanceId
            || (
                target.documentBackend !== undefined
                && target.documentBackend !== resolveDocumentRefBackend(snapshot.identity.documentRef)
            )
        ) {
            throw new Error('stale-command-target');
        }
    }

    function assertCapturedIdentityMatches(
        tabId: string,
        expectedIdentity: IDocumentRevisionInfo | null,
        strictRevision = true,
    ) {
        if (!expectedIdentity) {
            return;
        }

        const actualIdentity = getTabDocumentIdentity(tabId);
        const matches = strictRevision
            ? documentIdentityMatches(expectedIdentity, actualIdentity)
            : actualIdentity?.documentRef === expectedIdentity.documentRef;
        if (!matches) {
            throw new Error('Agent command target document changed.');
        }
    }

    function resolveScopedTabId(
        request: IAgentCommandRequest,
        commandTabId: string | null | undefined,
        fallbackMessage: string,
    ) {
        if (request.scope && commandTabId && request.scope.tabId !== commandTabId) {
            throw new Error(`Agent command target tab changed: expected ${request.scope.tabId}, got ${commandTabId}.`);
        }
        const tabId = request.scope?.tabId ?? commandTabId ?? options.activeTabId.value;
        if (!tabId) {
            throw new Error(fallbackMessage);
        }
        return tabId;
    }

    function assertCommandCurrentDocument(
        request: IAgentCommandRequest,
        tabId: string,
        signal: AbortSignal,
        expectedIdentity: IDocumentRevisionInfo | null,
        strictRevision = true,
        expectedCommandTarget: TAgentWorkspaceCommandTarget | null = null,
    ) {
        assertSignalActive(signal);
        assertScopeMatchesTab(request.scope, tabId, strictRevision);
        assertCommandTargetCurrent(expectedCommandTarget, strictRevision);
        if (!request.scope && !expectedCommandTarget) {
            assertCapturedIdentityMatches(tabId, expectedIdentity, strictRevision);
        }
    }

    async function waitForCommandWorkspace(
        tabId: string,
        expectedCommandTarget: TAgentWorkspaceCommandTarget | null,
    ) {
        const session = getTabSession(tabId);
        const workspace = await session?.whenMounted() ?? null;
        return expectedCommandTarget && session && !session.validateCommandTarget(expectedCommandTarget).ok
            ? null
            : workspace;
    }

    function createCommandContext(
        request: IAgentCommandRequest,
        tabId: string,
        signal: AbortSignal,
        expectedIdentity: IDocumentRevisionInfo | null,
        expectedCommandTarget: TAgentWorkspaceCommandTarget | null,
    ): IWorkspaceAgentCommandContext {
        const commandTarget = request.scope?.commandTarget ?? expectedCommandTarget;
        return {
            signal,
            documentIdentity: request.scope?.documentIdentity ?? expectedIdentity,
            documentInstanceId: request.scope?.documentInstanceId ?? getTabDocumentInstanceId(tabId),
            ...(commandTarget ? {commandTarget} : {}),
            assertCurrentDocument: (contextOptions = {}) => {
                assertCommandCurrentDocument(
                    request,
                    tabId,
                    signal,
                    expectedIdentity,
                    contextOptions.allowRevisionChange !== true,
                    expectedCommandTarget,
                );
            },
        };
    }

    async function runCommand(request: IAgentCommandRequest, signal: AbortSignal) {
        if (request.command.name === 'activate_tab') {
            const tabId = resolveScopedTabId(
                request,
                request.command.arguments.tabId,
                'No active tab is available for activation.',
            );
            const expectedIdentity = request.scope?.documentIdentity ?? getTabDocumentIdentity(tabId);
            const expectedCommandTarget = request.scope?.commandTarget ?? getTabCommandTarget(tabId);
            assertCommandCurrentDocument(request, tabId, signal, expectedIdentity, true, expectedCommandTarget);
            const paneId = await activateTabForAgent(tabId);
            assertCommandCurrentDocument(request, tabId, signal, expectedIdentity, true, expectedCommandTarget);
            return {
                activePaneId: paneId,
                activeTabId: tabId,
            };
        }

        if (request.command.name === 'read_resource') {
            const tabId = resolveScopedTabId(
                request,
                request.command.arguments.tabId,
                'No active tab is available for resource reads.',
            );

            const expectedIdentity = request.scope?.documentIdentity ?? getTabDocumentIdentity(tabId);
            const expectedCommandTarget = request.scope?.commandTarget ?? getTabCommandTarget(tabId);
            assertCommandCurrentDocument(request, tabId, signal, expectedIdentity, true, expectedCommandTarget);
            const workspace = await waitForCommandWorkspace(tabId, expectedCommandTarget);
            assertCommandCurrentDocument(request, tabId, signal, expectedIdentity, true, expectedCommandTarget);
            if (!workspace) {
                throw new Error(`Workspace for tab ${tabId} is not available.`);
            }

            const context = createCommandContext(request, tabId, signal, expectedIdentity, expectedCommandTarget);
            const result = await workspace.readAgentResource(request.command.arguments.uri, context);
            assertCommandCurrentDocument(request, tabId, signal, expectedIdentity, true, expectedCommandTarget);
            return {
                activePaneId: options.activePaneId.value,
                activeTabId: options.activeTabId.value,
                targetTabId: tabId,
                ...result,
            };
        }

        if (request.command.name === 'run_action') {
            const tabId = resolveScopedTabId(
                request,
                request.command.arguments.tabId,
                'No active tab is available for agent actions.',
            );

            const expectedIdentity = request.scope?.documentIdentity ?? getTabDocumentIdentity(tabId);
            const expectedCommandTarget = request.scope?.commandTarget ?? getTabCommandTarget(tabId);
            assertCommandCurrentDocument(request, tabId, signal, expectedIdentity, true, expectedCommandTarget);
            const paneId = await activateTabForAgent(tabId);
            assertCommandCurrentDocument(request, tabId, signal, expectedIdentity, true, expectedCommandTarget);
            const workspace = await waitForCommandWorkspace(tabId, expectedCommandTarget);
            assertCommandCurrentDocument(request, tabId, signal, expectedIdentity, true, expectedCommandTarget);
            if (!workspace) {
                throw new Error(`Workspace for tab ${tabId} is not available.`);
            }

            const context = createCommandContext(request, tabId, signal, expectedIdentity, expectedCommandTarget);
            const result = await workspace.runAgentAction(
                request.command.arguments.id,
                request.command.arguments.input,
                request.command.arguments.dryRun === undefined
                    ? {}
                    : {dryRun: request.command.arguments.dryRun},
                context,
            );
            await nextTick();
            assertCommandCurrentDocument(request, tabId, signal, expectedIdentity, false, expectedCommandTarget);
            return {
                activePaneId: paneId,
                activeTabId: tabId,
                ...result,
            };
        }

        const tabId = resolveScopedTabId(
            request,
            request.command.arguments.tabId,
            'No active tab is available for page navigation.',
        );

        const expectedIdentity = request.scope?.documentIdentity ?? getTabDocumentIdentity(tabId);
        const expectedCommandTarget = request.scope?.commandTarget ?? getTabCommandTarget(tabId);
        assertCommandCurrentDocument(request, tabId, signal, expectedIdentity, true, expectedCommandTarget);
        const paneId = await activateTabForAgent(tabId);
        assertCommandCurrentDocument(request, tabId, signal, expectedIdentity, true, expectedCommandTarget);
        const workspace = await waitForCommandWorkspace(tabId, expectedCommandTarget);
        assertCommandCurrentDocument(request, tabId, signal, expectedIdentity, true, expectedCommandTarget);
        if (!workspace) {
            throw new Error(`Workspace for tab ${tabId} is not available.`);
        }

        workspace.handleGoToPage(request.command.arguments.page);
        await nextTick();
        assertCommandCurrentDocument(request, tabId, signal, expectedIdentity, true, expectedCommandTarget);
        const snapshot = workspace.getToolbarSnapshot();
        return {
            activePaneId: paneId,
            activeTabId: tabId,
            currentPage: snapshot.currentPage,
            totalPages: snapshot.totalPages,
        };
    }

    function submitSnapshot(request: IAgentWorkspaceSnapshotRequest) {
        let response: IAgentWorkspaceSnapshotResponse;
        try {
            response = createSnapshotResponse(request);
        } catch (error) {
            response = {
                requestId: request.requestId,
                ...(request.windowId === undefined ? {} : { windowId: request.windowId }),
                ok: false,
                error: getErrorMessage(error),
            };
        }

        guardAsync(submitWorkspaceSnapshotWithAck(response), {
            category: 'background-diagnostic',
            scope: 'agent',
            message: 'Failed to submit agent workspace snapshot',
        });
    }

    function submitCommandResult(request: IAgentCommandRequest) {
        const abortController = new AbortController();
        activeCommandAbortControllers.set(request.requestId, abortController);
        guardAsync(
            runCommand(request, abortController.signal)
                .then(result => submitCommandResponseWithAck({
                    requestId: request.requestId,
                    ...(request.windowId === undefined ? {} : { windowId: request.windowId }),
                    ok: true,
                    result,
                }))
                .catch(error => submitCommandResponseWithAck(
                    createCommandErrorResponse(request, error),
                ))
                .finally(() => {
                    abortController.abort();
                    activeCommandAbortControllers.delete(request.requestId);
                }),
            {
                category: 'background-diagnostic',
                scope: 'agent',
                message: 'Failed to submit agent command response',
            },
        );
    }

    function cancelCommandRequest(request: IAgentCommandCancelRequest) {
        activeCommandAbortControllers.get(request.requestId)?.abort(createAgentCommandAbortError());
    }

    function waitForRetryDelay() {
        return new Promise<void>(resolve => setTimeout(resolve, AGENT_BRIDGE_RETRY_DELAY_MS));
    }

    async function waitForAgentCapability() {
        let hasLoggedBridgeWait = false;
        while (lifecycle.isDisposed !== true) {
            const shouldWaitForAgentBridge = options.shouldWaitForDesktopBridge() || isElectronUserAgent();
            const bridgeReady = await waitForDesktopPlatformBridge({ shouldWait: shouldWaitForAgentBridge });
            if (lifecycle.isDisposed.valueOf()) {
                return null;
            }
            if (!shouldWaitForAgentBridge || bridgeReady) {
                return getAgentCapability();
            }

            if (!hasLoggedBridgeWait) {
                hasLoggedBridgeWait = true;
                BrowserLogger.warn('agent', 'Waiting for Electron platform bridge before attaching agent workspace listeners');
            }
            await waitForRetryDelay();
        }

        return null;
    }

    onMounted(() => {
        lifecycle.isDisposed = false;
        guardAsync(
            (async () => {
                const agent = await waitForAgentCapability();
                if (lifecycle.isDisposed === true || !agent) {
                    return;
                }
                const unsubscribeSnapshot = agent.onWorkspaceSnapshotRequest(submitSnapshot);
                const unsubscribeCommand = agent.onCommandRequest(submitCommandResult);
                const unsubscribeCommandCancel = agent.onCommandCancelRequest(cancelCommandRequest);
                if (lifecycle.isDisposed.valueOf()) {
                    unsubscribeSnapshot();
                    unsubscribeCommand();
                    unsubscribeCommandCancel();
                    return;
                }
                unsubscribeWorkspaceSnapshotRequest = unsubscribeSnapshot;
                unsubscribeCommandRequest = unsubscribeCommand;
                unsubscribeCommandCancelRequest = unsubscribeCommandCancel;
            })(),
            {
                category: 'background-diagnostic',
                scope: 'agent',
                message: 'Failed to attach agent workspace bridge',
            },
        );
    });

    onUnmounted(() => {
        lifecycle.isDisposed = true;
        for (const abortController of activeCommandAbortControllers.values()) {
            abortController.abort();
        }
        activeCommandAbortControllers.clear();
        unsubscribeWorkspaceSnapshotRequest?.();
        unsubscribeWorkspaceSnapshotRequest = null;
        unsubscribeCommandRequest?.();
        unsubscribeCommandRequest = null;
        unsubscribeCommandCancelRequest?.();
        unsubscribeCommandCancelRequest = null;
    });

    return { buildSnapshot: () => buildAgentWorkspaceSnapshot(options) };
};
