import { delay } from 'es-toolkit/promise';
import type { ShallowRef } from 'vue';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TTabUpdate } from '@app/types/tabs';
import type {
    IWorkspaceExpose,
    IWorkspaceToolbarSnapshot,
} from '@app/types/workspaceExpose';
import type { IDocumentOpenIntent } from '@app/modules/workspace-shell/document-sessions/documentOpenIntent';
import {
    createPendingWorkspaceDocumentRecord,
    createWorkspaceDocumentRecord,
    type IWorkspaceDocumentRecord,
} from '@app/modules/workspace-shell/state/workspaceDocumentRecord';
import { isRestoreDocumentOpenAction } from '@app/modules/workspace-shell/document-sessions/isRestoreDocumentOpenAction';
import { DEFERRED_WORKSPACE_HOST_POLICY } from '@app/modules/workspace-shell/host/deferredWorkspaceHostPolicy';
import { toolbarSnapshotHasAcceptedDocument } from '@app/modules/workspace-shell/host/toolbarSnapshotHasAcceptedDocument';
import { hasWorkspaceViewerDocumentCapabilities } from '@app/modules/workspace-shell/viewers/workspaceViewerAdapters';
import { BrowserLogger } from '@app/utils/browserLogger';
import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';
import type { IDocumentOpenSurfaceSession } from '@app/modules/document-viewer/public';

export interface IWorkspaceDocumentOpenHost {
    documentOpenSurface: IDocumentOpenSurfaceSession;
    getActiveTransactionId: () => string | null;
    getInitialViewState: () => {currentPage?: number | undefined} | null | undefined;
    getSeedToolbarSnapshot: () => IWorkspaceToolbarSnapshot;
    hasDocumentOrOpenError: () => boolean;
    hasOpenedDocument: () => boolean;
    hasSessionOpenedDocument: () => boolean;
    isHostUnmounted: () => boolean;
    publishDocumentRecord: (record: IWorkspaceDocumentRecord) => void;
    requestWorkspaceMount: (reason: string) => void;
}

interface IDocumentOpenTransactionRun {
    transactionId: string;
    action: string;
    preserveDirtyOnFailure: boolean;
    acceptDocumentWithoutVisual: boolean;
    target: TTabUpdate | null;
    seededTabHint: boolean;
}

function shouldSeedPendingTabHint(target: TTabUpdate | null | undefined, hasWorkspaceOpenedDocument: boolean,
    hasWorkspaceSessionOpenedDocument: boolean) {
    return Boolean(target && !hasWorkspaceOpenedDocument && !hasWorkspaceSessionOpenedDocument);
}

export function resolveOpenSurfaceDocumentId(target: TTabUpdate | null, transactionDocumentRef: TDocumentRef | null, fallbackId: string) {
    return String(target?.originalPath ?? transactionDocumentRef ?? fallbackId);
}

export function resolveDocumentOpenRunResult<T>(result: T | false, reachedTerminalState: boolean) {
    return result !== false && reachedTerminalState
        ? result
        : false;
}

const DOCUMENT_OPEN_ABORTED = Symbol('document-open-aborted');

async function waitForDocumentOpenTask<T>(task: Promise<T>, signal: AbortSignal) {
    if (signal.aborted) {
        return DOCUMENT_OPEN_ABORTED;
    }
    const abortState: { handler: (() => void) | null } = {handler: null};
    const aborted = new Promise<typeof DOCUMENT_OPEN_ABORTED>((resolve) => {
        const handler = () => resolve(DOCUMENT_OPEN_ABORTED);
        abortState.handler = handler;
        signal.addEventListener('abort', handler, {once: true});
    });
    try {
        return await Promise.race([
            task,
            aborted,
        ]);
    } finally {
        const handler = abortState.handler;
        if (handler) {
            signal.removeEventListener('abort', handler);
        }
    }
}

