<template>
    <div
        ref="workspaceHostElement"
        class="workspace-host"
        :data-workspace-active="isActive ? 'true' : 'false'"
        :data-workspace-render-active="isRenderActive ? 'true' : 'false'"
        :data-workspace-tab-id="tabId"
        :data-recent-open-owner-ready="isRecentOpenOwnerReady ? 'true' : 'false'"
    >
        <div
            v-if="workspaceRequested && DocumentWorkspace && !hasWorkspaceChunkLoadError"
            class="workspace-host__workspace"
        >
            <component
                :is="DocumentWorkspace"
                :key="workspaceRenderKey"
                :tab-id="tabId"
                :is-active="isActive && !isPlaceholderVisible"
                :is-render-active="isRenderActive"
                :is-tab-transition-busy="isTabTransitionBusy"
                :initial-view-state="initialViewState"
                :pending-document-open="isDocumentOpenInFlight || hasPendingDocumentHint"
                :pending-document-path="pendingDocumentPath"
                suppress-empty-state
                :document-session="activeDocumentSession"
                :split-cache-session="splitCacheSession"
                :start-section="startSection"
                :is-fullscreen="isFullscreen"
                :fullscreen-supported="fullscreenSupported"
                :is-workspace-layout-resizing="isWorkspaceLayoutResizing"
                @update-document-record="handleDocumentRecordUpdate"
                @update:start-section="handleStartSectionUpdate"
                @open-in-new-tab="handleOpenInNewTab"
                @request-close-tab="handleRequestCloseTab"
                @open-settings="handleOpenSettings"
                @open-combine="handleOpenCombine"
                @toggle-fullscreen="handleToggleFullscreen"
                @viewer-owner-ready="handleViewerOwnerReady"
                @expose-ready="handleWorkspaceExposeReady"
                @expose-released="handleWorkspaceExposeReleased"
            />
        </div>

        <div
            v-if="isPlaceholderMounted"
            v-show="isPlaceholderVisible"
            class="workspace-host__placeholder"
        >
            <PdfEmptyState
                :recent-files="recentFiles"
                :recent-files-resolved="isResolved"
                :recent-files-error="recentFilesError"
                :open-failure="startOpenFailure"
                :open-batch-progress="null"
                :open-in-progress="isOpenUiBusy"
                :is-recent-open-ready="isRecentFileOpenReady"
                :start-section="startSection"
                can-combine-files
                :open-combine-result="handleOpenCombineResultFromPlaceholder"
                @update:start-section="handleStartSectionUpdate"
                @open-file="handleOpenFileFromUi"
                @open-recent="handleOpenRecentFromPlaceholder"
                @remove-recent="handleRemoveRecentFromPlaceholder"
                @reveal-recent="handleRevealRecentFromPlaceholder"
                @clear-recent="handleClearRecentFromPlaceholder"
                @retry-recent="handleRetryRecentFilesFromPlaceholder"
                @dismiss-open-failure="startOpenFailure = null"
            />
        </div>

        <DocumentWorkspaceFailurePanel
            v-if="isHostErrorVisible"
            :description="workspaceLoadErrorDescription"
            :presentation="workspaceLoadFailurePresentation"
            @close="handleRequestCloseTab"
            @retry="handleRetryWorkspaceMount"
        />
    </div>
</template>

