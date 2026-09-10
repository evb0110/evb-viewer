import {
    buildAgentAssistantScopeFingerprint,
    cloneAssistantScope,
    type IAgentAssistantChatScope,
    type IAgentAssistantChatMessage,
    type IAgentAssistantEvent,
    type IAgentAssistantImageAttachment,
    type IAgentAssistantState,
    type IAgentAssistantStateRequest,
    type TAgentAssistantEffort,
    type TAgentAssistantLoginMode,
    type TAgentAssistantMessageRole,
    type TAgentAssistantPresetId,
    type TAgentAssistantProviderId,
    type TAgentAssistantSpeedMode,
} from '@contracts/agent';
import type { TTranslateFn } from '@i18n-app';
import {createIsoTimestamp} from '@contracts/timestamps';
import type {ExpectedOutcome} from '@contracts/diagnostics/failureReceipt';
import {
    ASSISTANT_DEFAULT_EFFORT,
    ASSISTANT_DEFAULT_SPEED_MODE,
    ASSISTANT_SPEED_MODES,
    isRemovedCodexAssistantModelId,
} from '@contracts/agentModels';
import {
    createSelectedAssistantStatus,
    getStateScopeFingerprint,
    normalizeEffortValue,
    normalizeModelValue,
    normalizeProviderValue,
    normalizeSpeedModeValue,
    providerDefaultEffort,
    providerDefaultSpeedMode,
    speedModesForProviderStatus,
} from '@app/modules/agent-panel/utils/assistantSelectionState';
import { createEmptyAssistantState } from '@app/modules/agent-panel/utils/createEmptyAssistantState';
import {
    ASSISTANT_PRESETS,
    type IAssistantPreset,
} from '@app/modules/agent-panel/utils/assistantPresets';
import {
    persistAssistantSelection,
    preferredAssistantModel,
    readAssistantSelectionPreference,
    selectedAssistantModelForProvider,
} from '@app/modules/agent-panel/utils/assistantSelectionPreference';
import { useAssistantComposerAutofocus } from '@app/modules/agent-panel/utils/useAssistantComposerAutofocus';
import { isAssistantSelectionLocked } from '@app/modules/agent-panel/utils/isAssistantSelectionLocked';
import { getAgentAssistantPanelView } from '@app/modules/agent-panel/utils/getAgentAssistantPanelView';
import { BrowserLogger } from '@app/utils/browserLogger';
import { getErrorMessage } from '@app/utils/error';
import { getAgentCapability } from '@app/utils/getAgentCapability';
import {
    defaultDocument,
    defaultWindow,
    useEventListener,
    useIntervalFn,
} from '@vueuse/core';
import { useRuntimeErrorReports } from '@app/composables/useRuntimeErrorReports';
import { useTypedI18n } from '@app/composables/useTypedI18n';
import { useAssistantPanelClipboard } from '@app/modules/agent-panel/composables/useAssistantPanelClipboard';
import {
    createAssistantEventFence,
    isAssistantStateCurrent,
} from '@app/modules/agent-panel/utils/assistantEventFence';
import {
    createAssistantSteering,
    type IAssistantSubmitPayload,
} from '@app/modules/agent-panel/utils/createAssistantSteering';
import { useAssistantImageComposer } from '@app/modules/agent-panel/composables/useAssistantImageComposer';
import {
    captureAssistantFailure,
    createAssistantActionOptions,
    getAssistantExpectedOutcome,
    type IAssistantActionErrorOptions,
} from '@app/modules/agent-panel/utils/assistantFailure';
import type { FailurePresentation } from '@app/composables/useFailureToast';
import {
    ASSISTANT_AUTO_REFRESH_MIN_INTERVAL_MS,
    ASSISTANT_STATUS_HEARTBEAT_MS,
    ASSISTANT_STATUS_TEXT_LIMIT,
    formatAssistantElapsed,
    formatAssistantTurnStatus,
    isAssistantBtwCommand,
    isAssistantMessageListNearBottom,
    isActiveAssistantTurnPhase,
    truncateAssistantStatusText,
} from '@app/modules/agent-panel/utils/assistantTurnPresentation';
export interface IAgentAssistantPanelControllerProps {
    activeDocumentName?: string | null;
    chatScope?: IAgentAssistantChatScope | null;
    hasActiveDocument?: boolean;
    hasAnyDocument?: boolean;
    width?: number | undefined;
    isResizing?: boolean;
}
export const useAgentAssistantPanelController = (props: Readonly<IAgentAssistantPanelControllerProps>) => {
    const activeDocumentName = computed(() => props.activeDocumentName ?? null);
    const chatScope = computed(() => props.chatScope ?? null);
    const hasActiveDocument = computed(() => props.hasActiveDocument ?? false);
    const hasAnyDocument = computed(() => props.hasAnyDocument ?? false);
    const isResizing = computed(() => props.isResizing ?? false);
    const widthVar = computed(() => (props.width != null ? `${props.width}px` : undefined));
    const { t }: { t: TTranslateFn } = useTypedI18n();
    const { reportRuntimeError } = useRuntimeErrorReports();
    const assistantSelectionStorage = defaultWindow?.localStorage;
    const initialAssistantSelectionPreference = readAssistantSelectionPreference(assistantSelectionStorage);
    const initialSelectedProvider = initialAssistantSelectionPreference?.provider ?? 'codex';
    const initialSelectedModel = preferredAssistantModel(
        initialAssistantSelectionPreference,
        initialSelectedProvider,
    );
    const isInstalling = ref(false);
    const isLoggingIn = ref(false);
    const loginMode = ref<TAgentAssistantLoginMode | null>(null);
    const isSending = ref(false);
    const turnStartedAtMs = ref<number | null>(null);
    const turnActivityAtMs = ref<number | null>(null);
    const turnActivityText = ref('');
    const turnClockNowMs = ref(Date.now());
    const isResetting = ref(false);
    const hasLoadedState = ref(false);
    const installProgress = ref('');
    const deviceCode = ref('');
    const draft = ref('');
    const composerImages = ref<IAgentAssistantImageAttachment[]>([]);
    const composerError = ref('');
    const assistantFailurePresentation = shallowRef<FailurePresentation | null>(null);
    const composerInputRef = ref<HTMLTextAreaElement | null>(null);
    const state = ref<IAgentAssistantState | null>(null);
    const selectedProvider = ref<TAgentAssistantProviderId>(initialSelectedProvider);
    const selectedModel = ref(initialSelectedModel);
    const hasLocalModelSelection = ref(Boolean(initialAssistantSelectionPreference?.modelsByProvider[initialSelectedProvider]));
    const selectedEffort = ref<TAgentAssistantEffort>(ASSISTANT_DEFAULT_EFFORT);
    const hasLocalEffortSelection = ref(false);
    const selectedSpeedMode = ref<TAgentAssistantSpeedMode>(ASSISTANT_DEFAULT_SPEED_MODE);
    const hasLocalSpeedModeSelection = ref(false);
    const isSwitchingAssistant = ref(false);
    let sendGeneration = 0;
    let stateGeneration = 0;
    let assistantSwitchGeneration = 0;
    let lastRefreshStartedAt = 0;
    const acceptAssistantEvent = createAssistantEventFence();
    const queuedSteer = ref<IAssistantSubmitPayload | null>(null);
    const queuedSteerSendInFlight = ref(false);
    const interruptInFlight = ref(false);
    const emptyState = computed<IAgentAssistantState>(() => createEmptyAssistantState({
        chatScope: chatScope.value,
        selectedProvider: selectedProvider.value,
        selectedModel: selectedModel.value,
        selectedEffort: selectedEffort.value,
        selectedSpeedMode: selectedSpeedMode.value,
    }));
    const status = computed(() => (state.value ?? emptyState.value).status);
    const availableEfforts = computed(() => status.value.availableEfforts);
    const availableSpeedModes = computed(() => {
        const providerStatus = status.value.providers.find((
            provider: IAgentAssistantState['status']['providers'][number],
        ) => provider.id === selectedProvider.value);
        if (providerStatus) {
            return speedModesForProviderStatus(providerStatus, selectedModel.value);
        }
        const speedModes = status.value.availableSpeedModes;
        return speedModes.length > 0 ? [...speedModes] : [...ASSISTANT_SPEED_MODES];
    });
    const messages = computed(() => (state.value ?? emptyState.value).messages);
    const {
        copyMessageIcon,
        copyMessageTooltip,
        handleAssistantCopyShortcut,
        handleCopyMessageText,
        messagesRef,
        panelRef,
        renderedMessages,
    } = useAssistantPanelClipboard({
        messages,
        t,
    });
    const isClaudeProvider = computed(() => selectedProvider.value === 'claude');
    const panelView = computed(() => getAgentAssistantPanelView(status.value, hasLoadedState.value));
    const hasComposer = computed(() => panelView.value === 'ready' && Boolean(chatScope.value));
    const canFocusComposerInput = computed(() => hasComposer.value);
    const hasMessages = computed(() => messages.value.length > 0 || isTurnActive.value);
    const trimmedDraft = computed(() => draft.value.trim());
    const isBtwDraft = computed(() => (
        composerImages.value.length === 0
        && isAssistantBtwCommand(trimmedDraft.value)
    ));
    const hasComposerPayload = computed(() => trimmedDraft.value.length > 0 || composerImages.value.length > 0);
    const hasQueuedSteer = computed(() => queuedSteer.value !== null);
    const canQueueSteer = computed(() => (
        isTurnActive.value
        && !hasQueuedSteer.value
        && !queuedSteerSendInFlight.value
        && !isImageIngestionPending.value
        && hasComposerPayload.value
    ));
    const canSend = computed(() => (
        Boolean(chatScope.value)
        && !hasQueuedSteer.value
        && !queuedSteerSendInFlight.value
        && !isImageIngestionPending.value
        && hasComposerPayload.value
        && (
            !isSending.value
            || isBtwDraft.value
            || canQueueSteer.value
        )
    ));
    const canResetChat = computed(() => (
        hasLoadedState.value
        && Boolean(chatScope.value)
        && !isResetting.value
        && (
            messages.value.length > 0
            || isTurnActive.value
            || status.value.runtimeState === 'busy'
        )
    ));
    const canRetryAssistantError = computed(() => status.value.errorEnvelope?.retryable === true
        && !hasQueuedSteer.value && !queuedSteerSendInFlight.value
        && (!isTurnActive.value || isTurnStalled.value));
    const installButtonLabel = computed(() => isInstalling.value
        ? t('assistant.installingCodex')
        : t('assistant.installCodex'));
    const installTitle = computed(() => isClaudeProvider.value
        ? t('assistant.installClaudeTitle')
        : t('assistant.installTitle'));
    const installDescription = computed(() => isClaudeProvider.value
        ? t('assistant.installClaudeDescription')
        : t('assistant.installDescription'));
    const signInTitle = computed(() => isClaudeProvider.value
        ? t('assistant.signInClaudeTitle')
        : t('assistant.signInTitle'));
    const signInDescription = computed(() => isClaudeProvider.value
        ? t('assistant.signInClaudeDescription')
        : t('assistant.signInDescription'));
    const emptyTitle = computed(() => hasActiveDocument.value
        ? t('assistant.emptyDocumentTitle')
        : t('assistant.emptyWorkspaceTitle'));
    const emptyDescription = computed(() => {
        if (hasActiveDocument.value) {
            return activeDocumentName.value
                ? t('assistant.emptyDocumentDescriptionNamed', { name: activeDocumentName.value })
                : t('assistant.emptyDocumentDescription');
        }
        return hasAnyDocument.value
            ? t('assistant.emptyWorkspaceWithDocumentsDescription')
            : t('assistant.emptyWorkspaceDescription');
    });
    const placeholderText = computed(() => hasActiveDocument.value
        ? t('assistant.documentPlaceholder')
        : t('assistant.workspacePlaceholder'));
    const headerIcon = computed(() => (chatScope.value?.title ? 'i-ph-file-text' : 'i-ph-chat-circle-dots'));
    const headerTitle = computed(() => chatScope.value?.title ?? t('assistant.title'));
    const isTurnActive = computed(() => isActiveAssistantTurnPhase(status.value.turn.phase));
    const turnReasoning = computed(() => status.value.turn.reasoning);
    const turnToolActivity = computed(() => status.value.turn.toolActivity);
    const turnUsage = computed(() => status.value.turn.usage);
    const isTurnStalled = computed(() => status.value.turn.phase === 'stalled');
    const assistantSelectionLocked = computed(() => isAssistantSelectionLocked({
        isSending: isSending.value,
        runtimeState: status.value.runtimeState,
        turn: status.value.turn,
    }));
    const turnStatusText = computed(() => {
        const ageReference = turnActivityAtMs.value ?? turnStartedAtMs.value;
        const activity = turnActivityText.value.trim();
        return formatAssistantTurnStatus({
            phase: status.value.turn.phase,
            activity,
            ageReferenceMs: ageReference,
            startedAtMs: turnStartedAtMs.value,
            nowMs: turnClockNowMs.value,
            hasQueuedSteer: Boolean(queuedSteer.value),
            t,
        });
    });
    const sendButtonAriaLabel = computed(() => (
        isTurnActive.value && !isBtwDraft.value
            ? t('assistant.sendSteer')
            : t('assistant.send')
    ));
    useIntervalFn(() => {
        if (isTurnActive.value) {
            turnClockNowMs.value = Date.now();
        }
    }, ASSISTANT_STATUS_HEARTBEAT_MS);
    const {
        clearComposerImages,
        closeExpandedImage,
        expandImage,
        expandedImage,
        expandedImageCaption,
        expandedImageItem,
        handleComposerPaste,
        handleExpandedImageKeydown,
        isImageIngestionPending,
        navigateExpandedImage,
        replaceComposerImages,
        removeComposerImage,
    } = useAssistantImageComposer({
        composerError,
        composerImages,
        t,
    });
    function setTurnActivity(activity: string) {
        const normalized = truncateAssistantStatusText(activity, ASSISTANT_STATUS_TEXT_LIMIT);
        if (!normalized) {
            return;
        }
        const now = Date.now();
        turnActivityText.value = normalized;
        turnActivityAtMs.value = now;
        turnClockNowMs.value = now;
    }
    function syncTurnActivityWithPhase(phase: IAgentAssistantState['status']['turn']['phase']) {
        if (isActiveAssistantTurnPhase(phase)) {
            turnStartedAtMs.value ??= Date.now();
            if (!turnActivityText.value) {
                setTurnActivity(phase === 'queued'
                    ? t('assistant.startingTurn')
                    : t('assistant.working'));
            }
            return;
        }

        turnStartedAtMs.value = null;
        turnActivityAtMs.value = null;
        turnActivityText.value = '';
    }
    function addLocalAssistantStatusMessage(text: string) {
        const baseState = state.value ?? emptyState.value;
        state.value = {
            ...baseState,
            messages: [
                ...baseState.messages,
                {
                    id: `local-assistant-status-${Date.now()}-${Math.random().toString(36).slice(2)}`,
                    role: 'assistant',
                    text,
                    createdAt: createIsoTimestamp(),
                },
            ],
        };
        hasLoadedState.value = true;
        void nextTick(scrollAssistantMessagesToBottom);
    }
    function buildAssistantBtwMessage() {
        if (!isTurnActive.value && !queuedSteer.value) {
            return t('assistant.btwIdle');
        }

        const now = Date.now();
        const elapsed = turnStartedAtMs.value === null
            ? '0s'
            : formatAssistantElapsed(now - turnStartedAtMs.value);
        const activity = turnActivityText.value || t('assistant.working');
        const lastActivityAge = turnActivityAtMs.value === null
            ? elapsed
            : formatAssistantElapsed(now - turnActivityAtMs.value);
        const lines = [
            t('assistant.btwAlive', {
                phase: status.value.turn.phase,
                elapsed,
            }),
            t('assistant.btwLastActivity', {
                activity,
                age: lastActivityAge,
            }),
        ];
        if (queuedSteer.value) {
            lines.push(t('assistant.btwQueued', {text: truncateAssistantStatusText(queuedSteer.value.text, 80)}));
        }
        if (isTurnActive.value) {
            lines.push(t('assistant.btwSteerHint'));
        }
        return lines.join('\n\n');
    }

    function getAssistantActionErrorMessage(error: unknown) {
        const message = getErrorMessage(error).trim();
        return message.length > 0 && message !== 'undefined' && message !== 'null'
            ? message
            : t('errors.runtime.description');
    }

    function applyAssistantStatusError(message: string) {
        const baseState = state.value ?? emptyState.value;
        const nextStatus: IAgentAssistantState['status'] = {
            ...baseState.status,
            runtimeState: baseState.status.runtimeState === 'starting' ? 'error' : baseState.status.runtimeState,
            error: message,
        };
        state.value = {
            ...baseState,
            status: nextStatus,
        };
        hasLoadedState.value = true;
    }

    function reportAssistantActionError(
        error: unknown,
        options: IAssistantActionErrorOptions,
    ): { expected: ExpectedOutcome } | { presentation: FailurePresentation } {
        const expected = getAssistantExpectedOutcome(error, options.expected);
        if (expected) {
            BrowserLogger.warn('assistant', 'Assistant action was not completed', {
                action: options.action,
                expected,
                error,
            });
            return { expected };
        }

        const presentation = captureAssistantFailure(error, {
            action: options.action,
            description: getAssistantActionErrorMessage(error),
            logMessage: options.title,
            section: 'assistant',
            title: t('assistant.runtimeErrorTitle'),
        });
        reportRuntimeError(presentation);
        if (options.target !== 'none') {
            assistantFailurePresentation.value = presentation;
        }
        return { presentation };
    }

    function handleAssistantActionError(error: unknown, options: IAssistantActionErrorOptions) {
        const message = getAssistantActionErrorMessage(error);
        const target = options.target ?? 'status';
        const report = reportAssistantActionError(error, options);
        if ('expected' in report) {
            if (target === 'composer') {
                composerError.value = '';
            }
            return message;
        }
        if (target === 'status') {
            applyAssistantStatusError(message);
        } else if (target === 'composer') {
            composerError.value = message;
        }
        return message;
    }

    function runAssistantAction(
        task: (() => Promise<unknown>) | Promise<unknown>,
        options: IAssistantActionErrorOptions,
    ) {
        void (async () => {
            try {
                await (typeof task === 'function' ? task() : task);
            } catch (error) {
                handleAssistantActionError(error, options);
            }
        })();
    }
    function createOptimisticAssistantState(
        provider: TAgentAssistantProviderId,
        model: string,
        effort: TAgentAssistantEffort,
        speedMode: TAgentAssistantSpeedMode,
        keepMessages: boolean,
    ): IAgentAssistantState | null {
        const baseState = state.value ?? emptyState.value;
        const providerStatus = baseState.status.providers.find((
            candidate: IAgentAssistantState['status']['providers'][number],
        ) => candidate.id === provider);
        if (!providerStatus) {
            return null;
        }

        const shouldKeepMessages = keepMessages
            && baseState.status.provider === provider
            && getStateScopeFingerprint(baseState) === buildAgentAssistantScopeFingerprint(provider, chatScope.value);
        return {
            scope: chatScope.value ? cloneAssistantScope(chatScope.value) : null,
            status: createSelectedAssistantStatus(baseState.status, providerStatus, model, effort, speedMode),
            messages: shouldKeepMessages ? baseState.messages : [],
        };
    }

    function applyOptimisticSelection(
        provider: TAgentAssistantProviderId,
        model: string,
        effort: TAgentAssistantEffort,
        speedMode: TAgentAssistantSpeedMode,
        keepMessages: boolean,
    ) {
        const optimisticState = createOptimisticAssistantState(provider, model, effort, speedMode, keepMessages);
        if (!optimisticState) {
            return;
        }

        state.value = optimisticState;
        hasLoadedState.value = true;
        isSending.value = isActiveAssistantTurnPhase(optimisticState.status.turn.phase);
    }

    function createAssistantStateRequestForScope(
        scope: IAgentAssistantChatScope | null,
    ): IAgentAssistantStateRequest {
        return {
            scope: scope ? cloneAssistantScope(scope) : null,
            provider: selectedProvider.value,
            model: selectedModel.value,
            effort: selectedEffort.value,
            speedMode: selectedSpeedMode.value,
        };
    }

    function createAssistantStateRequest() {
        return createAssistantStateRequestForScope(chatScope.value);
    }

    function createAssistantStateRequestFromState(
        assistantState: IAgentAssistantState,
    ): IAgentAssistantStateRequest {
        return {
            scope: assistantState.scope ? cloneAssistantScope(assistantState.scope) : null,
            provider: assistantState.status.provider,
            model: assistantState.status.model,
            effort: normalizeEffortValue(assistantState.status.effort) ?? selectedEffort.value,
            speedMode: normalizeSpeedModeValue(assistantState.status.speedMode) ?? selectedSpeedMode.value,
        };
    }

    function interruptAssistantStateBestEffort(
        assistantState: IAgentAssistantState | null,
        title: string,
    ) {
        if (
            !assistantState
            || !assistantState.scope
            || !isActiveAssistantTurnPhase(assistantState.status.turn.phase)
        ) {
            return;
        }

        sendGeneration += 1;
        runAssistantAction(
            getAgentCapability().interruptAssistant(createAssistantStateRequestFromState(assistantState)),
            createAssistantActionOptions('interrupt', title, 'none', 'canceled'),
        );
    }

    function isAssistantMessagesNearBottom() {
        return isAssistantMessageListNearBottom(messagesRef.value);
    }

    function scrollAssistantMessagesToBottom() {
        const el = messagesRef.value;
        if (el) {
            el.scrollTop = el.scrollHeight;
        }
    }

    function applyState(nextState: IAgentAssistantState) {
        if (!isAssistantStateCurrent(nextState, selectedProvider.value, chatScope.value)) {
            return;
        }
        const shouldScrollToBottom = isAssistantMessagesNearBottom();
        const providerStatus = nextState.status.providers.find((
            provider: IAgentAssistantState['status']['providers'][number],
        ) => provider.id === nextState.status.provider);
        const needsModelOverride = hasLocalModelSelection.value && nextState.status.model !== selectedModel.value;
        const needsEffortOverride = hasLocalEffortSelection.value && nextState.status.effort !== selectedEffort.value;
        const needsSpeedModeOverride = hasLocalSpeedModeSelection.value && nextState.status.speedMode !== selectedSpeedMode.value;
        const adjustedState = providerStatus && (needsModelOverride || needsEffortOverride || needsSpeedModeOverride)
            ? {
                ...nextState,
                status: createSelectedAssistantStatus(
                    nextState.status,
                    providerStatus,
                    needsModelOverride ? selectedModel.value : nextState.status.model,
                    needsEffortOverride ? selectedEffort.value : nextState.status.effort,
                    needsSpeedModeOverride ? selectedSpeedMode.value : nextState.status.speedMode,
                ),
            }
            : nextState;
        selectedProvider.value = adjustedState.status.provider;
        selectedModel.value = adjustedState.status.model;
        selectedEffort.value = normalizeEffortValue(adjustedState.status.effort)
            ?? providerDefaultEffort(adjustedState.status.providers, adjustedState.status.provider);
        selectedSpeedMode.value = resolveSelectedSpeedModeFromState(adjustedState, providerStatus);
        assistantFailurePresentation.value = null;
        state.value = adjustedState;
        hasLoadedState.value = true;
        isSending.value = isActiveAssistantTurnPhase(adjustedState.status.turn.phase);
        syncTurnActivityWithPhase(adjustedState.status.turn.phase);
        if (shouldScrollToBottom) {
            void nextTick(scrollAssistantMessagesToBottom);
        }
    }

    function resolveSelectedSpeedModeFromState(
        nextState: IAgentAssistantState,
        providerStatus: IAgentAssistantState['status']['providers'][number] | undefined,
    ) {
        const stateSpeedMode = normalizeSpeedModeValue(nextState.status.speedMode)
            ?? providerDefaultSpeedMode(nextState.status.providers, nextState.status.provider);
        return nextState.status.provider === 'codex'
            && !hasLocalSpeedModeSelection.value
            && providerStatus?.availableSpeedModes
            && !providerStatus.availableSpeedModes.includes(ASSISTANT_DEFAULT_SPEED_MODE)
            ? ASSISTANT_DEFAULT_SPEED_MODE
            : stateSpeedMode;
    }

    function handleAssistantEvent(event: IAgentAssistantEvent) {
        if (!acceptAssistantEvent(event, selectedProvider.value, chatScope.value)) {
            return;
        }
        if (event.state && !isAssistantStateCurrent(event.state, selectedProvider.value, chatScope.value)) {
            return;
        }
        if (event.state) {
            applyState(event.state);
        }
        if (event.type === 'turn-started') {
            setTurnActivity(t('assistant.activityStarted'));
        }
        if (event.type === 'reasoning-delta' && event.reasoningDelta && state.value) {
            state.value = {
                ...state.value,
                status: {
                    ...state.value.status,
                    turn: {
                        ...state.value.status.turn,
                        phase: 'thinking',
                        reasoning: `${state.value.status.turn.reasoning}${event.reasoningDelta}`,
                        lastEventAtMs: event.lastEventAtMs ?? Date.now(),
                    },
                },
            };
            setTurnActivity('Thinking');
        }
        if (event.type === 'heartbeat' && event.phase && state.value) {
            state.value = {
                ...state.value,
                status: {
                    ...state.value.status,
                    turn: {
                        ...state.value.status.turn,
                        phase: event.phase,
                        lastEventAtMs: event.lastEventAtMs ?? state.value.status.turn.lastEventAtMs,
                    },
                },
            };
            syncTurnActivityWithPhase(event.phase);
        }
        if (event.type === 'turn-progress' && event.progress) {
            setTurnActivity(event.progress);
        }
        if (event.type === 'message-delta' && event.messageId && event.delta && state.value) {
            setTurnActivity(t('assistant.activityReceivingResponse'));
            const messageIndex = state.value.messages.findIndex((
                message: IAgentAssistantChatMessage,
            ) => message.id === event.messageId);
            if (messageIndex >= 0) {
                const messages = [...state.value.messages];
                const message = messages[messageIndex];
                if (!message) {
                    return;
                }
                messages[messageIndex] = {
                    ...message,
                    text: `${message.text}${event.delta}`,
                    pending: true,
                };
                state.value = {
                    ...state.value,
                    messages,
                };
                if (isAssistantMessagesNearBottom()) {
                    void nextTick(scrollAssistantMessagesToBottom);
                }
            }
        }
        if (event.type === 'install-progress' && event.progress) {
            installProgress.value = event.progress;
        }
        if (event.type === 'turn-completed') {
            setTurnActivity(t('assistant.activityCompleted'));
        }
        if (event.type === 'error') {
            isInstalling.value = false;
            isLoggingIn.value = false;
            isSending.value = false;
        }
    }

    async function refreshState() {
        const generation = ++stateGeneration;
        lastRefreshStartedAt = Date.now();
        const nextState = await getAgentCapability().getAssistantState(createAssistantStateRequest());
        if (generation === stateGeneration) {
            applyState(nextState);
        }
    }

    function updateProvider(value: unknown) {
        if (assistantSelectionLocked.value) {
            return;
        }
        const nextProvider = normalizeProviderValue(value);
        if (nextProvider === selectedProvider.value) {
            return;
        }
        const nextSwitchGeneration = ++assistantSwitchGeneration;
        const nextModel = selectedAssistantModelForProvider(
            assistantSelectionStorage,
            nextProvider,
            status.value.providers,
        );
        selectedProvider.value = nextProvider;
        selectedModel.value = nextModel;
        const providerStatus = status.value.providers.find(provider => provider.id === selectedProvider.value);
        const speedModes = providerStatus
            ? speedModesForProviderStatus(providerStatus, nextModel)
            : ASSISTANT_SPEED_MODES;
        if (!speedModes.includes(selectedSpeedMode.value)) {
            selectedSpeedMode.value = speedModes[0] ?? 'standard';
        }
        hasLocalModelSelection.value = true;
        selectedEffort.value = providerDefaultEffort(status.value.providers, nextProvider);
        hasLocalEffortSelection.value = false;
        selectedSpeedMode.value = providerDefaultSpeedMode(status.value.providers, nextProvider);
        hasLocalSpeedModeSelection.value = false;
        persistAssistantSelection(assistantSelectionStorage, nextProvider, nextModel);
        sendGeneration += 1;
        applyOptimisticSelection(nextProvider, selectedModel.value, selectedEffort.value, selectedSpeedMode.value, false);
        draft.value = '';
        clearComposerImages();
        queuedSteer.value = null;
        queuedSteerSendInFlight.value = false;
        isSending.value = false;
        isSwitchingAssistant.value = true;
        runAssistantAction(refreshState().finally(() => {
            if (nextSwitchGeneration === assistantSwitchGeneration) {
                isSwitchingAssistant.value = false;
            }
        }), createAssistantActionOptions('switch-provider', 'Failed to switch assistant provider'));
    }

    function updateModel(value: unknown) {
        if (assistantSelectionLocked.value) {
            return;
        }
        const nextModel = normalizeModelValue(value);
        if (!nextModel || nextModel === selectedModel.value || (selectedProvider.value === 'codex' && isRemovedCodexAssistantModelId(nextModel))) {
            return;
        }
        selectedModel.value = nextModel;
        const providerStatus = status.value.providers.find(provider => provider.id === selectedProvider.value);
        const speedModes = providerStatus
            ? speedModesForProviderStatus(providerStatus, nextModel)
            : ASSISTANT_SPEED_MODES;
        if (!speedModes.includes(selectedSpeedMode.value)) {
            selectedSpeedMode.value = speedModes[0] ?? 'standard';
        }
        hasLocalModelSelection.value = true;
        persistAssistantSelection(assistantSelectionStorage, selectedProvider.value, nextModel);
        applyOptimisticSelection(selectedProvider.value, nextModel, selectedEffort.value, selectedSpeedMode.value, true);
    }
    function updateEffort(value: unknown) {
        if (assistantSelectionLocked.value) {
            return;
        }
        const nextEffort = normalizeEffortValue(value);
        if (!nextEffort || nextEffort === selectedEffort.value) {
            return;
        }
        selectedEffort.value = nextEffort;
        hasLocalEffortSelection.value = true;
        applyOptimisticSelection(selectedProvider.value, selectedModel.value, nextEffort, selectedSpeedMode.value, true);
    }

    function updateSpeedMode(value: unknown) {
        if (assistantSelectionLocked.value) {
            return;
        }
        const nextSpeedMode = normalizeSpeedModeValue(value);
        if (!nextSpeedMode || nextSpeedMode === selectedSpeedMode.value) {
            return;
        }
        selectedSpeedMode.value = nextSpeedMode;
        hasLocalSpeedModeSelection.value = true;
        applyOptimisticSelection(selectedProvider.value, selectedModel.value, selectedEffort.value, nextSpeedMode, true);
    }

    function refreshStateAfterWindowReturn() {
        if (document.visibilityState === 'hidden') {
            return;
        }

        const now = Date.now();
        if (now - lastRefreshStartedAt < ASSISTANT_AUTO_REFRESH_MIN_INTERVAL_MS) {
            return;
        }

        runAssistantAction(refreshState(), createAssistantActionOptions('refresh', 'Failed to refresh assistant state after app focus'));
    }
    async function installCodex() {
        isInstalling.value = true;
        installProgress.value = '';
        try {
            const result = await getAgentCapability().installAssistantCodex();
            applyState(result.state);
        } finally {
            isInstalling.value = false;
        }
    }
    async function startLogin(mode: TAgentAssistantLoginMode) {
        isLoggingIn.value = true;
        loginMode.value = mode;
        deviceCode.value = '';
        try {
            const result = await getAgentCapability().startAssistantLogin({ mode });
            applyState(result.state);
            deviceCode.value = result.userCode ?? '';
        } finally {
            isLoggingIn.value = false;
            loginMode.value = null;
        }
    }
    async function cancelLogin() {
        applyState(await getAgentCapability().cancelAssistantLogin());
        deviceCode.value = '';
    }
    function handleInstallCodex() {
        runAssistantAction(installCodex, createAssistantActionOptions('install', 'Failed to install assistant Codex'));
    }
    function handleStartLogin(mode: TAgentAssistantLoginMode) {
        runAssistantAction(() => startLogin(mode), createAssistantActionOptions('login', 'Failed to start assistant login'));
    }
    function handleCancelLogin() {
        runAssistantAction(cancelLogin, createAssistantActionOptions('cancel', 'Failed to cancel assistant login', undefined, 'canceled'));
    }
    function handleRefreshState() {
        runAssistantAction(refreshState, createAssistantActionOptions('refresh', 'Failed to refresh assistant state'));
    }
    async function submitAssistantPayload(
        payload: IAssistantSubmitPayload,
        errorTitle: string,
        onSendError?: () => void,
    ): Promise<boolean> {
        if (!chatScope.value) {
            return false;
        }
        const generation = sendGeneration;
        const previousMessageIds = new Set(messages.value.map(message => message.id));
        const attachments = payload.attachments ?? [];
        isSending.value = true;
        try {
            const result = await getAgentCapability().sendAssistantMessage({
                text: payload.text,
                scope: cloneAssistantScope(chatScope.value),
                provider: selectedProvider.value,
                model: selectedModel.value,
                effort: selectedEffort.value,
                speedMode: selectedSpeedMode.value,
                ...(attachments.length > 0 ? { attachments } : {}),
                ...(payload.presetId ? { presetId: payload.presetId } : {}),
            });
            if (generation !== sendGeneration) {
                return false;
            }
            applyState(result.state);
            if (!result.ok) {
                if (!hasRecordedAssistantPayload(result.state, previousMessageIds, payload)) {
                    onSendError?.();
                }
                handleAssistantActionError(
                    createResolvedAssistantActionError(
                        result.error ?? result.state.status.error,
                        result.errorEnvelope ?? result.state.status.errorEnvelope,
                    ),
                    createAssistantActionOptions('send', errorTitle, 'composer'),
                );
                return false;
            }
            return true;
        } catch (error) {
            if (generation === sendGeneration) {
                onSendError?.();
                handleAssistantActionError(error, createAssistantActionOptions('send', errorTitle, 'composer'));
            } else {
                reportAssistantActionError(error, createAssistantActionOptions('send', 'Stale assistant message request failed', 'none'));
            }
            return false;
        } finally {
            if (generation === sendGeneration) {
                isSending.value = isTurnActive.value;
            }
        }
    }
    const {
        flushQueuedSteerIfReady,
        queueSteer,
    } = createAssistantSteering({
        chatScope,
        clearComposerImages,
        composerImages,
        composerError,
        draft,
        handleInterrupt,
        isSending,
        isTurnActive,
        queuedSteer,
        queuedSteerSendInFlight,
        replaceComposerImages,
        sendGeneration: () => sendGeneration,
        setTurnActivity,
        submitAssistantPayload,
        scopeFingerprint: () => buildAgentAssistantScopeFingerprint(selectedProvider.value, chatScope.value),
        t,
    });
    function presetLabel(presetId: TAgentAssistantPresetId) {
        if (presetId === 'add-bookmarks') {
            return t('assistant.presetAddBookmarks');
        }
        if (presetId === 'number-pages') {
            return t('assistant.presetNumberPages');
        }
        return t('assistant.presetCheckOcr');
    }
    function sendPreset(preset: IAssistantPreset) {
        if (!chatScope.value || isSending.value) {
            return;
        }
        void submitAssistantPayload(
            {
                text: presetLabel(preset.id),
                presetId: preset.id,
            },
            'Failed to send assistant preset',
        );
    }
    async function sendMessage() {
        if (!canSend.value) {
            return;
        }
        if (!chatScope.value) {
            return;
        }
        const text = trimmedDraft.value;
        if (isBtwDraft.value) {
            draft.value = '';
            clearComposerImages();
            addLocalAssistantStatusMessage(buildAssistantBtwMessage());
            return;
        }
        const attachments = composerImages.value.map((
            image: IAgentAssistantImageAttachment,
        ) => ({ ...image }));
        if (isTurnActive.value) {
            queueSteer({
                text,
                attachments,
            });
            return;
        }
        draft.value = '';
        clearComposerImages();
        await submitAssistantPayload(
            {
                text,
                attachments,
            },
            'Failed to send assistant message',
            () => {
                if (draft.value.length === 0 && composerImages.value.length === 0) {
                    draft.value = text;
                    replaceComposerImages(attachments);
                }
            },
        );
    }
    function handleSendMessage() {
        void sendMessage();
    }
    async function retryLastAssistantMessage() {
        const lastUserMessage = [...messages.value].reverse().find(message => message.role === 'user');
        if (
            !lastUserMessage
            || hasQueuedSteer.value
            || queuedSteerSendInFlight.value
            || isTurnActive.value && !isTurnStalled.value
        ) {
            return;
        }
        const attachments = lastUserMessage.attachments?.map(attachment => ({...attachment})) ?? [];
        if (isTurnStalled.value) {
            await interrupt();
        }
        await submitAssistantPayload({
            text: lastUserMessage.text,
            attachments,
        }, 'Failed to retry assistant message', () => {
            draft.value = lastUserMessage.text;
            replaceComposerImages(attachments);
        });
    }
    async function interrupt() {
        if (!chatScope.value || interruptInFlight.value || status.value.turn.phase === 'interrupting') {
            return;
        }
        interruptInFlight.value = true;
        sendGeneration += 1;
        try {
            applyState(await getAgentCapability().interruptAssistant(createAssistantStateRequest()));
        } finally {
            interruptInFlight.value = false;
        }
    }
    function handleInterrupt() {
        runAssistantAction(interrupt, createAssistantActionOptions('interrupt', 'Failed to interrupt assistant turn', undefined, 'canceled'));
    }
    async function resetChat() {
        if (!chatScope.value) {
            return;
        }
        sendGeneration += 1;
        draft.value = '';
        clearComposerImages();
        queuedSteer.value = null;
        queuedSteerSendInFlight.value = false;
        isResetting.value = true;
        try {
            applyState(await getAgentCapability().resetAssistantChat(createAssistantStateRequest()));
        } finally {
            isResetting.value = false;
            isSending.value = isTurnActive.value;
        }
    }
    function handleResetChat() {
        runAssistantAction(resetChat, createAssistantActionOptions('reset', 'Failed to reset assistant chat'));
    }
    function roleLabel(role: TAgentAssistantMessageRole) {
        if (role === 'user') {
            return t('assistant.roleUser');
        }
        if (role === 'system') {
            return t('assistant.roleSystem');
        }
        return t('assistant.roleAssistant');
    }
    watch(() => buildAgentAssistantScopeFingerprint(selectedProvider.value, chatScope.value), () => {
        interruptAssistantStateBestEffort(state.value, 'Failed to interrupt assistant turn before switching scope');
        stateGeneration += 1;
        sendGeneration += 1;
        state.value = null;
        hasLoadedState.value = false;
        draft.value = '';
        clearComposerImages();
        queuedSteer.value = null;
        queuedSteerSendInFlight.value = false;
        isSending.value = false;
        runAssistantAction(refreshState(), createAssistantActionOptions('scope-refresh', 'Failed to refresh assistant state for document'));
    });
    let unsubscribe: (() => void) | null = null;
    useAssistantComposerAutofocus(composerInputRef, canFocusComposerInput);
    watch([
        isTurnActive,
        isSending,
        isTurnStalled,
    ], () => {
        flushQueuedSteerIfReady();
    }, { flush: 'post' });
    onMounted(() => {
        unsubscribe = getAgentCapability().onAssistantEvent(handleAssistantEvent);
        runAssistantAction(refreshState(), createAssistantActionOptions('load', 'Failed to load assistant state'));
    });

    useEventListener(defaultWindow, 'focus', refreshStateAfterWindowReturn);
    useEventListener(defaultDocument, 'visibilitychange', refreshStateAfterWindowReturn);
    useEventListener(defaultWindow, 'keydown', handleAssistantCopyShortcut, { capture: true });
    useEventListener(defaultWindow, 'keydown', handleExpandedImageKeydown);

    onUnmounted(() => {
        interruptAssistantStateBestEffort(state.value, 'Failed to interrupt assistant turn before closing panel');
        unsubscribe?.();
        unsubscribe = null;
    });

    return {
        ASSISTANT_PRESETS,
        activeDocumentName,
        assistantFailurePresentation,
        assistantSelectionLocked,
        availableEfforts,
        availableSpeedModes,
        canResetChat,
        canRetryAssistantError,
        canSend,
        chatScope,
        closeExpandedImage,
        composerError,
        composerImages,
        composerInputRef,
        copyMessageIcon,
        copyMessageTooltip,
        deviceCode,
        draft,
        emptyDescription,
        emptyTitle,
        expandImage,
        expandedImage,
        expandedImageCaption,
        expandedImageItem,
        handleCancelLogin,
        handleComposerPaste,
        handleCopyMessageText,
        handleInstallCodex,
        handleInterrupt,
        handleRefreshState,
        handleResetChat,
        handleSendMessage,
        handleStartLogin,
        hasActiveDocument,
        hasAnyDocument,
        hasComposer,
        hasQueuedSteer,
        hasLoadedState,
        hasMessages,
        headerIcon,
        headerTitle,
        installButtonLabel,
        installDescription,
        installProgress,
        installTitle,
        isClaudeProvider,
        isInstalling,
        isLoggingIn,
        isResetting,
        isResizing,
        isSending,
        isSwitchingAssistant,
        isTurnActive,
        isTurnStalled,
        loginMode,
        messagesRef,
        navigateExpandedImage,
        panelRef,
        panelView,
        placeholderText,
        presetLabel,
        removeComposerImage,
        retryLastAssistantMessage,
        renderedMessages,
        roleLabel,
        selectedEffort,
        selectedModel,
        selectedProvider,
        selectedSpeedMode,
        sendButtonAriaLabel,
        sendPreset,
        signInDescription,
        signInTitle,
        status,
        t,
        turnStatusText,
        turnReasoning,
        turnToolActivity,
        turnUsage,
        updateEffort,
        updateModel,
        updateProvider,
        updateSpeedMode,
        widthVar,
    };
};

