import { ref } from 'vue';

const restoringTabCounts = ref<Map<string, number>>(new Map());

function updateRestoringTabs(updater: (next: Map<string, number>) => void) {
    const next = new Map(restoringTabCounts.value);
    updater(next);
    restoringTabCounts.value = next;
}

export function useWorkspaceRestoreTracker() {
    function start(tabId: string) {
        updateRestoringTabs((next) => {
            const current = next.get(tabId) ?? 0;
            next.set(tabId, current + 1);
        });
    }

    function finish(tabId: string) {
        updateRestoringTabs((next) => {
            const current = next.get(tabId) ?? 0;
            if (current <= 1) {
                next.delete(tabId);
                return;
            }
            next.set(tabId, current - 1);
        });
    }

    function has(tabId: string) {
        return (restoringTabCounts.value.get(tabId) ?? 0) > 0;
    }

    return {
        start,
        finish,
        has,
    };
}