<script setup lang="ts">
import type { TDocumentRef } from '@contracts/documentRef';
import type { TOpenFileResult } from '@contracts/electronApiDocuments';
import type { IRecentFile } from '@contracts/shared';
import {
    createDefaultWorkspaceToolbarSnapshot,
    type IWorkspaceExpose,
    type IWorkspaceOpenFailure,
    type IWorkspaceToolbarSnapshot,
} from '@app/types/workspaceExpose';
import { BrowserLogger } from '@app/utils/browserLogger';
import * as platformDocuments from '@app/utils/platformDocuments';
import { isBrowserDocumentRef } from '@app/utils/documentRef';
import { getAsyncChunkLoadErrorMessage } from '@app/modules/workspace-shell/host/getAsyncChunkLoadErrorMessage';
import { useRecentFiles } from '@app/composables/useRecentFiles';
import { PdfEmptyState } from '@app/modules/pdf-viewer/public/component-exports/pdfEmptyState';
import DocumentWorkspaceFailurePanel from '@app/modules/workspace-shell/components/DocumentWorkspaceFailurePanel.vue';
import { handleDocumentWorkspaceCrash } from '@app/modules/workspace-shell/checkpoint/handleDocumentWorkspaceCrash';
import { useWorkspaceSplitCache } from '@app/modules/workspace-shell/composables/useWorkspaceSplitCache';
import { resolveWorkspaceRequestedState } from '@app/modules/workspace-shell/host/resolveWorkspaceRequestedState';
import { createDeferredWorkspaceLoadGateway } from '@app/modules/workspace-shell/host/createDeferredWorkspaceLoadGateway';
import { shouldPreloadWorkspaceOnHostMount } from '@app/modules/workspace-shell/host/shouldPreloadWorkspaceOnHostMount';
import {
    shouldKeepWorkspacePendingDocumentHint,
    shouldShowWorkspacePlaceholder,
} from '@app/modules/workspace-shell/host/shouldShowWorkspacePlaceholder';
import {
    createWorkspaceRestoreAttemptState,
    finishWorkspaceRestoreAttempt,
    tryClaimWorkspaceRestoreAttempt,
    workspaceHasDocumentOrOpenError as getWorkspaceHasDocumentOrOpenError,
    workspaceHasOpenedDocument as getWorkspaceHasOpenedDocument,
    workspaceSessionHasOpenedDocument as getWorkspaceSessionHasOpenedDocument,
} from '@app/modules/workspace-shell/host/deferredWorkspaceHostState';
import { buildPendingTabDocumentHint } from '@app/modules/workspace-shell/tabs/buildPendingTabDocumentHint';
import { acceptsDocumentWithoutVisual } from '@app/modules/workspace-shell/document-sessions/acceptsDocumentWithoutVisual';
import { toolbarSnapshotHasAcceptedDocument } from '@app/modules/workspace-shell/host/toolbarSnapshotHasAcceptedDocument';
import { createDeferredWorkspaceExposeProxy } from '@app/modules/workspace-shell/expose/createDeferredWorkspaceExposeProxy';
import type {
    IStartOpenFailure,
    TStartSection,
} from '@app/types/startSection';
import type { IDocumentOpenIntent } from '@app/modules/workspace-shell/document-sessions/documentOpenIntent';
import { isRestoreDocumentOpenAction } from '@app/modules/workspace-shell/document-sessions/isRestoreDocumentOpenAction';
import { createTabViewSessionState } from '@app/modules/workspace-shell/tabs/createTabViewSessionState';
import type { ITabViewSessionState } from '@app/modules/workspace-shell/tabs/tabSessionStoreTypes';
import type { IWorkspaceDocumentRecord } from '@app/modules/workspace-shell/state/workspaceDocumentRecord';
import { createWorkspaceSplitCacheSessionState } from '@app/modules/workspace-shell/document-sessions/createWorkspaceSplitCacheSessionState';
import type {
    IWorkspaceDocumentController,
    IWorkspaceDocumentSnapshot,
} from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import { useDeferredWorkspaceChunkLoader } from '@app/modules/workspace-shell/composables/useDeferredWorkspaceChunkLoader';
import {
    createDeferredWorkspaceHostBindings,
    type IDeferredWorkspaceHostEmits,
} from '@app/modules/workspace-shell/composables/createDeferredWorkspaceHostBindings';
import { DEFERRED_WORKSPACE_HOST_POLICY } from '@app/modules/workspace-shell/host/deferredWorkspaceHostPolicy';
import {
    createDocumentOpenSurfaceSession,
    documentOpenSurfaceSessionKey,
    shouldPresentDocumentOpenEmptyPlaceholder,
} from '@app/modules/document-viewer/public';
import type { IDocumentOpeningPageFrame } from '@app/modules/document-viewer/public';
import { shouldResetDocumentOpenSurfaceForEmptySession } from '@app/modules/workspace-shell/host/shouldResetDocumentOpenSurfaceForEmptySession';
import { isRecentOpenCommandEligible } from '@app/modules/workspace-shell/host/isRecentOpenCommandEligible';
import { getErrorMessage } from '@app/utils/error';

const {
    hasDocumentHint = false,
    documentPath = null,
    documentRecord = null,
    documentSession,
    isActive,
    isDirty = false,
    isFullscreen,
    isRenderActive = isActive,
    recoveryWorkingCopyPath = null,
    isTabTransitionBusy,
    isWorkspaceLayoutResizing = false,
    fullscreenSupported,
    initialViewState = null,
    startSection = undefined,
    tabId,
} = defineProps<{
    tabId: string;
    isActive: boolean;
    isRenderActive?: boolean | undefined;
    isTabTransitionBusy: boolean;
    isStartupOpenClaimPending: boolean;
    hasDocumentHint?: boolean | undefined;
    documentPath?: TDocumentRef | null | undefined;
    documentRecord?: IWorkspaceDocumentRecord | null | undefined;
    documentSession: IWorkspaceDocumentController;
    isDirty?: boolean | undefined;
    recoveryWorkingCopyPath?: TDocumentRef | null | undefined;
    initialViewState?: ITabViewSessionState | null | undefined;
    startSection?: TStartSection | undefined;
    isFullscreen: boolean;
    fullscreenSupported: boolean;
    isWorkspaceLayoutResizing?: boolean | undefined;
}>();
const { t } = useTypedI18n();
const emit = defineEmits<IDeferredWorkspaceHostEmits>();
const documentOpenSurface = createDocumentOpenSurfaceSession();
provide(documentOpenSurfaceSessionKey, documentOpenSurface);


