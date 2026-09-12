import type { Ref } from 'vue';
import { useEventListener } from '@vueuse/core';
import type {
    IEditorPaneState,
    TEditorLayoutNode,
} from '@contracts/editorPanes';
import type { ITab } from '@app/types/tabs';
import type { IWorkspaceExpose } from '@app/types/workspaceExpose';
import type { IWorkspaceDocumentRecord } from '@app/modules/workspace-shell/state/workspaceDocumentRecord';
import { buildWorkspaceCheckpoint } from '@app/modules/workspace-shell/checkpoint/buildWorkspaceCheckpoint';
import {
    buildWorkspaceCheckpointChangeSignature,
    type IWorkspaceCheckpointChangeSignature,
} from '@app/modules/workspace-shell/checkpoint/buildWorkspaceCheckpointChangeSignature';
import { browserDocumentStore } from '@app/platform/browserDocumentStore';
import {
    clearBrowserWorkspaceRecovery,
    loadBrowserWorkspaceRecovery,
    saveBrowserWorkspaceRecovery,
    touchBrowserWorkspaceRecovery,
} from '@app/platform/browser/browserWorkspaceRecoveryStore';
import { BrowserLogger } from '@app/utils/browserLogger';
import { getBrowserWindowRecoveryOwnerId } from '@app/platform/browserWindowTabs';
import type { TDocumentRef } from '@contracts/documentRef';
import { createEpochMs } from '@contracts/timestamps';
import type { TTabId } from '@contracts/windowTabs';
import {
    createBrowserDocumentLiveLease,
    releaseBrowserDocumentLiveLease,
    saveBrowserDocumentLiveLease,
} from '@app/platform/browser/browserDocumentLeaseStore';

interface IUseBrowserWorkspaceRecoveryOptions {
    enabled: Ref<boolean>;
    panes: Ref<IEditorPaneState[]>;
    tabs: Ref<ITab[]>;
    layout: Ref<TEditorLayoutNode | null>;
    activePaneId: Ref<string | null>;
    activeTabId: Ref<string | null>;
    workspaceRefs: Ref<Map<string, IWorkspaceExpose>>;
    documentRecordsByTabId: Ref<Record<string, IWorkspaceDocumentRecord>>;
    getPaneByTabId(tabId: string): IEditorPaneState | null;
}

const RECOVERY_DEBOUNCE_MS = 750;
const RECOVERY_RETRY_MS = 2_000;
const RECOVERY_HEARTBEAT_MS = 10_000;

