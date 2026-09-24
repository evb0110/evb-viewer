<template>
    <div
        class="workspace-host"
        :data-workspace-active="isActive ? 'true' : 'false'"
        :data-workspace-render-active="isRenderActive ? 'true' : 'false'"
        :data-workspace-tab-id="tabId"
    >
        <DocumentWorkspace
            v-if="!crashFailure"
            :key="renderKey"
            :tab-id="tabId"
            :is-active="isActive"
            :is-render-active="isRenderActive"
            :is-tab-transition-busy="isTabTransitionBusy"
            :document-session="documentSession"
            :split-cache-session="splitCacheSession"
            :is-fullscreen="isFullscreen"
            :fullscreen-supported="fullscreenSupported"
            :is-workspace-layout-resizing="isWorkspaceLayoutResizing"
            @open-in-new-tab="emit('open-in-new-tab', $event)"
            @request-close-tab="emit('request-close-tab')"
            @open-settings="emit('open-settings')"
            @open-combine="emit('open-combine')"
            @toggle-fullscreen="emit('toggle-fullscreen')"
        />
        <DocumentWorkspaceFailurePanel
            v-else
            :description="crashFailure.description ?? ''"
            :presentation="crashFailure"
            @close="emit('request-close-tab')"
            @retry="retry"
        />
        <!-- The tab's only Start page. It is not part of the workspace chunk,
        so it paints while the workspace loads; every action on it goes through
        the tab's controller to the mounted workspace. -->
        <div v-if="isStartMounted" v-show="isStartVisible" class="workspace-host__start">
            <PdfEmptyState
                :recent-files="recentFiles"
                :recent-files-resolved="recentFilesResolved"
                :recent-files-error="recentFilesError"
                :open-failure="startOpenFailure"
                :open-batch-progress="null"
                :open-in-progress="isOpening"
                :is-recent-open-ready="isRecentOpenReady"
                :start-section="startSection"
                can-combine-files
                :open-combine-result="result => withWorkspace(workspace => workspace.handleOpenFileWithResult(result))"
                @update:start-section="emit('update:start-section', $event)"
                @open-file="withWorkspace(workspace => workspace.handleOpenFileFromUi())"
                @open-folder="withWorkspace(workspace => workspace.handleOpenFolderFromUi())"
                @open-recent="openRecentFile"
                @remove-recent="removeRecentFile"
                @reveal-recent="revealRecentFile"
                @clear-recent="clearRecentFiles"
                @retry-recent="retryRecentFiles"
                @dismiss-open-failure="documentSession.dismissFailure()"
            />
        </div>
    </div>
</template>

<script setup lang="ts">
import type { TDocumentRef } from '@contracts/documentRef';
import type { TOpenFileResult } from '@contracts/electronApiDocuments';
import type { IRecentFile } from '@contracts/shared';
import type { TStartSection } from '@app/types/startSection';
import type { IWorkspaceExpose } from '@app/types/workspaceExpose';
import type { FailurePresentation } from '@app/composables/useFailureToast';
import { PdfEmptyState } from '@app/modules/pdf-viewer/public/component-exports/pdfEmptyState';
import { describeDocumentTarget } from '@app/modules/workspace-shell/document-sessions/describeDocumentTarget';
import DocumentWorkspaceFailurePanel from '@app/modules/workspace-shell/components/DocumentWorkspaceFailurePanel.vue';
import { handleDocumentWorkspaceCrash } from '@app/modules/workspace-shell/checkpoint/handleDocumentWorkspaceCrash';
import { createWorkspaceSplitCacheSessionState } from '@app/modules/workspace-shell/document-sessions/createWorkspaceSplitCacheSessionState';
import {
    identityHasDocument,
    type IWorkspaceDocumentController,
} from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import { useWorkspaceSplitCache } from '@app/modules/workspace-shell/composables/useWorkspaceSplitCache';
import { useWorkspaceRestoreTracker } from '@app/modules/workspace-shell/composables/useWorkspaceRestoreTracker';
import { useRecentFiles } from '@app/composables/useRecentFiles';
import * as platformDocuments from '@app/utils/platformDocuments';
import { isBrowserDocumentRef } from '@app/utils/documentRef';
import { getErrorMessage } from '@app/utils/error';

const DocumentWorkspace = defineAsyncComponent(() => import('@app/modules/workspace-shell/components/DocumentWorkspace.vue'));

