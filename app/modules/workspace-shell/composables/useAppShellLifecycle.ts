import type { Ref } from 'vue';
import type { IWindowTabIncomingTransfer } from '@contracts/windowTabs';
import { traceRendererStartup } from '@app/utils/traceRendererStartup';
import { getWindowTabsCapability } from '@app/utils/platformWindowTabs';
import { BrowserLogger } from '@app/utils/browserLogger';

interface IUseAppShellLifecycleOptions {
    dirtyTabCloseDialogOpen: Ref<boolean>;
    updatesDialogOpen: Ref<boolean>;
    cleanupEmptyPanes: () => void;
    ensureUpdatesInitialized: () => Promise<void>;
    handleIncomingTabTransfer: (transfer: IWindowTabIncomingTransfer) => Promise<void>;
    cleanupDirectionalTabs: () => void;
    cleanupExternalFileDrop: () => void;
    resolveDirtyTabCloseDialog: (confirmed: boolean) => void;
    closeUpdatesDialog: () => void;
}

export const useAppShellLifecycle = (options: IUseAppShellLifecycleOptions) => {
    const {
        dirtyTabCloseDialogOpen,
        updatesDialogOpen,
        cleanupEmptyPanes,
        ensureUpdatesInitialized,
        handleIncomingTabTransfer,
        cleanupDirectionalTabs,
        cleanupExternalFileDrop,
        resolveDirtyTabCloseDialog,
        closeUpdatesDialog,
    } = options;

    let incomingTabTransferCleanup: (() => void) | null = null;

    onMounted(() => {
        const start = performance.now();
        traceRendererStartup('index.vue onMounted start');

        cleanupEmptyPanes();
        void ensureUpdatesInitialized();

        incomingTabTransferCleanup = getWindowTabsCapability().onIncomingTransfer((transfer) => {
            void handleIncomingTabTransfer(transfer).catch((error: unknown) => {
                BrowserLogger.error('tabs', 'Incoming tab transfer handler rejected', {
                    transferId: transfer.transferId,
                    error: error instanceof Error ? error : String(error),
                }, {code: 'RENDERER_TAB_TRANSFER_OPERATION_FAILED'});
            });
        });
        traceRendererStartup('index.vue onMounted finished', {durationMs: Math.round(performance.now() - start)});
    });

    onUnmounted(() => {
        cleanupDirectionalTabs();
        incomingTabTransferCleanup?.();
        incomingTabTransferCleanup = null;
        cleanupExternalFileDrop();
    });

    watch(dirtyTabCloseDialogOpen, (isOpen) => {
        if (!isOpen) {
            resolveDirtyTabCloseDialog(false);
        }
    });

    watch(updatesDialogOpen, (isOpen) => {
        if (!isOpen) {
            closeUpdatesDialog();
        }
    });
};
