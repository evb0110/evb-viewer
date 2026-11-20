import type { Ref } from 'vue';
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
            // Deferred once so that inFlight is assigned before the body can complete and clear it.
            await Promise.resolve();
            let firstError: unknown;
            try {
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