const {
    documentSession,
    tabId,
} = defineProps<{
    tabId: string;
    isActive: boolean;
    isRenderActive: boolean;
    isTabTransitionBusy: boolean;
    documentSession: IWorkspaceDocumentController;
    startSection: TStartSection;
    isFullscreen: boolean;
    fullscreenSupported: boolean;
    isWorkspaceLayoutResizing: boolean;
}>();
const emit = defineEmits<{
    'update:start-section': [section: TStartSection];
    'open-in-new-tab': [result: TDocumentRef | TOpenFileResult];
    'request-close-tab': [];
    'open-settings': [];
    'open-combine': [];
    'toggle-fullscreen': [];
}>();
const { t } = useTypedI18n();
const splitCacheSession = computed(() => createWorkspaceSplitCacheSessionState(documentSession));
const workspaceSplitCache = useWorkspaceSplitCache();
const workspaceRestoreTracker = useWorkspaceRestoreTracker();
const {
    recentFiles,
    isResolved: recentFilesResolved,
    error: recentFilesError,
    loadRecentFiles,
    retryRecentFiles,
    removeRecentFile,
    clearRecentFiles,
} = useRecentFiles();
const crashFailure = shallowRef<FailurePresentation | null>(null);
const renderKey = ref(0);

const snapshot = computed(() => documentSession.snapshot.value);
const isOpening = computed(() => snapshot.value.phase === 'opening');
// Start belongs to a tab without a document on screen, including one whose
// open just failed. A tab that owns a document, is opening or closing one, or
// is about to receive a split's document does not show it.
const isStartVisible = computed(() => {
    const phase = snapshot.value.phase;
    const toolbar = documentSession.toolbarSnapshot.value;
    const session = splitCacheSession.value;
    return (phase === 'empty' || phase === 'failed')
        && !toolbar.hasPdf
        && !toolbar.isDjvuMode
        && !(session ? workspaceSplitCache.has(tabId, {session}) : workspaceSplitCache.has(tabId))
        && !workspaceRestoreTracker.has(tabId);
});
// An open started from Start keeps Start mounted but hidden until the open
// settles, so a failed open returns to the same Combine queue, error and Retry.
const isStartMounted = ref(false);
watch([
    isStartVisible,
    isOpening,
], ([
    visible,
    opening,
]) => {
    isStartMounted.value = visible || (opening && isStartMounted.value);
}, {
    immediate: true,
    flush: 'sync',
});
const startOpenFailure = computed(() => (
    snapshot.value.phase === 'failed' && !identityHasDocument(snapshot.value.identity)
        ? snapshot.value.failure
        : null
));

function isRecentOpenReady(file: IRecentFile) {
    return snapshot.value.activeTransaction?.target?.originalPath !== file.originalPath;
}

// A mounted workspace runs the command in the click's own call, so page
// commands that follow it queue behind the open; otherwise the command waits
// for the workspace to mount.
function withWorkspace(run: (workspace: IWorkspaceExpose) => Promise<boolean>) {
    const workspace = documentSession.mountedWorkspace.value;
    return workspace
        ? run(workspace)
        : documentSession.whenMounted().then(mounted => (mounted ? run(mounted) : false));
}

async function openRecentFile(file: IRecentFile) {
    if (isBrowserDocumentRef(file.originalPath)) {
        try {
            await platformDocuments.getDocumentFilesCapability().statFile(file.originalPath);
        } catch (error) {
            recentFilesError.value = getErrorMessage(error);
            return false;
        }
    }
    const open = (workspace: IWorkspaceExpose) => workspace.handleOpenFileDirectWithPersist(file.originalPath);
    const mounted = documentSession.mountedWorkspace.value;
    if (mounted) {
        return open(mounted);
    }
    // The tab is opening from the click, not from when the workspace chunk
    // arrives; the workspace's own open replaces this transaction once mounted.
    return documentSession.runOpen({
        kind: 'open',
        target: describeDocumentTarget(file.originalPath),
    }, () => withWorkspace(open));
}

async function revealRecentFile(file: IRecentFile) {
    try {
        await platformDocuments.getDocumentWindowCapability().showItemInFolder(file.originalPath);
    } catch {
        // Best-effort; the file may have moved.
    }
}

// A crash inside one tab's workspace is isolated to that tab: it shows why and
// offers a retry or close, and the other tabs keep working.
onErrorCaptured((error, instance, info) => {
    const failure = handleDocumentWorkspaceCrash(error, instance?.$options.name ?? null, info, {tabId});
    documentSession.markFailed({
        message: getErrorMessage(error),
        failure,
    });
    crashFailure.value = {
        failure,
        title: t('errors.workspace.loadTitle'),
        description: t('errors.workspace.loadDescriptionWithMessage', {message: getErrorMessage(error)}),
    };
    return false;
});

function retry() {
    crashFailure.value = null;
    renderKey.value += 1;
}

onMounted(() => {
    void loadRecentFiles();
});
</script>

<style scoped>
.workspace-host {
    position: relative;
    display: flex;
    isolation: isolate;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
}

.workspace-host__start {
    position: absolute;
    inset: 0;
    z-index: var(--app-workspace-transition-overlay-z-index);
    display: flex;
    min-width: 0;
    min-height: 0;
    background: var(--app-window-bg);
}

.workspace-host__loading {
    position: absolute;
    inset: 0;
    z-index: var(--app-z-workspace-overlay);
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    background: var(--app-document-viewer-bg, var(--app-window-bg));
}
</style>
