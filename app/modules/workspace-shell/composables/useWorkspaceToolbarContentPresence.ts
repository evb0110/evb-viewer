import type { Ref } from 'vue';
import { useMutationObserver } from '@vueuse/core';

export const useWorkspaceToolbarContentPresence = (toolbarHostRef: Ref<HTMLElement | null>) => {
    const workspaceToolbar = shallowRef<HTMLElement | null>(null);
    const hasWorkspaceToolbarContent = computed(() => workspaceToolbar.value !== null);

    function syncWorkspaceToolbarContent() {
        workspaceToolbar.value = toolbarHostRef.value?.querySelector<HTMLElement>(':scope > *') ?? null;
    }

    useMutationObserver(toolbarHostRef, syncWorkspaceToolbarContent, { childList: true });
    watch(toolbarHostRef, () => {
        if (import.meta.client) {
            void nextTick(syncWorkspaceToolbarContent);
        }
    }, { flush: 'post' });
    onMounted(syncWorkspaceToolbarContent);

    return {
        hasWorkspaceToolbarContent,
        workspaceToolbar,
    };
};
