import {
    shell,
    type BrowserWindow,
} from 'electron';
import type {
    IAgentAssistantInstallResult,
    IAgentAssistantLoginRequest,
    IAgentAssistantLoginResult,
    IAgentAssistantState,
} from '@contracts/agent';
import { installManagedCodex } from '@electron/features/agent/codexCli';
import {
    rememberAssistantReturnWindow,
    type TAssistantReturnWindow,
} from '@electron/features/agent/assistantReturnWindow';
import type { IAssistantProviderRuntimeState } from '@electron/features/agent/assistantProviderState';
import type {
    createAssistantFeatureLifecycle,
    createAssistantRuntimeLifecycle,
} from '@electron/features/agent/assistantRuntimeLifecycle';
import { withAssistantErrorEnvelope } from '@electron/features/agent/assistantErrorEnvelope';
import { sanitizeAllowedExternalUrl } from '@contracts/externalUrl';
import { getErrorMessage } from '@electron/utils/error';
import { isRecord } from '@contracts/runtimeGuards';

interface IPendingLoginOperation {
    cancelPromise: Promise<boolean> | null;
    cancelProvider: (() => Promise<void>) | null;
    cancelRequested: boolean;
    invalidated: boolean;
    loginId: string | null;
    promise: Promise<IAgentAssistantLoginResult> | null;
}

