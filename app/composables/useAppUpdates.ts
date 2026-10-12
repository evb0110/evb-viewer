import type {
    IAppUpdateStatus,
    TAppUpdatePhase,
    TAppUpdateReason,
} from '@contracts/updatesPlatformFeature';
import type { TTranslationKey } from '@i18n-app';
import { getFailureReceipt } from '@contracts/diagnostics/failureReceipt';
import type { IPresentedFailureCapture } from '@app/utils/failureReporter';
import { BrowserLogger } from '@app/utils/browserLogger';
import { getErrorMessage } from '@app/utils/error';
import { captureFailureForPresentation } from '@app/utils/failureReporter';
import {
    getUpdatesCapability,
    isUpdatesCapabilitySupported,
} from '@app/utils/platformUpdates';

type TUpdateFailureCapture = IPresentedFailureCapture & {technicalDetails?: string};

export type TStatusDialogPhase = Exclude<TAppUpdatePhase, 'idle' | 'downloaded'>;

export interface IUpdateDialogState {
    open: boolean;
    kind: 'status' | 'available' | 'ready';
    phase: TStatusDialogPhase;
    version: string | null;
    percent: number | null;
    message: string | null;
    failure: TUpdateFailureCapture | null;
    reason?: TAppUpdateReason | undefined;
}

type TUpdateFailureAction = 'load' | 'check' | 'download' | 'install' | 'defer' | 'skip' | 'status';

const DEFAULT_STATUS: IAppUpdateStatus = {
    phase: 'idle',
    origin: 'auto',
    version: null,
    percent: null,
    message: null,
};

const status = ref<IAppUpdateStatus>({ ...DEFAULT_STATUS });
const dialogOpen = ref(false);
const initialized = ref(false);
let statusUnsubscribe: (() => void) | null = null;
let initializationPromise: Promise<boolean> | null = null;
const activeUpdateFailure = ref<TUpdateFailureCapture | null>(null);

function toErrorMessage(error: unknown) {
    const message = getErrorMessage(error);
    if (message.trim().length > 0) {
        return message;
    }
    return String(error);
}

function closeDialog() {
    dialogOpen.value = false;
}

function captureUpdateFailure(
    error: unknown,
    action: TUpdateFailureAction,
    message: string,
): TUpdateFailureCapture {
    const existingFailure = getFailureReceipt(error);
    const presentation = existingFailure
        ? {failure: existingFailure}
        : captureFailureForPresentation({
            code: 'UPDATE_OPERATION_FAILED',
            local: {
                source: 'updates',
                message,
                cause: error,
                data: {action},
            },
        });
    BrowserLogger.error('updates', message, error, presentation.failure);
    return {
        ...presentation,
        technicalDetails: toErrorMessage(error),
    };
}

function applyStatus(
    nextStatus: IAppUpdateStatus,
    failure: TUpdateFailureCapture | null = null,
    opensDialog = nextStatus.origin === 'manual',
) {
    status.value = nextStatus;

    if (nextStatus.phase === 'error') {
        activeUpdateFailure.value = failure
            ?? activeUpdateFailure.value
            ?? captureUpdateFailure(
                new Error(nextStatus.message ?? 'Update status reported an error.'),
                'status',
                'Update status reported an error',
            );
    } else {
        activeUpdateFailure.value = null;
    }

    // A manual result opens the dialog here unless the caller says otherwise. The
    // shell presents an automatic offer as a notice, and an automatic failure is only logged.
    if (nextStatus.phase === 'error' && !opensDialog) {
        closeDialog();
    } else if (opensDialog && (nextStatus.phase !== 'downloading' || dialogOpen.value)) {
        showUpdateDialog();
    }
}

function showUpdateDialog() {
    if (status.value.phase !== 'idle') {
        dialogOpen.value = true;
    }
}

async function downloadUpdate() {
    try {
        await getUpdatesCapability()?.download();
    } catch (error) {
        const message = toErrorMessage(error);
        const failure = captureUpdateFailure(error, 'download', 'Failed to download update');
        applyStatus({
            phase: 'error',
            reason: 'download-failed',
            origin: 'manual',
            version: status.value.version,
            percent: null,
            message,
        }, failure);
    }
}

async function ensureInitialized() {
    if (initialized.value) {
        return true;
    }
    if (initializationPromise) {
        return initializationPromise;
    }

    const updates = getUpdatesCapability();
    if (!updates) {
        return false;
    }
    const hydrateStatus = async () => {
        const currentState = await updates.getState();
        if (!initialized.value || currentState.requestedHere === true) {
            applyStatus(currentState.phase === 'downloaded'
                ? {
                    ...currentState,
                    origin: 'auto',
                } : currentState, null, currentState.requestedHere === true);
        }
    };
    const unsubscribe = updates.onStatus((nextStatus) => {
        initialized.value = true;
        applyStatus(nextStatus, null, nextStatus.origin === 'manual' && nextStatus.requestedHere === true);
        if (nextStatus.reason === 'install-failed' && nextStatus.requestedHere === false) {
            void hydrateStatus().catch(error => BrowserLogger.warn('updates', 'Failed to claim startup update failure', error));
        }
    });
    if (statusUnsubscribe && statusUnsubscribe !== unsubscribe) {
        statusUnsubscribe();
    }
    statusUnsubscribe = unsubscribe;

    initializationPromise = (async () => {
        try {
            await hydrateStatus();
            initialized.value = true;
            return true;
        } catch (error) {
            const message = toErrorMessage(error);
            const failure = captureUpdateFailure(error, 'load', 'Failed to load update status');
            if (initialized.value) {
                return true;
            }

            applyStatus({
                phase: 'error',
                reason: 'check-failed',
                origin: 'manual',
                version: status.value.version,
                percent: null,
                message,
            }, failure);

            unsubscribe();
            if (statusUnsubscribe === unsubscribe) statusUnsubscribe = null;
            initialized.value = false;
            return false;
        } finally {
            initializationPromise = null;
        }
    })();

    return initializationPromise;
}