const {
    DocumentWorkspace,
    clearWorkspaceChunkRetryTimers,
    loadDocumentWorkspace,
    resetWorkspaceChunkLoadError,
    retryWorkspaceChunkRender,
    workspaceChunkLoadError,
    workspaceChunkFailurePresentation,
    workspaceRenderNonce,
} = useDeferredWorkspaceChunkLoader({
    logSection: DEFERRED_WORKSPACE_HOST_POLICY.RECENT_OPEN_LOG_SECTION,
    tabId,
});

const workspaceRequested = ref(false);
// The active empty tab must mount the canonical workspace owner before Recent
// becomes actionable. Deferring this by animation frames leaves the placeholder
// owning clicks that cannot present an exact page shell synchronously.
const canPremountActiveEmpty = ref(true);
const mountedWorkspace = shallowRef<IWorkspaceExpose | null>(null);
const workspaceHostElement = shallowRef<HTMLElement | null>(null);
const openingPageFrameAuthority = shallowRef<IDocumentOpeningPageFrame | null>(null);
const isRecentOpenOwnerReady = ref(false);
const isViewerOwnerMounted = ref(false);
let isHostUnmounted = false;
const restoreAttemptState = createWorkspaceRestoreAttemptState();
const filePickerInFlightCount = ref(0);
const workspaceSplitCache = useWorkspaceSplitCache();
const activeDocumentSession = computed(() => documentSession);
const {
    handleDocumentRecordUpdate,
    handleStartSectionUpdate,
    handleOpenInNewTab,
    handleRequestCloseTab,
    handleOpenSettings,
    handleOpenCombine,
    handleToggleFullscreen,
    handleWorkspaceExposeReady,
    handleWorkspaceExposeReleased: releaseWorkspaceExposeBinding,
} = createDeferredWorkspaceHostBindings({
    emit,
    mountedWorkspace,
});
const splitCacheSession = computed(() => createWorkspaceSplitCacheSessionState(activeDocumentSession.value));

const {
    recentFiles,
    isResolved,
    error: recentFilesError,
    loadRecentFiles,
    retryRecentFiles,
    removeRecentFile,
    clearRecentFiles,
} = useRecentFiles();

async function handleRetryRecentFilesFromPlaceholder() {
    try {
        await retryRecentFiles();
    } catch (error) {
        BrowserLogger.warn('recent-open', 'Failed to retry recent files', error);
    }
}

const hasMountedWorkspace = computed(() => mountedWorkspace.value !== null);
const hasWorkspaceChunkLoadError = computed(() => workspaceChunkLoadError.value !== null);
const workspaceRenderKey = computed(() => `${tabId}:${workspaceRenderNonce.value}`);
const currentToolbarSnapshot = computed(() => documentRecord?.toolbarSnapshot ?? createDefaultWorkspaceToolbarSnapshot());

function refreshOpeningFrameOwnerReadiness() {
    isRecentOpenOwnerReady.value = isViewerOwnerMounted.value
        && openingPageFrameAuthority.value !== null;
}

function handleViewerOwnerReady(authority: IDocumentOpeningPageFrame) {
    // The premounted chassis owns both the prepared shell and final fit scale.
    // Sharing its authority prevents the empty host from independently
    // guessing scrollbar, sidebar, or renderer viewport geometry.
    openingPageFrameAuthority.value = authority;
    isViewerOwnerMounted.value = true;
    refreshOpeningFrameOwnerReadiness();
}

function handleWorkspaceExposeReleased(expose: IWorkspaceExpose) {
    if (mountedWorkspace.value !== expose) {
        return;
    }
    isViewerOwnerMounted.value = false;
    openingPageFrameAuthority.value = null;
    refreshOpeningFrameOwnerReadiness();
    releaseWorkspaceExposeBinding(expose);
}

function isRecentFileOpenReady(file: IRecentFile) {
    return isRecentOpenCommandEligible({
        activeOpenDocumentRef: activeDocumentOpenTransaction.value?.documentRef ?? null,
        documentRef: file.originalPath,
    });
}

