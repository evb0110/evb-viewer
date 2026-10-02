import type {
    ComputedRef,
    Ref,
} from 'vue';
import type { IAppUpdateStatus } from '@contracts/updatesPlatformFeature';
import { useFailureToast } from '@app/composables/useFailureToast';
import type { IUpdateDialogState } from '@app/composables/useAppUpdates';

interface IUseAppShellUpdatesDialogOptions {
    updatesStatus: Ref<IAppUpdateStatus>;
    updatesDialog: Ref<IUpdateDialogState>;
    showUpdateDialog: () => void;
    updatesDialogVersion: ComputedRef<string | null | undefined>;
    closeUpdatesDialog: () => void;
    deferUpdate: () => Promise<void>;
    downloadUpdate: () => Promise<void>;
    skipUpdateVersion: () => Promise<void>;
    installUpdateNow: () => Promise<void>;
}

export const useAppShellUpdatesDialog = (options: IUseAppShellUpdatesDialogOptions) => {
    const { t } = useTypedI18n();
    const toast = useToast();
    const {
        presentFailureToast,
        presentNoticeToast,
    } = useFailureToast();

    // An offer found by the scheduled check must not take the window from the
    // reader, so it waits in a notice that opens the dialog on request.
    // Dismissing the notice neither skips the version nor approves the update.
    // Each notice keeps the id the toaster generated: a removed id is filtered
    // out of the toaster later, which would also drop a new notice reusing it.
    let offerToastId: string | number | null = null;
    const removeOfferToast = () => {
        if (offerToastId !== null) {
            toast.remove(offerToastId);
            offerToastId = null;
        }
    };
    watch([
        () => options.updatesStatus.value.phase,
        () => options.updatesStatus.value.origin,
        () => options.updatesStatus.value.version,
    ], ([
        phase,
        origin,
        version,
    ]) => {
        removeOfferToast();
        if (origin !== 'auto' || (phase !== 'available' && phase !== 'downloaded')) {
            return;
        }
        const ready = phase === 'downloaded';
        offerToastId = toast.add({
            color: 'neutral',
            title: t(ready ? 'updates.readyTitle' : 'updates.availableTitle'),
            description: t(ready ? 'updates.readyDescription' : 'updates.offerDescription', {version: version ?? t('updates.unknownVersion')}),
            duration: Number.POSITIVE_INFINITY,
            progress: false,
            actions: [{
                label: t('updates.viewAction'),
                color: 'neutral',
                variant: 'outline',
                onClick: options.showUpdateDialog,
            }],
        }).id;
    }, { immediate: true });
    onScopeDispose(removeOfferToast);

    const updatesDialogTitle = computed(() => {
        if (options.updatesDialog.value.kind === 'ready') {
            return t('updates.readyTitle');
        }
        if (options.updatesDialog.value.kind === 'available') {
            return t('updates.availableTitle');
        }

        switch (options.updatesDialog.value.phase) {
            case 'available':
                return t('updates.availableTitle');
            case 'checking':
                return t('updates.checkingTitle');
            case 'downloading':
                return t('updates.downloadingTitle');
            case 'no-update':
                return t('updates.upToDateTitle');
            case 'error':
                return t('updates.errorTitle');
            case 'unsupported':
                return t('updates.unsupportedTitle');
        }
    });

    const updatesDialogDescription = computed(() => {
        const version = options.updatesDialogVersion.value ?? t('updates.unknownVersion');

        if (options.updatesDialog.value.kind === 'ready') {
            return t('updates.readyDescription', { version });
        }
        if (options.updatesDialog.value.kind === 'available') {
            return t('updates.availableDescription', { version });
        }

        switch (options.updatesDialog.value.phase) {
            case 'available':
                return t('updates.availableDescription', { version });
            case 'checking':
                return t('updates.checkingDescription');
            case 'downloading': {
                const percent = Math.max(0, Math.round(options.updatesDialog.value.percent ?? 0));
                return t('updates.downloadingDescription', {
                    version,
                    percent,
                });
            }
            case 'no-update':
                return t('updates.upToDateDescription', { version });
            case 'error':
                return t('updates.errorDescription', { message: options.updatesDialog.value.message ?? t('updates.unknownError') });
            case 'unsupported':
                return options.updatesDialog.value.message ?? t('updates.unsupportedDescription');
        }
    });

    // A check the user asked for that fails ends the dialog and is told the
    // way every failure is.
    watch(() => options.updatesDialog.value.open && options.updatesDialog.value.phase === 'error', (failed) => {
        if (!failed) {
            return;
        }
        const failure = options.updatesDialog.value.failure;
        const report = {
            title: updatesDialogTitle.value,
            description: updatesDialogDescription.value,
        };
        options.closeUpdatesDialog();
        if (failure) {
            presentFailureToast({
                ...failure,
                ...report,
            });
        } else {
            presentNoticeToast({
                tone: 'warning',
                ...report,
            });
        }
    });

    return {
        handleDeferUpdate() {
            options.closeUpdatesDialog();
            void options.deferUpdate();
        },
        handleDownloadUpdate() {
            void options.downloadUpdate();
        },
        handleInstallUpdate() {
            void options.installUpdateNow();
        },
        handleSkipUpdate() {
            options.closeUpdatesDialog();
            void options.skipUpdateVersion();
        },
        updatesDialogDescription,
        updatesDialogTitle,
    };
};
