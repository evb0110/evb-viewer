import type { Ref } from 'vue';
import type {
    IEditorPaneState,
    TEditorLayoutNode,
} from '@contracts/editorPanes';
import type { ITab } from '@app/types/tabs';
import type { IWorkspaceDocumentController } from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import { buildWorkspaceCheckpoint } from '@app/modules/workspace-shell/checkpoint/buildWorkspaceCheckpoint';
import { buildWorkspaceCheckpointChangeSignature } from '@app/modules/workspace-shell/checkpoint/buildWorkspaceCheckpointChangeSignature';
import { getWindowTabsCapability } from '@app/utils/platformWindowTabs';
import { waitForDesktopPlatformBridge } from '@app/utils/platform';
import { guardAsync } from '@app/utils/asyncGuard';
import { getErrorMessage } from '@app/utils/error';
import { getPerformanceProfile } from '@app/utils/performanceProfile';
import type { IWorkspaceCheckpoint } from '@contracts/workspaceCheckpoint';
import {useFailureToast} from '@app/composables/useFailureToast';
import { resolveDocumentSavePerformanceTier } from '@contracts/hostResourceProfile';

interface IUseWorkspaceCrashCheckpointOptions {
    enabled: Ref<boolean>;
    panes: Ref<IEditorPaneState[]>;
    tabs: Ref<ITab[]>;
    layout: Ref<TEditorLayoutNode | null>;
    activePaneId: Ref<string | null>;
    activeTabId: Ref<string | null>;
    documentSessionsByTabId: Ref<Record<string, IWorkspaceDocumentController>>;
    getPaneByTabId(tabId: string): IEditorPaneState | null;
}