watch(
    () => activeDocumentSession.value.snapshot.value,
    (session) => {
        if (!shouldResetDocumentOpenSurfaceForEmptySession(session, documentOpenSurface.snapshot.value)) {
            return;
        }
        // Closing a document ends its visual generation. Re-arm Recent from
        // the current empty session and the current chassis/layout authority;
        // never inherit the closed document's prepared-frame ownership.
        documentOpenSurface.reset();
    },
    {flush: 'sync'},
);
const activeDocumentOpenTransaction = computed(() => {
    const transaction = activeDocumentSession.value.snapshot.value.activeTransaction;
    return transaction && (
        transaction.kind === 'open'
        || transaction.kind === 'restore'
        || transaction.kind === 'reload'
    )
        ? transaction
        : null;
});
const isClosingDocument = computed(() => (
    activeDocumentSession.value.snapshot.value.activeTransaction?.kind === 'close'
));
const isPendingDocumentHintHeld = computed(() => {
    // A host remounted after a cold release has no workspace until it is
    // activated, but its record still holds the document it committed. That
    // record is the release evidence; a pending record is still opening.
    const recordSnapshot = currentToolbarSnapshot.value;
    const mountedSnapshot = mountedWorkspace.value?.getToolbarSnapshot()
        ?? (recordSnapshot.isOpeningDocument ? null : recordSnapshot);
    return shouldKeepWorkspacePendingDocumentHint({
        hasDocumentHint: hasDocumentHint === true,
        isClosingDocument: isClosingDocument.value,
        mountedSnapshot,
    });
});
// The hint stands for a document this workspace has not presented yet. Once it
// has, readiness can still drop - a navigation shows a skeleton on the
// committed page, a budget eviction clears it - but that is not an open.
// Re-arming the hint there reported an open to the workspace, which suspended
// the sidebar and re-anchored the viewport on each bookmark jump. A real
// reopen or reload owns an open transaction instead.
const presentedDocumentHint = shallowRef<{
    workspace: IWorkspaceExpose;
    documentPath: TDocumentRef | null;
} | null>(null);
watch(
    [
        isPendingDocumentHintHeld,
        mountedWorkspace,
        () => documentPath,
    ],
    ([
        held,
        workspace,
        path,
    ]) => {
        if (!held && workspace) {
            presentedDocumentHint.value = {
                workspace,
                documentPath: path,
            };
        }
    },
    {
        flush: 'sync',
        immediate: true,
    },
);
const hasPendingDocumentHint = computed(() => {
    const presented = presentedDocumentHint.value;
    return isPendingDocumentHintHeld.value && !(
        presented !== null
        && presented.workspace === mountedWorkspace.value
        && presented.documentPath === documentPath
    );
});
const pendingDocumentPath = computed(() => (
    activeDocumentOpenTransaction.value?.documentRef
    ?? (hasPendingDocumentHint.value ? documentPath : null)
));
// An in-place reload of the open document (OCR apply, page edits) re-arms the
// open surface through `idle` while the previous pages stay painted. Showing
// the Recent placeholder there also flips `isActive` on the workspace, which
// unmounts the teleported toolbar and every popup it hosts. The placeholder is
// for the transition from no document to a document, so it waits for a new
// document, not a new generation of the one that already presented.
const lastPresentedDocumentId = ref<string | null>(null);
watch(
    () => documentOpenSurface.snapshot.value,
    (snapshot) => {
        if (snapshot.identity === null) {
            lastPresentedDocumentId.value = null;
        } else if (!shouldPresentDocumentOpenEmptyPlaceholder(snapshot)) {
            lastPresentedDocumentId.value = snapshot.identity.documentId;
        }
    },
    {flush: 'sync'},
);
const isPlaceholderVisible = computed(() => {
    const snapshot = documentOpenSurface.snapshot.value;
    return shouldShowWorkspacePlaceholder({
        hasAcceptedDocument: toolbarSnapshotHasAcceptedDocument(mountedWorkspace.value?.getToolbarSnapshot()),
        hasQueuedSplitRestore: hasQueuedSplitRestore.value,
        hasPendingDocumentHint: hasPendingDocumentHint.value,
        hasVisibleDocument: !shouldPresentDocumentOpenEmptyPlaceholder(snapshot)
            || (
                snapshot.identity !== null
                && snapshot.identity.documentId === lastPresentedDocumentId.value
            ),
        isDocumentOpenInFlight: isDocumentOpenInFlight.value,
    });
});
const workspaceLoadErrorDescription = computed(() => {
    const message = getAsyncChunkLoadErrorMessage(workspaceChunkLoadError.value).trim();
    if (!message) {
        return t('errors.workspace.loadDescription');
    }
    return t('errors.workspace.loadDescriptionWithMessage', { message });
});
const workspaceLoadFailurePresentation = computed(() => {
    const presentation = workspaceChunkFailurePresentation.value;
    if (!presentation) {
        return null;
    }
    return {
        ...presentation,
        description: workspaceLoadErrorDescription.value,
    };
});
const hasPdf = computed(() => {
    const value = mountedWorkspace.value?.hasPdf;
    if (typeof value === 'boolean') {
        return value;
    }
    return value?.value ?? currentToolbarSnapshot.value.hasPdf;
});

