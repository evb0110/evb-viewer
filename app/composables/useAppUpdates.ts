import type {
    IAppUpdateStatus,
    TAppUpdatePhase,
} from '@contracts/updatesPlatformFeature';
import { getFailureReceipt } from '@contracts/diagnostics/failureReceipt';
import type { IPresentedFailureCapture } from '@app/utils/failureReporter';
import { BrowserLogger } from '@app/utils/browserLogger';
import { getErrorMessage } from '@app/utils/error';
import { captureFailureForPresentation } from '@app/utils/failureReporter';
import {
    getUpdatesCapability,
    isUpdatesCapabilitySupported,
} from '@app/utils/platformUpdates';

export type TStatusDialogPhase = Exclude<TAppUpdatePhase, 'idle' | 'downloaded'>;

export interface IUpdateDialogState {
    open: boolean;
    kind: 'status' | 'available' | 'ready';
    phase: TStatusDialogPhase;
    version: string | null;
    percent: number | null;
    message: string | null;
    failure: IPresentedFailureCapture | null;
}

type TUpdateFailureAction = 'load' | 'check' | 'download' | 'install' | 'defer' | 'skip' | 'status';

const DEFAULT_STATUS: IAppUpdateStatus = {
    phase: 'idle',
    origin: 'auto',
    version: null,
    percent: null,
    message: null,
};

const DEFAULT_DIALOG: IUpdateDialogState = {
    open: false,
    kind: 'status',
    phase: 'checking',
    version: null,
    percent: null,
    message: null,
    failure: null,
};

const status = ref<IAppUpdateStatus>({ ...DEFAULT_STATUS });
const dialog = ref<IUpdateDialogState>({ ...DEFAULT_DIALOG });
const initialized = ref(false);
let statusUnsubscribe: (() => void) | null = null;
let initializationPromise: Promise<boolean> | null = null;
let activeUpdateFailure: IPresentedFailureCapture | null = null;

function toErrorMessage(error: unknown) {
    const message = getErrorMessage(error);
    if (message.trim().length > 0) {
        return message;
    }
    return String(error);
}

function openStatusDialog(
    nextStatus: IAppUpdateStatus,
    failure: IPresentedFailureCapture | null,
) {
    if (nextStatus.phase === 'idle' || nextStatus.phase === 'downloaded') {
        return;
    }

    dialog.value = {
        open: true,
        kind: 'status',
        phase: nextStatus.phase,
        version: nextStatus.version,
        percent: nextStatus.percent,
        message: nextStatus.message,
        failure,
    };
}

function openReadyDialog(version: string | null) {
    dialog.value = {
        open: true,
        kind: 'ready',
        phase: 'downloading',
        version,
        percent: 100,
        message: null,
        failure: null,
    };
}

function openAvailableDialog(version: string | null) {
    dialog.value = {
        open: true,
        kind: 'available',
        phase: 'available',
        version,
        percent: null,
        message: null,
        failure: null,
    };
}

function closeDialog() {
    dialog.value.open = false;
}

function captureUpdateFailure(
    error: unknown,
    action: TUpdateFailureAction,
    message: string,
): IPresentedFailureCapture {
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
    return presentation;
}

function applyStatus(
    nextStatus: IAppUpdateStatus,
    failure: IPresentedFailureCapture | null = null,
) {
    status.value = nextStatus;

    if (nextStatus.phase === 'error') {
        activeUpdateFailure = failure
            ?? activeUpdateFailure
            ?? captureUpdateFailure(
                new Error(nextStatus.message ?? 'Update status reported an error.'),
                'status',
                'Update status reported an error',
            );
    } else {
        activeUpdateFailure = null;
    }

    if (nextStatus.phase === 'available') {
        openAvailableDialog(nextStatus.version);
        return;
    }

    if (nextStatus.phase === 'downloaded') {
        openReadyDialog(nextStatus.version);
        return;
    }

    if (nextStatus.phase === 'error' || (
        nextStatus.origin === 'manual'
        && nextStatus.phase !== 'idle'
    )) {
        openStatusDialog(nextStatus, activeUpdateFailure);
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
    const statusEvents = {receivedPushedStatus: false};
    const unsubscribe = updates.onStatus((nextStatus) => {
        statusEvents.receivedPushedStatus = true;
        initialized.value = true;
        applyStatus(nextStatus);
    });
    if (statusUnsubscribe && statusUnsubscribe !== unsubscribe) {
        statusUnsubscribe();
    }
    statusUnsubscribe = unsubscribe;

    initializationPromise = (async () => {
        try {
            const currentState = await updates.getState();
            if (!statusEvents.receivedPushedStatus) {
                applyStatus(currentState);
            }
            initialized.value = true;
            return true;
        } catch (error) {
            const message = toErrorMessage(error);
            const failure = captureUpdateFailure(error, 'load', 'Failed to load update status');
            if (statusEvents.receivedPushedStatus) {
                initialized.value = true;
                return true;
            }

            applyStatus({
                phase: 'error',
                origin: 'manual',
                version: status.value.version,
                percent: null,
                message,
            }, failure);

            if (statusUnsubscribe === unsubscribe) {
                statusUnsubscribe();
                statusUnsubscribe = null;
            } else {
                unsubscribe();
            }
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
            origin: 'manual',
            version: status.value.version,
            percent: null,
            message,
        }, failure);
    }
}

async function skipUpdateVersion() {
    const version = dialog.value.version?.length ? dialog.value.version : status.value.version;
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

const dialogVersion = computed(() => dialog.value.version?.length ? dialog.value.version : status.value.version);

export const useAppUpdates = () => {
    return {
        status,
        dialog,
        dialogVersion,
        isCheckInProgress,
        isUpdateSupported,
        ensureInitialized,
        checkForUpdates,
        downloadUpdate,
        installUpdateNow,
        deferUpdate,
        skipUpdateVersion,
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
        activeUpdateFailure = null;
        status.value = { ...DEFAULT_STATUS };
        dialog.value = { ...DEFAULT_DIALOG };
    });
}