function hasRecordedAssistantPayload(
    state: IAgentAssistantState,
    previousMessageIds: ReadonlySet<string>,
    payload: IAssistantSubmitPayload,
) {
    return state.messages.some(message => (
        message.role === 'user'
        && !previousMessageIds.has(message.id)
        && message.text === payload.text
        && areAssistantAttachmentsEqual(message.attachments ?? [], payload.attachments ?? [])
    ));
}

function areAssistantAttachmentsEqual(
    left: readonly IAgentAssistantImageAttachment[],
    right: readonly IAgentAssistantImageAttachment[],
) {
    return left.length === right.length && left.every((attachment, index) => {
        const candidate = right[index];
        return candidate !== undefined
            && attachment.id === candidate.id
            && attachment.name === candidate.name
            && attachment.mimeType === candidate.mimeType
            && attachment.sizeBytes === candidate.sizeBytes
            && attachment.dataUrl === candidate.dataUrl;
    });
}

function createResolvedAssistantActionError(
    error: unknown,
    errorEnvelope: unknown,
) {
    const message = typeof error === 'string'
        ? error
        : typeof errorEnvelope === 'object'
            && errorEnvelope !== null
            && 'message' in errorEnvelope
            && typeof errorEnvelope.message === 'string'
            ? errorEnvelope.message
            : 'Assistant message was not accepted.';
    const actionError = new Error(message);
    if (typeof errorEnvelope === 'object' && errorEnvelope !== null) {
        Object.assign(actionError, {errorEnvelope});
    }
    return actionError;
}