function readWorkspaceToolbarSnapshot() {
    const baseSnapshot = mountedWorkspace.value?.getToolbarSnapshot() ?? currentToolbarSnapshot.value;
    const isOpeningDocument = isDocumentOpenInFlight.value || hasPendingDocumentHint.value;
    return {
        ...baseSnapshot,
        isOpeningDocument: baseSnapshot.isOpeningDocument || isOpeningDocument,
    };
}

function emitCurrentViewSessionState(snapshot: IWorkspaceToolbarSnapshot = readWorkspaceToolbarSnapshot()) {
    emit('update-session-state', createTabViewSessionState(
        snapshot,
        activeDocumentSession.value.snapshot.value.viewState,
    ));
}
const hasQueuedSplitRestore = computed(() => {
    const session = splitCacheSession.value;
    return session
        ? workspaceSplitCache.has(tabId, {session})
        : workspaceSplitCache.has(tabId);
});
const isDocumentOpenInFlight = computed(() => activeDocumentOpenTransaction.value !== null);
// An open started from Start (a Recent file or a Combine result) keeps Start
// mounted but hidden until the open settles. A failed open then returns to the
// same Combine queue, error and Retry instead of a fresh empty page. Opens that
// begin without a mounted Start surface never mount one.
const isPlaceholderMounted = ref(false);
watch(
    [
        isPlaceholderVisible,
        isDocumentOpenInFlight,
    ],
    ([
        visible,
        openInFlight,
    ]) => {
        isPlaceholderMounted.value = visible || (openInFlight && isPlaceholderMounted.value);
    },
    {
        immediate: true,
        flush: 'sync',
    },
);
const hasUnresolvedDirtyRecovery = computed(() => isDirty === true && Boolean(recoveryWorkingCopyPath));
const isFilePickerInFlight = computed(() => filePickerInFlightCount.value > 0);
// Startup open-claim is a background probe. Mark the open UI busy only once the
// user or restore flow is actually opening a document.
const isOpenUiBusy = computed(() => isDocumentOpenInFlight.value || isFilePickerInFlight.value);
const isHostErrorVisible = computed(() => hasWorkspaceChunkLoadError.value && workspaceRequested.value && !hasMountedWorkspace.value);
const loaderVariant = computed(() => {
    if (isHostErrorVisible.value) {
        return 'workspace-mount:error';
    }

    return 'none';
});

function requestWorkspaceMount(reason: string) {
    if (workspaceRequested.value) {
        return;
    }

    workspaceRequested.value = true;
    BrowserLogger.debug(DEFERRED_WORKSPACE_HOST_POLICY.RECENT_OPEN_LOG_SECTION, 'Requesting workspace mount', {
        tabId: tabId,
        reason,
    });
}

const workspaceLoadGateway = createDeferredWorkspaceLoadGateway({
    tabId,
    mountedWorkspace,
    workspaceChunkLoadError,
    loadDocumentWorkspace,
    requestWorkspaceMount,
    isHostUnmounted: () => isHostUnmounted,
});
const {
    ensureWorkspaceLoaded,
    preloadWorkspaceComponent,
    withLoadedWorkspace,
    withLoadedWorkspaceRequired,
    withWorkspace,
} = workspaceLoadGateway;

const workspaceHasOpenedDocument = () => getWorkspaceHasOpenedDocument(
    mountedWorkspace.value,
    activeDocumentSession.value.snapshot.value,
);
const workspaceHasDocumentOrOpenError = () => getWorkspaceHasDocumentOrOpenError(
    mountedWorkspace.value,
    activeDocumentSession.value.snapshot.value,
);
function markWorkspaceRestoreAttemptFinished(
    snapshot: IWorkspaceDocumentSnapshot,
    path: TDocumentRef,
    result: unknown,
) {
    finishWorkspaceRestoreAttempt(restoreAttemptState, snapshot, path, result !== false);
}

watch(
    [
        hasQueuedSplitRestore,
        () => hasDocumentHint === true,
        () => isActive,
        () => isRenderActive,
        canPremountActiveEmpty,
    ],
    ([
        hasQueued,
        hasDocumentHint,
        isActive,
        isRenderActive,
        canPremount,
    ]) => {
        workspaceRequested.value = resolveWorkspaceRequestedState(workspaceRequested.value, {
            hasQueuedSplitRestore: hasQueued,
            hasDocumentHint,
            isActive: isActive || isRenderActive,
            canPremountActiveEmpty: canPremount,
        });
    },
    { immediate: true },
);

