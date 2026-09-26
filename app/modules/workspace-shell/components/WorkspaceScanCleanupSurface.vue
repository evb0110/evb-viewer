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
            :document-revision="file.documentRevisionToken.value"
            :source-sha256="scanCleanupSourceSha256"
            :current-page="view.currentPage.value"
            :total-pages="view.totalPages.value"
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

const ScanCleanupWorkspace = defineAsyncComponent({
    loader: () => import('@app/modules/scan-cleanup/public/workspace')
        .then(module => module.ScanCleanupWorkspace),
    loadingComponent: ScanCleanupWorkspaceLoading,
    delay: 0,
});

defineProps<{canTeleportToolbar: boolean;}>();

const {
    scanCleanup,
    scanCleanupSourceSha256,
    file,
    view,
    isActive,
} = useDocumentContext();
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

.scan-cleanup-workspace-boundary :deep(.scan-cleanup-loading-surface),
.scan-cleanup-workspace-boundary :deep(.scan-cleanup-surface) {
    min-width: 0;
    min-height: 0;
    grid-area: 1 / 1;
}
</style>
