import type { Ref } from 'vue';
import { useEventListener } from '@vueuse/core';
import type {
    IEditorPaneState,
    TEditorLayoutNode,
} from '@contracts/editorPanes';
import type { ITab } from '@app/types/tabs';
import type { IWorkspaceDocumentController } from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import { buildWorkspaceCheckpoint } from '@app/modules/workspace-shell/checkpoint/buildWorkspaceCheckpoint';
import {
    buildWorkspaceCheckpointChangeSignature,
    type IWorkspaceCheckpointChangeSignature,
} from '@app/modules/workspace-shell/checkpoint/buildWorkspaceCheckpointChangeSignature';
import { getWindowTabsCapability } from '@app/utils/platformWindowTabs';
import { getDocumentWorkingCopyCapability } from '@app/utils/platformDocuments';
import { BrowserLogger } from '@app/utils/browserLogger';
import type { TDocumentRef } from '@contracts/documentRef';
import { createEpochMs } from '@contracts/timestamps';
import type { TTabId } from '@contracts/windowTabs';
import type { IWorkspaceCheckpointTab } from '@contracts/workspaceCheckpoint';

interface IUseBrowserWorkspaceRecoveryOptions {
    enabled: Ref<boolean>;
    panes: Ref<IEditorPaneState[]>;
    tabs: Ref<ITab[]>;
    layout: Ref<TEditorLayoutNode | null>;
    activePaneId: Ref<string | null>;
    activeTabId: Ref<string | null>;
    documentSessionsByTabId: Ref<Record<string, IWorkspaceDocumentController>>;
    getPaneByTabId(tabId: string): IEditorPaneState | null;
}

const RECOVERY_DEBOUNCE_MS = 750;
const RECOVERY_RETRY_MS = 2_000;
const RECOVERY_HEARTBEAT_MS = 10_000;

