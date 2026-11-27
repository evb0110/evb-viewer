import type {
    IAppUpdateStatus,
    TAppUpdatePhase,
    TAppUpdateReason,
} from '@contracts/updatesPlatformFeature';
import type { TTranslationKey } from '@i18n-app';
import {
    computed,
    getCurrentInstance,
    getCurrentScope,
    inject,
    onScopeDispose,
    provide,
    readonly,
    ref,
    type ComputedRef,
    type InjectionKey,
    type Ref,
} from 'vue';
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
    readonly open: boolean;
    readonly kind: 'status' | 'available' | 'ready';
    readonly phase: TStatusDialogPhase;
    readonly version: string | null;
    readonly percent: number | null;
    readonly message: string | null;
    readonly failure: TUpdateFailureCapture | null;
    readonly reason?: TAppUpdateReason | undefined;
}

type TUpdateFailureAction = 'load' | 'check' | 'download' | 'install' | 'defer' | 'skip' | 'status';

interface IAppWithUnmountHook {
    onUnmount?: (cleanup: () => void) => void;
    vueApp?: {onUnmount?: (cleanup: () => void) => void};
}

export interface IAppUpdatesOwner {
    readonly status: Ref<IAppUpdateStatus>;
    readonly dialogOpen: Readonly<Ref<boolean>>;
    readonly activeUpdateFailure: Readonly<Ref<TUpdateFailureCapture | null>>;
    readonly dialogVersion: ComputedRef<string | null>;
    readonly isCheckInProgress: ComputedRef<boolean>;
    readonly isUpdateSupported: ComputedRef<boolean>;
    ensureInitialized: () => Promise<boolean>;
    checkForUpdates: () => Promise<void>;
    downloadUpdate: () => Promise<void>;
    installUpdateNow: () => Promise<void>;
    deferUpdate: () => Promise<void>;
    skipUpdateVersion: () => Promise<void>;
    showUpdateDialog: () => void;
    closeDialog: () => void;
    dispose: () => void;
}

const DEFAULT_STATUS: IAppUpdateStatus = {
    phase: 'idle',
    origin: 'auto',
    version: null,
    percent: null,
    message: null,
};

const appUpdatesOwnerKey: InjectionKey<IAppUpdatesOwner> = Symbol('app-updates-owner');
const fallbackUpdatesOwnersByApp = new WeakMap<object, IAppUpdatesOwner>();
const hotFallbackUpdatesCleanups = import.meta.hot ? new Set<() => void>() : null;
const UPDATES_HOT_DISPOSERS_SYMBOL = Symbol.for('evb:hmr:useAppUpdates:disposers');
const defaultFallbackUpdatesAppKey = {};

function getHotFallbackUpdatesDisposersByApp(): WeakMap<object, () => void> | null {
    if (!import.meta.hot) {
        return null;
    }
    const existing = Reflect.get(globalThis, UPDATES_HOT_DISPOSERS_SYMBOL);
    if (existing instanceof WeakMap) {
        return existing as WeakMap<object, () => void>;
    }
    const created = new WeakMap<object, () => void>();
    Reflect.set(globalThis, UPDATES_HOT_DISPOSERS_SYMBOL, created);
    return created;
}

function disposeAllHotFallbackUpdatesOwners() {
    for (const cleanup of [...(hotFallbackUpdatesCleanups ?? [])]) {
        cleanup();
    }
}

function resolveFallbackUpdatesAppKey(): object {
    if (typeof tryUseNuxtApp === 'function') {
        const nuxtApp = tryUseNuxtApp();
        if (nuxtApp) {
            return nuxtApp;
        }
    }
    if (typeof useNuxtApp === 'function') {
        try {
            const nuxtApp = useNuxtApp();
            if (nuxtApp) {
                return nuxtApp;
            }
        } catch {
            // Outside an active Nuxt app context (e.g. standalone unit tests).
        }
    }
    return getCurrentInstance()?.appContext.app ?? defaultFallbackUpdatesAppKey;
}

function registerAppUnmountCleanup(appKey: object, cleanup: () => void) {
    const candidate = appKey as IAppWithUnmountHook;
    const onUnmount = typeof candidate.onUnmount === 'function'
        ? candidate.onUnmount.bind(candidate)
        : typeof candidate.vueApp?.onUnmount === 'function'
            ? candidate.vueApp.onUnmount.bind(candidate.vueApp)
            : null;
    onUnmount?.(cleanup);
}