watch(loaderVariant, (nextVariant, previousVariant) => {
    if (nextVariant === previousVariant) {
        return;
    }

    BrowserLogger.debug(DEFERRED_WORKSPACE_HOST_POLICY.LOADER_LOG_SECTION, 'Workspace host loader variant changed', {
        tabId: tabId,
        previousVariant,
        nextVariant,
        surface: 'document-page-skeleton',
        isDocumentOpenInFlight: isDocumentOpenInFlight.value,
        workspaceRequested: workspaceRequested.value,
        hasMountedWorkspace: hasMountedWorkspace.value,
        hasWorkspaceChunkLoadError: hasWorkspaceChunkLoadError.value,
    });
}, { immediate: true });

watch(hasMountedWorkspace, (mounted) => {
    if (mounted) {
        resetWorkspaceChunkLoadError();
    }
});

watch(
    () => isActive || isRenderActive,
    (active, wasActive) => {
        if (wasActive && !active) {
            emitCurrentViewSessionState();
        }
    },
    { flush: 'sync' },
);

watch(
    [
        () => isActive,
        () => isRenderActive,
        () => documentPath,
        isDocumentOpenInFlight,
        hasUnresolvedDirtyRecovery,
    ],
    ([
        active,
        renderActive,
        path,
        opening,
        unresolvedDirtyRecovery,
    ]) => {
        const snapshot = activeDocumentSession.value.snapshot.value;
        if (
            !(active || renderActive)
            || !path
            || hasDocumentHint !== true
            || unresolvedDirtyRecovery
            || workspaceHasOpenedDocument()
            || opening
            || !tryClaimWorkspaceRestoreAttempt(restoreAttemptState, snapshot, path)
        ) {
            return;
        }

        void activeDocumentSession.value.open({
            action: 'restoreTabDocument',
            target: null,
        }, async signal => {
            return withWorkspace(
                'restoreTabDocument',
                workspace => workspace.handleOpenFileDirectWithPersist(path),
                signal,
            );
        })
            .then(result => markWorkspaceRestoreAttemptFinished(snapshot, path, result))
            .catch(() => markWorkspaceRestoreAttemptFinished(snapshot, path, false));
    },
    { immediate: true },
);

watch([
    hasMountedWorkspace,
    isDocumentOpenInFlight,
    hasUnresolvedDirtyRecovery,
], ([
    mounted,
    opening,
    unresolvedDirtyRecovery,
]) => {
    const snapshot = activeDocumentSession.value.snapshot.value;
    const restorePath = documentPath;
    if (
        !mounted
        || opening
        || !(isActive || isRenderActive)
        || !initialViewState
        || !restorePath
        || unresolvedDirtyRecovery
        || workspaceHasOpenedDocument()
        || !tryClaimWorkspaceRestoreAttempt(restoreAttemptState, snapshot, restorePath)
    ) {
        return;
    }

    void activeDocumentSession.value.open({
        action: 'restoreColdDocument',
        target: buildPendingTabDocumentHint(restorePath),
    }, async signal => withWorkspace(
        'restoreColdDocument',
        workspace => workspace.handleOpenFileDirectWithPersist(restorePath),
        signal,
    ))
        .then(result => markWorkspaceRestoreAttemptFinished(snapshot, restorePath, result))
        .catch(() => markWorkspaceRestoreAttemptFinished(snapshot, restorePath, false));
});

function handleRetryWorkspaceMount() {
    BrowserLogger.info(DEFERRED_WORKSPACE_HOST_POLICY.RECENT_OPEN_LOG_SECTION, 'Retrying DocumentWorkspace async chunk load', {tabId: tabId});

    retryWorkspaceChunkRender();
    workspaceLoadGateway.resetWorkspaceLoad();
    workspaceRequested.value = true;
    void preloadWorkspaceComponent('manual-retry');
}

onErrorCaptured((error, instance, info) => {
    const failure = handleDocumentWorkspaceCrash(error, instance?.$options.name ?? null, info, {
        tabId,
        failActiveTransaction: () => {
            const transaction = activeDocumentSession.value.snapshot.value.activeTransaction;
            if (transaction) activeDocumentSession.value.finishTransaction(transaction.id, 'failed');
        },
        releaseWorkspace: () => {
            const expose = mountedWorkspace.value;
            if (expose) {
                handleWorkspaceExposeReleased(expose);
            }
        },
        resetWorkspaceLoad: workspaceLoadGateway.resetWorkspaceLoad,
        setError: value => { workspaceChunkLoadError.value = value; },
    });
    workspaceChunkFailurePresentation.value = {
        failure,
        title: 'Workspace failed to load',
    };
    return false;
});

