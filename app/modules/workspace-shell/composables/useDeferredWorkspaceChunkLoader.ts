import { getErrorMessage } from '@app/utils/error';
import { shouldRetryAsyncChunkLoad } from '@app/modules/workspace-shell/host/shouldRetryAsyncChunkLoad';
import { BrowserLogger } from '@app/utils/browserLogger';
import {
    getFailureReceipt,
    type FailureReceipt,
} from '@contracts/diagnostics/failureReceipt';
import type { FailurePresentation } from '@app/composables/useFailureToast';

const ASYNC_CHUNK_RETRY_DELAY_STEP_MS = 150;

interface IUseDeferredWorkspaceChunkLoaderOptions {
    logSection: string;
    tabId: string;
}

const loadDocumentWorkspace = () => import('@app/modules/workspace-shell/components/DocumentWorkspace.vue');

function attachFailureReceipt(error: unknown, receipt: FailureReceipt) {
    if (!error || typeof error !== 'object' || getFailureReceipt(error)) {
        return;
    }
    try {
        Object.defineProperty(error, 'failure', {
            configurable: true,
            value: receipt,
        });
    } catch {
        // The load state still carries the receipt when an import error is not extensible.
    }
}

export const useDeferredWorkspaceChunkLoader = (options: IUseDeferredWorkspaceChunkLoaderOptions) => {
    const workspaceChunkLoadError = ref<unknown>(null);
    const workspaceChunkFailurePresentation = shallowRef<FailurePresentation | null>(null);
    const workspaceRenderNonce = ref(0);
    const chunkRetryTimers = new Set<ReturnType<typeof setTimeout>>();
    function reportWorkspaceChunkFailure(error: unknown, message: string) {
        const receipt = getFailureReceipt(error) ?? BrowserLogger.error(
            options.logSection,
            message,
            error,
            {code: 'RENDERER_WORKSPACE_OPERATION_FAILED'},
        );
        attachFailureReceipt(error, receipt);
        workspaceChunkFailurePresentation.value = {
            failure: receipt,
            title: 'Workspace failed to load',
            ...(error instanceof Error && getErrorMessage(error)
                ? {description: getErrorMessage(error)}
                : {description: message}),
        };
        workspaceChunkLoadError.value = error;
        return receipt;
    }
    const DocumentWorkspace = import.meta.client
        ? defineAsyncComponent({
            loader: loadDocumentWorkspace,
            suspensible: false,
            onError: (error, retry, fail, attempts) => {
                if (shouldRetryAsyncChunkLoad({
                    attempts,
                    error,
                    isDev: import.meta.dev,
                })) {
                    BrowserLogger.warn(options.logSection, 'DocumentWorkspace async chunk load failed; retrying', {
                        tabId: options.tabId,
                        attempts,
                        error,
                    });
                    const retryDelayMs = attempts * ASYNC_CHUNK_RETRY_DELAY_STEP_MS;
                    const retryTimer = setTimeout(() => {
                        chunkRetryTimers.delete(retryTimer);
                        retry();
                    }, retryDelayMs);
                    chunkRetryTimers.add(retryTimer);
                    return;
                }

                reportWorkspaceChunkFailure(error, 'DocumentWorkspace async chunk load failed');
                fail();
            },
        })
        : null;

    function resetWorkspaceChunkLoadError() {
        workspaceChunkLoadError.value = null;
        workspaceChunkFailurePresentation.value = null;
    }

    function retryWorkspaceChunkRender() {
        resetWorkspaceChunkLoadError();
        workspaceRenderNonce.value += 1;
    }

    function clearWorkspaceChunkRetryTimers() {
        for (const timer of chunkRetryTimers) {
            clearTimeout(timer);
        }
        chunkRetryTimers.clear();
    }

    return {
        DocumentWorkspace,
        clearWorkspaceChunkRetryTimers,
        loadDocumentWorkspace,
        reportWorkspaceChunkFailure,
        resetWorkspaceChunkLoadError,
        retryWorkspaceChunkRender,
        workspaceChunkLoadError,
        workspaceChunkFailurePresentation,
        workspaceRenderNonce,
    };
};
