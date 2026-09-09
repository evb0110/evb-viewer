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
    getPendingLoginId(): string | null;
    setPendingLoginId(value: string | null): void;
    setAuthReturnWindow(value: TAssistantReturnWindow): void;
    logger: {warn(message: string): void};
}) {
    let installPromise: Promise<IAgentAssistantInstallResult> | null = null;

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

    async function startLogin(
        request: IAgentAssistantLoginRequest,
        parentWindow?: BrowserWindow | null,
    ): Promise<IAgentAssistantLoginResult> {
        await options.featureLifecycle.waitForShutdown();
        const operationGeneration = options.featureLifecycle.captureGeneration();
        try {
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
            if (typeof response.type !== 'string') {
                throw new Error('Codex did not return a login flow.');
            }

            const pendingLoginId = typeof response.loginId === 'string' ? response.loginId : null;
            options.setPendingLoginId(pendingLoginId);
            options.setAuthReturnWindow(rememberAssistantReturnWindow(parentWindow));
            options.providerRuntime.authState = 'login-pending';
            const authUrl = typeof response.authUrl === 'string' ? response.authUrl : undefined;
            const verificationUrl = typeof response.verificationUrl === 'string' ? response.verificationUrl : undefined;
            const urlToOpen = authUrl ?? verificationUrl;
            if (urlToOpen) {
                await shell.openExternal(sanitizeAllowedExternalUrl(urlToOpen));
                await options.featureLifecycle.assertEnabled(operationGeneration);
                await options.runtimeLifecycle.assertRuntimeEnabled(currentRuntime);
            }
            options.publishState();
            return {
                ok: true,
                state: options.getState(),
                ...(pendingLoginId ? {loginId: pendingLoginId} : {}),
                ...(authUrl ? {authUrl} : {}),
                ...(verificationUrl ? {verificationUrl} : {}),
                ...(typeof response.userCode === 'string' ? {userCode: response.userCode} : {}),
            };
        } catch (error) {
            if (!(await options.featureLifecycle.isEnabled(operationGeneration))) {
                return options.createDisabledResult(options.getState());
            }
            options.setAuthReturnWindow(null);
            options.providerRuntime.lastError = getErrorMessage(error);
            options.providerRuntime.authState = 'signed-out';
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

    async function cancelLogin(): Promise<IAgentAssistantState> {
        options.setAuthReturnWindow(null);
        const currentRuntime = options.runtimeLifecycle.getRuntime();
        const pendingLoginId = options.getPendingLoginId();
        if (currentRuntime && pendingLoginId) {
            await currentRuntime.client.request('account/login/cancel', {loginId: pendingLoginId}).catch((error: unknown) => {
                options.logger.warn(`Failed to cancel assistant login: ${getErrorMessage(error)}`);
            });
        }
        options.setPendingLoginId(null);
        await options.runtimeLifecycle.refreshAuthState();
        options.publishState();
        return options.getState();
    }

    return {
        cancelLogin,
        install,
        startLogin,
    };
}