async function checkForUpdates() {
    try {
        if (!await ensureInitialized()) {
            return;
        }
        await getUpdatesCapability()?.check();
    } catch (error) {
        const message = toErrorMessage(error);
        const failure = captureUpdateFailure(error, 'check', 'Failed to check for updates');
        applyStatus({
            phase: 'error',
            reason: 'check-failed',
            origin: 'manual',
            version: status.value.version,
            percent: null,
            message,
        }, failure);
    }
}

async function installUpdateNow() {
    try {
        closeDialog();
        await getUpdatesCapability()?.install();
    } catch (error) {
        const message = toErrorMessage(error);
        const failure = captureUpdateFailure(error, 'install', 'Failed to install update');
        applyStatus({
            phase: 'error',
            reason: 'install-failed',
            origin: 'manual',
            version: status.value.version,
            percent: null,
            message,
        }, failure);
    }
}

async function deferUpdate() {
    try {
        closeDialog();
        await getUpdatesCapability()?.defer();
    } catch (error) {
        const message = toErrorMessage(error);
        const failure = captureUpdateFailure(error, 'defer', 'Failed to defer update');
        applyStatus({
            phase: 'error',
            reason: 'check-failed',
            origin: 'manual',
            version: status.value.version,
            percent: null,
            message,
        }, failure);
    }
}

async function skipUpdateVersion() {
    const version = status.value.version;
    if (!version) {
        closeDialog();
        return;
    }

    try {
        closeDialog();
        await getUpdatesCapability()?.skipVersion(version);
    } catch (error) {
        const message = toErrorMessage(error);
        const failure = captureUpdateFailure(error, 'skip', 'Failed to skip update version');
        applyStatus({
            phase: 'error',
            reason: 'check-failed',
            origin: 'manual',
            version: status.value.version,
            percent: null,
            message,
        }, failure);
    }
}

const isCheckInProgress = computed(() => {
    return status.value.phase === 'checking' || status.value.phase === 'downloading';
});

const isUpdateSupported = computed(() => {
    return isUpdatesCapabilitySupported(status.value);
});

const dialogVersion = computed(() => status.value.version);

const updateReasonKeys = {
    'check-failed': 'updates.checkFailed',
    'check-timed-out': 'updates.checkTimedOut',
    'network-unavailable': 'updates.networkUnavailable',
    'feed-unavailable': 'updates.feedUnavailable',
    'download-failed': 'updates.downloadFailed',
    'install-failed': 'updates.installFailed',
    'install-preparation-failed': 'updates.installPreparationFailed',
    'store-updates': 'updates.storeUpdates',
    'signed-build-required': 'updates.signedBuildRequired',
    'runtime-unsupported': 'updates.unsupportedDescription',
} as const satisfies Record<TAppUpdateReason, TTranslationKey>;

export const useAppUpdates = () => {
    const { t } = useTypedI18n();
    const presentedDialog = computed<IUpdateDialogState>(() => {
        const current = status.value;
        return {
            get open() { return dialogOpen.value; },
            set open(open: boolean) { dialogOpen.value = open; },
            kind: current.phase === 'downloaded' ? 'ready' : current.phase === 'available' ? 'available' : 'status',
            phase: current.phase === 'idle' ? 'checking' : current.phase === 'downloaded' ? 'downloading' : current.phase,
            version: current.version,
            percent: current.percent,
            reason: current.reason,
            failure: activeUpdateFailure.value,
            message: current.phase === 'error' || current.phase === 'unsupported'
                ? current.reason === 'feed-unavailable'
                    ? t('updates.feedUnavailable', {version: current.version ?? t('updates.unknownVersion')})
                    : t(current.reason ? updateReasonKeys[current.reason]
                        : current.phase === 'unsupported' ? 'updates.unsupportedDescription' : 'updates.unknownError')
                : current.message,
        };
    });
    return {
        status,
        dialog: presentedDialog,
        dialogVersion,
        isCheckInProgress,
        isUpdateSupported,
        ensureInitialized,
        checkForUpdates,
        downloadUpdate,
        installUpdateNow,
        deferUpdate,
        skipUpdateVersion,
        showUpdateDialog,
        closeDialog,
    };
};

if (import.meta.hot) {
    import.meta.hot.dispose(() => {
        if (statusUnsubscribe) {
            statusUnsubscribe();
            statusUnsubscribe = null;
        }
        initializationPromise = null;
        initialized.value = false;
        activeUpdateFailure.value = null;
        status.value = { ...DEFAULT_STATUS };
        closeDialog();
    });
}