const detachOpenTransactionHost = activeDocumentSession.value.attachOpenTransactionHost({
    documentOpenSurface,
    getActiveTransactionId: () => activeDocumentSession.value.snapshot.value.activeTransaction?.id ?? null,
    getInitialViewState: () => initialViewState,
    getSeedToolbarSnapshot: () => currentToolbarSnapshot.value,
    hasDocumentOrOpenError: workspaceHasDocumentOrOpenError,
    hasOpenedDocument: workspaceHasOpenedDocument,
    hasSessionOpenedDocument: () => getWorkspaceSessionHasOpenedDocument(activeDocumentSession.value.snapshot.value),
    isHostUnmounted: () => isHostUnmounted,
    publishDocumentRecord: handleDocumentRecordUpdate,
    requestWorkspaceMount,
});

async function pickFileFromUi() {
    filePickerInFlightCount.value += 1;
    try {
        await nextTick();
        await new Promise<void>((resolve) => {
            requestAnimationFrame(() => {
                requestAnimationFrame(() => resolve());
            });
        });
        return await platformDocuments.getDocumentPickerCapability().openDocumentDialog();
    } finally {
        filePickerInFlightCount.value = Math.max(0, filePickerInFlightCount.value - 1);
    }
}

// An open that fails on an empty tab hands the tab back to Start, which would
// otherwise cover a failure the workspace still holds: the tab kept the failed
// file's name, counted as occupied and showed no error. The failed open is
// closed so the tab is empty again, and Start reports why the file did not
// open. A generated combine result belongs to the Combine page, which reports
// its own failure and keeps the file for Retry and Save As; closing deletes an
// adopted working copy, so that failure is released only when none was
// adopted. Restores and recovery opens keep their own failure handling.
const startOpenFailure = shallowRef<IStartOpenFailure | null>(null);
// The reason the last open in this tab failed, kept after the failed open is
// released so callers can tell a document that cannot open from a tab that
// was not available, and not retry the document elsewhere.
const lastOpenFailure = shallowRef<IWorkspaceOpenFailure | null>(null);

async function openDocument<T>(intent: IDocumentOpenIntent, run: (signal: AbortSignal) => Promise<T>) {
    startOpenFailure.value = null;
    lastOpenFailure.value = null;
    const result = await activeDocumentSession.value.open(intent, run);
    if (result === false) {
        await releaseFailedOpen(intent);
    }
    return result;
}

async function releaseFailedOpen(intent: IDocumentOpenIntent) {
    const workspace = mountedWorkspace.value;
    const openFailure = workspace?.getOpenFailure() ?? null;
    const isGeneratedResult = intent.acceptDocumentWithoutVisual === true;
    lastOpenFailure.value = openFailure;
    if (
        !workspace
        || !openFailure
        || intent.preserveDirtyOnFailure === true
        || isRestoreDocumentOpenAction(intent.action)
        || workspaceHasOpenedDocument()
        || !isPlaceholderVisible.value
        || (isGeneratedResult && workspace.getAutomationStateSnapshot().workingCopyPath !== null)
    ) {
        return;
    }
    const closed = await activeDocumentSession.value.close({persist: false});
    if (closed && !isGeneratedResult) {
        startOpenFailure.value = {
            ...openFailure,
            fileName: intent.target?.fileName ?? null,
        };
    }
}

async function handleOpenRecentFromPlaceholder(file: IRecentFile) {
    BrowserLogger.debug(DEFERRED_WORKSPACE_HOST_POLICY.RECENT_OPEN_LOG_SECTION, 'Recent item clicked from placeholder', {
        tabId: tabId,
        path: file.originalPath,
        workspaceRequested: workspaceRequested.value,
        hasMountedWorkspace: hasMountedWorkspace.value,
    });

    if (isBrowserDocumentRef(file.originalPath)) {
        try {
            await platformDocuments.getDocumentFilesCapability().statFile(file.originalPath);
        } catch (error) {
            recentFilesError.value = getErrorMessage(error);
            BrowserLogger.warn(DEFERRED_WORKSPACE_HOST_POLICY.RECENT_OPEN_LOG_SECTION, 'Recent item is unavailable before opening', {
                tabId: tabId,
                path: file.originalPath,
                error,
            });
            return false;
        }
    }

    const result = await openDocument({
        action: 'openRecentFromPlaceholder',
        target: buildPendingTabDocumentHint(file),
    }, async (signal) => {
        const preloadedWorkspace = mountedWorkspace.value
            ?? await ensureWorkspaceLoaded('openRecentFromPlaceholder:preload', signal);
        if (signal.aborted) {
            return false;
        }
        if (!preloadedWorkspace) {
            BrowserLogger.debug(DEFERRED_WORKSPACE_HOST_POLICY.RECENT_OPEN_LOG_SECTION, 'Failed to preload workspace for recent open', {
                tabId: tabId,
                path: file.originalPath,
            });
            return false;
        }

        return withWorkspace(
            'openRecentFromPlaceholder',
            workspace => workspace.handleOpenFileDirectWithPersist(file.originalPath),
            signal,
        );
    });
    return result;
}

