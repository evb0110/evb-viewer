<template>
    <div
        v-if="scanCleanup.surfaceMode.value === 'scan-cleanup'"
        class="scan-cleanup-workspace-boundary"
    >
        <ScanCleanupWorkspace
            :source-path="file.workingCopyPath.value"
            :page-source="view.documentPageSource.value"
            :page-source-pending="view.documentPageSource.value === null && view.isLoading.value"
            :document-key="file.documentKey.value"
            :document-session-key="controller.snapshot.value.identity.documentSessionKey"
            :document-revision="file.documentRevisionToken.value"
            :source-sha256="scanCleanupSourceSha256"
            :current-page="view.currentPage.value"
            :total-pages="totalPages"
            :session-state="scanCleanup.scanCleanupSessionState.value"
            :toolbar-active="isActive"
            :can-teleport-toolbar="canTeleportToolbar"
            @done="scanCleanup.closeScanCleanup"
            @ready="scanCleanup.workspaceMounted.value = true"
            @update:session-state="scanCleanup.updateScanCleanupSessionState"
        />
    </div>
</template>

<script setup lang="ts">
import ScanCleanupWorkspaceLoading from '@app/modules/workspace-shell/components/ScanCleanupWorkspaceLoading.vue';
import { useDocumentContext } from '@app/modules/workspace-shell/documentContext';
import { workspaceCommandSinkKey } from '@app/types/workspaceCommand';
import { useDocumentViewContext } from '@app/modules/workspace-shell/documentViewContext';

const ScanCleanupWorkspace = defineAsyncComponent({
    loader: () => import('@app/modules/scan-cleanup/public/workspace')
        .then(module => module.ScanCleanupWorkspace),
    loadingComponent: ScanCleanupWorkspaceLoading,
    delay: 0,
});

defineProps<{canTeleportToolbar: boolean;}>();

const {
    controller,
    file,
    metadata,
    pdfDocumentSessionSlot,
} = useDocumentContext();
provide(workspaceCommandSinkKey, metadata.workspaceCommandSink);
const {
    scanCleanup,
    scanCleanupSourceSha256,
    view,
    isActive,
} = useDocumentViewContext();
// A PDF's pages are counted by its document, which a returning view's provisional
// page does not stand for; a page source is counted by its view.
const totalPages = computed(() => (controller.file.value.isDjvu
    ? view.totalPages.value
    : pdfDocumentSessionSlot.session.value?.document.value?.numPages ?? 0));
</script>

<style scoped>
.scan-cleanup-workspace-boundary {
    position: absolute;
    z-index: var(--app-z-local-overlay);
    inset: 0;
    display: grid;
    min-width: 0;
    min-height: 0;
}
</style>