export function createCodexAssistantAdapter(options: {
    featureLifecycle: ReturnType<typeof createAssistantFeatureLifecycle>;
    runtimeLifecycle: ReturnType<typeof createAssistantRuntimeLifecycle>;
    providerRuntime: IAssistantProviderRuntimeState;
    getState(): IAgentAssistantState;
    publishState(): void;
    publishEvent(event: {
        type: 'install-progress' | 'error';
        progress?: string;
        error?: string
    }): void;
    createDisabledResult(state: IAgentAssistantState): IAgentAssistantLoginResult;
    stopForDisabledFeature(): Promise<string>;
    logger: {warn(message: string): void};
}) {
    let installPromise: Promise<IAgentAssistantInstallResult> | null = null;
    let pendingLoginOperation: IPendingLoginOperation | null = null;
    let pendingLoginId: string | null = null;
    let authReturnWindow: TAssistantReturnWindow = null;

    function decodeRecordResponse(value: unknown) {
        return isRecord(value) ? value : null;
    }

    async function install(): Promise<IAgentAssistantInstallResult> {
        if (installPromise) {
            return installPromise;
        }

        installPromise = (async () => {
            try {
                await options.featureLifecycle.waitForShutdown();
                if (!(await options.featureLifecycle.isEnabled(options.featureLifecycle.captureGeneration()))) {
                    const error = await options.stopForDisabledFeature();
                    return withAssistantErrorEnvelope({
                        ok: false,
                        state: options.getState(),
                        error,
                    });
                }
                delete options.providerRuntime.lastError;
                options.publishEvent({
                    type: 'install-progress',
                    progress: 'Starting Codex installation.',
                });
                const codexInfo = await installManagedCodex({onProgress: progress => options.publishEvent({
                    type: 'install-progress',
                    progress,
                })});
                options.runtimeLifecycle.setCodexInfo(codexInfo);
                options.publishEvent({
                    type: 'install-progress',
                    progress: 'Starting EVB Assistant with the updated Codex.',
                });
                await options.runtimeLifecycle.ensureRuntime();
                return {
                    ok: true,
                    state: options.getState(),
                };
            } catch (error) {
                options.providerRuntime.lastError = getErrorMessage(error);
                options.providerRuntime.runtimeState = 'error';
                options.publishEvent({
                    type: 'error',
                    error: options.providerRuntime.lastError,
                });
                return withAssistantErrorEnvelope({
                    ok: false,
                    state: options.getState(),
                    error: options.providerRuntime.lastError,
                });
            } finally {
                installPromise = null;
            }
        })();
        return installPromise;
    }

    function retirePendingLogin(operation: IPendingLoginOperation) {
        if (pendingLoginOperation !== operation) {
            return;
        }
        pendingLoginOperation = null;
        pendingLoginId = null;
        authReturnWindow = null;
    }

    async function cancelProviderLogin(operation: IPendingLoginOperation) {
        if (operation.cancelPromise) {
            return operation.cancelPromise;
        }

        operation.cancelPromise = (async () => {
            if (!operation.cancelProvider) {
                return false;
            }
            try {
                await operation.cancelProvider();
                return false;
            } catch (error: unknown) {
                options.logger.warn(`Failed to cancel assistant login: ${getErrorMessage(error)}`);
                await options.runtimeLifecycle.refreshAuthState();
                return true;
            }
        })();
        return operation.cancelPromise;
    }

    async function throwIfCancelRequested(operation: IPendingLoginOperation) {
        if (!operation.cancelRequested) {
            return;
        }
        if (!(await cancelProviderLogin(operation))) {
            options.providerRuntime.authState = 'signed-out';
        }
        throw new Error('Assistant sign-in was canceled.');
    }

    async function runLogin(
        operation: IPendingLoginOperation,
        request: IAgentAssistantLoginRequest,
        parentWindow?: BrowserWindow | null,
    ): Promise<IAgentAssistantLoginResult> {
        const operationGeneration = options.featureLifecycle.captureGeneration();
        try {
            await options.featureLifecycle.waitForShutdown();
            const currentRuntime = await options.runtimeLifecycle.ensureRuntime();
            await options.featureLifecycle.assertEnabled(operationGeneration);
            await options.runtimeLifecycle.assertRuntimeEnabled(currentRuntime);
            const params = request.mode === 'device-code'
                ? {type: 'chatgptDeviceCode'}
                : {
                    type: 'chatgpt',
                    codexStreamlinedLogin: true,
                };
            const response = await currentRuntime.client.requestDecoded('account/login/start', params, decodeRecordResponse);
            await options.featureLifecycle.assertEnabled(operationGeneration);
            await options.runtimeLifecycle.assertRuntimeEnabled(currentRuntime);
            if (operation.invalidated) {
                return {
                    ok: true,
                    state: options.getState(),
                };
            }
            if (typeof response.type !== 'string') {
                throw new Error('Codex did not return a login flow.');
            }

            const responseLoginId = typeof response.loginId === 'string' ? response.loginId : null;
            operation.loginId = responseLoginId;
            operation.cancelProvider = responseLoginId
                ? () => currentRuntime.client.request('account/login/cancel', {loginId: responseLoginId}).then(() => undefined)
                : null;
            pendingLoginId = responseLoginId;
            authReturnWindow = rememberAssistantReturnWindow(parentWindow);
            options.providerRuntime.authState = 'login-pending';
            await throwIfCancelRequested(operation);
            const authUrl = typeof response.authUrl === 'string' ? response.authUrl : undefined;
            const verificationUrl = typeof response.verificationUrl === 'string' ? response.verificationUrl : undefined;
            const urlToOpen = authUrl ?? verificationUrl;
            if (urlToOpen) {
                await shell.openExternal(sanitizeAllowedExternalUrl(urlToOpen));
                await options.featureLifecycle.assertEnabled(operationGeneration);
                await options.runtimeLifecycle.assertRuntimeEnabled(currentRuntime);
            }
            if (operation.invalidated) {
                return {
                    ok: true,
                    state: options.getState(),
                };
            }
            await throwIfCancelRequested(operation);
            options.publishState();
            return {
                ok: true,
                state: options.getState(),
                ...(responseLoginId ? {loginId: responseLoginId} : {}),
                ...(authUrl ? {authUrl} : {}),
                ...(verificationUrl ? {verificationUrl} : {}),
                ...(typeof response.userCode === 'string' ? {userCode: response.userCode} : {}),
            };
        } catch (error) {
            if (operation.invalidated) {
                return {
                    ok: true,
                    state: options.getState(),
                };
            }
            const cancellationFailed = operation.loginId !== null
                ? await cancelProviderLogin(operation)
                : false;
            retirePendingLogin(operation);
            if (!(await options.featureLifecycle.isEnabled(operationGeneration))) {
                return options.createDisabledResult(options.getState());
            }
            options.providerRuntime.lastError = getErrorMessage(error);
            if (!cancellationFailed) {
                options.providerRuntime.authState = 'signed-out';
            }
            options.publishEvent({
                type: 'error',
                error: options.providerRuntime.lastError,
            });
            return withAssistantErrorEnvelope({
                ok: false,
                state: options.getState(),
                error: options.providerRuntime.lastError,
            });
        }
    }

    async function startLogin(
        request: IAgentAssistantLoginRequest,
        parentWindow?: BrowserWindow | null,
    ): Promise<IAgentAssistantLoginResult> {
        if (pendingLoginOperation?.promise) {
            return pendingLoginOperation.promise;
        }

        const operation: IPendingLoginOperation = {
            cancelPromise: null,
            cancelProvider: null,
            cancelRequested: false,
            invalidated: false,
            loginId: null,
            promise: null,
        };
        pendingLoginOperation = operation;
        operation.promise = runLogin(operation, request, parentWindow);
        return operation.promise;
    }

    async function cancelLogin(): Promise<IAgentAssistantState> {
        const operation = pendingLoginOperation;
        if (operation) {
            operation.cancelRequested = true;
            authReturnWindow = null;
            await operation.promise;
            const cancellationFailed = await cancelProviderLogin(operation);
            if (!cancellationFailed) {
                options.providerRuntime.authState = 'signed-out';
            }
            retirePendingLogin(operation);
        } else {
            authReturnWindow = null;
            pendingLoginId = null;
            await options.runtimeLifecycle.refreshAuthState();
        }
        options.publishState();
        return options.getState();
    }

    function clearLoginState() {
        if (pendingLoginOperation) {
            pendingLoginOperation.cancelRequested = true;
            pendingLoginOperation.invalidated = true;
            pendingLoginOperation = null;
        }
        pendingLoginId = null;
        authReturnWindow = null;
    }

    return {
        cancelLogin,
        clearLoginState,
        getAuthReturnWindow: () => authReturnWindow,
        getPendingLoginId: () => pendingLoginId,
        install,
        startLogin,
    };
}