async function handleRemoveRecentFromPlaceholder(file: IRecentFile) {
    await removeRecentFile(file);
}

async function handleRevealRecentFromPlaceholder(file: IRecentFile) {
    try {
        await platformDocuments.getDocumentWindowCapability().showItemInFolder(file.originalPath);
    } catch {
        // Best-effort; ignore failures (path may have moved or permissions changed).
    }
}

async function handleClearRecentFromPlaceholder() {
    await clearRecentFiles();
}

async function handleOpenCombineResultFromPlaceholder(result: TOpenFileResult) {
    return openDocument({
        action: 'openCombineResultFromPlaceholder',
        acceptDocumentWithoutVisual: acceptsDocumentWithoutVisual(result),
        target: buildPendingTabDocumentHint(result),
    }, async signal => withWorkspace(
        'openCombineResultFromPlaceholder',
        workspace => workspace.handleOpenFileWithResult(result),
        signal,
    ));
}

async function handleOpenFileFromUi() {
    const result = await pickFileFromUi();
    if (!result || isHostUnmounted) {
        return false;
    }

    return openDocument({
        action: 'handleOpenFileWithResultFromUi',
        target: buildPendingTabDocumentHint(result),
    }, async signal => withWorkspace(
        'handleOpenFileWithResultFromUi',
        workspace => workspace.handleOpenFileWithResult(result),
        signal,
    ));
}

onMounted(() => {
    isHostUnmounted = false;
    refreshOpeningFrameOwnerReadiness();
    emit('expose-ready', workspaceExpose);
    if (shouldPreloadWorkspaceOnHostMount({
        hasQueuedSplitRestore: hasQueuedSplitRestore.value,
        hasDocumentHint: hasDocumentHint === true,
        isActive: isActive || isRenderActive,
    })) {
        void preloadWorkspaceComponent('workspace-host-mounted');
    }

    BrowserLogger.debug(DEFERRED_WORKSPACE_HOST_POLICY.RECENT_OPEN_LOG_SECTION, 'Workspace host mounted; loading recent files', {tabId: tabId});
    void loadRecentFiles().finally(() => {
        BrowserLogger.debug(DEFERRED_WORKSPACE_HOST_POLICY.RECENT_OPEN_LOG_SECTION, 'Workspace host recent files load settled', {
            tabId: tabId,
            count: recentFiles.value.length,
        });
    });
});

onBeforeUnmount(() => {
    // A cold-tab lifecycle update can remove this host in the same parent
    // render that changes its active props, so the deactivation watcher is not
    // guaranteed to observe an inactive frame. Capture while the mounted
    // workspace and its renderer-neutral toolbar projection are still live.
    emitCurrentViewSessionState();
});

onUnmounted(() => {
    isHostUnmounted = true;
    detachOpenTransactionHost();
    openingPageFrameAuthority.value = null;
    isRecentOpenOwnerReady.value = false;
    documentOpenSurface.reset();
    emit('expose-released');
    workspaceLoadGateway.dispose();
    clearWorkspaceChunkRetryTimers();
});

const workspaceExpose: IWorkspaceExpose = createDeferredWorkspaceExposeProxy({
    documentSession: activeDocumentSession.value,
    enqueueDocumentOpen: openDocument,
    getMounted: () => mountedWorkspace.value,
    log: (action, error) => {
        BrowserLogger.error('workspace-host', `Action failed (${action})`, {
            tabId: tabId,
            error,
        }, {code: 'RENDERER_WORKSPACE_OPERATION_FAILED'});
    },
    overrides: {
        getToolbarSnapshot: () => readWorkspaceToolbarSnapshot(),
        getOpenFailure: () => mountedWorkspace.value?.getOpenFailure() ?? lastOpenFailure.value,
        // The shell toolbar is visible before the deferred workspace mounts.
        // Navigation must enter the already-owned viewport session directly;
        // a mount-wait command target can legitimately become stale as the
        // in-flight open refines its document identity. Rapid commands can
        // also arrive in the async gap before a queued open transaction
        // begins its surface generation; the owner-less session rejects them
        // as potential stale projections, so the host retains the genuine
        // user command and replays it when the generation begins.
        handleGoToPage: (page, options) => {
            if (isDocumentOpenInFlight.value || !mountedWorkspace.value) {
                activeDocumentSession.value.requestDocumentPage(page);
                return;
            }

            mountedWorkspace.value.handleGoToPage(page, options);
        },
        handleOpenFileFromUi,
        hasPdf,
    },
    withLoadedWorkspace,
    withLoadedWorkspaceRequired,
    withWorkspace,
});

defineExpose(workspaceExpose);
</script>

<style src="./DeferredDocumentWorkspaceHost.css" scoped></style>
