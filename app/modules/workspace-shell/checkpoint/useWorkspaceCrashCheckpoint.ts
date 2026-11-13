import type {
    InjectionKey, Ref,
} from 'vue';
import type {TDocumentRef} from '@contracts/documentRef';
import type {
    IEditorPaneState,
    TEditorLayoutNode,
} from '@contracts/editorPanes';
import type { ITab } from '@app/types/tabs';
import {
    getDocumentWorkspace,
    type IWorkspaceDocumentController,
} from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import { buildWorkspaceCheckpoint } from '@app/modules/workspace-shell/checkpoint/buildWorkspaceCheckpoint';
import { buildWorkspaceCheckpointChangeSignature } from '@app/modules/workspace-shell/checkpoint/buildWorkspaceCheckpointChangeSignature';
import { getWindowTabsCapability } from '@app/utils/platformWindowTabs';
import { waitForDesktopPlatformBridge } from '@app/utils/platform';
import { guardAsync } from '@app/utils/asyncGuard';
import { getPerformanceProfile } from '@app/utils/performanceProfile';
import type { IWorkspaceCheckpoint } from '@contracts/workspaceCheckpoint';
import { resolveDocumentSavePerformanceTier } from '@contracts/hostResourceProfile';

interface IUseWorkspaceCrashCheckpointOptions {
    enabled: Ref<boolean>;
    isStartupOpenClaimPending: Ref<boolean>;
    panes: Ref<IEditorPaneState[]>;
    tabs: Ref<ITab[]>;
    layout: Ref<TEditorLayoutNode | null>;
    activePaneId: Ref<string | null>;
    activeTabId: Ref<string | null>;
    documentSessionsByTabId: Ref<Record<string, IWorkspaceDocumentController>>;
    getPaneByTabId(tabId: string): IEditorPaneState | null;
}

/** Commits the drafts of the document whose working copy `workingCopyRef` is, before a Save writes and after it publishes. */
export const crashCheckpointBeforeSaveKey: InjectionKey<(workingCopyRef: TDocumentRef | null) => Promise<void>> = Symbol('crashCheckpointBeforeSave');

/**
 * Writes the window's tabs, panes and views shortly after they change. A document's unsaved work is not part of it:
 * the document commits its drafts itself when an edit is accepted.
 */
export const useWorkspaceCrashCheckpoint = (options: IUseWorkspaceCrashCheckpointOptions) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight: Promise<void> | null = null;
    let pendingLatest: IWorkspaceCheckpoint | null = null;
    let disposed = false;
    const deviceTier = resolveDocumentSavePerformanceTier(getPerformanceProfile().tier);
    const debounceMs = deviceTier === 'low' ? 1_500 : 500;

    // One write at a time; a checkpoint built meanwhile replaces any other waiting one.
    function persistCheckpoint(checkpoint: IWorkspaceCheckpoint): Promise<void> {
        if (inFlight) {
            pendingLatest = checkpoint;
            return inFlight;
        }
        inFlight = (async () => {
            let firstError: unknown;
            try {
                await waitForDesktopPlatformBridge({shouldWait: true});
                for (let next: IWorkspaceCheckpoint | null = checkpoint; next && !disposed && options.enabled.value; next = pendingLatest) {
                    pendingLatest = null;
                    await Promise.resolve(getWindowTabsCapability().saveWorkspaceCheckpoint?.(next)).catch((error: unknown) => {
                        firstError ??= error;
                    });
                }
                if (firstError !== undefined) throw firstError;
            } finally {
                inFlight = null;
                pendingLatest = null;
            }
        })();
        return inFlight;
    }

    /** Writes the window's layout now, ahead of the debounce, and resolves once it is written. */
    async function persistCheckpointNow() {
        if (!options.enabled.value || disposed || options.isStartupOpenClaimPending.value) return;
        await nextTick();
        if (!options.enabled.value || disposed || options.isStartupOpenClaimPending.value) return;
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
        await persistCheckpoint(buildWorkspaceCheckpoint(options));
    }

    function scheduleCheckpoint() {
        if (timer) {
            clearTimeout(timer);
        }
        timer = setTimeout(() => {
            timer = null;
            guardAsync(persistCheckpointNow(), {
                category: 'background-diagnostic',
                scope: 'workspace-checkpoint',
                message: 'Failed to capture crash recovery checkpoint',
            });
        }, debounceMs);
    }

    const stop = watch(
        // Watch a cheap change signature instead of the serialized checkpoint:
        // the full checkpoint is built only inside the debounced persist.
        () => options.enabled.value && !options.isStartupOpenClaimPending.value
            ? buildWorkspaceCheckpointChangeSignature(options).workspace
            : null,
        signature => {
            if (signature !== null) scheduleCheckpoint();
        },
        {immediate: true},
    );

    onBeforeUnmount(() => {
        disposed = true;
        pendingLatest = null;
        stop();
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
    });

    // Linked tabs share one document, which commits its drafts once.
    const documentWorkspaces = () => [...new Set(Object.values(options.documentSessionsByTabId.value))]
        .map(session => ({session, workspace: getDocumentWorkspace(session)}));
    // A Save the app does not live to finish is rolled back at the next start; the drafts it commits first hold
    // the edits it was writing, so they reopen unsaved instead of being lost.
    provide(crashCheckpointBeforeSaveKey, (workingCopyRef) => {
        const commit = documentWorkspaces().find(({session}) => session.snapshot.value.identity.workingCopyPath === workingCopyRef)
            ?.workspace?.commitDocumentDrafts;
        return commit ? commit() : Promise.reject(new Error('Recovery protection is unavailable for the saving document'));
    });
    /** Resolves once every document's drafts and the window's layout are written. */
    async function flushNow() {
        await Promise.all([
            ...documentWorkspaces().map(({workspace}) => workspace?.commitDocumentDrafts?.()),
            persistCheckpointNow(),
        ]);
    }
    return {persistCheckpointNow, flushNow};
};
