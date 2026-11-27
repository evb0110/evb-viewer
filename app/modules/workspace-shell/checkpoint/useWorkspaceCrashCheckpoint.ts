import type { Ref } from 'vue';
import { useTimeoutFn } from '@vueuse/core';
import {
    WORKSPACE_CRASH_CHECKPOINT_DEBOUNCE_MS,
    WORKSPACE_CRASH_CHECKPOINT_LOW_TIER_DEBOUNCE_MS,
} from '@app/constants/timeouts';
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

/**
 * Writes the window's tabs, panes and views: at once when the documents it presents change, shortly after a view
 * change. A document's unsaved work is not part of it: the document commits its drafts itself when an edit is accepted.
 */
export const useWorkspaceCrashCheckpoint = (options: IUseWorkspaceCrashCheckpointOptions) => {
    let inFlight: Promise<void> | null = null;
    let pendingLatest: IWorkspaceCheckpoint | null = null;
    let disposed = false;
    const deviceTier = resolveDocumentSavePerformanceTier(getPerformanceProfile().tier);
    const debounceMs = deviceTier === 'low'
        ? WORKSPACE_CRASH_CHECKPOINT_LOW_TIER_DEBOUNCE_MS
        : WORKSPACE_CRASH_CHECKPOINT_DEBOUNCE_MS;
    const {
        start: scheduleCheckpoint,
        stop: cancelScheduledCheckpoint,
    } = useTimeoutFn(persistInBackground, debounceMs, {immediate: false});

    // One write at a time; a checkpoint built meanwhile replaces any other waiting one.
    function persistCheckpoint(checkpoint: IWorkspaceCheckpoint): Promise<void> {
        if (inFlight) {
            pendingLatest = checkpoint;
            return inFlight;
        }
        inFlight = (async () => {
            // Deferred once so that inFlight is assigned before the body can complete and clear it.
            await Promise.resolve();
            // Only the last write decides the outcome: a later checkpoint replaces an earlier one that failed.
            let failure: {error: unknown} | null = null;
            try {
                for (let next: IWorkspaceCheckpoint | null = pendingLatest ?? checkpoint; next && !disposed && options.enabled.value; next = pendingLatest) {
                    pendingLatest = null;
                    failure = null;
                    await Promise.resolve(getWindowTabsCapability().saveWorkspaceCheckpoint?.(next)).catch((error: unknown) => {
                        failure = {error};
                    });
                }
                if (failure) throw (failure as {error: unknown}).error;
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
        cancelScheduledCheckpoint();
        await persistCheckpoint(buildWorkspaceCheckpoint(options));
    }

    function persistInBackground() {
        guardAsync(persistCheckpointNow(), {
            category: 'background-diagnostic',
            scope: 'workspace-checkpoint',
            message: 'Failed to capture crash recovery checkpoint',
        });
    }

    // Watch a cheap change signature instead of the serialized checkpoint:
    // the full checkpoint is built only when it is written.
    const signature = computed(() => options.enabled.value && !options.isStartupOpenClaimPending.value
        ? buildWorkspaceCheckpointChangeSignature(options)
        : null);
    const stop = watch(
        [() => signature.value?.workspace ?? null, () => signature.value?.structure ?? null],
        ([workspace, structure], previous) => {
            if (workspace === null) return;
            // A document opened, closed, moved or saved is written at once, so a crash right after it
            // still relaunches with that tab. View state such as page and zoom waits for the debounce.
            if (structure !== previous?.[1]) persistInBackground();
            else scheduleCheckpoint();
        },
        {immediate: true},
    );

    onBeforeUnmount(() => {
        disposed = true;
        pendingLatest = null;
        stop();
        cancelScheduledCheckpoint();
    });

    /** Resolves once every document's drafts and the window's layout are written. */
    async function flushNow() {
        await Promise.all([
            // Linked tabs share one document, which commits its drafts once.
            ...[...new Set(Object.values(options.documentSessionsByTabId.value))].map(session => getDocumentWorkspace(session)?.commitDocumentDrafts?.()),
            persistCheckpointNow(),
        ]);
    }
    return {persistCheckpointNow, flushNow};
};