function toErrorMessage(error: unknown) {
    const message = getErrorMessage(error);
    if (message.trim().length > 0) {
        return message;
    }
    return String(error);
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

export function createAppUpdatesOwner(): IAppUpdatesOwner {
    const status = ref<IAppUpdateStatus>({ ...DEFAULT_STATUS });
    const dialogOpen = ref(false);
    const initialized = ref(false);
    let statusUnsubscribe: (() => void) | null = null;
    let initializationPromise: Promise<boolean> | null = null;
    let ownerGeneration = 0;
    const activeUpdateFailure = ref<TUpdateFailureCapture | null>(null);

    function closeDialog() {
        dialogOpen.value = false;
    }

    function showUpdateDialog() {
        if (status.value.phase !== 'idle') {
            dialogOpen.value = true;
        }
    }

    function applyStatus(
        nextStatus: IAppUpdateStatus,
        failure: TUpdateFailureCapture | null = null,
        opensDialog = nextStatus.origin === 'manual',
    ) {
        status.value = nextStatus;

        if (nextStatus.phase === 'error' && nextStatus.reason !== 'install-permission-denied') {
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

    async function downloadUpdate() {
        const generation = ownerGeneration;
        try {
            await getUpdatesCapability()?.download();
        } catch (error) {
            if (generation !== ownerGeneration) {
                return;
            }
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
        const generation = ownerGeneration;
        const isCurrentGeneration = () => generation === ownerGeneration;
        const hydrateStatus = async () => {
            const currentState = await updates.getState();
            if (!isCurrentGeneration()) {
                return;
            }
            if (!initialized.value || currentState.requestedHere === true) {
                applyStatus(currentState.phase === 'downloaded'
                    ? {
                        ...currentState,
                        origin: 'auto',
                    } : currentState, null, currentState.requestedHere === true);
            }
        };
        const unsubscribe = updates.onStatus((nextStatus) => {
            if (!isCurrentGeneration()) {
                return;
            }
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

        const pendingInitialization = (async () => {
            try {
                await hydrateStatus();
                if (!isCurrentGeneration()) {
                    return false;
                }
                initialized.value = true;
                return true;
            } catch (error) {
                if (!isCurrentGeneration()) {
                    return false;
                }
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
                if (statusUnsubscribe === unsubscribe) {
                    statusUnsubscribe = null;
                }
                initialized.value = false;
                return false;
            } finally {
                if (isCurrentGeneration()) {
                    initializationPromise = null;
                }
            }
        })();

        initializationPromise = pendingInitialization;
        return pendingInitialization;
    }

    async function checkForUpdates() {
        const generation = ownerGeneration;
        try {
            if (!await ensureInitialized() || generation !== ownerGeneration) {
                return;
            }
            await getUpdatesCapability()?.check();
        } catch (error) {
            if (generation !== ownerGeneration) {
                return;
            }
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
        const generation = ownerGeneration;
        try {
            closeDialog();
            await getUpdatesCapability()?.install();
        } catch (error) {
            if (generation !== ownerGeneration) {
                return;
            }
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
        const generation = ownerGeneration;
        try {
            closeDialog();
            await getUpdatesCapability()?.defer();
        } catch (error) {
            if (generation !== ownerGeneration) {
                return;
            }
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

        const generation = ownerGeneration;
        try {
            closeDialog();
            await getUpdatesCapability()?.skipVersion(version);
        } catch (error) {
            if (generation !== ownerGeneration) {
                return;
            }
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

    function dispose() {
        ownerGeneration += 1;
        if (statusUnsubscribe) {
            statusUnsubscribe();
            statusUnsubscribe = null;
        }
        initializationPromise = null;
        initialized.value = false;
        activeUpdateFailure.value = null;
        status.value = { ...DEFAULT_STATUS };
        closeDialog();
    }

    const isCheckInProgress = computed(() => {
        return status.value.phase === 'checking' || status.value.phase === 'downloading';
    });

    const isUpdateSupported = computed(() => isUpdatesCapabilitySupported(status.value));

    const dialogVersion = computed(() => status.value.version);

    return {
        status,
        dialogOpen: readonly(dialogOpen),
        activeUpdateFailure: readonly(activeUpdateFailure),
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
        dispose,
    };
}

function getFallbackUpdatesOwner(): IAppUpdatesOwner {
    const appKey = resolveFallbackUpdatesAppKey();
    let owner = fallbackUpdatesOwnersByApp.get(appKey);
    if (!owner) {
        const hotDisposers = getHotFallbackUpdatesDisposersByApp();
        if (hotDisposers && appKey !== defaultFallbackUpdatesAppKey) {
            hotDisposers.get(appKey)?.();
        }
        const created = createAppUpdatesOwner();
        fallbackUpdatesOwnersByApp.set(appKey, created);
        const cleanup = () => {
            hotFallbackUpdatesCleanups?.delete(cleanup);
            if (hotDisposers?.get(appKey) === cleanup) {
                hotDisposers.delete(appKey);
            }
            if (fallbackUpdatesOwnersByApp.get(appKey) === created) {
                fallbackUpdatesOwnersByApp.delete(appKey);
            }
            created.dispose();
        };
        hotFallbackUpdatesCleanups?.add(cleanup);
        if (hotDisposers && appKey !== defaultFallbackUpdatesAppKey) {
            hotDisposers.set(appKey, cleanup);
        }
        registerAppUnmountCleanup(appKey, cleanup);
        owner = created;
    }
    return owner;
}

const updateReasonKeys = {
    'check-failed': 'updates.checkFailed',
    'check-timed-out': 'updates.checkTimedOut',
    'network-unavailable': 'updates.networkUnavailable',
    'feed-unavailable': 'updates.feedUnavailable',
    'download-failed': 'updates.downloadFailed',
    'install-failed': 'updates.installFailed',
    'install-permission-denied': 'updates.installPermissionDenied',
    'install-preparation-failed': 'updates.installPreparationFailed',
    'store-updates': 'updates.storeUpdates',
    'signed-build-required': 'updates.signedBuildRequired',
    'runtime-unsupported': 'updates.unsupportedDescription',
} as const satisfies Record<TAppUpdateReason, TTranslationKey>;

function projectAppUpdates(owner: IAppUpdatesOwner) {
    const { t } = useTypedI18n();
    const presentedDialog = computed<IUpdateDialogState>(() => {
        const current = owner.status.value;
        return Object.freeze({
            open: owner.dialogOpen.value,
            kind: current.phase === 'downloaded' ? 'ready' : current.phase === 'available' ? 'available' : 'status',
            phase: current.phase === 'idle' ? 'checking' : current.phase === 'downloaded' ? 'downloading' : current.phase,
            version: current.version,
            percent: current.percent,
            reason: current.reason,
            failure: owner.activeUpdateFailure.value,
            message: current.phase === 'error' || current.phase === 'unsupported'
                ? current.reason === 'feed-unavailable'
                    ? t('updates.feedUnavailable', {version: current.version ?? t('updates.unknownVersion')})
                    : t(current.reason ? updateReasonKeys[current.reason]
                        : current.phase === 'unsupported' ? 'updates.unsupportedDescription' : 'updates.unknownError')
                : current.message,
        });
    });

    return {
        status: owner.status,
        dialog: presentedDialog,
        dialogOpen: owner.dialogOpen,
        dialogVersion: owner.dialogVersion,
        isCheckInProgress: owner.isCheckInProgress,
        isUpdateSupported: owner.isUpdateSupported,
        ensureInitialized: owner.ensureInitialized,
        checkForUpdates: owner.checkForUpdates,
        downloadUpdate: owner.downloadUpdate,
        installUpdateNow: owner.installUpdateNow,
        deferUpdate: owner.deferUpdate,
        skipUpdateVersion: owner.skipUpdateVersion,
        showUpdateDialog: owner.showUpdateDialog,
        closeDialog: owner.closeDialog,
    };
}

/** Called once by the shell root to own the single renderer-wide updater subscription and dispose it on teardown. */
export const provideAppUpdates = () => {
    const owner = createAppUpdatesOwner();
    provide(appUpdatesOwnerKey, owner);
    if (getCurrentScope()) {
        onScopeDispose(owner.dispose);
    }
    return {
        ...projectAppUpdates(owner),
        dispose: owner.dispose,
    };
};

export const useAppUpdates = () => {
    const owner = (getCurrentInstance() ? inject(appUpdatesOwnerKey, null) : null)
        ?? getFallbackUpdatesOwner();
    return projectAppUpdates(owner);
};

if (import.meta.hot) {
    import.meta.hot.dispose(disposeAllHotFallbackUpdatesOwners);
}