export const useBrowserWorkspaceRecovery = (options: IUseBrowserWorkspaceRecoveryOptions) => {
    let activeOwnerId: string | null = null;
    let generation: number | null = null;
    const windowTabs = getWindowTabsCapability();
    const workingCopy = getDocumentWorkingCopyCapability();
    if (!windowTabs.browserRecovery || !workingCopy.recovery) return;
    const recovery = windowTabs.browserRecovery;
    const snapshots = workingCopy.recovery;
    const liveDocumentRefs = () => Object.values(options.documentSessionsByTabId.value).flatMap(({snapshot}) => [
        snapshot.value.identity.originalPath,
        snapshot.value.identity.workingCopyPath,
    ].flatMap(ref => ref ? [ref] : []));
    let fenced = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
    let inFlight: Promise<void> | null = null;
    let disposed = false;
    let checkpointRevision = 0;
    let persistedCheckpointRevision = -1;
    let attemptedCheckpointRevision = -1;
    let retryNotBefore = 0;
    let previousContentSignatures = new Map<string, string>();
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
        // Generation 0 means this owner has no recovery record to keep alive.
        if (
            !ownerId
            || !expectedGeneration
            || disposed
            || fenced
            || !options.enabled.value
        ) {
            return;
        }

        try {
            const outcome = await recovery.touch(ownerId, expectedGeneration, liveDocumentRefs());
            if (outcome.saved) {
                generation = outcome.generation;
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

    async function cleanupSnapshots(refs: Iterable<TDocumentRef>, retainedRefs = new Set<TDocumentRef>()) {
        liveDocumentRefs().forEach(ref => retainedRefs.add(ref));
        await Promise.allSettled(Array.from(refs, async (ref) => {
            if (!retainedRefs.has(ref)) {
                await snapshots.cleanupSnapshot(ref);
            }
        }));
    }

    function dirtyTabIds() {
        return new Set(Object.entries(options.documentSessionsByTabId.value).flatMap(([
            tabId,
            session,
        ]) => session.snapshot.value.dirty ? [tabId] : []));
    }

    function markMutation(tabIds: Iterable<string>) {
        checkpointRevision += 1;
        for (const tabId of tabIds) {
            tabMutationRevisions.set(tabId, (tabMutationRevisions.get(tabId) ?? 0) + 1);
        }
        retryNotBefore = 0;
    }

    function recordCheckpointMutation(signature: IWorkspaceCheckpointChangeSignature) {
        const contentSignatures = new Map([...signature.tabSignatures.keys()].map((tabId) => {
            const session = options.documentSessionsByTabId.value[tabId];
            let recoverySignature: readonly unknown[] | null = null;
            try {
                recoverySignature = session?.getView(tabId)?.mountedWorkspace.value?.getWorkspaceDocumentRecoveryChangeSignature?.() ?? null;
            } catch {
                // The checkpoint builder reports rejected document captures.
            }
            return [
                tabId,
                JSON.stringify([
                    session?.snapshot.value.identity ?? null,
                    session?.snapshot.value.dirty ?? false,
                    recoverySignature,
                ]),
            ] as const;
        }));
        const dirtyIds = dirtyTabIds();
        const changedDirtyTabs = [...contentSignatures]
            .filter(([
                tabId,
                tabSignature,
            ]) => dirtyIds.has(tabId) && previousContentSignatures.get(tabId) !== tabSignature)
            .map(([tabId]) => tabId);
        previousContentSignatures = contentSignatures;
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
        const ownerId = recovery.getOwnerId();
        if (!ownerId) {
            retryNotBefore = Date.now() + RECOVERY_RETRY_MS;
            return;
        }
        if (ownerId !== activeOwnerId) {
            stopHeartbeat();
            activeOwnerId = ownerId;
            generation = null;
            fenced = false;
            persistedCheckpointRevision = -1;
            persistedTabMutationRevisions.clear();
            attemptedTabMutationRevisions.clear();
        }
        const checkpoint = buildWorkspaceCheckpoint(options);
        const allDirtyTabs = checkpoint.tabs.filter(tab => tab.isDirty);
        const previous = await recovery.load(ownerId);
        const expectedGeneration = generation ?? previous?.generation ?? 0;
        generation = expectedGeneration;
        if (allDirtyTabs.length === 0) {
            const outcome = await recovery.clear(ownerId, previous ? expectedGeneration : 0);
            if (previous) {
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
            // The views of one document share one recovery copy: its first
            // dirty tab makes it (from any mounted view) or keeps the last
            // one, and the document's other tabs name the same copy, so
            // restore brings them back as views of one document.
            const sessionOf = (tabId: TTabId) => options.documentSessionsByTabId.value[tabId];
            const documentCopies = new Map<IWorkspaceDocumentController, {
                ref: TDocumentRef | null;
                refreshed: boolean;
            }>();
            for (const tab of allDirtyTabs) {
                const capturedRevision = capturedTabMutationRevisions.get(tab.tabId) ?? 0;
                attemptedTabMutationRevisions.set(tab.tabId, capturedRevision);
                const session = sessionOf(tab.tabId);
                const documentCopy = session ? documentCopies.get(session) : undefined;
                if (documentCopy) {
                    if (documentCopy.ref === null) {
                        unavailableRecoveryTabIds.add(tab.tabId);
                    } else {
                        replacements.set(tab.tabId, documentCopy.ref);
                        if (documentCopy.refreshed) refreshedTabIds.add(tab.tabId);
                    }
                    continue;
                }
                const documentTabs = allDirtyTabs.filter(candidate => session !== undefined && sessionOf(candidate.tabId) === session);
                const changedSincePersisted = (documentTabs.length > 0 ? documentTabs : [tab]).some(candidate => (
                    (capturedTabMutationRevisions.get(candidate.tabId) ?? 0) > (persistedTabMutationRevisions.get(candidate.tabId) ?? -1)
                ));
                const retained = retainedRecoveryTabs.get(tab.tabId);
                if (retained?.workingCopyRef && !changedSincePersisted) {
                    retainedRefs.add(retained.workingCopyRef);
                    if (session) documentCopies.set(session, {
                        ref: retained.workingCopyRef,
                        refreshed: false,
                    });
                    continue;
                }
                let bytes: Uint8Array | null | undefined;
                if (tab.workingCopyRef) {
                    try {
                        const mountedView = session
                            ? [
                                session.getView(tab.tabId),
                                ...session.views.value.values(),
                            ]
                                .find(view => view?.mountedWorkspace.value)
                            : null;
                        const drafts = tab.annotationRecovery?.payload.drafts ?? [];
                        bytes = await mountedView?.mountedWorkspace.value?.createRecoverySnapshotBytes(drafts.length > 0 ? tab.annotationRecovery : undefined);
                        // Native snapshots already contain canonical edits. Only
                        // drafts need the captured payload and unchanged base.
                        if (drafts.length === 0) delete tab.annotationRecovery;
                    } catch (error) {
                        if (capturedCheckpointRevision === checkpointRevision) {
                            BrowserLogger.warn(
                                'workspace-recovery',
                                `Failed to refresh recovery snapshot for dirty tab ${tab.tabId}`,
                                error,
                            );
                        }
                    }
                }
                if (!bytes) {
                    // Save or reopen can supersede this capture while it waits
                    // for the document lease. The existing pending revision
                    // captures the current owner; discard this old checkpoint.
                    if (capturedCheckpointRevision !== checkpointRevision) {
                        await cleanupSnapshots(createdRefs);
                        return;
                    }
                    if (!retained?.workingCopyRef) {
                        BrowserLogger.warn(
                            'workspace-recovery',
                            `Dirty tab ${tab.tabId} did not produce a recovery snapshot; retrying without it`,
                        );
                        unavailableRecoveryTabIds.add(tab.tabId);
                        if (session) documentCopies.set(session, {
                            ref: null,
                            refreshed: false,
                        });
                        shouldRetry = true;
                        continue;
                    }
                    retainedRefs.add(retained.workingCopyRef);
                    if (session) documentCopies.set(session, {
                        ref: retained.workingCopyRef,
                        refreshed: false,
                    });
                    shouldRetry = true;
                    continue;
                }
                const {
                    ref: snapshotRef, revisionToken,
                } = await snapshots.createSnapshot(
                    `${tab.fileName ?? 'document'}.recovery.pdf`,
                    bytes,
                    tab.sourceRef ?? undefined,
                );
                createdRefs.push(snapshotRef);
                if (tab.annotationRecovery) {
                    tab.annotationRecovery = {
                        ...tab.annotationRecovery,
                        workingCopyRef: snapshotRef,
                        workingByteRevision: revisionToken,
                    };
                }
                replacements.set(tab.tabId, snapshotRef);
                refreshedTabIds.add(tab.tabId);
                if (session) documentCopies.set(session, {
                    ref: snapshotRef,
                    refreshed: true,
                });
            }

            const recoveryTabs = checkpoint.tabs.flatMap<IWorkspaceCheckpointTab>((tab) => {
                if (unavailableRecoveryTabIds.has(tab.tabId)) {
                    return [];
                }
                const snapshotRef = replacements.get(tab.tabId);
                if (snapshotRef && refreshedTabIds.has(tab.tabId)) {
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
                const retained = retainedRecoveryTabs.get(tab.tabId)
                    ?? [...retainedRecoveryTabs.values()].find(candidate => candidate.workingCopyRef === snapshotRef);
                if (tab.isDirty && retained?.workingCopyRef) {
                    // Keep document identity and drafts bound to the retained
                    // bytes, including when a newer content capture failed.
                    return [{
                        ...retained,
                        paneId: tab.paneId,
                        currentPage: tab.currentPage,
                        zoom: tab.zoom,
                        zoomMode: tab.zoomMode,
                        continuousScroll: tab.continuousScroll,
                        viewMode: tab.viewMode,
                        viewRotation: tab.viewRotation,
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
            const outcome = await recovery.save(
                ownerId,
                expectedGeneration,
                recoveryCheckpoint,
                [
                    ...createdRefs,
                    ...retainedRefs,
                ],
                liveDocumentRefs(),
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
