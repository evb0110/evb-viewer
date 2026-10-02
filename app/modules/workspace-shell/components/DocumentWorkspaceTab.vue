<template>
    <div
        class="workspace-host"
        :data-workspace-active="isActive ? 'true' : 'false'"
        :data-workspace-render-active="isRenderActive ? 'true' : 'false'"
        :data-workspace-tab-id="tabId"
    >
        <DocumentWorkspace
            v-if="crashDescription === null"
            :key="renderKey"
            :tab-id="tabId"
            :is-active="isActive"
            :is-render-active="isRenderActive"
            :is-tab-transition-busy="isTabTransitionBusy"
            :document-session="documentSession"
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
            :description="crashDescription"
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
                :open-batch-progress="null"
                :open-in-progress="isOpening"
                :is-recent-open-ready="isRecentOpenReady"
                :start-section="startSection"
                can-combine-files
                :open-combine-result="result => withWorkspace(workspace => workspace.handleOpenFileWithResult(result))"
                @update:start-section="emit('update:start-section', $event)"
                @open-file="openPicked(() => platformDocuments.getDocumentPickerCapability().openDocumentDialog())"
                @open-folder="openPicked(() => platformDocuments.getDocumentPickerCapability().openFolderDialog())"
                @press-recent="pressRecentFile"
                @open-recent="openRecentFile"
                @remove-recent="removeRecentFile"
                @reveal-recent="revealRecentFile"
                @clear-recent="clearRecentFiles"
                @retry-recent="retryRecentFiles"
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
import { PdfEmptyState } from '@app/modules/pdf-viewer/public/component-exports/pdfEmptyState';
import {
    describeDocumentTarget,
    describeOpenResult,
} from '@app/modules/workspace-shell/document-sessions/describeDocumentTarget';
import DocumentWorkspaceFailurePanel from '@app/modules/workspace-shell/components/DocumentWorkspaceFailurePanel.vue';
import { handleDocumentWorkspaceCrash } from '@app/modules/workspace-shell/checkpoint/handleDocumentWorkspaceCrash';
import { describeRefusedDocumentOpen } from '@app/modules/workspace-shell/composables/document-session/classifyDocumentOpenError';
import type {
    IWorkspaceDocumentController,
    IWorkspaceOpenRequest,
} from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import { useWorkspaceRestoreTracker } from '@app/modules/workspace-shell/composables/useWorkspaceRestoreTracker';
import { useRecentFiles } from '@app/composables/useRecentFiles';
import * as platformDocuments from '@app/utils/platformDocuments';
import { isBrowserDocumentRef } from '@app/utils/documentRef';
import { getErrorMessage } from '@app/utils/error';
import {
    readPdfPageShape,
    type IPdfPageShapeRead,
} from '@app/modules/workspace-shell/composables/document-session/resolvePdfOpeningGeometry';

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
const crashDescription = ref<string | null>(null);
const renderKey = ref(0);

const snapshot = computed(() => documentSession.snapshot.value);
const documentView = computed(() => documentSession.getView(tabId));
const isOpening = computed(() => snapshot.value.phase === 'opening');
// Start belongs to a tab without a document on screen, including one whose
// open just failed. A tab that owns a document, is opening or closing one, or
// is about to receive a transferred document does not show it.
const isStartVisible = computed(() => {
    const phase = snapshot.value.phase;
    const toolbar = documentView.value?.toolbarSnapshot.value;
    return (phase === 'empty' || phase === 'failed')
        && !toolbar?.hasPdf
        && !toolbar?.isDjvuMode
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

function isRecentOpenReady(file: IRecentFile) {
    return snapshot.value.activeTransaction?.target?.originalPath !== file.originalPath;
}

// A mounted workspace runs the command in the click's own call, so page
// commands that follow it queue behind the open; otherwise the command waits
// for the workspace to mount.
function withWorkspace(run: (workspace: IWorkspaceExpose) => Promise<boolean>) {
    const workspace = documentView.value?.mountedWorkspace.value;
    return workspace
        ? run(workspace)
        : (documentView.value?.whenMounted() ?? Promise.resolve(null)).then(mounted => (mounted ? run(mounted) : false));
}

// The page's shape is asked for when a Recent row is pressed; main answers a
// file it has read before before the button is released, so the open claims
// the tab with its page skeleton. Only the click of that press uses it.
let pressedRecentShape: IPdfPageShapeRead | null = null;

function pressRecentFile(file: IRecentFile) {
    pressedRecentShape = readPdfPageShape(file.originalPath);
}

async function openRecentFile(file: IRecentFile, pressed: boolean) {
    const pageShape = pressed && pressedRecentShape?.path === file.originalPath
        ? pressedRecentShape
        : readPdfPageShape(file.originalPath);
    pressedRecentShape = null;
    if (isBrowserDocumentRef(file.originalPath)) {
        try {
            await platformDocuments.getDocumentFilesCapability().statFile(file.originalPath);
        } catch (error) {
            recentFilesError.value = getErrorMessage(error);
            return false;
        }
    }
    return openInWorkspace({
        kind: 'open',
        target: describeDocumentTarget(file.originalPath),
        pageShape,
    }, workspace => workspace.handleOpenFileDirectWithPersist(file.originalPath, pageShape));
}

// The picker is requested in the click's own call: a browser shows a file
// chooser only within the click's user activation, which can expire while the
// workspace chunk loads. Start has no document, so there is nothing to
// persist before picking.
async function openPicked(pick: () => Promise<TOpenFileResult | null>) {
    let result: TOpenFileResult | null;
    try {
        result = await pick();
    } catch (error) {
        // Main refused the chosen file before handing it over: this open
        // failed, the workspace did not crash.
        documentSession.markFailed(describeRefusedDocumentOpen(error, t));
        return false;
    }
    return result
        ? openInWorkspace(describeOpenResult(result), workspace => workspace.handleOpenFileWithResult(result))
        : false;
}

function openInWorkspace(request: IWorkspaceOpenRequest, open: (workspace: IWorkspaceExpose) => Promise<boolean>) {
    const mounted = documentView.value?.mountedWorkspace.value;
    if (mounted) {
        return open(mounted);
    }
    // The tab is opening from the click, not from when the workspace chunk
    // arrives; the workspace's own open replaces this transaction once mounted.
    return documentSession.runOpen(request, () => withWorkspace(open));
}

async function revealRecentFile(file: IRecentFile) {
    try {
        await platformDocuments.getDocumentWindowCapability().showItemInFolder(file.originalPath);
    } catch {
        // Best-effort; the file may have moved.
    }
}

// A crash inside one tab's workspace is isolated to that tab: the tab offers a
// retry or close in place of the workspace, the toast reports it, and the
// other tabs keep working.
onErrorCaptured((error, instance, info) => {
    const failure = handleDocumentWorkspaceCrash(error, instance?.$options.name ?? null, info, {tabId});
    documentSession.markFailed({
        message: getErrorMessage(error),
        failure,
        title: t('errors.workspace.loadTitle'),
    });
    crashDescription.value = t('errors.workspace.loadDescriptionWithMessage', {message: getErrorMessage(error)});
    return false;
});

function retry() {
    crashDescription.value = null;
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
