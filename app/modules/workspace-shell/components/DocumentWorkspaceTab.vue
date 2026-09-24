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
            :start-section="startSection"
            :is-fullscreen="isFullscreen"
            :fullscreen-supported="fullscreenSupported"
            :is-workspace-layout-resizing="isWorkspaceLayoutResizing"
            @update:start-section="emit('update:start-section', $event)"
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
    </div>
</template>

<script setup lang="ts">
import type { TDocumentRef } from '@contracts/documentRef';
import type { TOpenFileResult } from '@contracts/electronApiDocuments';
import type { TStartSection } from '@app/types/startSection';
import type { FailurePresentation } from '@app/composables/useFailureToast';
import DocumentWorkspaceFailurePanel from '@app/modules/workspace-shell/components/DocumentWorkspaceFailurePanel.vue';
import { handleDocumentWorkspaceCrash } from '@app/modules/workspace-shell/checkpoint/handleDocumentWorkspaceCrash';
import { createWorkspaceSplitCacheSessionState } from '@app/modules/workspace-shell/document-sessions/createWorkspaceSplitCacheSessionState';
import type { IWorkspaceDocumentController } from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
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
const crashFailure = shallowRef<FailurePresentation | null>(null);
const renderKey = ref(0);

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
