import { until } from '@vueuse/core';
import type {
    ComputedRef,
    Ref,
} from 'vue';
import {
    installScanCleanupRunCoordinator,
    pruneScanCleanupOutputs,
} from '@app/modules/scan-cleanup/public/runtime';
import type { IWorkspaceExpose } from '@app/types/workspaceExpose';
import type { IWorkspaceDocumentController } from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import {
    getDocumentOpenCapability,
    getDocumentWorkingCopyCapability,
} from '@app/utils/platformDocuments';
import type { TOpenFileResult } from '@contracts/electronApiDocuments';
import { createRequestId } from '@contracts/shared';
import {
    parseDocumentRef,
    type TDocumentRef,
} from '@contracts/documentRef';
import type { TTranslateFn } from '@i18n-app';
import type {ITabViewSessionState} from '@app/modules/workspace-shell/tabs/tabSessionStoreTypes';

export function resolveScanCleanupEntryViewState(
    viewState: ITabViewSessionState,
): ITabViewSessionState {
    if (viewState.surfaceMode === 'scan-cleanup') {
        return viewState;
    }
    const {
        scanCleanup: _scanCleanup,
        ...freshViewState
    } = viewState;
    return {
        ...freshViewState,
        surfaceMode: 'scan-cleanup',
    };
}

function findDocumentTabId(
    documentRef: string,
    documentSessionsByTabId: Readonly<Record<string, IWorkspaceDocumentController>>,
) {
    return Object.entries(documentSessionsByTabId).find(([
        ,
        session,
    ]) => {
        const identity = session.snapshot.value.identity;
        return identity.documentRef === documentRef
            || identity.workingCopyPath === documentRef
            || identity.originalPath === documentRef;
    })?.[0] ?? null;
}

export async function recoverScanCleanupWorkspaceForDocument(
    documentRef: string,
    documentSessionsByTabId: Readonly<Record<string, IWorkspaceDocumentController>>,
    activateTab: (tabId: string) => void,
) {
    const tabId = findDocumentTabId(documentRef, documentSessionsByTabId);
    const session = tabId ? documentSessionsByTabId[tabId] : undefined;
    if (!tabId || !session) {
        return false;
    }
    // A hidden cleanup tab is recoverable but not visibly open. Preserve its
    // cleanup session when it already owns the surface; otherwise enter with a
    // fresh selection, then make that tab visible for persisted error details.
    const view = session.getView(tabId);
    view?.applyViewState(resolveScanCleanupEntryViewState(
        view.viewState.value,
    ));
    activateTab(tabId);
    await nextTick();
    return true;
}

const ABANDONED_OPEN = Symbol('scan-cleanup-generated-open-abandoned');

/**
 * A working copy the main process created for an open nobody ended up claiming
 * belongs to no document session, so nothing else will ever release it. Only
 * the copy is discarded; the generated output it was copied from is the run's
 * product and stays on disk for the retention sweep to age out.
 */
function discardUnclaimedGeneratedOpen(result: TOpenFileResult | null) {
    if (result?.kind !== 'pdf' || !result.workingPath) {
        return;
    }
    void getDocumentWorkingCopyCapability().cleanupFile(result.workingPath).catch(() => undefined);
}

export async function openScanCleanupGeneratedPdf(
    documentRef: TDocumentRef,
    signal: AbortSignal,
    handleOpenInNewTab: (result: TOpenFileResult) => Promise<boolean>,
) {
    const documentOpen = getDocumentOpenCapability();
    const requestId = createRequestId('scan-cleanup-open');
    const cancelOpen = () => {
        void documentOpen.cancelOpenDocumentDirectBatch?.(requestId).catch(() => undefined);
    };
    if (signal.aborted) {
        return false;
    }
    signal.addEventListener('abort', cancelOpen, {once: true});
    // Both listeners are detached on every exit, including a synchronous throw
    // from the open call: the signal outlives this open, so anything left
    // attached to it accumulates for the rest of the handoff.
    const abandonOpen: { handler: (() => void) | null } = { handler: null };
    try {
        const open = documentOpen.openDocumentDirectBatch([documentRef], requestId);
        // Main-process cancellation is optional and a copy already in flight
        // cannot be interrupted, so the abort is also raced locally. The open
        // promise is still consumed either way, both to avoid an unhandled
        // rejection and to release a working copy that arrives with no tab left
        // to claim it.
        const abandoned = new Promise<typeof ABANDONED_OPEN>((resolve) => {
            const handler = () => resolve(ABANDONED_OPEN);
            abandonOpen.handler = handler;
            signal.addEventListener('abort', handler, {once: true});
        });
        const settled = await Promise.race([
            open.then(result => ({result}), (error: unknown) => ({error})),
            abandoned,
        ]);
        if (settled === ABANDONED_OPEN) {
            void open.then(discardUnclaimedGeneratedOpen, () => undefined);
            return false;
        }
        if ('error' in settled) {
            throw settled.error;
        }
        if (signal.aborted.valueOf()) {
            discardUnclaimedGeneratedOpen(settled.result);
            return false;
        }
        return settled.result?.kind === 'pdf'
            ? await handleOpenInNewTab(settled.result)
            : false;
    } finally {
        signal.removeEventListener('abort', cancelOpen);
        if (abandonOpen.handler) {
            signal.removeEventListener('abort', abandonOpen.handler);
        }
    }
}

export const useScanCleanupRunCoordinator = (
    activeWorkspace: ComputedRef<IWorkspaceExpose | null>,
    handleOpenInNewTab: (
        target: TDocumentRef | TOpenFileResult,
        paneId?: string,
        placement?: {activate: boolean},
    ) => Promise<boolean>,
    isStartupOpenClaimPending: Ref<boolean>,
    t: TTranslateFn,
    documentSessionsByTabId: ComputedRef<Record<string, IWorkspaceDocumentController>>,
    activateTab: (tabId: string) => void,
    persistCheckpointNow: () => Promise<void>,
) => {
    const toast = useToast();
    const cleanup = installScanCleanupRunCoordinator({
        // An output reopened after a reload may be back in its tab from the
        // workspace checkpoint already; that tab is the output. A replayed
        // output keeps the reader's tab in front: it is placed behind it and
        // opens when its tab is shown, reopened once its tab is checkpointed.
        openGeneratedPdf: async (path, signal, foreground) => {
            await until(isStartupOpenClaimPending).toBe(false);
            const documentRef = parseDocumentRef(path);
            if (signal.aborted || documentRef === null) {
                return false;
            }
            const tabId = findDocumentTabId(path, documentSessionsByTabId.value);
            if (tabId) {
                if (foreground) {
                    activateTab(tabId);
                }
                return true;
            }
            return foreground
                ? openScanCleanupGeneratedPdf(documentRef, signal, handleOpenInNewTab)
                : await handleOpenInNewTab(documentRef, undefined, {activate: false}) && persistCheckpointNow().then(() => true, () => false);
        },
        saveActiveDocumentAs: async () => activeWorkspace.value?.handleSaveAs() ?? false,
        openScanCleanupForDocument: documentRef => recoverScanCleanupWorkspaceForDocument(
            documentRef,
            documentSessionsByTabId.value,
            activateTab,
        ),
        t,
        toast,
    });

    onUnmounted(cleanup);
    watch(isStartupOpenClaimPending, (pending) => {
        if (!pending) void pruneScanCleanupOutputs().catch(() => undefined);
    }, {immediate: true});
};