export const useWorkspaceCrashCheckpoint = (options: IUseWorkspaceCrashCheckpointOptions) => {
    const {t} = useTypedI18n();
    const toast = useToast();
    const {presentNoticeToast} = useFailureToast();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight: Promise<void> | null = null;
    let pendingLatest: IWorkspaceCheckpoint | null = null;
    let disposed = false;
    const deviceTier = resolveDocumentSavePerformanceTier(getPerformanceProfile().tier);
    const debounceMs = deviceTier === 'low' ? 1_500 : 500;
    const captureRetryDelayMs = 1_000;
    const maxCaptureRetryDelayMs = 30_000;
    const maxCaptureRetryAttempts = 5;
    let captureRetryAttempt = 0;

    async function drainCheckpointWrites(initialCheckpoint: IWorkspaceCheckpoint) {
        let checkpoint: IWorkspaceCheckpoint | null = initialCheckpoint;
        let firstError: unknown;
        let retryCount = 0;
        await waitForDesktopPlatformBridge({shouldWait: true});
        while (checkpoint && !disposed) {
            if (!options.enabled.value) {
                pendingLatest = null;
                return;
            }
            try {
                await getWindowTabsCapability().saveWorkspaceCheckpoint(checkpoint);
                if (!disposed && options.enabled.value) {
                    reconcileRecoveryNotices(checkpoint);
                }
                firstError = undefined;
            } catch (error) {
                firstError ??= error;
                if (pendingLatest) {
                    checkpoint = pendingLatest;
                    pendingLatest = null;
                    retryCount = 0;
                    continue;
                }
                if (retryCount < 1) {
                    retryCount += 1;
                    continue;
                }
            }
            checkpoint = pendingLatest;
            pendingLatest = null;
            retryCount = 0;
        }
        if (firstError !== undefined) {
            throw firstError instanceof Error
                ? firstError
                : new Error(getErrorMessage(firstError));
        }
    }

    function reconcileRecoveryNotices(checkpoint: IWorkspaceCheckpoint | null) {
        const rejectedTabs = checkpoint?.tabs.filter(tab => tab.annotationRecoveryFailure) ?? [];
        for (const tab of rejectedTabs) {
            presentNoticeToast({
                id: `workspace-recovery-${tab.tabId}`,
                tone: 'warning',
                title: t('errors.workspace.recoveryProtectionTitle'),
                description: t('errors.workspace.recoveryProtectionDescription', {
                    fileName: tab.fileName ?? tab.sourceRef ?? tab.tabId,
                    message: tab.annotationRecoveryFailure!.message,
                }),
                duration: Number.POSITIVE_INFINITY,
                progress: false,
            });
        }
        // The existing toaster owns notice lifetime; derive it from the current
        // admission outcomes instead of keeping another failure-state registry.
        for (const notice of toast.toasts.value) {
            if (String(notice.id).startsWith('workspace-recovery-')
                && !rejectedTabs.some(tab => notice.id === `workspace-recovery-${tab.tabId}`)) {
                toast.remove(notice.id);
            }
        }
    }

    function persistCheckpoint(checkpoint: IWorkspaceCheckpoint) {
        if (!options.enabled.value || disposed) {
            reconcileRecoveryNotices(null);
            return;
        }
        if (inFlight) {
            pendingLatest = checkpoint;
            return;
        }
        inFlight = drainCheckpointWrites(checkpoint).finally(() => {
            inFlight = null;
            if (pendingLatest && !disposed && options.enabled.value) {
                const nextCheckpoint = pendingLatest;
                pendingLatest = null;
                persistCheckpoint(nextCheckpoint);
            }
        });
        guardAsync(inFlight, {
            category: 'background-diagnostic',
            scope: 'workspace-checkpoint',
            message: 'Failed to persist crash recovery checkpoint',
        });
    }

    /**
     * Saves the workspace as it is now, ahead of the debounce, and resolves once
     * a checkpoint holding it is written; it rejects if that write fails. A
     * write already running queues this one as the latest, so the drains are
     * awaited until none is left. Without crash checkpoints, or with no dirty
     * tab under onlyIfDirty, there is nothing to make durable.
     */
    async function persistCheckpointNow(onlyIfDirty = false) {
        if (!options.enabled.value || disposed || (onlyIfDirty && !hasDirtyTabs())) {
            return;
        }
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
        persistCheckpoint(buildWorkspaceCheckpoint(options));
        let failure: Error | null = null;
        while (inFlight) {
            try {
                await inFlight;
                failure = null;
            } catch (error) {
                failure = error instanceof Error ? error : new Error(getErrorMessage(error));
            }
        }
        if (failure !== null) {
            throw failure;
        }
    }

    function hasDirtyTabs() {
        return Object.values(options.documentSessionsByTabId.value).some(session => session.snapshot.value.dirty);
    }

    function scheduleCheckpoint(delayMs = debounceMs, onlyIfDirty = false) {
        if (timer) {
            clearTimeout(timer);
        }
        timer = setTimeout(() => {
            timer = null;
            if (!hasDirtyTabs()) {
                captureRetryAttempt = 0;
            }
            if (onlyIfDirty && !hasDirtyTabs()) {
                return;
            }
            try {
                const checkpoint = buildWorkspaceCheckpoint(options);
                captureRetryAttempt = 0;
                persistCheckpoint(checkpoint);
            } catch (error) {
                guardAsync(Promise.reject(error), {
                    category: 'background-diagnostic',
                    scope: 'workspace-checkpoint',
                    message: 'Failed to capture crash recovery checkpoint',
                });
                if (!disposed && options.enabled.value && hasDirtyTabs()) {
                    if (captureRetryAttempt < maxCaptureRetryAttempts) {
                        const retryDelayMs = Math.min(
                            captureRetryDelayMs * (2 ** captureRetryAttempt),
                            maxCaptureRetryDelayMs,
                        );
                        captureRetryAttempt += 1;
                        scheduleCheckpoint(retryDelayMs, true);
                    }
                }
            }
        }, delayMs);
    }

    const stop = watch(
        // Watch a cheap change signature instead of the serialized checkpoint:
        // the full checkpoint is built only inside the debounced persist.
        () => options.enabled.value
            ? buildWorkspaceCheckpointChangeSignature(options).workspace
            : null,
        () => {
            if (options.enabled.value) {
                scheduleCheckpoint();
            } else {
                reconcileRecoveryNotices(null);
            }
        },
        {immediate: true},
    );

    onBeforeUnmount(() => {
        reconcileRecoveryNotices(null);
        disposed = true;
        pendingLatest = null;
        stop();
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
        captureRetryAttempt = 0;
    });

    return {persistCheckpointNow};
};
