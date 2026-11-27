import {useMutationObserver, useTimeoutFn} from '@vueuse/core';

interface IWorkspaceHostTeleportAvailability {
    toolbarHostId: string;
    statusHostId: string;
}

export const useWorkspaceHostTeleportAvailability = (options: IWorkspaceHostTeleportAvailability) => {
    const canTeleportToolbar = ref(false);
    const canTeleportStatus = ref(false);
    let stopHostObserver: (() => void) | null = null;

    function stopObservation() {
        stopHostObserver?.();
        stopHostObserver = null;
        stopObserverTimeout();
    }

    const {start: startObserverTimeout, stop: stopObserverTimeout} = useTimeoutFn(stopObservation, 5_000, {immediate: false});

    function refreshTeleportHosts() {
        if (typeof document === 'undefined') {
            return;
        }
        canTeleportToolbar.value = Boolean(document.getElementById(options.toolbarHostId));
        canTeleportStatus.value = Boolean(document.getElementById(options.statusHostId));
        if (canTeleportToolbar.value && canTeleportStatus.value) {
            stopObservation();
        }
    }

    onMounted(() => {
        refreshTeleportHosts();
        if (!canTeleportToolbar.value || !canTeleportStatus.value) {
            stopHostObserver = useMutationObserver(document.documentElement, refreshTeleportHosts, {
                childList: true,
                subtree: true,
            }).stop;
            startObserverTimeout();
        }
        void nextTick(refreshTeleportHosts);
    });

    onBeforeUnmount(stopObservation);

    return {
        canTeleportStatus,
        canTeleportToolbar,
    };
};