export const useBrowserWorkspaceRecovery = (options: IUseBrowserWorkspaceRecoveryOptions) => {
    let activeOwnerId: string | null = null;
    let generation: number | null = null;
    let liveLeaseGeneration: number | null = null;
    let liveLeaseDependencies: Array<{ref: TDocumentRef}> = [];
    let fenced = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
    let inFlight: Promise<void> | null = null;
    let disposed = false;
    let checkpointRevision = 0;
    let persistedCheckpointRevision = -1;
    let attemptedCheckpointRevision = -1;
    let retryNotBefore = 0;
    let previousTabSignatures = new Map<string, string>();
    let observedSignature: IWorkspaceCheckpointChangeSignature | null = null;
    const tabMutationRevisions = new Map<string, number>();
    const persistedTabMutationRevisions = new Map<string, number>();
    const attemptedTabMutationRevisions = new Map<string, number>();

    function stopHeartbeat() {
        if (heartbeatTimer) {
            clearTimeout(heartbeatTimer);
            heartbeatTimer = null;
        }
    }

    function scheduleHeartbeat(delay = RECOVERY_HEARTBEAT_MS) {
        if (
            heartbeatTimer
            || disposed
            || fenced
            || !options.enabled.value
            || !activeOwnerId
            || generation === null
        ) {
            return;
        }
        heartbeatTimer = setTimeout(() => {
            heartbeatTimer = null;
            void heartbeatRecoveryLease();
        }, delay);
    }

    async function heartbeatRecoveryLease() {
        const ownerId = activeOwnerId;
        const expectedGeneration = generation;
        if (
            !ownerId
            || expectedGeneration === null
            || disposed
            || fenced
            || !options.enabled.value
        ) {
            return;
        }

        try {
            const outcome = await touchBrowserWorkspaceRecovery(ownerId, expectedGeneration);
            if (outcome.saved) {
                generation = outcome.generation;
                if (liveLeaseGeneration !== null || liveLeaseDependencies.length > 0) {
                    try {
                        // A null generation means the lease was reclaimed or
                        // never published. Re-acquiring is what keeps a
                        // quiescent window protected, since nothing else
                        // publishes a lease until the next recovery save.
                        const liveLease = liveLeaseGeneration === null
                            ? await createBrowserDocumentLiveLease(ownerId, liveLeaseDependencies)
                            : await saveBrowserDocumentLiveLease(
                                ownerId,
                                liveLeaseGeneration,
                                'active',
                                liveLeaseDependencies,
                            );
                        liveLeaseGeneration = liveLease.generation;
                    } catch (error) {
                        // Maintenance reclaims the lease of an owner that looks
                        // abandoned. Forget the generation so the next attempt
                        // re-acquires; keeping the stale one would fail every
                        // future write and leave this window's documents
                        // unprotected without ever saying so.
                        liveLeaseGeneration = null;
                        BrowserLogger.warn('workspace-recovery', 'Browser document live lease was reclaimed; re-acquiring', error);
                    }
                }
            } else if (activeOwnerId === ownerId && generation === expectedGeneration) {
                fenced = true;
                stopHeartbeat();
                BrowserLogger.warn(
                    'workspace-recovery',
                    `Recovery lease disappeared or changed while heartbeating owner ${ownerId} at generation ${String(expectedGeneration)}; fencing stale writer`,
                );
                return;
            }
        } catch (error) {
            // A temporary IndexedDB failure should not make this context discard
            // its only recovery copy. Retry the heartbeat and let the owner
            // claim CAS decide whether the lease was actually lost.
            BrowserLogger.warn('workspace-recovery', 'Failed to heartbeat browser recovery snapshot', error);
        } finally {
            if (activeOwnerId === ownerId && generation === expectedGeneration) {
                scheduleHeartbeat();
            }
        }
    }

    function hasDirtyTabs() {
        return options.tabs.value.some(tab => tab.isDirty);
    }

    async function cleanupSnapshots(refs: Iterable<string>, retainedRefs = new Set<string>()) {
        await Promise.allSettled(Array.from(refs, async (ref) => {
            if (!retainedRefs.has(ref)) {
                await browserDocumentStore.cleanupDetachedDocument(ref);
            }
        }));
    }

    function dirtyTabIds() {
        return new Set(options.tabs.value.filter(tab => tab.isDirty).map(tab => tab.id));
    }

    function markMutation(tabIds: Iterable<string>) {
        checkpointRevision += 1;
        for (const tabId of tabIds) {
            tabMutationRevisions.set(tabId, (tabMutationRevisions.get(tabId) ?? 0) + 1);
        }
        retryNotBefore = 0;
    }

    function recordCheckpointMutation(signature: IWorkspaceCheckpointChangeSignature) {
        const dirtyIds = dirtyTabIds();
        const changedDirtyTabs = [...signature.tabSignatures]
            .filter(([
                tabId,
                tabSignature,
            ]) => dirtyIds.has(tabId) && previousTabSignatures.get(tabId) !== tabSignature)
            .map(([tabId]) => tabId);
        previousTabSignatures = new Map(signature.tabSignatures);
        markMutation(changedDirtyTabs);
    }

    function hasPendingWork(now = Date.now()) {
        if (
            checkpointRevision > persistedCheckpointRevision
            && (
                checkpointRevision > attemptedCheckpointRevision
                || now >= retryNotBefore
            )
        ) {
            return true;
        }
        return Array.from(dirtyTabIds()).some((tabId) => {
            const revision = tabMutationRevisions.get(tabId) ?? 0;
            if (revision <= (persistedTabMutationRevisions.get(tabId) ?? -1)) {
                return false;
            }
            return revision > (attemptedTabMutationRevisions.get(tabId) ?? -1)
                || now >= retryNotBefore;
        });
    }

    function hasUnpersistedWork() {
        if (checkpointRevision > persistedCheckpointRevision) {
            return true;
        }
        return Array.from(dirtyTabIds()).some(tabId => (
            (tabMutationRevisions.get(tabId) ?? 0)
            > (persistedTabMutationRevisions.get(tabId) ?? -1)
        ));
    }

    async function persistCurrentRecovery(
        capturedCheckpointRevision: number,
        capturedTabMutationRevisions: ReadonlyMap<string, number>,
    ) {
        const ownerId = getBrowserWindowRecoveryOwnerId();
        if (!ownerId) {
            retryNotBefore = Date.now() + RECOVERY_RETRY_MS;
            return;
        }
        if (ownerId !== activeOwnerId) {
            if (activeOwnerId && liveLeaseGeneration !== null) {
                await releaseBrowserDocumentLiveLease(activeOwnerId, liveLeaseGeneration).catch(() => undefined);
            }
            stopHeartbeat();
            activeOwnerId = ownerId;
            generation = null;
            fenced = false;
            persistedCheckpointRevision = -1;
            persistedTabMutationRevisions.clear();
            attemptedTabMutationRevisions.clear();
            liveLeaseGeneration = null;
        }
        const checkpoint = buildWorkspaceCheckpoint(options);
        const allDirtyTabs = checkpoint.tabs.filter(tab => tab.isDirty);
        const previous = await loadBrowserWorkspaceRecovery(ownerId);
        const expectedGeneration = generation ?? previous?.generation ?? 0;
        generation = expectedGeneration;
        if (allDirtyTabs.length === 0) {
            if (previous) {
                const outcome = await clearBrowserWorkspaceRecovery(ownerId, expectedGeneration);
                generation = outcome.generation;
                if (!outcome.saved) {
                    BrowserLogger.warn(
                        'workspace-recovery',
                        `Recovery lease changed while clearing owner ${ownerId} at generation ${String(expectedGeneration)}; fencing stale writer`,
                    );
                    fenced = true;
                    stopHeartbeat();
                    return;
                }
                await cleanupSnapshots(previous.snapshotRefs);
            }
            stopHeartbeat();
            if (liveLeaseGeneration !== null) {
                try {
                    await releaseBrowserDocumentLiveLease(ownerId, liveLeaseGeneration);
                    liveLeaseGeneration = null;
                } catch {
                    // Keep the generation so the next drain can retry release.
                }
            }
            liveLeaseDependencies = [];
            persistedCheckpointRevision = Math.max(
                persistedCheckpointRevision,
                capturedCheckpointRevision,
            );
            return;
        }
        const createdRefs: TDocumentRef[] = [];
        try {
            const replacements = new Map<TTabId, TDocumentRef>();
            const retainedRecoveryTabs = new Map(
                (previous?.checkpoint.tabs ?? [])
                    .filter(tab => tab.isDirty && tab.workingCopyRef)
                    .map(tab => [
                        tab.tabId,
                        tab,
                    ]),
            );
            const retainedRefs = new Set<TDocumentRef>();
            const refreshedTabIds = new Set<TTabId>();
            const unavailableRecoveryTabIds = new Set<TTabId>();
            let shouldRetry = false;
            for (const tab of allDirtyTabs) {
                const capturedRevision = capturedTabMutationRevisions.get(tab.tabId) ?? 0;
                attemptedTabMutationRevisions.set(tab.tabId, capturedRevision);
                const retained = retainedRecoveryTabs.get(tab.tabId);
                if (
                    retained?.workingCopyRef
                    && capturedRevision <= (persistedTabMutationRevisions.get(tab.tabId) ?? -1)
                ) {
                    retainedRefs.add(retained.workingCopyRef);
                    continue;
                }
                let bytes: Uint8Array | null | undefined;
                if (tab.workingCopyRef) {
                    try {
                        bytes = await options.workspaceRefs.value
                            .get(tab.tabId)
                            ?.createRecoverySnapshotBytes();
                    } catch (error) {
                        BrowserLogger.warn(
                            'workspace-recovery',
                            `Failed to refresh recovery snapshot for dirty tab ${tab.tabId}`,
                            error,
                        );
                    }
                }
                if (!bytes) {
                    if (!retained?.workingCopyRef) {
                        BrowserLogger.warn(
                            'workspace-recovery',
                            `Dirty tab ${tab.tabId} did not produce a recovery snapshot; retrying without it`,
                        );
                        unavailableRecoveryTabIds.add(tab.tabId);
                        shouldRetry = true;
                        continue;
                    }
                    retainedRefs.add(retained.workingCopyRef);
                    shouldRetry = true;
                    continue;
                }
                const snapshotRef = await browserDocumentStore.createStoredDocument(
                    `${tab.fileName ?? 'document'}.recovery.pdf`,
                    bytes,
                    {
                        mimeType: 'application/pdf',
                        kind: 'working',
                        retention: 'durable',
                        saveKind: 'pdf',
                        ...(tab.sourceRef ? {sourceRef: tab.sourceRef} : {}),
                    },
                );
                createdRefs.push(snapshotRef);
                replacements.set(tab.tabId, snapshotRef);
                refreshedTabIds.add(tab.tabId);
            }

            const recoveryTabs = checkpoint.tabs.flatMap((tab) => {
                if (unavailableRecoveryTabIds.has(tab.tabId)) {
                    return [];
                }
                const snapshotRef = replacements.get(tab.tabId);
                if (snapshotRef) {
                    return [{
                        ...tab,
                        sourceRef: tab.sourceRef ?? snapshotRef,
                        workingCopyRef: snapshotRef,
                        // A recovered document is a safe detached copy. It
                        // remains dirty and requires an explicit destination;
                        // recovery can never overwrite or download by itself.
                        requiresSaveAsOnFirstSave: true,
                    }];
                }
                const retained = retainedRecoveryTabs.get(tab.tabId);
                if (tab.isDirty && retained?.workingCopyRef) {
                    return [{
                        ...retained,
                        paneId: tab.paneId,
                    }];
                }
                return [{
                    ...tab,
                    // Clean documents reopen from their durable source;
                    // their ordinary transient working copies are not
                    // part of the recovery lease.
                    workingCopyRef: null,
                }];
            });
            const recoveryTabIds = new Set(recoveryTabs.map(tab => tab.tabId));
            const recoveryPanes = checkpoint.panes.map(pane => {
                const tabIds = pane.tabIds.filter(tabId => recoveryTabIds.has(tabId));
                return {
                    ...pane,
                    tabIds,
                    activeTabId: pane.activeTabId && recoveryTabIds.has(pane.activeTabId)
                        ? pane.activeTabId
                        : (tabIds[0] ?? null),
                };
            });
            const recoveryCheckpoint = {
                ...checkpoint,
                capturedAt: createEpochMs(),
                activeTabId: checkpoint.activeTabId && recoveryTabIds.has(checkpoint.activeTabId)
                    ? checkpoint.activeTabId
                    : (recoveryTabs[0]?.tabId ?? null),
                panes: recoveryPanes,
                tabs: recoveryTabs,
            };
            const outcome = await saveBrowserWorkspaceRecovery(
                ownerId,
                expectedGeneration,
                recoveryCheckpoint,
                [
                    ...createdRefs,
                    ...retainedRefs,
                ],
            );
            generation = outcome.generation;
            if (!outcome.saved) {
                BrowserLogger.warn(
                    'workspace-recovery',
                    `Recovery lease changed while saving owner ${ownerId} at generation ${String(expectedGeneration)}; fencing stale writer`,
                );
                fenced = true;
                stopHeartbeat();
                await cleanupSnapshots(createdRefs);
                return;
            }
            const liveDependencies = recoveryCheckpoint.tabs.flatMap(tab => [
                ...(tab.workingCopyRef ? [{ref: tab.workingCopyRef}] : []),
                ...(tab.sourceRef ? [{ref: tab.sourceRef}] : []),
            ]);
            liveLeaseDependencies = liveDependencies;
            try {
                const liveLease = liveLeaseGeneration === null
                    ? await createBrowserDocumentLiveLease(ownerId, liveDependencies)
                    : await saveBrowserDocumentLiveLease(ownerId, liveLeaseGeneration, 'active', liveDependencies);
                liveLeaseGeneration = liveLease.generation;
            } catch (error) {
                liveLeaseGeneration = null;
                BrowserLogger.warn('workspace-recovery', 'Failed to publish browser document live lease', error);
            }
            scheduleHeartbeat();
            persistedCheckpointRevision = Math.max(
                persistedCheckpointRevision,
                capturedCheckpointRevision,
            );
            for (const tabId of refreshedTabIds) {
                persistedTabMutationRevisions.set(
                    tabId,
                    capturedTabMutationRevisions.get(tabId) ?? 0,
                );
            }
            if (shouldRetry) {
                retryNotBefore = Date.now() + RECOVERY_RETRY_MS;
            }
            await cleanupSnapshots(
                previous?.snapshotRefs ?? [],
                new Set([
                    ...createdRefs,
                    ...retainedRefs,
                ]),
            );
        } catch (error) {
            await cleanupSnapshots(createdRefs);
            throw error;
        }
    }

    function drain() {
        if (disposed || fenced || !options.enabled.value) {
            return;
        }
        if (!hasPendingWork()) {
            return;
        }
        if (inFlight) {
            return;
        }
        const capturedCheckpointRevision = checkpointRevision;
        const capturedTabRevisions = new Map(tabMutationRevisions);
        attemptedCheckpointRevision = capturedCheckpointRevision;
        inFlight = persistCurrentRecovery(capturedCheckpointRevision, capturedTabRevisions)
            .catch((error) => {
                BrowserLogger.warn('workspace-recovery', 'Failed to persist browser recovery snapshot', error);
                retryNotBefore = Date.now() + RECOVERY_RETRY_MS;
            })
            .finally(() => {
                inFlight = null;
                if (!disposed && options.enabled.value && hasUnpersistedWork()) {
                    schedule(retryNotBefore > Date.now()
                        ? retryNotBefore - Date.now()
                        : 0);
                }
            });
    }

    function schedule(delay = RECOVERY_DEBOUNCE_MS) {
        if (timer) {
            clearTimeout(timer);
        }
        timer = setTimeout(() => {
            timer = null;
            drain();
        }, delay);
    }

    const stop = watch(
        // The cheap change signature keeps this watcher from rebuilding and
        // serializing the full checkpoint on every reactive tick; the
        // checkpoint itself is built only inside the debounced persist.
        () => {
            if (!options.enabled.value) {
                observedSignature = null;
                return null;
            }
            const signature = buildWorkspaceCheckpointChangeSignature(options);
            observedSignature = signature;
            return signature.workspace;
        },
        () => {
            // Vue always evaluates the source before invoking this callback;
            // the fallback supports lightweight structural watch doubles by
            // treating every dirty tab as mutated.
            if (observedSignature) {
                recordCheckpointMutation(observedSignature);
            } else {
                markMutation(dirtyTabIds());
            }
            schedule();
        },
        {immediate: true},
    );

    const targetWindow = typeof window === 'undefined' ? undefined : window;
    const targetDocument = typeof document === 'undefined' ? undefined : document;
    useEventListener(targetWindow, 'pagehide', drain);
    for (const eventName of [
        'change',
        'input',
        'keyup',
        'pointerup',
    ] as const) {
        useEventListener(targetWindow, eventName, () => {
            if (!options.enabled.value) {
                return;
            }
            if (!hasDirtyTabs()) {
                return;
            }
            const activeTabId = options.activeTabId.value;
            const dirtyIds = dirtyTabIds();
            if (activeTabId && !dirtyIds.has(activeTabId)) {
                return;
            }
            markMutation(activeTabId ? [activeTabId] : dirtyIds);
            schedule();
        });
    }
    useEventListener(targetDocument, 'visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            drain();
            return;
        }
        void heartbeatRecoveryLease();
    });

    onBeforeUnmount(() => {
        disposed = true;
        stop();
        stopHeartbeat();
        if (timer) clearTimeout(timer);
    });
};
