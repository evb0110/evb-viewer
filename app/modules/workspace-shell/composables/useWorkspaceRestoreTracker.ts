import { omit } from 'es-toolkit/object';

export interface IWorkspaceRestoreTrackerLike {
    has: (tabId: string) => boolean;
    start: (tabId: string) => void;
    finish: (tabId: string) => void;
}

const useRestoringTabCounts = () => useState<Record<string, number>>(
    'workspace-restore:counts',
    () => ({}),
);

export const useWorkspaceRestoreTracker = () => {
    const restoringTabCounts = useRestoringTabCounts();

    function start(tabId: string) {
        restoringTabCounts.value = {
            ...restoringTabCounts.value,
            [tabId]: (restoringTabCounts.value[tabId] ?? 0) + 1,
        };
    }

    function finish(tabId: string) {
        const current = restoringTabCounts.value[tabId] ?? 0;
        if (current <= 1) {
            restoringTabCounts.value = omit(restoringTabCounts.value, [tabId]);
            return;
        }

        restoringTabCounts.value = {
            ...restoringTabCounts.value,
            [tabId]: current - 1,
        };
    }

    function has(tabId: string) {
        return (restoringTabCounts.value[tabId] ?? 0) > 0;
    }

    return {
        start,
        finish,
        has,
    };
};
