import type {
    IAgentAssistantChatScope,
    IAgentAssistantModelOption,
    IAgentAssistantState,
    IAgentAssistantStatus,
    TAgentAssistantProviderId,
} from '@contracts/agent';
import {cloneAssistantScope} from '@agent-core/assistantScope';
import {
    CODEX_APP_INSTALL_URL,
    CODEX_STANDALONE_INSTALL_URL,
    type ICodexCliInfo,
} from '@electron/features/agent/codexCli';
import { PINNED_CODEX_CLI_VERSION } from '@electron/features/agent/codexCliReleaseManifest';
import type { TCodexAssistantModelOption } from '@electron/features/agent/assistantModelCatalog';
import { createAssistantErrorEnvelope } from '@electron/features/agent/assistantErrorEnvelope';
import type {IAssistantChatSession} from '@electron/features/agent/assistantChatSessionStore';
import {
    buildAssistantProviderStatuses,
    type TAssistantProviderRuntimeStateMap,
} from '@electron/features/agent/assistantProviderState';
import {
    getProviderEfforts,
    getProviderModelLabel,
    getProviderSpeedModes,
    normalizeAssistantEffort,
    normalizeAssistantModel,
    normalizeAssistantSpeedMode,
    type IAssistantSelection,
    type IClaudeAssistantProviderInfo,
} from '@electron/features/agent/assistantProviderStatus';
import { getAssistantTurnProviderTurnId } from '@electron/features/agent/assistantTurnLifecycle';
import {createIsoTimestamp} from '@contracts/timestamps';

interface IBuildAgentAssistantStateSnapshotOptions {
    claudeInfo: IClaudeAssistantProviderInfo | null;
    claudeModels: readonly IAgentAssistantModelOption[];
    codexInfo: ICodexCliInfo | null;
    codexModels: readonly TCodexAssistantModelOption[];
    createMcpStatus: (provider: TAgentAssistantProviderId) => IAgentAssistantStatus['mcp'];
    getSessionForStatus: (
        scope: IAgentAssistantChatScope | null,
        selection: IAssistantSelection,
    ) => IAssistantChatSession | null;
    isAssistantTurnActiveForScope: (
        session: IAssistantChatSession,
        scope: IAgentAssistantChatScope | null,
    ) => boolean;
    messages: IAgentAssistantState['messages'];
    platform: string;
    providerRuntimeStates: TAssistantProviderRuntimeStateMap;
    scope: IAgentAssistantChatScope | null;
    selection: IAssistantSelection;
}

function buildAgentAssistantStatusSnapshot(options: IBuildAgentAssistantStateSnapshotOptions): IAgentAssistantStatus {
    const installed = options.codexInfo?.installed === true;
    const versionSupported = options.codexInfo?.isVersionSupported === true;
    const supported = options.platform === 'darwin' || options.platform === 'win32' || options.platform === 'linux';
    const normalizedModel = normalizeAssistantModel(
        options.codexModels,
        options.selection.provider,
        options.selection.model,
    );
    const normalizedSelection = {
        provider: options.selection.provider,
        model: normalizedModel,
        effort: normalizeAssistantEffort(
            options.codexModels,
            options.selection.provider,
            normalizedModel,
            options.selection.effort,
        ),
        speedMode: normalizeAssistantSpeedMode(
            options.codexModels,
            options.selection.provider,
            normalizedModel,
            options.selection.speedMode,
        ),
    } as const satisfies IAssistantSelection;
    const session = options.getSessionForStatus(options.scope, normalizedSelection);
    const sessionTurnMatchesScope = session
        ? options.isAssistantTurnActiveForScope(session, options.scope)
        : false;
    const sessionTurnPhase = session
        ? session.turnPresentation.phase
        : 'idle';
    const sessionActiveTurnId = session && sessionTurnMatchesScope
        ? getAssistantTurnProviderTurnId(session.turnOwner)
        : null;
    const effortInput = session?.effort ?? normalizedSelection.effort;
    const speedModeInput = session?.speedMode ?? normalizedSelection.speedMode;
    const providerStatuses = buildAssistantProviderStatuses({
        platform: options.platform,
        states: options.providerRuntimeStates,
        codexInfo: options.codexInfo,
        claudeInfo: options.claudeInfo,
        codexModels: options.codexModels,
        claudeModels: options.claudeModels,
        model: session?.model ?? normalizedSelection.model,
        effort: effortInput,
        speedMode: speedModeInput,
    });
    const fallbackProvider = providerStatuses[0];
    if (!fallbackProvider) {
        throw new Error('No assistant providers are available.');
    }
    const activeProvider = providerStatuses.find((
        provider: IAgentAssistantStatus['providers'][number],
    ) => provider.id === normalizedSelection.provider) ?? fallbackProvider;
    const model = normalizeAssistantModel(
        options.codexModels,
        normalizedSelection.provider,
        session?.model ?? normalizedSelection.model,
    );
    const effort = normalizeAssistantEffort(options.codexModels, normalizedSelection.provider, model, effortInput);
    const speedMode = normalizeAssistantSpeedMode(
        options.codexModels,
        normalizedSelection.provider,
        model,
        speedModeInput,
    );
    const error = session?.lastError ?? activeProvider.error;
    return {
        supported,
        platform: options.platform,
        provider: activeProvider.id,
        providerLabel: activeProvider.label,
        providers: providerStatuses,
        model,
        modelLabel: getProviderModelLabel(
            options.codexModels,
            options.claudeModels,
            normalizedSelection.provider,
            model,
        ),
        models: activeProvider.models,
        modelSwitchMode: activeProvider.modelSwitchMode,
        effort,
        availableEfforts: getProviderEfforts(options.codexModels, normalizedSelection.provider, model),
        speedMode,
        availableSpeedModes: getProviderSpeedModes(options.codexModels, normalizedSelection.provider, model),
        installState: activeProvider.installState,
        codexInstalled: installed,
        codexPath: options.codexInfo?.path ?? null,
        codexVersion: options.codexInfo?.version ?? null,
        minimumCodexVersion: options.codexInfo?.minimumVersion ?? PINNED_CODEX_CLI_VERSION,
        codexVersionSupported: versionSupported,
        installUrl: CODEX_APP_INSTALL_URL,
        installScriptUrl: CODEX_STANDALONE_INSTALL_URL,
        managedInstallDir: options.codexInfo?.managedInstallDir ?? '',
        authState: activeProvider.authState,
        account: activeProvider.account,
        runtimeState: activeProvider.runtimeState,
        mcp: options.createMcpStatus(normalizedSelection.provider),
        turn: {
            id: sessionActiveTurnId,
            phase: sessionTurnPhase,
            reasoning: session?.turnPresentation.reasoning ?? '',
            toolActivity: session?.turnPresentation.toolActivity ?? [],
            lastEventAtMs: session?.turnPresentation.lastEventAtMs ?? null,
            usage: session?.turnPresentation.usage ?? null,
        },
        lastCheckedAt: createIsoTimestamp(),
        ...(error
            ? {
                error,
                errorEnvelope: createAssistantErrorEnvelope(error),
            }
            : {}),
    };
}

export function buildAgentAssistantStateSnapshot(options: IBuildAgentAssistantStateSnapshotOptions): IAgentAssistantState {
    return {
        scope: options.scope ? cloneAssistantScope(options.scope) : null,
        status: buildAgentAssistantStatusSnapshot(options),
        messages: options.messages,
    };
}