export function createWorkspaceDocumentOpenTransactions(options: {
    tabId: string;
    mountedWorkspace: ShallowRef<IWorkspaceExpose | null>;
}) {
    let host: IWorkspaceDocumentOpenHost | null = null;
    let hostEverAttached = false;
    let pendingPreOwnerGoToPage: readonly [page: number, attempt: number] | null = null;
    let documentOpenAttemptCounter = 0;

    function attachHost(nextHost: IWorkspaceDocumentOpenHost) {
        host = nextHost;
        hostEverAttached = true;
        pendingPreOwnerGoToPage = null;
        documentOpenAttemptCounter = 0;
        return () => {
            if (host === nextHost) {
                host = null;
                pendingPreOwnerGoToPage = null;
                documentOpenAttemptCounter = 0;
            }
        };
    }

    function workspaceHasSuccessfulInitialVisual() {
        const toolbarSnapshot = options.mountedWorkspace.value?.getToolbarSnapshot();
        return Boolean(toolbarSnapshot?.initialVisualReady
            && !toolbarSnapshot.hasOpenError
            && hasWorkspaceViewerDocumentCapabilities(toolbarSnapshot.viewerCapabilities));
    }

    function workspaceHasAcceptedDocument() {
        return toolbarSnapshotHasAcceptedDocument(options.mountedWorkspace.value?.getToolbarSnapshot());
    }

    function beginDocumentOpenTransaction(openHost: IWorkspaceDocumentOpenHost, intent: IDocumentOpenIntent,
        transactionId: string, transactionDocumentRef: TDocumentRef | null) {
        const target = intent.target ?? null;
        const currentSurface = openHost.documentOpenSurface.snapshot.value;
        const surfaceAcceptsOpeningTransaction = (
            currentSurface.phase === 'idle'
            || currentSurface.phase === 'ready'
            || currentSurface.phase === 'failed'
        );
        logPdfRenderTrace('pdf-open-surface-transaction-start', {
            action: intent.action,
            currentDocumentId: currentSurface.identity?.documentId ?? null,
            currentGeneration: currentSurface.generation,
            currentPhase: currentSurface.phase,
            targetDocumentId: target?.originalPath ?? transactionDocumentRef ?? null,
            transactionId,
        });
        const documentId = resolveOpenSurfaceDocumentId(
            target,
            transactionDocumentRef,
            options.tabId,
        );
        const transaction: IDocumentOpenTransactionRun = {
            transactionId,
            action: intent.action,
            preserveDirtyOnFailure: intent.preserveDirtyOnFailure === true,
            acceptDocumentWithoutVisual: intent.acceptDocumentWithoutVisual === true,
            target,
            seededTabHint: shouldSeedPendingTabHint(
                target,
                openHost.hasOpenedDocument(),
                openHost.hasSessionOpenedDocument(),
            ),
        };

        if (surfaceAcceptsOpeningTransaction) {
            const identity = {
                documentId,
                documentRevision: `open-intent:${transactionId}`,
                provisional: true,
            };
            const initialViewState = openHost.getInitialViewState();
            const restoredInitialPage = isRestoreDocumentOpenAction(intent.action)
                ? Math.max(1, Math.trunc(initialViewState?.currentPage ?? 1))
                : null;
            openHost.documentOpenSurface.begin(identity, null, restoredInitialPage ?? 1);
            if (pendingPreOwnerGoToPage !== null) {
                if (pendingPreOwnerGoToPage[1] === documentOpenAttemptCounter) {
                    openHost.documentOpenSurface.requestNavigation(pendingPreOwnerGoToPage[0]);
                }
                pendingPreOwnerGoToPage = null;
            }
            const claimedSurface = openHost.documentOpenSurface.snapshot.value;
            logPdfRenderTrace('pdf-open-surface-transaction-claimed', {
                action: intent.action,
                documentId: claimedSurface.identity?.documentId ?? null,
                generation: claimedSurface.generation,
                hasOpeningFrame: claimedSurface.openingPageFrame !== null,
                hasOpeningGeometry: claimedSurface.openingPageGeometry !== null,
                phase: claimedSurface.phase,
                transactionId,
            });
        }

        if (transaction.seededTabHint && target) {
            openHost.publishDocumentRecord(createPendingWorkspaceDocumentRecord(
                target,
                {previousToolbarSnapshot: openHost.getSeedToolbarSnapshot()},
            ));
        }

        openHost.requestWorkspaceMount(`document-open:${intent.action}`);

        BrowserLogger.debug(DEFERRED_WORKSPACE_HOST_POLICY.RECENT_OPEN_LOG_SECTION, 'Document open transaction started', {
            tabId: options.tabId,
            transactionId,
            action: transaction.action,
            seededTabHint: transaction.seededTabHint,
            target: transaction.target,
        });

        return transaction;
    }

    async function waitForDocumentOpenTerminalState(openHost: IWorkspaceDocumentOpenHost,
        transaction: IDocumentOpenTransactionRun, opened: boolean, signal: AbortSignal) {
        await nextTick();
        if (
            !opened
            || signal.aborted
            || openHost.getActiveTransactionId() !== transaction.transactionId
        ) {
            return false;
        }
        const deadline = Date.now() + DEFERRED_WORKSPACE_HOST_POLICY.DOCUMENT_OPEN_SETTLE_TIMEOUT_MS;
        while (
            !openHost.isHostUnmounted()
            && !signal.aborted.valueOf()
            && openHost.getActiveTransactionId() === transaction.transactionId
            && Date.now() < deadline
        ) {
            const workspace = options.mountedWorkspace.value;
            if (workspace) {
                const remainingMs = Math.max(0, deadline - Date.now());
                if (remainingMs > 0) {
                    try {
                        await Promise.race([
                            workspace.waitForDocumentOpenSettled({
                                ...(transaction.acceptDocumentWithoutVisual
                                    ? {acceptDocumentWithoutVisual: true}
                                    : {}),
                                signal,
                            }),
                            delay(remainingMs).then(() => {
                                throw new Error('Document open settle timed out');
                            }),
                        ]);
                        if (
                            signal.aborted.valueOf()
                            || openHost.getActiveTransactionId() !== transaction.transactionId
                        ) {
                            return false;
                        }
                    } catch (error) {
                        if (
                            signal.aborted.valueOf()
                            || openHost.getActiveTransactionId() !== transaction.transactionId
                        ) {
                            return false;
                        }
                        BrowserLogger.warn(DEFERRED_WORKSPACE_HOST_POLICY.RECENT_OPEN_LOG_SECTION, 'Document open settle wait failed', {
                            tabId: options.tabId,
                            transactionId: transaction.transactionId,
                            action: transaction.action,
                            target: transaction.target,
                            error,
                        });
                        return false;
                    }
                }
                if (workspace.getToolbarSnapshot().hasOpenError) {
                    return false;
                }
                if (transaction.acceptDocumentWithoutVisual && workspaceHasAcceptedDocument()) {
                    return true;
                }
                if (workspaceHasSuccessfulInitialVisual()) {
                    return true;
                }
            } else {
                await delay(DEFERRED_WORKSPACE_HOST_POLICY.WORKSPACE_MOUNT_POLL_INTERVAL_MS);
                if (
                    signal.aborted.valueOf()
                    || openHost.getActiveTransactionId() !== transaction.transactionId
                ) {
                    return false;
                }
            }
        }
        if (
            signal.aborted.valueOf()
            || openHost.getActiveTransactionId() !== transaction.transactionId
        ) {
            return false;
        }
        const hasTerminalDocumentState = transaction.acceptDocumentWithoutVisual
            ? workspaceHasAcceptedDocument()
            : workspaceHasSuccessfulInitialVisual();
        if (!hasTerminalDocumentState) {
            BrowserLogger.warn(DEFERRED_WORKSPACE_HOST_POLICY.RECENT_OPEN_LOG_SECTION, 'Document open did not reach a terminal visible state before settle timeout', {
                tabId: options.tabId,
                transactionId: transaction.transactionId,
                action: transaction.action,
                target: transaction.target,
                timeoutMs: DEFERRED_WORKSPACE_HOST_POLICY.DOCUMENT_OPEN_SETTLE_TIMEOUT_MS,
                hasMountedWorkspace: options.mountedWorkspace.value !== null,
                acceptDocumentWithoutVisual: transaction.acceptDocumentWithoutVisual,
            });
        }
        return hasTerminalDocumentState;
    }

    function finishDocumentOpenPresentation(openHost: IWorkspaceDocumentOpenHost,
        transaction: IDocumentOpenTransactionRun, opened: boolean) {
        pendingPreOwnerGoToPage = null;
        // A failed open with nothing on screen gives the tab back to Start, so
        // its seeded name goes too; left behind, the name reads as a document
        // to restore and the same file is opened again. A failed restore keeps
        // its name as the record of what the tab owned.
        if (
            !opened
            && transaction.seededTabHint
            && !transaction.preserveDirtyOnFailure
            && openHost.getActiveTransactionId() === transaction.transactionId
            && !openHost.hasOpenedDocument()
            && (!openHost.hasDocumentOrOpenError() || !isRestoreDocumentOpenAction(transaction.action))
        ) {
            openHost.publishDocumentRecord(createWorkspaceDocumentRecord());
        }
        if (
            !opened
            && openHost.documentOpenSurface.snapshot.value.identity?.documentRevision
                === `open-intent:${transaction.transactionId}`
        ) {
            openHost.documentOpenSurface.reset();
        }
        BrowserLogger.debug(DEFERRED_WORKSPACE_HOST_POLICY.RECENT_OPEN_LOG_SECTION, 'Document open transaction finished', {
            tabId: options.tabId,
            transactionId: transaction.transactionId,
            action: transaction.action,
            opened,
            hasTerminalDocumentState: openHost.hasDocumentOrOpenError(),
        });
    }

    async function run<T>(intent: IDocumentOpenIntent, transactionId: string,
        transactionDocumentRef: TDocumentRef | null, sourceOpen: (signal: AbortSignal) => Promise<T>,
        signal: AbortSignal): Promise<T | false> {
        const openHost = host;
        if (!openHost) {
            // A detached presentation host refuses opens, preserving the
            // pre-consolidation unmounted-host contract for stale expose
            // proxies and transactions queued behind an unmount. Only a
            // controller that never had a host runs source opens bare.
            if (hostEverAttached) {
                return false;
            }
            if (signal.aborted) {
                return false;
            }
            const result = await waitForDocumentOpenTask(sourceOpen(signal), signal);
            return signal.aborted.valueOf() || result === DOCUMENT_OPEN_ABORTED ? false : result;
        }
        if (openHost.isHostUnmounted() || signal.aborted) {
            return false;
        }
        // Keep the mounted path in the click call stack so rapid page commands cannot overtake the open transaction.
        documentOpenAttemptCounter += 1;
        const transaction = beginDocumentOpenTransaction(openHost, intent, transactionId, transactionDocumentRef);
        if (!transaction) {
            pendingPreOwnerGoToPage = null;
            return false;
        }
        let opened = false;
        try {
            if (signal.aborted.valueOf() || openHost.getActiveTransactionId() !== transaction.transactionId) {
                return false;
            }
            const sourceResult = await waitForDocumentOpenTask(sourceOpen(signal), signal);
            if (
                signal.aborted.valueOf()
                || sourceResult === DOCUMENT_OPEN_ABORTED
                || openHost.getActiveTransactionId() !== transaction.transactionId
            ) {
                return false;
            }
            if (sourceResult === false) {
                return false;
            }
            const reachedTerminalState = await waitForDocumentOpenTerminalState(
                openHost,
                transaction,
                sourceResult !== false,
                signal,
            );
            if (signal.aborted.valueOf()) {
                return false;
            }
            const settledResult = resolveDocumentOpenRunResult(
                sourceResult,
                reachedTerminalState,
            );
            if (settledResult === false) {
                return false;
            }
            opened = true;
            return settledResult;
        } finally {
            pendingPreOwnerGoToPage = null;
            if (
                !signal.aborted.valueOf()
                || (signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError')
            ) {
                finishDocumentOpenPresentation(openHost, transaction, opened);
            }
        }
    }

    function requestPage(page: number) {
        const openHost = host;
        if (!openHost) {
            return;
        }
        if (openHost.documentOpenSurface.viewportSession.value.identity === null) {
            pendingPreOwnerGoToPage = [
                page,
                documentOpenAttemptCounter,
            ];
            return;
        }
        openHost.documentOpenSurface.requestNavigation(page);
    }

    return {
        attachHost,
        requestPage,
        run,
    };
}
