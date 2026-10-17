import type {
    InjectionKey, Ref,
} from 'vue';
import type {TDocumentRef} from '@contracts/documentRef';
import type {
    IEditorPaneState,
    TEditorLayoutNode,
} from '@contracts/editorPanes';
import type { ITab } from '@app/types/tabs';
import type { IWorkspaceDocumentController } from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import { buildWorkspaceCheckpoint } from '@app/modules/workspace-shell/checkpoint/buildWorkspaceCheckpoint';
import { buildWorkspaceCheckpointChangeSignature } from '@app/modules/workspace-shell/checkpoint/buildWorkspaceCheckpointChangeSignature';
import { getWindowTabsCapability } from '@app/utils/platformWindowTabs';
import {
    hasElectronAPI, waitForDesktopPlatformBridge,
} from '@app/utils/platform';
import { guardAsync } from '@app/utils/asyncGuard';
import {getErrorMessage} from '@app/utils/error';
import { getPerformanceProfile } from '@app/utils/performanceProfile';
import type { IWorkspaceCheckpoint } from '@contracts/workspaceCheckpoint';
import {useFailureToast} from '@app/composables/useFailureToast';
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

/** Writes the current checkpoint before mutation and after publication for the owned document. */
export const crashCheckpointBeforeSaveKey: InjectionKey<(workingCopyRef: TDocumentRef | null, assertCurrent?: () => void) => Promise<void>> = Symbol('crashCheckpointBeforeSave');

export const useWorkspaceCrashCheckpoint = (options: IUseWorkspaceCrashCheckpointOptions) => {
    const {t} = useTypedI18n();
    const toast = useToast();
    const {presentNoticeToast} = useFailureToast();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight: Promise<IWorkspaceCheckpoint | undefined> | null = null;
    let pendingLatest: IWorkspaceCheckpoint | null = null;
    let disposed = false;
    const deviceTier = resolveDocumentSavePerformanceTier(getPerformanceProfile().tier);
    const debounceMs = deviceTier === 'low' ? 1_500 : 500;

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

    function persistCheckpoint(checkpoint: IWorkspaceCheckpoint): Promise<IWorkspaceCheckpoint | undefined> {
        if (inFlight) {
            pendingLatest = checkpoint;
            return inFlight;
        }
        pendingLatest = null;
        inFlight = (async () => {
            let firstError: Error | undefined;
            try {
                await waitForDesktopPlatformBridge({shouldWait: true});
                while (!disposed && options.enabled.value) {
                    try {
                        if (!await getWindowTabsCapability().saveWorkspaceCheckpoint?.(checkpoint)) {
                            pendingLatest = null;
                            if (firstError !== undefined) throw firstError;
                            return undefined;
                        }
                        if (!disposed && options.enabled.value && !options.isStartupOpenClaimPending.value) reconcileRecoveryNotices(checkpoint);
                        firstError = undefined;
                    } catch (error) {
                        firstError ??= error instanceof Error ? error : new Error(getErrorMessage(error));
                    }
                    if (!pendingLatest) break;
                    checkpoint = pendingLatest;
                    pendingLatest = null;
                }
                pendingLatest = null;
                if (firstError !== undefined) throw firstError;
                return !disposed && options.enabled.value ? checkpoint : undefined;
            } finally {
                inFlight = null;
            }
        })();
        return inFlight;
    }

    /**
     * Saves the workspace as it is now, ahead of the debounce, and resolves once
     * a checkpoint holding it is written; it rejects if that write fails. A
     * write already running queues this one as the latest, so the drains are
     * awaited until none is left. Background writes may omit rejected captures;
     * Save requires its dirty target's artifact and live document identity after
     * the corresponding main save promise fulfills, never just a main flush.
     */
    async function persistCheckpointNow(onlyIfDirty = false, workingCopyRef?: TDocumentRef | null, assertCurrent?: () => void) {
        if (workingCopyRef === undefined && (!options.enabled.value || disposed || options.isStartupOpenClaimPending.value || (onlyIfDirty && !Object.values(options.documentSessionsByTabId.value).some(session => session.snapshot.value.dirty)))) return;
        await nextTick();
        if (!options.enabled.value || disposed || (workingCopyRef === undefined && options.isStartupOpenClaimPending.value)) {
            if (workingCopyRef === undefined) return;
            throw new DOMException('Workspace recovery ownership ended', 'AbortError');
        }
        const checkpoint = buildWorkspaceCheckpoint(options, options.isStartupOpenClaimPending.value ? workingCopyRef : undefined);
        const target = workingCopyRef === undefined ? undefined : checkpoint.tabs.find(tab => tab.workingCopyRef === workingCopyRef);
        const document = target && options.documentSessionsByTabId.value[target.tabId];
        const identity = document?.snapshot.value.identity;
        const frontier = document?.readMutationFrontier();
        if (workingCopyRef !== undefined && (!workingCopyRef || !target || !identity?.documentInstanceId
            || identity.workingCopyPath !== workingCopyRef || !identity.revisionInfo?.token || frontier === null || frontier === undefined
            || (target.isDirty && (!target.annotationRecovery || target.annotationRecoveryFailure)))) {
            throw new Error(target?.annotationRecoveryFailure?.message ?? 'Recovery protection is unavailable for the saving document');
        }
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
        const written = await persistCheckpoint(checkpoint);
        if (target) {
            const protectedTarget = written?.tabs.find(tab => tab.workingCopyRef === workingCopyRef);
            const current = document?.snapshot.value;
            if (!written || !options.enabled.value || disposed || !current || current.phase !== 'presented' || current.activeTransaction
                || !Object.values(options.documentSessionsByTabId.value).includes(document)
                || current.identity.documentInstanceId !== identity?.documentInstanceId
                || current.identity.workingCopyPath !== workingCopyRef
                || current.identity.revisionInfo?.token !== identity?.revisionInfo?.token
                || (!assertCurrent && (document?.readMutationFrontier() !== frontier || current.dirty !== target.isDirty))) {
                throw new DOMException('Workspace document ownership ended', 'AbortError');
            }
            assertCurrent?.();
            if (!protectedTarget || protectedTarget.isDirty !== target.isDirty
                || (target.isDirty && (protectedTarget.annotationRecoveryFailure || !protectedTarget.annotationRecovery
                    || protectedTarget.annotationRecovery.documentInstanceId !== target.annotationRecovery!.documentInstanceId
                    || protectedTarget.annotationRecovery.workingByteRevision !== target.annotationRecovery!.workingByteRevision
                    || protectedTarget.annotationRecovery.annotationMutationGeneration < target.annotationRecovery!.annotationMutationGeneration))) {
                throw new Error(protectedTarget?.annotationRecoveryFailure?.message ?? 'Recovery settlement did not protect the current document');
            }
        }
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
            if (signature !== null) {
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
    });

    // A Save the app does not live to finish is rolled back at the next start, together with the edits it was writing;
    // the checkpoint a Save writes first holds those edits, so they reopen unsaved instead of being lost.
    if (hasElectronAPI()) provide(crashCheckpointBeforeSaveKey, (workingCopyRef, assertCurrent) => persistCheckpointNow(true, workingCopyRef, assertCurrent));
    return {persistCheckpointNow};
};
