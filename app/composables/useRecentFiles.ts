import { getErrorMessage } from '@app/utils/error';
import type { IRecentFile } from '@contracts/shared';
import type { TDocumentRef } from '@contracts/documentRef';
import { useRuntimeEnvironment } from '@app/composables/useRuntimeEnvironment';
import {
    shouldPreferDesktopPlatform,
    waitForDesktopPlatformBridge,
} from '@app/utils/platform';
import {readBrowserRecentFilesSnapshot} from '@app/utils/recentFilesPersistence';
import { usePlatformHydratedState } from '@app/composables/usePlatformHydratedState';
import { useFailureToast } from '@app/composables/useFailureToast';
import { BrowserLogger } from '@app/utils/browserLogger';
import {
    getFailureReceipt,
    type ExpectedOutcome,
} from '@contracts/diagnostics/failureReceipt';
import { getDocumentRecentFilesCapability as getPlatformDocumentRecentFilesCapability } from '@app/utils/platformDocuments';
import { getDocumentRefBaseName } from '@app/utils/documentRef';

const ELECTRON_BRIDGE_RETRY_DELAY_MS = 25;
const ELECTRON_BRIDGE_RETRY_ATTEMPTS = 20;
const ELECTRON_RECENT_FILES_RETRY_DELAY_MS = 750;
const ELECTRON_RECENT_FILES_MAX_AUTOMATIC_RETRIES = 5;

export const useRecentFiles = () => {
    const { t } = useTypedI18n();
    const {
        presentFailureToast,
        presentNoticeToast,
    } = useFailureToast();
    const { isDesktopRuntime } = useRuntimeEnvironment();
    const route = useRoute();
    const initialCookieSnapshot = readBrowserRecentFilesSnapshot();
    const hasResolvedCookieSnapshot = initialCookieSnapshot.hasSnapshot && !initialCookieSnapshot.truncated;
    const shouldPreferElectronRuntime = computed(() => (
        shouldPreferDesktopPlatform(route.path, isDesktopRuntime.value)
    ));
    const hasUsableInitialSnapshot = computed(() => (
        !shouldPreferElectronRuntime.value && hasResolvedCookieSnapshot
    ));

    async function waitForDocumentsCapabilityBridge() {
        if (shouldPreferElectronRuntime.value) {
            const bridgeReady = await waitForDesktopPlatformBridge({
                shouldWait: shouldPreferElectronRuntime.value,
                attempts: ELECTRON_BRIDGE_RETRY_ATTEMPTS,
                retryDelayMs: ELECTRON_BRIDGE_RETRY_DELAY_MS,
            });

            if (!bridgeReady) {
                throw new Error('Electron API unavailable');
            }
        }
    }

    async function getDocumentRecentFilesCapability() {
        await waitForDocumentsCapabilityBridge();

        return getPlatformDocumentRecentFilesCapability();
    }

    const {
        state: recentFiles,
        isLoading,
        isResolved,
        error,
        load: loadRecentFilesState,
        retryNow: retryRecentFilesState,
        clearRetryTimer,
    } = usePlatformHydratedState<IRecentFile[]>({
        key: 'recentFiles',
        initialValue: () => initialCookieSnapshot.recentFiles,
        initialResolved: !isDesktopRuntime.value && hasResolvedCookieSnapshot,
        async loadValue() {
            return (await getDocumentRecentFilesCapability()).recentFiles.get();
        },
        getErrorMessage(loadError) {
            return loadError instanceof Error ? getErrorMessage(loadError) : t('errors.recent.load');
        },
        shouldRetry() {
            return shouldPreferElectronRuntime.value;
        },
        retryDelayMs: ELECTRON_RECENT_FILES_RETRY_DELAY_MS,
        maxAutomaticRetries: ELECTRON_RECENT_FILES_MAX_AUTOMATIC_RETRIES,
        markResolvedOnError() {
            return !shouldPreferElectronRuntime.value;
        },
    });

    async function loadRecentFiles() {
        await loadRecentFilesState();
    }

    async function retryRecentFiles() {
        await retryRecentFilesState();
    }

    // A failed edit of the list leaves the list as it was; only a failed load
    // is the list's own state.
    function reportEditFailure(title: string, editError: unknown) {
        presentFailureToast({
            failure: BrowserLogger.error(
                'recent-files',
                title,
                editError,
                getFailureReceipt(editError) ?? {code: 'RENDERER_WORKSPACE_OPERATION_FAILED'},
            ),
            title,
            ...(editError instanceof Error ? {description: getErrorMessage(editError)} : {}),
        });
    }

    async function removeRecentFile(file: IRecentFile) {
        try {
            await (await getDocumentRecentFilesCapability()).recentFiles.remove(file.originalPath);
            await loadRecentFiles();
        } catch (e) {
            reportEditFailure(t('errors.recent.remove'), e);
        }
    }

    /**
     * Asked before a Recent open claims its tab: a file that is gone leaves the
     * list and is told as such, and the open does not start. Anything else,
     * including a file that cannot be checked, goes on to open.
     */
    async function forgetRecentFileIfMissing(path: TDocumentRef) {
        let removed = false;
        try {
            removed = await (await getDocumentRecentFilesCapability()).recentFiles.removeIfMissing(path);
        } catch (checkError) {
            BrowserLogger.warn('recent-files', 'Recent file availability check failed', checkError);
        }
        if (!removed) {
            return false;
        }
        const fileName = recentFiles.value.find(file => file.originalPath === path)?.fileName
            ?? getDocumentRefBaseName(path)
            ?? path;
        recentFiles.value = recentFiles.value.filter(file => file.originalPath !== path);
        BrowserLogger.warn('recent-files', 'Recent file was gone and left the list', {
            kind: 'expected',
            code: 'handled-absence',
        } satisfies ExpectedOutcome);
        presentNoticeToast({
            tone: 'warning',
            title: t('errors.recent.notFoundTitle'),
            description: t('errors.recent.notFoundDescription', {name: fileName}),
        });
        return true;
    }

    async function clearRecentFiles() {
        try {
            await (await getDocumentRecentFilesCapability()).recentFiles.clear();
            recentFiles.value = [];
            error.value = null;
            isResolved.value = true;
            clearRetryTimer();
        } catch (e) {
            reportEditFailure(t('errors.recent.clear'), e);
        }
    }

    return {
        recentFiles,
        isLoading,
        isResolved,
        hasUsableInitialSnapshot,
        error,
        loadRecentFiles,
        retryRecentFiles,
        removeRecentFile,
        forgetRecentFileIfMissing,
        clearRecentFiles,
    };
};
