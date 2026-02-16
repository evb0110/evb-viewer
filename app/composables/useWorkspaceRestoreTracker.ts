import { ref } from 'vue';

const restoringTabIds = ref<Set<string>>(new Set());

function updateRestoringTabs(updater: (next: Set<string>) => void) {
    const next = new Set(restoringTabIds.value);
    updater(next);
    restoringTabIds.value = next;
}

export function useWorkspaceRestoreTracker() {
    function start(tabId: string) {
        updateRestoringTabs((next) => {
            next.add(tabId);
        });
    }

    function finish(tabId: string) {
        updateRestoringTabs((next) => {
            next.delete(tabId);
        });
    }

    function has(tabId: string) {
        return restoringTabIds.value.has(tabId);
    }

    return {
        start,
        finish,
        has,
    };
}
